-- Migration 022: Views em `public` que espelham `site.*`
--
-- Motivação:
--   O Data API do Supabase (PostgREST) tem uma lista global de schemas
--   expostos. Em 2026-05-28 o `site` foi adicionado à lista via Dashboard +
--   Management API, mas o PostgREST/gateway desse projeto está com bug ou
--   lag anormal e segue rejeitando requests com `Accept-Profile: site`:
--
--     PGRST106 — "Only the following schemas are exposed: public, graphql_public"
--
--   Restart do projeto + NOTIFY pgrst + reapplicação da config não
--   destravaram. Sem suporte da Supabase, a aplicação `/site/` fica inteira
--   400/500 (listar conversas, contas WA, mensagens — tudo via supabase-js
--   com `db: { schema: 'site' }`).
--
-- Workaround:
--   Espelhar as tabelas de `site.*` em views simples em `public.v_site_*`.
--   O supabase-js então fala com schema default (`public`, já exposto)
--   e tudo destrava sem mexer no schema `site` e sem afetar outros
--   projetos que compartilham este Supabase (prefixo `v_site_` é único
--   e não colide com nada em `public`).
--
-- Propriedades:
--   - Views simples sobre 1 tabela → Postgres trata como auto-updatable
--     (INSERT/UPDATE/DELETE funcionam sem precisar de INSTEAD OF triggers)
--   - GRANTs explícitos pros 3 roles que o supabase-js usa (anon,
--     authenticated, service_role) já que views não herdam grants
--   - Reversível: `DROP VIEW IF EXISTS` no rollback remove sem efeito
--     colateral nas tabelas-fonte
--
-- Quando dropar este workaround:
--   Quando o suporte Supabase restaurar a exposição do schema `site`
--   (testar com: `curl -H "Accept-Profile: site" -H "apikey: ..." <rest>/conversations`
--   retornando 200). Aí basta reverter o commit que troca os nomes de
--   tabela no código e dar `DROP VIEW` aqui.

CREATE OR REPLACE VIEW public.v_site_conversations      AS SELECT * FROM site.conversations;
CREATE OR REPLACE VIEW public.v_site_leads              AS SELECT * FROM site.leads;
CREATE OR REPLACE VIEW public.v_site_messages           AS SELECT * FROM site.messages;
CREATE OR REPLACE VIEW public.v_site_whatsapp_accounts  AS SELECT * FROM site.whatsapp_accounts;
CREATE OR REPLACE VIEW public.v_site_gchat_threads      AS SELECT * FROM site.gchat_threads;

-- Grants — views não herdam dos source tables. Replicamos o que site.*
-- já concede pros mesmos roles (SELECT, INSERT, UPDATE, DELETE).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.v_site_conversations      TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.v_site_leads              TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.v_site_messages           TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.v_site_whatsapp_accounts  TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.v_site_gchat_threads      TO anon, authenticated, service_role;

COMMENT ON VIEW public.v_site_conversations IS
  'Workaround mig 022: espelho de site.conversations em public porque o PostgREST do projeto segue rejeitando Accept-Profile: site (PGRST106), apesar da config ter sido atualizada via Dashboard + Mgmt API.';
