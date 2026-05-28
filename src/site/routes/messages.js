import { Router } from 'express';
import multer from 'multer';
import sb from '../services/db.js';
import {
    getMessages,
    insertOutboundMessage,
    updateConversation,
    getConversationChatInfo,
} from '../services/supabase.js';
import * as unipile from '../services/unipile.js';
import logger from '../../services/logger.js';

const router = Router();

// Memória, 16MB max — mesmo limite do prospecção (src/routes/messages.js).
// Unipile/WhatsApp aceita ~25MB pra docs e ~16MB pra imagem/vídeo. Mantemos
// o teto conservador.
const upload = multer({
    storage: multer.memoryStorage(),
    limits:  { fileSize: 16 * 1024 * 1024 },
});

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

// ─── POST /messages/:conversationId/send-media ─────────────────────────
// Upload de arquivo/imagem/áudio. Aceita multipart com `file` + opcional
// `text` (caption). Backfill de attachment.id roda em background pra
// habilitar preview ler (Unipile leva ~3s pra indexar a msg).
router.post('/messages/:conversationId/send-media', upload.single('file'), async (req, res) => {
    try {
        const text = req.body.text || '';
        const file = req.file;

        if (!file && !text.trim()) {
            return res.status(400).json({ error: 'Texto ou arquivo é obrigatório' });
        }

        const conv = await getConversationChatInfo(req.params.conversationId);
        if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });
        if (!conv.whatsapp_chat_id) {
            return res.status(400).json({ error: 'Conversa sem whatsapp_chat_id' });
        }

        // Envia pro Unipile com attachment
        let upResult;
        try {
            upResult = await unipile.sendMessage(
                conv.whatsapp_chat_id,
                text || null,
                file?.buffer,
                file?.originalname,
            );
        } catch (err) {
            logger.warn('site send-media Unipile falhou', { error: err.message, conv: conv.id });
            return res.status(502).json({ error: `Falha no Unipile: ${err.message}` });
        }

        const realUnipileId = upResult?.message_id || upResult?.id || null;
        const placeholderId = realUnipileId
            || `media_${Date.now()}_${Math.random().toString(36).slice(2)}`;

        // Persistência inicial: name/mime/size sem o att.id real (que vem
        // assíncrono via getMessageById). Frontend mostra placeholder até
        // backfill pegar o id.
        const initialAttachments = file ? [{
            name:      file.originalname,
            mime_type: file.mimetype,
            size:      file.size,
        }] : [];

        const inserted = await insertOutboundMessage({
            conversationId:   conv.id,
            text:             text || (file && !file.mimetype?.startsWith('image/') ? `📎 ${file.originalname}` : ''),
            unipileMessageId: placeholderId,
            senderUserId:     req.user?.id || null,
            senderName:       req.user?.name || null,
            attachments:      initialAttachments,
        });

        // Patch do estado da conversa: bot fora, atendente dono, last_message_at.
        const patch = { last_message_at: new Date().toISOString() };
        if (conv.status === 'waiting_human') patch.status = 'in_progress';
        if (conv.status === 'bot') {
            patch.status    = 'in_progress';
            patch.bot_stage = 'human';
        }
        if (req.user?.id) patch.assigned_user_id = req.user.id;
        await updateConversation(conv.id, patch);

        // Backfill em background: tenta a cada 2s por até 20s pegar o
        // attachment.id real do Unipile (necessário pra /api/site/attachments
        // proxy carregar a mídia).
        if (file && realUnipileId) {
            (async () => {
                for (let i = 0; i < 10; i++) {
                    await new Promise(r => setTimeout(r, 2000));
                    try {
                        const detail = await unipile.getMessageById(realUnipileId);
                        const atts   = detail?.attachments || [];
                        const enriched = atts.find(a => a.id);
                        if (enriched) {
                            await sb.from('v_site_messages')
                                .update({ attachments: atts.map(a => ({
                                    id:        a.id,
                                    name:      a.name || a.file_name || file.originalname,
                                    mime_type: a.mime_type || a.mimetype || file.mimetype,
                                    size:      a.size || file.size,
                                    type:      a.type,
                                })) })
                                .eq('id', inserted.id);
                            return;
                        }
                    } catch { /* retry silencioso */ }
                }
            })();
        }

        res.json(inserted);
    } catch (err) {
        logger.error('site POST /messages/:id/send-media', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /attachments/:messageId/:attId — Proxy pra mídia do Unipile ───
// Mesmo padrão do /api/attachments do prospecção, mas com auth do site
// (já que /api/site/* tem requireSiteAccess no server.js).
router.get('/attachments/:messageId/:attId', async (req, res) => {
    try {
        const dsn = process.env.UNIPILE_DSN;
        const key = process.env.UNIPILE_API_KEY;
        if (!dsn || !key) return res.status(503).json({ error: 'Unipile não configurado' });

        const url = `https://${dsn}/api/v1/messages/${encodeURIComponent(req.params.messageId)}/attachments/${encodeURIComponent(req.params.attId)}`;
        const upRes = await fetch(url, { headers: { 'X-API-KEY': key } });
        if (!upRes.ok) {
            return res.status(upRes.status).json({ error: `Unipile ${upRes.status}` });
        }
        // Repassa o stream + content-type
        const ct = upRes.headers.get('content-type');
        if (ct) res.setHeader('content-type', ct);
        const buf = Buffer.from(await upRes.arrayBuffer());
        res.send(buf);
    } catch (err) {
        logger.warn('site GET /attachments proxy', { error: err.message });
        res.status(500).json({ error: 'Erro ao baixar mídia' });
    }
});

export default router;
