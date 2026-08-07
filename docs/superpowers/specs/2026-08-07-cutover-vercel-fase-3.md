# Cutover para a Vercel — Fase 3

**Data:** 2026-08-07
**Status:** rascunho — bloqueado pela validação da Fase 2 em produção
**Fase 3 de 3.** Fecha a migração iniciada com a separação do banco.

## Pré-condição bloqueante

A Fase 2 precisa acumular evidência **em produção** antes de qualquer coisa aqui começar:

- [ ] Eventos de webhook chegando com `handled: 'prospecting'` ou `handled: 'site'`
- [ ] Mensagem inbound aparecendo no inbox sem depender do ciclo de polling
- [ ] Zero duplicata com webhook e polling rodando juntos
- [ ] Nenhum disparo duplicado do bot do `/site`

Sem isso, desligar o polling troca um caminho comprovado por um não comprovado — que é
exatamente o erro que as três fases foram desenhadas para evitar.

## O que falta

| item | estado hoje |
|---|---|
| `startPolling()` | rodando no Railway |
| `startSitePolling()` | rodando no Railway |
| `startCrmSyncWorker()` | rodando no Railway **e** disponível como cron (Fase 1) |
| `vercel.json`, `api/index.js` | existem, nada apontado |
| webhook do Unipile | aponta para o Railway |
| `webhook_raw_log` + captura | instrumentação temporária, ainda útil |
| órfãos no Storage | nenhuma limpeza |

## Sequência

A ordem existe para manter a propriedade que tornou as fases anteriores seguras: **uma
variável por vez**, e sempre com o caminho antigo de pé até o novo se provar.

**1. Deploy na Vercel sem mover o webhook.**
A Vercel sobe com **apenas o cron do reconciliador**. A ingestão continua chegando no
Railway. Prova que a plataforma sobe, conecta no banco e reconcilia — sem nenhum tráfego
real dependendo dela.

> ⚠️ **O cron de CRM sync fica de fora deste passo, de propósito.** Ao contrário do
> reconciliador, ele **não** é idempotente sob concorrência: `getPendingSyncs()` seleciona
> `sync_status = 'pending'` e só marca o status depois de concluir, sem claim nem lease.
> Rodá-lo na Vercel com `startCrmSyncWorker()` ainda de pé no Railway faria os dois pegarem
> as mesmas entradas e criarem pessoa/deal/atividade **em duplicata no Pipedrive** — que não
> tem constraint para desfazer. Ele entra no `vercel.json` no mesmo passo em que o worker do
> Railway sai. Nunca os dois.

Env vars necessárias: as mesmas do Railway, mais `CRON_SECRET`. Sem ele os endpoints de
cron falham fechado, por desenho. **`PUBLIC_URL` deve apontar para a Vercel, não para o
Railway** — é ela que monta a URL de registro do webhook.

**2. Desligar o polling no Railway.**
Comentar as três chamadas dentro do `app.listen`. A ingestão passa a depender só do
webhook, ainda apontado para o Railway — então isto testa a **ingestão** isoladamente, sem
trocar de plataforma no mesmo passo.

Ponto de reversão: descomentar e redeployar.

**3. Mover o webhook do Unipile para a URL da Vercel.**
Este é o corte real. `scripts/register-unipile-webhooks.js` já faz isso de forma
idempotente — basta `PUBLIC_URL` apontando para a Vercel.

O Railway continua de pé, sem webhook, como rollback imediato: reapontar o webhook devolve
tudo em segundos.

**4. Observar, depois desligar o Railway.**

## Limpeza que acompanha

- `webhook_raw_log`: dropar tabela e remover a captura de `src/routes/webhooks.js`. Manter
  até aqui porque é a única janela para o payload cru se algo divergir no caminho.
- Migrations 023 e 024 documentam o próprio fim.
- `.claude/probe-webhook.mjs` e `.claude/probe-parser.mjs`: sondas de diagnóstico, já
  gitignored. Manter — são baratas e reutilizáveis no próximo incidente de webhook.
- Órfãos no Storage: arquivo subido cujo envio foi abandonado. Job de limpeza entra de
  carona no cron do CRM sync, apagando objetos em `outbound/` com mais de 24 h que não
  aparecem em nenhum `attachments` de mensagem.

## Riscos conhecidos

**O reconciliador cobre só `public`.** O fluxo `/site` não tem equivalente de
`resyncConversation`. Depois do passo 2, o `/site` fica sem rede de segurança: se o webhook
perder um evento dele, a mensagem não entra por nenhum caminho.

Duas saídas, a decidir com dados da Fase 2: escrever o resync do `/site` antes do passo 2,
ou aceitar a lacuna porque o volume do `/site` é baixo (39 leads, 299 mensagens no total
contra 42 mil da prospecção) e a recuperação manual via `backfill-site-chat.js` já existe.
A recomendação depende de quantos eventos do `/site` o webhook entregar de fato.

**Timeout do webhook.** O handler agora aguarda a ingestão. Se `processChat` demorar mais
que o timeout do Unipile, ele re-entrega — inofensivo pelo dedup, mas gera trabalho
repetido. Medir a duração real na Fase 2 antes de decidir se vale otimizar.

**Cold start da Vercel.** Primeira invocação após ociosidade adiciona latência ao webhook.
Com o bot do `/site` no caminho, isso é visível para o lead. Medir; se incomodar, o
`fluid compute` da Vercel ou um cron de aquecimento resolvem.

## Critérios de sucesso

- [ ] Vercel servindo todo o tráfego, Railway desligado
- [ ] Nenhum `setInterval` no caminho de produção
- [ ] Inbox e bot do `/site` funcionando com latência igual ou melhor que hoje
- [ ] Upload de diagnóstico de ~6 MB funcionando pela Vercel
- [ ] `webhook_raw_log` dropada e captura removida
- [ ] Sem órfãos acumulando no bucket
