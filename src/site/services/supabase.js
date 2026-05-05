/**
 * Site Supabase helpers — CRUD enxuto pra Fase 2 (read-only por enquanto).
 * Mais funções (create, update) chegam nas Fases 3-5.
 */
import sb from './db.js';

// ─── LEADS ────────────────────────────────────────────────────────────

export async function listLeads({ limit = 50, offset = 0 } = {}) {
    const { data, error } = await sb
        .from('leads')
        .select('*')
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
    if (error) throw error;
    return data || [];
}

export async function getLeadById(id) {
    const { data } = await sb.from('leads').select('*').eq('id', id).maybeSingle();
    return data || null;
}

export async function updateLead(id, patch) {
    const { data, error } = await sb.from('leads')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id).select().single();
    if (error) throw error;
    return data;
}

// ─── CONVERSATIONS ────────────────────────────────────────────────────

export async function listConversations({
    limit = 50, offset = 0, status, assigned_user_id, mine, currentUserId,
} = {}) {
    let query = sb
        .from('conversations')
        .select('*, leads(id, name, phone, email, company_name)')
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .range(offset, offset + limit - 1);
    if (status) query = query.eq('status', status);
    if (assigned_user_id === 'unassigned') query = query.is('assigned_user_id', null);
    else if (assigned_user_id)             query = query.eq('assigned_user_id', assigned_user_id);
    if (mine && currentUserId)             query = query.eq('assigned_user_id', currentUserId);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

export async function getConversationById(id) {
    const { data } = await sb
        .from('conversations')
        .select('*, leads(*)')
        .eq('id', id)
        .maybeSingle();
    return data || null;
}

// ─── MESSAGES ─────────────────────────────────────────────────────────

export async function getMessages(conversationId, { limit = 100 } = {}) {
    const { data, error } = await sb
        .from('messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
        .limit(limit);
    if (error) throw error;
    return data || [];
}

export async function insertOutboundMessage({
    conversationId, text, unipileMessageId, senderUserId, senderName,
}) {
    const { data, error } = await sb.from('messages').insert({
        conversation_id:    conversationId,
        direction:          'outbound',
        text,
        unipile_message_id: unipileMessageId,
        sender_type:        'human',
        sender_user_id:     senderUserId,
        sender_name:        senderName,
        delivered:          false,
        seen:               false,
    }).select().single();
    if (error) throw error;
    return data;
}

export async function updateConversation(id, patch) {
    const { data, error } = await sb.from('conversations')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id).select().single();
    if (error) throw error;
    return data;
}

export async function getConversationChatInfo(id) {
    const { data } = await sb.from('conversations')
        .select('id, whatsapp_chat_id, whatsapp_account_id, status')
        .eq('id', id).maybeSingle();
    return data || null;
}

// ─── WHATSAPP ACCOUNTS ────────────────────────────────────────────────

export async function listWhatsAppAccounts() {
    const { data, error } = await sb
        .from('whatsapp_accounts')
        .select('*')
        .order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
}
