/**
 * Auto Activities — Cria atividades no Pipedrive automaticamente
 *
 * - WhatsApp activity: quando msg outbound é enviada (1x por conversa/dia)
 * - Resposta activity: quando msg inbound é recebida (1x por conversa/dia)
 * - Dedup via campos last_wa_activity_date e last_reply_activity_date na tabela conversations
 */
import supabase from './supabase.js';
import { getLeadById } from './supabase.js';
import { createWhatsAppActivity, createReplyActivity } from './pipedrive.js';
import logger from './logger.js';

/**
 * Resolve o token Pipedrive individual do usuário (ou fallback global)
 */
async function getUserPipedriveToken(userId) {
    if (!userId) return process.env.PIPEDRIVE_API_TOKEN;
    try {
        const { data } = await supabase
            .from('platform_users')
            .select('pipedrive_api_token, pipedrive_user_id')
            .eq('id', userId)
            .single();
        return {
            token: data?.pipedrive_api_token || process.env.PIPEDRIVE_API_TOKEN,
            pipedriveUserId: data?.pipedrive_user_id || null,
        };
    } catch {
        return { token: process.env.PIPEDRIVE_API_TOKEN, pipedriveUserId: null };
    }
}

/**
 * Busca deal_id, person_id e type do lead vinculado à conversa
 */
async function getConversationDealInfo(conversationId) {
    try {
        const { data: conv } = await supabase
            .from('conversations')
            .select('lead_id, type, whatsapp_account_id, last_wa_activity_date, last_reply_activity_date')
            .eq('id', conversationId)
            .single();
        if (!conv?.lead_id) return null;

        const lead = await getLeadById(conv.lead_id);
        if (!lead?.crm_deal_id) return null;

        return {
            dealId: lead.crm_deal_id,
            personId: lead.crm_person_id || null,
            leadName: lead.name || lead.phone || 'Lead',
            conversationType: conv.type || null,
            whatsappAccountId: conv.whatsapp_account_id || null,
            lastWaDate: conv.last_wa_activity_date,
            lastReplyDate: conv.last_reply_activity_date,
        };
    } catch {
        return null;
    }
}

/**
 * Descobre o token Pipedrive E o pipedrive_user_id do dono da conta WhatsApp.
 *
 * Retorna `{ token, userId }`:
 *   - `token` autentica a chamada (cria a activity)
 *   - `userId` (pipedrive_user_id) vai no payload pra atribuir a activity
 *     ao SDR correto, mesmo quando ele não tem token próprio cadastrado.
 *
 * Princípio: dono = quem TEM o número atribuído via permissions. Admin que
 * fez o Connect tecnicamente NÃO é dono (era a regra antiga, removida).
 *
 * Resolução:
 *   1. Único user atribuído à conta: retorna token dele (ou global) + userId
 *      dele. Resolve contas exclusivas mesmo sem token próprio cadastrado.
 *   2. Múltiplos atribuídos, exatamente 1 com token: usa esse token + userId.
 *   3. Múltiplos atribuídos, 0 ou >1 com token (ambíguo): cai no global SEM
 *      userId (Pipedrive atribui ao dono do token global = atual fallback).
 *   4. Nenhum atribuído ou conta inválida: global SEM userId.
 */
export async function getTokenByWhatsAppAccount(unipileAccountId) {
    const globalToken = process.env.PIPEDRIVE_API_TOKEN;
    if (!unipileAccountId) return { token: globalToken, userId: null };

    try {
        const { data: assigned } = await supabase
            .from('platform_users')
            .select('id, name, pipedrive_api_token, pipedrive_user_id, permissions')
            .contains('permissions', { whatsapp_accounts: [unipileAccountId] });

        const users = assigned || [];

        if (users.length === 1) {
            const u = users[0];
            return {
                token: u.pipedrive_api_token || globalToken,
                userId: u.pipedrive_user_id || null,
            };
        }

        if (users.length > 1) {
            const withToken = users.filter(u => u.pipedrive_api_token);
            if (withToken.length === 1) {
                return {
                    token: withToken[0].pipedrive_api_token,
                    userId: withToken[0].pipedrive_user_id || null,
                };
            }
            if (withToken.length > 1) {
                logger.warn('Conta WhatsApp atribuída a múltiplos users com token — usando fallback global', {
                    unipile_account_id: unipileAccountId,
                    user_count: withToken.length,
                    user_names: withToken.map(u => u.name),
                });
            }
        }
    } catch (err) {
        logger.warn('Falha consultando permissions.whatsapp_accounts', {
            unipile_account_id: unipileAccountId,
            error: err.message,
        });
    }

    return { token: globalToken, userId: null };
}

/**
 * Chamado quando uma mensagem OUTBOUND é enviada (humano → lead)
 * Cria atividade tipo "whatsapp" no Pipedrive (1x por conversa/dia)
 */
export async function onOutboundMessage(conversationId, userId) {
    try {
        const info = await getConversationDealInfo(conversationId);
        if (!info) return; // sem deal vinculado, ignora

        // Leads de prospecção: atividade WhatsApp é criada MANUALMENTE pelo SDR
        // via os botões BB/FR/VM no painel direito — não criamos automática.
        if (info.conversationType === 'prospecting') return;

        const today = new Date().toISOString().split('T')[0];
        if (info.lastWaDate === today) return; // já criou hoje

        // ATOMIC CLAIM — pra hoje. Reivindica se NULL ou se data anterior.
        const { data: claimed, error: claimErr } = await supabase
            .from('conversations')
            .update({ last_wa_activity_date: today })
            .eq('id', conversationId)
            .or(`last_wa_activity_date.is.null,last_wa_activity_date.lt.${today}`)
            .select('id')
            .maybeSingle();
        if (claimErr || !claimed) return;

        // Prioridade: (1) token do user logado na UI, (2) token do dono da conta
        // WhatsApp (SDR enviou do celular direto), (3) token global.
        let token, pipedriveUserId = null;
        if (userId) {
            const r = await getUserPipedriveToken(userId);
            token = r?.token;
            pipedriveUserId = r?.pipedriveUserId || null;
        }
        if (!token) {
            const r = await getTokenByWhatsAppAccount(info.whatsappAccountId);
            token = r.token;
            pipedriveUserId = pipedriveUserId || r.userId;
        }

        try {
            await createWhatsAppActivity({
                dealId: info.dealId,
                personId: info.personId,
                subject: `WhatsApp — ${info.leadName}`,
                transcript: '',
                done: true,
                tokenOverride: token,
                userId: pipedriveUserId,
            });
        } catch (err) {
            // Falha → reverte claim para tentar amanhã
            await supabase
                .from('conversations')
                .update({ last_wa_activity_date: info.lastWaDate || null })
                .eq('id', conversationId);
            throw err;
        }

        logger.info('Auto WhatsApp activity created', {
            conversation_id: conversationId,
            deal_id: info.dealId,
        });
    } catch (err) {
        logger.warn('Auto WhatsApp activity error', {
            conversation_id: conversationId,
            error: err.message,
        });
    }
}

/**
 * Chamado quando uma mensagem INBOUND é recebida (lead → humano)
 * Cria atividade tipo "resposta" no Pipedrive — 1x por conversa POR DIA.
 *
 * Simétrico com o outbound (`onOutboundMessage`): se o lead voltar a responder
 * num novo dia, gera nova atividade. Múltiplas msgs no mesmo dia consolidam
 * numa única activity. Histórico claro no Pipedrive sem ruído.
 *
 * Usa atomic compare-and-swap (UPDATE WHERE is_null OR < today + RETURNING)
 * pra evitar race condition entre múltiplas msgs inbound chegando juntas.
 */
export async function onInboundMessage(conversationId) {
    try {
        const info = await getConversationDealInfo(conversationId);
        if (!info) return; // sem deal vinculado, ignora

        const today = new Date().toISOString().split('T')[0];
        // Já criada HOJE → não duplica (mas ontem ou antes pode renovar)
        if (info.lastReplyDate === today) return;

        // ATOMIC CLAIM — só uma chamada concorrente consegue marcar pra hoje.
        // Reivindica se NULL ou se data anterior (idem outbound activity).
        const { data: claimed, error: claimErr } = await supabase
            .from('conversations')
            .update({ last_reply_activity_date: today })
            .eq('id', conversationId)
            .or(`last_reply_activity_date.is.null,last_reply_activity_date.lt.${today}`)
            .select('id')
            .maybeSingle();

        if (claimErr || !claimed) {
            // Outro processo já reivindicou — não cria
            return;
        }

        // Token + userId do dono da conta WhatsApp (atividade no nome certo
        // mesmo quando o SDR não tem pipedrive_api_token cadastrado)
        const { token: replyToken, userId: replyUserId } = await getTokenByWhatsAppAccount(info.whatsappAccountId);

        try {
            await createReplyActivity({
                dealId: info.dealId,
                personId: info.personId,
                subject: `Resposta recebida — ${info.leadName}`,
                content: `Lead respondeu via WhatsApp em ${new Date().toLocaleDateString('pt-BR')}`,
                tokenOverride: replyToken,
                userId: replyUserId,
            });
        } catch (err) {
            // Falha na criação → libera o claim pra próxima tentativa
            await supabase
                .from('conversations')
                .update({ last_reply_activity_date: null })
                .eq('id', conversationId);
            throw err;
        }

        logger.info('Auto Reply activity created', {
            conversation_id: conversationId,
            deal_id: info.dealId,
        });
    } catch (err) {
        logger.warn('Auto Reply activity error', {
            conversation_id: conversationId,
            error: err.message,
        });
    }
}
