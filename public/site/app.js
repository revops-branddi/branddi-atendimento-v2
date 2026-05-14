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
    bot:           'Bot triagem',
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

        // Notificação desktop: dispara quando uma conv NOVA entra em
        // waiting_human (bot handoff Comercial, ou atendente abre fila).
        // Skip no primeiro poll pra não notificar pra todas as existentes.
        detectNewWaitingHuman(convs);

        if (!convs.length) {
            list.replaceChildren(emptyMsg('Sem conversas'));
            state._listHash = '';
            return;
        }
        // Skip render se nada relevante mudou — evita flicker do polling.
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
        // Coluna esquerda: nome + horário em cima, empresa embaixo.
        el('div', { class: 'conv-item-main' },
            el('div', { class: 'name' },
                el('span', {}, c.leads?.name || c.leads?.phone || 'Sem nome'),
                el('time', {}, fmtTime(c.last_message_at || c.created_at)),
            ),
            el('div', { class: 'preview' }, c.leads?.company_name || c.leads?.email || c.leads?.phone || ''),
        ),
        // Coluna direita: badge de status (+ pill "minha" se for do user).
        el('div', { class: 'meta' },
            el('span', { class: `badge badge-${c.status}` }, STATUS_LABEL[c.status] || c.status),
            isMine && el('span', { class: 'status-pill' }, 'minha'),
        ),
    );
}

// ─── Filters ─────────────────────────────────────────────────────────

document.getElementById('filter-select').addEventListener('change', (e) => {
    state.filter = e.target.value;
    loadConversations();
});

// ─── Conversation viewer ─────────────────────────────────────────────

async function openConversation(id) {
    state.activeConvId = id;
    state._threadHash  = ''; // reset pra forçar render da nova conversa
    state._panelHash   = ''; // idem pro lead panel
    document.querySelectorAll('.conv-item').forEach(it => it.classList.toggle('active', it.dataset.id === id));
    // Tira o estado vazio do viewer: a classe `site-empty` herda text-align:center
    // e o style inline `margin:auto` quebra o flex da thread. Trocamos pra
    // `conv-view` (flex column) só quando há conversa selecionada.
    const viewer = document.getElementById('conv-viewer');
    viewer.className = 'conv-view';
    viewer.removeAttribute('style');
    await renderConversation({ initial: true });
}

// ─── Lead Panel (à direita) ──────────────────────────────────────────

const OPEC_CATEGORY_LABELS = {
    bb:     'TakeDown BB',
    golpes: 'TakeDown Golpes',
    vm:     'TakeDown VM',
};

function renderLeadPanel(conv) {
    const empty = document.getElementById('lp-empty');
    const content = document.getElementById('lp-content');
    if (!empty || !content) return;
    if (!conv) {
        empty.style.display = '';
        content.style.display = 'none';
        state._panelHash = '';
        return;
    }
    empty.style.display = 'none';
    content.style.display = '';

    // Hash gate: evita re-render quando atendente está digitando num input
    // (replaceChildren mata o foco). Só re-renderiza quando dados do lead
    // realmente mudaram. Polling do thread (msgs) não dispara aqui.
    const lead = conv.leads || {};
    const panelHash = JSON.stringify({
        cid:   conv.id,
        cstat: conv.status,
        lead: [
            lead.id, lead.name, lead.job_title, lead.company_name, lead.email,
            lead.phone, lead.classification, lead.opec_category,
            lead.crm_deal_id, lead.crm_person_id,
        ],
    });
    if (panelHash === state._panelHash) return;
    state._panelHash = panelHash;

    const leadId = lead.id || conv.lead_id;
    const initials = (lead.name || lead.phone || '?')
        .split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';

    const fmtDate = (iso) => {
        if (!iso) return '—';
        const d = new Date(iso);
        return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
    };

    const dealLink = lead.crm_deal_id
        ? el('a', {
            class: 'lp-field-link',
            href: `https://brandmonitor.pipedrive.com/deal/${lead.crm_deal_id}`,
            target: '_blank',
            rel: 'noopener',
          }, `Deal #${lead.crm_deal_id} ↗`)
        : null;

    const classificationBadges = [];
    if (lead.classification === 'comercial') {
        classificationBadges.push(el('span', { class: 'classification-pill comercial' }, 'Comercial'));
    } else if (lead.classification === 'opec') {
        const subLabel = OPEC_CATEGORY_LABELS[lead.opec_category] || 'OPEC';
        classificationBadges.push(el('span', { class: 'classification-pill opec' }, subLabel));
    } else {
        classificationBadges.push(el('span', { class: 'lp-field-value muted' }, 'Não classificado'));
    }

    // Mostra botão "Criar deal" se OPEC já não pegou esse lead. OPEC vira
    // resolved automático pelo bot — não faz sentido criar deal lá.
    const canCreateDeal = !lead.crm_deal_id && lead.classification !== 'opec';

    content.replaceChildren(
        el('div', { class: 'lp-avatar-row' },
            el('div', { class: 'lp-avatar' }, initials),
            el('div', { class: 'lp-name-block' },
                el('div', { class: 'lp-name' }, lead.name || lead.phone || 'Sem nome'),
                el('div', { class: 'lp-name-sub' }, statusLabel(conv)),
            ),
        ),

        el('div', { class: 'lp-section' },
            el('div', { class: 'lp-section-label' }, 'Classificação'),
            el('div', { class: 'lp-classification-row' }, ...classificationBadges),
            dealLink && el('div', { class: 'lp-field', style: 'margin-top:8px;border:none' },
                el('div', { class: 'lp-field-label' }, 'Pipedrive'),
                el('div', { class: 'lp-field-value' }, dealLink),
            ),
        ),

        el('div', { class: 'lp-section' },
            el('div', { class: 'lp-section-label' }, 'Contato'),
            // Campos editáveis — auto-save no blur. Phone segue read-only.
            renderEditableField(leadId, 'name',         'Nome',     lead.name),
            renderEditableField(leadId, 'job_title',    'Cargo',    lead.job_title),
            renderEditableField(leadId, 'company_name', 'Empresa',  lead.company_name),
            renderEditableField(leadId, 'email',        'E-mail',   lead.email, 'email'),
            el('div', { class: 'lp-field' },
                el('div', { class: 'lp-field-label' }, 'Telefone'),
                el('div', { class: 'lp-field-value' + (!lead.phone ? ' muted' : '') }, lead.phone || '—'),
            ),
        ),

        canCreateDeal && el('div', { class: 'lp-section' },
            el('button', {
                class: 'lp-create-deal-btn',
                onclick: () => createPipedriveDeal(conv.id),
            }, 'Criar deal no Pipedrive'),
            el('div', { class: 'lp-help-text' },
                'Preencha nome, cargo e empresa antes — vai pra Pipedrive como Person + Deal.',
            ),
        ),

        el('div', { class: 'lp-section' },
            el('div', { class: 'lp-section-label' }, 'Datas'),
            el('div', { class: 'lp-field' },
                el('div', { class: 'lp-field-label' }, 'Criado em'),
                el('div', { class: 'lp-field-value' }, fmtDate(lead.created_at || conv.created_at)),
            ),
            el('div', { class: 'lp-field' },
                el('div', { class: 'lp-field-label' }, 'Última mensagem'),
                el('div', { class: 'lp-field-value' }, fmtDate(conv.last_message_at)),
            ),
        ),
    );
}

// Campo editável: input que persiste no blur via PATCH /leads/:id.
// Usa data-lead-id + data-field pra bind sem closure (poll re-render OK).
function renderEditableField(leadId, field, label, value, type = 'text') {
    const wrap   = el('div', { class: 'lp-field' });
    const labelEl = el('div', { class: 'lp-field-label' }, label);
    const input  = el('input', {
        type,
        class: 'lp-field-input',
        value: value || '',
        placeholder: '—',
        'data-lead-id': leadId,
        'data-field': field,
    });
    input.addEventListener('blur', async () => {
        const newVal = input.value.trim();
        if ((value || '') === newVal) return; // sem mudança, skip
        input.classList.add('saving');
        try {
            await api(`/leads/${leadId}`, {
                method: 'PATCH',
                body:   JSON.stringify({ [field]: newVal }),
            });
            input.classList.remove('saving');
            input.classList.add('saved');
            setTimeout(() => input.classList.remove('saved'), 1200);
            // Atualiza state local pra próximo poll não sobrescrever
            if (state.activeConv?.leads) state.activeConv.leads[field] = newVal || null;
        } catch (err) {
            input.classList.remove('saving');
            input.classList.add('error');
            toast(`Erro ao salvar ${label}: ${err.message}`, 'error');
        }
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
    });
    wrap.append(labelEl, input);
    return wrap;
}

async function createPipedriveDeal(convId) {
    if (!confirm('Criar Person + Deal no Pipedrive com os dados atuais? (Os campos editados acima serão usados)')) return;
    try {
        const res = await api(`/conversations/${convId}/route-comercial`, { method: 'POST' });
        const msg = res.already_routed
            ? `Já tinha deal #${res.deal_id} no Pipedrive`
            : `Deal #${res.deal_id} criado no Pipedrive ✓`;
        toast(msg, 'success');
        await Promise.all([renderConversation(), loadConversations({ silent: true })]);
    } catch (err) {
        toast(err.message, 'error');
    }
}

function statusLabel(conv) {
    const map = {
        waiting_human: 'Aguardando atendimento',
        in_progress:   'Em andamento',
        resolved:      'Resolvida',
    };
    return map[conv.status] || conv.status;
}

// Toggle do painel — persiste preferência em localStorage
function setupLeadPanelToggle() {
    const shell  = document.getElementById('site-shell');
    const toggle = document.getElementById('lp-toggle');
    if (!shell || !toggle) return;

    const apply = (hidden) => {
        shell.classList.toggle('lead-panel-hidden', hidden);
        toggle.textContent = hidden ? '›' : '‹';
        toggle.title = hidden ? 'Mostrar painel do lead' : 'Ocultar painel do lead';
    };
    apply(localStorage.getItem('site:lead-panel-hidden') === '1');

    toggle.addEventListener('click', () => {
        const nowHidden = !shell.classList.contains('lead-panel-hidden');
        localStorage.setItem('site:lead-panel-hidden', nowHidden ? '1' : '0');
        apply(nowHidden);
    });
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
        msgs: msgs.map(m => [
            m.id, m.text, m.delivered, m.seen, m.sender_name,
            // Inclui atts pra re-renderizar quando backfill chegar
            (m.attachments || []).map(a => [a.id, a.name, a.mime_type]),
        ]),
    });
    if (!initial && hash === state._threadHash) return;
    state._threadHash = hash;

    // Atualiza lead panel sempre que renderConversation rodar — barato porque
    // só toca DOM quando o hash mudou (mesma porteira).
    renderLeadPanel(conv);

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
        const text = resolveLidPlaceholders(m.text || '', fallback);
        const attsHtml = renderMessageAttachments(m);

        list.append(
            el('div', { class: `msg ${m.direction}` },
                el('div', { class: 'who' }, senderLabel),
                attsHtml,
                text && el('div', { class: 'msg-text' }, text),
                el('div', { class: 'when' }, fmtTime(m.created_at)),
            ),
        );
    });
    return list;
}

// Renderiza atts da mensagem (imagem inline, video player, doc com link).
// Quando attachment ainda não tem id (recém-enviado, backfill rodando),
// mostra placeholder até o poll trazer o id.
function renderMessageAttachments(m) {
    const atts = m.attachments || [];
    if (!atts.length) return null;
    const wrap = el('div', { class: 'msg-attachments' });
    for (const a of atts) {
        const mime    = (a.mime_type || a.mimetype || '').toLowerCase();
        const isImg   = mime.startsWith('image/') || a.type === 'image' || a.type === 'img';
        const isVideo = mime.startsWith('video/') || a.type === 'video';
        const isAudio = mime.startsWith('audio/') || a.type === 'audio';
        const name    = a.name || a.file_name || (isImg ? 'Imagem' : 'Arquivo');

        // Sem unipile_message_id ou sem att.id → ainda em backfill, mostra
        // placeholder só com nome (atendente sabe que enviou, vai aparecer
        // a thumb em segundos).
        if (!m.unipile_message_id || !a.id) {
            wrap.append(el('div', { class: 'msg-att msg-att-pending' },
                el('span', { class: 'msg-att-icon' }, isImg ? '🖼️' : isVideo ? '🎬' : isAudio ? '🎵' : '📎'),
                el('span', { class: 'msg-att-name' }, name),
                el('span', { class: 'msg-att-status' }, '· enviando…'),
            ));
            continue;
        }

        const url = `/api/site/attachments/${encodeURIComponent(m.unipile_message_id)}/${encodeURIComponent(a.id)}`;

        if (isImg) {
            wrap.append(el('div', { class: 'msg-att msg-att-image' },
                el('img', { src: url, alt: name, loading: 'lazy', onclick: () => window.open(url, '_blank') }),
            ));
        } else if (isVideo) {
            wrap.append(el('div', { class: 'msg-att msg-att-video' },
                el('video', { src: url, controls: true, preload: 'metadata' }),
            ));
        } else if (isAudio) {
            wrap.append(el('div', { class: 'msg-att msg-att-audio' },
                el('audio', { src: url, controls: true, preload: 'metadata' }),
            ));
        } else {
            wrap.append(el('a', { class: 'msg-att msg-att-file', href: url, target: '_blank', rel: 'noopener' },
                el('span', { class: 'msg-att-icon' }, '📎'),
                el('span', { class: 'msg-att-name' }, name),
            ));
        }
    }
    return wrap;
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

    const fileInput = el('input', {
        type: 'file',
        accept: 'image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip',
        style: 'display:none',
        onchange: (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            if (f.size > 16 * 1024 * 1024) {
                toast('Arquivo maior que 16MB', 'error');
                e.target.value = '';
                return;
            }
            pendingFile = f;
            renderFilePreview();
        },
    });

    // Mesmo botão validado do prospecção (.attach-btn + SVG paperclip)
    // já estilizado no style-v2.css. SVG construído via DOM API pra evitar
    // innerHTML (lint do projeto bloqueia mesmo com string estática).
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const paperclipSvg = document.createElementNS(SVG_NS, 'svg');
    paperclipSvg.setAttribute('width',  '20');
    paperclipSvg.setAttribute('height', '20');
    paperclipSvg.setAttribute('viewBox', '0 0 24 24');
    paperclipSvg.setAttribute('fill', 'none');
    paperclipSvg.setAttribute('stroke', 'currentColor');
    paperclipSvg.setAttribute('stroke-width', '2');
    paperclipSvg.setAttribute('stroke-linecap', 'round');
    paperclipSvg.setAttribute('stroke-linejoin', 'round');
    const paperclipPath = document.createElementNS(SVG_NS, 'path');
    paperclipPath.setAttribute('d', 'M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48');
    paperclipSvg.appendChild(paperclipPath);

    const attachBtn = el('button', {
        type: 'button',
        class: 'attach-btn',
        title: 'Anexar arquivo (max 16MB)',
        disabled: isResolved,
        onclick: () => fileInput.click(),
    }, paperclipSvg);

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

    let pendingFile = null;
    const previewSlot = el('div', { class: 'composer-preview-slot' });

    function renderFilePreview() {
        if (!pendingFile) {
            previewSlot.replaceChildren();
            return;
        }
        const isImage = pendingFile.type?.startsWith('image/');
        const sizeKb  = Math.round(pendingFile.size / 1024);
        const removeBtn = el('button', {
            type: 'button',
            class: 'composer-preview-remove',
            title: 'Remover anexo',
            onclick: () => {
                pendingFile = null;
                fileInput.value = '';
                renderFilePreview();
            },
        }, '✕');

        let thumb;
        if (isImage) {
            thumb = el('img', {
                src: URL.createObjectURL(pendingFile),
                class: 'composer-preview-thumb',
                onload: (e) => URL.revokeObjectURL(e.target.src),
            });
        } else {
            thumb = el('div', { class: 'composer-preview-icon' }, '📄');
        }

        previewSlot.replaceChildren(
            el('div', { class: 'composer-preview' },
                thumb,
                el('div', { class: 'composer-preview-meta' },
                    el('div', { class: 'composer-preview-name', title: pendingFile.name }, pendingFile.name),
                    el('div', { class: 'composer-preview-size' }, `${sizeKb} KB`),
                ),
                removeBtn,
            ),
        );
    }

    async function send() {
        const text = ta.value.trim();
        if (!text && !pendingFile) return;
        btn.disabled = true; ta.disabled = true; attachBtn.disabled = true;
        try {
            if (pendingFile) {
                // Multipart pra send-media. Não setar Content-Type — browser
                // adiciona boundary automaticamente.
                const fd = new FormData();
                fd.append('file', pendingFile);
                if (text) fd.append('text', text);
                await api(`/messages/${conv.id}/send-media`, {
                    method: 'POST',
                    body:   fd,
                });
                pendingFile = null;
                fileInput.value = '';
                renderFilePreview();
            } else {
                await api(`/messages/${conv.id}`, {
                    method: 'POST',
                    body: JSON.stringify({ text }),
                });
            }
            ta.value = '';
            await renderConversation();
            await loadConversations({ silent: true });
        } catch (err) {
            toast(err.message, 'error');
        } finally {
            btn.disabled = false; ta.disabled = isResolved; attachBtn.disabled = isResolved;
            ta.focus();
        }
    }

    return el('div', { class: `composer ${isResolved ? 'disabled' : ''}` },
        previewSlot,
        // .chat-input-row já tá estilizada no style-v2.css (gap + align)
        el('div', { class: 'chat-input-row' },
            attachBtn,
            ta,
            btn,
            fileInput,
        ),
    );
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

// ─── Desktop notifications ───────────────────────────────────────────
// Dispara quando uma conv NOVA entra em waiting_human (bot Comercial
// handoff ou atendente reabre). Só notifica se a aba está em background
// — quando atendente está olhando, o badge visual basta.

const NOTIF_PERMISSION_DISMISSED_KEY = 'site:notif-permission-dismissed';

function maybeShowNotificationPrompt() {
    if (!('Notification' in window)) return; // browser sem suporte
    if (Notification.permission === 'granted' || Notification.permission === 'denied') return;
    if (localStorage.getItem(NOTIF_PERMISSION_DISMISSED_KEY) === '1') return;

    // Banner discreto no topo da side-panel pedindo permissão
    const banner = el('div', { class: 'notif-prompt' },
        el('span', { class: 'notif-prompt-text' }, '🔔 Receba notificações de novas conversas'),
        el('button', {
            class: 'notif-prompt-btn',
            onclick: async () => {
                const result = await Notification.requestPermission();
                banner.remove();
                if (result === 'granted') {
                    toast('Notificações ativadas', 'success');
                }
            },
        }, 'Ativar'),
        el('button', {
            class: 'notif-prompt-dismiss',
            title: 'Não mostrar mais',
            onclick: () => {
                localStorage.setItem(NOTIF_PERMISSION_DISMISSED_KEY, '1');
                banner.remove();
            },
        }, '✕'),
    );

    const sidebar = document.querySelector('.site-sidebar');
    if (sidebar) sidebar.insertBefore(banner, sidebar.firstChild);
}

// Detecta convs novas em waiting_human comparando com snapshot anterior.
// _waitingBaseline = null no boot; após primeiro poll, vira o Set de IDs
// já existentes — assim só convs que entrarem DEPOIS disparam notificação.
function detectNewWaitingHuman(convs) {
    const currentIds = new Set(
        convs.filter(c => c.status === 'waiting_human').map(c => c.id),
    );
    if (state._waitingBaseline === null || state._waitingBaseline === undefined) {
        // Primeiro poll: estabelece baseline, não notifica
        state._waitingBaseline = currentIds;
        return;
    }
    for (const id of currentIds) {
        if (!state._waitingBaseline.has(id)) {
            const conv = convs.find(c => c.id === id);
            if (conv) notifyDesktop(conv);
        }
    }
    state._waitingBaseline = currentIds;
}

function notifyDesktop(conv) {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    // Não notifica se atendente já está vendo a aba (badge basta)
    if (!document.hidden && document.hasFocus()) return;

    const lead = conv.leads || {};
    const title = `Nova conversa no Site${lead.name ? ` — ${lead.name}` : ''}`;
    const body  = lead.company_name
        ? `${lead.company_name}${lead.phone ? ' · ' + lead.phone : ''}`
        : (lead.phone || 'Lead aguardando atendimento');

    try {
        const n = new Notification(title, {
            body,
            icon: '/branddi-mark.svg',
            tag:  `site-conv-${conv.id}`, // mesma conv não dispara 2x
            requireInteraction: false,
        });
        n.onclick = () => {
            window.focus();
            n.close();
            openConversation(conv.id);
        };
    } catch (err) {
        console.warn('notifyDesktop falhou:', err);
    }
}

// ─── Modal: contas WhatsApp do site (admin only) ─────────────────────

async function openWaAccountsModal() {
    const overlay = el('div', { class: 'opec-modal-overlay', onclick: (e) => {
        if (e.target === overlay) overlay.remove();
    } });

    const body = el('div', { class: 'opec-modal-body' }, emptyMsg('Carregando contas…'));

    overlay.append(
        el('div', { class: 'opec-modal' },
            el('div', { class: 'opec-modal-header' },
                el('h3', {}, 'Contas WhatsApp do Site'),
                el('div', { class: 'opec-modal-sub' }, 'Gerencie a conexão do número dedicado'),
            ),
            body,
            el('div', { class: 'opec-modal-footer' },
                el('button', { class: 'opec-cancel', onclick: () => overlay.remove() }, 'Fechar'),
                el('button', {
                    class: 'opec-submit',
                    onclick: () => connectNewWaAccount(overlay),
                }, 'Conectar nova'),
            ),
        ),
    );
    document.body.appendChild(overlay);

    try {
        const accounts = await api('/whatsapp-accounts');
        renderWaAccountsList(body, accounts, overlay);
    } catch (err) {
        body.replaceChildren(emptyMsg(`Erro: ${err.message}`));
    }
}

function renderWaAccountsList(body, accounts, overlay) {
    if (!accounts.length) {
        body.replaceChildren(
            el('div', { class: 'wa-empty' },
                el('div', {}, 'Nenhuma conta WhatsApp cadastrada'),
                el('div', { class: 'wa-empty-hint' }, 'Clique em "Conectar nova" pra começar.'),
            ),
        );
        return;
    }
    const items = accounts.map(a => renderWaAccountItem(a, overlay));
    body.replaceChildren(...items);
}

function renderWaAccountItem(acc, overlay) {
    const liveStatus = (acc.live_status || acc.status || 'unknown').toLowerCase();
    const isOk = /^(ok|connected|running|ok_for_now)$/i.test(liveStatus);
    const statusClass = isOk ? 'online' : (/connecting|checkpoint|qr/i.test(liveStatus) ? 'connecting' : 'offline');
    const statusLabel = isOk ? 'Conectada' : (/connecting|checkpoint|qr/i.test(liveStatus) ? 'Conectando…' : 'Desconectada');

    const labelInput = el('input', {
        type: 'text',
        class: 'wa-acc-label',
        value: acc.label || '',
        placeholder: 'Sem label',
    });
    labelInput.addEventListener('blur', async () => {
        if ((acc.label || '') === labelInput.value.trim()) return;
        try {
            await api(`/whatsapp-accounts/${acc.id}`, {
                method: 'PATCH',
                body:   JSON.stringify({ label: labelInput.value.trim() }),
            });
            acc.label = labelInput.value.trim();
            toast('Label salva', 'success');
        } catch (err) {
            toast(`Erro: ${err.message}`, 'error');
        }
    });

    const reconnectBtn = el('button', {
        class: 'wa-acc-btn primary',
        onclick: () => reconnectWaAccount(acc.id),
    }, 'Religar');

    const disconnectBtn = el('button', {
        class: 'wa-acc-btn danger',
        onclick: () => disconnectWaAccount(acc.id, overlay),
    }, 'Desconectar');

    return el('div', { class: 'wa-acc-item' },
        el('div', { class: 'wa-acc-row' },
            el('div', { class: 'wa-acc-info' },
                el('div', { class: 'wa-acc-phone' }, acc.phone_number || acc.unipile_account_id || '?'),
                el('span', { class: `wa-acc-status ${statusClass}` }, statusLabel),
            ),
        ),
        el('div', { class: 'wa-acc-row' },
            el('label', { class: 'wa-acc-label-wrap' },
                el('span', { class: 'wa-acc-label-text' }, 'Label'),
                labelInput,
            ),
        ),
        el('div', { class: 'wa-acc-actions' }, reconnectBtn, disconnectBtn),
    );
}

async function connectNewWaAccount(overlay) {
    if (!confirm('Vai abrir uma página da Unipile pra escanear o QR. Continuar?')) return;
    try {
        const res = await api('/whatsapp-accounts/connect-link', { method: 'POST' });
        if (!res.url) throw new Error('URL não retornada');
        window.open(res.url, '_blank', 'noopener');
        toast('Abri a página da Unipile em outra aba — escaneie o QR', 'success');
        // Recarrega lista após 5s pra refletir conta nova
        setTimeout(() => {
            overlay.remove();
            openWaAccountsModal();
        }, 5000);
    } catch (err) {
        toast(err.message, 'error');
    }
}

async function reconnectWaAccount(accId) {
    try {
        const res = await api(`/whatsapp-accounts/${accId}/reconnect-link`, { method: 'POST' });
        if (!res.url) throw new Error('URL não retornada');
        window.open(res.url, '_blank', 'noopener');
        toast('Abri a página da Unipile em outra aba — escaneie o QR', 'success');
    } catch (err) {
        toast(err.message, 'error');
    }
}

async function disconnectWaAccount(accId, overlay) {
    if (!confirm('Desconectar essa conta? As conversas existentes ficam preservadas, mas novas mensagens deixam de chegar até religar.')) return;
    try {
        await api(`/whatsapp-accounts/${accId}`, { method: 'DELETE' });
        toast('Conta desconectada', 'success');
        overlay.remove();
        refreshSiteStatus();
    } catch (err) {
        toast(err.message, 'error');
    }
}

// ─── Modal: Dashboard /site (admin only) ─────────────────────────────

const DASH_PERIODS = [
    { value: 7,  label: '7 dias' },
    { value: 30, label: '30 dias' },
    { value: 90, label: '90 dias' },
];

async function openSiteDashboardModal() {
    let currentDays = 7;
    const overlay = el('div', { class: 'opec-modal-overlay', onclick: (e) => {
        if (e.target === overlay) overlay.remove();
    } });

    const periodTabs = el('div', { class: 'dash-period-tabs' });
    DASH_PERIODS.forEach(p => {
        const btn = el('button', {
            class: `dash-period-btn ${p.value === currentDays ? 'active' : ''}`,
            onclick: () => {
                currentDays = p.value;
                periodTabs.querySelectorAll('button').forEach(b => b.classList.toggle('active', +b.dataset.value === currentDays));
                loadAndRender();
            },
            'data-value': p.value,
        }, p.label);
        periodTabs.append(btn);
    });

    const body = el('div', { class: 'opec-modal-body' }, emptyMsg('Carregando…'));

    overlay.append(
        el('div', { class: 'opec-modal dash-modal' },
            el('div', { class: 'opec-modal-header' },
                el('h3', {}, 'Dashboard — Atendimento Site'),
                el('div', { class: 'opec-modal-sub' }, 'KPIs do canal /site (admin)'),
                periodTabs,
            ),
            body,
            el('div', { class: 'opec-modal-footer' },
                el('button', { class: 'opec-cancel', onclick: () => overlay.remove() }, 'Fechar'),
            ),
        ),
    );
    document.body.appendChild(overlay);

    async function loadAndRender() {
        body.replaceChildren(emptyMsg('Carregando…'));
        try {
            const data = await api(`/dashboard?days=${currentDays}`);
            renderDashboard(body, data);
        } catch (err) {
            body.replaceChildren(emptyMsg(`Erro: ${err.message}`));
        }
    }
    loadAndRender();
}

function renderDashboard(body, data) {
    const kpiCards = [
        { label: 'Conversas', value: data.conversations.total, hint: `Em ${data.range.days} dias` },
        { label: 'OPEC',      value: data.opec.total,          hint: 'Auto-roteadas pelo bot' },
        { label: 'Comercial', value: data.comercial.total,     hint: `${data.comercial.with_deal} viraram deal (${data.comercial.conversion_rate}%)` },
        { label: 'Bot handoffs', value: data.bot.handed_off,   hint: `${data.bot.gave_up} desistiu (3 erros)` },
    ];

    const opecCats = [
        { key: 'bb',     label: 'TakeDown BB',     count: data.opec.by_category.bb },
        { key: 'golpes', label: 'TakeDown Golpes', count: data.opec.by_category.golpes },
        { key: 'vm',     label: 'TakeDown VM',     count: data.opec.by_category.vm },
    ];
    const opecMax = Math.max(1, ...opecCats.map(c => c.count));

    const statuses = [
        { key: 'bot',           label: 'Bot triagem' },
        { key: 'waiting_human', label: 'Aguardando' },
        { key: 'in_progress',   label: 'Em andamento' },
        { key: 'resolved',      label: 'Resolvidas' },
    ];

    body.replaceChildren(
        // KPI cards top
        el('div', { class: 'dash-kpi-grid' },
            ...kpiCards.map(k => el('div', { class: 'dash-kpi-card' },
                el('div', { class: 'dash-kpi-label' }, k.label),
                el('div', { class: 'dash-kpi-value' }, String(k.value)),
                el('div', { class: 'dash-kpi-hint' }, k.hint),
            )),
        ),

        // OPEC breakdown
        el('div', { class: 'dash-section' },
            el('div', { class: 'dash-section-title' }, 'OPEC por categoria'),
            el('div', { class: 'dash-bar-list' },
                ...opecCats.map(c => el('div', { class: 'dash-bar-item' },
                    el('div', { class: 'dash-bar-label' }, c.label),
                    el('div', { class: 'dash-bar-track' },
                        el('div', { class: 'dash-bar-fill', style: `width: ${(c.count / opecMax) * 100}%` }),
                    ),
                    el('div', { class: 'dash-bar-value' }, String(c.count)),
                )),
            ),
        ),

        // Status breakdown
        el('div', { class: 'dash-section' },
            el('div', { class: 'dash-section-title' }, 'Distribuição por status'),
            el('div', { class: 'dash-status-grid' },
                ...statuses.map(s => el('div', { class: 'dash-status-cell' },
                    el('div', { class: 'dash-status-label' }, s.label),
                    el('div', { class: 'dash-status-value' }, String(data.conversations.by_status[s.key] || 0)),
                )),
            ),
        ),

        // Atendentes
        data.atendentes.length > 0 && el('div', { class: 'dash-section' },
            el('div', { class: 'dash-section-title' }, 'Por atendente'),
            el('table', { class: 'dash-table' },
                el('thead', {},
                    el('tr', {},
                        el('th', {}, 'Atendente'),
                        el('th', {}, 'Atribuídas'),
                        el('th', {}, 'Resolvidas'),
                    ),
                ),
                el('tbody', {},
                    ...data.atendentes.map(a => el('tr', {},
                        el('td', {}, a.name),
                        el('td', {}, String(a.assigned_count)),
                        el('td', {}, String(a.resolved_count)),
                    )),
                ),
            ),
        ),

        // Bot avg attempts
        data.bot.avg_attempts > 0 && el('div', { class: 'dash-section dash-bot-stats' },
            el('div', { class: 'dash-section-title' }, 'Bot stats'),
            el('div', { class: 'dash-bot-stat' },
                el('span', { class: 'dash-bot-label' }, 'Tentativas médias antes de classificar'),
                el('span', { class: 'dash-bot-value' }, String(data.bot.avg_attempts)),
            ),
        ),
    );
}
function applySiteRoleVisibility() {
    const isAdmin = state.me?.role === 'Admin';
    const dashLink = document.getElementById('nav-dashboard');
    if (dashLink) {
        if (isAdmin) {
            // Sobrescreve o href pra abrir modal do dashboard do /site
            dashLink.style.display = '';
            dashLink.removeAttribute('href');
            dashLink.style.cursor = 'pointer';
            dashLink.title = 'Dashboard do Site';
            dashLink.addEventListener('click', (e) => {
                e.preventDefault();
                openSiteDashboardModal();
            });
        } else {
            dashLink.style.display = 'none';
        }
    }

    const pill = document.getElementById('site-status-pill');
    if (pill && isAdmin) {
        pill.classList.add('clickable');
        pill.title = 'Clique pra gerenciar conta WhatsApp do site';
        pill.addEventListener('click', openWaAccountsModal);
    }
}

// ─── Boot ────────────────────────────────────────────────────────────

updateTopbarUser();
applySiteRoleVisibility();
setupTopbarUserMenu();
setupLeadPanelToggle();
maybeShowNotificationPrompt();
refreshSiteStatus();
loadConversations().then(startPolling);
