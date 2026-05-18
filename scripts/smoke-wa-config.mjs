// Smoke test do PATCH /api/whatsapp/accounts/:id
//
// Tipo: script ad-hoc (não é suite de teste — projeto não tem framework).
// Forja JWT de Admin (mesmo caminho do /auth/login → signToken).
// Não-destrutivo: snapshot do estado pré → roda asserções → restaura.
//
// Pré-requisitos:
//   - server rodando local (default http://localhost:3838, override via TEST_BASE)
//   - .env com JWT_SECRET preenchido
//   - conta WA "Juliana" (rfJoPr25T9SwHnxohsxEPA) existir no DB; se
//     deletada/migrada, ajuste TARGET_ACCOUNT + JULIANA_ID + ADMIN.id
//     antes de rodar.
//
// Como rodar:
//   node scripts/smoke-wa-config.mjs
//
// Quando re-rodar: depois de mexer em src/routes/whatsapp-accounts.js
// (especialmente PATCH /:id), ou alterar política de sync de permissions.
//
// TODO (refactor futuro quando outro dev precisar): parametrizar IDs via
// argv ou env (--account=<id> --admin=<id>) pra não depender de Juliana
// específica continuar no banco.
import 'dotenv/config';
import jwt from 'jsonwebtoken';

const BASE = process.env.TEST_BASE || 'http://localhost:3838';
const ADMIN = {
    id: '39017dda-15bb-4de7-bfa1-8fd3faab5a95',
    email: 'sergio.munoz@branddi.com',
    name: 'Sergio Munoz',
    role: 'Admin',
    permissions: {},
};
const TARGET_ACCOUNT = 'rfJoPr25T9SwHnxohsxEPA'; // Juliana
const JULIANA_ID = '1f8832b5-bde3-4677-b198-a695a601bcbf';

const token = jwt.sign(ADMIN, process.env.JWT_SECRET, { expiresIn: '5m' });

async function req(method, path, body) {
    const r = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'Cookie': `auth_token=${token}`,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { _raw: text }; }
    return { status: r.status, body: json };
}

function eq(label, a, b) {
    const ok = JSON.stringify(a) === JSON.stringify(b);
    console.log(`${ok ? '✅' : '❌'} ${label}: ${ok ? 'OK' : `got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`}`);
    return ok;
}

(async () => {
    console.log('\n━━━ Smoke test: PATCH /api/whatsapp/accounts/:id ━━━\n');

    // ── Snapshot pré
    const pre = await req('GET', '/api/whatsapp/accounts');
    if (pre.status !== 200) {
        console.error('❌ GET /accounts falhou:', pre.status, pre.body);
        process.exit(1);
    }
    const preAccount = pre.body.accounts.find(a => a.id === TARGET_ACCOUNT);
    console.log('Estado pré:', {
        type: preAccount.account_type,
        label: preAccount.display_label,
        owner: preAccount.connected_by_user_id,
        excluded: preAccount.excluded_from_metrics,
    });

    const preUsers = await req('GET', '/api/users');
    const preOps = (preUsers.body.users || [])
        .filter(u => (u.permissions?.whatsapp_accounts || []).includes(TARGET_ACCOUNT))
        .map(u => u.id);
    console.log('Operadores pré:', preOps);

    // ── Teste 1: validação rejeita account_type inválido
    console.log('\n— Teste 1: account_type inválido —');
    const t1 = await req('PATCH', `/api/whatsapp/accounts/${TARGET_ACCOUNT}`, { account_type: 'xpto' });
    eq('Status 400', t1.status, 400);
    eq('Mensagem', !!t1.body.error?.includes('account_type'), true);

    // ── Teste 2: validação rejeita owner inexistente
    console.log('\n— Teste 2: owner inexistente —');
    const t2 = await req('PATCH', `/api/whatsapp/accounts/${TARGET_ACCOUNT}`, { connected_by_user_id: '00000000-0000-0000-0000-000000000000' });
    eq('Status 400', t2.status, 400);
    eq('Mensagem', !!t2.body.error?.includes('connected_by_user_id'), true);

    // ── Teste 3: virtual sem label rejeitada
    console.log('\n— Teste 3: virtual sem label —');
    const t3 = await req('PATCH', `/api/whatsapp/accounts/${TARGET_ACCOUNT}`, {
        account_type: 'virtual',
        display_label: null,
    });
    eq('Status 400', t3.status, 400);

    // ── Teste 4: update válido (display_label) sem mudar permissions
    console.log('\n— Teste 4: update label apenas —');
    const t4 = await req('PATCH', `/api/whatsapp/accounts/${TARGET_ACCOUNT}`, {
        display_label: 'Juliana Test',
    });
    eq('Status 200', t4.status, 200);
    eq('Label retornado', t4.body.account?.display_label, 'Juliana Test');
    eq('Permissions sync vazio', t4.body.permissions_sync?.added.length + t4.body.permissions_sync?.removed.length, 0);

    // ── Teste 5: adiciona Sergio (admin) como operador
    console.log('\n— Teste 5: adiciona operador —');
    const t5 = await req('PATCH', `/api/whatsapp/accounts/${TARGET_ACCOUNT}`, {
        allowed_user_ids: [JULIANA_ID, ADMIN.id],
    });
    eq('Status 200', t5.status, 200);
    eq('Sergio adicionado', t5.body.permissions_sync.added.includes(ADMIN.id), true);

    // ── Teste 6: remove Sergio (volta ao estado original)
    console.log('\n— Teste 6: remove operador —');
    const t6 = await req('PATCH', `/api/whatsapp/accounts/${TARGET_ACCOUNT}`, {
        allowed_user_ids: preOps,
    });
    eq('Status 200', t6.status, 200);
    eq('Sergio removido', t6.body.permissions_sync.removed.includes(ADMIN.id), true);

    // ── Teste 7: restaura label original
    console.log('\n— Teste 7: restaura label original —');
    const t7 = await req('PATCH', `/api/whatsapp/accounts/${TARGET_ACCOUNT}`, {
        display_label: preAccount.display_label,
    });
    eq('Status 200', t7.status, 200);
    eq('Label original', t7.body.account?.display_label, preAccount.display_label);

    // ── Verifica estado final = estado inicial
    const post = await req('GET', '/api/whatsapp/accounts');
    const postAccount = post.body.accounts.find(a => a.id === TARGET_ACCOUNT);
    const postUsers = await req('GET', '/api/users');
    const postOps = (postUsers.body.users || [])
        .filter(u => (u.permissions?.whatsapp_accounts || []).includes(TARGET_ACCOUNT))
        .map(u => u.id);

    console.log('\n━━━ Reconciliação ━━━');
    eq('Label final', postAccount.display_label, preAccount.display_label);
    eq('Owner final', postAccount.connected_by_user_id, preAccount.connected_by_user_id);
    eq('Type final', postAccount.account_type, preAccount.account_type);
    eq('Excluded final', postAccount.excluded_from_metrics, preAccount.excluded_from_metrics);
    eq('Operadores finais', postOps.sort(), preOps.sort());

    console.log('\n✅ Done.\n');
})().catch(err => {
    console.error('FATAL:', err.message);
    process.exit(1);
});
