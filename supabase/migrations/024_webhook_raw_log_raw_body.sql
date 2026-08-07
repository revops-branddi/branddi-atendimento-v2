-- Passo 0, segunda rodada: guardar o corpo CRU.
--
-- A primeira rodada capturou 15 eventos em ~6 min e provou que o Unipile ENTREGA.
-- Mas os 15 vieram com body {} porque chegam como application/x-www-form-urlencoded
-- e o app so' tinha express.json() — o corpo era descartado antes do handler.
--
-- `body` guarda o resultado do parser; `raw` guarda os bytes como chegaram. Só o
-- cru permite descobrir se o Unipile manda JSON com content-type errado (caso em
-- que o parser de formulario devolve lixo) ou form-encoded de verdade.
--
-- DROPAR junto com a tabela quando a Fase 2 fechar.
alter table public.webhook_raw_log
    add column if not exists raw text;

comment on column public.webhook_raw_log.raw is
    'Corpo cru como chegou, antes de qualquer parser. Temporario — Passo 0.';
