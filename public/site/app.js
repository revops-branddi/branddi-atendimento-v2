/**
 * Site Inbox — atendimento humano (sem bot).
 *
 * Polling: lista de conversas a cada 8s, thread aberta a cada 5s. Mantém UX
 * aceitável sem precisar de WebSocket nesta fase. Quando o volume justificar,
 * a troca pra Realtime do Supabase é local (este arquivo).
 */
const API = '/api/site';
const LIST_POLL_MS = 8_000;
const THREAD_POLL_MS = 5_000;
const STATUS_POLL_MS = 30_000;

// ─── Auth + fetch helpers ────────────────────────────────────────────

function getToken() {
    return localStorage.getItem('ba_token');
}

function getUser() {
    try { return JSON.parse(localStorage.getItem('ba_user') || '{}'); }
    catch { return {}; }
}

async function api(path, options = {}) {
    const token = getToken();
    if (!token) { window.location.href = '/login.html'; throw new Error('unauthenticated'); }

    const res = await fetch(`${API}${path}`, {
        credentials: 'include',
        ...options,
        headers: {
            Authorization: `Bearer ${token}`,
            ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
            ...(options.headers || {}),
        },
    });
    if (res.status === 401) {
        localStorage.removeItem('ba_token');
        localStorage.removeItem('ba_user');
        window.location.href = '/login.html';
        throw new Error('unauthorized');
    }
    if (res.status === 403) {
        document.body.replaceChildren(el('div', { style: 'padding:40px;text-align:center;color:#6b7280' }, 'Você não tem acesso ao Atendimento Site.'));
        throw new Error('forbidden');
    }
    if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).error || msg; } catch {}
        throw new Error(msg);
    }
    if (res.status === 204) return null;
    return res.json();
}

function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) {
        return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'style') node.setAttribute('style', v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
    }
    for (const c of children.flat()) {
        if (c == null || c === false) continue;
        node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
}

function toast(msg, kind = 'info') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = `toast show ${kind === 'error' ? 'error' : ''}`;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 3000);
}

const STATUS_LABEL = {
    waiting_human: 'Aguardando',
    in_progress:   'Em andamento',
    resolved:      'Resolvida',
};

// ─── State ───────────────────────────────────────────────────────────

const state = {
    activeConvId: null,
    activeConv:   null,
    filter:       'all',
    convs:        [],
    me:           getUser(),
};

let listPollHandle   = null;
let threadPollHandle = null;
let statusPollHandle = null;

// ─── List rendering ──────────────────────────────────────────────────

function emptyMsg(text) {
    return el('div', { class: 'site-empty' }, text);
}

function buildListQuery() {
    const params = new URLSearchParams();
    if (state.filter === 'mine')          params.set('mine', '1');
    else if (state.filter === 'waiting_human' || state.filter === 'in_progress' || state.filter === 'resolved') {
        params.set('status', state.filter);
    }
    const qs = params.toString();
    return qs ? `/conversations?${qs}` : '/conversations';
}

async function loadConversations({ silent = false } = {}) {
    const list = document.getElementById('conv-list');
    if (!silent) list.replaceChildren(emptyMsg('Carregando…'));
    try {
        const convs = await api(buildListQuery());
        state.convs = convs;
        if (!convs.length) {
            list.replaceChildren(emptyMsg('Sem conversas'));
            state._listHash = '';
            return;
        }
        // Skip render se nada relevante mudou — evita flicker do polling.
        // Hash leve: id + last_message_at + status + assigned + nome do lead.
        const hash = JSON.stringify(convs.map(c =>
            [c.id, c.last_message_at, c.status, c.assigned_user_id, c.leads?.name]
        ));
        if (silent && hash === state._listHash) return;
        state._listHash = hash;
        list.replaceChildren(...convs.map(renderConvItem));
    } catch (err) {
        if (!silent) list.replaceChildren(emptyMsg(`Erro: ${err.message}`));
    }
}

function renderConvItem(c) {
    const isMine = c.assigned_user_id && c.assigned_user_id === state.me.id;
    return el('div', {
        class: `conv-item ${c.id === state.activeConvId ? 'active' : ''}`,
        dataset: { id: c.id },
        onclick: () => openConversation(c.id),
    },
        el('div', { class: 'name' },
            el('span', {}, c.leads?.name || c.leads?.phone || 'Sem nome'),
            el('time', {}, fmtTime(c.last_message_at || c.created_at)),
        ),
        el('div', { class: 'preview' }, c.leads?.company_name || c.leads?.email || c.leads?.phone || ''),
        el('div', { class: 'meta' },
            el('span', { class: `badge badge-${c.status}` }, STATUS_LABEL[c.status] || c.status),
            isMine && el('span', { class: 'status-pill' }, 'minha'),
        ),
    );
}

// ─── Filters ─────────────────────────────────────────────────────────

document.getElementById('filters').addEventListener('click', (e) => {
    const btn = e.target.closest('.filter-btn');
    if (!btn) return;
    state.filter = btn.dataset.filter;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b === btn));
    loadConversations();
});

// ─── Conversation viewer ─────────────────────────────────────────────

async function openConversation(id) {
    state.activeConvId = id;
    state._threadHash  = ''; // reset pra forçar render da nova conversa
    document.querySelectorAll('.conv-item').forEach(it => it.classList.toggle('active', it.dataset.id === id));
    // Tira o estado vazio do viewer: a classe `site-empty` herda text-align:center
    // e o style inline `margin:auto` quebra o flex da thread. Trocamos pra
    // `conv-view` (flex column) só quando há conversa selecionada.
    const viewer = document.getElementById('conv-viewer');
    viewer.className = 'conv-view';
    viewer.removeAttribute('style');
    await renderConversation({ initial: true });
}

async function renderConversation({ initial = false } = {}) {
    const id = state.activeConvId;
    if (!id) return;
    const viewer = document.getElementById('conv-viewer');
    if (initial) viewer.replaceChildren(emptyMsg('Carregando…'));

    let conv, msgs;
    try {
        [conv, msgs] = await Promise.all([api(`/conversations/${id}`), api(`/messages/${id}`)]);
    } catch (err) {
        if (initial) viewer.replaceChildren(emptyMsg(`Erro: ${err.message}`));
        return;
    }
    state.activeConv = conv;

    // Hash de tudo que afeta a renderização — se nada mudou, evita rebuild
    // (que causa flicker, perda de seleção de texto e scroll-jump no poll).
    const hash = JSON.stringify({
        cid:    id,
        cstatus: conv.status,
        cassigned: conv.assigned_user_id,
        ccls: conv.leads?.classification,
        cdeal: conv.leads?.crm_deal_id,
        msgs: msgs.map(m => [m.id, m.text, m.delivered, m.seen, m.sender_name]),
    });
    if (!initial && hash === state._threadHash) return;
    state._threadHash = hash;

    const header = renderHeader(conv);
    const list   = renderMessages(msgs);
    const composer = renderComposer(conv);

    // Reusa o nó composer se possível pra preservar foco/digitação durante poll.
    const existing = viewer.querySelector('.composer textarea');
    const draft = existing && existing.value;
    const hasFocus = existing && document.activeElement === existing;

    viewer.replaceChildren(header, list, composer);

    // Auto-scroll para o fim das mensagens.
    const msgListEl = viewer.querySelector('.msg-list');
    msgListEl.scrollTop = msgListEl.scrollHeight;

    // Restaura rascunho.
    if (draft) {
        const ta = composer.querySelector('textarea');
        ta.value = draft;
        if (hasFocus) ta.focus();
    }
}

function renderHeader(conv) {
    const lead = conv.leads || {};
    const isMine = conv.assigned_user_id === state.me.id;

    const statusSel = el('select', {
        title: 'Status', onchange: (e) => patchConv({ status: e.target.value }),
    },
        ...['waiting_human', 'in_progress', 'resolved'].map(s =>
            el('option', { value: s, selected: conv.status === s }, STATUS_LABEL[s])
        ),
    );

    const claimBtn = isMine
        ? el('button', { onclick: () => patchConv({ assigned_user_id: null }) }, 'Liberar')
        : el('button', { class: 'primary', onclick: () => patchConv({ assigned_user_id: 'me' }) }, 'Atender');

    const assignedLabel = conv.assigned_user_id
        ? (isMine ? 'atribuída a mim' : 'atribuída a outro')
        : 'sem atribuição';

    return el('div', { class: 'conv-header' },
        el('div', { class: 'info' },
            el('div', { class: 'name' },
                lead.name || lead.phone || 'Sem nome',
                renderClassificationBadge(lead),
            ),
            el('div', { class: 'sub' },
                lead.phone ? `${lead.phone} · ` : '',
                lead.company_name || lead.email || '',
                ` · ${assignedLabel}`,
            ),
        ),
        el('div', { class: 'conv-actions' },
            ...renderClassificationButtons(conv, lead),
            statusSel,
            claimBtn,
        ),
    );
}

function renderClassificationBadge(lead) {
    if (lead.classification === 'comercial') {
        const label = lead.crm_deal_id
            ? `Comercial · Deal #${lead.crm_deal_id}`
            : 'Comercial';
        return el('span', { class: 'classification-pill comercial', title: label }, label);
    }
    if (lead.classification === 'opec') {
        return el('span', { class: 'classification-pill opec' }, 'OPEC');
    }
    return null;
}

function renderClassificationButtons(conv, lead) {
    // Lead já classificado → não mostra botões (badge já indica o estado).
    if (lead.classification === 'comercial' || lead.classification === 'opec') {
        return [];
    }
    return [
        el('button', {
            class: 'primary',
            title: 'Cria Person + Deal no Pipedrive',
            onclick: () => routeLead('comercial'),
        }, 'Comercial'),
        el('button', {
            title: 'Cria task no Google Chat do time OPEC',
            onclick: () => openOpecModal(conv, lead),
        }, 'OPEC'),
    ];
}

async function routeLead(target) {
    const id = state.activeConvId;
    if (!id) return;
    if (target !== 'comercial') {
        // OPEC vai pelo modal; aqui só Comercial usa confirm direto.
        return;
    }
    if (!confirm('Criar Person + Deal no Pipedrive pra esse lead?')) return;
    try {
        const res = await api(`/conversations/${id}/route-comercial`, { method: 'POST' });
        const msg = res.already_routed
            ? `Já tinha deal #${res.deal_id}`
            : `Deal #${res.deal_id} criado no Pipedrive`;
        toast(msg, 'success');
        await Promise.all([renderConversation(), loadConversations({ silent: true })]);
    } catch (err) {
        toast(err.message, 'error');
    }
}

// ─── OPEC Modal ──────────────────────────────────────────────────────

const OPEC_OPTIONS = [
    { value: 'bb',     label: 'TakeDown BB',     hint: 'notificacao@brandmonitor.com.br · Giselle França' },
    { value: 'golpes', label: 'TakeDown Golpes', hint: 'fraud@branddi.com · Caroline Cipriani' },
    { value: 'vm',     label: 'TakeDown VM',     hint: 'ip-violations-report@brandmonitor.com.br · João França' },
];

async function openOpecModal(conv, lead) {
    // Pré-preenche textarea com últimas msgs inbound da conversa (lead falou)
    let prefill = '';
    try {
        const msgs = await api(`/messages/${conv.id}`);
        prefill = (msgs || [])
            .filter(m => m.direction === 'inbound')
            .slice(-10)
            .map(m => (m.text || '').trim())
            .filter(Boolean)
            .join('\n\n');
    } catch { /* segue sem prefill */ }

    const overlay = el('div', { class: 'opec-modal-overlay', onclick: (e) => {
        if (e.target === overlay) closeOpecModal();
    } });

    const radioGroup = el('div', { class: 'opec-radio-group' },
        ...OPEC_OPTIONS.map(opt => el('label', { class: 'opec-radio' },
            el('input', { type: 'radio', name: 'opec-cat', value: opt.value }),
            el('div', { class: 'opec-radio-body' },
                el('div', { class: 'opec-radio-label' }, opt.label),
                el('div', { class: 'opec-radio-hint' }, opt.hint),
            ),
        )),
    );

    const subjectTa = el('textarea', {
        class: 'opec-subject',
        rows: '8',
        placeholder: 'Resumo / contexto do que o lead quer (edite à vontade)…',
    });
    subjectTa.value = prefill;

    const submitBtn = el('button', { class: 'opec-submit', disabled: true }, 'Enviar pro time OPEC');
    const cancelBtn = el('button', { class: 'opec-cancel', onclick: closeOpecModal }, 'Cancelar');

    radioGroup.addEventListener('change', () => {
        const selected = radioGroup.querySelector('input[name="opec-cat"]:checked');
        submitBtn.disabled = !selected;
    });

    submitBtn.onclick = async () => {
        const selected = radioGroup.querySelector('input[name="opec-cat"]:checked');
        if (!selected) return;
        const category = selected.value;
        const subject  = subjectTa.value.trim();

        submitBtn.disabled = true;
        submitBtn.textContent = 'Enviando…';
        try {
            const res = await api(`/conversations/${conv.id}/route-opec`, {
                method: 'POST',
                body:   JSON.stringify({ category, subject }),
            });
            closeOpecModal();
            if (res.gchat_error) {
                toast(`Lead marcado como OPEC, mas envio pro GChat falhou: ${res.gchat_error}`, 'error');
            } else {
                toast(`Lead enviado pro time ${OPEC_OPTIONS.find(o => o.value === category).label}`, 'success');
            }
            await Promise.all([renderConversation(), loadConversations({ silent: true })]);
        } catch (err) {
            toast(err.message, 'error');
            submitBtn.disabled = false;
            submitBtn.textContent = 'Enviar pro time OPEC';
        }
    };

    overlay.append(
        el('div', { class: 'opec-modal' },
            el('div', { class: 'opec-modal-header' },
                el('h3', {}, 'Encaminhar pra OPEC'),
                el('div', { class: 'opec-modal-sub' },
                    `${lead.name || lead.phone || ''}${lead.company_name ? ' · ' + lead.company_name : ''}`,
                ),
            ),
            el('div', { class: 'opec-modal-body' },
                el('div', { class: 'opec-section-label' }, 'Qual time atende esse caso?'),
                radioGroup,
                el('div', { class: 'opec-section-label' }, 'Resumo / contexto'),
                subjectTa,
            ),
            el('div', { class: 'opec-modal-footer' },
                cancelBtn,
                submitBtn,
            ),
        ),
    );

    document.body.appendChild(overlay);
    // Foco no primeiro radio pra acessibilidade
    setTimeout(() => radioGroup.querySelector('input[type="radio"]')?.focus(), 50);
}

function closeOpecModal() {
    document.querySelector('.opec-modal-overlay')?.remove();
}

function renderMessages(msgs) {
    const list = el('div', { class: 'msg-list' });
    if (!msgs.length) {
        list.append(emptyMsg('Sem mensagens ainda'));
        return list;
    }
    const leadName = state.activeConv?.leads?.name || '';
    msgs.forEach(m => {
        const senderLabel = m.sender_name || (m.sender_type === 'human' ? 'Atendente' : 'Lead');
        const fallback    = m.direction === 'inbound' ? leadName : senderLabel;
        list.append(
            el('div', { class: `msg ${m.direction}` },
                el('div', { class: 'who' }, senderLabel),
                el('div', {}, resolveLidPlaceholders(m.text || '', fallback)),
                el('div', { class: 'when' }, fmtTime(m.created_at)),
            ),
        );
    });
    return list;
}

// Substitui placeholders {{<id>@lid}} / {{<id>@s.whatsapp.net}} que o Unipile
// mete literal em mensagens de reação/evento, pelo nome do lead (DM 1-1 só
// tem 1 attendee não-self). Mesma lógica de public/app.js:resolveLidPlaceholders.
function resolveLidPlaceholders(text, fallbackName) {
    if (!text || !fallbackName) return text;
    return text.replace(/\{\{[^{}]*?@(?:lid|s\.whatsapp\.net)\}\}/g, fallbackName);
}

function renderComposer(conv) {
    const isResolved = conv.status === 'resolved';
    const ta = el('textarea', {
        placeholder: isResolved ? 'Conversa resolvida — reabra pra responder' : 'Escreva uma mensagem…',
        rows: '2',
        disabled: isResolved,
        onkeydown: (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
            }
        },
    });
    const btn = el('button', { onclick: send, disabled: isResolved }, 'Enviar');

    async function send() {
        const text = ta.value.trim();
        if (!text) return;
        btn.disabled = true; ta.disabled = true;
        try {
            await api(`/messages/${conv.id}`, {
                method: 'POST',
                body: JSON.stringify({ text }),
            });
            ta.value = '';
            await renderConversation();
            await loadConversations({ silent: true });
        } catch (err) {
            toast(err.message, 'error');
        } finally {
            btn.disabled = false; ta.disabled = isResolved;
            ta.focus();
        }
    }

    return el('div', { class: `composer ${isResolved ? 'disabled' : ''}` }, ta, btn);
}

async function patchConv(patch) {
    const id = state.activeConvId;
    if (!id) return;
    try {
        await api(`/conversations/${id}`, {
            method: 'PATCH',
            body: JSON.stringify(patch),
        });
        await Promise.all([renderConversation(), loadConversations({ silent: true })]);
    } catch (err) {
        toast(err.message, 'error');
    }
}

// ─── Status pill (conta WhatsApp do site) ────────────────────────────
// Lê de /whatsapp-accounts: cada conta vem com `status` (DB) e `live_status`
// (best-effort do Unipile). Considera "online" se alguma conta tem live OK
// — analogo ao /api/health do app principal, mas usando só contas do site.

const OK_STATUS_RX = /^(ok|connected|running|ok_for_now)$/i;
const CONNECTING_RX = /^(connecting|checkpoint|qr)/i;

function pickPillState(accounts) {
    if (!accounts || !accounts.length) {
        return { variant: 'unknown', label: 'Sem conta' };
    }
    const liveOrDb = (a) => a.live_status || a.status || 'unknown';
    const anyOk         = accounts.some(a => OK_STATUS_RX.test(liveOrDb(a)));
    if (anyOk) return { variant: 'online', label: 'Site conectado' };

    const anyConnecting = accounts.some(a => CONNECTING_RX.test(liveOrDb(a)));
    if (anyConnecting)  return { variant: 'connecting', label: 'Conectando…' };

    return { variant: 'offline', label: 'Site desconectado' };
}

function applyPill({ variant, label }) {
    const pill = document.getElementById('site-status-pill');
    if (pill) {
        // O pill usa .status-pill (do style-v2) com .offline padrão. Adicionamos
        // .connecting e .unknown como variantes locais. .online é o estado padrão
        // (sem modifier).
        pill.classList.remove('offline', 'connecting', 'unknown');
        if (variant !== 'online') pill.classList.add(variant);
        const txt = pill.querySelector('.site-status-pill-text');
        if (txt) txt.textContent = label;
    }
    // Espelha no #status-dot do rodape da side-nav (paridade com main app).
    const dot = document.getElementById('status-dot');
    if (dot) dot.classList.toggle('offline', variant === 'offline' || variant === 'unknown');
}

async function refreshSiteStatus() {
    try {
        const accounts = await api('/whatsapp-accounts');
        applyPill(pickPillState(accounts));
    } catch {
        applyPill({ variant: 'unknown', label: 'Status indisponível' });
    }
}

// ─── Polling ─────────────────────────────────────────────────────────

function clearAllPolls() {
    clearInterval(listPollHandle);   listPollHandle   = null;
    clearInterval(threadPollHandle); threadPollHandle = null;
    clearInterval(statusPollHandle); statusPollHandle = null;
}

function startAllPolls() {
    listPollHandle   = setInterval(() => loadConversations({ silent: true }), LIST_POLL_MS);
    threadPollHandle = setInterval(() => {
        if (state.activeConvId) renderConversation();
    }, THREAD_POLL_MS);
    statusPollHandle = setInterval(refreshSiteStatus, STATUS_POLL_MS);
}

function startPolling() {
    startAllPolls();
    // Pausa quando aba some de foco pra economizar requests.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            clearAllPolls();
        } else if (!listPollHandle) {
            loadConversations({ silent: true });
            if (state.activeConvId) renderConversation();
            refreshSiteStatus();
            startAllPolls();
        }
    });
}

// ─── Topbar: user chip + dropdown ────────────────────────────────────
// Logica espelha public/app.js (setupTopbarUser + setupTopbarUserMenu).
// Mantemos local em vez de compartilhar pra nao acoplar /site ao app.js
// principal, que tem muito mais responsabilidade.

function updateTopbarUser() {
    const me = state.me || {};
    const avatar = document.getElementById('topbar-user-avatar');
    const name   = document.getElementById('topbar-user-name');
    const role   = document.getElementById('topbar-user-role');
    if (avatar) avatar.textContent = (me.name || '?').split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
    if (name)   name.textContent   = me.name || me.email || '—';
    if (role)   role.textContent   = me.role || '—';
}

function setupTopbarUserMenu() {
    const trigger = document.getElementById('topbar-user-chip');
    const menu    = document.getElementById('topbar-user-menu');
    if (!trigger || !menu) return;

    const close = () => {
        if (menu.hidden) return;
        menu.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
        document.removeEventListener('click', onDocClick, true);
        document.removeEventListener('keydown', onKey);
    };
    const open = () => {
        if (!menu.hidden) return;
        menu.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        document.addEventListener('click', onDocClick, true);
        document.addEventListener('keydown', onKey);
    };
    const onDocClick = (e) => {
        if (!trigger.contains(e.target) && !menu.contains(e.target)) close();
    };
    const onKey = (e) => { if (e.key === 'Escape') { close(); trigger.focus(); } };

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.hidden ? open() : close();
    });
    menu.addEventListener('click', (e) => {
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (action === 'logout') {
            localStorage.removeItem('ba_token');
            localStorage.removeItem('ba_user');
            window.location.href = '/login.html';
        }
        close();
    });
}

// Mostra Dashboard só pra Admin (paridade com setRoleVisibility do main app)
function applySiteRoleVisibility() {
    const isAdmin = state.me?.role === 'Admin';
    const dashLink = document.getElementById('nav-dashboard');
    if (dashLink) dashLink.style.display = isAdmin ? '' : 'none';
}

// ─── Boot ────────────────────────────────────────────────────────────

updateTopbarUser();
applySiteRoleVisibility();
setupTopbarUserMenu();
refreshSiteStatus();
loadConversations().then(startPolling);
