-- Migration 015: Flag pra ignorar contas WhatsApp de outros times/apps
--
-- Contexto: o DSN Unipile da Branddi tem contas conectadas que pertencem a
-- outros times/apps (ex: SDR de outra unidade). O polling listChats puxa
-- TUDO desse DSN sem filtro de account, então essas contas vazavam pro
-- Atendimento-v2 sem owner resolvível (sem display_label nem permission),
-- aparecendo como conversas "sem tag de atendente" no inbox.
--
-- Solução: flag `ignored` no whatsapp_accounts. Polling pula, webhook
-- ignora, getInbox filtra. NÃO desconecta a conta no Unipile (continua
-- válida pro outro time).

ALTER TABLE whatsapp_accounts
    ADD COLUMN IF NOT EXISTS ignored boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_whatsapp_accounts_ignored
    ON whatsapp_accounts(unipile_account_id) WHERE ignored = true;

COMMENT ON COLUMN whatsapp_accounts.ignored IS
    'Conta existe no Unipile mas pertence a outro time/app — não deve aparecer no Atendimento-v2. Polling pula chats, webhook ignora eventos, getInbox/getGroups filtram. NÃO afeta a conta no Unipile (continua válida).';
