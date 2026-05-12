-- Migration 016: Persiste falhas de envio em messages
--
-- Hoje quando o Unipile recusa um envio (ex: 422 invalid_recipient — número
-- sem WhatsApp ativo), o erro estoura no HTTP do POST /messages, o front
-- mostra o JSON cru, e a informação se perde. Não há registro do que
-- falhou nem por quê.
--
-- Esta migração adiciona campos pra:
--   1. Marcar a tentativa como falha (failed_at)
--   2. Capturar o motivo estruturado (failed_reason) — type + detail do
--      Unipile, ou outra causa
--
-- Mensagens falhas ficam em messages com unipile_message_id=NULL,
-- delivered=false, failed_at=timestamp, failed_reason='invalid_recipient'.
-- Permitem analisar padrões (quais leads/números falham mais) e UI melhor
-- (re-enviar / sugerir email).

ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS failed_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS failed_reason text;

-- Index parcial pra queries de "msgs que falharam"
CREATE INDEX IF NOT EXISTS idx_messages_failed
    ON messages(conversation_id, created_at DESC)
    WHERE failed_at IS NOT NULL;

COMMENT ON COLUMN messages.failed_at IS
    'Timestamp da falha no envio (Unipile rejeitou ou outro erro). NULL = envio teve sucesso ou ainda em andamento.';

COMMENT ON COLUMN messages.failed_reason IS
    'Motivo estruturado da falha — ex: "invalid_recipient", "unipile_4xx:type:detail", "no_chat_id". Lido pelo front pra mostrar mensagem amigável e pelo retry-worker pra decidir se vale re-tentar.';
