/**
 * Ingestao de mensagens vinda do webhook do Unipile (Fase 2).
 *
 * O webhook substitui apenas o mecanismo de DESCOBERTA — o `listChats` que o
 * polling roda a cada 10s. Tudo depois disso e' o caminho ja validado em
 * producao: match de lead, criacao de conversa, sync com Pipedrive, tratamento
 * de grupo, disparo do bot do /site e dedup por unipile_message_id.
 *
 * Isso e' possivel porque processChat() consome do objeto de chat exatamente
 * `id` e `account_id`, mais `type`/`provider_id` para detectar grupo — e os
 * quatro existem no payload do webhook.
 */
import { processChat as processProspectingChat } from './unipile.js';
import { processChat as processSiteChat, getActiveAccounts as getSiteAccounts } from '../site/services/ingest.js';
import { getIgnoredAccountIds } from './supabase.js';
import sb from './supabase.js';
import logger from './logger.js';

/** O Unipile usa `message_received`; eventos de conta usam o prefixo `account`. */
export function isMessageEvent(payload) {
    const e = payload?.event || payload?.type;
    return typeof e === 'string' && e.startsWith('message');
}

/**
 * Adapta o payload do webhook para o objeto de chat que processChat espera.
 * @returns {{id:string, account_id:string, provider_id:string|null, type:number}|null}
 *          null quando falta o minimo — melhor descartar do que montar chat invalido.
 */
export function chatFromWebhook(payload) {
    const id = payload?.chat_id;
    const account_id = payload?.account_id;
    if (!id || !account_id) return null;

    return {
        id,
        account_id,
        provider_id: payload.provider_chat_id || null,
        // isGroupChat() reconhece grupo por `type === 1`. Errar este mapeamento
        // faria um grupo entrar no caminho de conversa 1-1.
        type: payload.is_group ? 1 : 0,
    };
}

/**
 * Decide a qual fluxo a conta pertence. Falha fechado: o que nao for
 * reconhecido e' 'unknown' e nao entra em lugar nenhum.
 *
 * A ordem importa. Uma conta ignorada TAMBEM aparece em public.whatsapp_accounts
 * — e' la' que a flag mora. Checar prospeccao primeiro faria conversa de outro
 * time entrar no inbox da Branddi.
 *
 * @returns {'ignored'|'site'|'prospecting'|'unknown'}
 */
export function classifyAccount(accountId, { ignoredIds = [], siteIds = [], publicIds = [] } = {}) {
    if (typeof accountId !== 'string' || accountId.length === 0) return 'unknown';
    if (ignoredIds.includes(accountId)) return 'ignored';
    if (siteIds.includes(accountId)) return 'site';
    if (publicIds.includes(accountId)) return 'prospecting';
    return 'unknown';
}

async function resolveListas() {
    const [ignoredIds, siteAccounts, pub] = await Promise.all([
        getIgnoredAccountIds().catch(() => []),
        getSiteAccounts().catch(() => []),
        sb.from('whatsapp_accounts').select('unipile_account_id'),
    ]);

    return {
        ignoredIds: ignoredIds || [],
        siteIds: (siteAccounts || []).map(a => a.unipile_account_id).filter(Boolean),
        publicIds: (pub?.data || []).map(a => a.unipile_account_id).filter(Boolean),
        siteAccounts: siteAccounts || [],
    };
}

/**
 * Ponto de entrada do handler de webhook para eventos de mensagem.
 *
 * NUNCA lanca: um 500 faria o Unipile re-tentar o mesmo evento indefinidamente.
 * O polling e o reconciliador ja cobrem o que falhar aqui, entao perder latencia
 * e' aceitavel e entrar em loop de retry nao e'.
 *
 * @returns {Promise<{handled:string, account_id?:string, chat_id?:string}>}
 */
export async function ingestWebhookMessage(payload) {
    const chat = chatFromWebhook(payload);
    if (!chat) {
        logger.warn('webhook-ingest: payload sem chat_id/account_id', {
            event: payload?.event || payload?.type || null,
        });
        return { handled: 'invalid_payload' };
    }

    const listas = await resolveListas();
    const destino = classifyAccount(chat.account_id, listas);

    // Descarte sempre logado: foi exatamente o descarte SILENCIOSO que escondeu
    // o bug de content-type por meses.
    if (destino === 'ignored' || destino === 'unknown') {
        logger.info('webhook-ingest: evento descartado', {
            motivo: destino, account_id: chat.account_id, chat_id: chat.id,
        });
        return { handled: destino, account_id: chat.account_id };
    }

    try {
        if (destino === 'site') {
            const account = listas.siteAccounts.find(a => a.unipile_account_id === chat.account_id);
            if (!account) {
                logger.warn('webhook-ingest: conta do site sumiu entre a listagem e o despacho', {
                    account_id: chat.account_id,
                });
                return { handled: 'unknown', account_id: chat.account_id };
            }
            await processSiteChat(chat, account);
        } else {
            await processProspectingChat(chat);
        }

        logger.info('webhook-ingest: chat processado', {
            fluxo: destino, account_id: chat.account_id, chat_id: chat.id,
        });
        return { handled: destino, account_id: chat.account_id, chat_id: chat.id };
    } catch (err) {
        logger.error('webhook-ingest: falha ao processar chat', {
            fluxo: destino, chat_id: chat.id, error: err.message,
        });
        return { handled: 'error', account_id: chat.account_id, chat_id: chat.id };
    }
}
