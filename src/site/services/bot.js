/**
 * Site Bot — triagem inicial das conversas inbound.
 *
 * Máquina de estados rule-based (zero LLM): cumprimenta, pergunta se é
 * OPEC ou Comercial, roteia. Quando não consegue interpretar a resposta,
 * tenta de novo até 3x e desiste (entrega pra humano).
 *
 * IMPORTANTE: este bot é EXCLUSIVO do fluxo /site (schema site.*, número
 * dedicado). Auto-mensagens em prospecção continuam proibidas — ver
 * memory/feedback_no_auto_messages.md.
 *
 * Estados (bot_stage):
 *   welcome                       — conv nova, próxima inbound dispara greeting
 *   awaiting_classification       — esperando "1" (OPEC) ou "2" (Comercial)
 *   awaiting_email_choice         — OPEC: esperando "1" / "2" / "3"
 *   awaiting_commercial_details   — Comercial: esperando resposta livre
 *   human                         — bot saiu, atendente assume
 *
 * Status (column status):
 *   'bot' enquanto bot_stage != 'human'. Quando vai pra humano, vira
 *   'waiting_human' (Comercial) ou 'resolved' (OPEC já roteado).
 */
import sb from './db.js';
import { sendMessage } from './unipile.js';
import logger from '../../services/logger.js';
import { postOpecToGChat, OPEC_CATEGORIES } from '../../services/gchat.js';
import { updateLead, getLeadById, getMessages } from './supabase.js';

const MAX_BOT_ATTEMPTS = 3;

// ─── Mensagens do bot ─────────────────────────────────────────────────

const MSG_WELCOME = `Olá! Aqui é a Branddi — obrigada pelo contato 👋

Pra te direcionar pra pessoa certa, me conta: você está aqui porque
1️⃣ Recebeu uma notificação da nossa equipe
2️⃣ Quer conhecer mais sobre o trabalho da Branddi

Responde com *1* ou *2*.`;

const MSG_OPEC_EMAIL = `Entendi. Pra direcionar pro time certo, qual foi o e-mail pelo qual você recebeu a notificação?

1️⃣ notificacao@brandmonitor.com.br
2️⃣ fraud@branddi.com
3️⃣ ip-violations-report@brandmonitor.com.br

Responde com *1*, *2* ou *3*.`;

const MSG_COMMERCIAL = `Show! Pra te ajudar melhor, me passa numa mensagem só:

• Seu nome
• Empresa
• O que você quer entender / resolver com a gente

Vou direcionar pra um atendente humano em seguida.`;

const MSG_FALLBACK = `Não entendi 😅 Pode responder com o número da opção que mais combina?`;

const MSG_HANDOFF_OPEC = (cat) =>
    `Tudo certo! Já encaminhei sua solicitação pro time de ${cat}. Em breve alguém entra em contato. 🙏`;

const MSG_HANDOFF_COMMERCIAL = `Recebido! Já vou chamar um atendente humano pra continuar daqui. 🙌`;

const MSG_HANDOFF_GIVEUP = `Vou chamar um atendente humano pra te ajudar — em instantes alguém aparece por aqui. 🙏`;

// ─── Parsing das respostas do lead ───────────────────────────────────

function parseClassification(text) {
    const t = String(text || '').trim().toLowerCase();
    if (/^1\b|notifica|recebi/i.test(t)) return 'opec';
    if (/^2\b|conhec|interess|saber|trabalho/i.test(t)) return 'comercial';
    return null;
}

function parseEmailChoice(text) {
    const t = String(text || '').trim().toLowerCase();
    if (/^1\b|notificacao|brandmonitor.*notif/i.test(t)) return 'bb';
    if (/^2\b|fraud|golpe/i.test(t))                     return 'golpes';
    if (/^3\b|ip-?violations?|vm\b/i.test(t))            return 'vm';
    return null;
}

// ─── DB helpers ──────────────────────────────────────────────────────

async function updateConversation(id, patch) {
    const { error } = await sb.from('conversations')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id);
    if (error) throw error;
}

async function saveBotMessage(conv, text, unipileMessageId) {
    // Persistimos como outbound humana — sender_name='Bot' diferencia na UI
    // sem precisar adicionar coluna nova. direction='outbound' garante que
    // aparece no lado correto da thread.
    //
    // unipile_message_id é crítico: sem ele, o polling subsequente vê a
    // mesma msg voltando do Unipile e insere uma 2ª row (UNIQUE não bate)
    // — daí o balão duplicado "ATENDENTE" + "BOT" na UI.
    const { error } = await sb.from('messages').insert({
        conversation_id:    conv.id,
        direction:          'outbound',
        text,
        sender_type:        'human',
        sender_name:        'Bot',
        unipile_message_id: unipileMessageId || null,
        delivered:          true,
        seen:               false,
        created_at:         new Date().toISOString(),
    });
    if (error) logger.warn('saveBotMessage error', { error: error.message });
}

async function botSend(conv, text) {
    try {
        const res = await sendMessage(conv.whatsapp_chat_id, text);
        const unipileMessageId = res?.message_id || res?.id || null;
        await saveBotMessage(conv, text, unipileMessageId);
        return true;
    } catch (err) {
        logger.warn('Bot send failed', { conv_id: conv.id, error: err.message });
        return false;
    }
}

// ─── State machine principal ────────────────────────────────────────

/**
 * Chama-se uma vez por mensagem inbound nova quando conv.status === 'bot'.
 * Retorna { handled: bool, newStage: string|null }.
 *
 * `lastInboundText` é o texto da última msg do lead — usado pra parsing
 * nos estados awaiting_*. Em welcome, o texto é ignorado (só serve como
 * trigger pra disparar greeting).
 */
export async function processBotTurn(conv, lastInboundText) {
    const stage = conv.bot_stage || 'welcome';

    // welcome → manda greeting + transita pra awaiting_classification
    if (stage === 'welcome') {
        const ok = await botSend(conv, MSG_WELCOME);
        if (ok) {
            await updateConversation(conv.id, {
                bot_stage:     'awaiting_classification',
                bot_attempts:  0,
            });
        }
        return { handled: ok, newStage: 'awaiting_classification' };
    }

    // awaiting_classification → parse "1" ou "2"
    if (stage === 'awaiting_classification') {
        const choice = parseClassification(lastInboundText);
        if (choice === 'opec') {
            await botSend(conv, MSG_OPEC_EMAIL);
            await updateConversation(conv.id, {
                bot_stage:    'awaiting_email_choice',
                bot_attempts: 0,
            });
            return { handled: true, newStage: 'awaiting_email_choice' };
        }
        if (choice === 'comercial') {
            await botSend(conv, MSG_COMMERCIAL);
            await updateConversation(conv.id, {
                bot_stage:    'awaiting_commercial_details',
                bot_attempts: 0,
            });
            return { handled: true, newStage: 'awaiting_commercial_details' };
        }
        return await botFallback(conv, MSG_FALLBACK);
    }

    // awaiting_email_choice → parse "1" / "2" / "3"
    if (stage === 'awaiting_email_choice') {
        const cat = parseEmailChoice(lastInboundText);
        if (!cat) return await botFallback(conv, MSG_FALLBACK);

        // Auto-classifica + posta GChat + responde lead + handoff
        const lead = await getLeadById(conv.lead_id);
        await updateLead(conv.lead_id, {
            classification: 'opec',
            opec_category:  cat,
        });

        // Conversa completa pro card (msgs do lead até agora)
        let conversationText = '';
        try {
            const msgs = await getMessages(conv.id, { limit: 100 });
            conversationText = msgs
                .filter(m => m.direction === 'inbound')
                .map(m => `[${new Date(m.created_at).toLocaleString('pt-BR')}] ${m.text || ''}`.trim())
                .filter(Boolean)
                .join('\n');
        } catch { /* segue */ }

        const gchatResult = await postOpecToGChat({
            category:         cat,
            lead:             { ...lead, classification: 'opec', opec_category: cat },
            conversationText,
            subject:          'Lead chegou via wa.me e foi auto-classificado pelo bot do site.',
        });

        const catLabel = OPEC_CATEGORIES[cat]?.label || 'OPEC';
        await botSend(conv, MSG_HANDOFF_OPEC(catLabel));
        // OPEC vai direto pra resolved (Q2.a confirmada com user)
        await updateConversation(conv.id, {
            status:    'resolved',
            bot_stage: 'human',
        });

        logger.info('Site bot routed lead to OPEC', {
            conv_id: conv.id, category: cat, gchat_ok: gchatResult.ok,
        });
        return { handled: true, newStage: 'human' };
    }

    // awaiting_commercial_details → handoff pra humano após 1 resposta
    if (stage === 'awaiting_commercial_details') {
        // Não importa o conteúdo — atendente vai ler tudo e classificar manual
        await botSend(conv, MSG_HANDOFF_COMMERCIAL);
        await updateConversation(conv.id, {
            status:    'waiting_human',
            bot_stage: 'human',
        });
        logger.info('Site bot handed off Commercial lead', { conv_id: conv.id });
        return { handled: true, newStage: 'human' };
    }

    // 'human' → bot já saiu, não responde
    return { handled: false, newStage: stage };
}

// Fallback: incrementa contador, manda msg de "não entendi". Após 3 tentativas
// desiste e entrega pra humano.
async function botFallback(conv, text) {
    const attempts = (conv.bot_attempts || 0) + 1;
    if (attempts >= MAX_BOT_ATTEMPTS) {
        await botSend(conv, MSG_HANDOFF_GIVEUP);
        await updateConversation(conv.id, {
            status:       'waiting_human',
            bot_stage:    'human',
            bot_attempts: attempts,
        });
        logger.info('Site bot gave up after max attempts', { conv_id: conv.id });
        return { handled: true, newStage: 'human' };
    }
    await botSend(conv, text);
    await updateConversation(conv.id, { bot_attempts: attempts });
    return { handled: true, newStage: conv.bot_stage };
}
