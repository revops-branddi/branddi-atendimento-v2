/**
 * Site WhatsApp Accounts — gerência das contas Unipile dedicadas ao site.
 *
 * Diferente de `/api/whatsapp/accounts` (prospecção): aqui só lista/edita
 * contas que vivem em `site.whatsapp_accounts`. Polling/ingest do site lê
 * exclusivamente desta tabela; assim, conectar uma conta nova aqui NUNCA
 * vaza pra prospecção e vice-versa.
 *
 * Restrição: todas as rotas exigem role Admin. O site é fluxo central da
 * empresa (número único), não tem por que cada user mexer.
 */
import { Router } from 'express';
import { listWhatsAppAccounts } from '../services/supabase.js';
import sb from '../services/db.js';
import * as unipile from '../services/unipile.js';
import { requireRole } from '../../middleware/auth.js';
import logger from '../../services/logger.js';

const router = Router();

// ─── GET /whatsapp-accounts ──────────────────────────────────────────
// Lista contas registradas + status atual no Unipile (best-effort).
router.get('/whatsapp-accounts', async (req, res) => {
    try {
        const accounts = await listWhatsAppAccounts();
        // Enriquecer com status live do Unipile sem quebrar se o provider
        // falhar — quem está só visualizando não pode ficar travado.
        const enriched = await Promise.all(accounts.map(async (a) => {
            let liveStatus = null;
            try {
                const live = await unipile.getAccount(a.unipile_account_id);
                const sourceStatus = Array.isArray(live?.sources) && live.sources[0]?.status;
                liveStatus = sourceStatus || live?.connection_status || live?.status || null;
            } catch { /* mantém status do DB */ }
            return { ...a, live_status: liveStatus };
        }));
        res.json(enriched);
    } catch (err) {
        logger.warn('site GET /whatsapp-accounts', { error: err.message });
        res.status(500).json({ error: 'Erro ao listar contas WhatsApp' });
    }
});

// ─── POST /whatsapp-accounts/connect ─────────────────────────────────
// Inicia conexão de uma nova conta WhatsApp pelo Unipile (devolve QR / checkpoint).
// O Unipile responde com o account_id antes do QR ser escaneado; persistimos
// status='connecting' e o painel atualiza pra 'active' quando o status live virar OK.
router.post('/whatsapp-accounts/connect', requireRole('Admin'), async (req, res) => {
    try {
        const { label = null, phone_number = null } = req.body || {};
        const result = await unipile.connectWhatsApp();
        const accountId = result?.account_id || result?.id;
        if (!accountId) {
            return res.status(500).json({ error: 'Unipile não retornou account_id', raw: result });
        }
        await sb.from('v_site_whatsapp_accounts').upsert({
            unipile_account_id:   accountId,
            phone_number:         phone_number || result?.connection_params?.im?.phone_number || null,
            label,
            status:               'connecting',
            connected_by_user_id: req.user?.id || null,
            updated_at:           new Date().toISOString(),
        }, { onConflict: 'unipile_account_id' });
        res.json(result);
    } catch (err) {
        logger.error('site POST /whatsapp-accounts/connect', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /whatsapp-accounts ─────────────────────────────────────────
// Registra manualmente uma conta Unipile já conectada (pra reaproveitar uma
// conta criada antes do schema site existir). NÃO chama o Unipile.
router.post('/whatsapp-accounts', requireRole('Admin'), async (req, res) => {
    try {
        const { unipile_account_id, phone_number = null, label = null } = req.body || {};
        if (!unipile_account_id) {
            return res.status(400).json({ error: 'unipile_account_id é obrigatório' });
        }
        const { data, error } = await sb.from('v_site_whatsapp_accounts').upsert({
            unipile_account_id,
            phone_number,
            label,
            status:               'active',
            connected_by_user_id: req.user?.id || null,
            updated_at:           new Date().toISOString(),
        }, { onConflict: 'unipile_account_id' }).select().single();
        if (error) throw error;
        res.json(data);
    } catch (err) {
        logger.warn('site POST /whatsapp-accounts', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// ─── PATCH /whatsapp-accounts/:id ────────────────────────────────────
router.patch('/whatsapp-accounts/:id', requireRole('Admin'), async (req, res) => {
    try {
        const allowed = {};
        if ('label'        in req.body) allowed.label        = req.body.label;
        if ('phone_number' in req.body) allowed.phone_number = req.body.phone_number;
        if ('status'       in req.body) allowed.status       = req.body.status;
        allowed.updated_at = new Date().toISOString();

        const { data, error } = await sb.from('v_site_whatsapp_accounts')
            .update(allowed).eq('id', req.params.id).select().single();
        if (error) throw error;
        res.json(data);
    } catch (err) {
        logger.warn('site PATCH /whatsapp-accounts/:id', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /whatsapp-accounts/connect-link ────────────────────────────
// Hosted Auth flow pra conta NOVA: gera URL temporária (1h) pra admin
// abrir no celular, escanear o QR direto na página da Unipile, e a conta
// já fica vinculada. Mais limpo do que o /connect que retorna QR raw.
router.post('/whatsapp-accounts/connect-link', requireRole('Admin'), async (req, res) => {
    try {
        const expiresOn = new Date(Date.now() + 60 * 60_000).toISOString();
        const result = await unipile.createHostedAuthLink({ type: 'create', expiresOn });
        const url = result?.url || result?.hosted_url;
        if (!url) {
            return res.status(502).json({ error: 'Unipile não retornou URL', raw: result });
        }
        logger.info('Site WA hosted connect link gerada', { user_id: req.user?.id });
        res.json({ url, expires_on: expiresOn });
    } catch (err) {
        logger.error('site connect-link error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /whatsapp-accounts/:id/reconnect-link ──────────────────────
// Hosted Auth pra religar UMA conta existente mantendo o mesmo
// unipile_account_id (e portanto conversas vinculadas, etc).
router.post('/whatsapp-accounts/:id/reconnect-link', requireRole('Admin'), async (req, res) => {
    try {
        // Resolve unipile_account_id pela PK local
        const { data: row } = await sb.from('v_site_whatsapp_accounts')
            .select('unipile_account_id').eq('id', req.params.id).maybeSingle();
        if (!row?.unipile_account_id) {
            return res.status(404).json({ error: 'Conta não encontrada' });
        }
        const expiresOn = new Date(Date.now() + 60 * 60_000).toISOString();
        const result = await unipile.createHostedAuthLink({
            type:       'reconnect',
            accountId:  row.unipile_account_id,
            expiresOn,
        });
        const url = result?.url || result?.hosted_url;
        if (!url) {
            return res.status(502).json({ error: 'Unipile não retornou URL', raw: result });
        }
        logger.info('Site WA hosted reconnect link gerada', {
            account_id: row.unipile_account_id, user_id: req.user?.id,
        });
        res.json({ url, expires_on: expiresOn, account_id: row.unipile_account_id });
    } catch (err) {
        logger.error('site reconnect-link error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// ─── DELETE /whatsapp-accounts/:id ───────────────────────────────────
// Marca como disconnected localmente E desconecta no Unipile. Não faz hard
// delete pra preservar histórico de conversas vinculadas via unipile_account_id.
router.delete('/whatsapp-accounts/:id', requireRole('Admin'), async (req, res) => {
    try {
        const { data: row } = await sb.from('v_site_whatsapp_accounts')
            .select('unipile_account_id').eq('id', req.params.id).maybeSingle();
        if (row?.unipile_account_id) {
            try { await unipile.deleteAccount(row.unipile_account_id); }
            catch (err) { logger.warn('Unipile delete failed (continuing)', { error: err.message }); }
        }
        await sb.from('v_site_whatsapp_accounts')
            .update({ status: 'disconnected', updated_at: new Date().toISOString() })
            .eq('id', req.params.id);
        res.json({ success: true });
    } catch (err) {
        logger.warn('site DELETE /whatsapp-accounts/:id', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

export default router;
