/**
 * Site Dashboard — KPIs do canal /site (admin only).
 *
 * Endpoint enxuto que agrega contagens via Postgres SQL no schema site.*.
 * Sem materialized views, sem cache — DB do site é pequeno (centenas de
 * conv por mês), queries simples rodam em <100ms.
 */
import { Router } from 'express';
import sb from '../services/db.js';
import { requireRole } from '../../middleware/auth.js';
import logger from '../../services/logger.js';

const router = Router();

// ─── GET /dashboard ──────────────────────────────────────────────────
// Query: ?days=N (default 7). Retorna agregados das últimas N dias.
//
// Estrutura do response:
//   {
//     range: { days, since },
//     conversations: { total, by_status: {...}, by_classification: {...} },
//     opec: { total, by_category: { bb, golpes, vm } },
//     comercial: { total, with_deal, conversion_rate },
//     bot: { total_handed_off, avg_attempts, gave_up_count },
//     atendentes: [{ user_id, name, assigned_count, resolved_count }]
//   }
router.get('/dashboard', requireRole('Admin'), async (req, res) => {
    try {
        const days = Math.min(Math.max(parseInt(req.query.days || '7', 10) || 7, 1), 365);
        const since = new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();

        // 1. Conversations no período (via view public.v_site_conversations; ver mig 022)
        const { data: convs, error: convErr } = await sb
            .from('v_site_conversations')
            .select('id, status, lead_id, assigned_user_id, bot_stage, bot_attempts, created_at')
            .gte('created_at', since);
        if (convErr) throw convErr;

        // 2. Leads dessas conversas (pra ter classification + crm_deal_id)
        const leadIds = [...new Set(convs.map(c => c.lead_id).filter(Boolean))];
        let leads = [];
        if (leadIds.length) {
            const { data, error } = await sb
                .from('v_site_leads')
                .select('id, classification, opec_category, crm_deal_id')
                .in('id', leadIds);
            if (error) throw error;
            leads = data || [];
        }
        const leadMap = new Map(leads.map(l => [l.id, l]));

        // 3. Atendentes (do schema public, lookup por assigned_user_id)
        const userIds = [...new Set(convs.map(c => c.assigned_user_id).filter(Boolean))];
        let users = [];
        if (userIds.length) {
            // platform_users vive em public.* — agora que o client default já
            // é public, o .schema('public') vira no-op mas mantém intent claro.
            const { data, error } = await sb.schema('public')
                .from('platform_users')
                .select('id, name')
                .in('id', userIds);
            if (error) logger.warn('site dashboard users lookup', { error: error.message });
            users = data || [];
        }
        const userMap = new Map(users.map(u => [u.id, u]));

        // ─── Agrega ───────────────────────────────────────────────────
        const byStatus = { bot: 0, waiting_human: 0, in_progress: 0, resolved: 0 };
        const byCls    = { comercial: 0, opec: 0, unclassified: 0 };
        const byOpec   = { bb: 0, golpes: 0, vm: 0 };
        let comercialWithDeal = 0;
        let botHandedOff      = 0;
        let botGaveUp         = 0;
        let totalBotAttempts  = 0;
        let botCount          = 0;

        const perAtendente = new Map(); // user_id → { assigned, resolved }

        for (const c of convs) {
            byStatus[c.status] = (byStatus[c.status] || 0) + 1;

            const lead = leadMap.get(c.lead_id);
            const cls  = lead?.classification || null;
            if (cls === 'comercial') {
                byCls.comercial++;
                if (lead?.crm_deal_id) comercialWithDeal++;
            } else if (cls === 'opec') {
                byCls.opec++;
                if (lead?.opec_category && byOpec[lead.opec_category] !== undefined) {
                    byOpec[lead.opec_category]++;
                }
            } else {
                byCls.unclassified++;
            }

            // Bot stats: conv que passou pelo bot e foi pra humano (bot_stage='human')
            if (c.bot_stage === 'human') botHandedOff++;
            if (c.bot_attempts >= 3 && c.bot_stage === 'human') botGaveUp++;
            if (c.bot_stage === 'human' || c.bot_stage === 'awaiting_classification' ||
                c.bot_stage === 'awaiting_email_choice' || c.bot_stage === 'awaiting_commercial_details') {
                totalBotAttempts += (c.bot_attempts || 0);
                botCount++;
            }

            // Por atendente
            if (c.assigned_user_id) {
                const a = perAtendente.get(c.assigned_user_id) || { assigned: 0, resolved: 0 };
                a.assigned++;
                if (c.status === 'resolved') a.resolved++;
                perAtendente.set(c.assigned_user_id, a);
            }
        }

        const atendentes = [...perAtendente.entries()]
            .map(([userId, stats]) => ({
                user_id:        userId,
                name:           userMap.get(userId)?.name || 'Desconhecido',
                assigned_count: stats.assigned,
                resolved_count: stats.resolved,
            }))
            .sort((a, b) => b.assigned_count - a.assigned_count);

        const comercialTotal = byCls.comercial;
        const conversionRate = comercialTotal > 0
            ? Math.round((comercialWithDeal / comercialTotal) * 1000) / 10 // % com 1 casa
            : 0;
        const avgBotAttempts = botCount > 0
            ? Math.round((totalBotAttempts / botCount) * 100) / 100
            : 0;

        res.json({
            range: { days, since },
            conversations: {
                total:              convs.length,
                by_status:          byStatus,
                by_classification:  byCls,
            },
            opec: {
                total:        byCls.opec,
                by_category:  byOpec,
            },
            comercial: {
                total:           comercialTotal,
                with_deal:       comercialWithDeal,
                conversion_rate: conversionRate,
            },
            bot: {
                handed_off:      botHandedOff,
                gave_up:         botGaveUp,
                avg_attempts:    avgBotAttempts,
            },
            atendentes,
        });
    } catch (err) {
        logger.error('site GET /dashboard', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

export default router;
