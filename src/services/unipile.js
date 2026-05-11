/**
 * Unipile Service — WhatsApp via Unipile API
 * v2: Deduplicação de mensagens, reset bot_away_sent, structured logging
 */
import 'dotenv/config';
import {
    findConversationByChat, findGroupByProviderId, createConversation, updateConversation,
    findLeadByPhone, findLeadByPhoneFuzzy, createLead, updateLead, saveMessage, normalizePhone
} from './supabase.js';
import { onInboundMessage } from './auto-activities.js';
import { findPersonByPhone, findPersonByEmail, findPersonByExactName, getDealsForPerson } from './pipedrive.js';
import { isApolloConfigured, matchPerson } from './apollo.js';
import { getSettingValue } from './supabase.js';
import whatsapp from '../providers/index.js';
import logger from './logger.js';

// ─── Config ───────────────────────────────────────────────────────────
const API_KEY = process.env.UNIPILE_API_KEY;
const DSN     = process.env.UNIPILE_DSN;
const ACCT_ID = process.env.UNIPILE_ACCOUNT_ID;
const BASE    = DSN ? `https://${DSN}/api/v1` : null;

let _pollingInterval = null;
let _lastPollTime    = Date.now() - 60_000;

// Cache: unipile_account_id → { user_id, user_name, expires_at }
const _accountOwnerCache = new Map();
const ACCOUNT_OWNER_TTL_MS = 5 * 60_000;

/**
 * Cascata de estratégias pra achar a Person do Pipedrive sem exigir match
 * exato de phone. Só aceita match UNÍVOCO — ambiguidade sempre retorna null.
 *
 * Strategies em ordem:
 *   1. phone_exact          — variações BR (com/sem 9, com/sem 55)
 *   2. name_exact           — nome do Unipile (único match)
 *   3. apollo_email         — Apollo descobre email → search por email (único match)
 *
 * Apollo só roda se platform_settings.apollo_auto_match=true (controle de crédito).
 */
async function smartMatchPipedrivePerson({ phone, name }) {
    // 1. Phone (já cobre variações BR via normalizePhoneTerms)
    const byPhone = await findPersonByPhone(phone).catch(() => null);
    if (byPhone) return { person: byPhone, strategy: 'phone_exact' };

    // 2. Nome exato (só se Unipile trouxe nome real, não telefone)
    if (name && !/^\+?\d[\d\s\-()]+$/.test(name.trim()) && name.length >= 3) {
        const byName = await findPersonByExactName(name).catch(() => null);
        if (byName) return { person: byName, strategy: 'name_exact' };
    }

    // 3. Apollo (opt-in)
    try {
        const autoMatchEnabled = await getSettingValue('apollo_auto_match', false);
        if (!autoMatchEnabled || !isApolloConfigured()) return null;

        const apolloResp = await matchPerson({
            phone_number: phone,
            name: (name && !/^\+?\d/.test(name)) ? name : undefined,
        });
        if (!apolloResp?.matched || !apolloResp.person) return null;

        // Tenta email (mais preciso)
        if (apolloResp.person.email) {
            const byEmail = await findPersonByEmail(apolloResp.person.email).catch(() => null);
            if (byEmail) return { person: byEmail, strategy: 'apollo_email' };
        }

        // Tenta nome descoberto pelo Apollo
        if (apolloResp.person.name) {
            const byApolloName = await findPersonByExactName(apolloResp.person.name).catch(() => null);
            if (byApolloName) return { person: byApolloName, strategy: 'apollo_name' };
        }
    } catch (err) {
        logger.warn('smartMatch Apollo step failed', { phone, error: err.message });
    }

    return null;
}

// Resolve "dono" de uma conta WhatsApp pelo CRITÉRIO DE NEGÓCIO (atribuição
// via permissions.whatsapp_accounts), não pelo critério técnico (quem clicou
// Connect). Admin que conecta não é dono.
//
// Match único exigido — atribuição ambígua (compartilhada) → null (sem owner).
async function getAccountOwner(unipileAccountId) {
    if (!unipileAccountId) return null;
    const cached = _accountOwnerCache.get(unipileAccountId);
    if (cached && cached.expires_at > Date.now()) return cached;

    let userId = null;
    let userName = null;
    try {
        const { default: supabase } = await import('./supabase.js');
        const { data: assigned } = await supabase
            .from('platform_users')
            .select('id, name')
            .contains('permissions', { whatsapp_accounts: [unipileAccountId] });

        const users = assigned || [];
        if (users.length === 1) {
            userId = users[0].id;
            userName = users[0].name;
        }
        // 0 ou 2+ → fica null (sem owner identificável)
    } catch { /* fica null */ }

    const entry = { user_id: userId, user_name: userName, expires_at: Date.now() + ACCOUNT_OWNER_TTL_MS };
    _accountOwnerCache.set(unipileAccountId, entry);
    return entry;
}

export function isAvailable() {
    return !!(API_KEY && DSN && ACCT_ID);
}

// ─── API Request ──────────────────────────────────────────────────────

async function req(endpoint, options = {}) {
    if (!isAvailable()) throw new Error('Unipile não configurado');
    const url  = `${BASE}${endpoint}`;
    const res  = await fetch(url, {
        ...options,
        headers: { 'X-API-KEY': API_KEY, 'Accept': 'application/json', ...(options.headers || {}) },
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Unipile (${res.status}): ${err}`);
    }
    return res.json();
}

// ─── Accounts ─────────────────────────────────────────────────────────

export async function listAccounts() {
    return req('/accounts');
}

export async function getWhatsAppAccountId() {
    if (ACCT_ID) return ACCT_ID;
    const result = await listAccounts();
    const wa = (result.items || result || []).find(a =>
        (a.type || a.provider || '').toUpperCase() === 'WHATSAPP'
    );
    return wa?.id || null;
}

// ─── Chats ────────────────────────────────────────────────────────────

export async function listChats({ limit = 30, cursor, unread } = {}) {
    let qs = `?account_type=WHATSAPP&limit=${limit}`;
    if (cursor) qs += `&cursor=${encodeURIComponent(cursor)}`;
    if (unread != null) qs += `&unread=${unread}`;
    return req(`/chats${qs}`);
}

export async function getChat(chatId) {
    return req(`/chats/${chatId}`);
}

export async function getChatAttendees(chatId) {
    return req(`/chats/${chatId}/attendees`);
}

// ─── Messages ─────────────────────────────────────────────────────────

export async function getMessages(chatId, { limit = 50, cursor } = {}) {
    let qs = `?limit=${limit}`;
    if (cursor) qs += `&cursor=${encodeURIComponent(cursor)}`;
    return req(`/chats/${chatId}/messages${qs}`);
}

// Busca uma mensagem específica via id do Unipile. Útil pra resgatar
// attachments[].id logo após enviar mídia (a resposta do POST /messages
// devolve só o message_id, sem o attachment id).
export async function getMessageById(messageId) {
    if (!isAvailable() || !messageId) return null;
    try {
        return await req(`/messages/${encodeURIComponent(messageId)}`);
    } catch {
        return null;
    }
}

export async function sendMessage(chatId, text, attachmentBuffer, attachmentName) {
    const fd = new FormData();
    if (text) fd.append('text', text);
    if (attachmentBuffer && attachmentName) {
        const blob = new Blob([attachmentBuffer]);
        fd.append('attachments', blob, attachmentName);
    }
    return req(`/chats/${chatId}/messages`, { method: 'POST', body: fd });
}

/**
 * Gera variantes BR de um número (com/sem 9, com/sem DDI 55).
 * Crítico em DDDs do Sul e antigos onde o WhatsApp do destinatário NÃO
 * tem o 9 inicial — mandar com 9 cai num chat fantasma que nunca entrega.
 */
function brPhoneVariants(phone) {
    const digits = String(phone).replace(/\D/g, '');
    const local = digits.startsWith('55') && digits.length >= 12 ? digits.slice(2) : digits;
    const out = new Set();
    if (local.length >= 10) out.add(`55${local}`);                                      // como veio
    if (local.length === 10) out.add(`55${local.slice(0,2)}9${local.slice(2)}`);        // adiciona 9
    if (local.length === 11 && local[2] === '9') out.add(`55${local.slice(0,2)}${local.slice(3)}`); // remove 9
    return [...out];
}

/** Classifica um número como 'with_9' (DDD+9+8) ou 'without_9' (DDD+8). */
function phoneToVariant(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    const local = digits.startsWith('55') && digits.length >= 12 ? digits.slice(2) : digits;
    if (local.length === 11 && local[2] === '9') return 'with_9';
    if (local.length === 10) return 'without_9';
    return null;
}

/** Pega a variante 'with_9'/'without_9' de um número, ou null se não aplicável. */
function pickPhoneByVariant(phone, variant) {
    const variants = brPhoneVariants(phone);
    for (const v of variants) {
        if (phoneToVariant(v) === variant) return v;
    }
    return null;
}

async function getLeadWorkingVariant(leadId) {
    if (!leadId) return null;
    try {
        const { default: sb } = await import('./supabase.js');
        const { data } = await sb
            .from('leads')
            .select('working_phone_variant')
            .eq('id', leadId)
            .maybeSingle();
        return data?.working_phone_variant || null;
    } catch { return null; }
}

async function markLeadWorkingVariant(leadId, variant) {
    if (!leadId || !variant) return;
    try {
        const { default: sb } = await import('./supabase.js');
        await sb
            .from('leads')
            .update({ working_phone_variant: variant })
            .eq('id', leadId)
            .is('working_phone_variant', null);
    } catch { /* não crítico */ }
}

/**
 * Procura um chat já existente nessa conta cujo attendee bata com qualquer
 * uma das variantes do telefone, com mensagens RECENTES delivered=1
 * (= número confirmadamente válido na rede WhatsApp).
 * Retorna { chat_id } ou null.
 */
async function findVerifiedChatByPhone(accountId, phoneVariants) {
    if (!accountId || !phoneVariants?.length) return null;
    try {
        const list = await req(`/chats?account_id=${accountId}&limit=100`);
        for (const chat of (list.items || [])) {
            const att = await req(`/chats/${chat.id}/attendees`).catch(() => null);
            const attendeePhones = (att?.items || [])
                .map(a => String(a.specifics?.phone_number || a.phone_number || a.public_identifier || '').replace(/\D/g, ''))
                .filter(Boolean);
            const matches = attendeePhones.some(p => phoneVariants.some(v => p.endsWith(v) || v.endsWith(p)));
            if (!matches) continue;

            // Confirma que o chat já teve msg outbound entregue (= número válido)
            const msgs = await req(`/chats/${chat.id}/messages?limit=10`).catch(() => null);
            const hasDelivered = (msgs?.items || []).some(m => m.is_sender && m.delivered === 1);
            if (hasDelivered) return { chat_id: chat.id };
        }
    } catch { /* fallback silencioso */ }
    return null;
}

// Janela curta pra detectar "chat fantasma" (Unipile aceita o POST mas o número
// não existe no WhatsApp do destinatário). 20s é suficiente pra delivery normal
// completar e ainda parecer "instantâneo" pro atendente.
const POST_SEND_DELIVERY_CHECK_DELAY_MS = 20_000;

/**
 * Inicia nova conversa pelo Unipile.
 * - Resolve a conta (com fallback se env stale)
 * - Se o lead já tem `working_phone_variant` confirmada, usa ela direto (sem chute)
 * - Procura chat já validado pra alguma variante do telefone (com/sem 9 BR);
 *   se achar, MANDA NELE em vez de criar duplicata fantasma
 * - Senão, cria chat novo e agenda checagem de entrega em ~20s — se a primeira
 *   mensagem não foi entregue (delivered=0), reenvia na variante alternativa
 *   automaticamente. Reduz a janela de "engoliu mensagem" de 5min pra ~20s.
 *
 * options:
 *   - leadId         — pra ler/gravar lead.working_phone_variant
 *   - conversationId — pra atualizar conversation.whatsapp_chat_id se trocar
 *                      e marcar a msg outbound como retry_attempted_at
 *   - _isRetry       — flag interna; quando true, NÃO agenda nova checagem
 *                      (evita loop). Usado pelo delivery check e pelo
 *                      delivery-retry-worker.
 */
export async function startNewChat(phoneNumber, text, accountId = null, options = {}) {
    const { leadId = null, conversationId = null, _isRetry = false } = options;

    let acct = accountId || await getWhatsAppAccountId();

    if (acct) {
        try {
            const r = await fetch(`${BASE}/accounts/${acct}`, {
                headers: { 'X-API-KEY': API_KEY }, signal: AbortSignal.timeout(4000),
            });
            if (!r.ok) acct = null;
        } catch { acct = null; }
    }
    if (!acct) {
        const all = await listAccounts().catch(() => null);
        const items = all?.items || [];
        const wa = items.find(a =>
            (a.type || a.provider || '').toUpperCase() === 'WHATSAPP'
            && Array.isArray(a.sources) && a.sources[0]?.status
            && /^(ok|connected|running|ok_for_now)$/i.test(a.sources[0].status)
        );
        acct = wa?.id || null;
    }
    if (!acct) throw new Error('Nenhuma conta WhatsApp conectada no Unipile');

    // Camada 1 (memória): se o lead já tem variante confirmada, sobrescreve o
    // número original com ela. Pula o palpite — vai direto na que funciona.
    if (!_isRetry && leadId) {
        const working = await getLeadWorkingVariant(leadId);
        if (working) {
            const target = pickPhoneByVariant(phoneNumber, working);
            const currentVariant = phoneToVariant(phoneNumber);
            if (target && currentVariant && currentVariant !== working) {
                logger.info('startNewChat: usando working variant gravada', {
                    lead_id: leadId, working, from: phoneNumber, to: target,
                });
                phoneNumber = target;
            }
        }
    }

    // Tenta achar um chat já confirmado (delivered=1 em msg anterior) pra alguma
    // variante do número. Evita o caso clássico do "5192924470 sem 9" sendo
    // mandado como "51992924470 com 9" → chat fantasma nunca entrega.
    const variants = brPhoneVariants(phoneNumber);
    const existing = await findVerifiedChatByPhone(acct, variants);
    if (existing?.chat_id) {
        const sendResult = await sendMessage(existing.chat_id, text);
        return {
            id: existing.chat_id,
            chat_id: existing.chat_id,
            reused_existing: true,
            message_id: sendResult?.message_id,
        };
    }

    // Sem chat verificado existente — cria novo com o phone (já corrigido se tinha working)
    const fd = new FormData();
    fd.append('account_id', acct);
    fd.append('text',       text);
    fd.append('attendees_ids', phoneNumber);
    const result = await req('/chats', { method: 'POST', body: fd });
    const newChatId = result?.id || result?.chat_id;

    // Camada 2 (detecção rápida): se há variante alternativa plausível,
    // checa entrega em 20s. Se ghost chat → reenvia na alternativa.
    if (!_isRetry && newChatId && variants.length >= 2) {
        const alternate = variants.find(v => v.replace(/\D/g, '') !== String(phoneNumber).replace(/\D/g, ''));
        if (alternate) {
            scheduleDeliveryCheck({
                chatId: newChatId,
                acct,
                text,
                originalPhone: phoneNumber,
                alternatePhone: alternate,
                leadId,
                conversationId,
            });
        }
    }

    return result;
}

/**
 * Agenda verificação ~20s após criar chat novo. Se a 1ª msg não foi entregue,
 * reenvia na variante alternativa (sem 9 ↔ com 9), atualiza conversation pro
 * novo chat_id e marca a msg original como retry_attempted_at (pra não duplicar
 * com o delivery-retry-worker dos 5min).
 */
function scheduleDeliveryCheck({ chatId, acct, text, originalPhone, alternatePhone, leadId, conversationId }) {
    setTimeout(async () => {
        try {
            const msgs = await req(`/chats/${chatId}/messages?limit=5`).catch(() => null);
            const items = msgs?.items || [];
            const lastSent = items.find(m => m.is_sender);

            if (lastSent && (lastSent.delivered === 1 || lastSent.seen === 1)) {
                // Entrega ok — registra a variante que funcionou
                const variant = phoneToVariant(originalPhone);
                if (leadId && variant) await markLeadWorkingVariant(leadId, variant);
                return;
            }

            logger.info('Delivery check: ghost chat detectado, reenviando na alternativa', {
                chat_id: chatId, original: originalPhone, alternate: alternatePhone,
                lead_id: leadId, conversation_id: conversationId,
            });

            const altResult = await startNewChat(alternatePhone, text, acct, {
                leadId, conversationId, _isRetry: true,
            }).catch(err => {
                logger.warn('Delivery check: alt send falhou', { error: err.message });
                return null;
            });
            const altChatId = altResult?.id || altResult?.chat_id;

            if (conversationId && altChatId && altChatId !== chatId) {
                try {
                    const { default: sb } = await import('./supabase.js');
                    await sb
                        .from('conversations')
                        .update({ whatsapp_chat_id: altChatId })
                        .eq('id', conversationId);
                } catch { /* não crítico */ }
            }

            // Marca a msg outbound original (a que ficou no ghost chat) como já
            // retentada — evita o worker dos 5min disparar uma terceira tentativa.
            if (conversationId) {
                try {
                    const { default: sb } = await import('./supabase.js');
                    const { data: orig } = await sb
                        .from('messages')
                        .select('id')
                        .eq('conversation_id', conversationId)
                        .eq('direction', 'outbound')
                        .is('retry_attempted_at', null)
                        .order('created_at', { ascending: false })
                        .limit(1)
                        .maybeSingle();
                    if (orig?.id) {
                        await sb
                            .from('messages')
                            .update({ retry_attempted_at: new Date().toISOString() })
                            .eq('id', orig.id);
                    }
                } catch { /* não crítico */ }
            }
        } catch (err) {
            logger.warn('Delivery check failed', { chat_id: chatId, error: err.message });
        }
    }, POST_SEND_DELIVERY_CHECK_DELAY_MS);
}

export function getAttachmentUrl(uri) {
    if (!uri || !isAvailable()) return null;
    const parts = uri.replace('att://', '').split('/');
    return `${BASE}/attachments/${parts.slice(1).join('/')}?X-API-KEY=${API_KEY}`;
}

// ─── Polling ──────────────────────────────────────────────────────────

// Polling agora é fallback: webhook em /api/webhooks/unipile dá real-time.
// 10s → 60s reduz carga sem perder cobertura (webhook pega o que importa).
// Override via env UNIPILE_POLL_INTERVAL_MS pra ajuste pontual.
export async function startPolling(intervalMs = parseInt(process.env.UNIPILE_POLL_INTERVAL_MS || '60000', 10)) {
    if (!isAvailable()) {
        logger.warn('Unipile não configurado — polling desativado');
        return;
    }
    logger.info('WhatsApp polling iniciado', { interval_ms: intervalMs });

    async function poll() {
        try {
            const result = await listChats({ limit: 20 });
            const chats  = result.items || [];

            for (const chat of chats) {
                await processChat(chat);
            }
            _lastPollTime = Date.now();
        } catch (err) {
            logger.warn('Polling error', { error: err.message });
        }
    }

    await poll();
    _pollingInterval = setInterval(poll, intervalMs);
}

export function stopPolling() {
    if (_pollingInterval) clearInterval(_pollingInterval);
}

/**
 * Re-sincroniza uma conversa específica: puxa as últimas N mensagens do
 * Unipile e roda pelo saveMessage (que deduplica por unipile_message_id).
 *
 * Uso: recuperar mensagens que o polling perdeu por bugs/erros transitórios.
 * Mais barato que processChat completo — pula match de lead/Pipedrive porque
 * a conversa já existe.
 *
 * @returns {{ fetched, inserted, skipped, errored }}
 */
export async function resyncConversation(conversationId, { limit = 50 } = {}) {
    if (!isAvailable()) throw new Error('Unipile não configurado');
    const { default: sb } = await import('./supabase.js');

    const { data: conversation, error } = await sb
        .from('conversations')
        .select('*, leads(name)')
        .eq('id', conversationId)
        .single();
    if (error || !conversation) throw new Error('Conversa não encontrada');
    if (!conversation.whatsapp_chat_id) {
        throw new Error('Conversa sem whatsapp_chat_id (não é WhatsApp)');
    }

    const msgs = await getMessages(conversation.whatsapp_chat_id, { limit });
    const allMsgs = msgs.items || [];

    const accountId = conversation.whatsapp_account_id;
    const accountOwner = accountId ? await getAccountOwner(accountId) : null;

    let inserted = 0, skipped = 0, errored = 0;
    for (const rawMsg of allMsgs) {
        try {
            const msg = whatsapp.normalizeMessage(rawMsg);
            const isOutbound = msg.direction === 'outbound';
            const outboundName = accountOwner?.user_name || 'Atendente';

            const saved = await saveMessage({
                conversation_id:    conversation.id,
                direction:          msg.direction,
                sender_type:        isOutbound ? 'human' : 'lead',
                sender_name:        isOutbound ? outboundName : (conversation.leads?.name || 'Lead'),
                sent_by_user_id:    isOutbound ? (accountOwner?.user_id || null) : null,
                sent_by_name:       isOutbound ? outboundName : null,
                content:            msg.text,
                attachments:        msg.attachments,
                unipile_message_id: msg.id,
                created_at:         msg.timestamp,
                delivered:          !!msg.delivered,
                seen:               !!msg.seen,
            });

            if (saved) inserted++;
            else skipped++;
        } catch (err) {
            errored++;
            logger.warn('Resync: erro processando msg', {
                conversation_id: conversationId,
                msg_id: rawMsg?.id,
                error: err.message,
            });
        }
    }

    if (inserted > 0) {
        await updateConversation(conversation.id, {
            last_message_at: new Date().toISOString(),
        });
    }

    logger.info('Resync conversa concluído', {
        conversation_id: conversationId,
        chat_id: conversation.whatsapp_chat_id,
        fetched: allMsgs.length,
        inserted,
        skipped,
        errored,
    });

    return { fetched: allMsgs.length, inserted, skipped, errored };
}

// Detecta se um chat da Unipile é um grupo WhatsApp.
// Heurísticas: chat.type === 1 (Unipile flag) OU provider_id termina em @g.us (formato WA grupos).
function isGroupChat(chat) {
    return chat?.type === 1 || String(chat?.provider_id || '').endsWith('@g.us');
}

// Mapeia attendees do Unipile pro shape simples que salvamos em group_participants.
// IMPORTANTE: campo `id` é o attendee_id da Unipile — chave canônica que casa
// com msg.sender_attendee_id pra resolver o nome do remetente em mensagens
// (Unipile não devolve sender.name confiavelmente em group chats).
function normalizeParticipants(attendees) {
    return (attendees || []).map(a => ({
        id:          a.id || null,
        provider_id: a.provider_id || null,
        name:        a.name || null,
        phone:       a.specifics?.phone_number || a.phone_number || null,
        is_self:     !!a.is_self,
    }));
}

// Cascata pra resolver o nome do remetente de uma msg em group chat:
//   1. msg.senderName (raro, mas se vier usa)
//   2. Lookup attendee_id em group_participants[].id (caminho canônico)
//   3. msg.pushName (vem do JSON original do WhatsApp, fallback robusto)
//   4. 'Membro' como último recurso
function resolveGroupSenderName(msg, participants) {
    if (msg.senderName) return msg.senderName;

    if (msg.senderAttendeeId && Array.isArray(participants)) {
        const found = participants.find(p => p.id === msg.senderAttendeeId);
        if (found?.name) return found.name;
    }

    if (msg.pushName) return msg.pushName;

    return 'Membro';
}

// Processa chat de grupo. Diferenças em relação a DM:
//   - Sem lead vinculado (lead_id = null) — grupos não viram leads
//   - group_subject = chat.name; group_participants = todos attendees
//   - Mensagens inbound usam msg.senderName real (não nome de "lead")
//   - Sem onInboundMessage (não tem deal pra criar atividade Pipedrive)
async function processGroupChat(chat) {
    try {
        // Chave canônica: provider_id (JID @g.us) é o mesmo entre contas
        // Branddi que veem o grupo. Fallback pra chat.id legado pra grupos
        // antigos sem provider_id ainda backfillado.
        let conversation = chat.provider_id
            ? await findGroupByProviderId(chat.provider_id)
            : null;
        if (!conversation) {
            conversation = await findConversationByChat(chat.id);
        }
        const preExisted = !!conversation;
        let wasCreatedNow = false;

        const attendees = (await getChatAttendees(chat.id)).items || [];
        const participants = normalizeParticipants(attendees);

        if (!preExisted) {
            // Tipo da conversa segue default da conta WhatsApp (mesmo critério das DMs)
            let convType = 'inbound';
            if (chat.account_id) {
                try {
                    const { default: sb } = await import('./supabase.js');
                    const { data: acc } = await sb
                        .from('whatsapp_accounts')
                        .select('default_conversation_type')
                        .eq('unipile_account_id', chat.account_id)
                        .maybeSingle();
                    if (acc?.default_conversation_type) convType = acc.default_conversation_type;
                } catch { /* fallback inbound */ }
            }

            const accountId = chat.account_id || null;
            try {
                conversation = await createConversation({
                    lead_id:              null,
                    whatsapp_chat_id:     chat.id,
                    whatsapp_account_id:  accountId,
                    whatsapp_account_ids: accountId ? [accountId] : [],
                    whatsapp_chat_ids:    accountId ? { [accountId]: chat.id } : {},
                    group_provider_id:    chat.provider_id || null,
                    channel:              'whatsapp_group',
                    type:                 convType,
                    status:               'in_progress',
                    chatbot_stage:        'human',
                    last_message_at:      new Date().toISOString(),
                    is_group:             true,
                    group_subject:        chat.name || null,
                    group_participants:   participants,
                });

                wasCreatedNow = true;
                logger.info('Grupo WhatsApp criado', {
                    chat_id: chat.id, provider_id: chat.provider_id,
                    subject: chat.name, members: participants.length,
                });
            } catch (err) {
                // Race: outra conta criou a row canonical entre o find e o create.
                // O UNIQUE em group_provider_id força isso (23505). Re-busca e
                // segue como se fosse existente — o merge abaixo vai adicionar
                // esta conta ao array.
                if (err.code === '23505' && chat.provider_id) {
                    conversation = await findGroupByProviderId(chat.provider_id);
                    if (!conversation) throw err; // não era race, é outro problema
                    logger.info('Grupo já criado por outra conta concorrente', {
                        chat_id: chat.id, provider_id: chat.provider_id,
                    });
                } else {
                    throw err;
                }
            }
        }

        // Merge sempre que a row pré-existia (incluindo race fallback).
        // Quando criamos agora, os campos já vieram corretos no insert.
        if (!wasCreatedNow) {
            // Atualiza subject, participants e o mapping de account → chat_id.
            // Caso típico: grupo já tem row canonical de outra conta Branddi,
            // esta conta agora também está vendo o grupo — adiciona ela ao array.
            const updates = {};
            if (chat.name && chat.name !== conversation.group_subject) {
                updates.group_subject = chat.name;
            }
            const oldIds = new Set((conversation.group_participants || []).map(p => p.provider_id));
            const newIds = new Set(participants.map(p => p.provider_id));
            const sameSet = oldIds.size === newIds.size && [...oldIds].every(id => newIds.has(id));
            if (!sameSet) updates.group_participants = participants;

            // Merge da conta atual no array + mapping (idempotente)
            if (chat.account_id) {
                const accIds = new Set(conversation.whatsapp_account_ids || []);
                const chatIds = { ...(conversation.whatsapp_chat_ids || {}) };
                if (!accIds.has(chat.account_id) || chatIds[chat.account_id] !== chat.id) {
                    accIds.add(chat.account_id);
                    chatIds[chat.account_id] = chat.id;
                    updates.whatsapp_account_ids = [...accIds];
                    updates.whatsapp_chat_ids = chatIds;
                }
                // Backfill provider_id em rows antigas
                if (!conversation.group_provider_id && chat.provider_id) {
                    updates.group_provider_id = chat.provider_id;
                }
            }

            if (Object.keys(updates).length > 0) {
                await updateConversation(conversation.id, updates);
                Object.assign(conversation, updates);
            }
        }

        // Busca mensagens: novo → histórico maior; existente → janela do polling
        const fetchLimit = wasCreatedNow ? 50 : 10;
        const msgs = await getMessages(chat.id, { limit: fetchLimit });
        const allMsgs = msgs.items || [];

        const newMsgs = wasCreatedNow
            ? allMsgs
            : allMsgs.filter(m => new Date(m.timestamp) > new Date(_lastPollTime - 5_000));

        for (const rawMsg of newMsgs) {
            try {
                const msg = whatsapp.normalizeMessage(rawMsg);
                const isOutbound = msg.direction === 'outbound';

                // EM GRUPO: nome do remetente real, não "lead". Outbound = quem da
                // nossa conta mandou (geralmente atendente único atribuído à account).
                let senderName;
                if (isOutbound) {
                    senderName = await resolveOutboundSenderName(chat.account_id);
                } else {
                    senderName = resolveGroupSenderName(msg, conversation.group_participants);
                }

                await saveMessage({
                    conversation_id:    conversation.id,
                    direction:          msg.direction,
                    sender_type:        isOutbound ? 'human' : 'lead',
                    sender_name:        senderName,
                    content:            msg.text,
                    attachments:        msg.attachments,
                    unipile_message_id: msg.id,
                    created_at:         msg.timestamp,
                    delivered:          !!msg.delivered,
                    seen:               !!msg.seen,
                    via_account_id:     chat.account_id || null,
                });
                // Sem onInboundMessage — grupos não criam atividade Pipedrive
            } catch (err) {
                logger.warn('Polling: erro processando msg de grupo, seguindo', {
                    chat_id: chat.id, msg_id: rawMsg?.id, error: err.message,
                });
            }
        }

        if (newMsgs.length > 0) {
            await updateConversation(conversation.id, {
                last_message_at: new Date().toISOString(),
            });
        }
    } catch (err) {
        logger.warn('Erro ao processar grupo', { chat_id: chat.id, error: err.message });
    }
}

// Pra outbound em grupo: quem é o "atendente"? Resolve via account owner
// (mesma cascata por permissions usada pra atribuição Pipedrive).
async function resolveOutboundSenderName(accountId) {
    if (!accountId) return 'Atendente';
    const owner = await getAccountOwner(accountId);
    return owner?.user_name || 'Atendente';
}

/**
 * pickSendAccount — escolhe qual conta WhatsApp Branddi vai mandar a msg
 * num grupo com múltiplas contas membros.
 *
 * Cascata (mais específica → mais permissiva):
 *   1. Conta no `whatsapp_account_ids` da conv que está em `user.permissions.whatsapp_accounts`
 *      (user tem permissão explícita E é membro)
 *   2. Conta no array que tem `display_label` ou `connected_by_user_id` setado
 *      (configurada no app, mesmo que o user logado não tenha permissão direta)
 *   3. Primeira do array — fallback de emergência (grupo só com contas órfãs)
 *
 * Retorna { accountId, chatId } ou null se não há nada utilizável.
 */
export async function pickSendAccount(conversation, user) {
    if (!conversation?.is_group) return null;
    const accountIds = Array.isArray(conversation.whatsapp_account_ids)
        ? conversation.whatsapp_account_ids
        : [];
    const chatIds = conversation.whatsapp_chat_ids || {};
    if (accountIds.length === 0) return null;

    const resolve = (accId) => ({
        accountId: accId,
        chatId: chatIds[accId] || null,
    });

    // 1. Match com permissão do user logado
    const userAccounts = user?.permissions?.whatsapp_accounts || [];
    const userMatch = accountIds.find(id => userAccounts.includes(id));
    if (userMatch) return resolve(userMatch);

    // 2. Conta configurada (tem display_label ou connected_by_user_id)
    try {
        const { default: sb } = await import('./supabase.js');
        const { data: configured } = await sb
            .from('whatsapp_accounts')
            .select('unipile_account_id, display_label, connected_by_user_id')
            .in('unipile_account_id', accountIds);
        const configuredAcc = (configured || []).find(
            a => a.display_label || a.connected_by_user_id
        );
        if (configuredAcc) return resolve(configuredAcc.unipile_account_id);
    } catch { /* fallback abaixo */ }

    // 3. Fallback
    return resolve(accountIds[0]);
}

async function processChat(chat) {
    try {
        // Grupos seguem um caminho dedicado — sem lead, sem deal, sem auto-activity.
        // (Ver processGroupChat abaixo)
        if (isGroupChat(chat)) {
            return await processGroupChat(chat);
        }

        let conversation = await findConversationByChat(chat.id);
        let isNewConversation = false;

        if (!conversation) {
            isNewConversation = true;
            const attendees = (await getChatAttendees(chat.id)).items || [];
            const rawContact = attendees.find(a => !a.is_self);
            if (!rawContact) return;

            // Normalize via provider abstraction
            const contact = whatsapp.normalizeContact(rawContact);
            const phone = normalizePhone(contact.phone);
            // Contatos @lid (LID = Linked Identifier do WhatsApp) trazem phone
            // derivado e às vezes inexato — usar fuzzy match (last 8 digits)
            // pra evitar duplicar leads que já existem com o mesmo número real.
            const isLidAttendee = String(contact.providerId || '').endsWith('@lid');
            let lead = null;
            if (phone) {
                lead = isLidAttendee
                    ? await findLeadByPhoneFuzzy(phone)
                    : await findLeadByPhone(phone);
            }

            if (!lead) {
                if (isLidAttendee) {
                    logger.info('Criando lead via attendee @lid sem match', {
                        attendee_id: contact.providerId, phone,
                    });
                }
                lead = await createLead({
                    name:   contact.name || phone || 'Desconhecido',
                    phone,
                    origin: 'whatsapp_direct',
                    origin_metadata: { attendee_id: contact.providerId },
                });
            } else if (isLidAttendee && lead.phone !== phone) {
                logger.info('Match fuzzy de lead via @lid', {
                    attendee_id: contact.providerId, attendee_phone: phone, lead_phone: lead.phone, lead_id: lead.id,
                });
            }

            // Auto-match com Pipedrive (person + deals) — cascata conservadora:
            // (1) phone exato / variações BR
            // (2) nome exato do Unipile (só se match único)
            // (3) Apollo (opt-in via setting apollo_auto_match): descobre email/nome
            //     e tenta match por email no Pipedrive (único match)
            if (phone && !lead.crm_person_id) {
                try {
                    const matchResult = await smartMatchPipedrivePerson({
                        phone,
                        name: contact.name,
                    });

                    if (matchResult?.person) {
                        const pdPerson = matchResult.person;
                        const updates = {
                            crm_person_id: String(pdPerson.id),
                        };
                        if (!lead.name || lead.name === phone) updates.name = pdPerson.name;
                        if (!lead.company_name && pdPerson.org_name) updates.company_name = pdPerson.org_name;

                        const deals = await getDealsForPerson(pdPerson.id);
                        if (deals.length > 0) updates.crm_deal_id = String(deals[0].id);

                        await updateLead(lead.id, updates);
                        lead = { ...lead, ...updates };
                        logger.info('Auto-matched lead with Pipedrive', {
                            phone, person_id: pdPerson.id, deals: deals.length,
                            strategy: matchResult.strategy,
                        });
                    }
                } catch (err) {
                    logger.warn('Pipedrive auto-match failed', { phone, error: err.message });
                }
            }

            // Verifica quem iniciou a conversa: busca msgs para determinar
            // Se a primeira msg é outbound (nós iniciamos) → sem bot
            // Se é inbound (lead iniciou) → bot ativo apenas se veio do site (form)
            const initMsgs = await getMessages(chat.id, { limit: 5 });
            const initItems = initMsgs.items || [];
            // Ordena por timestamp (mais antiga primeiro)
            initItems.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
            const firstMsg = initItems[0];
            const weStarted = firstMsg ? firstMsg.is_sender : false;

            // Auto-replies eliminados — toda conversa entra direto em estágio humano.
            const botStage = 'human';

            // Tipo da conversa vem do default da conta WhatsApp.
            // Ex: número da Harylanne (5511999802791) é prospecting; outros 'inbound'.
            // Permite "pessoal SDR" vs "site oficial" coexistirem na mesma plataforma.
            let convType = 'inbound';
            if (chat.account_id) {
                try {
                    const { data: acc } = await import('./supabase.js').then(m =>
                        m.default
                            .from('whatsapp_accounts')
                            .select('default_conversation_type')
                            .eq('unipile_account_id', chat.account_id)
                            .maybeSingle()
                    );
                    if (acc?.default_conversation_type) convType = acc.default_conversation_type;
                } catch { /* fallback inbound */ }
            }

            conversation = await createConversation({
                lead_id:             lead.id,
                whatsapp_chat_id:    chat.id,
                whatsapp_account_id: chat.account_id || null,
                channel:             'whatsapp_direct',
                type:                convType,
                status:              weStarted ? 'in_progress' : 'waiting',
                chatbot_stage:       botStage,
                last_message_at:     new Date().toISOString(),
            });

            if (botStage === 'human') {
                logger.info('Bot desativado para conversa', { phone, reason: weStarted ? 'outbound' : 'direct_contact', origin: lead.origin });
            }
        }

        // Self-heal: backfill whatsapp_account_id em conversas antigas (antes da migration 005).
        // Roda uma vez por conversa — próxima passada do polling já não entra aqui.
        if (!isNewConversation && !conversation.whatsapp_account_id && chat.account_id) {
            await updateConversation(conversation.id, { whatsapp_account_id: chat.account_id });
            conversation.whatsapp_account_id = chat.account_id;
        }

        // Busca mensagens: conversa nova → importa histórico recente; existente → só desde último poll
        const fetchLimit = isNewConversation ? 50 : 10;
        const msgs  = await getMessages(chat.id, { limit: fetchLimit });
        const allMsgs = msgs.items || [];

        // Janela do polling. Também inclui msgs outbound dentro do limit cujos
        // attachments locais ainda não têm att.id — caso típico: imagem enviada
        // pela UI antes do fix da reconciliação. Sem isso, ela nunca fica com
        // preview porque já passou da janela de 5s.
        let recentOutboundIdsMissingAtt = new Set();
        if (!isNewConversation) {
            try {
                const { default: sb } = await import('./supabase.js');
                const { data: brokenOut = [] } = await sb
                    .from('messages')
                    .select('unipile_message_id, attachments')
                    .eq('conversation_id', conversation.id)
                    .eq('direction', 'outbound')
                    .gte('created_at', new Date(Date.now() - 24 * 3600_000).toISOString());
                recentOutboundIdsMissingAtt = new Set(
                    brokenOut
                        .filter(m => (m.attachments || []).length && !(m.attachments || []).some(a => a.id))
                        .map(m => m.unipile_message_id)
                );
            } catch { /* não crítico */ }
        }
        const newMsgs = isNewConversation
            ? allMsgs
            : allMsgs.filter(m =>
                new Date(m.timestamp) > new Date(_lastPollTime - 5_000)
                || recentOutboundIdsMissingAtt.has(m.id)
            );

        // Descobre quem é o dono da conta WhatsApp (pra gravar nome real em msgs outbound
        // que chegam pelo polling — ex: SDR enviando do celular, não da UI).
        // Cache simples em memória do chat.account_id → { user_id, user_name }.
        let accountOwner = null;
        const accountId = chat.account_id || conversation.whatsapp_account_id;
        if (accountId) {
            accountOwner = await getAccountOwner(accountId);
        }

        for (const rawMsg of newMsgs) {
            // try/catch POR MENSAGEM — um erro em uma msg não pode descartar
            // as restantes daquele newMsgs (era o que acontecia antes:
            // saveMessage lançava em duplicata e o loop morria, perdendo as
            // mensagens novas que ainda viriam atrás na lista).
            try {
            // Normalize via provider abstraction
            const msg = whatsapp.normalizeMessage(rawMsg);

            const isOutbound = msg.direction === 'outbound';
            const outboundName = accountOwner?.user_name || 'Atendente';

            // Reconcilia mensagens que enviamos com ID sintético (script_/media_/human_).
            // Quando o polling traz a mesma msg com o ID real do Unipile, achar a
            // linha "placeholder" pelo conteúdo + janela de 5 min e adotar o ID real,
            // pra evitar duplicata.
            if (isOutbound && msg.id) {
                try {
                    const { default: sb } = await import('./supabase.js');
                    const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
                    const { data: placeholders } = await sb
                        .from('messages')
                        .select('id, unipile_message_id, content, attachments')
                        .eq('conversation_id', conversation.id)
                        .eq('direction', 'outbound')
                        .gte('created_at', cutoff)
                        .or('unipile_message_id.like.media_%,unipile_message_id.like.script_%,unipile_message_id.like.human_%');
                    const sameAttachName = (a, b) => {
                        const an = a?.[0]?.name; const bn = b?.[0]?.name;
                        return an && bn && an === bn;
                    };
                    const match = (placeholders || []).find(p =>
                        (p.content && msg.text && p.content.trim() === msg.text.trim())
                        || sameAttachName(p.attachments, msg.attachments)
                    );
                    if (match && match.unipile_message_id !== msg.id) {
                        // Atualiza id real + adota attachments do Unipile (que
                        // têm id real → uri renderizável) pra preview aparecer.
                        const updates = {
                            unipile_message_id: msg.id,
                            delivered: !!msg.delivered,
                            seen: !!msg.seen,
                        };
                        if (msg.attachments?.length) updates.attachments = msg.attachments;
                        await sb.from('messages').update(updates).eq('id', match.id);
                        continue; // já reconciliado, não insere
                    }
                } catch { /* não crítico */ }
            }

            const saved = await saveMessage({
                conversation_id:    conversation.id,
                direction:          msg.direction,
                sender_type:        isOutbound ? 'human' : 'lead',
                sender_name:        isOutbound ? outboundName : (conversation.leads?.name || 'Lead'),
                sent_by_user_id:    isOutbound ? (accountOwner?.user_id || null) : null,
                sent_by_name:       isOutbound ? outboundName : null,
                content:            msg.text,
                attachments:        msg.attachments,
                unipile_message_id: msg.id,
                created_at:         msg.timestamp,
                delivered:          !!msg.delivered,
                seen:               !!msg.seen,
            });

            // v2: Se saveMessage retorna null, mensagem é DUPLICATA. Mas se a msg
            // já existia, podemos atualizar delivered/seen (que mudam ao longo
            // do tempo conforme o destinatário recebe/lê).
            if (!saved) {
                if (isOutbound) {
                    const { default: sb } = await import('./supabase.js');
                    const update = { delivered: !!msg.delivered, seen: !!msg.seen };
                    // Se a linha local foi gravada pela rota send-media (que não
                    // tem o att.id do Unipile), os attachments lá não têm uri
                    // renderizável. Quando o polling traz a versão "enriquecida"
                    // (com att.id), sobrescrevemos pra preview funcionar.
                    if (msg.attachments?.some(a => a.id)) {
                        const { data: existing } = await sb
                            .from('messages')
                            .select('attachments')
                            .eq('unipile_message_id', msg.id)
                            .single();
                        const existingHasId = (existing?.attachments || []).some(a => a.id);
                        if (!existingHasId) update.attachments = msg.attachments;
                    }
                    await sb
                        .from('messages')
                        .update(update)
                        .eq('unipile_message_id', msg.id);
                }
                continue;
            }

            // v2: Reset bot_away_sent SOMENTE quando um humano respondeu (outbound humano)
            // Isso evita o loop: inbound → reset → away → inbound → reset → away...
            if (msg.direction === 'outbound' && saved.sender_type === 'human' && conversation.bot_away_sent) {
                await updateConversation(conversation.id, { bot_away_sent: false });
            }

            // Auto-create Reply activity in Pipedrive (fire and forget)
            if (msg.direction === 'inbound') {
                onInboundMessage(conversation.id).catch(() => {});
            }
            } catch (err) {
                // Mensagem individual falhou — loga e segue pras próximas.
                logger.warn('Polling: erro processando msg, seguindo', {
                    chat_id: chat.id,
                    msg_id: rawMsg?.id,
                    error: err.message,
                });
            }
        }

        if (newMsgs.length > 0) {
            await updateConversation(conversation.id, {
                last_message_at: new Date().toISOString(),
            });
        }

        // Camada 1 (memória, lado polling): se este chat tem msg outbound entregue
        // e o lead ainda não tem working_phone_variant gravada, descobre qual
        // variante o WhatsApp do destinatário tem registrada (com/sem 9) e grava.
        // Funciona pra conversas iniciadas fora do startNewChat (SDR mandou do
        // celular, contato direto, etc).
        const leadForVariant = conversation.leads;
        const hasDeliveredOutbound = newMsgs.some(m => {
            const norm = whatsapp.normalizeMessage(m);
            return norm.direction === 'outbound' && norm.delivered;
        });
        if (hasDeliveredOutbound && leadForVariant?.id && leadForVariant.phone
            && !leadForVariant.working_phone_variant) {
            try {
                const att = await getChatAttendees(chat.id).catch(() => null);
                const recipient = (att?.items || []).find(a => !a.is_self);
                const recipientPhone = recipient?.specifics?.phone_number
                    || recipient?.phone_number
                    || recipient?.public_identifier
                    || null;
                if (recipientPhone) {
                    const variant = phoneToVariant(recipientPhone);
                    const leadVariants = brPhoneVariants(leadForVariant.phone).map(v => v.replace(/\D/g, ''));
                    const recipientDigits = String(recipientPhone).replace(/\D/g, '');
                    if (variant && leadVariants.some(v => v === recipientDigits)) {
                        await markLeadWorkingVariant(leadForVariant.id, variant);
                        logger.info('working_phone_variant gravada via polling', {
                            lead_id: leadForVariant.id, variant, recipient: recipientDigits,
                        });
                    }
                }
            } catch (err) {
                logger.warn('Falha ao gravar working_phone_variant', { chat_id: chat.id, error: err.message });
            }
        }
    } catch (err) {
        logger.warn('Erro ao processar chat', { chat_id: chat.id, error: err.message });
    }
}
