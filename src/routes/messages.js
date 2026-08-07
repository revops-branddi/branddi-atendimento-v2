/**
 * Messages Routes — Envio/recebimento e histórico de mensagens
 */
import { Router } from 'express';
import multer from 'multer';
import { getMessages, saveMessage, markMessagesRead, updateConversation, getLeadById } from '../services/supabase.js';
import { sendMessage, startNewChat, getAttachmentUrl, getMessageById, isAvailable as unipileAvailable, pickSendAccount, UnipileError } from '../services/unipile.js';
import whatsapp from '../providers/unipile.js';
import { applyScriptVariables } from '../services/script-variables.js';
import { onOutboundMessage } from '../services/auto-activities.js';
import supabase from '../services/supabase.js';
import { downloadObject, createUploadUrl } from '../services/storage.js';

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

// Mapeia erro do Unipile pra response amigável + reason curto pra persistir.
// Retorna { httpStatus, payload, failedReason } pra caller decidir.
function mapSendError(err, context = {}) {
    if (err instanceof UnipileError) {
        const type = err.unipileType || '';
        const detail = err.unipileDetail || '';
        // Casos conhecidos com mensagem amigável pt-BR
        if (type === 'errors/invalid_recipient') {
            return {
                httpStatus: 422,
                failedReason: 'invalid_recipient',
                payload: {
                    error: 'Esse número não tem WhatsApp ativo (ou o perfil não está mais acessível). Tente outro canal — email/LinkedIn — ou confirme o número no Pipedrive.',
                    error_code: 'invalid_recipient',
                    unipile_detail: detail,
                    ...context,
                },
            };
        }
        // 4xx genérico do Unipile — preserva o detalhe estruturado
        return {
            httpStatus: err.status >= 400 && err.status < 500 ? err.status : 502,
            failedReason: `unipile_${err.status}${type ? ':' + type : ''}`,
            payload: {
                error: detail || err.unipileTitle || `Unipile retornou erro (${err.status}). Tente novamente em alguns minutos.`,
                error_code: 'unipile_error',
                unipile_status: err.status,
                unipile_type: type,
                unipile_detail: detail,
                ...context,
            },
        };
    }
    // Erro não-Unipile (rede, etc)
    return {
        httpStatus: 500,
        failedReason: 'internal',
        payload: { error: err.message || 'Erro interno ao enviar.', error_code: 'internal', ...context },
    };
}

// Grava a tentativa falha em messages pra histórico/análise. Tolerante a
// duplicata (mesmo content pode ser re-tentado) usando timestamp no ID local.
async function recordFailedSend({ conversationId, user, text, failedReason }) {
    try {
        await saveMessage({
            conversation_id:    conversationId,
            direction:          'outbound',
            sender_type:        'human',
            sender_name:        user?.name || 'Atendente',
            sent_by_user_id:    user?.id || null,
            sent_by_name:       user?.name || null,
            content:            text,
            attachments:        [],
            unipile_message_id: `failed_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            failed_at:          new Date().toISOString(),
            failed_reason:      failedReason,
            delivered:          false,
        });
    } catch (e) {
        // Não bloqueia a response do erro original
    }
}

// ─── POST /api/messages/:conversationId/send — Envia mensagem humana ──
router.post('/messages/:conversationId/send', async (req, res) => {
    const { text, whatsapp_account_id: overrideAccountId } = req.body;
    let { chatId } = req.body;
    if (!text) return res.status(400).json({ error: 'text é obrigatório' });

    // Valida override de conta WA (quando user multi-conta escolhe persona).
    // Admin pode usar qualquer; outros só as próprias permissions.
    if (overrideAccountId) {
        const isAdmin = req.user?.role === 'Admin';
        const allowed = req.user?.permissions?.whatsapp_accounts || [];
        if (!isAdmin && !allowed.includes(overrideAccountId)) {
            return res.status(403).json({
                error: 'Você não tem acesso a essa conta WhatsApp.',
            });
        }
    }

    try {
        // Se conversa não tem chatId (outbound novo), inicia chat via Unipile
        if (!chatId) {
            // Busca conversa e lead para pegar o telefone
            const { data: conv } = await supabase
                .from('conversations')
                .select('id, lead_id, whatsapp_chat_id, whatsapp_account_id, is_group, whatsapp_account_ids, whatsapp_chat_ids')
                .eq('id', req.params.conversationId)
                .single();

            // Grupo canônico: chat_id é per-conta. Escolhe a conta de envio
            // pela cascata em pickSendAccount (user permission → configurada → fallback).
            if (conv?.is_group) {
                const picked = await pickSendAccount(conv, req.user);
                if (!picked?.chatId) {
                    return res.status(400).json({
                        error: 'Grupo sem chat_id de envio resolvido — possivelmente nenhuma conta Branddi membro.'
                    });
                }
                chatId = picked.chatId;
            // Troca de emissor: quando o atendente escolhe uma conta DIFERENTE da
            // que a conversa ja usa, o chat existente nao serve — cada conta tem
            // um chat proprio com o mesmo lead. Cair no ramo de startNewChat abre
            // (ou reencontra) o chat na conta nova e reamarra a conversa nas
            // linhas abaixo. Sem esta condicao, o override era silenciosamente
            // ignorado e a mensagem saia pelo numero antigo.
            } else if (conv?.whatsapp_chat_id
                       && !(overrideAccountId && overrideAccountId !== conv.whatsapp_account_id)) {
                chatId = conv.whatsapp_chat_id;
            } else if (conv?.lead_id) {
                const lead = await getLeadById(conv.lead_id);
                if (lead?.phone) {
                    const whatsappPhone = lead.phone.startsWith('55') ? lead.phone : `55${lead.phone}`;

                    // Resolve qual conta WhatsApp usar pra enviar:
                    // 1. override explícito no body (picker do front)
                    // 2. conversation.whatsapp_account_id (já vinculada antes)
                    // 3. primeiro número permitido ao user logado
                    // 4. fallback no startNewChat (env / primeira ativa)
                    let sendAccountId = overrideAccountId || conv.whatsapp_account_id || null;
                    if (!sendAccountId && req.user?.permissions?.whatsapp_accounts?.length > 0) {
                        sendAccountId = req.user.permissions.whatsapp_accounts[0];
                    }

                    // IMPORTANTE: chamar startNewChat ANTES de qualquer
                    // updateConversation/saveMessage. Se o Unipile rejeitar
                    // (ex: 422 invalid_recipient), o catch externo grava
                    // failed_reason e retorna pro front sem deixar conversation
                    // órfã (whatsapp_chat_id=null). Comportamento anterior
                    // criava lixo no DB a cada tentativa falha.
                    let chatResult;
                    try {
                        chatResult = await startNewChat(whatsappPhone, text, sendAccountId, {
                            leadId: lead.id,
                            conversationId: req.params.conversationId,
                        });
                    } catch (err) {
                        const { httpStatus, payload, failedReason } = mapSendError(err, { stage: 'start_new_chat' });
                        await recordFailedSend({
                            conversationId: req.params.conversationId,
                            user: req.user, text, failedReason,
                        });
                        return res.status(httpStatus).json(payload);
                    }

                    chatId = chatResult?.id || chatResult?.chat_id;
                    if (!chatId) {
                        await recordFailedSend({
                            conversationId: req.params.conversationId,
                            user: req.user, text, failedReason: 'no_chat_id',
                        });
                        return res.status(502).json({
                            error: 'Unipile não retornou chat_id válido. Tente novamente em alguns minutos.',
                            error_code: 'no_chat_id',
                        });
                    }

                    // Sucesso — marca a conta usada na conversa pra próximas msgs
                    const updates = { whatsapp_chat_id: chatId };
                    if (sendAccountId) updates.whatsapp_account_id = sendAccountId;
                    await updateConversation(req.params.conversationId, updates);

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

        // Envia via Unipile e captura ID real para deduplicação.
        // Erros do Unipile (ex: 422) capturados pelo catch externo.
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
        const { httpStatus, payload, failedReason } = mapSendError(err, { stage: 'send_message' });
        await recordFailedSend({
            conversationId: req.params.conversationId,
            user: req.user, text, failedReason,
        });
        res.status(httpStatus).json(payload);
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

// ─── POST /api/messages/upload-url — URL assinada pro upload direto ──
//
// O browser sobe o arquivo direto pro Storage e depois chama send-media com a
// chave. Assim o binario nunca transita pelo corpo da request, que na Vercel
// e' limitado a 4,5 MB — teto que os diagnosticos comerciais ja ultrapassam.
router.post('/messages/upload-url', async (req, res) => {
    try {
        const { file_name } = req.body || {};
        const r = await createUploadUrl(file_name);
        res.json(r);
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

        // Duas origens de midia, normalizadas num objeto so':
        //   - multipart (`file`): caminho antigo, ainda usado no Railway
        //   - `storage_key`: caminho novo, o browser subiu direto pro Supabase
        //     Storage e mandou so' a chave — contorna o teto de 4,5 MB de corpo
        //     de request da Vercel, que bloquearia os diagnosticos comerciais.
        let midia = null;
        if (file) {
            midia = {
                buffer:   file.buffer,
                name:     file.originalname,
                mimeType: file.mimetype,
                size:     file.size,
            };
        } else if (req.body.storage_key) {
            const baixado = await downloadObject(req.body.storage_key);
            midia = {
                buffer:   baixado.buffer,
                name:     baixado.fileName,
                mimeType: req.body.mime_type || 'application/octet-stream',
                size:     baixado.buffer.length,
            };
        }

        if (!midia && !text) return res.status(400).json({ error: 'Texto ou arquivo é obrigatório' });
        if (!chatId) {
            // Resolve chatId da conversa. Grupos canônicos exigem cascata
            // pickSendAccount pra resolver qual conta envia (chat_id é per-conta).
            const { data: conv } = await supabase
                .from('conversations')
                .select('whatsapp_chat_id, is_group, whatsapp_account_ids, whatsapp_chat_ids')
                .eq('id', req.params.conversationId)
                .single();
            if (conv?.is_group) {
                const picked = await pickSendAccount(conv, req.user);
                chatId = picked?.chatId || null;
            } else {
                chatId = conv?.whatsapp_chat_id;
            }
        }
        if (!chatId) return res.status(400).json({ error: 'Conversa sem chat WhatsApp vinculado' });

        // Envia via Unipile com attachment e captura ID real
        const mediaResult = await sendMessage(chatId, text || null, midia?.buffer, midia?.name);
        const realUnipileId = mediaResult?.message_id || mediaResult?.id || null;
        const mediaMsgId = realUnipileId || `media_${Date.now()}_${Math.random().toString(36).slice(2)}`;

        // O POST /messages só devolve o message_id. Pra resgatar att.id (e
        // habilitar a preview imediatamente), buscamos a msg completa via
        // GET /messages/:id e normalizamos os attachments. Best-effort: se
        // falhar (ex: Unipile ainda não indexou), caímos pro metadado básico
        // e o polling reconcilia depois.
        // Save com fallback de attachments. O attachment id real vem do Unipile
        // de forma assíncrona (>3s pra indexar), então kickamos um backfill em
        // background que atualiza a row quando o att.id estiver disponível.
        const attachments = midia ? [{
            name: midia.name,
            mime_type: midia.mimeType,
            size: midia.size,
        }] : [];

        const msg = await saveMessage({
            conversation_id:    req.params.conversationId,
            direction:          'outbound',
            sender_type:        'human',
            sender_name:        req.user?.name || 'Atendente',
            sent_by_user_id:    req.user?.id || null,
            sent_by_name:       req.user?.name || null,
            content:            text || (midia && !midia.mimeType?.startsWith('image/') ? `📎 ${midia.name}` : ''),
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

        // Background: assim que o Unipile indexar a msg, baixa attachments[].id
        // do detalhe e atualiza a row local. Tenta a cada 2s por até 20s.
        if (msg && midia && realUnipileId) {
            (async () => {
                for (let i = 0; i < 10; i++) {
                    await new Promise(r => setTimeout(r, 2000));
                    try {
                        const detail = await getMessageById(realUnipileId);
                        const norm = detail ? whatsapp.normalizeMessage(detail) : null;
                        const enriched = norm?.attachments?.find(a => a.id);
                        if (enriched) {
                            await supabase
                                .from('messages')
                                .update({ attachments: norm.attachments })
                                .eq('id', msg.id);
                            return;
                        }
                    } catch { /* retry */ }
                }
            })();
        }

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
