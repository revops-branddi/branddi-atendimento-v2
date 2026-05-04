/**
 * Messages Routes — Envio/recebimento e histórico de mensagens
 */
import { Router } from 'express';
import multer from 'multer';
import { getMessages, saveMessage, markMessagesRead, updateConversation, getLeadById } from '../services/supabase.js';
import { sendMessage, startNewChat, getAttachmentUrl, getMessageById, isAvailable as unipileAvailable } from '../services/unipile.js';
import whatsapp from '../providers/unipile.js';
import { applyScriptVariables } from '../services/script-variables.js';
import { onOutboundMessage } from '../services/auto-activities.js';
import supabase from '../services/supabase.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } }); // 16MB max

// ─── GET /api/messages/:conversationId — Histórico ────────────────────
router.get('/messages/:conversationId', async (req, res) => {
    try {
        const { limit = 50, before } = req.query;
        const messages = await getMessages(req.params.conversationId, {
            limit: parseInt(limit), before,
        });

        // Marca como lidas
        await markMessagesRead(req.params.conversationId).catch(() => {});

        res.json({ messages, total: messages.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/messages/:conversationId/send — Envia mensagem humana ──
router.post('/messages/:conversationId/send', async (req, res) => {
    try {
        const { text } = req.body;
        let { chatId } = req.body;
        if (!text) return res.status(400).json({ error: 'text é obrigatório' });

        // Se conversa não tem chatId (outbound novo), inicia chat via Unipile
        if (!chatId) {
            // Busca conversa e lead para pegar o telefone
            const { data: conv } = await supabase
                .from('conversations')
                .select('id, lead_id, whatsapp_chat_id, whatsapp_account_id')
                .eq('id', req.params.conversationId)
                .single();

            if (conv?.whatsapp_chat_id) {
                chatId = conv.whatsapp_chat_id;
            } else if (conv?.lead_id) {
                const lead = await getLeadById(conv.lead_id);
                if (lead?.phone) {
                    const whatsappPhone = lead.phone.startsWith('55') ? lead.phone : `55${lead.phone}`;

                    // Resolve qual conta WhatsApp usar pra enviar:
                    // 1. conversation.whatsapp_account_id (se já vinculada)
                    // 2. primeiro número permitido ao user logado
                    // 3. fallback no startNewChat (env / primeira ativa)
                    let sendAccountId = conv.whatsapp_account_id || null;
                    if (!sendAccountId && req.user?.permissions?.whatsapp_accounts?.length > 0) {
                        sendAccountId = req.user.permissions.whatsapp_accounts[0];
                    }

                    const chatResult = await startNewChat(whatsappPhone, text, sendAccountId, {
                        leadId: lead.id,
                        conversationId: req.params.conversationId,
                    });
                    chatId = chatResult?.id || chatResult?.chat_id;
                    if (chatId) {
                        // Marca a conta usada na conversa pra próximas msgs
                        const updates = { whatsapp_chat_id: chatId };
                        if (sendAccountId) updates.whatsapp_account_id = sendAccountId;
                        await updateConversation(req.params.conversationId, updates);
                    }

                    // Primeira msg já foi enviada pelo startNewChat, salvar e retornar
                    const startMsgId = chatResult?.message_id || `human_${Date.now()}_${Math.random().toString(36).slice(2)}`;
                    const msg = await saveMessage({
                        conversation_id:   req.params.conversationId,
                        direction:         'outbound',
                        sender_type:       'human',
                        sender_name:       req.user?.name || 'Atendente',
                        sent_by_user_id:   req.user?.id || null,
                        sent_by_name:      req.user?.name || null,
                        content:           text,
                        attachments:       [],
                        unipile_message_id: startMsgId,
                    });
                    await updateConversation(req.params.conversationId, {
                        chatbot_stage: 'human', status: 'in_progress',
                        last_message_at: new Date().toISOString(),
                        assigned_user_id: req.user?.id || null,
                    });
                    // Auto-create WhatsApp activity in Pipedrive (fire and forget)
                    onOutboundMessage(req.params.conversationId, req.user?.id).catch(() => {});
                    return res.json({ success: true, message: msg, chat_started: true });
                }
            }
            if (!chatId) return res.status(400).json({ error: 'Sem chatId e sem telefone para iniciar conversa' });
        }

        // Envia via Unipile e captura ID real para deduplicação
        const sendResult = await sendMessage(chatId, text);
        const realMsgId = sendResult?.message_id || sendResult?.id || `human_${Date.now()}_${Math.random().toString(36).slice(2)}`;

        // Salva no banco com rastreio do remetente
        const msg = await saveMessage({
            conversation_id:   req.params.conversationId,
            direction:         'outbound',
            sender_type:       'human',
            sender_name:       req.user?.name || 'Atendente',
            sent_by_user_id:   req.user?.id || null,
            sent_by_name:      req.user?.name || null,
            content:           text,
            attachments:       [],
            unipile_message_id: realMsgId,
        });

        // Garante que a conversa está em modo humano + auto-atribui ao usuário
        await updateConversation(req.params.conversationId, {
            chatbot_stage: 'human',
            status: 'in_progress',
            last_message_at: new Date().toISOString(),
            assigned_user_id: req.user?.id || null,
        });

        // Auto-create WhatsApp activity in Pipedrive (fire and forget)
        onOutboundMessage(req.params.conversationId, req.user?.id).catch(() => {});

        res.json({ success: true, message: msg });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/messages/:conversationId/script — Aplica script ────────
router.post('/messages/:conversationId/script', async (req, res) => {
    try {
        const { script_content, chatId, lead_id } = req.body;
        if (!script_content) return res.status(400).json({ error: 'script_content é obrigatório' });
        if (!chatId) return res.status(400).json({ error: 'chatId é obrigatório' });

        // Busca lead para aplicar variáveis
        let lead = null;
        if (lead_id) {
            lead = await getLeadById(lead_id).catch(() => null);
        }

        // Aplica variáveis no script
        const text = applyScriptVariables(script_content, lead);

        // Envia via Unipile
        await sendMessage(chatId, text);

        // Salva no banco com rastreio do remetente
        const msg = await saveMessage({
            conversation_id:   req.params.conversationId,
            direction:         'outbound',
            sender_type:       'human',
            sender_name:       req.user?.name || 'Atendente',
            sent_by_user_id:   req.user?.id || null,
            sent_by_name:      req.user?.name || null,
            content:           text,
            attachments:       [],
            unipile_message_id: `script_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        });

        await updateConversation(req.params.conversationId, {
            chatbot_stage: 'human',
            status: 'in_progress',
            last_message_at: new Date().toISOString(),
            assigned_user_id: req.user?.id || null,
        });

        // Auto-create WhatsApp activity in Pipedrive (fire and forget)
        onOutboundMessage(req.params.conversationId, req.user?.id).catch(() => {});

        res.json({ success: true, message: msg, applied_text: text });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/messages/:conversationId/send-media — Envia mensagem com mídia
router.post('/messages/:conversationId/send-media', upload.single('file'), async (req, res) => {
    try {
        const text = req.body.text || '';
        let chatId = req.body.chatId || null;
        const file = req.file;

        if (!file && !text) return res.status(400).json({ error: 'Texto ou arquivo é obrigatório' });
        if (!chatId) {
            // Resolve chatId da conversa
            const { data: conv } = await supabase
                .from('conversations')
                .select('whatsapp_chat_id')
                .eq('id', req.params.conversationId)
                .single();
            chatId = conv?.whatsapp_chat_id;
        }
        if (!chatId) return res.status(400).json({ error: 'Conversa sem chat WhatsApp vinculado' });

        // Envia via Unipile com attachment e captura ID real
        const mediaResult = await sendMessage(chatId, text || null, file?.buffer, file?.originalname);
        const realUnipileId = mediaResult?.message_id || mediaResult?.id || null;
        const mediaMsgId = realUnipileId || `media_${Date.now()}_${Math.random().toString(36).slice(2)}`;

        // O POST /messages só devolve o message_id. Pra resgatar att.id (e
        // habilitar a preview imediatamente), buscamos a msg completa via
        // GET /messages/:id e normalizamos os attachments. Best-effort: se
        // falhar (ex: Unipile ainda não indexou), caímos pro metadado básico
        // e o polling reconcilia depois.
        let attachments = [];
        if (file) {
            const fallback = { name: file.originalname, mime_type: file.mimetype, size: file.size };
            attachments = [fallback];
            // Unipile leva ~1–2s pra indexar a msg recém-enviada. Tentamos com
            // backoff curto pra capturar att.id (renderiza preview imediato).
            // Se mesmo com retries não vier, o polling reconcilia depois.
            if (realUnipileId) {
                const delays = [400, 900, 1500];
                for (const wait of delays) {
                    await new Promise(r => setTimeout(r, wait));
                    try {
                        const detail = await getMessageById(realUnipileId);
                        const norm = detail ? whatsapp.normalizeMessage(detail) : null;
                        const hasId = norm?.attachments?.some(a => a.id);
                        if (hasId) { attachments = norm.attachments; break; }
                    } catch { /* tenta de novo */ }
                }
            }
        }

        const msg = await saveMessage({
            conversation_id:    req.params.conversationId,
            direction:          'outbound',
            sender_type:        'human',
            sender_name:        req.user?.name || 'Atendente',
            sent_by_user_id:    req.user?.id || null,
            sent_by_name:       req.user?.name || null,
            content:            text || (file && !file.mimetype?.startsWith('image/') ? `📎 ${file.originalname}` : ''),
            attachments,
            unipile_message_id: mediaMsgId,
        });

        await updateConversation(req.params.conversationId, {
            chatbot_stage: 'human',
            status: 'in_progress',
            last_message_at: new Date().toISOString(),
            assigned_user_id: req.user?.id || null,
        });

        onOutboundMessage(req.params.conversationId, req.user?.id).catch(() => {});

        res.json({ success: true, message: msg });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/messages/:conversationId/note — Salva anotação interna ────
router.post('/messages/:conversationId/note', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text?.trim()) return res.status(400).json({ error: 'text é obrigatório' });

        const msg = await saveMessage({
            conversation_id:    req.params.conversationId,
            direction:          'outbound',
            sender_type:        'note',
            sender_name:        req.user?.name || 'Nota',
            sent_by_user_id:    req.user?.id || null,
            sent_by_name:       req.user?.name || null,
            content:            text.trim(),
            attachments:        [],
            unipile_message_id: `note_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        });

        res.json({ success: true, message: msg });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DEBUG (temporário): inspeciona o que Unipile devolve em GET /messages/:id
router.get('/debug/unipile-msg/:id', async (req, res) => {
    if (req.user?.role !== 'Admin') return res.status(403).end();
    try {
        const detail = await getMessageById(req.params.id);
        const norm = detail ? whatsapp.normalizeMessage(detail) : null;
        res.json({ raw: detail, normalized: norm });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/attachments/:messageId/:attId — Proxy para mídia do Unipile
// Usa o endpoint message-scoped /api/v1/messages/:msgId/attachments/:attId
// (suporta sticker/image/video/audio que vêm como attachments[] em raw,
// mesmo quando Unipile diz "cannot display this type" no campo text).
router.get('/attachments/:messageId/:attId', async (req, res) => {
    try {
        if (!unipileAvailable()) return res.status(503).json({ error: 'Unipile não configurado' });
        const dsn = process.env.UNIPILE_DSN;
        const key = process.env.UNIPILE_API_KEY;
        const url = `https://${dsn}/api/v1/messages/${encodeURIComponent(req.params.messageId)}/attachments/${encodeURIComponent(req.params.attId)}`;

        const upstream = await fetch(url, { headers: { 'X-API-KEY': key } });
        if (!upstream.ok) return res.status(upstream.status).json({ error: 'Falha ao buscar attachment' });

        res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
        res.setHeader('Cache-Control', 'private, max-age=86400');
        res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
