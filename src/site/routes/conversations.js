import { Router } from 'express';
import {
    listConversations,
    getConversationById,
    updateConversation,
} from '../services/supabase.js';
import logger from '../../services/logger.js';

const router = Router();

// ─── GET /conversations ──────────────────────────────────────────────
// Filtros: status, mine, unassigned. Tudo opcional — sem filtro retorna
// tudo ordenado por last_message_at desc.
router.get('/conversations', async (req, res) => {
    try {
        const limit  = Math.min(parseInt(req.query.limit  || '50', 10), 200);
        const offset = parseInt(req.query.offset || '0', 10);
        const status = req.query.status || null;
        const mine   = req.query.mine === '1' || req.query.mine === 'true';
        const assigned_user_id = req.query.assigned_user_id || null;

        const convs = await listConversations({
            limit, offset, status, mine,
            assigned_user_id,
            currentUserId: req.user?.id,
        });
        res.json(convs);
    } catch (err) {
        logger.warn('site GET /conversations', { error: err.message });
        res.status(500).json({ error: 'Erro ao listar conversas' });
    }
});

router.get('/conversations/:id', async (req, res) => {
    try {
        const conv = await getConversationById(req.params.id);
        if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });
        res.json(conv);
    } catch (err) {
        logger.warn('site GET /conversations/:id', { error: err.message });
        res.status(500).json({ error: 'Erro ao buscar conversa' });
    }
});

// ─── PATCH /conversations/:id ────────────────────────────────────────
// Permite alterar status (waiting_human|in_progress|resolved) e
// assigned_user_id (null pra desatribuir, 'me' pra pegar pra si).
router.patch('/conversations/:id', async (req, res) => {
    try {
        const allowedStatus = ['waiting_human', 'in_progress', 'resolved'];
        const patch = {};
        if ('status' in req.body) {
            if (req.body.status && !allowedStatus.includes(req.body.status)) {
                return res.status(400).json({ error: `status inválido (use ${allowedStatus.join('|')})` });
            }
            patch.status = req.body.status;
        }
        if ('assigned_user_id' in req.body) {
            patch.assigned_user_id = req.body.assigned_user_id === 'me'
                ? req.user?.id || null
                : req.body.assigned_user_id;
        }
        if (!Object.keys(patch).length) {
            return res.status(400).json({ error: 'Nada pra atualizar' });
        }
        const updated = await updateConversation(req.params.id, patch);
        res.json(updated);
    } catch (err) {
        logger.warn('site PATCH /conversations/:id', { error: err.message });
        res.status(500).json({ error: 'Erro ao atualizar conversa' });
    }
});

export default router;
