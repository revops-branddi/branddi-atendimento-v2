-- Migration 008: site flow — remove bot defaults.
-- Decisão: o atendimento do site é 100% humano (sem chatbot/auto-reply).
-- O CHECK de bot_stage e o default 'bot' do status criam ruído na UI sem
-- ganho. Mantemos as colunas (bot_stage, bot_answers) só pra não quebrar
-- selects antigos, mas:
--   - status default vira 'waiting_human'
--   - bot_stage perde CHECK e default
--
-- Reverter:
--   ALTER TABLE site.conversations ALTER COLUMN status SET DEFAULT 'bot';
--   ALTER TABLE site.conversations ALTER COLUMN bot_stage SET DEFAULT 'welcome';
--   ALTER TABLE site.conversations ADD CONSTRAINT site_conversations_bot_stage_check
--       CHECK (bot_stage IN ('welcome','qualifying','classified','human'));
--   ALTER TABLE site.conversations DROP CONSTRAINT site_conversations_status_check;
--   ALTER TABLE site.conversations ADD CONSTRAINT site_conversations_status_check
--       CHECK (status IN ('bot','waiting_human','in_progress','resolved'));

-- 1) Status: tira 'bot' do CHECK, default vira 'waiting_human'.
ALTER TABLE site.conversations DROP CONSTRAINT IF EXISTS site_conversations_status_check;
ALTER TABLE site.conversations
    ADD CONSTRAINT site_conversations_status_check
    CHECK (status IN ('waiting_human', 'in_progress', 'resolved'));

ALTER TABLE site.conversations ALTER COLUMN status SET DEFAULT 'waiting_human';

-- Migra rows existentes em 'bot' pra 'waiting_human' (na prática zero rows na fase 2,
-- mas idempotente garante que rerodar a migration em qualquer estado funcione).
UPDATE site.conversations SET status = 'waiting_human' WHERE status = 'bot';

-- 2) bot_stage: tira CHECK e default. Coluna fica nullable, sem semântica.
ALTER TABLE site.conversations DROP CONSTRAINT IF EXISTS site_conversations_bot_stage_check;
ALTER TABLE site.conversations ALTER COLUMN bot_stage DROP DEFAULT;

-- 3) Index pra fila do atendente: status + last_message_at desc.
CREATE INDEX IF NOT EXISTS idx_site_conv_status_recent
    ON site.conversations(status, last_message_at DESC NULLS LAST);
