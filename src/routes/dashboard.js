/**
 * Dashboard Routes — métricas de prospecção (atribuídas via dono do número WA).
 *
 * Cache backend: Map em memória com TTL 30s por chave (params do query).
 * Aceita ?fresh=1 pra bypass o cache (refresh manual).
 */
import { Router } from 'express';
import { getProspectingDashboard } from '../services/supabase.js';

const router = Router();

const VALID_GRANULARITIES = new Set(['daily', 'weekly', 'monthly']);
const VALID_TEAMS = new Set(['prospecting', 'sales']);

// ─── In-memory cache ───────────────────────────────────────────────────
// Map<cacheKey, { data, expiresAt }>. Reset em redeploy/restart.
// TTL curto (30s) suficiente pra absorver trocas de tab consecutivas
// sem deixar dados muito stale.
const _dashCache = new Map();
const CACHE_TTL_MS = 30_000;

function cacheKey(params) {
    return JSON.stringify(params);
}

function cleanExpired() {
    const now = Date.now();
    for (const [k, v] of _dashCache) {
        if (v.expiresAt < now) _dashCache.delete(k);
    }
}

// ─── GET /api/dashboard/prospecting ───────────────────────────────────
// Admin vê tudo + filtra por user/account/team; SDR vê só os próprios números.
// ?team=prospecting|sales  → agrupa por categoria do atendente
// ?team omitido            → todos
// ?fresh=1                 → bypass cache (refresh forçado)
router.get('/dashboard/prospecting', async (req, res) => {
    try {
        const granularity = VALID_GRANULARITIES.has(req.query.granularity)
            ? req.query.granularity
            : 'monthly';
        const team = VALID_TEAMS.has(req.query.team) ? req.query.team : null;
        const params = {
            granularity,
            user_id: req.query.user_id || null,
            account_id: req.query.account_id || null,
            team,
            role: req.user?.role || 'Usuario',
            requester_id: req.user?.id || null,
        };

        const key = cacheKey(params);
        const bypass = req.query.fresh === '1';

        if (!bypass) {
            const cached = _dashCache.get(key);
            if (cached && cached.expiresAt > Date.now()) {
                res.setHeader('X-Cache', 'HIT');
                return res.json(cached.data);
            }
        }

        // Limpa entries expiradas a cada miss (manutenção barata)
        if (_dashCache.size > 50) cleanExpired();

        const data = await getProspectingDashboard(params);
        _dashCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
        res.setHeader('X-Cache', 'MISS');
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
