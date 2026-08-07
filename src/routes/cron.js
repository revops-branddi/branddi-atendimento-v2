/**
 * Endpoints chamados pela Vercel Cron. Cada um roda UM ciclo e retorna.
 * Nada de setInterval aqui — serverless nao mantem processo vivo.
 */
import { Router } from 'express';
import { runReconciler } from '../services/reconciler.js';
import { runCrmSyncOnce } from '../services/crm-sync.js';
import logger from '../services/logger.js';

const router = Router();

/**
 * Falha fechado: sem secret configurado, ninguem entra.
 *
 * Deliberadamente diferente de /api/webhooks/unipile, que aceita qualquer
 * requisicao quando UNIPILE_WEBHOOK_SECRET nao esta setado. Num endpoint que
 * dispara trabalho contra o Unipile e o Pipedrive, "sem secret = liberado"
 * transforma um erro de configuracao em endpoint publico.
 */
export function isAuthorizedCron(authHeader, secret) {
    if (!secret) return false;
    if (!authHeader) return false;
    return authHeader === `Bearer ${secret}`;
}

function guard(req, res, next) {
    if (!isAuthorizedCron(req.headers.authorization, process.env.CRON_SECRET)) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    next();
}

router.get('/cron/reconcile', guard, async (req, res) => {
    try {
        const r = await runReconciler({});
        logger.info('cron reconcile', r);
        res.json({ ok: true, ...r });
    } catch (err) {
        logger.error('cron reconcile falhou', { error: err.message });
        res.status(500).json({ ok: false, error: err.message });
    }
});

router.get('/cron/crm-sync', guard, async (req, res) => {
    try {
        const r = await runCrmSyncOnce();
        logger.info('cron crm-sync', r);
        res.json({ ok: true, ...r });
    } catch (err) {
        logger.error('cron crm-sync falhou', { error: err.message });
        res.status(500).json({ ok: false, error: err.message });
    }
});

export default router;
