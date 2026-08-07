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
 * ESCOPO: hoje cobre apenas o schema `public` (prospeccao). O fluxo /site nao
 * tem equivalente de resyncConversation() — so' o pollOnce privado do ingest —
 * e continua coberto pelo polling de 10s enquanto o Railway estiver de pe.
 * O /site entra na Fase 2, junto com a ingestao por webhook dele.
 */
import { resyncConversation } from './unipile.js';
import sb from './supabase.js';
import logger from './logger.js';

const WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Nucleo puro: decide o que reconciliar. Sem IO, para ser testavel.
 *
 * Reconciliar todas as ~2.400 conversas a cada 5 min seria desperdicio, e
 * conversa parada ha dias nao tem mensagem nova a recuperar. A janela e' o
 * que mantem o custo do cron proporcional ao trafego real.
 */
export function pickStaleConversations(convs, { now, windowMs = WINDOW_MS }) {
    return convs
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
        .map(c => ({ id: c.id }));
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

    const alvos = pickStaleConversations(data || [], { now });
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

    return { scanned: alvos.length, resynced, errors };
}
