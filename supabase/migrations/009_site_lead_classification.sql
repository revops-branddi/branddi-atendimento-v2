-- Migration 009: site flow — classification (comercial|opec).
-- Atendentes do site classificam leads em duas filas:
--   'comercial' → vira deal no Pipedrive (Fase 2)
--   'opec'      → roteado pra Google Chat webhook (Fase 3)
--
-- Idempotente: usa IF NOT EXISTS / DROP IF EXISTS pra permitir rerodar.
--
-- Reverter:
--   ALTER TABLE site.leads DROP CONSTRAINT IF EXISTS site_leads_classification_check;
--   DROP INDEX IF EXISTS idx_site_leads_classification;
--   ALTER TABLE site.leads DROP COLUMN IF EXISTS classification;

ALTER TABLE site.leads ADD COLUMN IF NOT EXISTS classification text;

ALTER TABLE site.leads DROP CONSTRAINT IF EXISTS site_leads_classification_check;
ALTER TABLE site.leads
    ADD CONSTRAINT site_leads_classification_check
    CHECK (classification IS NULL OR classification IN ('comercial', 'opec'));

CREATE INDEX IF NOT EXISTS idx_site_leads_classification
    ON site.leads(classification) WHERE classification IS NOT NULL;
