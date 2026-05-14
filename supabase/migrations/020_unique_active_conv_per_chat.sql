-- Migration 020: blinda site.conversations contra duplicação por race.
--
-- Cenário do bug: Railway com 2 workers/replicas rodando o polling.
-- Cada tick (10s), ambos chamavam processChat pro mesmo chat sem conv
-- local, ambos faziam findConversationByChat → null, ambos chamavam
-- createConversation. Resultado: 2 convs idênticas (~300ms apart) com
-- mesmo whatsapp_chat_id, vazias ou com as mesmas msgs.
--
-- Solução: UNIQUE PARTIAL index em whatsapp_chat_id restrito a status
-- ativos. Permite manter no DB convs antigas (status='resolved') do
-- mesmo chat — útil pra histórico de leads que retornam tempos depois.
-- Mas só 1 conv ATIVA (bot/waiting_human/in_progress) por chat.
--
-- Reverter:
--   DROP INDEX IF EXISTS site.uniq_active_conv_per_chat;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_conv_per_chat
    ON site.conversations (whatsapp_chat_id)
    WHERE status IN ('bot', 'waiting_human', 'in_progress');
