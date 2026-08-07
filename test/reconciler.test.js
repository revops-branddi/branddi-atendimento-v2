import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pickStaleConversations } from '../src/services/reconciler.js';

const NOW = new Date('2026-08-07T12:00:00Z').getTime();
const WINDOW = 48 * 60 * 60 * 1000;
const OPTS = { now: NOW, windowMs: WINDOW };

const conv = (id, isoOuNull, chat = 'chat-' + id) =>
    ({ id, whatsapp_chat_id: chat, last_message_at: isoOuNull });

const ids = r => r.alvos.map(a => a.id);

// ─── selecao ────────────────────────────────────────────────────────────

test('inclui conversa dentro da janela de 48h', () => {
    const r = pickStaleConversations([conv('a', '2026-08-07T11:00:00Z')], OPTS);
    assert.deepEqual(ids(r), ['a']);
    assert.equal(r.descartadas, 0);
});

test('exclui conversa fora da janela', () => {
    assert.deepEqual(ids(pickStaleConversations([conv('velha', '2026-08-01T12:00:00Z')], OPTS)), []);
});

test('exclui conversa sem last_message_at em vez de quebrar', () => {
    assert.deepEqual(ids(pickStaleConversations([conv('sem-data', null)], OPTS)), []);
});

test('exclui data invalida em vez de propagar NaN', () => {
    assert.deepEqual(ids(pickStaleConversations([conv('lixo', 'nao-e-data')], OPTS)), []);
});

test('inclui exatamente na borda da janela', () => {
    const borda = new Date(NOW - WINDOW).toISOString();
    assert.deepEqual(ids(pickStaleConversations([conv('borda', borda)], OPTS)), ['borda']);
});

test('exclui conversa que nao e de WhatsApp', () => {
    // Sem chat_id o resyncConversation rejeita; incluir so' gera erro logado a cada
    // ciclo, afogando erros reais em ruido previsivel.
    const c = { id: 'nao-wa', whatsapp_chat_id: null, last_message_at: '2026-08-07T11:00:00Z' };
    assert.deepEqual(ids(pickStaleConversations([c], OPTS)), []);
});

// ─── lote e truncamento ─────────────────────────────────────────────────
//
// Regressao de producao (2026-08-07): 103 conversas na janela de 48h, ~3s cada
// (ida ao Unipile) = ~309s, acima do corte de 300s da function da Vercel. O ciclo
// era interrompido no meio SEM aviso, entregando cobertura parcial como se fosse
// completa.
//
// Estreitar a janela seria a correcao errada: o filtro usa `last_message_at`, que
// e' o NOSSO registro — se o webhook perdeu a mensagem, o timestamp nao atualizou
// e a conversa sairia de uma janela curta, justamente o caso que ela deve pegar.

test('limita o lote e reporta quantas ficaram para os proximos ciclos', () => {
    const muitas = Array.from({ length: 50 }, (_, i) =>
        conv('c' + i, new Date(NOW - i * 60_000).toISOString()));
    const r = pickStaleConversations(muitas, { ...OPTS, max: 20 });
    assert.equal(r.alvos.length, 20);
    assert.equal(r.descartadas, 30);
});

test('prioriza atividade mais recente dentro do lote', () => {
    // A mais recente tem a maior chance de ter mensagem que o webhook perdeu.
    const convs = [
        conv('antiga',  '2026-08-06T12:00:00Z'),
        conv('recente', '2026-08-07T11:59:00Z'),
        conv('media',   '2026-08-07T06:00:00Z'),
    ];
    assert.deepEqual(ids(pickStaleConversations(convs, { ...OPTS, max: 2 })), ['recente', 'media']);
});

test('nao reporta descarte quando tudo coube', () => {
    const r = pickStaleConversations([conv('a', '2026-08-07T11:00:00Z')], { ...OPTS, max: 20 });
    assert.equal(r.descartadas, 0);
});

// ─── regra dura do projeto ──────────────────────────────────────────────

// O reconciliador busca mensagens que podem ser ANTIGAS, entao disparar o bot a
// partir dele seria auto-envio espontaneo. Verificamos o codigo-fonte, e nao os
// nomes exportados, porque a violacao que importa e' uma chamada interna.
test('reconciliador nunca importa nem chama o bot', async () => {
    const src = await readFile(new URL('../src/services/reconciler.js', import.meta.url), 'utf8');
    const codigo = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

    assert.ok(!/from\s+['"][^'"]*bot[^'"]*['"]/.test(codigo), 'nao deve importar modulo de bot');
    assert.ok(!/processBotTurn/.test(codigo), 'nao deve referenciar processBotTurn no codigo');
});
