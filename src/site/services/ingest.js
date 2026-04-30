/**
 * Site ingest — polling do Unipile que importa mensagens das contas do site.
 *
 * Sem chatbot, sem auto-reply: este worker SÓ persiste no schema site.* o que
 * já existe no Unipile. Se um humano ainda não respondeu, a conversa fica em
 * 'waiting_human' e a UI mostra na fila — nada é enviado pelo sistema.
 *
 * Isolamento crítico: lê SEMPRE o conjunto de contas registrado em
 * site.whatsapp_accounts (status='active'/'connecting'). Nunca toca em
 * public.* nem chama o serviço de prospecção. Polling roda em paralelo ao da
 * prospecção (src/services/unipile.js), com cadência própria.
 */
import sb from './db.js';
import * as unipile from './unipile.js';
import logger from '../../services/logger.js';
import { normalizePhone } from '../../services/supabase.js';

let _interval = null;
let _lastPollTime = Date.now() - 60_000;

const DEFAULT_INTERVAL_MS = 10_000;

export function isRunning() {
    return _interval !== null;
}

export async function startSitePolling(intervalMs = DEFAULT_INTERVAL_MS) {
    if (_interval) return;
    if (!unipile.isAvailable()) {
        logger.warn('Site Unipile não configurado — polling do site desativado');
        return;
    }

    logger.info('Site WhatsApp polling iniciado', { interval_ms: intervalMs });

    const tick = async () => {
        try {
            await pollOnce();
            _lastPollTime = Date.now();
        } catch (err) {
            logger.warn('Site polling error', { error: err.message });
        }
    };

    await tick();
    _interval = setInterval(tick, intervalMs);
}

export function stopSitePolling() {
    if (_interval) clearInterval(_interval);
    _interval = null;
}

// ─── Core ─────────────────────────────────────────────────────────────

async function pollOnce() {
    const accounts = await getActiveAccounts();
    for (const acc of accounts) {
        try {
            const res = await unipile.listChats(acc.unipile_account_id, { limit: 20 });
            const chats = res.items || [];
            for (const chat of chats) {
                await processChat(chat, acc);
            }
        } catch (err) {
            logger.warn('Site poll account failed', {
                account: acc.unipile_account_id, error: err.message,
            });
        }
    }
}

async function getActiveAccounts() {
    const { data, error } = await sb
        .from('whatsapp_accounts')
        .select('id, unipile_account_id, label, phone_number')
        .neq('status', 'disconnected');
    if (error) {
        logger.warn('Site getActiveAccounts error', { error: error.message });
        return [];
    }
    return data || [];
}

async function processChat(chat, account) {
    const accountId = chat.account_id || account.unipile_account_id;

    let conversation = await findConversationByChat(chat.id);
    let isNew = false;

    if (!conversation) {
        isNew = true;
        const att = await unipile.getChatAttendees(chat.id).catch(() => null);
        const attendees = att?.items || [];
        const rawContact = attendees.find(a => !a.is_self);
        if (!rawContact) return;

        const contact = normalizeContact(rawContact);
        const phone = normalizePhone(contact.phone);

        const lead = phone
            ? await findOrCreateLeadByPhone({
                phone,
                name: contact.name || phone || 'Desconhecido',
                attendeeId: contact.providerId,
            })
            : await createLead({
                name: contact.name || 'Desconhecido',
                origin: 'whatsapp_inbound',
                origin_metadata: { attendee_id: contact.providerId },
            });

        conversation = await createConversation({
            lead_id:             lead.id,
            whatsapp_chat_id:    chat.id,
            whatsapp_account_id: accountId,
            status:              'waiting_human',
            last_message_at:     new Date().toISOString(),
        });
    }

    const fetchLimit = isNew ? 50 : 10;
    const msgsRes = await unipile.getMessages(chat.id, { limit: fetchLimit });
    const items = msgsRes.items || [];
    const since = _lastPollTime - 5_000;
    const fresh = isNew ? items : items.filter(m => new Date(m.timestamp) > new Date(since));

    let touched = false;
    for (const raw of fresh) {
        const msg = normalizeMessage(raw);
        const inserted = await insertMessage({
            conversation_id:    conversation.id,
            direction:          msg.direction,
            text:               msg.text,
            attachments:        msg.attachments,
            unipile_message_id: msg.id,
            delivered:          msg.delivered,
            seen:               msg.seen,
            sender_type:        msg.direction === 'outbound' ? 'human' : 'lead',
            sender_name:        msg.direction === 'outbound' ? null : (conversation.leads?.name || 'Lead'),
            created_at:         msg.timestamp,
        });
        if (inserted) touched = true;
        else if (msg.direction === 'outbound') {
            // Atualiza status de entrega se a mensagem já existia.
            await sb.from('messages')
                .update({ delivered: msg.delivered, seen: msg.seen })
                .eq('unipile_message_id', msg.id);
        }
    }

    if (touched) {
        await sb.from('conversations')
            .update({ last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq('id', conversation.id);
    }
}

// ─── DB helpers (schema site.*) ──────────────────────────────────────

async function findConversationByChat(chatId) {
    const { data } = await sb
        .from('conversations')
        .select('id, lead_id, status, whatsapp_account_id, leads(id, name, phone)')
        .eq('whatsapp_chat_id', chatId)
        .maybeSingle();
    return data || null;
}

async function findOrCreateLeadByPhone({ phone, name, attendeeId }) {
    const { data: existing } = await sb
        .from('leads').select('*').eq('phone', phone).maybeSingle();
    if (existing) return existing;
    return createLead({
        name,
        phone,
        origin: 'whatsapp_inbound',
        origin_metadata: { attendee_id: attendeeId },
    });
}

async function createLead(payload) {
    const { data, error } = await sb.from('leads').insert(payload).select().single();
    if (error) throw error;
    return data;
}

async function createConversation(payload) {
    const { data, error } = await sb.from('conversations').insert(payload).select('*, leads(id, name, phone)').single();
    if (error) throw error;
    return data;
}

/**
 * Insere mensagem com dedup por unipile_message_id. Retorna `null` se já
 * existia (pra que o caller possa atualizar delivered/seen separadamente).
 */
async function insertMessage(payload) {
    const { data, error } = await sb
        .from('messages').insert(payload).select().single();
    if (error) {
        // 23505 = unique_violation (UNIQUE em unipile_message_id)
        if (error.code === '23505') return null;
        logger.warn('site insertMessage error', { error: error.message });
        return null;
    }
    return data;
}

// ─── Normalização (cópia mínima do provider Unipile) ─────────────────

function normalizeMessage(raw) {
    return {
        id:          raw.id,
        text:        raw.text || '',
        direction:   raw.is_sender ? 'outbound' : 'inbound',
        timestamp:   raw.timestamp || raw.created_at,
        attachments: raw.attachments || [],
        delivered:   raw.delivered === 1 || raw.delivered === true,
        seen:        raw.seen === 1 || raw.seen === true,
    };
}

function normalizeContact(raw) {
    const phone = raw.specifics?.phone_number
        || raw.phone_number
        || raw.phone
        || (raw.public_identifier && raw.public_identifier.replace(/@.*/, ''))
        || (!String(raw.provider_id || '').includes('@lid') && raw.provider_id)
        || '';
    const rawName = raw.name || null;
    const name = rawName && /^\+?\d[\d\s\-()]+$/.test(rawName.trim()) ? null : rawName;
    return { phone, name, providerId: raw.provider_id || raw.id };
}
