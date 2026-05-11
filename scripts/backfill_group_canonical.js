/**
 * Backfill: consolida rows duplicadas de grupos WhatsApp (uma por conta
 * Branddi) em row única chaveada pelo JID @g.us (group_provider_id).
 *
 * Contexto: antes da migration 014, cada whatsapp_account que via o mesmo
 * grupo criava sua própria conversation row (whatsapp_chat_id UNIQUE é
 * per-account no Unipile). Pós-migration, queremos UMA row canonical por
 * grupo, com whatsapp_account_ids[] listando todas as contas membros e
 * whatsapp_chat_ids = { account_id: chat_id_unipile } pra envio.
 *
 * Decisão crítica: como o Unipile gera um unipile_message_id DIFERENTE pra
 * cada conta capturando a mesma msg do WhatsApp (e direction até inverte
 * entre as cópias quando uma das contas é o sender), NÃO dá pra "merger"
 * messages das rows redundantes — só dá pra escolher uma versão da verdade.
 *
 * Estratégia: eleger uma canonical_account (mesma cascata do pickSendAccount:
 * conta configurada com display_label/connected_by_user_id antes da órfã).
 * A row dessa conta vira a canonical; as outras conversation rows são
 * hard-deletadas (cascade leva as msgs delas — perspectiva da conta órfã
 * que ninguém via na UI mesmo).
 *
 * O que o script faz:
 *   1. Carrega whatsapp_accounts no índice (pra cascata canonical_account)
 *   2. Lista todas conversations is_group=true
 *   3. Pra cada uma, resolve provider_id (@g.us) via DB ou Unipile
 *   4. Agrupa por provider_id. Pra grupos com mais de 1 row:
 *      - Elege canonical_account: conta com display_label OU connected_by_user_id
 *        (fallback: primeira do array)
 *      - canonical_conv = a row dessa conta
 *      - Hard-delete das outras rows (FK ON DELETE CASCADE leva messages)
 *      - Atualiza canonical_conv: group_provider_id + arrays consolidados
 *        (whatsapp_account_ids inclui TODAS as contas, incluindo as órfãs,
 *        pra polling futuro mergear correto em vez de criar row nova)
 *   5. Rows sem duplicata: só popula group_provider_id + arrays singulares
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

// Cascata pra escolher qual conta é a "canonical" de um grupo com múltiplas
// conversation rows. Igual à do pickSendAccount em runtime, sem o degrau de
// user permission (backfill não tem user logado).
//   1. Conta com display_label setado (foi nomeada no app)
//   2. Conta com connected_by_user_id setado (alguém conectou no app)
//   3. Fallback: primeira do array
function chooseCanonicalAccount(accountIds, accountsIndex) {
    for (const accId of accountIds) {
        const meta = accountsIndex[accId];
        if (meta?.display_label) return accId;
    }
    for (const accId of accountIds) {
        const meta = accountsIndex[accId];
        if (meta?.connected_by_user_id) return accId;
    }
    return accountIds[0] || null;
}

async function processGroup(jid, rows, accountsIndex, dryRun) {
    // Monta arrays consolidados — TODAS as contas (incluindo órfãs) entram
    // no whatsapp_account_ids pra polling futuro mergear corretamente.
    const accIds = [];
    const chatIdsMap = {};
    for (const r of rows) {
        if (r.whatsapp_account_id && !accIds.includes(r.whatsapp_account_id)) {
            accIds.push(r.whatsapp_account_id);
            chatIdsMap[r.whatsapp_account_id] = r.whatsapp_chat_id;
        }
    }

    // Eleger conta canonical — a row dessa conta será preservada com suas msgs.
    // Demais rows são hard-deletadas (cascade leva suas msgs, que ninguém via).
    const canonicalAccountId = chooseCanonicalAccount(accIds, accountsIndex);
    const canonical = rows.find(r => r.whatsapp_account_id === canonicalAccountId) || rows[0];
    const others = rows.filter(r => r.id !== canonical.id);

    // Conta msgs descartadas pra log
    let discardedMsgs = 0;
    if (others.length > 0) {
        const { count } = await supabase
            .from('messages')
            .select('id', { count: 'exact', head: true })
            .in('conversation_id', others.map(r => r.id));
        discardedMsgs = count || 0;
    }

    const summary = {
        jid,
        subject: canonical.group_subject,
        rows_total: rows.length,
        canonical_id: canonical.id,
        canonical_account: canonicalAccountId,
        canonical_account_label: accountsIndex[canonicalAccountId]?.display_label || null,
        discarded_rows: others.length,
        discarded_msgs: discardedMsgs,
        accounts: accIds,
    };

    if (!dryRun) {
        // 1. Atualiza canonical PRIMEIRO com group_provider_id, antes do delete.
        //    Importante fazer antes, pq UNIQUE em group_provider_id colide se
        //    duas rows tentarem o mesmo JID. As outras rows não têm o JID
        //    setado ainda (são legacy), então delete depois é seguro.
        const { error: updErr } = await supabase
            .from('conversations')
            .update({
                group_provider_id:    jid,
                whatsapp_account_ids: accIds,
                whatsapp_chat_ids:    chatIdsMap,
            })
            .eq('id', canonical.id);
        if (updErr) throw updErr;

        // 2. Hard-delete das outras rows. FK conversations → messages é
        //    ON DELETE CASCADE (migration 001), então as msgs delas vão junto.
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

async function loadAccountsIndex() {
    const { data, error } = await supabase
        .from('whatsapp_accounts')
        .select('unipile_account_id, display_label, connected_by_user_id, phone_number');
    if (error) throw error;
    const idx = {};
    for (const a of (data || [])) {
        idx[a.unipile_account_id] = a;
    }
    return idx;
}

async function main() {
    const opts = parseArgs();
    if (!BASE) {
        console.error('UNIPILE_DSN/API_KEY ausentes — não dá pra resolver provider_id.');
        process.exit(1);
    }

    console.log(`\n${opts.dryRun ? '[DRY RUN] ' : ''}Backfill canonical de grupos\n`);

    const accountsIndex = await loadAccountsIndex();
    console.log(`WhatsApp accounts no DB: ${Object.keys(accountsIndex).length}`);

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
    console.log(`Rows sem JID resolvido: ${orphans.length}\n`);

    // Separa grupos com duplicatas vs solos
    let dupGroups = 0;
    let dupRowsKilled = 0;
    let totalDiscardedMsgs = 0;
    let soloUpdated = 0;

    for (const [jid, group] of byJid.entries()) {
        if (group.length > 1) {
            dupGroups++;
            const s = await processGroup(jid, group, accountsIndex, opts.dryRun);
            dupRowsKilled += s.discarded_rows;
            totalDiscardedMsgs += s.discarded_msgs;
            const canonLabel = s.canonical_account_label || s.canonical_account || '???';
            console.log(
                `  📦 "${s.subject}" — ${s.rows_total} rows → 1` +
                ` | canonical: ${canonLabel}` +
                ` | contas no array: [${s.accounts.join(', ')}]` +
                ` | msgs descartadas: ${s.discarded_msgs}`
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
    console.log(`  Rows redundantes deletadas: ${dupRowsKilled}`);
    console.log(`  Messages descartadas (via cascade da row redundante): ${totalDiscardedMsgs}`);
    console.log(`  Grupos solos atualizados (só popula novos campos): ${soloUpdated}`);
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
