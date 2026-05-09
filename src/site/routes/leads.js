import { Router } from 'express';
import { listLeads, getLeadById, updateLead } from '../services/supabase.js';
import logger from '../../services/logger.js';

const router = Router();

// Campos que o atendente pode editar pelo lead panel. crm_*, classification,
// opec_category são derivados (do bot ou dos endpoints route-*) — não dá pra
// patchar daqui pra evitar atendente acidentalmente quebrar a relação CRM.
const EDITABLE_FIELDS = new Set(['name', 'job_title', 'company_name', 'email']);

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

// PATCH /leads/:id — atendente edita nome/cargo/empresa/email antes de
// criar deal no Pipedrive. Phone é read-only (vem do WhatsApp original).
router.patch('/leads/:id', async (req, res) => {
    try {
        const patch = {};
        for (const [k, v] of Object.entries(req.body || {})) {
            if (!EDITABLE_FIELDS.has(k)) continue;
            // Trata string vazia como null pra não persistir "" no DB
            patch[k] = v === '' ? null : v;
        }
        if (!Object.keys(patch).length) {
            return res.status(400).json({
                error: 'Nada pra atualizar (campos editáveis: ' + [...EDITABLE_FIELDS].join(', ') + ')',
            });
        }
        const updated = await updateLead(req.params.id, patch);
        res.json(updated);
    } catch (err) {
        logger.warn('site PATCH /leads/:id', { error: err.message });
        res.status(500).json({ error: err.message || 'Erro ao atualizar lead' });
    }
});

export default router;
