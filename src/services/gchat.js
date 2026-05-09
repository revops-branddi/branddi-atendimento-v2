/**
 * Google Chat — incoming webhooks pra grupos OPEC.
 *
 * Cada categoria OPEC tem um Space próprio no GChat com webhook configurado.
 * Posta um card estruturado (cardsV2) com dados do lead + conversa.
 *
 * Limitação importante: incoming webhook NÃO faz @mention confiável (precisa
 * Chat App com auth pra mention via <users/USER_ID>). Por isso o card mostra
 * o responsável como label destacado, e quem está no Space recebe notificação
 * por já estar no grupo.
 *
 * Falha do webhook NÃO derruba o fluxo OPEC — caller deve marcar lead mesmo
 * assim e mostrar warning. Função aqui retorna `{ ok, error }` em vez de
 * throw, pra deixar a decisão de retry no caller.
 */
import logger from './logger.js';

// ─── Config ──────────────────────────────────────────────────────────

// Mapping categoria → metadados (responsável + email + env var do webhook).
// Mover pra DB se algum dia mudar com frequência. Por enquanto hardcoded
// porque é estável (3 pessoas, 1 webhook cada).
export const OPEC_CATEGORIES = {
    bb: {
        label:       'TakeDown BB',
        notification_email: 'notificacao@brandmonitor.com.br',
        owner_name:  'Giselle França',
        owner_email: 'giselle.franca@branddi.com',
        webhook_env: 'OPEC_GCHAT_WEBHOOK_BB',
    },
    golpes: {
        label:       'TakeDown Golpes',
        notification_email: 'fraud@branddi.com',
        owner_name:  'Caroline Cipriani',
        owner_email: 'caroline.cipriani@branddi.com',
        webhook_env: 'OPEC_GCHAT_WEBHOOK_GOLPES',
    },
    vm: {
        label:       'TakeDown VM',
        notification_email: 'ip-violations-report@brandmonitor.com.br',
        owner_name:  'João França',
        owner_email: 'joao.franca@branddi.com',
        webhook_env: 'OPEC_GCHAT_WEBHOOK_VM',
    },
};

export function getOpecCategory(category) {
    return OPEC_CATEGORIES[category] || null;
}

// ─── Card builder ────────────────────────────────────────────────────

/**
 * Monta o payload cardsV2 que vai pro webhook. Layout:
 *   [Header] Nova solicitação <Categoria>
 *   [Section: Lead] Empresa | Nome | Telefone
 *   [Section: Atribuído] Responsável + email
 *   [Section: Conversa] Texto multilinha (msgs do lead)
 */
function buildCard({ category, lead, conversationText, subject }) {
    const cat = OPEC_CATEGORIES[category];
    const widgets = [];

    // Lead info
    if (lead.company_name) widgets.push({ decoratedText: { topLabel: 'Empresa',  text: lead.company_name } });
    if (lead.name)         widgets.push({ decoratedText: { topLabel: 'Nome',     text: lead.name } });
    if (lead.phone)        widgets.push({ decoratedText: { topLabel: 'Telefone', text: lead.phone } });

    // Atribuído (separador visual)
    widgets.push({ divider: {} });
    widgets.push({ decoratedText: {
        topLabel: 'Atribuído pra',
        text:     `<b>${cat.owner_name}</b>`,
        bottomLabel: cat.owner_email,
    } });
    widgets.push({ decoratedText: {
        topLabel: 'Email de notificação',
        text:     cat.notification_email,
    } });

    // Subject (resumo do atendente)
    if (subject) {
        widgets.push({ divider: {} });
        widgets.push({ textParagraph: { text: `<b>Resumo do atendente:</b>\n${escapeXml(subject)}` } });
    }

    // Conversa (mensagens do lead)
    if (conversationText) {
        widgets.push({ divider: {} });
        widgets.push({ textParagraph: { text: `<b>Mensagens do lead:</b>\n${escapeXml(conversationText)}` } });
    }

    return {
        cardsV2: [{
            cardId: `opec-${category}-${Date.now()}`,
            card: {
                header: {
                    title:    `Nova solicitação ${cat.label}`,
                    subtitle: 'Atendimento Site Branddi',
                    imageUrl: 'https://atendimento.branddi.com/branddi-mark.svg',
                    imageType: 'CIRCLE',
                },
                sections: [{ widgets }],
            },
        }],
    };
}

// GChat textParagraph aceita um subset de HTML — escape pra evitar tags
// quebradas no card (ex: lead manda um "<script>" no whatsapp).
function escapeXml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ─── Sender ──────────────────────────────────────────────────────────

/**
 * Envia o card pro GChat. Retorna { ok: true } em sucesso ou
 * { ok: false, error: string } em falha.
 *
 * NÃO joga exception — caller decide o que fazer.
 */
export async function postOpecToGChat({ category, lead, conversationText, subject }) {
    const cat = OPEC_CATEGORIES[category];
    if (!cat) {
        return { ok: false, error: `Categoria OPEC inválida: ${category}` };
    }

    const webhook = process.env[cat.webhook_env];
    if (!webhook) {
        logger.warn('GChat webhook não configurado', { category, env: cat.webhook_env });
        return { ok: false, error: `Webhook ${cat.webhook_env} não configurado` };
    }

    const payload = buildCard({ category, lead, conversationText, subject });

    try {
        const res = await fetch(webhook, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload),
            signal:  AbortSignal.timeout(8000),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            logger.warn('GChat webhook returned non-2xx', {
                category, status: res.status, body: body.slice(0, 300),
            });
            return { ok: false, error: `GChat ${res.status}: ${body.slice(0, 200)}` };
        }
        logger.info('OPEC posted to GChat', { category, lead_id: lead.id });
        return { ok: true };
    } catch (err) {
        logger.warn('GChat webhook fetch failed', { category, error: err.message });
        return { ok: false, error: err.message };
    }
}
