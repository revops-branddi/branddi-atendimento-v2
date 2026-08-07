import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidObjectKey } from '../src/services/storage.js';

// A chave vem do cliente, entao e' entrada nao-confiavel. Sem validacao, um
// atendente autenticado poderia mandar a function baixar qualquer objeto do
// bucket e envia-lo por WhatsApp.

test('aceita chave no formato que nos geramos', () => {
    assert.equal(isValidObjectKey('outbound/2026-08-07/9f8e7d6c-diagnostico.pdf'), true);
});

test('recusa path traversal', () => {
    assert.equal(isValidObjectKey('outbound/../../etc/passwd'), false);
});

test('recusa traversal escondido depois de um prefixo valido', () => {
    assert.equal(isValidObjectKey('outbound/2026-08-07/../../../secret.pdf'), false);
});

test('recusa chave fora do prefixo outbound/', () => {
    assert.equal(isValidObjectKey('private/segredo.pdf'), false);
});

test('recusa subdiretorio extra', () => {
    assert.equal(isValidObjectKey('outbound/2026-08-07/sub/arquivo.pdf'), false);
});

test('recusa data malformada', () => {
    assert.equal(isValidObjectKey('outbound/7-8-2026/arquivo.pdf'), false);
});

test('recusa vazio, nulo e nao-string', () => {
    assert.equal(isValidObjectKey(''), false);
    assert.equal(isValidObjectKey(null), false);
    assert.equal(isValidObjectKey(undefined), false);
    assert.equal(isValidObjectKey(42), false);
    assert.equal(isValidObjectKey({}), false);
});
