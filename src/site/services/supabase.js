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

// ─── CONVERSATIONS ────────────────────────────────────────────────────

export async function listConversations({ limit = 50, offset = 0, status } = {}) {
    let query = sb
        .from('conversations')
        .select('*, leads(id, name, phone, email, company_name)')
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .range(offset, offset + limit - 1);
    if (status) query = query.eq('status', status);
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

// ─── WHATSAPP ACCOUNTS ────────────────────────────────────────────────

export async function listWhatsAppAccounts() {
    const { data, error } = await sb
        .from('whatsapp_accounts')
        .select('*')
        .order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
}
