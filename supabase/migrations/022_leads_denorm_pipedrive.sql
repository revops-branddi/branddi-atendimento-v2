-- Denormaliza title do deal e nome da org do Pipedrive no lead.
--
-- Motivo: inbox-search hoje só procura por nome/empresa/telefone do lead,
-- então conv vinculada a um deal "Duty Cosméticos | Brand Bidding" via
-- número genérico (21980347910) é invisível pra busca "duty". Em vez de
-- consultar o Pipedrive a cada keystroke, mantemos uma cópia escrita no
-- momento do link/sync e refrescada quando a conv é aberta.
--
-- Campos nullable — leads sem vínculo permanecem null, sem default.

ALTER TABLE leads
    ADD COLUMN IF NOT EXISTS crm_deal_title TEXT,
    ADD COLUMN IF NOT EXISTS crm_org_name   TEXT;

-- Índices em prefix-match pra acelerar busca server-side (ilike '%term%').
-- pg_trgm seria ideal pra full ilike, mas exige extension. Index normal já
-- ajuda em ordenações e ilike com prefix (term%).
CREATE INDEX IF NOT EXISTS idx_leads_crm_deal_title ON leads (crm_deal_title);
CREATE INDEX IF NOT EXISTS idx_leads_crm_org_name   ON leads (crm_org_name);

COMMENT ON COLUMN leads.crm_deal_title IS 'Cópia denormalizada de pipedrive.deals.title — populada no link/sync, usada pra busca da inbox';
COMMENT ON COLUMN leads.crm_org_name   IS 'Cópia denormalizada de pipedrive.organizations.name — populada no link/sync, usada pra busca da inbox';
