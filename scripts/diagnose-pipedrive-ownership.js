/**
 * Diagnose: atribuição de atividades Pipedrive (READ-ONLY).
 *
 * Replica a cascata REAL usada em src/services/auto-activities.js:
 *   1. permissions.whatsapp_accounts (match único + token setado) → user
 *      atribuído
 *   2. fallback global (PIPEDRIVE_API_TOKEN)
 *
 * connected_by_user_id é mostrado como informação histórica mas NÃO entra
 * mais na resolução (admin que conecta não é dono).
 *
 * Saída redacted: só os 4 últimos chars do token (segurança).
 *
 * Uso: node scripts/diagnose-pipedrive-ownership.js [--user=<name>]
 */
import 'dotenv/config';
import supabase from '../src/services/supabase.js';

const FILTER_NAME = (() => {
    const arg = process.argv.find(a => a.startsWith('--user='));
    return arg ? arg.slice(7).toLowerCase() : null;
})();

const GLOBAL_TOKEN = process.env.PIPEDRIVE_API_TOKEN;

function suffix(token) {
    if (!token) return '(NULL)';
    if (typeof token !== 'string') return '(NÃO-STRING)';
    if (token.length < 8) return '(TOKEN_CURTO_DEMAIS)';
    return `…${token.slice(-4)} (len=${token.length})`;
}

async function pdUsersMe(token) {
    if (!token) return { error: 'sem token' };
    try {
        const res = await fetch(`https://api.pipedrive.com/v1/users/me?api_token=${token}`);
        const json = await res.json();
        if (!json?.success) {
            return { error: json?.error || `HTTP ${res.status}` };
        }
        const u = json.data || {};
        return {
            id: u.id,
            name: u.name,
            email: u.email,
            company_name: u.company_name,
        };
    } catch (err) {
        return { error: err.message };
    }
}

async function main() {
    console.log('=== Pipedrive ownership diagnose ===\n');

    // ── 1) GLOBAL TOKEN ─────────────────────────────────────────────
    console.log(`[GLOBAL] PIPEDRIVE_API_TOKEN env:`);
    console.log(`  token: ${suffix(GLOBAL_TOKEN)}`);
    if (GLOBAL_TOKEN) {
        const me = await pdUsersMe(GLOBAL_TOKEN);
        if (me.error) console.log(`  → /users/me ERROR: ${me.error}`);
        else console.log(`  → /users/me: ${me.name} (id=${me.id}) <${me.email}>`);
    }
    console.log();

    // ── 2) PLATFORM USERS ───────────────────────────────────────────
    let { data: users, error: uErr } = await supabase
        .from('platform_users')
        .select('id, name, email, role, pipedrive_api_token, pipedrive_user_id, permissions')
        .order('name');
    if (uErr) {
        console.error('Erro lendo platform_users:', uErr.message);
        process.exit(1);
    }
    if (FILTER_NAME) {
        users = users.filter(u => (u.name || '').toLowerCase().includes(FILTER_NAME));
    }

    console.log(`[platform_users] (${users.length} ${FILTER_NAME ? 'filtrado(s)' : 'total'})`);
    for (const u of users) {
        console.log(`\n  ${u.name} <${u.email}> [${u.role}]`);
        console.log(`    db.id:                ${u.id}`);
        console.log(`    pipedrive_user_id:    ${u.pipedrive_user_id || '(NULL)'}`);
        console.log(`    pipedrive_api_token:  ${suffix(u.pipedrive_api_token)}`);
        const assignedAccs = u.permissions?.whatsapp_accounts || [];
        console.log(`    permissions.whatsapp_accounts: [${assignedAccs.join(', ') || '(vazio)'}]`);

        if (u.pipedrive_api_token) {
            const me = await pdUsersMe(u.pipedrive_api_token);
            if (me.error) {
                console.log(`    → /users/me ERROR: ${me.error}`);
            } else {
                const idMatches = String(me.id) === String(u.pipedrive_user_id || '');
                console.log(`    → /users/me: ${me.name} (id=${me.id}) <${me.email}>`);
                if (u.pipedrive_user_id && !idMatches) {
                    console.log(`    ⚠️  MISMATCH: pipedrive_user_id armazenado (${u.pipedrive_user_id}) ≠ dono real do token (${me.id})`);
                }
                if ((u.email || '').toLowerCase() !== (me.email || '').toLowerCase()) {
                    console.log(`    ⚠️  EMAIL DIFERE: platform_users.email=${u.email} ≠ pipedrive.email=${me.email}`);
                }
            }
        }
    }
    console.log();

    // ── 3) WHATSAPP ACCOUNTS ────────────────────────────────────────
    const { data: accounts, error: aErr } = await supabase
        .from('whatsapp_accounts')
        .select(`
            unipile_account_id, phone_number, label, display_label, status,
            connected_by_user_id,
            platform_users:connected_by_user_id ( name, email, pipedrive_api_token )
        `);
    if (aErr) {
        console.error('Erro lendo whatsapp_accounts:', aErr.message);
        process.exit(1);
    }

    // Carrega TODOS os users pra resolver atribuição via permissions
    const { data: allUsersForResolve } = await supabase
        .from('platform_users')
        .select('id, name, email, pipedrive_api_token, permissions');

    function resolveOwner(unipileAccountId) {
        const matches = (allUsersForResolve || []).filter(u =>
            (u.permissions?.whatsapp_accounts || []).includes(unipileAccountId)
        );
        const withToken = matches.filter(u => u.pipedrive_api_token);
        if (withToken.length === 1) {
            return { source: 'permissions (match único)', user: withToken[0] };
        }
        if (withToken.length > 1) {
            return {
                source: `permissions ambíguo (${withToken.length} users) → fallback global`,
                user: null,
                ambiguous: withToken.map(u => u.name),
            };
        }
        if (matches.length > 0) {
            return {
                source: `${matches.length} user(s) atribuído(s) mas sem token → fallback global`,
                user: null,
                noToken: matches.map(u => u.name),
            };
        }
        return { source: 'sem atribuição → fallback global', user: null };
    }

    console.log(`[whatsapp_accounts] (${accounts.length} contas)`);
    for (const a of accounts) {
        const connBy = a.platform_users;
        console.log(`\n  ${a.display_label || a.label || a.phone_number} [${a.status}]`);
        console.log(`    unipile_account_id:    ${a.unipile_account_id}`);
        console.log(`    connected_by:          ${connBy?.name || '(NULL)'} ${connBy?.email ? '<' + connBy.email + '>' : ''} (informativo, não usado)`);

        const r = resolveOwner(a.unipile_account_id);
        console.log(`    resolves via:          ${r.source}`);
        if (r.ambiguous) console.log(`      └── ${r.ambiguous.join(', ')}`);
        if (r.noToken) console.log(`      └── ${r.noToken.join(', ')}`);

        if (r.user) {
            const me = await pdUsersMe(r.user.pipedrive_api_token);
            if (me.error) console.log(`    ⚠️  /users/me ERROR: ${me.error} — token quebrado, atividade vai falhar`);
            else console.log(`    → atividades dessa conta vão sair como: "${me.name}" (id=${me.id})`);
        } else {
            const me = await pdUsersMe(GLOBAL_TOKEN);
            const who = me.error ? '(token global inválido)' : `"${me.name}" (id=${me.id})`;
            console.log(`    → atividades dessa conta vão sair como: ${who}  ← GLOBAL`);
        }
    }
    console.log();
    console.log('=== Fim do diagnóstico ===');
}

main().catch(err => {
    console.error('Falha fatal:', err);
    process.exit(1);
});
