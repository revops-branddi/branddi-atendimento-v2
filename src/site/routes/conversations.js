import { Router } from 'express';
import { listConversations, getConversationById } from '../services/supabase.js';
import logger from '../../services/logger.js';

const router = Router();

router.get('/conversations', async (req, res) => {
    try {
        const limit  = Math.min(parseInt(req.query.limit  || '50', 10), 200);
        const offset = parseInt(req.query.offset || '0', 10);
        const status = req.query.status || null;
        const convs  = await listConversations({ limit, offset, status });
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

export default router;
