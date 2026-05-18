-- Migration 021: Classifica contas WhatsApp como pessoal vs virtual
--
-- Motivação: hoje a UI tem 2 fluxos misturados:
--   1. Conta pessoal (ex: Juliana, Miriam) — 1 atendente dono, métricas individuais
--   2. Conta virtual (ex: Ricardo, Gio — SDR IA) — sem dono real, operada por
--      vários users, fora das métricas individuais
--
-- Antes desta migration, distinguir os dois exigia inferir de
-- `connected_by_user_id IS NULL` + `excluded_from_metrics=true`, regra frágil.
-- Tornamos a intenção explícita com uma coluna enum text com CHECK.
--
-- Uso típico:
--   SELECT * FROM whatsapp_accounts WHERE account_type = 'virtual';
--   - Pessoal: connected_by_user_id NOT NULL, excluded_from_metrics=false
--   - Virtual: connected_by_user_id = admin "técnico", excluded_from_metrics=true,
--              display_label obrigatório (validação no app, não no schema)

ALTER TABLE whatsapp_accounts
    ADD COLUMN IF NOT EXISTS account_type text NOT NULL DEFAULT 'personal'
    CHECK (account_type IN ('personal', 'virtual'));

COMMENT ON COLUMN whatsapp_accounts.account_type IS
    'Tipo de conta: ''personal'' (1 atendente dono, conta nas métricas) | ''virtual'' (SDR IA, operada por vários, fora das métricas).';

-- Backfill: contas hoje excluídas de métricas viram virtual.
-- Coerente com a semântica anterior (excluded_from_metrics era o único sinal
-- usado pra separar bots/IAs).
UPDATE whatsapp_accounts
   SET account_type = 'virtual'
 WHERE excluded_from_metrics = true
   AND account_type = 'personal';

-- Índice: a maioria das queries de listagem vai filtrar/agrupar por tipo
-- (ex: dashboard de prospecção vs painel de gerenciamento de bots).
CREATE INDEX IF NOT EXISTS idx_whatsapp_accounts_type
    ON whatsapp_accounts(account_type);
