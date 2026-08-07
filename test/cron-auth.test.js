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

// O mais importante: sem CRON_SECRET configurado, o endpoint precisa RECUSAR.
// O handler de webhook existente faz o contrario — sem secret, aceita tudo — e
// esse padrao nao pode se repetir num endpoint que dispara trabalho.
test('falha fechado quando o secret nao esta configurado', () => {
    assert.equal(isAuthorizedCron('Bearer qualquer', undefined), false);
    assert.equal(isAuthorizedCron('Bearer qualquer', ''), false);
    assert.equal(isAuthorizedCron(undefined, undefined), false);
});

test('recusa header sem o prefixo Bearer', () => {
    assert.equal(isAuthorizedCron('abc123', 'abc123'), false);
});
