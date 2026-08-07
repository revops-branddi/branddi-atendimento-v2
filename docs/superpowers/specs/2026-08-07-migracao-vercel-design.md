# Migração Railway → Vercel — Atendimento-v2

**Data:** 2026-08-07
**Status:** aprovado, aguardando plano de implementação
**Projeto 2 de 2.** O Projeto 1 (separação do banco Supabase) foi concluído em
2026-08-07 — ver `2026-08-06-separacao-banco-supabase-design.md`.

## Problema

O Atendimento-v2 roda no Railway como processo longo. A meta é consolidar a
infraestrutura nas contas RevOps/Vercel — decisão organizacional, tomada e tratada
aqui como premissa.

O obstáculo é que o app depende de três coisas que serverless não oferece:

1. **Três workers `setInterval`** dentro do `app.listen` (`src/server.js:193-206`):
   `startPolling()`, `startSitePolling()`, `startCrmSyncWorker()`.
2. **Cursor em memória** — `_lastPollTime`, presente tanto em
   `src/site/services/ingest.js:21` quanto em `src/services/unipile.js`.
3. **Upload de 16 MB** (`src/routes/messages.js:14`) contra o teto de 4,5 MB de
   corpo de request da Vercel.

## Achados que fundamentam o design

Levantados em 2026-08-07 contra o código e o banco de produção.

### O bot do /site é reativo e sensível a latência

`src/site/services/bot.js` (261 linhas) é uma máquina de estados rule-based que faz
triagem inbound: cumprimenta, pergunta OPEC ou Comercial, roteia. É legítimo — a regra
de "zero auto-envio" vale para prospecção (`public.*`), não para o `/site`
(`site.*`, número dedicado).

Ele responde a cada mensagem do lead. O polling do site roda a cada **10 s**; o piso do
Vercel Cron é **1 minuto**. Portar esse worker para cron transforma "resposta quase
imediata" em "até 60 s de silêncio" no meio de uma conversa.

**Isto é o que descarta a abordagem cron-only.**

### Os webhooks do Unipile já estão registrados

`scripts/register-unipile-webhooks.js` registra dois: `users` (status de conta) e
`messaging` — este último com o comentário "pra auto-ingest sem polling pesado".
Verificado via `--dry-run` em 2026-08-07: **ambos ativos**, apontando para
`https://branddi-chat.up.railway.app/api/webhooks/unipile`.

### Mas o handler só trata evento de conta, e a evidência é ambígua

`src/routes/webhooks.js:135` extrai `account_id` e grava status. Não há tratamento de
evento de mensagem.

`public.whatsapp_account_status_events` tem **0 linhas** — em ambos os bancos, depois de
meses. Ao mesmo tempo, `whatsapp_accounts` mostra 5 status distintos e `updated_at` de
hoje, ou seja, status **mudam** (por outro caminho: polling / rotas de sync).

Uma sonda não-destrutiva em produção (`.claude/probe-webhook.mjs`) mostrou:

| requisição | resposta |
|---|---|
| com secret correto | `200 {"received":true,"ignored":true}` |
| sem secret | `401` |
| com secret errado | `401` |

Endpoint vivo, auth correta, secret do Railway idêntico ao do `.env`.

**A evidência não distingue duas hipóteses opostas:**

- **(a)** O Unipile não entrega os eventos de mensagem.
- **(b)** Entrega todos, mas o handler os descarta em silêncio — ele só procura a conta
  em `body.account.id`, `body.account_id` e `body.id`; se o payload de `messaging`
  aninhar diferente, cai no early-return `ignored: true`, que retorna 200 e **não grava
  nada**.

As duas produzem exatamente o mesmo estado observável. Resolver isso é o **Passo 0**.

### O limite de upload precisa ser contornado, não reduzido

Dos 814 anexos outbound, 93 têm `file_size` registrado (amostra de 11%, possivelmente
enviesada). Nessa amostra: média 0,50 MB, p95 3,15 MB, máximo 6,27 MB, **nenhum** acima
de 16 MB, e **2** acima de 4,5 MB.

A estatística agregada sugeriria baixar o teto e aceitar ~2% de perda. Os dois casos
concretos dizem o contrário:

| data | arquivo | MB |
|---|---|---|
| 04/ago | `branddi_diagnostico_unicpharma_2026-08-04.pdf` | 6,27 |
| 04/ago | `branddi_diagnostico_gupy_2026-08-04.pdf` | 5,34 |

São **diagnósticos** — o entregável comercial central. São os mais recentes da série. E a
tendência sobe: apresentações de julho ficam em 3,0–3,5 MB; diagnósticos de agosto, em
5,3–6,3 MB. Um teto de 4,5 MB bloquearia exatamente o documento que gera receita, e
bloquearia mais deles com o tempo.

### O dedup já existe e muda a ordem do cutover

`unipile_message_id` é `UNIQUE` em `public.messages` (migration 001) e `site.messages`
(migration 007), e o ingest usa
`upsert(..., { onConflict: 'unipile_message_id', ignoreDuplicates: true })`.

Como o Projeto 1 já apontou a produção para o banco novo, Railway e Vercel podem rodar
**simultaneamente contra o mesmo banco** sem forjar dados: o segundo a gravar vira no-op.
Split-brain só existe entre bancos diferentes.

## Arquitetura

### Ingestão: webhook principal, cron como rede de segurança

O handler de webhook ganha um roteador na entrada. Eventos de conta seguem para o fluxo
de status já existente; eventos de mensagem entram no mesmo `saveMessage` que o polling
usa hoje — reaproveitando dedup, match de lead e o caminho já testado em produção.

Um **Cron de 5 minutos** roda um reconciliador sobre as conversas ativas, buscando o que
não chegou. Não é o caminho principal: é a apólice. Se o Unipile perder um evento, a
mensagem entra com até 5 min de atraso em vez de nunca.

O reconciliador reaproveita `resyncConversation()` (`src/services/unipile.js`), que já
existe exatamente para isso e já deduplica por `unipile_message_id`.

**"Conversas ativas"** = conversas com `last_message_at` nas últimas 48 h, em ambos os
schemas. Limite deliberado: reconciliar todas as 2.428 conversas a cada 5 min seria
desperdício, e uma conversa parada há dias não tem mensagem nova para recuperar.

### Roteamento por conta — os dois fluxos dividem o mesmo webhook

Este é o ponto mais delicado do desenho, e não existe hoje: o polling é separado por
construção (dois workers, dois serviços, dois conjuntos de contas), mas o webhook é **um
só**, porque o DSN do Unipile é compartilhado.

O roteador precisa, para cada evento, decidir a qual fluxo a conta pertence:

1. Conta em `public.whatsapp_accounts` com `ignored = true` → **descartar**. São 2 de 20,
   pertencem a outros times e nunca deveriam entrar (o handler de status já faz isso via
   `getIgnoredAccountIds()`; o roteador de mensagem precisa fazer igual).
2. Conta em `site.whatsapp_accounts` → fluxo `/site`: grava em `site.*` e, se
   `status = 'bot'`, dispara `processBotTurn()`.
3. Conta em `public.whatsapp_accounts` → fluxo de prospecção: grava em `public.*` e
   **nunca** dispara bot.
4. Conta desconhecida → descartar e logar. Não inventar registro.

Errar esse roteamento é o pior defeito possível desta migração: mandar uma conversa de
prospecção para o fluxo do `/site` faria o bot responder pelo WhatsApp de um SDR — que é
exatamente a violação que originou a regra de zero auto-envio em prospecção. O
roteamento deve falhar fechado: na dúvida, descartar e logar, nunca adivinhar.

### Destino de cada bloqueador

| hoje | vira | por quê |
|---|---|---|
| `startPolling()` | webhook + reconciliador 5 min | latência melhora, sem `setInterval` |
| `startSitePolling()` (10 s) | webhook | bot responde na hora — **melhor que hoje** |
| `startCrmSyncWorker()` | Vercel Cron | é batch; latência não importa |
| `_lastPollTime` (memória) | **deixa de existir** | webhook é push, não pull |
| lease lock | **não é necessário** | ver abaixo |

**Por que não precisa de lease lock.** Ele existiria para impedir que duas invocações
concorrentes do mesmo cron dupliquem ingestão. Com a ingestão em webhook, sobram dois
crons de baixa frequência (reconciliador 5 min, CRM sync) cujas operações são idempotentes
por construção — o reconciliador via `unipile_message_id UNIQUE`, o CRM sync via
`crm_sync_log`. Sobreposição é no-op, não corrupção. Introduzir lease lock aqui seria
adicionar um mecanismo de coordenação para um problema que a chave única já resolve.

### Upload direto para o Storage

O fluxo atual é pass-through: `multer.memoryStorage()` → buffer → `sendMessage()` do
Unipile. O arquivo nunca é persistido.

O novo fluxo:

1. Browser pede uma signed URL para a function
2. Browser envia o arquivo **direto para o Supabase Storage** (não passa pela function,
   logo o teto de 4,5 MB não se aplica)
3. Browser chama `send-media` passando a chave do objeto
4. Function baixa do Storage e repassa para o Unipile

O teto da Vercel é sobre **corpo de request**, não sobre fetch de saída — por isso o
diagnóstico de 6,27 MB passa.

Arquivos órfãos (upload feito, envio abandonado) são limpos por um job que entra de
carona no cron do CRM sync.

## Fluxo de dados

```
Lead manda WhatsApp
  → Unipile
  → POST /api/webhooks/unipile        [caminho principal, ~instantâneo]
  → roteador: evento de mensagem
  → saveMessage()  (dedup por unipile_message_id)
  → se conversa do /site e status='bot' → processBotTurn() → resposta imediata

Cron 5 min (rede de segurança)
  → conversas ativas → resyncConversation() → saveMessage() → no-op se já existe

Atendente envia mídia
  → signed URL → upload direto pro Storage → function baixa → Unipile
```

## Tratamento de erro

- **Webhook falha ou o Unipile não entrega:** o reconciliador de 5 min cobre. Degrada
  latência, não perde mensagem. Esta é a razão de ele existir mesmo se o webhook se
  provar confiável.
- **Webhook duplicado:** no-op via `unipile_message_id UNIQUE`.
- **Cron sobreposto:** idempotente por construção; ver "por que não precisa de lease lock".
- **Upload interrompido:** objeto órfão no Storage, limpo pelo job de limpeza. Nenhuma
  mensagem parcial é gravada, porque a mensagem só é criada depois do envio ao Unipile.
- **Webhook aponta para uma URL só:** durante a validação em paralelo, quem tiver o
  webhook é quem ingere. O outro lado fica só com o reconciliador. Isso é aceitável e é
  exatamente o interruptor do cutover.

## Testes

- **Passo 0 (bloqueante):** capturar o payload cru de um evento `messaging` e confirmar
  qual hipótese, (a) ou (b), é a verdadeira. É uma mudança de ~5 linhas: logar/persistir
  `req.body` antes de qualquer validação. **Nada mais é construído antes disso.**
- Teste do roteador de webhook com payloads reais capturados no Passo 0, não inventados.
- Teste de idempotência: o mesmo evento entregue duas vezes gera uma linha.
- Teste do reconciliador: apagar uma mensagem do banco, rodar, confirmar que volta.
- Teste de upload de ponta a ponta com um arquivo > 4,5 MB — usar um diagnóstico real,
  que é o caso que motivou a decisão.
- Teste do bot: medir latência entre inbound e resposta, comparando com os 10 s de hoje.

## Cutover

Railway e Vercel apontam para o **mesmo** banco, então podem coexistir. A sequência:

1. Passo 0 resolvido
2. Deploy na Vercel com os crons ativos, **sem** mover o webhook — a Vercel roda só o
   reconciliador e prova que sobe, conecta e reconcilia
3. Mover o webhook do Unipile para a URL da Vercel — este é o corte real
4. Observar; o Railway segue de pé, sem webhook, como rollback imediato
5. Desligar o Railway

Rollback em qualquer ponto: reapontar o webhook para o Railway.

## Fora de escopo (YAGNI)

- Lease lock (justificado acima)
- Fila/queue entre webhook e persistência — o `UNIQUE` já dá idempotência
- Migrar o histórico de anexos para o Storage; só o fluxo novo muda
- Reescrever o `startDeliveryRetryWorker()`, desativado desde o bug de loop
  (`src/server.js:206`)
- Transferência do repositório e mudança de remote — só depois da paridade

## Critérios de sucesso

- [ ] Payload de `messaging` capturado e hipótese (a)/(b) decidida com evidência
- [ ] Mensagem inbound aparece no inbox sem polling
- [ ] **Roteamento por conta correto:** mensagem de conta de prospecção nunca dispara o
      bot; conta `ignored` é descartada; conta desconhecida é descartada e logada
- [ ] Bot do `/site` responde em tempo igual ou menor que os 10 s de hoje
- [ ] Reconciliador recupera uma mensagem deletada artificialmente
- [ ] Diagnóstico de ~6 MB enviado com sucesso pela Vercel
- [ ] CRM sync roda por cron com o mesmo resultado de hoje
- [ ] Nenhum `setInterval` remanescente no caminho de produção
- [ ] Railway desligado, e o banco não acusa duplicata durante o período de coexistência

## Dependência conhecida

O gatilho `push → deploy` **não foi testado desde a transferência do repositório** para a
org `revops-branddi`. O último push de código é `4c1ffcd` (28/mai), anterior à
transferência; o redeploy de 2026-08-07 veio de mudança de env var, evento interno do
Railway que não exercita o GitHub App. Se o gatilho quebrou, isso aparece no primeiro
merge em `main` — que é justamente o Passo 0.
