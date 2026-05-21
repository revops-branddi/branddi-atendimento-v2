/**
 * WhatsApp Account Routes — Gerencia conexao via QR Code + controle de acesso
 *
 * Regras de acesso:
 * - Admin ve e usa todas as contas
 * - Quando user conecta numero novo → fica disponivel so pra ele + Admin
 * - Admin pode autorizar outros users via permissions.whatsapp_accounts
 */
import { Router } from 'express';
import supabase from '../services/supabase.js';
import { invalidateUserCache } from '../middleware/auth.js';
import logger from '../services/logger.js';

const router = Router();

// ─── Helpers Unipile ──────────────────────────────────────────────────

function getUnipileConfig() {
    const key = process.env.UNIPILE_API_KEY;
    const dsn = process.env.UNIPILE_DSN;
    if (!key || !dsn) return null;
    return { key, base: `https://${dsn}/api/v1` };
}

async function unipileFetch(endpoint, options = {}, timeoutMs = 10000) {
    const config = getUnipileConfig();
    if (!config) throw new Error('Unipile nao configurado');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetch(`${config.base}${endpoint}`, {
            ...options,
            signal: controller.signal,
            headers: {
                'X-API-KEY': config.key,
                'Accept': 'application/json',
                ...(options.headers || {}),
            },
        });
        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Unipile (${res.status}): ${err}`);
        }
        return res.json();
    } catch (err) {
        if (err.name === 'AbortError') throw new Error(`Timeout — Unipile nao respondeu`);
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

// ─── GET /api/whatsapp/accounts — Lista contas com controle de acesso ─
router.get('/whatsapp/accounts', async (req, res) => {
    try {
        const data = await unipileFetch('/accounts', {}, 8000);
        const all = data.items || (Array.isArray(data) ? data : []);

        let accounts = all.filter(
            a => (a.type || '').toUpperCase() === 'WHATSAPP' || (a.provider || '').toUpperCase() === 'WHATSAPP'
        );

        // Sync com tabela local whatsapp_accounts
        for (const acc of accounts) {
            await syncAccountToLocal(acc);
        }

        // Busca registros locais para enriquecer com connected_by info
        const { data: localAccounts } = await supabase
            .from('whatsapp_accounts')
            .select('unipile_account_id, phone_number, label, display_label, connected_by_user_id, status, excluded_from_metrics, account_type, platform_users:connected_by_user_id(name)');

        const localMap = {};
        for (const la of (localAccounts || [])) {
            localMap[la.unipile_account_id] = la;
        }

        // Filtra por permissao
        const user = req.user || {};
        const isAdmin = user.role === 'Admin';
        const permissions = user.permissions || {};
        const allowedIds = permissions.whatsapp_accounts || [];

        const enriched = accounts.map(a => {
            const local = localMap[a.id] || {};
            // Unipile retorna o status detalhado em sources[].status ("OK" quando conectado).
            // Os campos top-level connection_status/status vêm vazios no endpoint /accounts.
            const sourceStatus = Array.isArray(a.sources) && a.sources.length > 0
                ? a.sources[0].status
                : null;
            // display_name na ordem de preferência:
            //   display_label (SDR IA: "Ricardo", "Gio")
            //   nome do dono (connected_by_user_id) — primeiro nome
            //   nada → cai no número como fallback no front
            const ownerFullName = local.platform_users?.name || null;
            const ownerFirstName = ownerFullName ? ownerFullName.split(/\s+/)[0] : null;
            const displayName = local.display_label || ownerFirstName || null;

            return {
                id: a.id,
                phone_number: a.connection_params?.im?.phone_number || local.phone_number || null,
                name: a.name || local.label || null,
                display_name: displayName,
                display_label: local.display_label || null,
                status: a.connection_status || a.status || sourceStatus || local.status || 'unknown',
                connected_by_user_id: local.connected_by_user_id || null,
                connected_by_name: ownerFullName || null,
                is_mine: local.connected_by_user_id === user.id,
                excluded_from_metrics: !!local.excluded_from_metrics,
                account_type: local.account_type || 'personal',
            };
        });

        // Admin ve tudo. User ve: suas proprias + autorizadas via permissions
        let filtered = enriched;
        if (!isAdmin) {
            filtered = enriched.filter(a =>
                a.is_mine || allowedIds.includes(a.id)
            );
        }

        res.json({ accounts: filtered });
    } catch (err) {
        logger.warn('WA accounts error', { error: err.message });
        res.json({ accounts: [], error: err.message });
    }
});

// ─── GET /api/whatsapp/sendable-by-me — Contas que o user logado pode usar pra ENVIAR
//
// Usado pelo picker de "iniciar conversa" quando o user tem múltiplas contas
// atribuídas (caso clássico: Harylanne operando Giovanna + Ricardo).
//
// Lê de cache local (whatsapp_accounts) em vez do Unipile pra ser rápido —
// não precisa do estado live, só de quem está conectada e disponível pra envio.
//
// Filtros:
//   - permissions.whatsapp_accounts do user (Admin vê tudo)
//   - status = 'OK' (CREDENTIALS/STOPPED/disconnected escondidas — não envia)
//   - ignored != true (contas marcadas como ignoradas estão fora)
router.get('/whatsapp/sendable-by-me', async (req, res) => {
    try {
        const isAdmin = req.user?.role === 'Admin';
        const allowed = req.user?.permissions?.whatsapp_accounts || [];

        if (!isAdmin && allowed.length === 0) {
            return res.json({ accounts: [] });
        }

        let query = supabase
            .from('whatsapp_accounts')
            .select('unipile_account_id, phone_number, display_label, status')
            .eq('status', 'OK')
            .neq('ignored', true)
            .order('display_label', { ascending: true });

        if (!isAdmin) {
            query = query.in('unipile_account_id', allowed);
        }

        const { data, error } = await query;
        if (error) throw error;

        res.json({ accounts: data || [] });
    } catch (err) {
        logger.warn('sendable-by-me error', { error: err.message });
        res.status(500).json({ accounts: [], error: err.message });
    }
});

// ─── POST /api/whatsapp/connect — Conecta novo numero (QR Code) ──────
// LEGADO: POST /accounts não retorna mais o QR inline na resposta — Unipile
// migrou pra Hosted Auth. Mantido aqui só por compat com scripts antigos;
// o frontend agora usa /whatsapp/connect-link abaixo.
router.post('/whatsapp/connect', async (req, res) => {
    try {
        const result = await unipileFetch('/accounts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: 'WHATSAPP' }),
        }, 35000);

        // Se a conta foi criada, registra localmente vinculada ao user
        const accountId = result?.account_id || result?.id;
        if (accountId) {
            await supabase.from('whatsapp_accounts').upsert({
                unipile_account_id: accountId,
                connected_by_user_id: req.user?.id || null,
                phone_number: result?.connection_params?.im?.phone_number || null,
                label: req.user?.name ? `${req.user.name}` : null,
                status: 'connecting',
                updated_at: new Date().toISOString(),
            }, { onConflict: 'unipile_account_id' });

            // Auto-adiciona nas permissoes do user que conectou
            if (req.user?.id) {
                await addAccountToUserPermissions(req.user.id, accountId);
            }
        }

        res.json(result);
    } catch (err) {
        logger.error('WA connect error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/whatsapp/connect-link ─────────────────────────────────
// Hosted Auth pra conectar NÚMERO NOVO. Devolve URL temporária (1h) da
// Unipile, que o atendente abre no celular → escaneia QR direto na página
// deles. Substitui o fluxo legado de QR inline (POST /accounts não retorna
// mais qr_code no body).
//
// Quando o user escaneia, Unipile cria a conta e dispara webhook
// `account.created` (já tratado em src/routes/webhooks.js). O webhook
// vincula a conta ao user via connected_by_user_id (via `name` no payload).
router.post('/whatsapp/connect-link', async (req, res) => {
    try {
        const config = getUnipileConfig();
        if (!config) return res.status(500).json({ error: 'Unipile não configurado' });

        const expiresOn = new Date(Date.now() + 60 * 60_000).toISOString();
        const result = await unipileFetch('/hosted/accounts/link', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type:      'create',
                providers: ['WHATSAPP'],
                api_url:   config.base.replace('/api/v1', ''),
                expiresOn,
                // `name` é eco-back no webhook → usamos pra vincular a conta
                // ao user que iniciou o flow, sem depender de cookie/sessão
                // na página da Unipile.
                name: req.user?.id ? `user:${req.user.id}` : 'unknown',
            }),
        }, 10000);

        const url = result?.url || result?.hosted_url;
        if (!url) {
            logger.warn('Hosted create sem URL', { result });
            return res.status(502).json({ error: 'Unipile não retornou URL', raw: result });
        }

        logger.info('Hosted create URL gerada', { user_id: req.user?.id });
        res.json({ url, expires_on: expiresOn });
    } catch (err) {
        logger.error('connect-link error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/whatsapp/accounts/:id/reconnect-link ──────────────────
// Gera URL temporária da Unipile pra religar UMA conta existente
// MANTENDO o mesmo unipile_account_id (e portanto suas permissões,
// conversas vinculadas, etc). Atendente abre essa URL no celular,
// scaneia QR direto na página da Unipile, sessão volta.
//
// Permissão: Admin OU user tem essa conta em permissions.whatsapp_accounts.
router.post('/whatsapp/accounts/:id/reconnect-link', async (req, res) => {
    try {
        const accountId = req.params.id;
        const user = req.user || {};
        const isAdmin = user.role === 'Admin';
        const allowed = (user.permissions?.whatsapp_accounts || []).includes(accountId);
        if (!isAdmin && !allowed) {
            return res.status(403).json({ error: 'Sem permissão pra essa conta WhatsApp' });
        }

        const config = getUnipileConfig();
        if (!config) return res.status(500).json({ error: 'Unipile não configurado' });

        // Hosted Auth flow — gera URL temporária (validade padrão 1h).
        // Documentado em Unipile: type='reconnect' + reconnect_account=:id
        // mantém account_id existente em vez de criar nova conta.
        const expiresOn = new Date(Date.now() + 60 * 60_000).toISOString();
        const result = await unipileFetch('/hosted/accounts/link', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'reconnect',
                reconnect_account: accountId,
                api_url: config.base.replace('/api/v1', ''),
                expiresOn,
            }),
        }, 10000);

        const url = result?.url || result?.hosted_url;
        if (!url) {
            logger.warn('Hosted reconnect sem URL', { accountId, result });
            return res.status(502).json({ error: 'Unipile não retornou URL', raw: result });
        }

        logger.info('Hosted reconnect URL gerada', {
            account_id: accountId,
            user_id: user.id,
        });
        res.json({ url, expires_on: expiresOn, account_id: accountId });
    } catch (err) {
        logger.error('reconnect-link error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/whatsapp/accounts/:id/restart-session ─────────────────
// Tenta restart sem QR. Em ~30% dos casos (sessão revalidada), volta
// imediatamente. Quando falha (AccountFailedToRestart), cliente cai
// no fluxo de QR scan (reconnect-link).
router.post('/whatsapp/accounts/:id/restart-session', async (req, res) => {
    try {
        const accountId = req.params.id;
        const user = req.user || {};
        const isAdmin = user.role === 'Admin';
        const allowed = (user.permissions?.whatsapp_accounts || []).includes(accountId);
        if (!isAdmin && !allowed) {
            return res.status(403).json({ error: 'Sem permissão pra essa conta WhatsApp' });
        }

        const config = getUnipileConfig();
        if (!config) return res.status(500).json({ error: 'Unipile não configurado' });

        // Unipile responde { object: 'AccountFailedToRestart' } em status 200
        // quando sessão tá morta de vez (precisa QR scan).
        const result = await unipileFetch(`/accounts/${accountId}/restart`, {
            method: 'POST',
        }, 10000);

        const isOk = result?.object && result.object !== 'AccountFailedToRestart';
        logger.info('Restart session', {
            account_id: accountId,
            user_id: user.id,
            result_object: result?.object,
            ok: isOk,
        });

        res.json({
            success: isOk,
            requires_qr: !isOk,
            raw: result,
        });
    } catch (err) {
        logger.error('restart-session error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/whatsapp/accounts/my-status ────────────────────────────
// Resumo enxuto pra topbar: contas do user logado + status.
// Frontend usa pra mostrar badge "⚠️ N caída(s)" sem round-trip Unipile.
router.get('/whatsapp/accounts/my-status', async (req, res) => {
    try {
        const user = req.user || {};
        const isAdmin = user.role === 'Admin';
        const myIds = user.permissions?.whatsapp_accounts || [];

        let query = supabase
            .from('whatsapp_accounts')
            .select('unipile_account_id, display_label, phone_number, status, updated_at');
        if (!isAdmin) {
            if (myIds.length === 0) return res.json({ accounts: [], down_count: 0 });
            query = query.in('unipile_account_id', myIds);
        } else if (myIds.length > 0) {
            // Admin com contas atribuídas: foca nas dele (que ele opera)
            query = query.in('unipile_account_id', myIds);
        }
        // Admin sem permissions: vê todas

        const { data, error } = await query;
        if (error) throw error;

        const isOk = s => /^(ok|connected|running|ok_for_now)$/i.test(s || '');
        const accounts = (data || []).map(a => ({
            id: a.unipile_account_id,
            label: a.display_label || a.phone_number || 'Conta',
            status: a.status,
            ok: isOk(a.status),
        }));
        const down_count = accounts.filter(a => !a.ok).length;

        res.json({ accounts, down_count });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── PATCH /api/whatsapp/accounts/:id — Config completa (Admin only) ──
// Atualiza qualquer combinação de:
//   - display_label      : rótulo amigável (string ou null)
//   - connected_by_user_id : UUID do dono (null pra desvincular)
//   - account_type       : 'personal' | 'virtual'
//   - excluded_from_metrics : boolean
//   - allowed_user_ids   : array de UUIDs — sincroniza
//                          platform_users.permissions.whatsapp_accounts.
//                          Quando presente, vira a fonte de verdade:
//                          users fora do array perdem acesso; users
//                          dentro recebem. O dono (connected_by_user_id)
//                          é sempre garantido na lista, mesmo se omitido.
//
// Edição parcial — só sincroniza permissions se `allowed_user_ids` vier
// no body. Outros campos seguem o mesmo princípio: ausente = não mexe.
//
// Trade-off: sem transação cross-tabela. Update do whatsapp_accounts vai
// antes; se sync de permissions falhar pra algum user, isso é logado mas
// não desfaz o resto. Considerado aceitável porque o estado parcial é
// recuperável (admin re-salva).
router.patch('/whatsapp/accounts/:id', async (req, res) => {
    try {
        if (req.user?.role !== 'Admin') {
            return res.status(403).json({ error: 'Apenas Admin pode configurar contas' });
        }

        const accountId = req.params.id;
        const body = req.body || {};
        const updates = {};

        // ── Validações ────────────────────────────────────────────────
        if ('display_label' in body) {
            const raw = body.display_label;
            updates.display_label = raw == null || String(raw).trim() === ''
                ? null
                : String(raw).trim().slice(0, 80);
        }

        if ('account_type' in body) {
            if (!['personal', 'virtual'].includes(body.account_type)) {
                return res.status(400).json({ error: "account_type deve ser 'personal' ou 'virtual'" });
            }
            updates.account_type = body.account_type;
        }

        if ('excluded_from_metrics' in body) {
            updates.excluded_from_metrics = !!body.excluded_from_metrics;
        }

        if ('connected_by_user_id' in body) {
            const ownerId = body.connected_by_user_id || null;
            if (ownerId) {
                // Confere se o user existe e está ativo
                const { data: ownerUser, error: ownerErr } = await supabase
                    .from('platform_users')
                    .select('id, active')
                    .eq('id', ownerId)
                    .maybeSingle();
                if (ownerErr) throw ownerErr;
                if (!ownerUser) return res.status(400).json({ error: 'connected_by_user_id não encontrado' });
                if (!ownerUser.active) return res.status(400).json({ error: 'Não dá pra atribuir conta a usuário inativo' });
            }
            updates.connected_by_user_id = ownerId;
        }

        // Regra de negócio: virtual exige display_label
        if (updates.account_type === 'virtual') {
            // Precisa ter display_label setado nesse update OU já existir no banco
            if ('display_label' in updates && !updates.display_label) {
                return res.status(400).json({ error: 'Contas virtuais exigem display_label' });
            }
            if (!('display_label' in updates)) {
                const { data: existing } = await supabase
                    .from('whatsapp_accounts')
                    .select('display_label')
                    .eq('unipile_account_id', accountId)
                    .maybeSingle();
                if (!existing?.display_label) {
                    return res.status(400).json({ error: 'Contas virtuais exigem display_label' });
                }
            }
        }

        // ── Update da tabela whatsapp_accounts ────────────────────────
        let updatedAccount = null;
        if (Object.keys(updates).length > 0) {
            updates.updated_at = new Date().toISOString();
            const { data, error } = await supabase
                .from('whatsapp_accounts')
                .update(updates)
                .eq('unipile_account_id', accountId)
                .select('unipile_account_id, phone_number, display_label, account_type, connected_by_user_id, excluded_from_metrics, status')
                .maybeSingle();
            if (error) throw error;
            if (!data) return res.status(404).json({ error: 'Conta não encontrada localmente' });
            updatedAccount = data;
        }

        // ── Sync permissions (apenas se allowed_user_ids veio no body) ─
        const permSync = { added: [], removed: [], errors: [] };
        if (Array.isArray(body.allowed_user_ids)) {
            // Garante que o dono está sempre no rol
            const ownerId = updatedAccount?.connected_by_user_id
                ?? (await supabase.from('whatsapp_accounts')
                    .select('connected_by_user_id').eq('unipile_account_id', accountId).maybeSingle()
                ).data?.connected_by_user_id;
            const targetSet = new Set(body.allowed_user_ids.filter(Boolean));
            if (ownerId) targetSet.add(ownerId);

            // Quem tem essa conta hoje
            const { data: currentUsers, error: currErr } = await supabase
                .from('platform_users')
                .select('id, permissions')
                .filter('permissions->whatsapp_accounts', 'cs', JSON.stringify([accountId]));
            if (currErr) throw currErr;
            const currentIds = new Set((currentUsers || []).map(u => u.id));

            const toAdd = [...targetSet].filter(id => !currentIds.has(id));
            const toRemove = [...currentIds].filter(id => !targetSet.has(id));

            // Aplica adições — fetch atual + push + update
            for (const uid of toAdd) {
                try {
                    const { data: u } = await supabase.from('platform_users')
                        .select('permissions').eq('id', uid).maybeSingle();
                    const perms = u?.permissions || {};
                    const list = perms.whatsapp_accounts || [];
                    if (!list.includes(accountId)) list.push(accountId);
                    perms.whatsapp_accounts = list;
                    await supabase.from('platform_users')
                        .update({ permissions: perms, updated_at: new Date().toISOString() })
                        .eq('id', uid);
                    invalidateUserCache(uid);
                    permSync.added.push(uid);
                } catch (err) {
                    permSync.errors.push({ user_id: uid, op: 'add', error: err.message });
                }
            }

            // Aplica remoções
            for (const uid of toRemove) {
                try {
                    const user = (currentUsers || []).find(u => u.id === uid);
                    const perms = user?.permissions || {};
                    perms.whatsapp_accounts = (perms.whatsapp_accounts || []).filter(id => id !== accountId);
                    await supabase.from('platform_users')
                        .update({ permissions: perms, updated_at: new Date().toISOString() })
                        .eq('id', uid);
                    invalidateUserCache(uid);
                    permSync.removed.push(uid);
                } catch (err) {
                    permSync.errors.push({ user_id: uid, op: 'remove', error: err.message });
                }
            }
        }

        logger.info('WA account config atualizado', {
            account_id: accountId,
            admin_user_id: req.user?.id,
            fields_changed: Object.keys(updates),
            perm_added: permSync.added.length,
            perm_removed: permSync.removed.length,
            perm_errors: permSync.errors.length,
        });

        // Retorna estado final (re-fetch se update teve nada)
        if (!updatedAccount) {
            const { data } = await supabase.from('whatsapp_accounts')
                .select('unipile_account_id, phone_number, display_label, account_type, connected_by_user_id, excluded_from_metrics, status')
                .eq('unipile_account_id', accountId).maybeSingle();
            updatedAccount = data;
        }

        res.json({
            success: true,
            account: updatedAccount,
            permissions_sync: permSync,
        });
    } catch (err) {
        logger.error('PATCH account config error', { error: err.message, account_id: req.params.id });
        res.status(500).json({ error: err.message });
    }
});

// ─── PATCH /api/whatsapp/accounts/:id/label — LEGACY ─────────────────
// Mantido por retrocompat (frontend antigo). Novo código deve usar o
// PATCH /:id acima, que cobre todos os campos. TODO: migrar callers
// e remover esta rota.
router.patch('/whatsapp/accounts/:id/label', async (req, res) => {
    try {
        if (req.user?.role !== 'Admin') {
            return res.status(403).json({ error: 'Apenas Admin pode editar labels' });
        }
        const raw = req.body?.display_label;
        const display_label = raw == null || String(raw).trim() === ''
            ? null
            : String(raw).trim().slice(0, 80);

        const { data, error } = await supabase
            .from('whatsapp_accounts')
            .update({ display_label, updated_at: new Date().toISOString() })
            .eq('unipile_account_id', req.params.id)
            .select('unipile_account_id, display_label')
            .maybeSingle();

        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Conta não encontrada localmente' });

        logger.info('Display label atualizado', {
            account_id: req.params.id,
            new_label: display_label,
            user_id: req.user?.id,
        });
        res.json({ success: true, ...data });
    } catch (err) {
        logger.error('label patch error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// ─── DELETE /api/whatsapp/accounts/:id — Desconecta conta ────────────
router.delete('/whatsapp/accounts/:id', async (req, res) => {
    try {
        await unipileFetch(`/accounts/${req.params.id}`, { method: 'DELETE' }, 8000);

        // Atualiza registro local
        await supabase
            .from('whatsapp_accounts')
            .update({ status: 'disconnected', updated_at: new Date().toISOString() })
            .eq('unipile_account_id', req.params.id);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Helpers ──────────────────────────────────────────────────────────

async function syncAccountToLocal(acc) {
    try {
        const phone = acc.connection_params?.im?.phone_number || null;
        const sourceStatus = Array.isArray(acc.sources) && acc.sources.length > 0
            ? acc.sources[0].status
            : null;
        await supabase.from('whatsapp_accounts').upsert({
            unipile_account_id: acc.id,
            phone_number: phone,
            status: acc.connection_status || acc.status || sourceStatus || 'unknown',
            updated_at: new Date().toISOString(),
        }, { onConflict: 'unipile_account_id', ignoreDuplicates: false });
    } catch { /* sync nao critico */ }
}

async function addAccountToUserPermissions(userId, accountId) {
    try {
        const { data: user } = await supabase
            .from('platform_users')
            .select('permissions')
            .eq('id', userId)
            .single();

        const perms = user?.permissions || {};
        const waAccounts = perms.whatsapp_accounts || [];
        if (!waAccounts.includes(accountId)) {
            waAccounts.push(accountId);
            perms.whatsapp_accounts = waAccounts;
            await supabase
                .from('platform_users')
                .update({ permissions: perms, updated_at: new Date().toISOString() })
                .eq('id', userId);
            // Cache do middleware precisa cair fora pra a nova permissão valer já
            invalidateUserCache(userId);
        }
    } catch { /* nao critico */ }
}

export default router;
