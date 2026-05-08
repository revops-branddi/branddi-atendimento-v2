/**
 * One-shot: registra webhooks Unipile apontando pro nosso Atendimento-v2.
 *
 * Pré-requisitos (env Railway):
 *   - UNIPILE_API_KEY, UNIPILE_DSN (já configurados)
 *   - PUBLIC_URL (ex: https://atendimento-v2.up.railway.app) — o backend
 *     precisa estar acessível publicamente
 *   - UNIPILE_WEBHOOK_SECRET (string aleatória) — autentica o callback
 *
 * Uso:
 *   node scripts/register-unipile-webhooks.js [--dry-run]
 *
 * Idempotente:
 *   - Se já há webhook nosso registrado, NÃO duplica (deleta o velho antes)
 *   - NÃO mexe em webhooks de outros projetos (filtra por request_url)
 */
import 'dotenv/config';

const KEY = process.env.UNIPILE_API_KEY;
const DSN = process.env.UNIPILE_DSN;
const BASE = DSN ? `https://${DSN}/api/v1` : null;
const PUBLIC_URL = process.env.PUBLIC_URL
    || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);
const SECRET = process.env.UNIPILE_WEBHOOK_SECRET;
const DRY = process.argv.includes('--dry-run');

if (!KEY || !DSN) { console.error('Falta UNIPILE_API_KEY/UNIPILE_DSN'); process.exit(1); }
if (!PUBLIC_URL) { console.error('Falta PUBLIC_URL'); process.exit(1); }
if (!SECRET) {
    console.error('Falta UNIPILE_WEBHOOK_SECRET — gera um e seta no env. Ex: openssl rand -hex 32');
    process.exit(1);
}

const TARGET_URL = `${PUBLIC_URL}/api/webhooks/unipile`;

async function unipile(path, init = {}) {
    const res = await fetch(BASE + path, {
        ...init,
        headers: {
            'X-API-KEY': KEY,
            'Content-Type': 'application/json',
            ...(init.headers || {}),
        },
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    if (!res.ok) throw new Error(`Unipile ${res.status}: ${JSON.stringify(json)}`);
    return json;
}

async function main() {
    console.log('Target webhook URL:', TARGET_URL);
    const list = await unipile('/webhooks');
    const existing = (list.items || []).filter(w => w.request_url === TARGET_URL);

    if (existing.length > 0) {
        console.log(`\n${existing.length} webhook(s) nosso(s) já registrado(s) — vou recriar pra garantir consistência:`);
        for (const w of existing) {
            console.log(`  · DELETE id=${w.id} source=${w.source}`);
            if (!DRY) await unipile(`/webhooks/${w.id}`, { method: 'DELETE' });
        }
    }

    // 2 sources que importam:
    //   - messaging: eventos de mensagem (pra auto-ingest sem polling pesado)
    //   - users: eventos de account/status (pra detectar queda em real-time)
    const newWebhooks = [
        {
            name:        'Atendimento-v2 - Status (users)',
            source:      'users',
            request_url: TARGET_URL,
            headers:     [{ key: 'x-webhook-secret', value: SECRET }],
            format:      'json',
            enabled:     true,
        },
        {
            name:        'Atendimento-v2 - Messaging',
            source:      'messaging',
            request_url: TARGET_URL,
            headers:     [{ key: 'x-webhook-secret', value: SECRET }],
            format:      'json',
            enabled:     true,
        },
    ];

    console.log(`\nRegistrando ${newWebhooks.length} webhook(s):`);
    for (const w of newWebhooks) {
        console.log(`  · CREATE source=${w.source}`);
        if (!DRY) {
            const created = await unipile('/webhooks', {
                method: 'POST',
                body: JSON.stringify(w),
            });
            console.log(`    → id=${created?.id || created?.webhook_id || '(?)'}`);
        }
    }

    console.log(DRY ? '\n--- dry-run, nada feito ---' : '\n✓ Concluído');
}

main().catch(err => { console.error('Falha:', err.message); process.exit(1); });
