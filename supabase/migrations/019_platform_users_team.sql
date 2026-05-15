-- Migration 019: time/categoria do atendente no funil comercial
--
-- 'prospecting' = SDR / abertura de oportunidade
-- 'sales'       = closer / vendas
-- NULL          = admin sem time atribuído (Diego, Sergio)
--
-- Usado pelo dashboard comercial pra agrupar métricas por categoria
-- (tabs Prospecção / Vendas / Todos).

ALTER TABLE platform_users
    ADD COLUMN IF NOT EXISTS team text
    CHECK (team IN ('prospecting', 'sales') OR team IS NULL);

COMMENT ON COLUMN platform_users.team IS
    'Categoria do atendente no funil: prospecting (SDRs) ou sales (closers). NULL = admin sem time.';

CREATE INDEX IF NOT EXISTS idx_platform_users_team
    ON platform_users(team) WHERE team IS NOT NULL;
