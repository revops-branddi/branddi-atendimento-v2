import { Router } from 'express';
import { getMessages } from '../services/supabase.js';
import logger from '../../services/logger.js';

const router = Router();

router.get('/messages/:conversationId', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
        const msgs  = await getMessages(req.params.conversationId, { limit });
        res.json(msgs);
    } catch (err) {
        logger.warn('site GET /messages/:conversationId', { error: err.message });
        res.status(500).json({ error: 'Erro ao buscar mensagens' });
    }
});

export default router;
