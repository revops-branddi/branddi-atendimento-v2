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
import { renameEmbed } from './supabase.js';
import { processBotTurn } from './bot.js';

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
                // Site é DM 1-1 (lead clicou em wa.me/<número>). Grupos onde o
                // número foi adicionado caem aqui também — pulamos pra não
                // misturar contexto de prospecção/comunidade no atendimento.
                if (isGroupChat(chat)) continue;
                await processChat(chat, acc);
            }
        } catch (err) {
            logger.warn('Site poll account failed', {
                account: acc.unipile_account_id, error: err.message,
            });
        }
    }
}

// Mesmas heurísticas do polling de prospecção (src/services/unipile.js).
function isGroupChat(chat) {
    return chat?.type === 1 || String(chat?.provider_id || '').endsWith('@g.us');
}

async function getActiveAccounts() {
    const { data, error } = await sb
        .from('v_site_whatsapp_accounts')
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

    // Fetch + filtra ANTES de decidir criar conv. Sem isso o polling
    // criava uma conv vazia a cada tick (10s) toda vez que via um chat
    // sem registro local — inclusive chats que o lead nunca interagiu
    // (ex: o número do site adicionado num grupo, ou conv apagada
    // localmente em cleanup). Com 2 workers no Railway, vinham 2 convs
    // fantasmas por tick, lotando a Inbox.
    const fetchLimit = conversation ? 10 : 50;
    const msgsRes    = await unipile.getMessages(chat.id, { limit: fetchLimit });
    const items      = msgsRes.items || [];
    const NEW_CONV_HISTORY_WINDOW_MS = 5 * 60_000;
    const cutoff = conversation
        ? _lastPollTime - 5_000
        : Date.now() - NEW_CONV_HISTORY_WINDOW_MS;
    const fresh = items.filter(m => new Date(m.timestamp).getTime() > cutoff);

    // Sem conv local + sem inbound fresca = chat fantasma (histórico só
    // antigo, ou apenas outbound). Não cria conv. Sair daqui mantém o
    // polling idempotente: roda de novo daqui a 10s, mesmo resultado,
    // sem efeitos colaterais.
    if (!conversation) {
        const hasFreshInbound = fresh.some(m => !m.is_sender);
        if (!hasFreshInbound) return;

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

        // Conv nova entra no bot por default (DB também tem default='bot',
        // explícito aqui só pra documentar o fluxo).
        conversation = await createConversation({
            lead_id:             lead.id,
            whatsapp_chat_id:    chat.id,
            whatsapp_account_id: accountId,
            status:              'bot',
            bot_stage:           'welcome',
            last_message_at:     new Date().toISOString(),
        });
    }

    let touched = false;
    let hasNewInbound = false;
    let lastInboundText = null;
    let lastInboundTimestamp = null;
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
        if (inserted) {
            touched = true;
            if (msg.direction === 'inbound') {
                hasNewInbound = true;
                // Última msg do lead — se tiver várias num batch, pega o texto
                // da mais recente (items vêm ordenadas desc do Unipile).
                if (lastInboundText == null) {
                    lastInboundText      = msg.text || '';
                    lastInboundTimestamp = msg.timestamp;
                }
            }
        }
        else if (msg.direction === 'outbound') {
            // Atualiza status de entrega se a mensagem já existia.
            await sb.from('v_site_messages')
                .update({ delivered: msg.delivered, seen: msg.seen })
                .eq('unipile_message_id', msg.id);
        }
    }

    if (touched) {
        await sb.from('v_site_conversations')
            .update({ last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq('id', conversation.id);
    }

    // Bot turn: chama o bot só se (a) chegou inbound nova nesse poll,
    // (b) a inbound é REALMENTE recente (≤60s), e (c) a conv ainda está
    // sob controle do bot.
    //
    // O check de "fresca" é crítico: quando uma conv é deletada/recriada
    // (ex: cleanup manual de teste, sync forçada), o `isNew=true` faz o
    // ingest puxar até 50 msgs históricas do Unipile e inserir todas.
    // Sem esse filtro, o bot dispararia welcome usando msgs de horas/dias
    // atrás como gatilho — o lead percebe como auto-mensagem espontânea
    // ("recebeu welcome 10min depois sem ter respondido"). Regra dura do
    // projeto: bot só responde a inbound NOVA. Re-import de histórico
    // nunca aciona turno do bot.
    //
    // Reload da conv pra pegar bot_stage atualizado caso processChat
    // tenha sido chamado em paralelo.
    const FRESH_INBOUND_WINDOW_MS = 60_000;
    const inboundIsFresh = lastInboundTimestamp
        && (Date.now() - new Date(lastInboundTimestamp).getTime()) < FRESH_INBOUND_WINDOW_MS;
    if (hasNewInbound && inboundIsFresh) {
        const { data: freshConv } = await sb.from('v_site_conversations')
            .select('id, lead_id, status, bot_stage, bot_attempts, whatsapp_chat_id, whatsapp_account_id')
            .eq('id', conversation.id)
            .maybeSingle();
        if (freshConv && freshConv.status === 'bot') {
            try {
                await processBotTurn(freshConv, lastInboundText);
            } catch (err) {
                logger.error('Bot turn failed', { conv_id: conversation.id, error: err.message });
            }
        }
    } else if (hasNewInbound && !inboundIsFresh) {
        logger.info('Site bot skipped — inbound is historical (re-import)', {
            conv_id: conversation.id, last_inbound_ts: lastInboundTimestamp,
        });
    }
}

// ─── DB helpers (via views public.v_site_*; ver mig 022) ─────────────

async function findConversationByChat(chatId) {
    // Só convs ATIVAS — resolved/archived ficam de fora pra não fazer
    // o polling tentar empilhar msgs novas num atendimento já encerrado.
    // Casa com o UNIQUE PARTIAL index em (whatsapp_chat_id) WHERE status
    // ativo (migration 020): no máx 1 row por chat aqui, garantido.
    const { data } = await sb
        .from('v_site_conversations')
        .select('id, lead_id, status, whatsapp_account_id, v_site_leads(id, name, phone)')
        .eq('whatsapp_chat_id', chatId)
        .in('status', ['bot', 'waiting_human', 'in_progress'])
        .maybeSingle();
    return data ? renameEmbed(data, 'v_site_leads', 'leads') : null;
}

async function findOrCreateLeadByPhone({ phone, name, attendeeId }) {
    const { data: existing } = await sb
        .from('v_site_leads').select('*').eq('phone', phone).maybeSingle();
    if (existing) return existing;
    return createLead({
        name,
        phone,
        origin: 'whatsapp_inbound',
        origin_metadata: { attendee_id: attendeeId },
    });
}

async function createLead(payload) {
    const { data, error } = await sb.from('v_site_leads').insert(payload).select().single();
    if (error) throw error;
    return data;
}

async function createConversation(payload) {
    const { data, error } = await sb.from('v_site_conversations').insert(payload).select('*, v_site_leads(id, name, phone)').single();
    if (error) {
        // 23505 = unique_violation. Outro worker (Railway tem 2 replicas)
        // ganhou a corrida e já criou a conv ativa pra esse chat. Não é
        // erro de verdade — relê e devolve a row vencedora.
        if (error.code === '23505') {
            const { data: existing } = await sb
                .from('v_site_conversations')
                .select('*, v_site_leads(id, name, phone)')
                .eq('whatsapp_chat_id', payload.whatsapp_chat_id)
                .in('status', ['bot', 'waiting_human', 'in_progress'])
                .maybeSingle();
            if (existing) return renameEmbed(existing, 'v_site_leads', 'leads');
        }
        throw error;
    }
    return renameEmbed(data, 'v_site_leads', 'leads');
}

/**
 * Insere mensagem com dedup por unipile_message_id. Retorna `null` se já
 * existia (pra que o caller possa atualizar delivered/seen separadamente).
 */
async function insertMessage(payload) {
    const { data, error } = await sb
        .from('v_site_messages').insert(payload).select().single();
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
