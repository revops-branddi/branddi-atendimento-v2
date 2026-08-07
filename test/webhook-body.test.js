import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWebhookBody } from '../src/services/webhook-body.js';

// Payload real capturado em producao (2026-08-07), truncado.
const REAL = '{"event":"message_received","account_id":"oxF_Ozs3RuakhJkHk130Zg","chat_id":"4a_mbXjJX0WuvH5ndNaTDw"}';

test('recupera JSON que o parser de formulario virou nome de chave', () => {
    // express.urlencoded transforma a string JSON inteira numa chave de valor vazio
    const parsedRuim = { [REAL]: '' };
    const r = normalizeWebhookBody(parsedRuim, REAL);
    assert.equal(r.event, 'message_received');
    assert.equal(r.account_id, 'oxF_Ozs3RuakhJkHk130Zg');
});

test('mantem o body quando ele ja veio parseado como JSON de verdade', () => {
    const bom = { event: 'account.disconnected', account_id: 'abc' };
    const r = normalizeWebhookBody(bom, JSON.stringify(bom));
    assert.deepEqual(r, bom);
});

test('nao quebra quando o cru nao e JSON', () => {
    const parsed = { campo: 'valor' };
    assert.deepEqual(normalizeWebhookBody(parsed, 'isto nao e json'), parsed);
});

test('nao quebra sem corpo cru', () => {
    const parsed = { campo: 'valor' };
    assert.deepEqual(normalizeWebhookBody(parsed, undefined), parsed);
    assert.deepEqual(normalizeWebhookBody(parsed, ''), parsed);
});

test('devolve objeto vazio quando nao ha nada', () => {
    assert.deepEqual(normalizeWebhookBody(undefined, undefined), {});
    assert.deepEqual(normalizeWebhookBody(null, null), {});
});

test('ignora JSON cru que nao e objeto', () => {
    // Um array ou escalar no topo nao e' um envelope de webhook valido; manter o
    // parseado evita entregar ao handler algo em que ele fara .account_id e quebrara.
    const parsed = { campo: 'valor' };
    assert.deepEqual(normalizeWebhookBody(parsed, '[1,2,3]'), parsed);
    assert.deepEqual(normalizeWebhookBody(parsed, '"texto"'), parsed);
    assert.deepEqual(normalizeWebhookBody(parsed, 'null'), parsed);
});

test('prefere o cru quando o parseado esta vazio', () => {
    const r = normalizeWebhookBody({}, REAL);
    assert.equal(r.event, 'message_received');
});
