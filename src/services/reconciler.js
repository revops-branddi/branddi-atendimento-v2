/**
 * Reconciliador — rede de seguranca da ingestao por webhook.
 *
 * REGRA DURA: este modulo NUNCA dispara o bot de triagem. Ele busca mensagens
 * que podem ser ANTIGAS, e responder com base numa mensagem de ontem seria
 * auto-envio espontaneo — proibido pelo projeto. Mesma regra que
 * scripts/backfill-site-chat.js ja documenta no cabecalho dele.
 * O teste em test/reconciler.test.js le este arquivo e falha se a regra for
 * violada, entao a garantia nao depende de alguem lembrar dela.
 *
 * ESCOPO: cobre apenas o schema `public` (prospeccao) — e isso deixou de ser uma
 * lacuna. O numero do /site migrou para a Cloud API da Meta em ~21/jul/2026 e e'
 * atendido pela integracao nativa do Pipedrive; a conta nem existe mais no
 * Unipile (404). Nao ha o que reconciliar la'.
 */
import { resyncConversation } from './unipile.js';
import sb from './supabase.js';
import logger from './logger.js';

const WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Quantas conversas um ciclo processa. Cada resync leva ~3s (ida ao Unipile),
 * e a function da Vercel corta em 300s — 103 conversas na janela de 48h davam
 * ~309s e estouravam o limite, deixando o ciclo incompleto SEM aviso.
 */
const MAX_POR_CICLO = 20;

/**
 * Nucleo puro: decide o que reconciliar. Sem IO, para ser testavel.
 *
 * POR QUE A JANELA E' LARGA E O LOTE E' CURTO — a combinacao nao e' obvia.
 *
 * Estreitar a janela seria a correcao errada: o filtro usa `last_message_at`,
 * que e' O NOSSO registro. Se o webhook perdeu uma mensagem, o nosso timestamp
 * nao atualizou, a conversa parece antiga e sairia de uma janela curta — ou
 * seja, a janela estreita excluiria exatamente o caso que ela existe pra pegar.
 *
 * O custo real nao vinha da janela, vinha de resincronizar TODAS toda vez.
 * Entao: janela larga (nao perde candidato) + lote curto (cabe na invocacao),
 * priorizando as de atividade mais recente, que sao as mais provaveis de terem
 * mensagem nova. O que exceder o lote entra nos ciclos seguintes.
 */
export function pickStaleConversations(convs, { now, windowMs = WINDOW_MS, max = MAX_POR_CICLO } = {}) {
    const candidatas = convs
        .filter(c => {
            // Nem toda conversa e' de WhatsApp. resyncConversation() rejeita as que
            // nao tem chat_id, e sem este filtro elas viravam um erro logado a cada
            // ciclo de 5 min — poluindo a contagem de `errors` a ponto de um erro
            // real nao se distinguir do ruido previsivel.
            if (!c.whatsapp_chat_id) return false;
            if (!c.last_message_at) return false;
            const t = new Date(c.last_message_at).getTime();
            return Number.isFinite(t) && now - t <= windowMs;
        })
        .sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));

    return {
        alvos: candidatas.slice(0, max).map(c => ({ id: c.id })),
        // Truncamento NUNCA e' silencioso: cobertura parcial se passando por
        // completa e' pior que cobertura declaradamente parcial.
        descartadas: Math.max(0, candidatas.length - max),
    };
}

/**
 * Um ciclo completo. Chamado pelo cron da Vercel, nunca por setInterval.
 * @returns {Promise<{scanned:number, resynced:number, errors:number}>}
 */
export async function runReconciler({ now = Date.now() } = {}) {
    const since = new Date(now - WINDOW_MS).toISOString();

    const { data, error } = await sb
        .from('conversations')
        .select('id, last_message_at, whatsapp_chat_id')
        .gte('last_message_at', since);

    if (error) throw new Error(`reconciler: ${error.message}`);

    const { alvos, descartadas } = pickStaleConversations(data || [], { now });
    if (descartadas > 0) {
        logger.info('reconciler: lote truncado', {
            processando: alvos.length, adiadas: descartadas,
            nota: 'entram nos ciclos seguintes; cobertura deste ciclo e parcial',
        });
    }
    let resynced = 0;
    let errors = 0;

    for (const { id } of alvos) {
        try {
            await resyncConversation(id, { limit: 20 });
            resynced++;
        } catch (err) {
            // Uma conversa que falha nao pode abortar o ciclo: o proximo cron
            // tentaria as mesmas e pararia no mesmo ponto para sempre.
            errors++;
            logger.warn('reconciler: falha ao resincronizar', {
                conversation_id: id,
                error: err.message,
            });
        }
    }

    return { scanned: alvos.length, resynced, errors, adiadas: descartadas };
}
