/**
 * Supabase Client — CRUD helpers para todas as tabelas
 * v2: Fix N+1 no inbox, settings via DB, dedup graceful, logger
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import logger from './logger.js';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

export default supabase;

function sanitizeSearchTerm(term) {
    return String(term || '')
        .replace(/[\\%_]/g, '\\$&')
        .replace(/[(),`]/g, '')
        .slice(0, 200);
}

// ─── LEADS ────────────────────────────────────────────────────────────

export async function createLead(data) {
    const { data: lead, error } = await supabase
        .from('leads')
        .insert([{ ...data, updated_at: new Date().toISOString() }])
        .select()
        .single();
    if (error) throw error;
    return lead;
}

export async function findLeadByPhone(phone) {
    const normalized = normalizePhone(phone);
    const { data } = await supabase
        .from('leads')
        .select('*')
        .eq('phone', normalized)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
    return data || null;
}

/**
 * Lookup tolerante: tenta match exato primeiro; se falhar, tenta pelos
 * últimos 8 dígitos (núcleo do número que raramente muda — DDI/DDD/9 podem
 * variar sem alterar a identidade do assinante).
 *
 * Usar APENAS quando a fonte do phone é confiável só "morally" (ex: contatos
 * @lid do WhatsApp, onde Unipile às vezes deriva um phone aproximado).
 *
 * Retorna o lead apenas se houver UM ÚNICO match no fallback — se houver
 * 0 ou 2+ candidatos, retorna null pra forçar criação de novo lead.
 */
export async function findLeadByPhoneFuzzy(phone) {
    const exact = await findLeadByPhone(phone);
    if (exact) return exact;

    const normalized = normalizePhone(phone);
    if (!normalized || normalized.length < 8) return null;
    const tail = normalized.slice(-8);

    const { data } = await supabase
        .from('leads')
        .select('*')
        .like('phone', `%${tail}`)
        .order('created_at', { ascending: false })
        .limit(2);

    if (!data || data.length !== 1) return null;
    return data[0];
}

export async function updateLead(id, updates) {
    const { data, error } = await supabase
        .from('leads')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
    if (error) throw error;
    return data;
}

export async function getLeads({ limit = 50, offset = 0, classification, origin, search } = {}) {
    let query = supabase
        .from('leads')
        .select('*, conversations(id, status, assigned_to, updated_at)')
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

    if (classification) query = query.eq('classification', classification);
    if (origin) query = query.eq('origin', origin);
    if (search) {
        const safe = sanitizeSearchTerm(search);
        query = query.or(`name.ilike.%${safe}%,company_name.ilike.%${safe}%,phone.ilike.%${safe}%`);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

export async function getLeadById(id) {
    const { data, error } = await supabase
        .from('leads')
        .select('*, conversations(id, status, assigned_to, channel, created_at, updated_at)')
        .eq('id', id)
        .single();
    if (error) throw error;
    return data;
}

// ─── CONVERSATIONS ────────────────────────────────────────────────────

export async function createConversation(data) {
    const { data: conv, error } = await supabase
        .from('conversations')
        .insert([{ ...data, updated_at: new Date().toISOString() }])
        .select()
        .single();
    if (error) throw error;
    return conv;
}

export async function getConversationById(id) {
    const { data, error } = await supabase
        .from('conversations')
        .select('*, leads(*)')
        .eq('id', id)
        .single();
    if (error) throw error;
    return data;
}

export async function findConversationByChat(whatsappChatId) {
    const { data } = await supabase
        .from('conversations')
        .select('*, leads(*)')
        .eq('whatsapp_chat_id', whatsappChatId)
        .single();
    return data || null;
}

// Grupo canônico: chaveado pelo JID @g.us (mesmo entre contas Branddi).
// Usar isto em vez de findConversationByChat pra grupos — evita criar row
// duplicada quando 2 contas Branddi são membros do mesmo grupo.
export async function findGroupByProviderId(providerId) {
    if (!providerId) return null;
    const { data } = await supabase
        .from('conversations')
        .select('*')
        .eq('is_group', true)
        .eq('group_provider_id', providerId)
        .maybeSingle();
    return data || null;
}

export async function updateConversation(id, updates) {
    const { data, error } = await supabase
        .from('conversations')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
    if (error) throw error;
    return data;
}

/**
 * getInbox — v2: busca apenas a última mensagem por conversa (fix N+1)
 * Usa subquery limitada em vez de trazer todas as mensagens.
 */
// Cache de metadata por account WhatsApp (60s).
// Estrutura: {
//   [unipile_account_id]: {
//     display_label: 'Ricardo' | null,         // sobrescreve nome real (SDR IA)
//     primary_owner_first_name: 'Harylanne' | null,  // do connected_by_user_id
//     permitted_users: [{ id, first_name }],   // users com o account em permissions
//     ignored: false,                          // conta de outro time — filtra fora
//   }
// }
let _accountOwnersCache = { data: null, ts: 0 };
async function getAccountOwnersMap() {
    const TTL = 60_000;
    if (_accountOwnersCache.data && (Date.now() - _accountOwnersCache.ts) < TTL) {
        return _accountOwnersCache.data;
    }
    try {
        const [accountsRes, usersRes] = await Promise.all([
            supabase
                .from('whatsapp_accounts')
                .select('unipile_account_id, display_label, connected_by_user_id, ignored, platform_users:connected_by_user_id(name)'),
            supabase
                .from('platform_users')
                .select('id, name, permissions')
                .eq('active', true),
        ]);
        const accounts = accountsRes.data || [];
        const users = usersRes.data || [];

        // Index reverso: account_id → users que têm permissão de operar
        const permittedByAccount = {};
        users.forEach(u => {
            const list = u.permissions?.whatsapp_accounts || [];
            list.forEach(accId => {
                permittedByAccount[accId] ||= [];
                permittedByAccount[accId].push({
                    id: u.id,
                    first_name: (u.name || '').split(/\s+/)[0] || u.name,
                });
            });
        });

        const map = {};
        accounts.forEach(a => {
            if (!a.unipile_account_id) return;
            const ownerName = a.platform_users?.name;
            map[a.unipile_account_id] = {
                display_label: a.display_label || null,
                primary_owner_first_name: ownerName ? ownerName.split(/\s+/)[0] : null,
                permitted_users: permittedByAccount[a.unipile_account_id] || [],
                ignored: !!a.ignored,
            };
        });
        _accountOwnersCache = { data: map, ts: Date.now() };
        return map;
    } catch {
        return _accountOwnersCache.data || {};
    }
}

// IDs de contas marcadas ignored=true (outras equipes). Reusa o cache de
// getAccountOwnersMap pra não martelar o DB. Usado em getInbox pra filtrar
// e em unipile.js pra pular no polling/webhook.
export async function getIgnoredAccountIds() {
    const map = await getAccountOwnersMap();
    return Object.entries(map)
        .filter(([, meta]) => meta?.ignored)
        .map(([id]) => id);
}

/**
 * Decide quais nomes mostrar como etiqueta numa conversa.
 * Cascata:
 *   1. display_label da conta (SDR IA com label fixo: "Ricardo", "Gio")
 *   2. primary_owner_first_name (connected_by_user_id setado: 1 dono real)
 *   3. Se múltiplos users têm permissão e há mensagens humanas outbound
 *      com sent_by_user_id, retorna os nomes desses (interação real)
 *   4. Se 1 user permitido, retorna só ele
 *   5. Vazio
 */
function resolveOwnerNames(conv, accountMeta) {
    if (!accountMeta) return [];
    if (accountMeta.display_label) return [accountMeta.display_label];
    if (accountMeta.primary_owner_first_name) return [accountMeta.primary_owner_first_name];

    const permitted = accountMeta.permitted_users || [];
    if (permitted.length === 0) return [];
    if (permitted.length === 1) return [permitted[0].first_name];

    // Múltiplos donos compartilhando o número → mostra quem realmente
    // interagiu com este deal/conversa, baseado nas mensagens outbound humanas.
    const interactedIds = new Set();
    (conv.messages || []).forEach(m => {
        if (m.direction === 'outbound' && m.sender_type === 'human' && m.sent_by_user_id) {
            interactedIds.add(m.sent_by_user_id);
        }
    });
    const filtered = permitted.filter(u => interactedIds.has(u.id));
    return filtered.length > 0 ? filtered.map(u => u.first_name) : [];
}

export async function getInbox({
    status, assigned_to, limit = 50,
    type, role, user_id, allowed_types,
    allowed_accounts, // números WhatsApp que o não-Admin pode ver (permissions.whatsapp_accounts)
    filter_user_id, // legado (1 user). Use filter_user_ids pra multi-select.
    filter_account_id, // legado (1 número). Use filter_account_ids pra multi-select.
    filter_user_ids, // array — Admin pode filtrar por N usuários
    filter_account_ids, // array — qualquer user pode filtrar por N números
    archived = false, // true = lista só arquivadas (Admin)
    is_group = false, // false = inbox principal (DMs); true = só grupos
} = {}) {
    // Normaliza singular → array (backwards compat)
    const userIds = Array.isArray(filter_user_ids) && filter_user_ids.length
        ? filter_user_ids
        : (filter_user_id ? [filter_user_id] : null);
    const accountIds = Array.isArray(filter_account_ids) && filter_account_ids.length
        ? filter_account_ids
        : (filter_account_id ? [filter_account_id] : null);
    let query = supabase
        .from('conversations')
        .select(`
            *,
            leads(id, name, phone, email, company_name, job_title, classification, origin, crm_deal_id, crm_person_id, crm_org_id),
            messages(id, content, direction, sender_type, sender_name, sent_by_name, created_at, read_at, delivered, seen)
        `)
        .neq('status', 'closed')
        .order('updated_at', { ascending: false })
        .order('created_at', { referencedTable: 'messages', ascending: false })
        .limit(limit);

    // Filtro de arquivadas (assume coluna archived_at; se não existir, Supabase ignora no select)
    if (archived) {
        query = query.not('archived_at', 'is', null);
    } else {
        query = query.is('archived_at', null);
    }

    // Filtro grupo vs DM. Inbox principal NÃO mostra grupos — eles ficam na
    // página dedicada (/grupos). Quando is_group=true, mostra só grupos.
    query = query.eq('is_group', !!is_group);

    if (status) query = query.eq('status', status);

    // Filtro por tipo de conversa
    if (type) {
        query = query.eq('type', type);
    } else if (allowed_types && allowed_types.length > 0) {
        query = query.in('type', allowed_types);
    }

    // Filtro por usuário: Admin vê tudo (com filtro opcional). Não-Admin vê só
    // conversas dos números WhatsApp atribuídos a ele em permissions.whatsapp_accounts.
    //
    // Grupos pós-014 usam whatsapp_account_ids[] (array) em vez do scalar
    // whatsapp_account_id — porque o mesmo grupo pode ter N contas Branddi
    // como membros (canonical row única). Usamos `overlaps` em vez de `in`
    // pra checar interseção entre o array de permission e o array da conv.
    const accountCol = is_group ? 'whatsapp_account_ids' : 'whatsapp_account_id';
    const matchAccounts = (q, ids) => is_group
        ? q.overlaps(accountCol, ids)
        : q.in(accountCol, ids);

    if (role === 'Admin') {
        if (userIds && userIds.length > 0) {
            const { data: targetUsers } = await supabase
                .from('platform_users')
                .select('permissions')
                .in('id', userIds);
            const targetAccounts = Array.from(new Set(
                (targetUsers || []).flatMap(u => u.permissions?.whatsapp_accounts || [])
            ));
            if (targetAccounts.length === 0) {
                return []; // nenhum dos selecionados tem número
            }
            query = matchAccounts(query, targetAccounts);
        }
        // Sem userIds, Admin vê tudo
    } else {
        const accounts = Array.isArray(allowed_accounts) ? allowed_accounts : [];
        if (accounts.length === 0) {
            // Sem números atribuídos = inbox vazio (regra de negócio explícita)
            return [];
        }
        // Se pediu filtro por números específicos, intersecta com os permitidos
        // (segurança: não-admin não pode ver fora do que tem permission)
        const intersect = accountIds && accountIds.length > 0
            ? accountIds.filter(id => accounts.includes(id))
            : accounts;
        if (intersect.length === 0) {
            return []; // selecionou só números fora dos permitidos
        }
        query = matchAccounts(query, intersect);
    }

    // Admin filtrando por números (independente dos usuários)
    if (role === 'Admin' && accountIds && accountIds.length > 0) {
        query = matchAccounts(query, accountIds);
    }

    if (assigned_to) {
        query = query.eq('assigned_to', assigned_to);
    }

    // Filtra contas ignored=true (outros times). Em DMs, exclui via NOT IN
    // no scalar. Em grupos, filtragem é client-side abaixo (excluir do array
    // e dropar conv se array ficar vazio) — overlaps com `not` no Postgrest
    // tem semântica esquisita.
    const accountOwnersForFilter = await getAccountOwnersMap();
    const ignoredIds = Object.entries(accountOwnersForFilter)
        .filter(([, meta]) => meta?.ignored)
        .map(([id]) => id);
    if (!is_group && ignoredIds.length > 0) {
        query = query.not('whatsapp_account_id', 'in', `(${ignoredIds.join(',')})`);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Reusa o map já buscado acima pra hidratar owners.
    const accountOwners = accountOwnersForFilter;

    // Em grupos, dropa convs cujo único membro Branddi era ignored (array
    // ficou vazio após remoção). DMs já foram filtradas via NOT IN na query.
    const filteredData = is_group && ignoredIds.length > 0
        ? (data || []).filter(conv => {
            const remaining = Array.isArray(conv.whatsapp_account_ids)
                ? conv.whatsapp_account_ids.filter(id => !ignoredIds.includes(id))
                : [];
            // Mantém se ainda há outra Branddi membro OU se canonical scalar
            // não está em ignored (compat com grupos legacy sem array)
            if (remaining.length > 0) return true;
            if (conv.whatsapp_account_id && !ignoredIds.includes(conv.whatsapp_account_id)) return true;
            return false;
        })
        : (data || []);

    return filteredData.map(conv => {
        const msgs = conv.messages || [];

        // Em grupos, remove accounts ignored do array antes de hidratar labels
        // — assim grupos visíveis via outra Branddi continuam aparecendo,
        // mas a conta ignored some das tags.
        if (is_group && ignoredIds.length > 0 && Array.isArray(conv.whatsapp_account_ids)) {
            conv.whatsapp_account_ids = conv.whatsapp_account_ids.filter(
                id => !ignoredIds.includes(id)
            );
        }

        // Em grupos canonicalizados (whatsapp_account_ids[] populado), resolve
        // labels de TODAS as contas Branddi membros — usado pelo front pra
        // mostrar "📱 Caroline, Ricardo" no card e identificar quem envia.
        let accountLabels = [];
        if (is_group && Array.isArray(conv.whatsapp_account_ids) && conv.whatsapp_account_ids.length > 0) {
            accountLabels = conv.whatsapp_account_ids
                .map(accId => {
                    const meta = accountOwners[accId];
                    if (!meta) return null;
                    return meta.display_label || meta.primary_owner_first_name || null;
                })
                .filter(Boolean);
        }

        // Owner names: pra DMs e grupos legados, cascata via whatsapp_account_id.
        // Pra grupos canônicos, usa os labels do array (mais informativo).
        const accountMeta = accountOwners[conv.whatsapp_account_id] || null;
        const ownerNames = accountLabels.length > 0
            ? accountLabels
            : resolveOwnerNames(conv, accountMeta);

        return {
            ...conv,
            account_owner_name: ownerNames[0] || null,        // compat com versão anterior
            account_owner_names: ownerNames,                  // novo: 1+ tags
            account_display_labels: accountLabels,            // pra grupos: labels de todas as contas Branddi
            last_message: msgs[0] || null,
            unread_count: msgs.filter(m =>
                m.direction === 'inbound' && !m.read_at
            ).length || 0,
            messages: undefined,
        };
    });
}

// ─── MESSAGES ─────────────────────────────────────────────────────────

/**
 * saveMessage — v2: retorna null se duplicata (em vez de throw)
 * Permite ao caller saber que a mensagem já existe e pular processamento.
 */
export async function saveMessage(data) {
    // IMPORTANTE: maybeSingle() (não single()) — com ignoreDuplicates=true,
    // duplicatas devolvem 0 linhas. single() lançaria PGRST116 ("no rows"),
    // que NÃO bate em error.code='23505' nem error.message.includes('duplicate'),
    // e o throw quebrava o loop do polling perdendo todas as msgs seguintes.
    // Com maybeSingle(), 0 linhas → msg=null, sem erro → retornamos null
    // (sinalização correta de "duplicata, já estava no DB").
    const { data: msg, error } = await supabase
        .from('messages')
        .upsert([data], { onConflict: 'unipile_message_id', ignoreDuplicates: true })
        .select()
        .maybeSingle();
    if (error) {
        if (error.message?.includes('duplicate') || error.code === '23505') {
            return null;
        }
        // Se a coluna não existe, tenta novamente sem os campos opcionais
        if (error.code === '42703' || error.message?.includes('does not exist')) {
            const { sent_by_user_id, sent_by_name, ...safeData } = data;
            const retry = await supabase
                .from('messages')
                .upsert([safeData], { onConflict: 'unipile_message_id', ignoreDuplicates: true })
                .select()
                .maybeSingle();
            if (retry.error) {
                if (retry.error.message?.includes('duplicate') || retry.error.code === '23505') return null;
                throw retry.error;
            }
            return retry.data; // pode ser null em caso de duplicata — esperado
        }
        throw error;
    }
    return msg; // null = duplicata silenciosa, objeto = msg recém-inserida
}

export async function getMessages(conversationId, { limit = 50, before } = {}) {
    // DESC + LIMIT pega as N msgs mais recentes (ASC pegaria as N mais antigas, escondendo
    // o que foi enviado/recebido em conversas com mais de N mensagens). Revertemos no fim
    // para devolver em ordem cronológica, que é o que o front espera.
    let query = supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (before) query = query.lt('created_at', before);

    const { data, error } = await query;
    if (error) throw error;
    return (data || []).reverse();
}

export async function markMessagesRead(conversationId) {
    await supabase
        .from('messages')
        .update({ read_at: new Date().toISOString() })
        .eq('conversation_id', conversationId)
        .eq('direction', 'inbound')
        .is('read_at', null);
}

// ─── ROUTING EVENTS ───────────────────────────────────────────────────

export async function createRoutingEvent(data) {
    const { error } = await supabase
        .from('routing_events')
        .insert([data]);
    if (error) throw error;
}

// ─── CRM SYNC LOG ─────────────────────────────────────────────────────

export async function logCrmSync(data) {
    const { data: log, error } = await supabase
        .from('crm_sync_log')
        .insert([data])
        .select()
        .single();
    if (error) throw error;
    return log;
}

/**
 * getPendingSyncs — v2: também busca entries com retry pendente
 */
export async function getPendingSyncs(limit = 20) {
    const now = new Date().toISOString();
    const { data, error } = await supabase
        .from('crm_sync_log')
        .select('*')
        .or(`sync_status.eq.pending,and(sync_status.eq.error,retry_count.lt.3,next_retry_at.lte.${now})`)
        .order('synced_at', { ascending: true })
        .limit(limit);
    if (error) throw error;
    return data || [];
}

export async function updateSyncLog(id, updates) {
    await supabase
        .from('crm_sync_log')
        .update({ ...updates, synced_at: new Date().toISOString() })
        .eq('id', id);
}

// ─── SCRIPTS ──────────────────────────────────────────────────────────

export async function getScripts({ category, active = true } = {}) {
    let query = supabase
        .from('scripts')
        .select('*')
        .order('sort_order', { ascending: true });

    if (active) query = query.eq('is_active', true);
    if (category) query = query.eq('category', category);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

export async function upsertScript(data) {
    const { data: script, error } = await supabase
        .from('scripts')
        .upsert([{ ...data, updated_at: new Date().toISOString() }])
        .select()
        .single();
    if (error) throw error;
    return script;
}

// ─── COMMERCIAL EVENTS (dashboard analytics) ─────────────────────────

/**
 * Loga um evento comercial pro dashboard analítico.
 * event_type: 'wa_activity_bb' | 'wa_activity_fr' | 'wa_activity_vm'
 *           | 'transcript_sent' | 'apollo_enrich_triggered' | 'apollo_enrich_matched'
 *           | 'outbound_started' | etc.
 * Non-blocking — falhas são silenciadas (não quebra o fluxo principal).
 */
export async function logCommercialEvent(event_type, ctx = {}) {
    try {
        await supabase.from('commercial_events').insert({
            event_type,
            user_id: ctx.user_id || null,
            conversation_id: ctx.conversation_id || null,
            lead_id: ctx.lead_id || null,
            whatsapp_account_id: ctx.whatsapp_account_id || null,
            metadata: ctx.metadata || null,
        });
    } catch { /* silently drop */ }
}

// ─── PROSPECTING DASHBOARD ───────────────────────────────────────────

const PROSPECTING_GRANULARITY_DAYS = { daily: 1, weekly: 7, monthly: 30 };
const PROSPECTING_COLD_THRESHOLD_DAYS = 3;
const PROSPECTING_FIRST_RESPONSE_CAP_MS = 7 * 86_400_000; // ignora outliers > 7d

/**
 * Dashboard de prospecção. Atribuição via dono original do número WA
 * (whatsapp_accounts.connected_by_user_id) — não usa messages.sent_by_user_id
 * porque o campo é incompleto historicamente e a regra do projeto é "1 número
 * = 1 dono".
 *
 * Granularidades: 'daily' (1d), 'weekly' (7d), 'monthly' (30d).
 * Role-aware: Admin vê tudo + filtra; SDR vê só os números que possui.
 */
export async function getProspectingDashboard({
    granularity = 'monthly',
    user_id = null,
    account_id = null,
    team = null,           // 'prospecting' | 'sales' | null = todos
    role = 'Usuario',
    requester_id = null,
} = {}) {
    const days = PROSPECTING_GRANULARITY_DAYS[granularity] || 30;
    const now = new Date();
    const sinceIso = new Date(now.getTime() - days * 86_400_000).toISOString();
    const effectiveUserId = role === 'Admin' ? user_id : requester_id;

    // 1a. Se filtrado por team, resolve quais user_ids pertencem ao time.
    //     Aplica restrição no accountQ via .in('connected_by_user_id', ids).
    let teamUserIds = null;
    if (team === 'prospecting' || team === 'sales') {
        const teamRes = await supabase
            .from('platform_users')
            .select('id')
            .eq('team', team);
        teamUserIds = (teamRes.data || []).map(u => u.id);
        if (teamUserIds.length === 0) return emptyProspecting(granularity, sinceIso);
    }

    // 1b. Universo de accounts elegíveis (não excluídos, com owner).
    let accountQ = supabase
        .from('whatsapp_accounts')
        .select('unipile_account_id, phone_number, connected_by_user_id')
        .eq('excluded_from_metrics', false)
        .not('connected_by_user_id', 'is', null);
    if (account_id) accountQ = accountQ.eq('unipile_account_id', account_id);
    if (effectiveUserId) accountQ = accountQ.eq('connected_by_user_id', effectiveUserId);
    if (teamUserIds) accountQ = accountQ.in('connected_by_user_id', teamUserIds);
    const accountsRes = await accountQ;
    const accounts = accountsRes.data || [];
    if (accounts.length === 0) return emptyProspecting(granularity, sinceIso);

    const accountIds = accounts.map(a => a.unipile_account_id);
    const ownerByAccount = Object.fromEntries(
        accounts.map(a => [a.unipile_account_id, a.connected_by_user_id])
    );

    // 2. Hidrata users (donos) com nome
    const ownerIds = [...new Set(accounts.map(a => a.connected_by_user_id))];
    const usersRes = await supabase
        .from('platform_users')
        .select('id, name')
        .in('id', ownerIds);
    const users = usersRes.data || [];
    const userById = Object.fromEntries(users.map(u => [u.id, u]));

    // 3. Conversas do scope. Carrega TODAS as do scope (pra cold_leads conseguir
    //    enxergar conversas antigas) + um set separado das que tiveram atividade
    //    no período (last_message_at >= since), usado pra limitar a query de
    //    mensagens — PostgREST `.in()` com 700+ UUIDs estoura o limite de URL.
    const convsRes = await supabase
        .from('conversations')
        .select('id, whatsapp_account_id, lead_id, crm_deal_id, last_message_at, status')
        .in('whatsapp_account_id', accountIds)
        .limit(20000);
    const convs = convsRes.data || [];
    if (convs.length === 0) return emptyProspecting(granularity, sinceIso);
    const convById = Object.fromEntries(convs.map(c => [c.id, c]));
    const convsInPeriod = convs.filter(c => c.last_message_at && c.last_message_at >= sinceIso);
    const convIdsInPeriod = convsInPeriod.map(c => c.id);

    // 4. Mensagens no período. Chunks de 200 IDs pra .in() não estourar URL.
    //    Cada chunk pode retornar >1000 msgs (Supabase default max-rows trunca
    //    silenciosamente). Pra pegar tudo, paginamos dentro do chunk via .range().
    const msgs = [];
    const PAGE_SIZE = 1000;
    if (convIdsInPeriod.length > 0) {
        for (let i = 0; i < convIdsInPeriod.length; i += 200) {
            const chunk = convIdsInPeriod.slice(i, i + 200);
            let from = 0;
            while (true) {
                const r = await supabase
                    .from('messages')
                    .select('conversation_id, direction, created_at')
                    .gte('created_at', sinceIso)
                    .in('conversation_id', chunk)
                    .range(from, from + PAGE_SIZE - 1);
                if (r.error || !r.data || r.data.length === 0) break;
                msgs.push(...r.data);
                if (r.data.length < PAGE_SIZE) break; // última página
                from += PAGE_SIZE;
            }
        }
    }

    // 5. Agrega por conversa: 1º outbound, 1º inbound, totais sent/recv
    const perConv = new Map();
    for (const m of msgs) {
        const c = convById[m.conversation_id];
        if (!c) continue;
        let s = perConv.get(m.conversation_id);
        if (!s) {
            s = {
                firstOut: null, firstIn: null, sent: 0, recv: 0,
                leadId: c.lead_id,
                ownerId: ownerByAccount[c.whatsapp_account_id] || null,
                accountId: c.whatsapp_account_id,
                hasDeal: !!c.crm_deal_id,
            };
            perConv.set(m.conversation_id, s);
        }
        if (m.direction === 'outbound') {
            s.sent++;
            if (!s.firstOut || m.created_at < s.firstOut) s.firstOut = m.created_at;
        } else if (m.direction === 'inbound') {
            s.recv++;
            if (!s.firstIn || m.created_at < s.firstIn) s.firstIn = m.created_at;
        }
    }
    const activeConvs = [...perConv.values()].filter(s => s.sent > 0);

    // KPIs globais
    const uniqueContactLeads = new Set();
    const respondedLeads = new Set();
    const dealsLeads = new Set();
    let messagesSent = 0, messagesReceived = 0;
    const firstResponseDeltas = [];

    // Agregação por owner
    const byUserAgg = new Map();
    const aggForUser = (uid) => {
        let a = byUserAgg.get(uid);
        if (!a) {
            a = { unique: new Set(), responded: new Set(), deals: new Set(), sent: 0, recv: 0, deltas: [] };
            byUserAgg.set(uid, a);
        }
        return a;
    };

    for (const s of activeConvs) {
        const lid = s.leadId;
        if (lid) uniqueContactLeads.add(lid);
        if (s.hasDeal && lid) dealsLeads.add(lid);
        messagesSent += s.sent;
        messagesReceived += s.recv;

        const respondedConv = !!(s.firstIn && s.firstOut && s.firstIn > s.firstOut);
        if (respondedConv && lid) respondedLeads.add(lid);
        let delta = null;
        if (respondedConv) {
            delta = new Date(s.firstIn) - new Date(s.firstOut);
            if (delta > 0 && delta < PROSPECTING_FIRST_RESPONSE_CAP_MS) {
                firstResponseDeltas.push(delta);
            } else {
                delta = null;
            }
        }

        if (s.ownerId) {
            const a = aggForUser(s.ownerId);
            if (lid) a.unique.add(lid);
            if (respondedConv && lid) a.responded.add(lid);
            if (s.hasDeal && lid) a.deals.add(lid);
            a.sent += s.sent;
            a.recv += s.recv;
            if (delta) a.deltas.push(delta);
        }
    }

    const phonesByOwner = {};
    for (const a of accounts) {
        (phonesByOwner[a.connected_by_user_id] ||= []).push(a.phone_number);
    }

    const byUser = [...byUserAgg.entries()].map(([uid, a]) => ({
        user_id: uid,
        name: userById[uid]?.name || '—',
        phone_numbers: [...new Set(phonesByOwner[uid] || [])],
        unique_contacts: a.unique.size,
        responded: a.responded.size,
        reply_rate: a.unique.size ? a.responded.size / a.unique.size : null,
        median_first_response_ms: median(a.deltas),
        deals: a.deals.size,
        messages_sent: a.sent,
        messages_received: a.recv,
    })).sort((x, y) => y.unique_contacts - x.unique_contacts);

    // Timeline buckets: daily → hora; weekly/monthly → dia
    const bucketKey = (iso) => granularity === 'daily' ? iso.slice(0, 13) : iso.slice(0, 10);
    const timelineMap = new Map();
    for (const s of activeConvs) {
        if (!s.firstOut) continue;
        const k = bucketKey(s.firstOut);
        let b = timelineMap.get(k);
        if (!b) { b = { bucket: k, contacts_new: 0, responded: 0 }; timelineMap.set(k, b); }
        b.contacts_new++;
        if (s.firstIn && s.firstIn > s.firstOut) b.responded++;
    }
    const timeline = [...timelineMap.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));

    // Heatmap dia-da-semana × hora (horário local do servidor)
    const heatmapMap = new Map();
    for (const m of msgs) {
        const d = new Date(m.created_at);
        const dow = d.getDay();
        const hour = d.getHours();
        const key = `${dow}-${hour}`;
        let h = heatmapMap.get(key);
        if (!h) { h = { dow, hour, sent: 0, received: 0 }; heatmapMap.set(key, h); }
        if (m.direction === 'outbound') h.sent++;
        else if (m.direction === 'inbound') h.received++;
    }
    // Cap em 1.0 — múltiplas mensagens do mesmo lead podem fazer received > sent;
    // pro heatmap importa "houve engajamento", não razão bruta.
    const heatmap = [...heatmapMap.values()].map(h => ({
        ...h,
        reply_rate: h.sent ? Math.min(h.received / h.sent, 1) : null,
    }));

    // Cold leads: top 10 conversas no scope com última msg há > N dias
    const coldCutoff = new Date(now.getTime() - PROSPECTING_COLD_THRESHOLD_DAYS * 86_400_000).toISOString();
    const coldCandidates = convs
        .filter(c => c.lead_id && c.last_message_at && c.last_message_at < coldCutoff)
        .sort((a, b) => a.last_message_at.localeCompare(b.last_message_at))
        .slice(0, 10);
    let coldLeadInfo = [];
    if (coldCandidates.length > 0) {
        const leadsRes = await supabase
            .from('leads')
            .select('id, name, phone')
            .in('id', coldCandidates.map(c => c.lead_id));
        coldLeadInfo = leadsRes.data || [];
    }
    const leadById = Object.fromEntries(coldLeadInfo.map(l => [l.id, l]));
    const cold_leads = coldCandidates.map(c => {
        const ownerId = ownerByAccount[c.whatsapp_account_id];
        return {
            lead_id: c.lead_id,
            lead_name: leadById[c.lead_id]?.name || '—',
            phone: leadById[c.lead_id]?.phone || '—',
            owner_name: userById[ownerId]?.name || '—',
            last_message_at: c.last_message_at,
            days_cold: Math.floor((now - new Date(c.last_message_at)) / 86_400_000),
        };
    });

    // Apollo health no período
    let apolloQ = supabase
        .from('apollo_enrichments')
        .select('status, has_whatsapp, user_id')
        .gte('created_at', sinceIso);
    if (effectiveUserId) apolloQ = apolloQ.eq('user_id', effectiveUserId);
    const apolloRes = await apolloQ;
    const apolloRows = apolloRes.data || [];
    const apollo = {
        triggered: apolloRows.length,
        completed: apolloRows.filter(r => r.status === 'completed').length,
        has_whatsapp: apolloRows.filter(r => r.has_whatsapp === true).length,
    };

    return {
        period: { granularity, days, since: sinceIso, until: now.toISOString() },
        scope: { role, user_id: effectiveUserId, account_id },
        kpis: {
            unique_contacts: uniqueContactLeads.size,
            responded: respondedLeads.size,
            reply_rate: uniqueContactLeads.size ? respondedLeads.size / uniqueContactLeads.size : null,
            median_first_response_ms: median(firstResponseDeltas),
            deals: dealsLeads.size,
            messages_sent: messagesSent,
            messages_received: messagesReceived,
        },
        byUser: role === 'Admin' ? byUser : byUser.filter(u => u.user_id === effectiveUserId),
        timeline,
        heatmap,
        funnel: {
            contacted: uniqueContactLeads.size,
            responded: respondedLeads.size,
            deals: dealsLeads.size,
        },
        cold_leads,
        apollo,
    };
}

function median(arr) {
    if (!arr || arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const m = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[m] : Math.round((sorted[m - 1] + sorted[m]) / 2);
}

function emptyProspecting(granularity, since) {
    return {
        period: { granularity, days: PROSPECTING_GRANULARITY_DAYS[granularity] || 30, since, until: new Date().toISOString() },
        scope: { role: 'Usuario', user_id: null, account_id: null },
        kpis: {
            unique_contacts: 0, responded: 0, reply_rate: null,
            median_first_response_ms: null, deals: 0,
            messages_sent: 0, messages_received: 0,
        },
        byUser: [],
        timeline: [],
        heatmap: [],
        funnel: { contacted: 0, responded: 0, deals: 0 },
        cold_leads: [],
        apollo: { triggered: 0, completed: 0, has_whatsapp: 0 },
    };
}

// ─── SETTINGS (via platform_settings table) ──────────────────────────

export async function getSettingValue(key, defaultValue = null) {
    const { data } = await supabase
        .from('platform_settings')
        .select('value')
        .eq('setting_key', key)
        .single();
    return data?.value ?? defaultValue;
}

export async function saveSetting(key, value) {
    const { data, error } = await supabase
        .from('platform_settings')
        .upsert(
            { setting_key: key, value, updated_at: new Date().toISOString() },
            { onConflict: 'setting_key' }
        )
        .select()
        .single();
    if (error) throw error;
    return data;
}

export async function getAllSettings() {
    const { data } = await supabase
        .from('platform_settings')
        .select('*');
    return (data || []).map(s => ({ ...s, key: s.setting_key }));
}

/** Retorna settings como objeto key→value (usado por routes/settings.js) */
export async function getSettings() {
    const rows = await getAllSettings();
    const obj = {};
    for (const row of rows) {
        obj[row.key] = row.value;
    }
    return obj;
}

// ─── UTILS ────────────────────────────────────────────────────────────

export function normalizePhone(phone) {
    if (!phone) return '';
    let digits = String(phone).replace(/\D/g, '');

    // Remove country code 55
    if (digits.startsWith('55') && digits.length >= 12) digits = digits.slice(2);

    // Celular BR sem 9° dígito: DDD(2) + 8 dígitos = 10 → insere 9
    if (digits.length === 10) {
        const ddd = digits.slice(0, 2);
        const num = digits.slice(2);
        digits = `${ddd}9${num}`;
    }

    return digits;
}

// ─── BOT 24H — Conversas sem resposta humana ──────────────────────────

export async function getConversationsWaitingForHuman(cutoffIso) {
    const { data, error } = await supabase
        .from('conversations')
        .select('id, whatsapp_chat_id, chatbot_stage, bot_away_sent, updated_at, leads!inner(name, origin)')
        .in('status', ['waiting', 'in_progress'])
        .eq('chatbot_stage', 'human')
        .neq('leads.origin', 'pipedrive_outbound')
        .or('bot_away_sent.is.null,bot_away_sent.eq.false')
        .lt('updated_at', cutoffIso)
        .limit(20);

    if (error) {
        logger.warn('getConversationsWaitingForHuman error', { error: error.message });
        return [];
    }
    return data || [];
}

// ─── HISTÓRICO DE CONVERSAS ───────────────────────────────────────────

export async function getConversationHistory({
    limit = 50, offset = 0, status, classification, origin, search, days
} = {}) {
    let query = supabase
        .from('conversations')
        .select(`
            id, status, assigned_to, channel, chatbot_stage, created_at, updated_at,
            leads(id, name, phone, company_name, classification, origin, crm_deal_id)
        `)
        .order('updated_at', { ascending: false })
        .range(offset, offset + limit - 1);

    if (status) query = query.eq('status', status);
    if (days) {
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        query = query.gte('created_at', since);
    }
    if (classification) query = query.eq('leads.classification', classification);
    if (origin) query = query.eq('channel', origin);
    if (search) {
        const safe = sanitizeSearchTerm(search);
        query = query.or(`leads.name.ilike.%${safe}%,leads.company_name.ilike.%${safe}%`);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}
