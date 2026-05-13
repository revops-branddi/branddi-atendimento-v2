-- Migration 018: Flag pra excluir números do dashboard de prospecção
--
-- Motivação: alguns números cadastrados em `whatsapp_accounts` são externos
-- (operados por outro app, integração legada, etc.) e não devem contar nas
-- métricas de atividade dos SDRs. Em vez de deletar a row (e perder histórico
-- de conversas), marcamos com `excluded_from_metrics=true`.
--
-- Uso no dashboard:
--   ...JOIN whatsapp_accounts w ON w.unipile_account_id = c.whatsapp_account_id
--   WHERE COALESCE(w.excluded_from_metrics, false) = false

ALTER TABLE whatsapp_accounts
    ADD COLUMN IF NOT EXISTS excluded_from_metrics boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN whatsapp_accounts.excluded_from_metrics IS
    'Quando true, conversas desse número são ignoradas no dashboard de prospecção (ex: número externo de outro app).';

-- Índice parcial: só carrega as poucas rows true (pequeno overhead)
CREATE INDEX IF NOT EXISTS idx_whatsapp_accounts_excluded
    ON whatsapp_accounts(excluded_from_metrics) WHERE excluded_from_metrics = true;
