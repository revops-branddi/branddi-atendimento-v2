# Migração Railway → Vercel — Fase 1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deixar o Atendimento-v2 pronto para rodar na Vercel resolvendo tudo que **não**
depende da incógnita do webhook, e resolver a própria incógnita com evidência.

**Architecture:** Fase 1 entrega quatro coisas independentes entre si: um harness de teste
(o projeto não tem nenhum), a captura do payload cru que decide o desenho da Fase 2, o
reconciliador que a Vercel vai rodar por cron, e o upload direto pro Storage. O roteador de
webhook **não** está nesta fase de propósito — escrevê-lo antes de conhecer o formato real
do payload seria inventar tipos.

**Tech Stack:** Node >= 20 (ESM), Express 4, `node:test` (embutido, zero dependência nova),
Supabase JS v2, Vercel Cron.

## Global Constraints

- `package.json` tem `"type": "module"` — todo código novo é ESM, nunca `require`.
- `engines.node` é `>=20.0.0`. Não usar API que exija Node 22+.
- **Zero dependência nova de teste.** Usar `node:test` e `node:assert`, embutidos.
- **O repositório é PÚBLICO.** Nenhum segredo em código, commit ou nome de arquivo.
- **Nunca commitar em `main`.** Branch por task, PR no fim.
- **Auto-envio é proibido em prospecção** (`public.*`, contas de SDR). Permitido só no
  fluxo `/site` (`site.*`) e **somente** pelo caminho do webhook.
- **O reconciliador NUNCA chama `processBotTurn()`.** Conversas recuperadas entram como
  `waiting_human`.
- Idempotência vem de `unipile_message_id UNIQUE` (migrations 001 e 007). Não inventar
  outro mecanismo de dedup.
- Próxima migration livre: **023** (a 022 é a última; note que existem duas `019`).

---

## Estrutura de arquivos

| arquivo | responsabilidade |
|---|---|
| `test/` | novo diretório de testes, um arquivo por unidade testada |
| `supabase/migrations/023_webhook_raw_log.sql` | tabela temporária de captura do Passo 0 |
| `src/routes/webhooks.js` | ganha captura crua antes de qualquer validação |
| `src/services/reconciler.js` | **novo** — núcleo puro + wrapper de IO do reconciliador |
| `src/routes/cron.js` | **novo** — endpoints HTTP que a Vercel Cron chama |
| `src/services/storage.js` | **novo** — signed URL e validação de chave de objeto |
| `src/routes/messages.js` | `send-media` passa a aceitar chave de objeto |
| `src/server.js` | `app.listen` condicional (não escuta em serverless) |
| `api/index.js` | **novo** — entrypoint da Vercel |
| `vercel.json` | **novo** — rotas e agenda de cron |

---

### Task 1: Harness de teste

O projeto não tem teste nenhum. Sem isso, nenhuma task seguinte tem como provar nada.

**Files:**
- Create: `test/smoke.test.js`
- Modify: `package.json` (adicionar script `test`)

**Interfaces:**
- Consumes: nada
- Produces: comando `npm test`, que roda `node --test test/`

- [ ] **Step 1: Escrever o teste que falha**

Criar `test/smoke.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('harness de teste esta vivo', () => {
    assert.equal(1 + 1, 2);
});
```

- [ ] **Step 2: Rodar e confirmar que falha por falta de script**

Run: `npm test`
Expected: FAIL — `npm error Missing script: "test"`

- [ ] **Step 3: Adicionar o script**

Em `package.json`, dentro de `"scripts"`, acrescentar:

```json
"test": "node --test test/"
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm test`
Expected: PASS — `# pass 1`

- [ ] **Step 5: Commit**

```bash
git add package.json test/smoke.test.js
git commit -m "test: add node:test harness"
```

---

### Task 2: Passo 0 — capturar o payload cru (BLOQUEANTE)

Decide entre hipótese (a) o Unipile não entrega e (b) o handler descarta em silêncio.
**Nada da Fase 2 começa antes desta task terminar.**

**Files:**
- Create: `supabase/migrations/023_webhook_raw_log.sql`
- Modify: `src/routes/webhooks.js:135` (inserir captura antes da validação de secret)

**Interfaces:**
- Consumes: nada
- Produces: tabela `public.webhook_raw_log`, consultável para decidir (a) vs (b)

- [ ] **Step 1: Escrever a migration**

Criar `supabase/migrations/023_webhook_raw_log.sql`:

```sql
-- Captura temporaria de payloads crus de webhook, para decidir se o Unipile
-- entrega eventos de mensagem. DROPAR depois que a Fase 2 fechar.
--
-- RLS on + zero policies = deny-all, igual as demais. Só service_role le.
create table if not exists public.webhook_raw_log (
    id          bigint generated always as identity primary key,
    received_at timestamptz not null default now(),
    headers     jsonb,
    body        jsonb
);

alter table public.webhook_raw_log enable row level security;

comment on table public.webhook_raw_log is
    'Temporaria — Passo 0 da migracao Vercel. Dropar apos decidir (a) vs (b).';
```

- [ ] **Step 2: Aplicar a migration no banco de produção**

Aplicar `supabase/migrations/023_webhook_raw_log.sql` no projeto
`vrkmrrdmbspuqscvuajr` pelo SQL editor do dashboard.

Verificar: a tabela existe e está com RLS ligado.

```sql
select relrowsecurity from pg_class where oid = 'public.webhook_raw_log'::regclass;
```

Expected: `true`

- [ ] **Step 3: Capturar o body ANTES de qualquer validação**

Em `src/routes/webhooks.js`, dentro de `router.post('/webhooks/unipile', ...)`, como
**primeira** instrução do `try` — antes da checagem de secret, que hoje é o primeiro
bloco:

```js
        // PASSO 0 (temporario): registra tudo que chega, antes de validar.
        // Precisa vir antes do secret check — se o secret estiver errado, e' isso
        // mesmo que precisamos enxergar. Falha silenciosa de proposito: captura
        // nunca pode derrubar o processamento real do webhook.
        try {
            await supabase.from('webhook_raw_log').insert({
                headers: {
                    'x-webhook-secret-present': Boolean(req.headers['x-webhook-secret']),
                    'content-type': req.headers['content-type'] || null,
                    'user-agent': req.headers['user-agent'] || null,
                },
                body: req.body || {},
            });
        } catch { /* captura e' best-effort */ }
```

Note que os headers são gravados **sem o valor** do secret — só se ele veio.
O repositório é público e o banco é lido por várias pessoas.

- [ ] **Step 4: Commit e merge para disparar deploy**

```bash
git add supabase/migrations/023_webhook_raw_log.sql src/routes/webhooks.js
git commit -m "chore: capture raw webhook payloads to settle delivery question"
git push -u origin <branch>
```

Abrir PR e mergear. O gatilho `push → deploy` está confirmado funcionando
(testado em 2026-08-07 com os PRs #175, #173 e #176).

- [ ] **Step 5: Confirmar que o deploy pegou**

Run: `curl -s https://branddi-chat.up.railway.app/api/health`
Expected: `uptime_s` abaixo de 120 — processo novo de pé.

- [ ] **Step 6: Aguardar tráfego real e ler o veredito**

O inbox recebe ~24 mensagens/hora. Aguardar 15 minutos e consultar:

```sql
-- 1) Chegou alguma coisa?
select count(*) as eventos, min(received_at) as primeiro, max(received_at) as ultimo
from public.webhook_raw_log;

-- 2) Onde a conta aparece no payload? (isto define o roteador da Fase 2)
select count(*)                                         as total,
       count(*) filter (where body ? 'account_id')      as account_id_na_raiz,
       count(*) filter (where body -> 'account' ? 'id') as account_aninhado,
       count(*) filter (where body ? 'id')              as tem_id_solto
from public.webhook_raw_log;

-- 3) Quais chaves de topo existem, e que tipos de evento chegaram
select distinct k as chave_de_topo
from public.webhook_raw_log, lateral jsonb_object_keys(body) k
order by 1;

select coalesce(body->>'event', body->>'type', '(sem event/type)') as tipo_evento,
       count(*)
from public.webhook_raw_log
group by 1 order by 2 desc;
```

**Interpretação — anotar o resultado no PR:**

| resultado | hipótese | consequência |
|---|---|---|
| 0 linhas | **(a)** Unipile não entrega | Fase 2 muda: reconciliador vira caminho principal, cadência sobe pra 1 min, e o bot do `/site` perde latência — reabrir a decisão A vs B com o usuário |
| linhas com evento de mensagem | **(b)** handler descartava | Fase 2 segue como desenhado; as chaves capturadas definem o roteador |

- [ ] **Step 7: Commit do achado**

Registrar o veredito num comentário do PR e em
`docs/superpowers/specs/2026-08-07-migracao-vercel-design.md`, substituindo a seção
"a evidência é ambígua" pela conclusão com os dados.

---

### Task 3: Reconciliador com núcleo puro

Roda por cron na Vercel. **Nunca dispara o bot.**

**Files:**
- Create: `src/services/reconciler.js`
- Create: `test/reconciler.test.js`

**Interfaces:**
- Consumes: `resyncConversation(conversationId, { limit })` de `src/services/unipile.js`
- Produces:
  - `pickStaleConversations(convs, { now, windowMs })` → `Array<{id}>` (puro)
  - `runReconciler({ now })` → `{ scanned: number, resynced: number, errors: number }`

- [ ] **Step 1: Escrever os testes que falham**

Criar `test/reconciler.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickStaleConversations } from '../src/services/reconciler.js';

const NOW = new Date('2026-08-07T12:00:00Z').getTime();
const WINDOW = 48 * 60 * 60 * 1000;

test('inclui conversa dentro da janela de 48h', () => {
    const convs = [{ id: 'a', last_message_at: '2026-08-07T11:00:00Z' }];
    assert.deepEqual(pickStaleConversations(convs, { now: NOW, windowMs: WINDOW }), [{ id: 'a' }]);
});

test('exclui conversa fora da janela', () => {
    const convs = [{ id: 'velha', last_message_at: '2026-08-01T12:00:00Z' }];
    assert.deepEqual(pickStaleConversations(convs, { now: NOW, windowMs: WINDOW }), []);
});

test('exclui conversa sem last_message_at em vez de quebrar', () => {
    const convs = [{ id: 'sem-data', last_message_at: null }];
    assert.deepEqual(pickStaleConversations(convs, { now: NOW, windowMs: WINDOW }), []);
});

test('nao exporta nada que dispare o bot', async () => {
    const mod = await import('../src/services/reconciler.js');
    const fonte = Object.keys(mod).join(' ');
    assert.ok(!/bot/i.test(fonte), 'reconciliador nao deve expor nada relacionado a bot');
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/services/reconciler.js'`

- [ ] **Step 3: Implementar o mínimo**

Criar `src/services/reconciler.js`:

```js
/**
 * Reconciliador — rede de seguranca da ingestao por webhook.
 *
 * REGRA DURA: este modulo NUNCA chama processBotTurn(). Ele busca mensagens
 * que podem ser ANTIGAS, e disparar o bot com base numa mensagem de ontem
 * seria auto-envio espontaneo — proibido pelo projeto. Mesma regra que
 * scripts/backfill-site-chat.js ja documenta.
 *
 * Conversas recuperadas entram como 'waiting_human'.
 */
import { resyncConversation } from './unipile.js';
import sb from './supabase.js';
import logger from './logger.js';

const WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Nucleo puro: decide o que reconciliar. Sem IO, para ser testavel.
 * Reconciliar todas as 2.428 conversas a cada 5 min seria desperdicio, e
 * conversa parada ha dias nao tem mensagem nova a recuperar.
 */
export function pickStaleConversations(convs, { now, windowMs = WINDOW_MS }) {
    return convs
        .filter(c => {
            if (!c.last_message_at) return false;
            const t = new Date(c.last_message_at).getTime();
            return Number.isFinite(t) && now - t <= windowMs;
        })
        .map(c => ({ id: c.id }));
}

export async function runReconciler({ now = Date.now() } = {}) {
    const since = new Date(now - WINDOW_MS).toISOString();
    const { data, error } = await sb
        .from('conversations')
        .select('id, last_message_at')
        .gte('last_message_at', since);

    if (error) throw new Error(`reconciler: ${error.message}`);

    const alvos = pickStaleConversations(data || [], { now });
    let resynced = 0, errors = 0;

    for (const { id } of alvos) {
        try {
            await resyncConversation(id, { limit: 20 });
            resynced++;
        } catch (err) {
            errors++;
            logger.warn('reconciler: falha ao resincronizar', { conversation_id: id, error: err.message });
        }
    }

    return { scanned: alvos.length, resynced, errors };
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm test`
Expected: PASS — 5 testes (1 smoke + 4 do reconciliador)

- [ ] **Step 5: Commit**

```bash
git add src/services/reconciler.js test/reconciler.test.js
git commit -m "feat: add reconciler with pure selection core"
```

---

### Task 4: Entrypoint da Vercel e cron

**Files:**
- Create: `api/index.js`
- Create: `src/routes/cron.js`
- Create: `vercel.json`
- Modify: `src/server.js` (listen condicional, montar rota de cron)
- Modify: `src/services/crm-sync.js:19-33` (extrair ciclo único exportável)

**Interfaces:**
- Consumes: `runReconciler({ now })` da Task 3
- Produces:
  - `isAuthorizedCron(authHeader, secret)` → `boolean` (puro)
  - `runCrmSyncOnce()` → `{ processed: number }` — exportada de `src/services/crm-sync.js`
  - `GET /api/cron/reconcile` e `GET /api/cron/crm-sync`, ambos exigindo header
    `authorization: Bearer <CRON_SECRET>`

> **Por que `runCrmSyncOnce` é nova.** Hoje só `startCrmSyncWorker()` é exportada, e ela
> é um `setInterval` — inútil em serverless. O ciclo único existe
> (`processPendingSyncs`, linha 24) mas é privado **e engole os próprios erros**, então
> um cron que a chamasse reportaria sucesso mesmo tendo falhado. A extração resolve as
> duas coisas de uma vez.

- [ ] **Step 1: Escrever o teste que falha**

Criar `test/cron-auth.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAuthorizedCron } from '../src/routes/cron.js';

test('aceita o secret correto', () => {
    assert.equal(isAuthorizedCron('Bearer abc123', 'abc123'), true);
});

test('recusa secret errado', () => {
    assert.equal(isAuthorizedCron('Bearer errado', 'abc123'), false);
});

test('recusa header ausente', () => {
    assert.equal(isAuthorizedCron(undefined, 'abc123'), false);
});

test('falha fechado quando o secret nao esta configurado', () => {
    assert.equal(isAuthorizedCron('Bearer qualquer', undefined), false);
    assert.equal(isAuthorizedCron('Bearer qualquer', ''), false);
});
```

O último teste é o que importa: sem `CRON_SECRET` configurado, o endpoint precisa
**recusar**, não liberar. O handler de webhook existente faz o contrário (sem secret,
aceita tudo) — não repetir esse padrão num endpoint que dispara trabalho.

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/routes/cron.js'`

- [ ] **Step 3: Implementar**

Criar `src/routes/cron.js`:

```js
/**
 * Endpoints chamados pela Vercel Cron. Cada um faz um ciclo e retorna.
 * Nada de setInterval — serverless nao mantem processo vivo.
 */
import { Router } from 'express';
import { runReconciler } from '../services/reconciler.js';
import logger from '../services/logger.js';

const router = Router();

/** Falha fechado: sem secret configurado, ninguem entra. */
export function isAuthorizedCron(authHeader, secret) {
    if (!secret) return false;
    if (!authHeader) return false;
    return authHeader === `Bearer ${secret}`;
}

function guard(req, res, next) {
    if (!isAuthorizedCron(req.headers.authorization, process.env.CRON_SECRET)) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    next();
}

router.get('/cron/reconcile', guard, async (req, res) => {
    try {
        const r = await runReconciler({});
        logger.info('cron reconcile', r);
        res.json({ ok: true, ...r });
    } catch (err) {
        logger.error('cron reconcile falhou', { error: err.message });
        res.status(500).json({ ok: false, error: err.message });
    }
});

router.get('/cron/crm-sync', guard, async (req, res) => {
    try {
        const r = await runCrmSyncOnce();
        logger.info('cron crm-sync', r);
        res.json({ ok: true, ...r });
    } catch (err) {
        logger.error('cron crm-sync falhou', { error: err.message });
        res.status(500).json({ ok: false, error: err.message });
    }
});

export default router;
```

com os imports no topo:

```js
import { runCrmSyncOnce } from '../services/crm-sync.js';
```

- [ ] **Step 3b: Extrair o ciclo único do CRM sync**

Em `src/services/crm-sync.js`, substituir o bloco das linhas 19-33 por:

```js
export function startCrmSyncWorker(intervalMs = 30_000) {
    logger.info('CRM Sync worker iniciado', { interval_ms: intervalMs });
    setInterval(() => {
        // O worker de processo longo nao pode deixar excecao escapar do
        // setInterval — viraria unhandled rejection e derrubaria o processo.
        runCrmSyncOnce().catch(err =>
            logger.warn('CRM Sync worker error', { error: err.message }));
    }, intervalMs);
}

/**
 * Um ciclo, com contagem e SEM engolir erro — e' o que o cron da Vercel chama.
 * Deixar a excecao subir e' o que permite ao endpoint responder 500 em vez de
 * reportar sucesso falso.
 */
export async function runCrmSyncOnce() {
    const pending = await getPendingSyncs(10);
    for (const syncEntry of pending) {
        await processSyncEntry(syncEntry);
    }
    return { processed: pending.length };
}
```

A função privada `processPendingSyncs` deixa de existir; `runCrmSyncOnce` ocupa o lugar
dela com contagem e propagação de erro.

Criar `api/index.js`:

```js
// Entrypoint da Vercel: reaproveita o mesmo app Express, sem escutar porta.
import app from '../src/server.js';
export default app;
```

Criar `vercel.json`:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "rewrites": [{ "source": "/(.*)", "destination": "/api/index" }],
  "crons": [
    { "path": "/api/cron/reconcile", "schedule": "*/5 * * * *" },
    { "path": "/api/cron/crm-sync", "schedule": "*/2 * * * *" }
  ]
}
```

O CRM sync roda hoje a cada 30 s. Dois minutos é o mais próximo que o Vercel Cron
permite sem virar desperdício — é fila de sincronização com o Pipedrive, não conversa
com lead, então o atraso não é percebido por ninguém.

- [ ] **Step 4: Tornar o `app.listen` condicional**

Em `src/server.js`, trocar o bloco `app.listen(PORT, () => { ... })` por:

```js
// Em serverless nao existe processo longo: a Vercel importa `app` e roteia.
// Os workers de setInterval so fazem sentido no Railway, e saem na Fase 2.
if (!process.env.VERCEL) {
    app.listen(PORT, () => {
        logger.info('Branddi Atendimento v2.0.0 iniciado', { port: PORT });

        try { startPolling(); } catch (err) {
            logger.warn('WhatsApp polling não iniciado', { error: err.message });
        }

        try { startSitePolling(); } catch (err) {
            logger.warn('Site WhatsApp polling não iniciado', { error: err.message });
        }

        startCrmSyncWorker();
    });
}
```

E montar a rota de cron junto das outras, perto de `app.use('/api', webhooksRouter)`:

```js
app.use('/api', cronRouter);
```

com o import correspondente no topo:

```js
import cronRouter from './routes/cron.js';
```

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `npm test`
Expected: PASS — 9 testes

- [ ] **Step 6: Confirmar que o Railway não regrediu**

Run: `npm start` e, noutro terminal, `curl -s localhost:3000/api/health`
Expected: JSON com `"status":"ok"` — o `app.listen` ainda roda fora da Vercel.

- [ ] **Step 7: Commit**

```bash
git add api/ vercel.json src/routes/cron.js test/cron-auth.test.js src/server.js
git commit -m "feat: add Vercel entrypoint and cron endpoints"
```

---

### Task 5: Upload direto para o Supabase Storage

Contorna o teto de 4,5 MB de corpo de request. O caso que motivou isso são os
diagnósticos comerciais, que já chegam a 6,27 MB e estão crescendo.

**Files:**
- Create: `src/services/storage.js`
- Create: `test/storage.test.js`
- Modify: `src/routes/messages.js` (`send-media` aceita chave de objeto)

**Interfaces:**
- Consumes: nada
- Produces:
  - `isValidObjectKey(key)` → `boolean` (puro)
  - `createUploadUrl(fileName)` → `{ key, signedUrl }`
  - `downloadObject(key)` → `{ buffer, fileName }`

- [ ] **Step 1: Escrever os testes que falham**

Criar `test/storage.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidObjectKey } from '../src/services/storage.js';

test('aceita chave gerada por nos', () => {
    assert.equal(isValidObjectKey('outbound/2026-08-07/9f8e7d6c-diagnostico.pdf'), true);
});

test('recusa path traversal', () => {
    assert.equal(isValidObjectKey('outbound/../../etc/passwd'), false);
});

test('recusa chave fora do prefixo outbound/', () => {
    assert.equal(isValidObjectKey('private/segredo.pdf'), false);
});

test('recusa vazio, nulo e nao-string', () => {
    assert.equal(isValidObjectKey(''), false);
    assert.equal(isValidObjectKey(null), false);
    assert.equal(isValidObjectKey(42), false);
});
```

Estes testes existem porque a chave vem do cliente. Sem validação, um atendente
autenticado poderia pedir que a function baixasse qualquer objeto do bucket e o
enviasse por WhatsApp.

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/services/storage.js'`

- [ ] **Step 3: Implementar**

Criar `src/services/storage.js`:

```js
/**
 * Upload de midia de saida via Supabase Storage.
 *
 * Por que existe: a Vercel limita o CORPO de request a 4.5 MB. Os diagnosticos
 * comerciais ja passam de 6 MB. O browser envia direto pro Storage (nao passa
 * pela function) e a function so recebe a chave, baixa e repassa pro Unipile —
 * o limite nao se aplica a fetch de saida.
 */
import { randomUUID } from 'node:crypto';
import sb from './supabase.js';

const BUCKET = 'outbound-media';
const PREFIX = 'outbound/';

/**
 * A chave vem do cliente, entao e' entrada nao-confiavel. Sem esta validacao,
 * um atendente autenticado poderia mandar a function baixar qualquer objeto do
 * bucket e envia-lo por WhatsApp.
 */
export function isValidObjectKey(key) {
    if (typeof key !== 'string' || key.length === 0) return false;
    if (!key.startsWith(PREFIX)) return false;
    if (key.includes('..')) return false;
    return /^outbound\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9._-]+$/.test(key);
}

export async function createUploadUrl(fileName) {
    const safe = String(fileName || 'arquivo').replace(/[^A-Za-z0-9._-]/g, '_');
    const dia = new Date().toISOString().slice(0, 10);
    const key = `${PREFIX}${dia}/${randomUUID()}-${safe}`;

    const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(key);
    if (error) throw new Error(`storage: ${error.message}`);

    return { key, signedUrl: data.signedUrl };
}

export async function downloadObject(key) {
    if (!isValidObjectKey(key)) throw new Error('storage: chave invalida');

    const { data, error } = await sb.storage.from(BUCKET).download(key);
    if (error) throw new Error(`storage: ${error.message}`);

    const buffer = Buffer.from(await data.arrayBuffer());
    const fileName = key.split('/').pop().replace(/^[0-9a-f-]{36}-/, '');
    return { buffer, fileName };
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm test`
Expected: PASS — 13 testes

- [ ] **Step 5: Criar o bucket no Supabase**

No dashboard do projeto `vrkmrrdmbspuqscvuajr`, criar o bucket `outbound-media`
como **privado**. Público permitiria que qualquer um lesse os diagnósticos pela URL.

- [ ] **Step 6: Aceitar chave de objeto no `send-media`**

Em `src/routes/messages.js`, na rota `router.post('/messages/:conversationId/send-media', ...)`,
antes de usar `file?.buffer`, inserir:

```js
        // Caminho novo: browser subiu direto pro Storage e mandou so' a chave.
        // Caminho antigo (multipart) segue valendo enquanto o Railway estiver de pe.
        let buffer = file?.buffer;
        let nomeArquivo = file?.originalname;

        if (!buffer && req.body.storage_key) {
            const baixado = await downloadObject(req.body.storage_key);
            buffer = baixado.buffer;
            nomeArquivo = baixado.fileName;
        }
```

e trocar a chamada seguinte para usar `buffer` e `nomeArquivo`:

```js
        const mediaResult = await sendMessage(chatId, text || null, buffer, nomeArquivo);
```

com o import no topo do arquivo:

```js
import { downloadObject } from '../services/storage.js';
```

- [ ] **Step 7: Adicionar a rota que emite a signed URL**

Em `src/routes/messages.js`, junto das outras rotas:

```js
// Emite URL assinada pro browser subir direto, sem passar pela function.
router.post('/messages/upload-url', async (req, res) => {
    try {
        const { file_name } = req.body || {};
        const r = await createUploadUrl(file_name);
        res.json(r);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
```

ajustando o import para `import { downloadObject, createUploadUrl } from '../services/storage.js';`

- [ ] **Step 8: Commit**

```bash
git add src/services/storage.js test/storage.test.js src/routes/messages.js
git commit -m "feat: upload media through Supabase Storage to bypass body limit"
```

---

## Fora do escopo desta fase

- **Roteador de webhook por conta** — depende do payload real, que a Task 2 revela.
  É a Fase 2.
- **Remoção dos três `setInterval`** — só depois que a ingestão por webhook estiver
  provada. Enquanto isso eles seguem rodando no Railway, que continua sendo produção.
- **Front-end do upload** — a rota `upload-url` fica pronta nesta fase; ligar o browser
  nela é trabalho de UI, separado.
- **Limpeza de órfãos no Storage** — entra junto do cron de CRM sync, na Fase 2.
- **Desligar o Railway** — último passo da Fase 2.

## Critérios de conclusão da Fase 1

- [ ] `npm test` passa com 13 testes
- [ ] `public.webhook_raw_log` existe, com RLS ligado, e recebeu tráfego real por 15 min
- [ ] O veredito (a) ou (b) está registrado na spec com os dados que o sustentam
- [ ] `npm start` continua subindo o servidor igual a hoje (Railway sem regressão)
- [ ] Bucket `outbound-media` criado como privado
- [ ] `vercel.json` e `api/index.js` existem, mas **nada foi apontado pra Vercel ainda**
