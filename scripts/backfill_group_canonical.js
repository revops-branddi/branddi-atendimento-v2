/**
 * Backfill: consolida rows duplicadas de grupos WhatsApp (uma por conta
 * Branddi) em row única chaveada pelo JID @g.us (group_provider_id).
 *
 * Contexto: antes da migration 014, cada whatsapp_account que via o mesmo
 * grupo criava sua própria conversation row (whatsapp_chat_id UNIQUE é
 * per-account no Unipile). Pós-migration, queremos UMA row canonical por
 * grupo, com whatsapp_account_ids[] listando as contas membros e
 * whatsapp_chat_ids = { account_id: chat_id_unipile } pra envio.
 *
 * O que o script faz:
 *   1. Lista todas conversations is_group=true
 *   2. Pra cada uma, busca o provider_id (@g.us) no Unipile via GET /chats/:id
 *      — necessário pq antigas não armazenam provider_id no DB
 *   3. Agrupa por provider_id. Pra grupos com mais de 1 row:
 *      - Elege canonical = row mais recente (updated_at desc)
 *      - Migra messages das outras pra canonical (UPDATE conversation_id +
 *        SET via_account_id = whatsapp_account_id da row antiga). Conflito
 *        no UNIQUE de unipile_message_id (mesma msg vista por 2 contas)
 *        deleta a duplicata em vez de migrar.
 *      - Atualiza canonical: group_provider_id, whatsapp_account_ids,
 *        whatsapp_chat_ids
 *      - Hard delete das rows redundantes
 *   4. Rows sem duplicata: só popula group_provider_id + arrays singulares
 *
 * Uso:
 *   node scripts/backfill_group_canonical.js --dry-run    # só loga, não muda
 *   node scripts/backfill_group_canonical.js              # executa
 *   node scripts/backfill_group_canonical.js --limit=10   # limita rows
 *
 * Pré-requisito: migration 014_group_canonical.sql aplicada.
 *
 * Idempotente: rodar de novo é no-op (rows já canonicalizadas pulam).
 */
import 'dotenv/config';
import supabase from '../src/services/supabase.js';

const API_KEY = process.env.UNIPILE_API_KEY;
const DSN     = process.env.UNIPILE_DSN;
const BASE    = DSN ? `https://${DSN}/api/v1` : null;

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { dryRun: false, limit: null };
    for (const a of args) {
        if (a === '--dry-run') opts.dryRun = true;
        else if (a.startsWith('--limit=')) opts.limit = parseInt(a.slice(8), 10);
    }
    return opts;
}

async function unipileGetChat(chatId) {
    const res = await fetch(`${BASE}/chats/${chatId}`, {
        headers: { 'X-API-KEY': API_KEY, 'Accept': 'application/json' },
    });
    if (!res.ok) return null;
    return res.json();
}

async function fetchAllGroupConversations(limit) {
    let q = supabase
        .from('conversations')
        .select('id, whatsapp_chat_id, whatsapp_account_id, whatsapp_account_ids, whatsapp_chat_ids, group_provider_id, group_subject, last_message_at, updated_at')
        .eq('is_group', true)
        .order('updated_at', { ascending: false });
    if (limit) q = q.limit(limit);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
}

// Resolve provider_id (JID @g.us) pra uma row. Usa o que já está no DB se
// disponível; senão consulta Unipile pelo chat_id.
async function resolveProviderId(row, cache) {
    if (row.group_provider_id) return row.group_provider_id;
    if (!row.whatsapp_chat_id) return null;
    if (cache.has(row.whatsapp_chat_id)) return cache.get(row.whatsapp_chat_id);

    const chat = await unipileGetChat(row.whatsapp_chat_id);
    const pid = chat?.provider_id || null;
    cache.set(row.whatsapp_chat_id, pid);
    return pid;
}

async function migrateMessagesToCanonical(fromConvId, toConvId, viaAccountId, dryRun) {
    // Pega ids das messages a migrar
    const { data: msgs, error } = await supabase
        .from('messages')
        .select('id, unipile_message_id')
        .eq('conversation_id', fromConvId);
    if (error) throw error;
    if (!msgs || msgs.length === 0) return { migrated: 0, deleted: 0 };

    let migrated = 0;
    let deleted = 0;

    for (const m of msgs) {
        if (dryRun) {
            migrated++;
            continue;
        }
        // Tenta UPDATE direto. Se bater no UNIQUE de unipile_message_id
        // (duplicata vista por outra conta), deleta a desta row em vez de migrar.
        const { error: updErr } = await supabase
            .from('messages')
            .update({ conversation_id: toConvId, via_account_id: viaAccountId })
            .eq('id', m.id);
        if (!updErr) {
            migrated++;
        } else if (updErr.code === '23505' || (updErr.message || '').includes('duplicate')) {
            // Duplicata: canonical já tem essa msg via outra conta. Deleta.
            const { error: delErr } = await supabase.from('messages').delete().eq('id', m.id);
            if (delErr) throw delErr;
            deleted++;
        } else {
            throw updErr;
        }
    }
    return { migrated, deleted };
}

async function processGroup(jid, rows, dryRun) {
    // Eleger canonical: row com updated_at mais recente
    const sorted = [...rows].sort((a, b) =>
        new Date(b.updated_at || 0) - new Date(a.updated_at || 0)
    );
    const canonical = sorted[0];
    const others = sorted.slice(1);

    // Monta arrays consolidados
    const accIds = new Set();
    const chatIdsMap = {};
    for (const r of rows) {
        if (r.whatsapp_account_id) {
            accIds.add(r.whatsapp_account_id);
            chatIdsMap[r.whatsapp_account_id] = r.whatsapp_chat_id;
        }
    }

    const summary = {
        jid,
        subject: canonical.group_subject,
        rows_total: rows.length,
        canonical_id: canonical.id,
        redundant_ids: others.map(r => r.id),
        accounts: [...accIds],
        msgs_migrated: 0,
        msgs_deleted: 0,
    };

    // Migra messages das redundantes pra canonical
    for (const o of others) {
        const { migrated, deleted } = await migrateMessagesToCanonical(
            o.id, canonical.id, o.whatsapp_account_id, dryRun
        );
        summary.msgs_migrated += migrated;
        summary.msgs_deleted += deleted;
    }

    if (!dryRun) {
        // Atualiza canonical
        const { error: updErr } = await supabase
            .from('conversations')
            .update({
                group_provider_id:    jid,
                whatsapp_account_ids: [...accIds],
                whatsapp_chat_ids:    chatIdsMap,
            })
            .eq('id', canonical.id);
        if (updErr) throw updErr;

        // Hard delete das redundantes
        if (others.length > 0) {
            const { error: delErr } = await supabase
                .from('conversations')
                .delete()
                .in('id', others.map(r => r.id));
            if (delErr) throw delErr;
        }
    }

    return summary;
}

// Pra rows sem duplicata: ainda assim popula os campos novos
async function backfillSolo(row, providerId, dryRun) {
    const updates = {
        group_provider_id: providerId,
    };
    if (row.whatsapp_account_id) {
        updates.whatsapp_account_ids = [row.whatsapp_account_id];
        updates.whatsapp_chat_ids = { [row.whatsapp_account_id]: row.whatsapp_chat_id };
    }
    if (!dryRun) {
        const { error } = await supabase
            .from('conversations')
            .update(updates)
            .eq('id', row.id);
        if (error) throw error;
    }
    return { id: row.id, subject: row.group_subject, jid: providerId };
}

async function main() {
    const opts = parseArgs();
    if (!BASE) {
        console.error('UNIPILE_DSN/API_KEY ausentes — não dá pra resolver provider_id.');
        process.exit(1);
    }

    console.log(`\n${opts.dryRun ? '[DRY RUN] ' : ''}Backfill canonical de grupos\n`);

    const rows = await fetchAllGroupConversations(opts.limit);
    console.log(`Grupos no DB: ${rows.length}`);

    // Resolve provider_id pra cada row (via DB ou Unipile)
    const providerCache = new Map();
    const byJid = new Map();
    const orphans = [];

    for (const r of rows) {
        try {
            const jid = await resolveProviderId(r, providerCache);
            if (!jid) {
                orphans.push(r);
                continue;
            }
            if (!byJid.has(jid)) byJid.set(jid, []);
            byJid.get(jid).push(r);
        } catch (err) {
            console.warn(`  ⚠️  Falha resolvendo JID de ${r.id} (chat ${r.whatsapp_chat_id}): ${err.message}`);
            orphans.push(r);
        }
    }

    console.log(`JIDs únicos: ${byJid.size}`);
    console.log(`Rows sem JID resolvido: ${orphans.length}`);

    // Separa grupos com duplicatas vs solos
    let dupGroups = 0;
    let consolidated = 0;
    let soloUpdated = 0;
    let totalMigrated = 0;
    let totalDeleted = 0;

    for (const [jid, group] of byJid.entries()) {
        if (group.length > 1) {
            dupGroups++;
            const s = await processGroup(jid, group, opts.dryRun);
            consolidated += s.redundant_ids.length;
            totalMigrated += s.msgs_migrated;
            totalDeleted += s.msgs_deleted;
            console.log(
                `  📦 "${s.subject}" — ${s.rows_total} rows → 1` +
                ` | contas: [${s.accounts.join(', ')}]` +
                ` | msgs migradas: ${s.msgs_migrated}, deletadas (dup): ${s.msgs_deleted}`
            );
        } else {
            const r = group[0];
            // Só atualiza se ainda não tem os campos novos
            if (!r.group_provider_id || !Array.isArray(r.whatsapp_account_ids) || r.whatsapp_account_ids.length === 0) {
                await backfillSolo(r, jid, opts.dryRun);
                soloUpdated++;
            }
        }
    }

    console.log(`\nResumo:`);
    console.log(`  Grupos com duplicatas: ${dupGroups}`);
    console.log(`  Rows redundantes consolidadas: ${consolidated}`);
    console.log(`  Grupos solos atualizados (só popula novos campos): ${soloUpdated}`);
    console.log(`  Messages migradas pra canonical: ${totalMigrated}`);
    console.log(`  Messages deletadas (dup pelo unipile_message_id): ${totalDeleted}`);
    console.log(`  Orphans (sem JID resolvido): ${orphans.length}`);
    if (orphans.length > 0) {
        console.log(`    → IDs: ${orphans.slice(0, 10).map(o => o.id).join(', ')}${orphans.length > 10 ? '...' : ''}`);
    }
    if (opts.dryRun) {
        console.log(`\n[DRY RUN] Nada foi modificado. Re-rode sem --dry-run pra aplicar.`);
    }
}

main().then(() => process.exit(0)).catch(err => {
    console.error('Erro fatal:', err);
    process.exit(1);
});
