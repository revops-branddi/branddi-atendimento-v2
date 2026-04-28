/**
 * One-shot: re-fire Apollo /people/match para todas as linhas em
 * apollo_enrichments com status='pending' que ficaram órfãs por causa do
 * webhook URL inválido (FRONTEND_URL apontava pra service morta).
 *
 * Uso:
 *   railway run node scripts/reprocess-pending-apollo.js [--dry-run]
 *
 * Pré-requisito: PUBLIC_URL precisa estar setado e o deploy ativo.
 */
import 'dotenv/config';
import supabase from '../src/services/supabase.js';
import { matchPerson, isApolloConfigured } from '../src/services/apollo.js';
import { pdGet } from '../src/services/pipedrive.js';

const DRY_RUN = process.argv.includes('--dry-run');
const SLEEP_MS = 1500;

function getPublicBaseUrl() {
    return process.env.PUBLIC_URL
        || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null)
        || process.env.FRONTEND_URL;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
    if (!isApolloConfigured()) {
        console.error('APOLLO_API_KEY ausente.');
        process.exit(1);
    }
    const baseUrl = getPublicBaseUrl();
    if (!baseUrl) {
        console.error('Sem URL pública configurada (PUBLIC_URL/RAILWAY_PUBLIC_DOMAIN).');
        process.exit(1);
    }
    const webhookUrl = `${baseUrl}/api/webhooks/apollo`;
    console.log(`webhook_url alvo: ${webhookUrl}`);
    console.log(DRY_RUN ? '[DRY RUN] nada será gravado' : '[LIVE] vai gastar créditos Apollo');

    const { data: pending, error } = await supabase
        .from('apollo_enrichments')
        .select('ref, pipedrive_person_id, person_name, created_at, apollo_request_id')
        .eq('status', 'pending')
        .order('created_at', { ascending: true });

    if (error) {
        console.error('Falha lendo pending:', error.message);
        process.exit(1);
    }
    console.log(`encontrei ${pending.length} linhas pending`);

    let refired = 0, alreadyHasPhone = 0, notFound = 0, errors = 0;

    for (const row of pending) {
        const tag = `[${row.ref.slice(0, 8)}] ${row.person_name || '?'}`;
        try {
            const pd = await pdGet(`/persons/${row.pipedrive_person_id}`);
            const current = pd?.data;
            if (!current) {
                console.log(`${tag} → person não encontrado no Pipedrive`);
                if (!DRY_RUN) {
                    await supabase.from('apollo_enrichments')
                        .update({ status: 'error', error: 'Pipedrive person not found', completed_at: new Date().toISOString() })
                        .eq('ref', row.ref);
                }
                errors++;
                continue;
            }

            const hasPhone = (current.phone || []).some(p => p.value && String(p.value).length > 5);
            if (hasPhone) {
                console.log(`${tag} → Pipedrive já tem phone, marcando completed`);
                if (!DRY_RUN) {
                    await supabase.from('apollo_enrichments')
                        .update({ status: 'completed', completed_at: new Date().toISOString() })
                        .eq('ref', row.ref);
                }
                alreadyHasPhone++;
                continue;
            }

            if (DRY_RUN) {
                console.log(`${tag} → would re-fire match+reveal`);
                refired++;
                continue;
            }

            const apolloResp = await matchPerson({
                name: current.name,
                email: current.email?.[0]?.value,
                phone_number: current.phone?.[0]?.value,
                organization_name: current.org_name,
                reveal_phone_number: true,
                webhook_url: webhookUrl,
            });

            if (!apolloResp.matched) {
                await supabase.from('apollo_enrichments')
                    .update({ status: 'not_found', completed_at: new Date().toISOString() })
                    .eq('ref', row.ref);
                console.log(`${tag} → not_found`);
                notFound++;
                continue;
            }

            const newReqId = apolloResp.phone_enrichment?.request_id || null;
            const phoneStatus = apolloResp.phone_enrichment?.status || null;
            const finalStatus = phoneStatus === 'pending' ? 'pending' : 'completed';

            await supabase.from('apollo_enrichments')
                .update({
                    apollo_request_id: newReqId,
                    status: finalStatus,
                    result: { person: apolloResp.person, reprocessed_at: new Date().toISOString() },
                    completed_at: finalStatus === 'completed' ? new Date().toISOString() : null,
                })
                .eq('ref', row.ref);

            console.log(`${tag} → re-fired, new_req_id=${newReqId} status=${phoneStatus}`);
            refired++;
        } catch (err) {
            console.error(`${tag} → ERRO: ${err.message}`);
            errors++;
        }
        await sleep(SLEEP_MS);
    }

    console.log('\n──── resumo ────');
    console.log(`re-fired:           ${refired}`);
    console.log(`já tinha phone:     ${alreadyHasPhone}`);
    console.log(`not_found:          ${notFound}`);
    console.log(`erros:              ${errors}`);
    console.log(`total processado:   ${pending.length}`);
}

main().then(() => process.exit(0)).catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
