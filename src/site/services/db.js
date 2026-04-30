/**
 * Site DB client — Supabase apontando pro schema 'site'.
 * Isolado do cliente principal (src/services/supabase.js) que aponta pra public.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY,
    { db: { schema: 'site' } }
);

export default sb;
