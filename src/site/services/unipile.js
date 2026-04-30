/**
 * Site Unipile client — wrapper enxuto pra a API do Unipile, usado APENAS
 * pelo fluxo do site. Compartilha as credenciais (UNIPILE_DSN/API_KEY) com o
 * fluxo de prospecção, mas opera só nas contas registradas em
 * site.whatsapp_accounts. NUNCA importar `src/services/unipile.js` daqui —
 * o isolamento entre os dois fluxos depende de não cruzar polling.
 */
import 'dotenv/config';

const API_KEY = process.env.UNIPILE_API_KEY;
const DSN     = process.env.UNIPILE_DSN;
const BASE    = DSN ? `https://${DSN}/api/v1` : null;

export function isAvailable() {
    return !!(API_KEY && DSN);
}

export async function unipileFetch(endpoint, options = {}, timeoutMs = 10_000) {
    if (!isAvailable()) throw new Error('Unipile não configurado');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${BASE}${endpoint}`, {
            ...options,
            signal: controller.signal,
            headers: {
                'X-API-KEY': API_KEY,
                'Accept':    'application/json',
                ...(options.headers || {}),
            },
        });
        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Unipile (${res.status}): ${err}`);
        }
        return res.json();
    } catch (err) {
        if (err.name === 'AbortError') throw new Error('Timeout — Unipile não respondeu');
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

// ─── Account ──────────────────────────────────────────────────────────

export async function getAccount(accountId) {
    return unipileFetch(`/accounts/${accountId}`, {}, 6000);
}

export async function connectWhatsApp() {
    return unipileFetch('/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'WHATSAPP' }),
    }, 35_000);
}

export async function deleteAccount(accountId) {
    return unipileFetch(`/accounts/${accountId}`, { method: 'DELETE' }, 8000);
}

// ─── Chats / messages ────────────────────────────────────────────────

export async function listChats(accountId, { limit = 30, cursor } = {}) {
    let qs = `?account_id=${accountId}&account_type=WHATSAPP&limit=${limit}`;
    if (cursor) qs += `&cursor=${encodeURIComponent(cursor)}`;
    return unipileFetch(`/chats${qs}`);
}

export async function getChatAttendees(chatId) {
    return unipileFetch(`/chats/${chatId}/attendees`);
}

export async function getMessages(chatId, { limit = 50 } = {}) {
    return unipileFetch(`/chats/${chatId}/messages?limit=${limit}`);
}

export async function sendMessage(chatId, text) {
    const fd = new FormData();
    if (text) fd.append('text', text);
    return unipileFetch(`/chats/${chatId}/messages`, { method: 'POST', body: fd });
}
