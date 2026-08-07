# Ingestão por webhook — Fase 2

**Data:** 2026-08-07
**Status:** aprovado (autonomia delegada pelo usuário), em implementação
**Fase 2 de 3.** A Fase 1 preparou o terreno; a Fase 3 é o cutover para a Vercel.

## Contexto

A Fase 1 e os PRs #178/#179 provaram, com dados de produção, que o webhook `messaging`
do Unipile **sempre entregou** — o corpo era descartado por um erro de content-type. Com
isso corrigido, a ingestão por evento passou de hipótese a caminho disponível.

O payload real, capturado em 2026-08-07:

```json
{"event":"message_received","account_id":"…","account_type":"WHATSAPP",
 "account_info":{…},"chat_id":"…","attendees":[…],"sender":{…},
 "message":"…","message_id":"…","timestamp":"2026-08-07T13:48:04.000Z",
 "attachments":[],"is_sender":false,"provider_chat_id":"5511968298133@s.whatsapp.net",
 "is_group":false,"folder":["INBOX"]}
```

## A descoberta que define o desenho

`processChat()` — o coração da ingestão, em `src/services/unipile.js:1027` — consome do
objeto de chat exatamente **dois campos**: `chat.id` e `chat.account_id`. Mais
`isGroupChat(chat)`, que lê `chat.type` e `chat.provider_id`. O mesmo vale para
`processChat(chat, account)` do fluxo `/site`.

Todos existem no payload:

| `processChat` precisa | vem de |
|---|---|
| `chat.id` | `chat_id` |
| `chat.account_id` | `account_id` |
| `chat.provider_id` | `provider_chat_id` |
| `chat.type` | `is_group` |

**Portanto a Fase 2 não escreve ingestão nova.** O webhook substitui apenas o mecanismo de
*descoberta* — o `listChats` a cada 10 s — e reaproveita, sem tocar, todo o resto: match de
lead, criação de conversa, sync com Pipedrive, tratamento de grupo, disparo do bot do
`/site` e dedup por `unipile_message_id`.

O que seria um caminho paralelo vira um adaptador de ~10 linhas. Menos código novo é menos
superfície para divergir do comportamento já validado em produção.

## Decisões tomadas

Registradas aqui porque foram tomadas sem consulta, sob autonomia delegada.

**1. Reaproveitar `processChat` em vez de escrever ingestão dedicada.**
A alternativa — persistir a mensagem direto do payload — seria mais rápida em uma
invocação, mas duplicaria match de lead, criação de conversa e sync de CRM. Duplicação
que divergiria com o tempo. O custo é uma chamada extra ao Unipile por evento, absorvida
pelo dedup.

**2. O polling continua ligado.** O webhook entra *ao lado* do polling, não no lugar dele.
`unipile_message_id UNIQUE` torna a sobreposição um no-op, e enquanto o Railway for
produção, desligar o polling trocaria um caminho comprovado por um novo no mesmo passo.
Desligar é da Fase 3, depois de o webhook acumular evidência.

**3. A Fase 2 não inclui o cutover para a Vercel.** Manter as duas coisas separadas
preserva a propriedade que tornou o Projeto 1 seguro: uma variável por vez. Se o inbox
oscilar depois desta fase, a causa é a ingestão; não há dúvida sobre a plataforma.

**4. Roteamento falha fechado.** Conta desconhecida é descartada e logada, nunca adivinhada.
Não é defesa teórica: o **primeiro** evento observado em produção veio de
`oxF_Ozs3RuakhJkHk130Zg`, marcado `ignored=true` — conta de outro time no DSN
compartilhado. Sem esse check, a Fase 2 importaria conversas de terceiros para o banco que
o Projeto 1 acabou de isolar.

**5. O bot do `/site` continua disparando pelo caminho normal.** Reaproveitar o
`processChat` do site preserva `processBotTurn` e a janela de 5 min que impede saudação
baseada em mensagem antiga. A regra de "só o webhook dispara o bot" segue valendo: o
reconciliador da Fase 1 não chama este caminho.

## Arquitetura

```
Unipile → POST /api/webhooks/unipile
  → normalizeWebhookBody (já existe, PR #179)
  → é evento de mensagem?
       não → fluxo de status de conta (já existe)
       sim ↓
  → classifyAccount(account_id)
       'ignored'      → descarta, loga  (conta de outro time)
       'unknown'      → descarta, loga  (falha fechado)
       'site'         → site processChat(chat, account)   → pode disparar bot
       'prospecting'  → processChat(chat)                 → nunca dispara bot
```

### Unidades

| arquivo | responsabilidade |
|---|---|
| `src/services/webhook-ingest.js` | **novo** — classificação, adaptação e despacho |
| `src/routes/webhooks.js` | chama o despacho em vez de responder `ack_only` |

Duas funções puras, testáveis sem banco:

- `chatFromWebhook(payload)` → `{ id, account_id, provider_id, type }`
- `classifyAccount(accountId, { ignoredIds, siteIds, publicIds })` → `'ignored' | 'site' | 'prospecting' | 'unknown'`

E uma de IO, `ingestWebhookMessage(payload)`, que resolve as listas de contas e despacha.

## Por que webhook e polling podem rodar juntos com segurança

Rodar os dois ao mesmo tempo cria concorrência real sobre o mesmo chat. Três riscos, todos
já cobertos pelo código existente — verificado antes de decidir, não assumido:

**Mensagem duplicada.** `unipile_message_id UNIQUE` (migrations 001 e 007). A segunda
inserção falha com 23505 e é tratada como no-op.

**Conversa duplicada.** `public.conversations` tem `conversations_whatsapp_chat_id_key`
(unique incondicional); `site.conversations` tem `uniq_active_conv_per_chat` (unique
parcial sobre status ativo). Nenhum dos dois fluxos consegue criar a segunda.

**Bot disparando duas vezes** — o mais grave, porque constraint de banco não desfaz
WhatsApp já enviado. Coberto por uma propriedade sutil de `src/site/services/ingest.js`:
`insertMessage()` devolve `null` no 23505, e `hasNewInbound` só vira `true` **se a inserção
ocorreu de fato** (`if (inserted)`), não se "existe inbound nova". De duas chamadas
concorrentes, apenas uma insere; a outra recebe `null` e não dispara o bot.

O gate é sobre *efeito próprio*, não sobre *estado observado* — e por isso herda a
atomicidade do INSERT. Somado ao reload de `bot_stage` imediatamente antes do turno (que o
próprio autor deixou comentado como proteção contra `processChat` em paralelo) e à janela
de 60 s de inbound fresca, o disparo duplicado está fechado.

## Tratamento de erro

- **Falha na ingestão:** logar e responder 200. Um 500 faria o Unipile re-tentar o mesmo
  evento indefinidamente; o polling e o reconciliador já cobrem o que falhar. Perder
  latência é aceitável, entrar em loop de retry não.
- **Evento duplicado:** no-op via `unipile_message_id UNIQUE`.
- **Conta ignorada/desconhecida:** descarte explícito e logado, nunca silencioso — foi
  exatamente o descarte silencioso que escondeu o bug do content-type por meses.

## Fora de escopo

- Desligar os três `setInterval` (Fase 3)
- Cutover para a Vercel (Fase 3)
- Limpeza de órfãos no Storage (Fase 3)
- Remover `webhook_raw_log` e a captura — só quando a Fase 3 fechar, porque ela ainda é a
  única janela para o payload cru

## Critérios de sucesso

- [ ] Mensagem inbound aparece no inbox sem depender do ciclo de polling
- [ ] Evento de conta `ignored` é descartado e logado, sem gravar nada
- [ ] Evento de conta desconhecida é descartado e logado
- [ ] Conta do `/site` roteia para `site.*`; conta de prospecção para `public.*`
- [ ] Nenhuma duplicata com polling e webhook rodando juntos
- [ ] Testes cobrindo classificação e adaptação, incluindo o payload real capturado
