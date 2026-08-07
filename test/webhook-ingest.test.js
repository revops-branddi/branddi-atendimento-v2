import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatFromWebhook, classifyAccount, isMessageEvent } from '../src/services/webhook-ingest.js';

// Payload real capturado em producao em 2026-08-07 (campos relevantes).
const REAL = {
    event: 'message_received',
    account_id: 'oxF_Ozs3RuakhJkHk130Zg',
    account_type: 'WHATSAPP',
    chat_id: 'Mt7z-46aX5ejY1M4kk1kqg',
    message: 'Ana',
    message_id: 'q5V_XX9mUZOh0F01_FPlJg',
    timestamp: '2026-08-07T13:48:04.000Z',
    is_sender: false,
    provider_chat_id: '5511968298133@s.whatsapp.net',
    is_group: false,
    folder: ['INBOX'],
};

// ─── chatFromWebhook ────────────────────────────────────────────────────

test('monta o objeto de chat a partir do payload real', () => {
    assert.deepEqual(chatFromWebhook(REAL), {
        id: 'Mt7z-46aX5ejY1M4kk1kqg',
        account_id: 'oxF_Ozs3RuakhJkHk130Zg',
        provider_id: '5511968298133@s.whatsapp.net',
        type: 0,
    });
});

// type === 1 e' como isGroupChat() reconhece grupo; se este mapeamento quebrar,
// grupo entra no caminho de 1-1 e cria lead falso pra cada participante.
test('marca grupo com type 1', () => {
    const c = chatFromWebhook({ ...REAL, is_group: true, provider_chat_id: '123@g.us' });
    assert.equal(c.type, 1);
    assert.equal(c.provider_id, '123@g.us');
});

test('devolve null sem chat_id, em vez de um chat invalido', () => {
    assert.equal(chatFromWebhook({ ...REAL, chat_id: undefined }), null);
    assert.equal(chatFromWebhook({}), null);
    assert.equal(chatFromWebhook(null), null);
});

test('devolve null sem account_id', () => {
    assert.equal(chatFromWebhook({ ...REAL, account_id: null }), null);
});

// ─── isMessageEvent ─────────────────────────────────────────────────────

test('reconhece evento de mensagem', () => {
    assert.equal(isMessageEvent(REAL), true);
    assert.equal(isMessageEvent({ event: 'message_received' }), true);
});

test('nao confunde evento de conta com mensagem', () => {
    assert.equal(isMessageEvent({ event: 'account.disconnected' }), false);
    assert.equal(isMessageEvent({ type: 'account.status' }), false);
    assert.equal(isMessageEvent({}), false);
    assert.equal(isMessageEvent(null), false);
});

// ─── classifyAccount ────────────────────────────────────────────────────

const LISTAS = {
    ignoredIds: ['ignorada-1', 'oxF_Ozs3RuakhJkHk130Zg'],
    siteIds:    ['conta-site'],
    publicIds:  ['conta-prospec', 'oxF_Ozs3RuakhJkHk130Zg'],
};

test('ignorada vence prospeccao mesmo estando nas duas listas', () => {
    // A conta ignorada TAMBEM aparece em public.whatsapp_accounts — e' assim que
    // ela e' marcada. Se a ordem de checagem inverter, conversa de outro time
    // entra no inbox da Branddi.
    assert.equal(classifyAccount('oxF_Ozs3RuakhJkHk130Zg', LISTAS), 'ignored');
});

test('classifica site e prospeccao', () => {
    assert.equal(classifyAccount('conta-site', LISTAS), 'site');
    assert.equal(classifyAccount('conta-prospec', LISTAS), 'prospecting');
});

test('conta desconhecida e desconhecida, nunca chutada', () => {
    assert.equal(classifyAccount('nunca-vista', LISTAS), 'unknown');
});

test('entrada invalida cai em unknown', () => {
    assert.equal(classifyAccount(null, LISTAS), 'unknown');
    assert.equal(classifyAccount('', LISTAS), 'unknown');
    assert.equal(classifyAccount(undefined, LISTAS), 'unknown');
});

// Falha fechado: se a resolucao das listas falhar, tudo vira unknown e nada e'
// ingerido. O contrario — assumir prospeccao por padrao — faria conta de
// terceiro entrar no banco.
test('sem listas, tudo e unknown', () => {
    assert.equal(classifyAccount('conta-site', {}), 'unknown');
    assert.equal(classifyAccount('conta-site', { ignoredIds: [], siteIds: [], publicIds: [] }), 'unknown');
});
