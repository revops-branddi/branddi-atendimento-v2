/**
 * One-shot: re-puxa últimas N msgs de cada conversa WhatsApp ativa nos
 * últimos D dias, pra recuperar msgs que o polling possa ter perdido por
 * causa do bug do saveMessage (single() throw em duplicata, antes do fix
 * em fix/polling-message-loss).
 *
 * Uso:
 *   railway run node scripts/backfill-missing-messages.js [opções]
 *
 * Opções:
 *   --days=N        olhar conversas com last_message_at nos últimos N dias (default: 3)
 *   --limit=N       quantas msgs puxar por conversa (default: 50)
 *   --conv=UUID     restringir a uma única conversa (debug)
 *   --dry-run       não modifica nada — só lista o que faria
 *   --concurrency=N quantas conversas processar em paralelo (default: 3)
 *
 * O resyncConversation já deduplica por unipile_message_id; só msgs
 * faltantes são inseridas.
 */
import 'dotenv/config';
import supabase from '../src/services/supabase.js';
import { resyncConversation, isAvailable } from '../src/services/unipile.js';

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { days: 3, limit: 50, conv: null, dryRun: false, concurrency: 3 };
    for (const a of args) {
        if (a === '--dry-run') opts.dryRun = true;
        else if (a.startsWith('--days=')) opts.days = parseInt(a.slice(7), 10);
        else if (a.startsWith('--limit=')) opts.limit = parseInt(a.slice(8), 10);
        else if (a.startsWith('--conv=')) opts.conv = a.slice(7);
        else if (a.startsWith('--concurrency=')) opts.concurrency = parseInt(a.slice(14), 10);
    }
    return opts;
}

async function listConversations({ days, conv }) {
    if (conv) {
        const { data, error } = await supabase
            .from('conversations')
            .select('id, whatsapp_chat_id, last_message_at, leads(name, phone)')
            .eq('id', conv)
            .single();
        if (error) throw error;
        return data ? [data] : [];
    }

    const since = new Date(Date.now() - days * 24 * 3600_000).toISOString();
    const { data, error } = await supabase
        .from('conversations')
        .select('id, whatsapp_chat_id, last_message_at, leads(name, phone)')
        .not('whatsapp_chat_id', 'is', null)
        .gte('last_message_at', since)
        .order('last_message_at', { ascending: false });
    if (error) throw error;
    return data || [];
}

// Roda fn(item) com no máx N em paralelo. Retorna array dos resultados na ordem.
async function pmap(items, fn, concurrency) {
    const results = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (true) {
            const idx = i++;
            if (idx >= items.length) return;
            try {
                results[idx] = await fn(items[idx], idx);
            } catch (err) {
                results[idx] = { error: err.message };
            }
        }
    });
    await Promise.all(workers);
    return results;
}

async function main() {
    if (!isAvailable()) {
        console.error('Unipile não configurado (UNIPILE_API_KEY/DSN ausentes).');
        process.exit(1);
    }

    const opts = parseArgs();
    console.log('Backfill missing messages — opções:', opts);

    const convs = await listConversations(opts);
    console.log(`Encontradas ${convs.length} conversa(s) candidata(s)`);

    if (convs.length === 0) {
        console.log('Nada a fazer.');
        return;
    }

    if (opts.dryRun) {
        for (const c of convs.slice(0, 20)) {
            console.log(` - ${c.id} (${c.leads?.name || '—'}) ${c.last_message_at}`);
        }
        if (convs.length > 20) console.log(` ... +${convs.length - 20} outras`);
        console.log('--dry-run: nenhuma alteração feita.');
        return;
    }

    let totalInserted = 0, totalSkipped = 0, totalErrored = 0, totalConvErrors = 0;
    let processed = 0;

    await pmap(convs, async (c) => {
        try {
            const r = await resyncConversation(c.id, { limit: opts.limit });
            totalInserted += r.inserted;
            totalSkipped  += r.skipped;
            totalErrored  += r.errored;
            processed++;
            if (r.inserted > 0) {
                console.log(`  ✓ ${c.id} ${c.leads?.name || '—'}: +${r.inserted} novas (${r.skipped} já existiam, ${r.errored} erros)`);
            }
        } catch (err) {
            totalConvErrors++;
            console.error(`  ✗ ${c.id} ${c.leads?.name || '—'}: ${err.message}`);
        }
    }, opts.concurrency);

    console.log('\n=== Resumo ===');
    console.log(`Conversas processadas: ${processed}/${convs.length}`);
    console.log(`Mensagens recuperadas: ${totalInserted}`);
    console.log(`Já existiam (skipped): ${totalSkipped}`);
    console.log(`Erros por mensagem:    ${totalErrored}`);
    console.log(`Erros por conversa:    ${totalConvErrors}`);
}

main().catch(err => {
    console.error('Falha fatal:', err);
    process.exit(1);
});
