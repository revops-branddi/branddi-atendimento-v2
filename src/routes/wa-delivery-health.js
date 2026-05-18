/**
 * WA Delivery Health — diagnóstico em tempo real de problemas de entrega
 * por conta WhatsApp do usuário logado.
 *
 * Motivação: o WhatsApp aplica throttle silencioso quando detecta padrão de
 * cold outreach (volume + similaridade + baixa resposta). Unipile aceita o
 * POST, msg fica `delivered=false` pra sempre, atendente não sabe.
 *
 * Esta rota agrega as últimas 60 min de envios do usuário e classifica:
 *   - ok       — entrega normal
 *   - warning  — sinais iniciais de degradação
 *   - active   — throttle muito provável; recomenda pausar cold
 *
 * Distingue COLD (1ª msg pra alguém que nunca respondeu) de WARM (conversa
 * com inbound histórico) — só cold sofre throttle. Warm em 100% prova que
 * a sessão WA está sadia, eliminando "conta caiu" como hipótese.
 */
import { Router } from 'express';
import supabase from '../services/supabase.js';
import logger from '../services/logger.js';

const router = Router();

const WINDOW_MINUTES   = 60;       // janela de análise
const LIMBO_MIN_AGE_MS = 5 * 60_000; // msg >5min sem delivered=true conta como falha
const MAX_MSGS         = 500;      // teto defensivo

/**
 * Classifica o estado de throttle de uma conta com base em cold msgs recentes.
 * Limites calibrados via análise de dados reais (caso Stephanie 2026-05-18):
 *   - 28 ghost + 31 limbo em 77 cold = 76% falha → active
 *   - Conta saudável típica: 0-15% falha em cold → ok
 */
function classifyAccount({ cold_total, cold_failed }) {
    if (cold_total === 0) return 'ok';
    const failRate = cold_failed / cold_total;
    if (cold_failed >= 5 && failRate >= 0.6) return 'active';
    if (cold_failed >= 3 || (cold_total >= 10 && failRate >= 0.4)) return 'warning';
    return 'ok';
}

function recommendationFor(status, { cold_failed }) {
    if (status === 'active') {
        return `${cold_failed} mensagens novas não foram entregues. Pause prospecção por algumas horas e foque em quem já respondeu — essas chegam normalmente.`;
    }
    if (status === 'warning') {
        return `Algumas mensagens novas estão demorando ou não chegando. Diminui o ritmo e varia a mensagem pra não acionar antispam do WhatsApp.`;
    }
    return null;
}

// ─── GET /api/wa/delivery-health ──────────────────────────────────────
// Retorna status agregado e por conta WA do usuário logado.
router.get('/wa/delivery-health', async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'auth required' });

        const windowStart = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();
        const limboCutoff = new Date(Date.now() - LIMBO_MIN_AGE_MS).toISOString();

        // 1) Msgs outbound human do user na janela
        const { data: msgs, error: msgsErr } = await supabase
            .from('messages')
            .select('id, conversation_id, delivered, failed_reason, created_at')
            .eq('sent_by_user_id', userId)
            .eq('direction', 'outbound')
            .eq('sender_type', 'human')
            .gte('created_at', windowStart)
            .order('created_at', { ascending: true })
            .limit(MAX_MSGS);
        if (msgsErr) throw msgsErr;
        if (!msgs?.length) {
            return res.json({
                status: 'ok',
                summary: { cold_total: 0, cold_failed: 0, window_minutes: WINDOW_MINUTES },
                accounts: [],
            });
        }

        const convIds = [...new Set(msgs.map(m => m.conversation_id))];

        // 2) Para cada conversation envolvida, descobre se tem QUALQUER inbound
        //    histórico (= warm) ou não (= cold). Inbound mesmo posterior à msg
        //    conta — uma vez warm, sempre warm.
        const { data: inbounds, error: inErr } = await supabase
            .from('messages')
            .select('conversation_id')
            .in('conversation_id', convIds)
            .eq('direction', 'inbound')
            .limit(MAX_MSGS * 2);
        if (inErr) throw inErr;
        const warmConvs = new Set((inbounds || []).map(r => r.conversation_id));

        // 3) Conversations → whatsapp_account_id
        const { data: convs, error: convErr } = await supabase
            .from('conversations')
            .select('id, whatsapp_account_id')
            .in('id', convIds);
        if (convErr) throw convErr;
        const convAccount = new Map((convs || []).map(c => [c.id, c.whatsapp_account_id]));

        // 4) Whatsapp accounts → label/phone pra UI
        const acctIds = [...new Set((convs || []).map(c => c.whatsapp_account_id).filter(Boolean))];
        const accountMeta = new Map();
        if (acctIds.length) {
            const { data: accts } = await supabase
                .from('whatsapp_accounts')
                .select('unipile_account_id, phone_number, display_label, label')
                .in('unipile_account_id', acctIds);
            for (const a of (accts || [])) {
                accountMeta.set(a.unipile_account_id, {
                    label: a.display_label || a.label || a.phone_number || 'WhatsApp',
                    phone: a.phone_number,
                });
            }
        }

        // 5) Agrega por conta WA
        const byAccount = new Map();
        for (const m of msgs) {
            const acct = convAccount.get(m.conversation_id) || '_unknown';
            const isCold = !warmConvs.has(m.conversation_id);
            const isGhost = m.failed_reason === 'ghost_chat';
            const isLimbo = !m.delivered && !m.failed_reason && m.created_at < limboCutoff;
            const isFailed = isGhost || isLimbo;
            const isDelivered = !!m.delivered;

            const bucket = byAccount.get(acct) || {
                whatsapp_account_id: acct,
                label: accountMeta.get(acct)?.label || 'WhatsApp',
                phone: accountMeta.get(acct)?.phone || null,
                cold_total: 0, cold_failed: 0, cold_delivered: 0,
                warm_total: 0, warm_delivered: 0,
                ghost_count: 0, limbo_count: 0,
            };
            if (isCold) {
                bucket.cold_total += 1;
                if (isFailed) bucket.cold_failed += 1;
                if (isDelivered) bucket.cold_delivered += 1;
            } else {
                bucket.warm_total += 1;
                if (isDelivered) bucket.warm_delivered += 1;
            }
            if (isGhost) bucket.ghost_count += 1;
            if (isLimbo) bucket.limbo_count += 1;
            byAccount.set(acct, bucket);
        }

        const accounts = [...byAccount.values()].map(b => ({
            ...b,
            status: classifyAccount(b),
            recommendation: recommendationFor(classifyAccount(b), b),
        }));

        // Status global = pior status entre as contas (active > warning > ok)
        const rank = { active: 2, warning: 1, ok: 0 };
        const globalStatus = accounts.reduce(
            (worst, a) => (rank[a.status] > rank[worst]) ? a.status : worst,
            'ok'
        );

        const totals = accounts.reduce((acc, a) => ({
            cold_total:   acc.cold_total   + a.cold_total,
            cold_failed:  acc.cold_failed  + a.cold_failed,
            ghost_count:  acc.ghost_count  + a.ghost_count,
            limbo_count:  acc.limbo_count  + a.limbo_count,
        }), { cold_total: 0, cold_failed: 0, ghost_count: 0, limbo_count: 0 });

        res.json({
            status: globalStatus,
            summary: {
                ...totals,
                window_minutes: WINDOW_MINUTES,
            },
            accounts,
        });
    } catch (err) {
        logger.warn('GET /wa/delivery-health', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

export default router;
