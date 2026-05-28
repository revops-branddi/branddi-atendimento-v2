/**
 * One-shot backfill pra puxar conversa(s) recentes da conta SITE do
 * Unipile pra dentro do schema do app.
 *
 * Por que existe: `src/site/services/ingest.js` tem um guard
 * NEW_CONV_HISTORY_WINDOW_MS=5min que IGNORA conv com inbound mais antigo
 * que 5 min se não houver row local. Salvaguarda contra ghost-convs, mas
 * suprime conversa legítima de ontem quando a conta ainda não tinha
 * estado funcional (caso do SITE depois que o /api/site/* destravou).
 *
 * Uso:
 *   node scripts/backfill-site-chat.js                # default 48h
 *   node scripts/backfill-site-chat.js 72             # últimas 72h
 *
 * Idempotente: messages têm UNIQUE em unipile_message_id (23505 ignorado),
 * conv é dedupada via whatsapp_chat_id + status ativo. Re-rodar não
 * duplica nada.
 *
 * Não dispara bot — convs criadas aqui entram direto em 'waiting_human'.
 * Backfilled chats não devem disparar welcome com base em msg antiga.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const UNIPILE_API_KEY = process.env.UNIPILE_API_KEY;
const UNIPILE_DSN = process.env.UNIPILE_DSN;

if (!SUPABASE_URL || !SUPABASE_KEY || !UNIPILE_API_KEY || !UNIPILE_DSN) {
    console.error('Faltam env vars: SUPABASE_URL, SUPABASE_KEY, UNIPILE_API_KEY, UNIPILE_DSN');
    process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const UNIPILE_BASE = `https://${UNIPILE_DSN}/api/v1`;
const UNIPILE_HEADERS = { 'X-API-KEY': UNIPILE_API_KEY, Accept: 'application/json' };

const SITE_ACCOUNT_ID = 'jo-4j82MTAyUGxMVA1aB_w'; // SITE — hardcoded
const LOOKBACK_HOURS = parseInt(process.argv[2] || '48', 10);
const cutoff = Date.now() - LOOKBACK_HOURS * 3600_000;

async function unipileGet(path) {
    const res = await fetch(`${UNIPILE_BASE}${path}`, { headers: UNIPILE_HEADERS });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Unipile ${path} ${res.status}: ${err}`);
    }
    return res.json();
}

function isGroupChat(chat) {
    return chat?.type === 1 || String(chat?.provider_id || '').endsWith('@g.us');
}

function extractPhone(providerId) {
    // provider_id pode ser "<digits>@s.whatsapp.net" ou "<digits>@c.us"
    const match = String(providerId || '').match(/^(\d+)@/);
    return match ? match[1] : null;
}

async function backfillChat(chat) {
    console.log(`\n--- chat ${chat.id} (${chat.name || '(no name)'})`);

    // Pula grupo
    if (isGroupChat(chat)) {
        console.log('  skip: group chat');
        return;
    }

    // Pega mensagens
    const msgsRes = await unipileGet(`/chats/${chat.id}/messages?limit=50`);
    const items = msgsRes.items || [];
    const fresh = items.filter(m => new Date(m.timestamp).getTime() > cutoff);
    if (fresh.length === 0) {
        console.log(`  skip: 0 msgs nas últimas ${LOOKBACK_HOURS}h (de ${items.length} total)`);
        return;
    }
    const hasInbound = fresh.some(m => !m.is_sender);
    if (!hasInbound) {
        console.log(`  skip: ${fresh.length} msgs recentes mas nenhuma inbound`);
        return;
    }

    // Pega contato (lead)
    const attRes = await unipileGet(`/chats/${chat.id}/attendees`);
    const attendees = attRes.items || [];
    const contact = attendees.find(a => !a.is_self);
    if (!contact) {
        console.log('  skip: nenhum attendee (lead) encontrado');
        return;
    }
    const phone = extractPhone(contact.provider_id);
    const leadName = contact.name || phone || 'Desconhecido';

    // Find or create lead
    let lead = null;
    if (phone) {
        const { data } = await sb.from('v_site_leads').select('*').eq('phone', phone).maybeSingle();
        if (data) lead = data;
    }
    if (!lead) {
        const { data, error } = await sb.from('v_site_leads').insert({
            name: leadName,
            phone,
            origin: 'whatsapp_inbound',
            origin_metadata: { attendee_id: contact.provider_id, backfilled_at: new Date().toISOString() },
        }).select().single();
        if (error) { console.error('  ✗ lead insert error', error); return; }
        lead = data;
        console.log(`  ✓ lead criado: ${lead.id} (${leadName} / ${phone || '?'})`);
    } else {
        console.log(`  ↳ lead existente: ${lead.id} (${lead.name})`);
    }

    // Conv: já existe ativa?
    const { data: existingConv } = await sb.from('v_site_conversations')
        .select('id')
        .eq('whatsapp_chat_id', chat.id)
        .in('status', ['bot', 'waiting_human', 'in_progress'])
        .maybeSingle();

    let conv;
    if (existingConv) {
        conv = existingConv;
        console.log(`  ↳ conv existente: ${conv.id} — importando só msgs`);
    } else {
        // Última msg pra setar last_message_at corretamente
        const lastTs = fresh
            .map(m => new Date(m.timestamp).getTime())
            .reduce((a, b) => Math.max(a, b), 0);

        const { data, error } = await sb.from('v_site_conversations').insert({
            lead_id:             lead.id,
            whatsapp_chat_id:    chat.id,
            whatsapp_account_id: SITE_ACCOUNT_ID,
            status:              'waiting_human', // backfilled — NÃO entra no bot
            last_message_at:     new Date(lastTs).toISOString(),
        }).select().single();
        if (error) { console.error('  ✗ conv insert error', error); return; }
        conv = data;
        console.log(`  ✓ conv criada: ${conv.id} (status=waiting_human)`);
    }

    // Insere messages — dedupa por unipile_message_id (23505 = silently skip)
    let inserted = 0, dedup = 0, failed = 0;
    // Reorder cronologicamente
    fresh.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    for (const raw of fresh) {
        const payload = {
            conversation_id:    conv.id,
            direction:          raw.is_sender ? 'outbound' : 'inbound',
            text:               raw.text || '',
            attachments:        raw.attachments || [],
            unipile_message_id: raw.id,
            delivered:          !!raw.delivered,
            seen:               !!raw.seen,
            sender_type:        raw.is_sender ? 'human' : 'lead',
            sender_name:        raw.is_sender ? null : leadName,
            created_at:         raw.timestamp,
        };
        const { error } = await sb.from('v_site_messages').insert(payload);
        if (!error) inserted++;
        else if (error.code === '23505') dedup++;
        else { failed++; console.error('  ✗ msg error', error.message); }
    }
    console.log(`  → msgs: ${inserted} novas, ${dedup} já existiam, ${failed} falharam`);
}

async function main() {
    console.log(`Backfill SITE account ${SITE_ACCOUNT_ID} — lookback ${LOOKBACK_HOURS}h\n`);
    const chatsRes = await unipileGet(`/chats?account_id=${SITE_ACCOUNT_ID}&limit=50`);
    const chats = chatsRes.items || [];
    console.log(`${chats.length} chats encontrados no Unipile`);

    for (const chat of chats) {
        try { await backfillChat(chat); }
        catch (err) { console.error(`Erro processando chat ${chat.id}:`, err.message); }
    }
    console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
