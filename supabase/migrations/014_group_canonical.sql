-- Migration 014: Consolida grupos WhatsApp em row única por JID (@g.us)
--
-- Problema: cada whatsapp_account que vê o mesmo grupo cria sua própria
-- conversation row (porque whatsapp_chat_id UNIQUE é per-account no Unipile).
-- Resultado: 2 contas Branddi no mesmo grupo = grupo aparece 2x no inbox,
-- com unread counts e estados de leitura divergentes.
--
-- Solução: chavear grupos por chat.provider_id (JID @g.us, globalmente único
-- entre contas) em vez de chat.id. Múltiplas contas vivem em
-- whatsapp_account_ids[]; whatsapp_chat_ids guarda { account_id: per_account_chat_id }
-- pra envio via Unipile (que segue precisando do chat.id per-account).
--
-- DMs não mudam: continuam chaveadas por whatsapp_chat_id UNIQUE.

-- ─── Colunas em conversations ─────────────────────────────────
ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS group_provider_id text,
    ADD COLUMN IF NOT EXISTS whatsapp_account_ids text[] DEFAULT '{}'::text[],
    ADD COLUMN IF NOT EXISTS whatsapp_chat_ids jsonb DEFAULT '{}'::jsonb;

-- ─── Coluna em messages ───────────────────────────────────────
-- Qual conta capturou a msg via webhook/polling. Em grupos com múltiplas
-- contas, dedupe natural ocorre pelo unipile_message_id UNIQUE — primeira
-- a chegar vence, demais retornam null em saveMessage.
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS via_account_id text;

-- ─── Índices ──────────────────────────────────────────────────
-- Unicidade canônica: 1 conversation por JID de grupo
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_group_provider
    ON conversations(group_provider_id)
    WHERE is_group = true AND group_provider_id IS NOT NULL;

-- GIN pra buscas "contém account_id" (usado por getInbox em grupos)
CREATE INDEX IF NOT EXISTS idx_conversations_account_ids
    ON conversations USING GIN (whatsapp_account_ids);

-- ─── Comentários ──────────────────────────────────────────────
COMMENT ON COLUMN conversations.group_provider_id IS
    'JID do grupo WhatsApp (formato XXXXX@g.us). Chave canônica única entre contas — mesmo grupo visto por N contas Branddi compartilha esta row. NULL pra DMs.';

COMMENT ON COLUMN conversations.whatsapp_account_ids IS
    'Contas Branddi que são membros deste grupo. Array porque grupo pode ter N contas Branddi simultaneamente. DMs usam só whatsapp_account_id (singular).';

COMMENT ON COLUMN conversations.whatsapp_chat_ids IS
    'Mapping { account_id: chat_id_unipile } pra envio. Cada conta tem seu próprio chat_id per-account no Unipile, mesmo apontando pro mesmo JID de grupo. Vazio pra DMs.';

COMMENT ON COLUMN messages.via_account_id IS
    'Conta Branddi que capturou esta mensagem. Em grupos com múltiplas contas, dedupe natural pelo unipile_message_id UNIQUE — primeira a chegar grava, demais viram null.';
