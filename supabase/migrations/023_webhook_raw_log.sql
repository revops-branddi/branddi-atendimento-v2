-- Captura TEMPORARIA de payloads crus de webhook.
--
-- Por que existe: whatsapp_account_status_events esta com 0 linhas depois de
-- meses, e uma sonda confirmou que o endpoint responde, a auth funciona e o
-- secret do Railway bate com o registrado. Esse estado e' igualmente compativel
-- com duas hipoteses opostas:
--   (a) o Unipile nao entrega eventos de mensagem
--   (b) entrega todos, e o handler os descarta em silencio — ele so' procura a
--       conta em body.account.id, body.account_id e body.id, e um payload que
--       aninhe diferente cai no early-return que responde 200 sem gravar nada
--
-- As duas produzem o mesmo estado observavel. Esta tabela e' o que as separa.
--
-- DROPAR quando a Fase 2 fechar: `drop table public.webhook_raw_log;`
create table if not exists public.webhook_raw_log (
    id          bigint generated always as identity primary key,
    received_at timestamptz not null default now(),
    headers     jsonb,
    body        jsonb
);

-- RLS on + zero policies = deny-all, igual as outras 18 tabelas. Só service_role
-- le, via BYPASSRLS. Sem isso, a anon key — que vaza no repo publico — leria
-- payloads crus de webhook.
alter table public.webhook_raw_log enable row level security;

comment on table public.webhook_raw_log is
    'TEMPORARIA — Passo 0 da migracao Vercel. Decide se o Unipile entrega eventos de mensagem. Dropar depois.';
