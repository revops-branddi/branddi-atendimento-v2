/**
 * One-shot: detecta conversas que são GRUPOS WhatsApp e marca is_group=true,
 * popula group_subject e group_participants. Antes do fix do PR
 * feat/whatsapp-groups, grupos eram criados como DM normal com lead-fantasma
 * (primeiro attendee).
 *
 * Uso:
 *   node scripts/backfill-group-detection.js [--dry-run] [--limit=N]
 *
 * Opções:
 *   --dry-run         não modifica nada — só lista o que faria
 *   --limit=N         processa no máx N conversas (default: tudo)
 *   --concurrency=N   conversas paralelas (default: 5)
 *
 * Idempotente: rodar de novo não duplica nada.
 */
import 'dotenv/config';
import supabase from '../src/services/supabase.js';

const API_KEY = process.env.UNIPILE_API_KEY;
const DSN = process.env.UNIPILE_DSN;
const BASE = DSN ? `https://${DSN}/api/v1` : null;

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { dryRun: false, limit: null, concurrency: 5 };
    for (const a of args) {
        if (a === '--dry-run') opts.dryRun = true;
        else if (a.startsWith('--limit=')) opts.limit = parseInt(a.slice(8), 10);
        else if (a.startsWith('--concurrency=')) opts.concurrency = parseInt(a.slice(14), 10);
    }
    return opts;
}

async function unipileGet(endpoint) {
    const res = await fetch(`${BASE}${endpoint}`, {
        headers: { 'X-API-KEY': API_KEY, 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`Unipile ${res.status}: ${endpoint}`);
    return res.json();
}

async function pmap(items, fn, concurrency) {
    const results = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (true) {
            const idx = i++;
            if (idx >= items.length) return;
            try { results[idx] = await fn(items[idx]); }
            catch (err) { results[idx] = { error: err.message }; }
        }
    });
    await Promise.all(workers);
    return results;
}

function isGroup(chat) {
    return chat?.type === 1 || String(chat?.provider_id || '').endsWith('@g.us');
}

function normalizeParticipants(attendees) {
    return (attendees || []).map(a => ({
        provider_id: a.provider_id || a.id || null,
        name: a.name || null,
        phone: a.specifics?.phone_number || a.phone_number || null,
        is_self: !!a.is_self,
    }));
}

async function main() {
    if (!API_KEY || !DSN) {
        console.error('Unipile não configurado (UNIPILE_API_KEY/DSN ausentes).');
        process.exit(1);
    }

    const opts = parseArgs();
    console.log('Backfill group detection — opções:', opts);

    // Pega conversas com whatsapp_chat_id que ainda não foram marcadas como grupo
    let q = supabase
        .from('conversations')
        .select('id, whatsapp_chat_id, lead_id, leads(name)')
        .not('whatsapp_chat_id', 'is', null)
        .eq('is_group', false);
    if (opts.limit) q = q.limit(opts.limit);
    const { data: convs, error } = await q;
    if (error) { console.error('Erro lendo conversations:', error.message); process.exit(1); }

    console.log(`Encontradas ${convs.length} conversa(s) sem flag is_group`);
    if (convs.length === 0) return;

    let detected = 0;
    let updated = 0;
    let errored = 0;
    let processed = 0;

    await pmap(convs, async (c) => {
        try {
            const chat = await unipileGet(`/chats/${c.whatsapp_chat_id}`);
            processed++;
            if (!isGroup(chat)) return;

            detected++;
            console.log(`  [GRUPO] ${c.id} ${chat.name || '(sem nome)'} — lead atual: ${c.leads?.name || '—'}`);

            if (opts.dryRun) return;

            // Busca attendees pra popular participants
            const att = await unipileGet(`/chats/${c.whatsapp_chat_id}/attendees`);
            const participants = normalizeParticipants(att.items || []);

            const { error: updErr } = await supabase
                .from('conversations')
                .update({
                    is_group: true,
                    group_subject: chat.name || null,
                    group_participants: participants,
                    // OBS: lead_id mantido como está (mesmo errado) por compat —
                    // não apaga FKs em registros de produção. UI ignora lead_id
                    // quando is_group=true.
                })
                .eq('id', c.id);
            if (updErr) throw updErr;
            updated++;
        } catch (err) {
            errored++;
            console.error(`  ✗ ${c.id}: ${err.message}`);
        }
    }, opts.concurrency);

    console.log('\n=== Resumo ===');
    console.log(`Conversas processadas: ${processed}/${convs.length}`);
    console.log(`Detectadas como grupo: ${detected}`);
    console.log(`Atualizadas no DB:     ${opts.dryRun ? '(dry-run)' : updated}`);
    console.log(`Erros:                 ${errored}`);
}

main().catch(err => { console.error('Falha fatal:', err); process.exit(1); });
