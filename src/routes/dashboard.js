/**
 * Dashboard Routes — métricas de prospecção (atribuídas via dono do número WA).
 */
import { Router } from 'express';
import { getProspectingDashboard } from '../services/supabase.js';

const router = Router();

const VALID_GRANULARITIES = new Set(['daily', 'weekly', 'monthly']);
const VALID_TEAMS = new Set(['prospecting', 'sales']);

// ─── GET /api/dashboard/prospecting ───────────────────────────────────
// Admin vê tudo + filtra por user/account/team; SDR vê só os próprios números.
// ?team=prospecting|sales  → agrupa por categoria do atendente
// ?team omitido            → todos
router.get('/dashboard/prospecting', async (req, res) => {
    try {
        const granularity = VALID_GRANULARITIES.has(req.query.granularity)
            ? req.query.granularity
            : 'monthly';
        const team = VALID_TEAMS.has(req.query.team) ? req.query.team : null;
        const data = await getProspectingDashboard({
            granularity,
            user_id: req.query.user_id || null,
            account_id: req.query.account_id || null,
            team,
            role: req.user?.role || 'Usuario',
            requester_id: req.user?.id || null,
        });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
