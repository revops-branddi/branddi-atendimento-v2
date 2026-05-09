import { Router } from 'express';
import {
    getMessages,
    insertOutboundMessage,
    updateConversation,
    getConversationChatInfo,
} from '../services/supabase.js';
import * as unipile from '../services/unipile.js';
import logger from '../../services/logger.js';

const router = Router();

// ─── GET /messages/:conversationId ───────────────────────────────────
router.get('/messages/:conversationId', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
        const msgs  = await getMessages(req.params.conversationId, { limit });
        res.json(msgs);
    } catch (err) {
        logger.warn('site GET /messages/:conversationId', { error: err.message });
        res.status(500).json({ error: 'Erro ao buscar mensagens' });
    }
});

// ─── POST /messages/:conversationId ──────────────────────────────────
// Envia mensagem outbound humana via Unipile e persiste no schema site.
//
// Estratégia: chama o Unipile primeiro. Só persiste a mensagem se o envio
// foi aceito — assim o histórico nunca mostra mensagem "fantasma" que o
// destinatário não recebeu. O `unipile_message_id` retornado é gravado pra
// que o polling subsequente atualize delivered/seen sem duplicar.
router.post('/messages/:conversationId', async (req, res) => {
    try {
        const { text } = req.body || {};
        if (!text || !text.trim()) {
            return res.status(400).json({ error: 'text obrigatório' });
        }
        const conv = await getConversationChatInfo(req.params.conversationId);
        if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });
        if (!conv.whatsapp_chat_id) {
            return res.status(400).json({ error: 'Conversa sem whatsapp_chat_id — não é possível enviar' });
        }

        let upResult;
        try {
            upResult = await unipile.sendMessage(conv.whatsapp_chat_id, text);
        } catch (err) {
            logger.warn('site Unipile sendMessage falhou', { error: err.message, conv: conv.id });
            return res.status(502).json({ error: `Falha no Unipile: ${err.message}` });
        }

        const unipileMessageId = upResult?.message_id || upResult?.id || null;

        const inserted = await insertOutboundMessage({
            conversationId:   conv.id,
            text:             text.trim(),
            unipileMessageId,
            senderUserId:     req.user?.id || null,
            senderName:       req.user?.name || null,
        });

        // Primeira resposta humana → tira da fila de espera.
        // Se atendente enviar manualmente em conv ainda no bot, força saída
        // do bot (status='in_progress', bot_stage='human') — atendente tomou
        // o controle.
        const patch = { last_message_at: new Date().toISOString() };
        if (conv.status === 'waiting_human') patch.status = 'in_progress';
        if (conv.status === 'bot') {
            patch.status    = 'in_progress';
            patch.bot_stage = 'human';
        }
        if (!req.body?._skipAssign && req.user?.id) patch.assigned_user_id = req.user.id;
        await updateConversation(conv.id, patch);

        res.json(inserted);
    } catch (err) {
        logger.error('site POST /messages', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

export default router;
