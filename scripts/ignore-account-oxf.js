/**
 * One-shot: marca uma conta WhatsApp como "ignored" (de outro time) e limpa
 * o estrago local — DMs deletadas, grupos canonical realocados ou deletados,
 * grupos onde a conta era só membro têm o ID removido do array.
 *
 * Default target: oxF_Ozs3RuakhJkHk130Zg (5511944443188 — outro time Branddi).
 *
 * Uso:
 *   node scripts/ignore-account-oxf.js --dry-run         # só imprime o plano
 *   node scripts/ignore-account-oxf.js                   # EXECUTA (destrutivo)
 *   node scripts/ignore-account-oxf.js --account=ID      # outro account_id
 *
 * Ordem das operações:
 *   1. UPDATE whatsapp_accounts SET ignored=true
 *   2. Pra cada grupo onde a conta é canonical (whatsapp_account_id = target):
 *      a. Se há outra Branddi no array → elege nova canonical (cascata
 *         display_label > connected_by_user_id > primeira do array) e
 *         atualiza: whatsapp_account_id, whatsapp_account_ids (sem target),
 *         whatsapp_chat_ids (sem key target).
 *      b. Se NÃO há outra Branddi → DELETE da row (cascade leva msgs).
 *   3. Pra cada grupo onde a conta é só membro (no array, não canonical):
 *      remove do whatsapp_account_ids e do whatsapp_chat_ids.
 *   4. DELETE das DMs (is_group=false, whatsapp_account_id=target).
 *
 * Idempotente: rodar de novo é no-op (não acha mais conversas).
 *
 * NÃO mexe na conta no Unipile — continua válida pro outro time.
 */
import 'dotenv/config';
import supabase from '../src/services/supabase.js';

const DEFAULT_ACCOUNT = 'oxF_Ozs3RuakhJkHk130Zg';

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { dryRun: false, account: DEFAULT_ACCOUNT };
    for (const a of args) {
        if (a === '--dry-run') opts.dryRun = true;
        else if (a.startsWith('--account=')) opts.account = a.slice(10);
    }
    return opts;
}

// Cascata pra eleger nova canonical entre as outras contas membros:
//   1. display_label setado
//   2. connected_by_user_id setado
//   3. primeira do array (estável)
function pickNewCanonical(otherAccountIds, accountsIndex) {
    for (const id of otherAccountIds) {
        if (accountsIndex[id]?.display_label) return id;
    }
    for (const id of otherAccountIds) {
        if (accountsIndex[id]?.connected_by_user_id) return id;
    }
    return otherAccountIds[0];
}

async function loadAccountsIndex() {
    const { data } = await supabase
        .from('whatsapp_accounts')
        .select('unipile_account_id, display_label, connected_by_user_id, phone_number');
    const idx = {};
    for (const a of (data || [])) idx[a.unipile_account_id] = a;
    return idx;
}

async function main() {
    const opts = parseArgs();
    const TARGET = opts.account;
    const tag = opts.dryRun ? '[DRY RUN] ' : '';
    console.log(`\n${tag}Ignorando conta WhatsApp: ${TARGET}\n`);

    const accountsIndex = await loadAccountsIndex();
    const targetMeta = accountsIndex[TARGET];
    if (!targetMeta) {
        console.error(`Conta ${TARGET} não encontrada em whatsapp_accounts.`);
        process.exit(1);
    }
    console.log(`Phone: ${targetMeta.phone_number} | display_label: ${targetMeta.display_label || '(none)'}\n`);

    // ─── 1. Set ignored=true ───────────────────────────────────────────
    console.log(`(1) whatsapp_accounts.ignored = true`);
    if (!opts.dryRun) {
        const { error } = await supabase
            .from('whatsapp_accounts')
            .update({ ignored: true, updated_at: new Date().toISOString() })
            .eq('unipile_account_id', TARGET);
        if (error) throw error;
    }

    // ─── 2. Grupos onde TARGET é canonical ─────────────────────────────
    const { data: canonicalGroups } = await supabase
        .from('conversations')
        .select('id, group_subject, whatsapp_account_id, whatsapp_account_ids, whatsapp_chat_ids')
        .eq('is_group', true)
        .eq('whatsapp_account_id', TARGET)
        .is('archived_at', null);

    let transferred = 0, deletedGroups = 0;
    console.log(`\n(2) Grupos canonical TARGET: ${canonicalGroups?.length || 0}`);
    for (const g of (canonicalGroups || [])) {
        const others = (g.whatsapp_account_ids || []).filter(id => id !== TARGET);
        if (others.length > 0) {
            // Transfere canonical
            const newCanonical = pickNewCanonical(others, accountsIndex);
            const newChatIds = { ...(g.whatsapp_chat_ids || {}) };
            delete newChatIds[TARGET];
            const label = accountsIndex[newCanonical]?.display_label
                || accountsIndex[newCanonical]?.phone_number
                || newCanonical;
            console.log(`  ✎ transfer "${g.group_subject}" → canonical=${label}`);
            if (!opts.dryRun) {
                const { error } = await supabase
                    .from('conversations')
                    .update({
                        whatsapp_account_id: newCanonical,
                        whatsapp_account_ids: others,
                        whatsapp_chat_ids: newChatIds,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('id', g.id);
                if (error) throw error;
            }
            transferred++;
        } else {
            // Só TARGET era Branddi membro → delete (cascade pega messages)
            console.log(`  ✗ DELETE "${g.group_subject}" (era só TARGET)`);
            if (!opts.dryRun) {
                const { error } = await supabase
                    .from('conversations')
                    .delete()
                    .eq('id', g.id);
                if (error) throw error;
            }
            deletedGroups++;
        }
    }

    // ─── 3. Grupos onde TARGET é só membro (não canonical) ─────────────
    const { data: memberGroups } = await supabase
        .from('conversations')
        .select('id, group_subject, whatsapp_account_id, whatsapp_account_ids, whatsapp_chat_ids')
        .eq('is_group', true)
        .contains('whatsapp_account_ids', [TARGET])
        .neq('whatsapp_account_id', TARGET)
        .is('archived_at', null);

    let stripped = 0;
    console.log(`\n(3) Grupos onde TARGET é só membro: ${memberGroups?.length || 0}`);
    for (const g of (memberGroups || [])) {
        const newArr = (g.whatsapp_account_ids || []).filter(id => id !== TARGET);
        const newChatIds = { ...(g.whatsapp_chat_ids || {}) };
        delete newChatIds[TARGET];
        if (!opts.dryRun) {
            const { error } = await supabase
                .from('conversations')
                .update({
                    whatsapp_account_ids: newArr,
                    whatsapp_chat_ids: newChatIds,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', g.id);
            if (error) throw error;
        }
        stripped++;
    }
    if (memberGroups?.length) console.log(`  (sample) "${memberGroups[0].group_subject}" e mais ${memberGroups.length - 1}`);

    // ─── 4. DMs ────────────────────────────────────────────────────────
    const { data: dms } = await supabase
        .from('conversations')
        .select('id, lead_id, leads(name, phone)')
        .eq('is_group', false)
        .eq('whatsapp_account_id', TARGET);

    console.log(`\n(4) DMs (is_group=false): ${dms?.length || 0}`);
    for (const d of (dms || [])) {
        console.log(`  ✗ DELETE conv=${d.id} lead=${d.leads?.name || '?'} (${d.leads?.phone || '—'})`);
    }
    let deletedDms = 0;
    if (!opts.dryRun && dms?.length) {
        const { error } = await supabase
            .from('conversations')
            .delete()
            .in('id', dms.map(d => d.id));
        if (error) throw error;
        deletedDms = dms.length;
    }

    // ─── Resumo ────────────────────────────────────────────────────────
    console.log(`\n${tag}Resumo:`);
    console.log(`  Account marcada ignored:           ${opts.dryRun ? '(dry)' : 'OK'}`);
    console.log(`  Grupos canonical transferidos:     ${opts.dryRun ? canonicalGroups?.filter(g => (g.whatsapp_account_ids||[]).filter(id=>id!==TARGET).length>0).length || 0 : transferred}`);
    console.log(`  Grupos canonical deletados:        ${opts.dryRun ? canonicalGroups?.filter(g => (g.whatsapp_account_ids||[]).filter(id=>id!==TARGET).length===0).length || 0 : deletedGroups}`);
    console.log(`  Grupos com TARGET removido do array: ${opts.dryRun ? memberGroups?.length || 0 : stripped}`);
    console.log(`  DMs deletadas:                     ${opts.dryRun ? dms?.length || 0 : deletedDms}`);
    if (opts.dryRun) console.log(`\n[DRY RUN] Nada foi modificado. Rode sem --dry-run pra aplicar.`);
}

main().then(() => process.exit(0)).catch(err => {
    console.error('Erro fatal:', err);
    process.exit(1);
});
