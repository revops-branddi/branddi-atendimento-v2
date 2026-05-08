/**
 * One-shot: preenche whatsapp_accounts.display_label baseado em quem tem
 * a conta atribuída nas permissions.whatsapp_accounts.
 *
 * Lógica (match único):
 *   - 1 user com a conta nas permissions → display_label = primeiro_nome
 *   - 0 ou 2+ users → skip (deixa pro admin preencher manual)
 *   - Conta já tem display_label → skip (idempotente)
 *
 * Uso: node scripts/auto-fill-account-labels.js [--dry-run]
 */
import 'dotenv/config';
import supabase from '../src/services/supabase.js';

const DRY = process.argv.includes('--dry-run');

async function main() {
    const { data: accounts, error: accErr } = await supabase
        .from('whatsapp_accounts')
        .select('unipile_account_id, phone_number, display_label, status');
    if (accErr) { console.error(accErr.message); process.exit(1); }

    const { data: users, error: usrErr } = await supabase
        .from('platform_users')
        .select('id, name, permissions');
    if (usrErr) { console.error(usrErr.message); process.exit(1); }

    let updated = 0, skipped = 0, ambiguous = 0, orphan = 0;

    for (const acc of accounts) {
        if (acc.display_label) { skipped++; continue; }

        const matches = users.filter(u =>
            (u.permissions?.whatsapp_accounts || []).includes(acc.unipile_account_id)
        );

        const display = acc.phone_number || acc.unipile_account_id;
        if (matches.length === 0) {
            console.log(`  · ${display.padEnd(20)} sem owner em permissions`);
            orphan++;
            continue;
        }
        if (matches.length > 1) {
            console.log(`  ⚠ ${display.padEnd(20)} ambíguo: ${matches.map(m => m.name).join(', ')}`);
            ambiguous++;
            continue;
        }

        const firstName = (matches[0].name || '').split(/\s+/)[0];
        if (!firstName) { skipped++; continue; }

        console.log(`  ✓ ${display.padEnd(20)} → "${firstName}" (${matches[0].name})`);
        if (!DRY) {
            const { error } = await supabase
                .from('whatsapp_accounts')
                .update({ display_label: firstName })
                .eq('unipile_account_id', acc.unipile_account_id);
            if (error) console.error(`    ERRO: ${error.message}`);
            else updated++;
        } else {
            updated++;
        }
    }

    console.log('\n=== Resumo ===');
    console.log(`Atualizados:        ${DRY ? '(dry-run) ' : ''}${updated}`);
    console.log(`Já tinham label:    ${skipped}`);
    console.log(`Ambíguos (skip):    ${ambiguous}`);
    console.log(`Sem owner (skip):   ${orphan}`);
}

main().catch(err => { console.error(err); process.exit(1); });
