/**
 * One-shot: popula has_whatsapp nas rows de apollo_enrichments que já
 * concluíram (status='completed', phone NOT NULL) mas foram salvas antes
 * da migration 017 — então têm has_whatsapp NULL.
 *
 * Não consome créditos Apollo. Cada row faz 1-2 chamadas Unipile (lookup),
 * que é rate-limited mas gratuito.
 *
 * Uso: railway run node scripts/backfill-apollo-has-whatsapp.js [--dry-run]
 */
import 'dotenv/config';
import supabase from '../src/services/supabase.js';
import { checkWhatsAppPresence, isAvailable } from '../src/services/unipile.js';

const DRY_RUN = process.argv.includes('--dry-run');
const SLEEP_MS = 800;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
    if (!isAvailable()) {
        console.error('Unipile não configurado.');
        process.exit(1);
    }
    console.log(DRY_RUN ? '[DRY RUN]' : '[LIVE]', 'backfill apollo_enrichments.has_whatsapp');

    const { data: rows, error } = await supabase
        .from('apollo_enrichments')
        .select('ref, phone, person_name, completed_at')
        .eq('status', 'completed')
        .not('phone', 'is', null)
        .is('has_whatsapp', null)
        .order('completed_at', { ascending: false });

    if (error) { console.error(error.message); process.exit(1); }
    console.log(`encontrei ${rows.length} rows pra backfill`);

    let yes = 0, no = 0, unknown = 0, errors = 0;
    for (const row of rows) {
        const tag = `[${row.ref.slice(0, 8)}] ${row.person_name || '?'} (${row.phone})`;
        try {
            const r = await checkWhatsAppPresence(row.phone);
            const label = r.has_whatsapp === true ? '✓ WA'
                        : r.has_whatsapp === false ? `✗ sem WA (${r.reason})`
                        : '? indef';

            if (!DRY_RUN) {
                await supabase.from('apollo_enrichments')
                    .update({ has_whatsapp: r.has_whatsapp })
                    .eq('ref', row.ref);
            }

            console.log(`${tag} → ${label}`);
            if (r.has_whatsapp === true) yes++;
            else if (r.has_whatsapp === false) no++;
            else unknown++;
        } catch (err) {
            console.error(`${tag} → ERRO: ${err.message}`);
            errors++;
        }
        await sleep(SLEEP_MS);
    }

    console.log('\n──── resumo ────');
    console.log(`com WA:        ${yes}`);
    console.log(`sem WA:        ${no}`);
    console.log(`indeterminado: ${unknown}`);
    console.log(`erros:         ${errors}`);
    console.log(`total:         ${rows.length}`);
}

main().then(() => process.exit(0)).catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
