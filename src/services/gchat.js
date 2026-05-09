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

// Mapping categoria → metadados (responsável + email + User ID do GChat
// + env var do webhook). User IDs descobertos via People API
// (people:searchDirectoryPeople) — formato `<users/USER_ID>` no texto da
// mensagem dispara notificação real pra essa pessoa no space (testado
// 2026-05-09). Hardcoded porque IDs são estáveis pro tempo de vida da conta.
export const OPEC_CATEGORIES = {
    bb: {
        label:              'TakeDown BB',
        notification_email: 'notificacao@brandmonitor.com.br',
        owner_name:         'Giselle França',
        owner_email:        'giselle.franca@branddi.com',
        owner_gchat_id:     '118259783287452386224',
        webhook_env:        'OPEC_GCHAT_WEBHOOK_BB',
    },
    golpes: {
        label:              'TakeDown Golpes',
        notification_email: 'fraud@branddi.com',
        owner_name:         'Caroline Cipriani',
        owner_email:        'caroline.cipriani@branddi.com',
        owner_gchat_id:     '108129913137826817302',
        webhook_env:        'OPEC_GCHAT_WEBHOOK_GOLPES',
    },
    vm: {
        label:              'TakeDown VM',
        notification_email: 'ip-violations-report@brandmonitor.com.br',
        owner_name:         'João França',
        owner_email:        'joao.franca@branddi.com',
        owner_gchat_id:     '116608694235179109361',
        webhook_env:        'OPEC_GCHAT_WEBHOOK_VM',
    },
};

// ─── Helpers de telefone ─────────────────────────────────────────────

// Strip não-dígitos e garante prefixo BR ('55'). wa.me precisa formato
// internacional sem "+", sem espaços. Ex: "+55 (71) 98328-1802" → "5571983281802"
function normalizeForWaMe(phone) {
    if (!phone) return null;
    let digits = String(phone).replace(/\D/g, '');
    if (!digits) return null;
    // Se começa com 55 e tem ≥12 dígitos, já tá com país. Caso contrário, prepend.
    if (!digits.startsWith('55')) digits = '55' + digits;
    return digits;
}

function formatPhonePretty(phone) {
    // Tenta formatar pra +55 (DD) 9XXXX-XXXX
    if (!phone) return null;
    const digits = String(phone).replace(/\D/g, '');
    if (digits.length < 10) return phone; // devolve cru se não bate
    let national = digits.startsWith('55') ? digits.slice(2) : digits;
    if (national.length === 11) {
        return `+55 (${national.slice(0,2)}) ${national.slice(2,7)}-${national.slice(7)}`;
    }
    if (national.length === 10) {
        return `+55 (${national.slice(0,2)}) ${national.slice(2,6)}-${national.slice(6)}`;
    }
    return `+55 ${national}`;
}

export function getOpecCategory(category) {
    return OPEC_CATEGORIES[category] || null;
}

// ─── Card builder ────────────────────────────────────────────────────

/**
 * Monta o payload do webhook: uma mensagem com `text` (que contém o
 * @mention pra disparar notificação) + cardV2 com os dados estruturados.
 *
 * Layout do card:
 *   [Header] Nova solicitação <Categoria>
 *   [Section: Lead] Empresa | Nome | Telefone (com botão wa.me)
 *   [Section: Atribuído] Responsável + email + email de notificação
 *   [Section: Resumo do atendente]
 *   [Section: Mensagens do lead]
 */
function buildPayload({ category, lead, conversationText, subject }) {
    const cat = OPEC_CATEGORIES[category];
    const widgets = [];

    // Empresa
    if (lead.company_name) {
        widgets.push({ decoratedText: { topLabel: 'Empresa', text: lead.company_name } });
    }
    // Nome
    if (lead.name) {
        widgets.push({ decoratedText: { topLabel: 'Nome', text: lead.name } });
    }
    // Telefone formatado + botão wa.me
    if (lead.phone) {
        const waNum  = normalizeForWaMe(lead.phone);
        const pretty = formatPhonePretty(lead.phone);
        widgets.push({
            decoratedText: {
                topLabel:    'WhatsApp',
                text:        pretty || lead.phone,
                bottomLabel: waNum ? `wa.me/${waNum}` : null,
                button: waNum ? {
                    text: 'Abrir WhatsApp',
                    onClick: { openLink: { url: `https://wa.me/${waNum}` } },
                } : undefined,
            },
        });
    }

    // Atribuído + email de notificação
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

    // Resumo do atendente
    if (subject) {
        widgets.push({ divider: {} });
        widgets.push({ textParagraph: { text: `<b>Resumo do atendente:</b>\n${escapeXml(subject)}` } });
    }

    // Mensagens do lead
    if (conversationText) {
        widgets.push({ divider: {} });
        widgets.push({ textParagraph: { text: `<b>Mensagens do lead:</b>\n${escapeXml(conversationText)}` } });
    }

    // O @mention vai no `text` (fora do card) — formato `<users/ID>` testado
    // e confirmado em 2026-05-09 (renderiza como tag, dispara notificação).
    const mentionText = `<users/${cat.owner_gchat_id}> nova solicitação ${cat.label} chegou:`;

    return {
        text: mentionText,
        cardsV2: [{
            cardId: `opec-${category}-${Date.now()}`,
            card: {
                header: {
                    title:     `Nova solicitação ${cat.label}`,
                    subtitle:  'Atendimento Site Branddi',
                    imageUrl:  'https://atendimento.branddi.com/branddi-mark.svg',
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

    const payload = buildPayload({ category, lead, conversationText, subject });

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
