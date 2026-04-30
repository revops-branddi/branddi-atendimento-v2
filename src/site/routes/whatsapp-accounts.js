import { Router } from 'express';
import { listWhatsAppAccounts } from '../services/supabase.js';
import logger from '../../services/logger.js';

const router = Router();

router.get('/whatsapp-accounts', async (req, res) => {
    try {
        const accounts = await listWhatsAppAccounts();
        res.json(accounts);
    } catch (err) {
        logger.warn('site GET /whatsapp-accounts', { error: err.message });
        res.status(500).json({ error: 'Erro ao listar contas WhatsApp' });
    }
});

export default router;
