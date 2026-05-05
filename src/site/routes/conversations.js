import { Router } from 'express';
import {
    listConversations,
    getConversationById,
    updateConversation,
    updateLead,
    getLeadById,
} from '../services/supabase.js'; // site.* schema helpers
import {
    findPersonByPhone, findOrCreateOrg, createPerson, createDeal,
} from '../../services/pipedrive.js';
import { getSettings } from '../../services/supabase.js'; // public schema (platform_settings)
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

// ─── POST /conversations/:id/route-comercial ─────────────────────────
// Classifica lead como Comercial → cria Person + Deal no Pipedrive
// (idempotente: se lead já tem crm_deal_id, retorna o existente).
router.post('/conversations/:id/route-comercial', async (req, res) => {
    try {
        const conv = await getConversationById(req.params.id);
        if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });

        const lead = await getLeadById(conv.lead_id);
        if (!lead)         return res.status(404).json({ error: 'Lead não encontrado' });
        if (!lead.phone)   return res.status(400).json({ error: 'Lead sem telefone — não dá pra criar Person no Pipedrive' });

        // Idempotência: se já tem deal, só garante classification e retorna.
        if (lead.crm_deal_id) {
            if (lead.classification !== 'comercial') {
                await updateLead(lead.id, { classification: 'comercial' });
            }
            return res.json({
                success: true,
                already_routed: true,
                deal_id: lead.crm_deal_id,
                person_id: lead.crm_person_id || null,
                lead_id: lead.id,
            });
        }

        // Encontra ou cria Person
        let person = await findPersonByPhone(lead.phone);
        if (!person) {
            person = await createPerson({
                name:         lead.name || lead.phone,
                phone:        lead.phone,
                email:        lead.email || null,
                company_name: lead.company_name || null,
            });
        }
        if (!person?.id) {
            return res.status(502).json({ error: 'Falha ao criar/encontrar Person no Pipedrive' });
        }

        // Org (opcional — só se temos company_name e Person ainda não tem)
        let orgId = person.org_id?.value || person.org_id || null;
        if (!orgId && lead.company_name) {
            orgId = await findOrCreateOrg(lead.company_name);
        }

        // Settings: pipeline + stage default (pode override via body)
        const settings = await getSettings();
        const pipelineId = req.body?.pipeline_id || settings?.pipedrive_pipeline_id || 5;
        const stageId    = req.body?.stage_id    || settings?.pipedrive_stage_id    || 208;

        const dealTitle = lead.company_name
            ? `${lead.company_name} — Site`
            : `${lead.name || lead.phone} — Site`;

        const deal = await createDeal({
            title:      dealTitle,
            personId:   person.id,
            orgId:      orgId || undefined,
            pipelineId,
            stageId,
            ownerId:    req.user?.pipedrive_user_id || undefined,
        });
        if (!deal?.id) {
            return res.status(502).json({ error: 'Falha ao criar Deal no Pipedrive' });
        }

        // Persiste no lead
        await updateLead(lead.id, {
            classification: 'comercial',
            crm_person_id:  String(person.id),
            crm_deal_id:    String(deal.id),
        });

        logger.info('Site lead routed to Comercial', {
            lead_id: lead.id, deal_id: deal.id, person_id: person.id,
        });

        res.json({
            success: true,
            deal_id: String(deal.id),
            person_id: String(person.id),
            lead_id: lead.id,
        });
    } catch (err) {
        logger.error('site route-comercial', { error: err.message });
        res.status(500).json({ error: err.message || 'Erro ao rotear pra Comercial' });
    }
});

// ─── POST /conversations/:id/route-opec ──────────────────────────────
// Marca lead como OPEC. Webhook pro Google Chat virá na Fase 3.
router.post('/conversations/:id/route-opec', async (req, res) => {
    try {
        const conv = await getConversationById(req.params.id);
        if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });

        const lead = await getLeadById(conv.lead_id);
        if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });

        await updateLead(lead.id, { classification: 'opec' });

        logger.info('Site lead routed to OPEC', { lead_id: lead.id });

        res.json({ success: true, lead_id: lead.id, classification: 'opec' });
    } catch (err) {
        logger.error('site route-opec', { error: err.message });
        res.status(500).json({ error: err.message || 'Erro ao rotear pra OPEC' });
    }
});

export default router;
