/**
 * Diagnóstico Apollo — checa se o pipeline de reveal está saudável.
 *
 * Imprime:
 *   1. Env vars relevantes (PUBLIC_URL, RAILWAY_PUBLIC_DOMAIN, FRONTEND_URL) + webhook_url resolvido
 *   2. Últimas 15 linhas de apollo_enrichments com status detalhado
 *   3. Contagem de rows por status nas últimas 24h
 *   4. Para a linha pending mais recente: shape do result (apollo_id presente? phone_enrichment?)
 *   5. Ping HTTP no próprio /api/webhooks/apollo com payload bulk vazio (espera 200)
 *
 * Uso: railway run node scripts/diag-apollo.js
 */
import 'dotenv/config';
import supabase from '../src/services/supabase.js';

function pad(s, n) { return String(s ?? '').padEnd(n).slice(0, n); }

function resolveWebhookUrl() {
    const raw = process.env.PUBLIC_URL
        || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null)
        || process.env.FRONTEND_URL;
    if (!raw) return null;
    const base = raw.replace(/\/+$/, '');
    return `${base}/api/webhooks/apollo`;
}

async function section1_env() {
    console.log('\n═══ 1. Env / webhook URL ═══');
    console.log('PUBLIC_URL            =', process.env.PUBLIC_URL || '(unset)');
    console.log('RAILWAY_PUBLIC_DOMAIN =', process.env.RAILWAY_PUBLIC_DOMAIN || '(unset)');
    console.log('FRONTEND_URL          =', process.env.FRONTEND_URL || '(unset)');
    const webhookUrl = resolveWebhookUrl();
    console.log('→ webhook_url enviado pro Apollo:', webhookUrl || '⚠️  NENHUM!');
    return webhookUrl;
}

async function section2_recent_rows() {
    console.log('\n═══ 2. Últimas 15 rows de apollo_enrichments ═══');
    const { data, error } = await supabase
        .from('apollo_enrichments')
        .select('ref, status, pipedrive_person_id, person_name, apollo_request_id, phone, error, created_at, completed_at')
        .order('created_at', { ascending: false })
        .limit(15);
    if (error) { console.error('erro:', error.message); return []; }

    console.log(pad('created', 19), pad('status', 12), pad('person', 22), pad('req_id', 14), pad('phone', 16));
    console.log('─'.repeat(90));
    for (const r of data) {
        console.log(
            pad(r.created_at?.replace('T', ' ').slice(0, 19), 19),
            pad(r.status, 12),
            pad(r.person_name, 22),
            pad(r.apollo_request_id?.slice(0, 12), 14),
            pad(r.phone, 16),
        );
    }
    return data;
}

async function section3_counts() {
    console.log('\n═══ 3. Contagem por status (últimas 24h) ═══');
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
        .from('apollo_enrichments')
        .select('status')
        .gte('created_at', since);
    if (error) { console.error('erro:', error.message); return; }
    const counts = {};
    for (const r of data) counts[r.status] = (counts[r.status] || 0) + 1;
    console.log(`total nas últimas 24h: ${data.length}`);
    for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${pad(k, 12)} ${v}`);
    }
}

async function section4_pending_shape(rows) {
    console.log('\n═══ 4. Inspeção da row pending mais recente ═══');
    const pending = rows.find(r => r.status === 'pending');
    if (!pending) { console.log('(nenhuma pending nas últimas 15)'); return; }

    const { data, error } = await supabase
        .from('apollo_enrichments')
        .select('ref, person_name, apollo_request_id, result, created_at')
        .eq('ref', pending.ref)
        .single();
    if (error) { console.error('erro:', error.message); return; }

    console.log(`ref=${data.ref}  person=${data.person_name}  created=${data.created_at}`);
    console.log(`apollo_request_id=${data.apollo_request_id || '(null)'}`);
    const result = data.result || {};
    console.log('result keys:', Object.keys(result));
    if (result.person) {
        console.log('result.person.apollo_id =', result.person.apollo_id);
        console.log('result.person.name      =', result.person.name);
        console.log('result.person.phone_numbers =', result.person.phone_numbers);
    } else {
        console.log('⚠️  result.person NÃO existe — webhook bulk match vai falhar');
    }
    if (result.phone_outcome) console.log('result.phone_outcome    =', result.phone_outcome);
}

async function section5_completed_shape(rows) {
    console.log('\n═══ 5. Inspeção da row completed mais recente (via webhook) ═══');
    const { data, error } = await supabase
        .from('apollo_enrichments')
        .select('ref, person_name, phone, result, created_at, completed_at')
        .eq('status', 'completed')
        .not('phone', 'is', null)
        .order('completed_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) { console.error('erro:', error.message); return; }
    if (!data) { console.log('(nunca completou nenhuma com phone)'); return; }
    console.log(`ref=${data.ref}  person=${data.person_name}`);
    console.log(`created=${data.created_at}  completed=${data.completed_at}`);
    console.log(`phone=${data.phone}`);
    const result = data.result || {};
    console.log('result top-level keys:', Object.keys(result));
    if (result._bulk) console.log('→ veio via webhook BULK (people[])');
    else if (result.request_id) console.log('→ veio via webhook LEGACY (single)');
    else console.log('→ shape desconhecido / pode ter sido completed síncrono');
}

async function section6_ping_webhook(webhookUrl) {
    console.log('\n═══ 6. Ping no próprio /api/webhooks/apollo ═══');
    if (!webhookUrl) { console.log('(sem URL, skip)'); return; }
    try {
        const r = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ people: [{ id: '__diag_nonexistent__', phone_numbers: [] }] }),
            signal: AbortSignal.timeout(8000),
        });
        const txt = await r.text();
        console.log(`status=${r.status}`);
        console.log('body:', txt.slice(0, 300));
        if (r.status === 200) console.log('✅ servidor acessível e respondendo');
        else console.log('⚠️  resposta inesperada');
    } catch (err) {
        console.log('❌ falha no ping:', err.message);
    }
}

async function main() {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  Apollo pipeline diagnostic — ' + new Date().toISOString());
    console.log('═══════════════════════════════════════════════════════════');
    const webhookUrl = await section1_env();
    const rows = await section2_recent_rows();
    await section3_counts();
    await section4_pending_shape(rows);
    await section5_completed_shape(rows);
    await section6_ping_webhook(webhookUrl);
    console.log('\n✓ fim do diagnóstico');
}

main().then(() => process.exit(0)).catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
