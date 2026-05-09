-- Migration 013: site flow — adiciona job_title em site.leads.
--
-- Quando bot Comercial entrega lead pra atendente, atendente preenche
-- manualmente nome/cargo/empresa antes de criar o deal no Pipedrive.
-- O cargo (job_title) não existia no schema.
--
-- Idempotente.
--
-- Reverter: ALTER TABLE site.leads DROP COLUMN IF EXISTS job_title;

ALTER TABLE site.leads ADD COLUMN IF NOT EXISTS job_title text;
