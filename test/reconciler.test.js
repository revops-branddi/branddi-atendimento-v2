import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pickStaleConversations } from '../src/services/reconciler.js';

const NOW = new Date('2026-08-07T12:00:00Z').getTime();
const WINDOW = 48 * 60 * 60 * 1000;

test('inclui conversa dentro da janela de 48h', () => {
    const convs = [{ id: 'a', whatsapp_chat_id: 'chat-a', last_message_at: '2026-08-07T11:00:00Z' }];
    assert.deepEqual(pickStaleConversations(convs, { now: NOW, windowMs: WINDOW }), [{ id: 'a' }]);
});

test('exclui conversa fora da janela', () => {
    const convs = [{ id: 'velha', whatsapp_chat_id: 'chat-v', last_message_at: '2026-08-01T12:00:00Z' }];
    assert.deepEqual(pickStaleConversations(convs, { now: NOW, windowMs: WINDOW }), []);
});

test('exclui conversa sem last_message_at em vez de quebrar', () => {
    const convs = [{ id: 'sem-data', whatsapp_chat_id: 'chat-s', last_message_at: null }];
    assert.deepEqual(pickStaleConversations(convs, { now: NOW, windowMs: WINDOW }), []);
});

test('exclui data invalida em vez de propagar NaN', () => {
    const convs = [{ id: 'lixo', whatsapp_chat_id: 'chat-l', last_message_at: 'nao-e-data' }];
    assert.deepEqual(pickStaleConversations(convs, { now: NOW, windowMs: WINDOW }), []);
});

test('inclui exatamente na borda da janela', () => {
    const convs = [{ id: 'borda', whatsapp_chat_id: 'chat-b', last_message_at: new Date(NOW - WINDOW).toISOString() }];
    assert.deepEqual(pickStaleConversations(convs, { now: NOW, windowMs: WINDOW }), [{ id: 'borda' }]);
});

// A regra dura do projeto: o reconciliador busca mensagens que podem ser ANTIGAS,
// entao disparar o bot a partir dele seria auto-envio espontaneo. Verificamos o
// codigo-fonte, e nao apenas os nomes exportados, porque a violacao que importa e'
// uma chamada interna — que nenhuma inspecao de exports revelaria.
test('exclui conversa que nao e de WhatsApp', () => {
    // Sem chat_id o resyncConversation rejeita; incluir so' gera erro logado a cada
    // ciclo de 5 min, afogando erros reais em ruido previsivel.
    const convs = [{ id: 'nao-wa', whatsapp_chat_id: null, last_message_at: '2026-08-07T11:00:00Z' }];
    assert.deepEqual(pickStaleConversations(convs, { now: NOW, windowMs: WINDOW }), []);
});

test('reconciliador nunca importa nem chama o bot', async () => {
    const src = await readFile(new URL('../src/services/reconciler.js', import.meta.url), 'utf8');
    const codigo = src
        .replace(/\/\*[\s\S]*?\*\//g, '')   // remove blocos de comentario
        .replace(/^\s*\/\/.*$/gm, '');      // remove comentarios de linha

    assert.ok(!/from\s+['"][^'"]*bot[^'"]*['"]/.test(codigo), 'nao deve importar modulo de bot');
    assert.ok(!/processBotTurn/.test(codigo), 'nao deve referenciar processBotTurn no codigo');
});
