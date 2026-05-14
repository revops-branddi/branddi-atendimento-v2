-- Migration 019: dropa CHECK constraints legadas em site.conversations
-- que sobreviveram à migration 012 e estavam bloqueando silenciosamente
-- toda transição de bot_stage além de 'welcome'/'human'.
--
-- Contexto:
--   site.conversations tinha DUAS constraints homônimas no mesmo CHECK:
--     - site_conversations_bot_stage_check (mig 012, valores corretos)
--     - conversations_bot_stage_check      (legado da criação inicial, só
--                                           aceita welcome|qualifying|
--                                           classified|human)
--   A mig 012 só dropou a com prefixo `site_` antes de recriar — a sem
--   prefixo continuou rejeitando 'awaiting_classification' etc.
--   Resultado em produção: bot mandava welcome, tentava avançar stage,
--   o UPDATE lançava 23514, o erro caía no try/catch silencioso do ingest
--   e o stage ficava travado. Lead respondia "2" mil vezes e o bot só
--   sabia repetir o greeting.
--
--   `conversations_status_check` (sem prefixo) também sobrou duplicado
--   mas com mesma definição que `site_conversations_status_check` — não
--   estava quebrando nada, só ruído de schema. Tiro junto pra deixar a
--   tabela com 1 constraint por coluna.
--
-- Reverter (não recomendado — recriaria o bug):
--   ALTER TABLE site.conversations ADD CONSTRAINT conversations_bot_stage_check
--     CHECK (bot_stage IN ('welcome','qualifying','classified','human'));
--   ALTER TABLE site.conversations ADD CONSTRAINT conversations_status_check
--     CHECK (status IN ('bot','waiting_human','in_progress','resolved'));

ALTER TABLE site.conversations
    DROP CONSTRAINT IF EXISTS conversations_bot_stage_check;

ALTER TABLE site.conversations
    DROP CONSTRAINT IF EXISTS conversations_status_check;
