/**
 * Site Inbox — Fase 2 (read-only)
 * Lista conversas + viewer de mensagens. Sem envio nesta fase.
 */
const API = '/api/site';

async function api(path) {
    const res = await fetch(`${API}${path}`, { credentials: 'include' });
    if (res.status === 401) { window.location.href = '/login.html'; throw new Error('unauthorized'); }
    if (res.status === 403) {
        document.body.replaceChildren(el('div', { style: 'padding:40px;text-align:center;color:#6b7280' }, 'Você não tem acesso ao Atendimento Site.'));
        throw new Error('forbidden');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'class') node.className = v;
        else if (k === 'style') node.setAttribute('style', v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
    }
    for (const c of children.flat()) {
        if (c == null) continue;
        node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
}

let activeConvId = null;

function emptyMsg(text) {
    return el('div', { class: 'site-empty' }, text);
}

async function loadConversations() {
    const list = document.getElementById('conv-list');
    list.replaceChildren(emptyMsg('Carregando…'));
    try {
        const convs = await api('/conversations');
        if (!convs.length) {
            list.replaceChildren(emptyMsg('Sem conversas ainda'));
            return;
        }
        list.replaceChildren(...convs.map(c => {
            const item = el('div',
                { class: 'conv-item', dataset: { id: c.id }, onclick: () => openConversation(c.id) },
                el('div', { class: 'name' }, c.leads?.name || c.leads?.phone || 'Sem nome'),
                el('div', { class: 'preview' }, c.leads?.company_name || c.leads?.email || ''),
                el('div', { class: 'meta' },
                    el('span', { class: `badge badge-${c.status}` }, c.status),
                    el('span', {}, fmtTime(c.last_message_at || c.created_at)),
                ),
            );
            return item;
        }));
    } catch (err) {
        list.replaceChildren(emptyMsg(`Erro: ${err.message}`));
    }
}

async function openConversation(id) {
    activeConvId = id;
    document.querySelectorAll('.conv-item').forEach(it => it.classList.toggle('active', it.dataset.id === id));
    const viewer = document.getElementById('conv-viewer');
    viewer.replaceChildren(emptyMsg('Carregando…'));
    try {
        const [conv, msgs] = await Promise.all([api(`/conversations/${id}`), api(`/messages/${id}`)]);

        const header = el('div', { style: 'padding-bottom:8px;border-bottom:1px solid #e5e7eb;margin-bottom:8px' },
            el('strong', {}, conv.leads?.name || 'Sem nome'),
            el('span', { style: 'color:#6b7280;margin-left:8px' }, conv.leads?.phone || ''),
            el('span', { class: `badge badge-${conv.status}`, style: 'margin-left:8px' }, conv.status),
            el('span', { style: 'margin-left:8px;font-size:12px;color:#6b7280' }, `bot: ${conv.bot_stage || ''}`),
        );

        const msgList = el('div', { class: 'msg-list' });
        if (msgs.length) {
            msgs.forEach(m => msgList.append(
                el('div', { class: `msg ${m.direction}` },
                    el('div', { class: 'who' }, `${m.sender_name || m.sender_type || ''} · ${fmtTime(m.created_at)}`),
                    el('div', {}, m.text || ''),
                ),
            ));
        } else {
            msgList.append(emptyMsg('Sem mensagens'));
        }

        const stub = el('div', { class: 'stub' }, 'Envio de mensagens chega na Fase 3+. Por enquanto só leitura.');

        viewer.replaceChildren(header, msgList, stub);
    } catch (err) {
        viewer.replaceChildren(emptyMsg(`Erro: ${err.message}`));
    }
}

loadConversations();
