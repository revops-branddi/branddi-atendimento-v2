import { Router } from 'express';
import { listLeads, getLeadById } from '../services/supabase.js';
import logger from '../../services/logger.js';

const router = Router();

router.get('/leads', async (req, res) => {
    try {
        const limit  = Math.min(parseInt(req.query.limit  || '50', 10), 200);
        const offset = parseInt(req.query.offset || '0', 10);
        const leads  = await listLeads({ limit, offset });
        res.json(leads);
    } catch (err) {
        logger.warn('site GET /leads', { error: err.message });
        res.status(500).json({ error: 'Erro ao listar leads' });
    }
});

router.get('/leads/:id', async (req, res) => {
    try {
        const lead = await getLeadById(req.params.id);
        if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
        res.json(lead);
    } catch (err) {
        logger.warn('site GET /leads/:id', { error: err.message });
        res.status(500).json({ error: 'Erro ao buscar lead' });
    }
});

export default router;
