/**
 * Site Supabase helpers — CRUD enxuto pra Fase 2 (read-only por enquanto).
 * Mais funções (create, update) chegam nas Fases 3-5.
 *
 * Nota workaround mig 022: `sb` aponta pro schema `public` (não mais `site`),
 * e as tabelas viraram views `public.v_site_*`. Joins via PostgREST embedding
 * usam o nome da view (`v_site_leads(...)`). Ver db.js + 022_site_views_in_public.
 */
import sb from './db.js';

// ─── LEADS ────────────────────────────────────────────────────────────

export async function listLeads({ limit = 50, offset = 0 } = {}) {
    const { data, error } = await sb
        .from('v_site_leads')
        .select('*')
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
    if (error) throw error;
    return data || [];
}

export async function getLeadById(id) {
    const { data } = await sb.from('v_site_leads').select('*').eq('id', id).maybeSingle();
    return data || null;
}

export async function updateLead(id, patch) {
    const { data, error } = await sb.from('v_site_leads')
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
        .from('v_site_conversations')
        .select('*, v_site_leads(id, name, phone, email, company_name)')
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .range(offset, offset + limit - 1);
    if (status) query = query.eq('status', status);
    if (assigned_user_id === 'unassigned') query = query.is('assigned_user_id', null);
    else if (assigned_user_id)             query = query.eq('assigned_user_id', assigned_user_id);
    if (mine && currentUserId)             query = query.eq('assigned_user_id', currentUserId);
    const { data, error } = await query;
    if (error) throw error;
    // Normaliza a chave do embed (`v_site_leads`) pra `leads`, mantendo o
    // contrato consumido pelo front (lead embutido em `conv.leads`).
    return (data || []).map(c => renameEmbed(c, 'v_site_leads', 'leads'));
}

export async function getConversationById(id) {
    const { data } = await sb
        .from('v_site_conversations')
        .select('*, v_site_leads(*)')
        .eq('id', id)
        .maybeSingle();
    return data ? renameEmbed(data, 'v_site_leads', 'leads') : null;
}

// ─── MESSAGES ─────────────────────────────────────────────────────────

export async function getMessages(conversationId, { limit = 100 } = {}) {
    const { data, error } = await sb
        .from('v_site_messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
        .limit(limit);
    if (error) throw error;
    return data || [];
}

export async function insertOutboundMessage({
    conversationId, text, unipileMessageId, senderUserId, senderName, attachments,
}) {
    const { data, error } = await sb.from('v_site_messages').insert({
        conversation_id:    conversationId,
        direction:          'outbound',
        text,
        attachments:        attachments || [],
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
    const { data, error } = await sb.from('v_site_conversations')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id).select().single();
    if (error) throw error;
    return data;
}

export async function getConversationChatInfo(id) {
    const { data } = await sb.from('v_site_conversations')
        .select('id, whatsapp_chat_id, whatsapp_account_id, status')
        .eq('id', id).maybeSingle();
    return data || null;
}

// ─── WHATSAPP ACCOUNTS ────────────────────────────────────────────────

export async function listWhatsAppAccounts() {
    const { data, error } = await sb
        .from('v_site_whatsapp_accounts')
        .select('*')
        .order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
}

// ─── HELPERS ──────────────────────────────────────────────────────────

// Renomeia uma chave de embed do PostgREST sem deep-clone. Usado pra
// expor `leads` (esperado pelos consumidores) em vez do nome interno da
// view `v_site_leads`. Exportado pra outros services do site reusarem.
export function renameEmbed(row, from, to) {
    if (!row || !(from in row)) return row;
    const { [from]: val, ...rest } = row;
    return { ...rest, [to]: val };
}
