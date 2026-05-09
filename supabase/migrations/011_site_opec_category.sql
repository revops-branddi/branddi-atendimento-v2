-- Migration 011: site flow — sub-categoria OPEC.
-- Quando atendente classifica lead como 'opec', escolhe qual time atende:
--   'bb'     → TakeDown BB (notificacao@brandmonitor.com.br) → Giselle França
--   'golpes' → TakeDown Golpes (fraud@branddi.com)           → Caroline Cipriani
--   'vm'     → TakeDown VM (ip-violations-report@brandmonitor.com.br) → João França
--
-- Cada categoria tem seu próprio webhook Google Chat (env vars
-- OPEC_GCHAT_WEBHOOK_{BB,GOLPES,VM}). Mapping nome→email→webhook fica em
-- src/services/gchat.js (constants), não no DB — webhook URLs são segredo.
--
-- Idempotente.
--
-- Reverter:
--   DROP INDEX IF EXISTS idx_site_leads_opec_category;
--   ALTER TABLE site.leads DROP CONSTRAINT IF EXISTS site_leads_opec_category_check;
--   ALTER TABLE site.leads DROP COLUMN IF EXISTS opec_category;

ALTER TABLE site.leads ADD COLUMN IF NOT EXISTS opec_category text;

ALTER TABLE site.leads DROP CONSTRAINT IF EXISTS site_leads_opec_category_check;
ALTER TABLE site.leads
    ADD CONSTRAINT site_leads_opec_category_check
    CHECK (
        opec_category IS NULL
        OR opec_category IN ('bb', 'golpes', 'vm')
    );

-- Garantia de coerência: se opec_category preenchido, classification deve ser 'opec'.
ALTER TABLE site.leads DROP CONSTRAINT IF EXISTS site_leads_opec_category_requires_opec;
ALTER TABLE site.leads
    ADD CONSTRAINT site_leads_opec_category_requires_opec
    CHECK (
        opec_category IS NULL
        OR classification = 'opec'
    );

CREATE INDEX IF NOT EXISTS idx_site_leads_opec_category
    ON site.leads(opec_category) WHERE opec_category IS NOT NULL;
