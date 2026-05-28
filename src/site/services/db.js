/**
 * Site DB client — Supabase no schema default `public`.
 *
 * Histórico: este client originalmente apontava pra `site.*` via
 * `{ db: { schema: 'site' } }`. Em 2026-05-28 o PostgREST/gateway do
 * projeto começou a rejeitar requests com `Accept-Profile: site` apesar
 * do schema estar na lista de Exposed Schemas (Dashboard + Mgmt API
 * confirmam). Migration 022 espelhou as tabelas de `site.*` em views
 * `public.v_site_*`, e este client passou a usar o default público.
 *
 * Tradução de nomes: `site.X` ↔ `public.v_site_X`. Joins via PostgREST
 * embedding usam o nome da view (ex.: `v_site_leads(...)`) — o PostgREST
 * detecta o FK através das tabelas-base.
 *
 * Quando dropar este workaround: ver migration 022.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY,
);

export default sb;
