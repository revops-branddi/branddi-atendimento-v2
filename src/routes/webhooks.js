/**
 * Webhooks — Recebe leads do formulário do site
 * POST /api/webhook/form
 */
import { Router } from 'express';
import {
    createLead, createConversation, findLeadByPhone, normalizePhone
} from '../services/supabase.js';
import supabase from '../services/supabase.js';
import { startNewChat } from '../services/unipile.js';
import { queueLeadSync } from '../services/crm-sync.js';
import { pdGet, pdPut } from '../services/pipedrive.js';
import { syncLeadFromApollo } from './apollo.js';
import logger from '../services/logger.js';

const router = Router();

// ─── Webhook do formulário do site ────────────────────────────────────
router.post('/webhook/form', async (req, res) => {
    try {
        // Suporta múltiplos formatos (Typeform, RD Station, HTML form, etc.)
        const body = req.body || {};

        const name    = body.name || body.nome || body.full_name || body.Name || '';
        const email   = body.email || body.Email || '';
        const phone   = normalizePhone(body.phone || body.telefone || body.whatsapp || body.Phone || '');
        const company = body.company || body.empresa || body.company_name || '';
        const message = body.message || body.mensagem || body.description || '';

        // Origin metadata (UTMs, página, etc.)
        const origin_metadata = {
            utm_source:   body.utm_source   || body.UTM_SOURCE   || null,
            utm_medium:   body.utm_medium   || body.UTM_MEDIUM   || null,
            utm_campaign: body.utm_campaign || body.UTM_CAMPAIGN || null,
            page_url:     body.page_url     || body.url          || null,
            form_id:      body.form_id      || body.formId       || null,
            raw_message:  message || null,
            received_at:  new Date().toISOString(),
        };

        if (!phone && !email) {
            return res.status(400).json({ error: 'Pelo menos phone ou email é obrigatório' });
        }

        // Verifica se lead já existe (pelo telefone)
        let lead = phone ? await findLeadByPhone(phone) : null;

        if (!lead) {
            lead = await createLead({ name, phone, email, company_name: company, origin: 'form', origin_metadata });
            logger.info('Novo lead via formulário', { name, contact: phone || email });
        } else {
            logger.info('Lead existente encontrado', { name: lead.name, phone: lead.phone });
        }

        // Cria conversa no banco (sem chatId ainda — será vinculado quando o lead responder)
        const conversation = await createConversation({
            lead_id:  lead.id,
            channel:  'form',
            status:   'waiting',
            chatbot_stage: 'welcome', // Bot vai disparar a boas-vindas quando o lead contatar via WA
        });

        // Tenta iniciar conversa WhatsApp automaticamente se tem telefone
        let chatStarted = false;
        if (phone) {
            try {
                const waPhone = phone.startsWith('55') ? phone : `55${phone}`;
                const welcomeMsg =
                    `Olá${name ? `, ${name.split(' ')[0]}` : ''}! 👋 Recebemos seu contato através do site da *Branddi*.\n\n` +
                    `Para te direcionar ao time certo, me conta:\n\n` +
                    `1️⃣  Quero conhecer os serviços da Branddi\n` +
                    `2️⃣  Recebi uma notificação da Branddi\n` +
                    `3️⃣  Sou cliente e tenho uma dúvida`;

                const chatResult = await startNewChat(waPhone, welcomeMsg, null, {
                    leadId: lead.id,
                    conversationId: conversation.id,
                });
                const chatId = chatResult.chat_id || chatResult.id || chatResult.data?.id;

                if (chatId) {
                    // Atualiza conversa com chatId
                    const { updateConversation, saveMessage } = await import('../services/supabase.js');
                    await updateConversation(conversation.id, {
                        whatsapp_chat_id: chatId,
                        chatbot_stage: 'qualifying', // já enviou a pergunta
                    });
                    await saveMessage({
                        conversation_id: conversation.id,
                        direction: 'outbound',
                        sender_type: 'bot',
                        sender_name: 'Bot Branddi',
                        content: welcomeMsg,
                        unipile_message_id: `bot_form_${Date.now()}`,
                    });
                    chatStarted = true;
                }
            } catch (err) {
                logger.warn('Webhook: não foi possível iniciar chat WA', { error: err.message });
            }
        }

        // Enfileira sync com Pipedrive
        await queueLeadSync(lead.id, { origin: 'form', origin_metadata });

        res.json({
            success: true,
            lead_id: lead.id,
            conversation_id: conversation.id,
            whatsapp_started: chatStarted,
        });
    } catch (err) {
        logger.error('Webhook form error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// ─── Webhook genérico (para testes / integrações futuras) ─────────────
router.post('/webhook/test', (req, res) => {
    logger.info('Webhook test received', { body: req.body });
    res.json({ received: true, body: req.body });
});

// ─── Webhook Apollo: recebe número revelado (reveal_phone_number async) ─
// URL: /api/webhooks/apollo
//
// Apollo manda dois formatos:
//
//  (a) BULK (atual, 2026): { status, total_requested_enrichments, people: [{id, phone_numbers, ...}] }
//      → correlacionamos pelo apollo_id (people[].id) com result->person->>apollo_id
//
//  (b) LEGACY (antigo): { request_id, sanitized_number, ... } ou ?ref=<uuid> na query
//      → correlacionamos pelo apollo_request_id ou pelo ref direto
router.post('/webhooks/apollo', async (req, res) => {
    logger.info('Apollo webhook hit', {
        query: req.query,
        body_keys: Object.keys(req.body || {}),
        body_preview: JSON.stringify(req.body || {}).slice(0, 500),
        user_agent: req.headers['user-agent'],
        ip: req.headers['x-forwarded-for'] || req.ip,
    });

    const body = req.body || {};

    // ── Caminho A: bulk format (people[]) ─────────────────────────────
    if (Array.isArray(body.people) && body.people.length > 0) {
        const results = [];
        for (const person of body.people) {
            try {
                results.push(await processBulkPerson(person));
            } catch (err) {
                logger.error('Apollo bulk: erro processando person', { error: err.message, apolloId: person?.id });
                results.push({ apollo_id: person?.id, error: err.message });
            }
        }
        return res.json({ received: true, count: results.length, results });
    }

    // ── Caminho B: legacy single-payload ──────────────────────────────
    const ref = req.query?.ref;
    const apolloReqId =
        body.request_id
        || body.id
        || body?.phone_enrichment?.request_id
        || null;

    let row = null;
    try {
        if (ref) {
            const { data } = await supabase
                .from('apollo_enrichments')
                .select('ref, pipedrive_person_id, status')
                .eq('ref', ref)
                .maybeSingle();
            row = data;
        }
        if (!row && apolloReqId) {
            const { data } = await supabase
                .from('apollo_enrichments')
                .select('ref, pipedrive_person_id, status')
                .eq('apollo_request_id', apolloReqId)
                .maybeSingle();
            row = data;
        }
        if (!row) {
            logger.warn('Apollo webhook: ref/request_id desconhecido', { ref, apolloReqId });
            return res.status(404).json({ error: 'ref não encontrado' });
        }
        if (row.status !== 'pending') {
            logger.info('Apollo webhook: ref já processado', { ref, status: row.status });
            return res.json({ already_processed: true });
        }

        const phoneRaw =
            body.sanitized_number
            || body.phone_number
            || body?.contact?.sanitized_phone
            || body?.contact?.phone_numbers?.[0]?.sanitized_number
            || body?.contact?.phone_numbers?.[0]?.raw_number
            || body?.person?.phone_numbers?.[0]?.sanitized_number
            || body?.person?.phone_numbers?.[0]?.raw_number
            || null;

        if (!phoneRaw) {
            await supabase.from('apollo_enrichments')
                .update({ status: 'not_found', result: body, completed_at: new Date().toISOString() })
                .eq('ref', row.ref);
            logger.info('Apollo webhook: reveal sem número', { ref: row.ref });
            return res.json({ received: true, phone: null });
        }

        const pdUpdated = await persistApolloPhone(row.pipedrive_person_id, phoneRaw);
        await supabase.from('apollo_enrichments')
            .update({ status: 'completed', phone: phoneRaw, result: body, completed_at: new Date().toISOString() })
            .eq('ref', row.ref);

        logger.info('Apollo webhook: número salvo (legacy)', { ref: row.ref, phone: phoneRaw, pdUpdated });
        res.json({ received: true, phone: phoneRaw, pipedrive_updated: !!pdUpdated });
    } catch (err) {
        logger.error('Apollo webhook error', { ref, error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// Processa uma entrada do array people[] do payload bulk Apollo.
// Match: result->person->>apollo_id (gravado no momento do match) com person.id do webhook.
async function processBulkPerson(apolloPerson) {
    const apolloId = apolloPerson?.id;
    if (!apolloId) return { error: 'apollo person sem id' };

    // Pode haver várias linhas pending pro mesmo apollo_id (re-disparos manuais).
    // Pegamos a mais antiga ainda pending → cada webhook resolve uma; webhooks
    // subsequentes vão consumir as próximas em ordem.
    const { data: row } = await supabase
        .from('apollo_enrichments')
        .select('ref, pipedrive_person_id, status')
        .eq('result->person->>apollo_id', apolloId)
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();

    if (!row) {
        logger.warn('Apollo bulk: apollo_id sem row pending', { apolloId });
        return { apollo_id: apolloId, status: 'no_pending_row' };
    }

    const phoneRaw =
        apolloPerson?.phone_numbers?.[0]?.sanitized_number
        || apolloPerson?.phone_numbers?.[0]?.raw_number
        || null;

    if (!phoneRaw || apolloPerson.status === 'failure') {
        await supabase.from('apollo_enrichments')
            .update({
                status: 'not_found',
                result: { ...apolloPerson, _bulk: true },
                completed_at: new Date().toISOString(),
            })
            .eq('ref', row.ref);
        logger.info('Apollo bulk: reveal sem número', { ref: row.ref, apolloId });
        return { apollo_id: apolloId, ref: row.ref, status: 'no_phone' };
    }

    const pdUpdated = await persistApolloPhone(row.pipedrive_person_id, phoneRaw);

    await supabase.from('apollo_enrichments')
        .update({
            status: 'completed',
            phone: phoneRaw,
            result: { ...apolloPerson, _bulk: true },
            completed_at: new Date().toISOString(),
        })
        .eq('ref', row.ref);

    logger.info('Apollo bulk: número salvo', { ref: row.ref, apolloId, phone: phoneRaw, pdUpdated });
    return { apollo_id: apolloId, ref: row.ref, status: 'completed', phone: phoneRaw, pipedrive_updated: !!pdUpdated };
}

// Salva phone no Pipedrive (só se vazio) + sync Supabase lead. Retorna true se Pipedrive foi atualizado.
async function persistApolloPhone(pipedrivePersonId, phoneRaw) {
    try {
        const pd = await pdGet(`/persons/${pipedrivePersonId}`);
        const person = pd?.data;
        if (!person) return false;

        const hasPhone = (person.phone || []).some(p => p.value && String(p.value).length > 5);
        let updated = false;
        if (!hasPhone) {
            await pdPut(`/persons/${pipedrivePersonId}`, {
                phone: [{ value: phoneRaw, primary: true, label: 'mobile' }],
            });
            updated = true;
        }
        await syncLeadFromApollo(pipedrivePersonId, person, null, { includePhone: true, phone: phoneRaw });
        return updated;
    } catch (err) {
        logger.warn('Apollo: erro salvando phone no Pipedrive', { pipedrivePersonId, error: err.message });
        return false;
    }
}

export default router;
