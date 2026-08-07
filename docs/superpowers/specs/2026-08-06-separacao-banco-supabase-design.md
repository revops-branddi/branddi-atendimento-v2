# Separação do banco Supabase — Atendimento-v2

**Data:** 2026-08-06
**Status:** **EXECUTADO em 2026-08-07.** Ver seção "Execução" no fim — o plano mudou
em dois pontos importantes durante a execução.
**Projeto 1 de 2.** O Projeto 2 (Railway → Vercel) tem spec própria e vem depois.

## Problema

O Atendimento-v2 divide o projeto Supabase `rpqfxrmqsgiqzkroxemk` com o
Prospecting Engine (LIA). Consequências:

1. **Blast radius** — uma migration ou incidente de um projeto atinge o outro.
2. **Segurança** — o backend autentica com a chave `anon` e 30 tabelas estão com
   RLS desabilitado. A app só funciona *porque* RLS está desligado. Qualquer
   vazamento do anon key expõe leitura e escrita de todas elas.
3. **Governança** — as tabelas do Atendimento moram no mesmo `public` que as 44
   da LIA, sem fronteira declarada.

## Achados que fundamentam o design

Levantados em 2026-08-06 contra o banco de produção:

- **Zero FKs cruzam a fronteira.** Nenhuma foreign key atravessa. As do escopo do
  Atendimento são **14** (enumeradas no runbook de execução) — a contagem de "22"
  desta spec estava errada e foi corrigida em 2026-08-07.
- **Interseção de tabelas = 1.** Cruzando todas as chamadas `.from()` dos dois
  codebases: a LIA toca 34 tabelas, o Atendimento 18, e a única em comum é
  `testing_tickets`. **Correção 2026-08-07: ela tem 47 linhas, não 0** — a leitura
  original veio de `n_live_tup` (estimativa do autovacuum), não de `count(*)`.
  Ou seja, é dado real compartilhado, e foi transportada junto.
- **`apollo_enrichments` e `commercial_events` são do Atendimento**, apesar de
  morarem em `public`. A LIA nunca as referencia.
- **O backend usa a chave `anon`** (`role: anon` no JWT de `SUPABASE_KEY`), não
  `service_role`.
- **Nenhum frontend expõe o anon key** — nem o do Atendimento nem o da LIA.
  Ambos falam apenas com seus próprios backends. Não há vazamento ativo hoje.

Conclusão: a separação é uma operação de **transporte**, não de refatoração.
Nenhuma query precisa ser reescrita.

## Escopo do transporte

| Objeto | Qtd | Itens |
|---|---|---|
| Tabelas `public` | 13 | leads, conversations, messages, whatsapp_accounts, platform_users, scripts, routing_events, crm_sync_log, platform_settings, apollo_enrichments, commercial_events, whatsapp_account_status_events, testing_tickets |
| Tabelas `site` | 5 | leads, conversations, messages, whatsapp_accounts, gchat_threads |
| Views | 5 | `v_site_*` em `public` — workaround do PGRST106 (migration 022) |
| Sequences | 2 | `platform_settings_id_seq`, `whatsapp_account_status_events_id_seq` |
| Triggers | 0 | nenhum nas tabelas do Atendimento |

Volume transportado (contagem real no cutover, 2026-08-07): **50.272 linhas** —
`messages` 42.139, `commercial_events` 2.630, `conversations` 2.428, `leads` 1.671,
`apollo_enrichments` 775, `site.messages` 299, `testing_tickets` 47, demais < 200.
Os números "~49 mil / 41.455" da versão original vieram de `n_live_tup` e estavam
defasados.

Nada da LIA acompanha. As 44 tabelas de `public` e as 8 de `cbm` ficam onde estão.

## Decisão de chave e RLS

Esta é a parte não-óbvia do design.

Ligar RLS no banco atual **derrubaria a aplicação**: ela autentica como `anon`,
e sem policies toda query passaria a retornar vazio.

A correção não é escrever policies para `anon` — é **parar de usar `anon` no
servidor**. `service_role` ignora RLS por definição. Portanto:

1. No banco novo, o backend passa a usar `service_role`
2. RLS é habilitado nas 18 tabelas
3. Policies são deny-by-default para `anon` e `authenticated`

Resultado: RLS protege contra o mundo externo sem afetar a app.

**Por que só é seguro fazer isso no banco novo:** no banco atual, dar
`service_role` à app concederia acesso irrestrito também às 44 tabelas da LIA —
aumentando o blast radius em vez de reduzir. No banco separado, onde só existem
as 18 tabelas do Atendimento, `service_role` é exatamente o escopo correto.

## Sequência do cutover

### Preparação (app rodando normal, sem downtime)

1. Criar projeto Supabase na org RevOps-Branddi
2. Extrair DDL das 18 tabelas + 5 views + 2 sequences do banco atual
3. Aplicar schema no banco novo **via SQL editor**, não pela Management API
   (após transferência de org o token `sbp_` costuma dar 403 — ver runbook
   `stack-migration-revops`)
4. Habilitar RLS nas 18 tabelas com policies deny-all para `anon`/`authenticated`
5. Carga inicial: `pg_dump` seletivo → restore
6. **Validar contagem tabela a tabela** — etapa não-negociável

### Cutover (janela curta)

> ⚠️ **Os passos 7 e 8 abaixo NÃO foram executados como escritos — e não deviam ser.**
> Ver "Execução" no fim do documento. Preservados aqui como registro do plano original.

7. ~~Parar o serviço no Railway (encerra os 3 workers de polling)~~
   **Desnecessário.** *Parent-set anchoring* permitiu copiar 50k linhas com a produção
   escrevendo, sem freeze e sem downtime.
8. ~~Delta final: recopiar linhas com `created_at` posterior à carga inicial~~
   **Inseguro — teria perdido dados.** `created_at` de `messages` vem do WhatsApp, não é
   hora de inserção: 9.607 mensagens têm timestamp **anterior** ao da conversa pai.
   Qualquer recorte temporal deixa linhas para trás em silêncio.
   O correto é **anti-join por PK**, sem filtro de tempo.
9. Trocar no Railway: `SUPABASE_URL` e `SUPABASE_KEY` (agora `service_role`)
10. Subir e validar: `/api/health`, abrir inbox, enviar mensagem de teste
11. ~~Rodar `resyncConversation()` nas conversas ativas~~
    **Não foi necessário** — sem janela de parada, não houve mensagem perdida a recuperar.

### Rollback

Apontar `SUPABASE_URL` e `SUPABASE_KEY` de volta ao banco antigo. Válido
enquanto nada tiver sido escrito no banco novo — o que reforça manter a janela
curta e executar o passo 11 logo após o corte.

## Contexto operacional da janela

Medido em 2026-08-06 16:38 BRT: o inbox está ativo, ~24 mensagens/hora (uma a
cada 2,5 min). Pico do dia às 11h (101 msgs). Uma janela de 15 minutos em
horário comercial afeta ~6 mensagens de conversas em andamento, recuperáveis
via `resyncConversation()`.

## Fora de escopo (YAGNI)

- Dual-write ou replicação — desnecessário para um sistema que tolera 1min de latência
- Reconciliação automática de divergência
- Migração seletiva de histórico (o volume não justifica)
- Qualquer alteração nas 44 tabelas da LIA
- Refactor serverless (cursor → Postgres, lease lock) — pertence ao Projeto 2

## Critérios de sucesso

Todos verificados em 2026-08-07:

- [x] As 18 tabelas existem no banco novo com contagem idêntica à origem
      — validado por **anti-join de PK**, não por `count(*)` (contagem igual com
      linhas diferentes é possível; conjunto de PKs idêntico não)
- [x] As 5 views `v_site_*` respondem a SELECT com embed
- [x] RLS habilitado nas 18, com `anon` retornando vazio
- [x] Backend autenticando com `service_role`
- [x] `/api/health` retorna 200 apontando para o banco novo (`uptime_s` resetado)
- [x] Envio e recebimento de mensagem funcionando ponta a ponta
- [x] Banco antigo intacto (rollback disponível)

## Execução (2026-08-07)

O plano se sustentou no essencial. Três correções materiais:

**1. Não houve downtime.** O passo 7 previa parar o Railway. A primeira tentativa de
cópia sem freeze morreu a 74% em `messages_conversation_id_fkey` — ordem topológica
resolve dependência *estrutural*, não *temporal*: uma conversa criada durante a cópia
da tabela pai não entrava no snapshot, e a mensagem filha apontava para ela.

A solução foi *parent-set anchoring*, espelhando literalmente a constraint:
`WHERE fk IS NULL OR fk IN (SELECT id FROM parent WHERE created_at < T)`.
Copiou 50k linhas com a produção escrevendo.

**2. O delta do passo 8 teria perdido dados.** Ver nota no passo 8.

**3. `security_invoker = on` exige `GRANT` — e `BYPASSRLS` não substitui.**
O achado mais caro, e que a spec não previa.

Como todo o tráfego do schema `site` passa pelas views `public.v_site_*` (workaround do
PGRST106, migration 022), ligar RLS sem corrigir `security_invoker` protegeria zero.
Mas corrigir `security_invoker` tem um efeito colateral: com invoker **on**, a view deixa
de rodar com a permissão do dono e passa a rodar com a de **quem chama**. `service_role`
então precisa de `GRANT` nas tabelas `site.*` — e `BYPASSRLS` não ajuda, porque ignora
*policies*, não *GRANTs*; `service_role` não é superuser.

No destino faltavam `USAGE` no schema `site` **e** 15 GRANTs de tabela. Resultado:
`service_role` tomava `42501` nas 5 views. Corrigido com `GRANT USAGE ON SCHEMA site` +
`GRANT ALL ON ALL TABLES/SEQUENCES IN SCHEMA site` para `anon, authenticated, service_role`,
replicando a origem — seguro porque o RLS deny-all já estava verificado (18/18 tabelas,
0 policies) **antes** de conceder.

**A Management API não detectaria isso.** Ela roda como `postgres`, que tem todos os GRANTs.
Validar RLS/permissão por ela dá falso verde. Só o teste via `@supabase/supabase-js`
(PostgREST) — o mesmo caminho da app — revelou.

Corolário para o Projeto 2: `unipile_message_id` é `UNIQUE` em `public.messages` e
`site.messages`, e o ingest usa `upsert(..., { ignoreDuplicates: true })`. Duas instâncias
apontando para o **mesmo** banco deduplicam sozinhas — split-brain só existe entre bancos
diferentes. Fazer esta migração primeiro removeu o risco crítico do cutover para a Vercel.

## Dependência bloqueante

Criar projeto Supabase exige access token (`sbp_`) — o MCP disponível está
escopado apenas ao projeto compartilhado e não expõe criação de projeto.
Destravado com `supabase login --token` executado pelo dono da conta.
