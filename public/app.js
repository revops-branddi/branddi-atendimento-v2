/**
 * Branddi Atendimento — App Frontend v2.0.0
 * Multi-usuario com roles SDR / Closer / Admin
 * Melhorias: try/catch por funcao, browser notifications,
 * inbox search client-side, CSV export, window exports completos
 */

const API = '';
let currentConversation = null;
let pollTimer = null;
let chartDay = null, chartOrigin = null, chartClass = null;
let allConversations = [];
let currentFilter = 'all';
let allScripts = [];
let currentScriptCat = '';
let selectedDealId = null; // Deal selecionado no deal picker

// --- Auth State ---
let currentUser = null;

function getToken() {
    return localStorage.getItem('ba_token');
}

function logout() {
    localStorage.removeItem('ba_token');
    localStorage.removeItem('ba_user');
    window.location.href = '/login.html';
}

// --- Browser Notifications ---
let notificationsEnabled = false;

function requestNotificationPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
        notificationsEnabled = true;
        return;
    }
    if (Notification.permission !== 'denied') {
        Notification.requestPermission().then(perm => {
            notificationsEnabled = perm === 'granted';
        });
    }
}

function showBrowserNotification(title, body) {
    if (!notificationsEnabled || document.hasFocus()) return;
    try {
        const n = new Notification(title, {
            body,
            icon: '/favicon.ico',
            tag: 'branddi-atendimento',
        });
        n.onclick = () => { window.focus(); n.close(); };
        setTimeout(() => n.close(), 8000);
    } catch { /* ignore */ }
}

// Request permission on first user interaction
document.addEventListener('click', function _reqNotif() {
    requestNotificationPermission();
    document.removeEventListener('click', _reqNotif);
}, { once: true });


// --- Mobile Sidebar ---
function setupMobile() {
    const toggle = document.getElementById('mobile-sidebar-toggle');
    const overlay = document.getElementById('mobile-overlay');
    if (toggle) toggle.addEventListener('click', toggleMobileSidebar);
    if (overlay) overlay.addEventListener('click', closeMobileSidebar);
}

function toggleMobileSidebar() {
    const sidebar = document.querySelector('.inbox-sidebar');
    const overlay = document.getElementById('mobile-overlay');
    if (!sidebar) return;
    const isOpen = sidebar.classList.toggle('mobile-open');
    overlay?.classList.toggle('show', isOpen);
}

function closeMobileSidebar() {
    const sidebar = document.querySelector('.inbox-sidebar');
    const overlay = document.getElementById('mobile-overlay');
    sidebar?.classList.remove('mobile-open');
    overlay?.classList.remove('show');
}

// --- Event Delegation (XSS-safe) ---
function setupEventDelegation() {
    document.body.addEventListener('click', (e) => {
        const el = e.target.closest('[data-action]');
        if (!el) return;
        const action = el.dataset.action;
        const id = el.dataset.id;

        switch (action) {
            case 'select-conversation':
                selectConversation(id);
                closeMobileSidebar();
                break;
            case 'route-conv':
                routeConv(id, el.dataset.team);
                break;
            case 'close-conv':
                closeConv(id);
                break;
            case 'toggle-scripts-menu':
                toggleScriptsMenu();
                break;
            case 'send-msg':
                sendMsg();
                break;
            case 'apply-script':
                applyScript(id);
                break;
            case 'sync-lead':
                syncLeadToPipedrive(id, document.getElementById(`pd-btn-${id}`));
                break;
            case 'edit-script':
                editScript(id);
                break;
            case 'delete-script':
                deleteScript(id);
                break;
            case 'logout':
                logout();
                break;
            case 'edit-user': {
                const user = _cachedUsers.find(u => u.id === el.dataset.userId);
                if (user) openEditUserForm(user);
                break;
            }
            case 'toggle-user':
                toggleUserActive(el.dataset.userId, el.dataset.activate === 'true');
                break;
            case 'delete-user-permanent':
                deleteUserPermanent(el.dataset.userId, el.dataset.userName);
                break;
            case 'open-history':
                e.stopPropagation();
                openHistoryMessages(id, el.dataset.name);
                break;
            case 'chat-tab':
                switchChatTab(el.dataset.tab);
                break;
            case 'save-note':
                saveInternalNote();
                break;
            case 'attach-file':
                document.getElementById('file-input')?.click();
                break;
            case 'remove-attachment':
                removeAttachment();
                break;
            case 'open-deal-contacts':
                openDealContacts(el.dataset.dealId);
                break;
            case 'close-deal-contacts':
                closeDealContactsModal();
                break;
            case 'toggle-filter-menu':
                toggleFilterMenu();
                break;
            case 'toggle-lead-panel': {
                const layout = document.querySelector('.inbox-layout');
                const btn = document.querySelector('.btn-toggle-lead-panel');
                if (!layout) break;
                const hidden = layout.classList.toggle('lead-panel-hidden');
                try { localStorage.setItem('leadPanelHidden', hidden ? '1' : '0'); } catch(_){}
                if (btn) btn.classList.toggle('active', !hidden);
                break;
            }
            case 'toggle-lp-details':
                el.closest('.lp-collapsible')?.classList.toggle('open');
                break;
            case 'lp-tab': {
                // SPEC v2 §4 — alterna aba Atividade | Detalhes no lead-panel
                const target = el.dataset.tab; // 'atividade' | 'detalhes'
                document.querySelectorAll('.lp-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === target));
                document.querySelectorAll('.lp-tab-panel').forEach(p => p.classList.toggle('active', p.id === `lp-panel-${target}`));
                break;
            }
            case 'route-dropdown':
                toggleRouteDropdown();
                break;
            case 'open-overflow-menu':
                e.stopPropagation();
                toggleOverflowMenu();
                break;
            case 'route-action': {
                const team = el.dataset.team;
                const cid = el.dataset.id;
                if (team === 'close') closeConv(cid);
                else routeConv(cid, team);
                closeRouteDropdown();
                break;
            }
            case 'push-pipedrive':
                pushConversationToPipedrive(id, el);
                break;
            case 'delete-conv-menu':
                openDeleteConvModal(id);
                break;
            case 'restore-conv':
                restoreConversation(id);
                break;
            case 'resync-conv':
                resyncConversation(id);
                break;
            case 'confirm-delete-conv':
                confirmDeleteConv();
                break;
            case 'close-delete-conv-modal':
                closeDeleteConvModal();
                break;
        }
    });
}

// ─── Apagar conversa (Admin only) ────────────────────────────────────
let _deleteConvTargetId = null;

function openDeleteConvModal(conversationId) {
    if (currentUser?.role !== 'Admin') return;
    _deleteConvTargetId = conversationId;
    const modal = document.getElementById('modal-delete-conv');
    if (modal) modal.style.display = 'flex';
    // reset radios pro default
    const radio = document.querySelector('input[name="delete-mode"][value="archive"]');
    if (radio) radio.checked = true;
}

function closeDeleteConvModal() {
    _deleteConvTargetId = null;
    const modal = document.getElementById('modal-delete-conv');
    if (modal) modal.style.display = 'none';
}

async function confirmDeleteConv() {
    const id = _deleteConvTargetId;
    if (!id) return;
    const mode = document.querySelector('input[name="delete-mode"]:checked')?.value || 'archive';

    if (mode === 'delete' && !confirm('Esta ação é IRREVERSÍVEL. Apagar conversa e todas as mensagens do banco?')) return;

    try {
        if (mode === 'archive') {
            await apiFetch(`/api/inbox/${id}/archive`, { method: 'POST' });
            toast('✅ Conversa arquivada', 'success');
        } else {
            await apiFetch(`/api/inbox/${id}`, { method: 'DELETE' });
            toast('🗑️ Conversa excluída permanentemente', 'success');
        }
        closeDeleteConvModal();
        // Remove da lista local e volta ao empty state
        allConversations = allConversations.filter(c => c.id !== id);
        if (currentConversation?.id === id) {
            currentConversation = null;
            const area = document.getElementById('chat-area');
            if (area) area.innerHTML = '<div class="empty-state-pro"><svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><h3>Selecione uma conversa</h3><p>Escolha uma conversa na lista ao lado para iniciar o atendimento</p></div>';
        }
        renderConversationList();
    } catch (err) {
        toast(`❌ Falha: ${err.message}`, 'error');
    }
}

async function restoreConversation(conversationId) {
    if (currentUser?.role !== 'Admin') return;
    if (!confirm('Restaurar esta conversa para o inbox ativo?')) return;
    try {
        await apiFetch(`/api/inbox/${conversationId}/unarchive`, { method: 'POST' });
        toast('✅ Conversa restaurada', 'success');
        allConversations = allConversations.filter(c => c.id !== conversationId);
        currentConversation = null;
        renderConversationList();
        if (typeof loadInbox === 'function') loadInbox();
    } catch (err) {
        toast(`❌ Falha: ${err.message}`, 'error');
    }
}

// ─── Re-sincronizar mensagens (recupera msgs perdidas pelo polling) ───
async function resyncConversation(conversationId) {
    try {
        toast('🔄 Re-puxando mensagens do WhatsApp...', 'info');
        const r = await apiFetch(`/api/inbox/${conversationId}/resync`, {
            method: 'POST',
            body: JSON.stringify({ limit: 50 }),
        });
        if (r.inserted > 0) {
            toast(`✅ ${r.inserted} mensagem(ns) recuperada(s)`, 'success');
            // Recarrega as mensagens da conversa atual pra mostrar as recuperadas
            if (currentConversation?.id === conversationId) {
                await loadMessages(currentConversation.id, currentConversation.whatsapp_chat_id);
            }
        } else {
            toast('Nada novo — todas as mensagens já estavam no inbox', 'info');
        }
    } catch (err) {
        toast(`❌ Falha ao re-sincronizar: ${err.message}`, 'error');
    }
}

async function pushConversationToPipedrive(conversationId, btnEl) {
    if (!conversationId) return;
    if (!confirm('Enviar esta conversa ao Pipedrive?\n\nIsso vai criar pessoa, deal, transcript e nota com dados de qualificação.')) return;

    const original = btnEl?.innerHTML;
    if (btnEl) { btnEl.disabled = true; btnEl.innerHTML = 'Enviando...'; }

    try {
        const res = await fetch(`/api/inbox/${conversationId}/push-to-pipedrive`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao enviar ao Pipedrive');

        if (data.already_synced) {
            alert('Conversa já foi enviada anteriormente ao Pipedrive.');
        } else {
            alert(`✅ Deal #${data.deal_id} criado no Pipedrive.`);
        }

        // Atualiza estado local e re-renderiza o chat (botão some)
        if (currentConversation?.id === conversationId) {
            currentConversation.crm_deal_id = String(data.deal_id);
            if (currentConversation.leads) {
                currentConversation.leads.crm_deal_id = String(data.deal_id);
                currentConversation.leads.crm_person_id = String(data.person_id);
            }
            renderChatArea(currentConversation);
            renderLeadPanel(currentConversation);
            await loadMessages(conversationId, currentConversation.whatsapp_chat_id);
        }
    } catch (err) {
        alert(`❌ Falha ao enviar ao Pipedrive: ${err.message}`);
        if (btnEl) { btnEl.disabled = false; btnEl.innerHTML = original; }
    }
}

// --- Filter Dropdown ---
function toggleFilterMenu() {
    const menu = document.getElementById('filter-dropdown-menu');
    menu?.classList.toggle('open');
}
// Close filter menu when clicking outside
document.addEventListener('click', (e) => {
    const dd = document.getElementById('filter-dropdown');
    const menu = document.getElementById('filter-dropdown-menu');
    if (menu?.classList.contains('open') && dd && !dd.contains(e.target)) {
        menu.classList.remove('open');
    }
});
function updateFilterDot() {
    const dot = document.getElementById('filter-active-dot');
    // multi-select considera "filtrando" quando há SOME (não-todos e não-vazio).
    // Vazio = "ver tudo" (mesmo que tudo selecionado), por design.
    const accountSelected = MultiSelect.getSelectedIds('inbox-account-filter');
    const userSelected    = MultiSelect.getSelectedIds('inbox-user-filter');
    const accountTotal = MultiSelect.getTotalOptions('inbox-account-filter');
    const userTotal    = MultiSelect.getTotalOptions('inbox-user-filter');
    const accountFiltering = accountSelected.length > 0 && accountSelected.length < accountTotal;
    const userFiltering    = userSelected.length > 0 && userSelected.length < userTotal;
    const hasFilter = currentFilter !== 'all'
        || accountFiltering
        || userFiltering;
    if (dot) dot.classList.toggle('show', hasFilter);
}

// ─── MultiSelect Component ───────────────────────────────────────────
// Dropdown com checkboxes. Default: tudo marcado = "ver tudo".
// Desmarcar tudo também = "ver tudo" (1 modo só, simplifica UX).
//
// API:
//   MultiSelect.init(elementId, items, { onChange, storageKey })
//   MultiSelect.getSelectedIds(elementId)          → array de IDs marcados
//   MultiSelect.getEffectiveIds(elementId)         → IDs pra mandar pro backend
//                                                    (vazio se "ver tudo")
//   MultiSelect.setSelectedIds(elementId, ids)     → atualiza programaticamente
//   MultiSelect.getTotalOptions(elementId)         → total de opções (pra dot)
//
// items: [{ id: string, label: string }, ...]
const MultiSelect = (() => {
    const _state = new Map();

    function _persist(s) {
        if (!s.storageKey) return;
        try { localStorage.setItem(s.storageKey, JSON.stringify(Array.from(s.selectedIds))); } catch {}
    }

    function _restore(storageKey) {
        if (!storageKey) return null;
        try {
            const raw = localStorage.getItem(storageKey);
            if (!raw) return null;
            return new Set(JSON.parse(raw));
        } catch { return null; }
    }

    function _renderTrigger(elementId) {
        const el = document.getElementById(elementId);
        if (!el) return;
        const s = _state.get(elementId);
        if (!s) return;
        const labelEl = el.querySelector('.multi-select-label');
        if (!labelEl) return;
        const total = s.items.length;
        const sel = s.selectedIds.size;
        const allLabel = el.dataset.emptyLabel || 'Todos';

        let text;
        if (sel === 0 || sel === total) {
            text = allLabel;
        } else if (sel === 1) {
            const id = Array.from(s.selectedIds)[0];
            const item = s.items.find(i => i.id === id);
            text = item ? item.label : '1 selecionado';
        } else {
            text = `${sel} selecionados`;
        }
        labelEl.textContent = text;
    }

    // Constrói as options via DOM (sem innerHTML) pra evitar qualquer chance de XSS
    function _renderOptions(elementId) {
        const el = document.getElementById(elementId);
        if (!el) return;
        const s = _state.get(elementId);
        if (!s) return;
        const optsEl = el.querySelector('.multi-select-options');
        if (!optsEl) return;
        optsEl.replaceChildren();
        for (const item of s.items) {
            const label = document.createElement('label');
            label.className = 'multi-select-option';
            label.dataset.id = item.id;

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = s.selectedIds.has(item.id);

            const span = document.createElement('span');
            span.className = 'multi-select-option-label';
            span.textContent = item.label;

            label.appendChild(cb);
            label.appendChild(span);
            optsEl.appendChild(label);
        }
    }

    function _emit(elementId) {
        const s = _state.get(elementId);
        if (!s) return;
        _persist(s);
        _renderTrigger(elementId);
        try { s.onChange?.(getEffectiveIds(elementId)); } catch (e) { console.error(e); }
    }

    function init(elementId, items, { onChange, storageKey } = {}) {
        const el = document.getElementById(elementId);
        if (!el) return;

        // Estado inicial: restaura do storage OU todos marcados
        const restored = _restore(storageKey);
        const initial = restored
            ? new Set(items.filter(i => restored.has(i.id)).map(i => i.id))
            : new Set(items.map(i => i.id));

        const s = { items, onChange, storageKey, selectedIds: initial };
        _state.set(elementId, s);

        _renderOptions(elementId);
        _renderTrigger(elementId);

        // Wire events 1x por elemento (idempotente em re-init)
        if (!el.dataset.wired) {
            el.dataset.wired = '1';

            el.querySelector('.multi-select-trigger').addEventListener('click', (e) => {
                e.stopPropagation();
                const menu = el.querySelector('.multi-select-menu');
                const trigger = el.querySelector('.multi-select-trigger');
                const isOpen = !menu.hidden;
                // Fecha outros menus abertos
                document.querySelectorAll('.multi-select-menu').forEach(m => {
                    if (m !== menu) {
                        m.hidden = true;
                        m.parentElement?.querySelector('.multi-select-trigger')?.setAttribute('aria-expanded', 'false');
                    }
                });
                menu.hidden = isOpen;
                trigger.setAttribute('aria-expanded', String(!isOpen));
            });

            el.querySelector('.multi-select-options').addEventListener('change', (e) => {
                const opt = e.target.closest('.multi-select-option');
                if (!opt) return;
                const id = opt.dataset.id;
                const checked = e.target.checked;
                const st = _state.get(elementId);
                if (!st) return;
                if (checked) st.selectedIds.add(id);
                else st.selectedIds.delete(id);
                _emit(elementId);
            });

            el.querySelector('[data-action="multi-select-all"]').addEventListener('click', () => {
                const st = _state.get(elementId);
                if (!st) return;
                st.selectedIds = new Set(st.items.map(i => i.id));
                _renderOptions(elementId);
                _emit(elementId);
            });
            el.querySelector('[data-action="multi-clear-all"]').addEventListener('click', () => {
                const st = _state.get(elementId);
                if (!st) return;
                st.selectedIds = new Set();
                _renderOptions(elementId);
                _emit(elementId);
            });
        }

        return s;
    }

    function getSelectedIds(elementId) {
        const s = _state.get(elementId);
        return s ? Array.from(s.selectedIds) : [];
    }

    function getTotalOptions(elementId) {
        const s = _state.get(elementId);
        return s ? s.items.length : 0;
    }

    // IDs pra mandar pro backend: vazio quando "ver tudo" (todos OU nenhum
    // selecionado), senão array filtrado.
    function getEffectiveIds(elementId) {
        const s = _state.get(elementId);
        if (!s) return [];
        const sel = s.selectedIds.size;
        if (sel === 0 || sel === s.items.length) return [];
        return Array.from(s.selectedIds);
    }

    function setSelectedIds(elementId, ids) {
        const s = _state.get(elementId);
        if (!s) return;
        s.selectedIds = new Set(ids);
        _renderOptions(elementId);
        _emit(elementId);
    }

    document.addEventListener('click', (e) => {
        document.querySelectorAll('.multi-select').forEach(el => {
            if (!el.contains(e.target)) {
                const menu = el.querySelector('.multi-select-menu');
                const trigger = el.querySelector('.multi-select-trigger');
                if (menu) menu.hidden = true;
                trigger?.setAttribute('aria-expanded', 'false');
            }
        });
    });

    return { init, getSelectedIds, getTotalOptions, getEffectiveIds, setSelectedIds };
})();

// --- Route Dropdown in Chat Header ---
function toggleRouteDropdown() {
    const menu = document.querySelector('.route-dropdown-menu');
    menu?.classList.toggle('open');
}
function closeRouteDropdown() {
    document.querySelector('.route-dropdown-menu')?.classList.remove('open');
}
document.addEventListener('click', (e) => {
    const dd = document.querySelector('.route-dropdown');
    const menu = document.querySelector('.route-dropdown-menu');
    if (menu?.classList.contains('open') && dd && !dd.contains(e.target)) {
        menu.classList.remove('open');
    }
});

// SPEC v2 §8 — Topbar: breadcrumb + WA pill + user chip
const TOPBAR_TITLES = {
    inbox:     { title: 'Inbox',     sub: 'Conversas WhatsApp' },
    deals:     { title: 'Deals',     sub: 'Pipedrive' },
    leads:     { title: 'Leads',     sub: 'Base completa' },
    scripts:   { title: 'Scripts',   sub: 'Templates de atendimento' },
    history:   { title: 'Histórico', sub: 'Conversas anteriores' },
    dashboard: { title: 'Dashboard', sub: 'Métricas comerciais' },
};
function updateTopbarCrumb(tab) {
    const t = TOPBAR_TITLES[tab];
    if (!t) return;
    const titleEl = document.getElementById('crumb-title');
    const subEl = document.getElementById('crumb-sub');
    if (titleEl) titleEl.textContent = t.title;
    if (subEl) subEl.textContent = t.sub;
}
function updateTopbarUser() {
    if (!currentUser) return;
    const avatar = document.getElementById('topbar-user-avatar');
    const name = document.getElementById('topbar-user-name');
    const role = document.getElementById('topbar-user-role');
    if (avatar) avatar.textContent = (currentUser.name || '?').split(/\s+/).slice(0,2).map(w => w[0]).join('').toUpperCase();
    if (name) name.textContent = currentUser.name || currentUser.email || '—';
    if (role) role.textContent = currentUser.role || '—';
}
function updateTopbarWaPill() {
    const dot = document.getElementById('status-dot');
    const pill = document.getElementById('topbar-wa-status');
    if (!dot || !pill) return;
    const offline = dot.classList.contains('offline');
    pill.classList.toggle('offline', offline);
    const txt = pill.querySelector('.status-pill-text');
    if (txt) txt.textContent = offline ? 'WA desconectado' : 'WA conectado';
}
function setupTopbarObservers() {
    const dot = document.getElementById('status-dot');
    if (dot) {
        updateTopbarWaPill();
        new MutationObserver(updateTopbarWaPill).observe(dot, { attributes: true, attributeFilter: ['class'] });
    }
    setupTopbarUserMenu();
}

// Dropdown do user-chip na topbar: clique abre, clique fora / Esc fecha.
// O item "Sair" usa data-action="logout", então o dispatcher global trata.
function setupTopbarUserMenu() {
    const trigger = document.getElementById('topbar-user-chip');
    const menu = document.getElementById('topbar-user-menu');
    if (!trigger || !menu || trigger.dataset.menuBound === '1') return;
    trigger.dataset.menuBound = '1';

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
    const onKey = (e) => {
        if (e.key === 'Escape') { close(); trigger.focus(); }
    };

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.hidden ? open() : close();
    });
    // Fecha ao clicar em qualquer item (logout dispara via dispatcher global)
    menu.addEventListener('click', () => close());
}

// ─── Topbar: badge de contas caídas (do user logado) ─────────────────
// Bate em /api/whatsapp/accounts/my-status periodicamente. Backend leu DB
// (rápido), sem round-trip à Unipile. Webhook do Unipile mantém o DB
// fresh em segundos quando algo cai. 30s é cadência confortável pra UI.
let _myStatusPoll = null;
async function refreshMyAccountsStatus() {
    if (!currentUser) return;
    const badge = document.getElementById('topbar-down-badge');
    const text = document.getElementById('topbar-down-badge-text');
    if (!badge || !text) return;
    try {
        const data = await apiFetch('/api/whatsapp/accounts/my-status');
        const down = data.down_count || 0;
        if (down === 0) {
            badge.style.display = 'none';
            return;
        }
        const downAccs = (data.accounts || []).filter(a => !a.ok);
        const labels = downAccs.map(a => a.label).slice(0, 2).join(', ');
        const more = downAccs.length > 2 ? ` +${downAccs.length - 2}` : '';
        text.textContent = down === 1
            ? `⚠️ ${labels} caiu`
            : `⚠️ ${down} contas caídas: ${labels}${more}`;
        badge.style.display = '';
    } catch { /* silencia — pode ser deploy ou auth */ }
}
function setupMyAccountsStatusPolling() {
    if (_myStatusPoll) return;
    refreshMyAccountsStatus();
    _myStatusPoll = setInterval(refreshMyAccountsStatus, 30_000);
}

// ─── Side-nav: badge de conversas pendentes do /site ─────────────────
// Bate em /api/site/conversations?status=waiting_human a cada 30s só pra
// quem tem site_access (admin sempre, outros via permissions). Pausa quando
// a aba some pra economizar request. Não monta UI nenhuma do site aqui —
// só o contador no botão da side-nav que linka pra /site.
let _siteBadgePoll = null;
async function refreshSiteWaitingBadge() {
    const badge = document.getElementById('badge-site');
    if (!badge) return;
    try {
        const convs = await apiFetch('/api/site/conversations?status=waiting_human');
        const count = Array.isArray(convs) ? convs.length : 0;
        badge.textContent = count;
        badge.classList.toggle('show', count > 0);
    } catch (err) {
        // 403 = perdeu permissão de site_access → some o badge silenciosamente.
        // Outros erros (rede/auth) também não devem poluir UI.
        badge.classList.remove('show');
    }
}
function setupSiteWaitingBadgePolling() {
    if (_siteBadgePoll) return;
    const isAdmin = currentUser?.role === 'Admin';
    const hasSiteAccess = isAdmin || currentUser?.permissions?.site_access === true;
    if (!hasSiteAccess) return;
    refreshSiteWaitingBadge();
    _siteBadgePoll = setInterval(() => {
        if (!document.hidden) refreshSiteWaitingBadge();
    }, 30_000);
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupTopbarObservers);
} else {
    setupTopbarObservers();
}

// SPEC v2 §6 — WA disconnected banner: sincroniza visibilidade com
// #status-dot.offline via MutationObserver. Single source of truth: o
// dot. Nenhum dos 5+ pontos onde dot.className é setado precisa
// chamar nada — o observer reage automaticamente.
function setupWaDisconnectedBanner() {
    const dot = document.getElementById('status-dot');
    const banner = document.getElementById('wa-disconnected-banner');
    if (!dot || !banner) return;
    const sync = () => {
        const offline = dot.classList.contains('offline');
        banner.style.display = offline ? '' : 'none';
    };
    sync();
    new MutationObserver(sync).observe(dot, { attributes: true, attributeFilter: ['class'] });
}
// Boot: registra o observer assim que DOM estiver pronto
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupWaDisconnectedBanner);
} else {
    setupWaDisconnectedBanner();
}

// SPEC v2 §5 — Aparência: persiste prefs em localStorage["atd:prefs"]
// e aplica em <html data-*>. Selects com [data-pref] disparam change.
function syncAppearanceSelectsFromPrefs() {
    let prefs = {};
    try { prefs = JSON.parse(localStorage.getItem('atd:prefs') || '{}'); } catch(_) {}
    document.querySelectorAll('[data-pref]').forEach(sel => {
        const key = sel.dataset.pref;
        const current = prefs[key] || document.documentElement.dataset[key] || sel.options[0]?.value;
        if (current && sel.value !== current) sel.value = current;
    });
}
document.addEventListener('change', function (e) {
    const sel = e.target.closest('[data-pref]');
    if (!sel) return;
    const key = sel.dataset.pref;
    const value = sel.value;
    let prefs = {};
    try { prefs = JSON.parse(localStorage.getItem('atd:prefs') || '{}'); } catch(_) {}
    prefs[key] = value;
    try { localStorage.setItem('atd:prefs', JSON.stringify(prefs)); } catch(_) {}
    document.documentElement.dataset[key] = value;
});
// (Sync ao abrir o modal acontece em openSettingsModal — chamada direta)

// SPEC v2 §2 — Chat header overflow menu (⋯) — agrupa ações secundárias
function toggleOverflowMenu() {
    const wrap = document.querySelector('.ch-overflow');
    if (!wrap) return;
    const wasOpen = wrap.classList.contains('open');
    // Close any sibling dropdowns first (route, scripts) to evitar empilhamento
    closeRouteDropdown();
    document.getElementById('scripts-menu')?.classList.remove('open');
    wrap.classList.toggle('open', !wasOpen);
}
function closeOverflowMenu() {
    document.querySelector('.ch-overflow')?.classList.remove('open');
}
document.addEventListener('click', (e) => {
    const wrap = document.querySelector('.ch-overflow');
    if (!wrap?.classList.contains('open')) return;
    // Fecha no click fora do wrap, ou no click em um item do menu
    if (!wrap.contains(e.target) || e.target.closest('.ch-menu-item')) {
        wrap.classList.remove('open');
    }
});

// --- Chat Tab Switching ---
function switchChatTab(tab) {
    document.querySelectorAll('.chat-input-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    const msgPanel = document.getElementById('chat-tab-message');
    const notesPanel = document.getElementById('chat-tab-notes');
    if (msgPanel) msgPanel.style.display = tab === 'message' ? '' : 'none';
    if (notesPanel) notesPanel.classList.toggle('active', tab === 'notes');
}

// --- Internal Notes (localStorage) ---
async function saveInternalNote() {
    if (!currentConversation) return;
    const input = document.getElementById('chat-notes-input');
    const text = (input?.value || '').trim();
    if (!text) return;
    try {
        await apiFetch(`/api/messages/${currentConversation.id}/note`, {
            method: 'POST',
            body: JSON.stringify({ text }),
        });
        input.value = '';
        toast('Anotacao salva', 'success');
        _lastMessagesHash = '';
        await loadMessages(currentConversation.id);
        switchChatTab('message');
    } catch (err) {
        toast(`Erro: ${err.message}`, 'error');
    }
}

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
    // Restaura estado do lead panel (redesign v2)
    try {
        const layout = document.querySelector('.inbox-layout');
        if (layout && localStorage.getItem('leadPanelHidden') === '1') {
            layout.classList.add('lead-panel-hidden');
        }
    } catch(_){}

    // Verifica autenticacao
    const token = getToken();
    if (!token) {
        window.location.href = '/login.html';
        return;
    }

    // Carrega dados do usuario
    try {
        const data = await apiFetch('/api/auth/me');
        if (!data || !data.user) throw new Error('Sessao invalida');
        currentUser = data.user;
        localStorage.setItem('ba_user', JSON.stringify(currentUser));
    } catch (err) {
        console.warn('Auth falhou:', err.message);
        localStorage.removeItem('ba_token');
        localStorage.removeItem('ba_user');
        window.location.href = '/login.html';
        return;
    }

    // Inicia a interface — cada setup tem try/catch proprio
    try { setupCurrentUser(); } catch (e) { console.warn('setupCurrentUser:', e); }
    try { setupTabs(); } catch (e) { console.warn('setupTabs:', e); }
    try { setupInboxFilters(); } catch (e) { console.warn('setupInboxFilters:', e); }
    try { setupScriptCats(); } catch (e) { console.warn('setupScriptCats:', e); }
    try { setupScriptForm(); } catch (e) { console.warn('setupScriptForm:', e); }
    try { setupInboxSearch(); } catch (e) { console.warn('setupInboxSearch:', e); }
    try { setupGruposSearch(); } catch (e) { console.warn('setupGruposSearch:', e); }
    try { setupMyAccountsStatusPolling(); } catch (e) { console.warn('setupMyAccountsStatusPolling:', e); }
    try { setupSiteWaitingBadgePolling(); } catch (e) { console.warn('setupSiteWaitingBadgePolling:', e); }
    try { setupLeadFilters(); } catch (e) { console.warn('setupLeadFilters:', e); }
    try { setupHistoryFilters(); } catch (e) { console.warn('setupHistoryFilters:', e); }
    try { setupDashPeriod(); } catch (e) { console.warn('setupDashPeriod:', e); }

    try { setupEventDelegation(); } catch (e) { console.warn('setupEventDelegation:', e); }
    try { setupMobile(); } catch (e) { console.warn('setupMobile:', e); }

    // Deep-link via ?tab=X — usado por links externos (ex: side-nav do /site).
    // Tabs válidas: as que existem no markup (data-tab). Inválidas são ignoradas.
    try {
        const tabParam = new URLSearchParams(location.search).get('tab');
        if (tabParam && document.querySelector(`.nav-btn[data-tab="${tabParam}"]`)) {
            switchTab(tabParam);
        }
    } catch (e) { console.warn('tab param:', e); }

    // Deals tab events
    document.getElementById('btn-send-outbound')?.addEventListener('click', sendOutbound);
    document.getElementById('btn-import-history')?.addEventListener('click', importWhatsAppHistory);
    document.getElementById('deals-search')?.addEventListener('input', debounce(searchDeals, 400));

    // Fix autofill: browser ignora autocomplete=off, limpamos via JS
    document.querySelectorAll('.sidebar-search, .search-input').forEach(el => { el.value = ''; });

    try { loadInbox(); } catch (e) { console.warn('loadInbox:', e); }
    try { startPolling(); } catch (e) { console.warn('startPolling:', e); }
    try { checkHealth(); } catch (e) { console.warn('checkHealth:', e); }
    setInterval(() => { try { checkHealth(); } catch { /* */ } }, 30000);
});


// --- Polling ---
let _pollingInProgress = false;

function startPolling() {
    pollTimer = setInterval(async () => {
        if (_pollingInProgress) return; // Evita race condition de polls sobrepostos
        _pollingInProgress = true;
        try {
            await loadInbox(true); // silent = true (nao reseta selecao)
            if (currentConversation) await loadMessages(currentConversation.id, currentConversation.whatsapp_chat_id);
        } finally {
            _pollingInProgress = false;
        }
    }, 7000);
}

// --- Health Check ---
async function checkHealth() {
    const dot = document.getElementById('status-dot');
    if (!dot) return;

    // Para não-Admin, o status reflete apenas os números atribuídos ao próprio user.
    // Para Admin, mantém a checagem global (UNIPILE_ACCOUNT_ID do env via /api/health).
    const isAdmin = currentUser?.role === 'Admin';

    try {
        if (!isAdmin) {
            const data = await apiFetch('/api/whatsapp/accounts');
            const accounts = data.accounts || [];

            if (accounts.length === 0) {
                dot.className = 'status-dot offline';
                dot.title = 'Nenhum número WhatsApp atribuído a você';
                return;
            }

            // "ok"/"connected"/"running"/"ok_for_now" — qualquer um desses vale como online
            const isConnected = s => /^(ok|connected|running|ok_for_now)$/i.test(s || '');
            const connected = accounts.filter(a => isConnected(a.status));

            if (connected.length === accounts.length) {
                dot.className = 'status-dot online';
                dot.title = connected.length === 1
                    ? `WhatsApp conectado — ${connected[0].phone_number || connected[0].name}`
                    : `${connected.length} números WhatsApp conectados`;
            } else if (connected.length > 0) {
                dot.className = 'status-dot offline';
                dot.title = `${accounts.length - connected.length} de ${accounts.length} números desconectados`;
            } else {
                dot.className = 'status-dot offline';
                dot.title = 'WhatsApp desconectado — reconecte';
            }
            return;
        }

        // Admin: health global
        const data = await apiFetch('/api/health');
        const waOk = data.services?.unipile;
        const rawStatus = data.services?.waStatus || 'unknown';

        dot.className = 'status-dot ' + (waOk ? 'online' : 'offline');
        dot.title = waOk ? 'WhatsApp conectado' :
            (rawStatus === 'CREDENTIALS' || rawStatus === 'error') ? 'WhatsApp desconectado — reconecte' :
            'WhatsApp offline';

        if (!waOk && (rawStatus === 'CREDENTIALS' || rawStatus === 'error')) {
            dot.style.animation = 'pulse-warn 1s infinite';
        }
    } catch {
        dot.className = 'status-dot offline';
        dot.title = 'Servidor offline';
    }
}

// --- Tabs ---
function setupTabs() {
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            switchTab(btn.dataset.tab);
        });
    });
}

function switchTab(tab) {
    document.querySelectorAll('.nav-btn[data-tab]').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    const btn = document.querySelector(`.nav-btn[data-tab="${tab}"]`);
    if (btn) btn.classList.add('active');
    document.getElementById(`panel-${tab}`)?.classList.add('active');
    if (typeof updateTopbarCrumb === 'function') updateTopbarCrumb(tab);
    if (tab === 'dashboard') loadDashboard();
    if (tab === 'scripts') loadScripts();
    if (tab === 'leads') loadLeads();
    if (tab === 'history') setTimeout(loadHistory, 100);
    if (tab === 'deals') loadDeals();
    if (tab === 'grupos') loadGrupos();
}

// ─── Grupos WhatsApp ─────────────────────────────────────────────────
let allGrupos = [];
let currentGrupo = null;
let gruposSearchTerm = '';

async function loadGrupos() {
    const listEl = document.getElementById('grupos-list');
    if (!listEl) return;
    try {
        const data = await apiFetch('/api/groups?limit=100');
        allGrupos = data.groups || [];
        renderGruposList();
        updateGruposBadge();
    } catch (err) {
        listEl.replaceChildren();
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.style.padding = '40px 16px';
        empty.textContent = `Falha ao carregar: ${err.message}`;
        listEl.appendChild(empty);
    }
}

function updateGruposBadge() {
    const badge = document.getElementById('badge-grupos');
    if (!badge) return;
    const unread = allGrupos.reduce((sum, g) => sum + (g.unread_count || 0), 0);
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.style.display = unread > 0 ? '' : 'none';
}

function renderGruposList() {
    const listEl = document.getElementById('grupos-list');
    if (!listEl) return;
    const term = gruposSearchTerm;
    const items = allGrupos.filter(g => {
        if (!term) return true;
        return (g.group_subject || '').toLowerCase().includes(term);
    });

    listEl.replaceChildren();
    if (items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.style.padding = '40px 16px';
        empty.textContent = term ? 'Nenhum grupo encontrado' : 'Nenhum grupo';
        listEl.appendChild(empty);
        return;
    }

    // Layout 2 linhas (mesmo padrão do inbox principal):
    //   linha 1: 👥 nome | hora
    //   linha 2: prefixo "Sender: " + preview da última msg (vazio se sem msgs)
    for (const g of items) {
        const isActive = currentGrupo?.id === g.id;
        const hasUnread = g.unread_count > 0;

        const item = document.createElement('div');
        const klasses = ['conv-item'];
        if (isActive) klasses.push('active');
        if (hasUnread) klasses.push('unread');
        item.className = klasses.join(' ');
        item.dataset.id = g.id;

        const main = document.createElement('div');
        main.className = 'conv-main';

        const top = document.createElement('div');
        top.className = 'conv-item-top';
        const name = document.createElement('span');
        name.className = 'conv-name';
        // Prefix com 👥 inline em vez de avatar separado (mais compacto)
        name.textContent = `👥 ${g.group_subject || '(grupo sem nome)'}`;
        const time = document.createElement('span');
        time.className = 'conv-time';
        time.textContent = g.last_message_at ? formatTime(g.last_message_at) : '';
        top.appendChild(name);
        top.appendChild(time);

        const snippet = document.createElement('div');
        snippet.className = 'conv-snippet';
        const lastMsg = (g.messages || [])[0];
        if (lastMsg) {
            const senderPrefix = lastMsg.sender_name && lastMsg.direction === 'inbound'
                ? `${lastMsg.sender_name}: `
                : '';
            snippet.textContent = senderPrefix + (lastMsg.content || '(mídia)').slice(0, 80);
        }
        // sem msg → snippet vazio (não polui com "X membros")

        main.appendChild(top);
        main.appendChild(snippet);

        // Badges de contas Branddi que estão no grupo (Caroline, Ricardo, etc).
        // Útil quando o mesmo grupo tem múltiplas contas — antes da consolidação
        // canonical viravam linhas duplicadas; agora ficam num só card com tags.
        const labels = (g.account_display_labels || []).filter(Boolean);
        if (labels.length > 0) {
            const tagsRow = document.createElement('div');
            tagsRow.className = 'conv-account-tags';
            tagsRow.style.display = 'flex';
            tagsRow.style.flexWrap = 'wrap';
            tagsRow.style.gap = '4px';
            tagsRow.style.marginTop = '4px';
            for (const label of labels) {
                const tag = document.createElement('span');
                tag.textContent = `📱 ${label}`;
                tag.style.fontSize = '10px';
                tag.style.padding = '1px 6px';
                tag.style.borderRadius = '4px';
                tag.style.background = 'var(--bg-2)';
                tag.style.color = 'var(--text-2)';
                tagsRow.appendChild(tag);
            }
            main.appendChild(tagsRow);
        }

        item.appendChild(main);

        if (hasUnread) {
            const unread = document.createElement('span');
            unread.className = 'conv-unread';
            unread.textContent = String(g.unread_count);
            item.appendChild(unread);
        }

        item.addEventListener('click', () => openGrupo(g.id));
        listEl.appendChild(item);
    }
}

async function openGrupo(grupoId) {
    const grupo = allGrupos.find(g => g.id === grupoId);
    if (!grupo) return;
    currentGrupo = grupo;
    renderGruposList(); // realça o ativo

    // Render chat area + members panel
    renderGrupoChat(grupo);
    renderGrupoMembers(grupo);

    // Carrega mensagens (reusa endpoint existente)
    try {
        const data = await apiFetch(`/api/messages/${grupoId}?limit=100`);
        const msgs = data.messages || [];
        renderGrupoMessages(grupo, msgs);
    } catch (err) {
        console.error('Erro carregando msgs do grupo:', err);
    }
}

function renderGrupoChat(grupo) {
    const area = document.getElementById('grupos-chat-area');
    if (!area) return;
    area.replaceChildren();

    // Header
    const header = document.createElement('header');
    header.className = 'chat-header';
    const left = document.createElement('div');
    left.className = 'ch-info chat-header-left';
    const ava = document.createElement('div');
    ava.className = 'ch-avatar chat-avatar';
    ava.style.fontSize = '18px';
    ava.textContent = '👥';
    const info = document.createElement('div');
    info.className = 'ch-info-text';
    const name = document.createElement('div');
    name.className = 'ch-name chat-meta-name';
    name.textContent = grupo.group_subject || '(grupo sem nome)';
    const sub = document.createElement('div');
    sub.className = 'ch-status chat-meta-sub';
    sub.textContent = `${(grupo.group_participants || []).length} membros`;
    info.appendChild(name);
    info.appendChild(sub);
    left.appendChild(ava);
    left.appendChild(info);
    header.appendChild(left);
    area.appendChild(header);

    // Messages wrap (flex:1, overflow-y:auto vem do CSS .messages-wrap)
    const wrap = document.createElement('div');
    wrap.className = 'messages-wrap';
    wrap.id = 'grupos-messages-wrap';
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.style.padding = '40px 0';
    empty.textContent = 'Carregando mensagens...';
    wrap.appendChild(empty);
    area.appendChild(wrap);

    // Composer (input + botão enviar) — mesma estrutura que o inbox usa
    const inputWrap = document.createElement('div');
    inputWrap.className = 'chat-input-wrap';
    inputWrap.id = 'grupos-input-wrap';

    const inputRow = document.createElement('div');
    inputRow.className = 'chat-input-row';

    const textarea = document.createElement('textarea');
    textarea.className = 'chat-textarea';
    textarea.id = 'grupos-input';
    textarea.placeholder = 'Digite sua mensagem... (Cmd/Ctrl+Enter para enviar)';
    textarea.rows = 1;
    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            sendGrupoMessage();
        }
    });

    const sendBtn = document.createElement('button');
    sendBtn.className = 'send-btn';
    sendBtn.id = 'grupos-send-btn';
    sendBtn.type = 'button';
    sendBtn.textContent = '▶';
    sendBtn.addEventListener('click', sendGrupoMessage);

    inputRow.appendChild(textarea);
    inputRow.appendChild(sendBtn);
    inputWrap.appendChild(inputRow);
    area.appendChild(inputWrap);
}

let _grupoSending = false;
async function sendGrupoMessage() {
    if (_grupoSending || !currentGrupo) return;
    const input = document.getElementById('grupos-input');
    const sendBtn = document.getElementById('grupos-send-btn');
    if (!input) return;
    const text = (input.value || '').trim();
    if (!text) return;

    _grupoSending = true;
    if (sendBtn) sendBtn.disabled = true;
    try {
        // Reusa o endpoint padrão de envio de mensagens — funciona pra group chat
        // (a API Unipile aceita o mesmo POST /chats/:id/messages)
        await apiFetch(`/api/messages/${currentGrupo.id}/send`, {
            method: 'POST',
            body: JSON.stringify({ text }),
        });
        input.value = '';
        // Recarrega mensagens pra ver o que enviamos
        const data = await apiFetch(`/api/messages/${currentGrupo.id}?limit=100`);
        renderGrupoMessages(currentGrupo, data.messages || []);
    } catch (err) {
        toast(`❌ Falha ao enviar: ${err.message}`, 'error');
    } finally {
        _grupoSending = false;
        if (sendBtn) sendBtn.disabled = false;
    }
}

function renderGrupoMessages(grupo, msgs) {
    const wrap = document.getElementById('grupos-messages-wrap');
    if (!wrap) return;
    wrap.replaceChildren();
    if (!msgs || msgs.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.style.padding = '40px 0';
        empty.textContent = 'Nenhuma mensagem ainda';
        wrap.appendChild(empty);
        return;
    }
    for (const m of msgs) {
        const isOut = m.direction === 'outbound';
        const cls = isOut ? 'outbound' : 'inbound';

        const bubble = document.createElement('div');
        bubble.className = `msg-bubble msg-row msg-${cls} ${cls}`;
        bubble.style.maxWidth = '85%';

        // Em grupos: SEMPRE mostra sender_name (estilo grupo do WhatsApp)
        const senderEl = document.createElement('div');
        senderEl.className = 'msg-sender';
        senderEl.textContent = m.sender_name || (isOut ? 'Atendente' : 'Membro');
        senderEl.style.fontSize = '11px';
        senderEl.style.fontWeight = '600';
        senderEl.style.marginBottom = '2px';
        senderEl.style.color = 'var(--accent)';
        bubble.appendChild(senderEl);

        const body = document.createElement('div');
        body.className = 'msg-body';
        body.textContent = m.content || '';
        bubble.appendChild(body);

        const meta = document.createElement('div');
        meta.className = 'msg-meta';
        meta.style.fontSize = '10px';
        meta.style.color = 'var(--text-3)';
        meta.style.marginTop = '4px';
        meta.textContent = formatTime(m.created_at);
        bubble.appendChild(meta);

        wrap.appendChild(bubble);
    }
    wrap.scrollTop = wrap.scrollHeight;
}

function renderGrupoMembers(grupo) {
    const panel = document.getElementById('grupos-info-panel');
    const list = document.getElementById('grupos-members-list');
    if (!panel || !list) return;
    panel.style.display = '';

    list.replaceChildren();
    const members = grupo.group_participants || [];

    // Seção de contas Branddi membros do grupo (pós-consolidação canonical).
    // Mostra ANTES dos membros externos pra deixar claro quais contas nossas
    // estão lá dentro (e quais conseguem mandar msg).
    const accountLabels = (grupo.account_display_labels || []).filter(Boolean);
    if (accountLabels.length > 0) {
        const accHeading = document.createElement('div');
        accHeading.style.fontSize = '12px';
        accHeading.style.color = 'var(--text-3)';
        accHeading.style.padding = '8px 12px 4px';
        accHeading.style.fontWeight = '600';
        accHeading.textContent = `Contas Branddi (${accountLabels.length})`;
        list.appendChild(accHeading);
        for (const label of accountLabels) {
            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.padding = '6px 12px';
            row.style.fontSize = '13px';
            row.textContent = `📱 ${label}`;
            list.appendChild(row);
        }
        const divider = document.createElement('div');
        divider.style.borderTop = '1px solid var(--border-md)';
        divider.style.margin = '8px 0';
        list.appendChild(divider);
    }

    const heading = document.createElement('div');
    heading.style.fontSize = '12px';
    heading.style.color = 'var(--text-3)';
    heading.style.padding = '8px 12px';
    heading.textContent = `${members.length} membros`;
    list.appendChild(heading);

    for (const m of members) {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.flexDirection = 'column';
        row.style.padding = '8px 12px';
        row.style.borderBottom = '1px solid var(--border-md)';

        // Display: nome real > phone formatado > "Sem identificação".
        // Phone formatado é melhor que "Sem nome" — ao menos identifica
        // unicamente o membro pra quem conhece o número.
        const displayName = m.name || formatPhoneBR(m.phone) || 'Sem identificação';
        const isFallback = !m.name;

        const name = document.createElement('div');
        name.style.fontSize = '13px';
        name.style.fontWeight = m.is_self ? '600' : '500';
        if (isFallback) name.style.color = 'var(--text-2)';
        name.textContent = displayName + (m.is_self ? ' (você)' : '');
        row.appendChild(name);

        // Mostra phone como sublinha SÓ quando temos nome (senão duplicaria)
        if (m.name && m.phone) {
            const phone = document.createElement('div');
            phone.style.fontSize = '11px';
            phone.style.color = 'var(--text-3)';
            phone.textContent = formatPhoneBR(m.phone) || m.phone;
            row.appendChild(phone);
        }
        list.appendChild(row);
    }
}

// Formata phone BR pra display: "+5511987654321" → "+55 11 98765-4321"
// Phones internacionais (não 55) ou inválidos: retorna como veio.
function formatPhoneBR(raw) {
    if (!raw) return null;
    const digits = String(raw).replace(/\D/g, '');
    if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
        const cc = digits.slice(0, 2);
        const ddd = digits.slice(2, 4);
        const rest = digits.slice(4);
        // 9 dígitos = celular novo (5 + 4); 8 dígitos = fixo / celular antigo (4 + 4)
        const split = rest.length === 9
            ? `${rest.slice(0, 5)}-${rest.slice(5)}`
            : `${rest.slice(0, 4)}-${rest.slice(4)}`;
        return `+${cc} ${ddd} ${split}`;
    }
    // Internacional ou desconhecido — preserva e adiciona '+' se faltou
    return raw.startsWith('+') ? raw : `+${raw}`;
}

function setupGruposSearch() {
    const input = document.getElementById('grupos-search');
    if (!input) return;
    input.addEventListener('input', debounce(() => {
        gruposSearchTerm = (input.value || '').trim().toLowerCase();
        renderGruposList();
    }, 300));
}

// --- INBOX ---

let inboxSearchTerm = '';

function setupInboxFilters() {
    // Filtros de status
    document.querySelectorAll('.filter-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            const prev = currentFilter;
            currentFilter = chip.dataset.filter;
            // Alternar para/de 'archived' exige reload do inbox (filtro server-side)
            if (currentFilter === 'archived' || prev === 'archived') {
                loadInbox();
            } else {
                renderConversationList();
            }
            updateFilterDot();
        });
    });

    // Filtro por usuário (Admin only)
    const userFilterEl = document.getElementById('inbox-user-filter');
    const userGroup = document.getElementById('filter-user-group');
    if (userFilterEl && currentUser?.role === 'Admin') {
        if (userGroup) userGroup.style.display = '';
        apiFetch('/api/users').then(data => {
            const users = data.users || [];
            const items = users.map(u => ({ id: u.id, label: `${u.name} (${u.role})` }));
            MultiSelect.init('inbox-user-filter', items, {
                storageKey: 'inbox.filter.user_ids',
                onChange: () => { updateFilterDot(); loadInbox(); },
            });
        }).catch(() => {});
    }

    // Filtro por número WhatsApp — aparece quando user tem 2+ números atribuídos.
    // Admin SEMPRE pode (vê todos os números do sistema). Non-Admin só vê os seus.
    const accountFilterEl = document.getElementById('inbox-account-filter');
    const accountGroup = document.getElementById('filter-account-group');
    const isAdmin = currentUser?.role === 'Admin';
    const myAccounts = currentUser?.permissions?.whatsapp_accounts || [];
    const showAccountFilter = isAdmin || myAccounts.length >= 2;

    if (accountFilterEl && showAccountFilter) {
        if (accountGroup) accountGroup.style.display = '';
        apiFetch('/api/whatsapp/accounts').then(data => {
            const accounts = (data.accounts || []).filter(a =>
                isAdmin || myAccounts.includes(a.id)
            );
            const items = accounts.map(a => ({
                id: a.id,
                // Prefere display_name (Harylanne, Ricardo, Gio). Fallback: número.
                label: a.display_name || a.phone_number || a.name || a.id,
            }));
            MultiSelect.init('inbox-account-filter', items, {
                storageKey: 'inbox.filter.account_ids',
                onChange: () => { updateFilterDot(); loadInbox(); },
            });
        }).catch(() => {});
    }

    // Abas "Tudo / Site / Prospecao" foram removidas — hoje 100% das conversas
    // são prospecting. Backend ainda aceita ?type= por compat, mas frontend
    // não envia mais. Filtragem por permissions.conversation_types continua
    // sendo aplicada server-side em getInbox via allowed_types.
}

function setupInboxSearch() {
    const searchInput = document.getElementById('inbox-search');
    if (!searchInput) return;
    searchInput.addEventListener('input', debounce(() => {
        inboxSearchTerm = (searchInput.value || '').trim().toLowerCase();
        renderConversationList();
    }, 300));
}

function setInboxFilter(filter) {
    currentFilter = filter;
    document.querySelectorAll('.filter-chip').forEach(c => {
        c.classList.toggle('active', c.dataset.filter === filter);
    });
    renderConversationList();
}

let _lastInboxHash = '';

async function loadInbox(silent = false) {
    try {
        // Multi-select: vazio = "ver tudo" (não envia param). Senão, csv.
        const userIds = MultiSelect.getEffectiveIds('inbox-user-filter');
        const userParam = userIds.length ? `&filter_user_ids=${encodeURIComponent(userIds.join(','))}` : '';
        const accountIds = MultiSelect.getEffectiveIds('inbox-account-filter');
        const accountParam = accountIds.length ? `&filter_account_ids=${encodeURIComponent(accountIds.join(','))}` : '';
        const archivedParam = currentFilter === 'archived' ? '&archived=true' : '';
        const data = await apiFetch(`/api/inbox?limit=100${userParam}${accountParam}${archivedParam}`);
        const newConversations = data.conversations || [];

        // Hash rápido para detectar mudanças e evitar re-render desnecessário (flicker)
        const newHash = JSON.stringify(newConversations.map(c => `${c.id}:${c.status}:${c.unread_count}:${c.last_message?.created_at}`));
        if (silent && newHash === _lastInboxHash) return; // Nada mudou
        _lastInboxHash = newHash;

        const prevIds = new Set(allConversations.map(c => c.id));
        allConversations = newConversations;

        if (silent) {
            const newConvs = allConversations.filter(c => !prevIds.has(c.id));
            if (newConvs.length > 0) {
                const leadName = newConvs[0].leads?.name || 'Lead';
                showNewMsgNotif(`Nova conversa: ${leadName}`);
                showBrowserNotification('Branddi Atendimento', `Nova conversa: ${leadName}`);
            }
        }

        renderConversationList();
        updateInboxBadge();
    } catch (err) {
        if (!silent) console.error('Inbox error:', err);
    }
}


function renderConversationList() {
    const list = document.getElementById('conversation-list');
    let filtered = allConversations;

    if (currentFilter !== 'all' && currentFilter !== 'archived') {
        if (currentFilter === 'waiting') filtered = filtered.filter(c => c.status === 'waiting');
        else if (currentFilter === 'comercial') filtered = filtered.filter(c => c.assigned_to === 'comercial' || c.leads?.classification === 'comercial');
        else if (currentFilter === 'opec') filtered = filtered.filter(c => c.assigned_to === 'opec' || c.leads?.classification === 'opec');
    }
    // archived: servidor já retorna só as arquivadas quando filtro=archived;
    // em outros filtros (all/waiting/in_progress/comercial/opec), exclui as
    // arquivadas que possam ter vazado no cache local — evita mostrar a
    // conv com .archived class (opacity 0.65) na inbox normal.
    if (currentFilter !== 'archived') {
        filtered = filtered.filter(c => !c.archived_at);
    }

    // Client-side search
    if (inboxSearchTerm) {
        filtered = filtered.filter(c => {
            const lead = c.leads || {};
            const haystack = [
                lead.name || '',
                lead.company_name || '',
                lead.phone || '',
            ].join(' ').toLowerCase();
            return haystack.includes(inboxSearchTerm);
        });
    }

    if (filtered.length === 0) {
        list.innerHTML = '<div class="empty-state-pro"><div class="empty-illustration"><svg class="icon"><use href="/icons.svg#icon-inbox"></use></svg></div><h4 class="empty-title">Nenhuma conversa</h4><p class="empty-desc">As novas conversas aparecer\u00e3o aqui automaticamente</p></div>';
        return;
    }

    list.innerHTML = filtered.map(conv => {
        const lead = conv.leads || {};
        const name = lead.name || formatPhone(lead.phone) || 'Desconhecido';
        const preview = conv.last_message?.content ? truncate(conv.last_message.content, 55) : '...';
        const time = conv.last_message ? relativeTime(conv.last_message.created_at) : relativeTime(conv.created_at);
        const isActive = currentConversation?.id === conv.id;
        const hasUnread = (conv.unread_count || 0) > 0;
        // Última mensagem foi do lead → highlight visual diferente do "nova msg"
        const lastFromLead = conv.last_message?.direction === 'inbound';

        // Atendente — paleta determinística pelo nome.
        // 1 owner = pill simples; 2+ owners = empilha tags (raro).
        // Tag com nome > círculo com inicial: "S" pode ser Sergio OU Stephanie,
        // mas "SERGIO" é inequívoco.
        const ownerNames = Array.isArray(conv.account_owner_names) && conv.account_owner_names.length > 0
            ? conv.account_owner_names
            : (conv.account_owner_name ? [conv.account_owner_name] : []);
        const ownerTags = ownerNames
            .slice(0, 3) // até 3 tags inline; depois corta (raro)
            .map(n => `<span class="tag tag-owner" data-color="${ownerColorClass(n)}">${escHtml(n.slice(0, 14))}</span>`)
            .join('');

        // Empresa: lead.company_name → fallback localStorage[atd:org:LEAD_ID]
        // (preenchido quando user seleciona deal no picker — Pipedrive deals
        // têm org_name mesmo quando lead.company_name no Branddi tá vazio)
        let company = lead.company_name || '';
        if (!company && lead.id) {
            try { company = localStorage.getItem(`atd:org:${lead.id}`) || ''; } catch (_) {}
        }
        const isArchived = !!conv.archived_at;

        const klass = ['conv-item'];
        if (isActive)            klass.push('active');
        if (hasUnread)           klass.push('unread');
        if (lastFromLead)        klass.push('lead-replied');
        if (isArchived)          klass.push('archived');

        const unreadHtml = hasUnread
            ? `<span class="conv-unread">${conv.unread_count}</span>`
            : '';

        return `<div class="${klass.join(' ')}" data-id="${conv.id}" data-action="select-conversation">
            <div class="conv-main">
                <div class="conv-item-top">
                    <span class="conv-name">${escHtml(name)}</span>
                    <span class="conv-time">${time}${isArchived ? ' 🗃️' : ''}</span>
                </div>
                <div class="conv-snippet${lastFromLead ? ' replied' : ''}">${lastFromLead ? '↩ ' : ''}${escHtml(preview)}</div>
                ${(company || ownerTags) ? `<div class="conv-meta-row">${company ? `<span class="conv-company">${escHtml(company)}</span>` : ''}${ownerTags}</div>` : ''}
            </div>
            ${unreadHtml}
        </div>`;
    }).join('');
}

// Atribui uma das 8 paletas pré-definidas com base em hash djb2 —
// determinístico entre sessões: "Harylanne" sempre cai na mesma cor.
// djb2 (h * 33 + c) tem distribuição muito melhor que h * 31 + c em
// strings curtas latinas. Mod 8 (vs 6) reduz colisões: testes com
// time típico (10 nomes) caem de 7→3 colisões.
function ownerColorClass(name) {
    if (!name) return 'c0';
    let h = 5381;
    for (let i = 0; i < name.length; i++) {
        h = ((h << 5) + h + name.charCodeAt(i)) | 0;
    }
    return 'c' + (Math.abs(h) % 8);
}

// Render AvatarStack de owners — SPEC v2 §1.2:
// avatares circulares 22px, overlap -8px, max 3 visíveis + "+N".
function renderAvatarStack(names) {
    if (!Array.isArray(names) || names.length === 0) return '';
    const visible = names.slice(0, 3);
    const more = names.length - visible.length;
    const stack = visible.map(n => {
        const init = String(n).split(/\s+/).filter(Boolean).slice(0, 2)
            .map(w => w[0]).join('').toUpperCase() || '?';
        return `<span class="avatar" data-color="${ownerColorClass(n)}" title="${escHtml(n)}">${escHtml(init)}</span>`;
    }).join('');
    const moreHtml = more > 0
        ? `<span class="avatar avatar-more" title="+${more} mais">+${more}</span>`
        : '';
    return `<div class="avatar-stack">${stack}${moreHtml}</div>`;
}

function updateInboxBadge() {
    const waiting = allConversations.filter(c => c.status === 'waiting').length;
    const badge   = document.getElementById('badge-inbox');
    if (badge) {
        badge.textContent = waiting;
        badge.classList.toggle('show', waiting > 0);
    }
}

async function selectConversation(convId) {
    let conv = allConversations.find(c => c.id === convId);

    // Fallback: conversa não está na lista filtrada (ex: criada agora,
    // outra aba, archived). Busca individualmente.
    if (!conv) {
        try {
            const data = await apiFetch(`/api/inbox/conversation/${convId}`);
            conv = data?.conversation;
            if (conv) {
                // Adiciona à lista pra evitar próximo fetch e manter UX consistente
                allConversations = [conv, ...allConversations.filter(c => c.id !== conv.id)];
            }
        } catch (err) {
            console.warn('selectConversation: fetch fallback falhou', err.message);
        }
    }
    if (!conv) return;

    currentConversation = conv;
    _lastMessagesHash = '';
    renderConversationList();
    renderChatArea(currentConversation);
    renderLeadPanel(currentConversation);
    await loadMessages(convId, currentConversation.whatsapp_chat_id);
}

// --- Chat Area ---

function renderChatArea(conv) {
    const lead = conv.leads || {};
    const name = lead.name || formatPhone(lead.phone) || 'Desconhecido';
    const initials = name.split(' ').slice(0,2).map(w => w[0]).join('').toUpperCase();
    const cls = lead.classification || 'unclassified';

    // SPEC v2 §2 — chat header (split inline + ⋯ overflow)
    // Status pill mapping (conv.status → tone + label)
    const statusToneMap = { waiting: 'warning', in_progress: 'success', closed: 'muted', archived: 'danger' };
    const statusLabelMap = { waiting: 'Aguardando', in_progress: 'Em andamento', closed: 'Encerrada', archived: 'Arquivada' };
    const statusKey = conv.archived_at ? 'archived' : (conv.status || 'waiting');
    const statusTone = statusToneMap[statusKey] || 'muted';
    const statusLabel = statusLabelMap[statusKey] || statusKey;

    const isAdmin = currentUser?.role === 'Admin';
    const showPipedrive = (cls !== 'opec' && !conv.crm_deal_id && !lead.crm_deal_id);

    const area = document.getElementById('chat-area');
    area.innerHTML = `
        <header class="chat-header">
            <div class="ch-info chat-header-left">
                <div class="ch-avatar chat-avatar">${initials}</div>
                <div class="ch-info-text">
                    <div class="ch-name chat-meta-name">${escHtml(name)}</div>
                    <div class="ch-status chat-meta-sub">
                        <span class="status-dot ${statusTone}"></span>
                        ${statusLabel}${lead.company_name ? ' · ' + escHtml(lead.company_name) : ''}${classLabel(cls) ? ' · ' + classLabel(cls) : ''}
                    </div>
                </div>
            </div>
            <div class="ch-actions chat-header-actions">
                <!-- Atribuir + Pipedrive removidos: este Inbox é só prospecção
                     (deals já existem no Pipedrive desde o início). Conversas
                     do site → /site/ que tem o fluxo Atribuir + criar deal. -->
                <div class="ch-overflow">
                    <button class="btn-icon" data-action="open-overflow-menu" title="Mais ações" aria-haspopup="menu">⋯</button>
                    <div class="ch-overflow-menu" role="menu">
                        <button class="ch-menu-item btn-toggle-lead-panel" data-action="toggle-lead-panel" role="menuitem">
                            <svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
                            <span>Ocultar painel do lead</span>
                        </button>
                        <button class="ch-menu-item" data-action="resync-conv" data-id="${escHtml(String(conv.id))}" role="menuitem" title="Re-puxa últimas mensagens do WhatsApp (recupera msgs que o polling possa ter perdido)">
                            <svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>
                            <span>Re-sincronizar mensagens</span>
                        </button>
                        ${isAdmin && conv.archived_at ? `
                        <button class="ch-menu-item btn-restore-conv" data-action="restore-conv" data-id="${escHtml(String(conv.id))}" role="menuitem">
                            <svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>
                            <span>Restaurar conversa</span>
                            <span class="badge-admin">ADM</span>
                        </button>` : ''}
                    </div>
                </div>
            </div>
        </header>
        <div class="messages-wrap" id="messages-wrap">
            <div class="empty-state" style="padding:40px 0"><span>Carregando mensagens...</span></div>
        </div>
        <div class="chat-input-tabs">
            <button class="chat-input-tab active" data-action="chat-tab" data-tab="message">Mensagem</button>
            <button class="chat-input-tab" data-action="chat-tab" data-tab="notes">Anotacoes internas</button>
        </div>
        <div class="chat-input-wrap" id="chat-tab-message">
            <div class="chat-input-toolbar">
                <div class="scripts-dropdown" id="scripts-dropdown">
                    <button class="scripts-trigger" data-action="toggle-scripts-menu">📋 Scripts ▾</button>
                    <div class="scripts-menu" id="scripts-menu"></div>
                </div>
            </div>
            <div class="chat-attach-preview" id="attach-preview" style="display:none">
                <div class="attach-preview-content" id="attach-preview-content"></div>
                <button class="attach-remove-btn" data-action="remove-attachment" title="Remover">✕</button>
            </div>
            <div class="chat-input-row">
                <button class="attach-btn" data-action="attach-file" title="Anexar arquivo">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
                    </svg>
                </button>
                <textarea class="chat-textarea" id="chat-input" placeholder="Digite sua mensagem..." rows="1"
                    onkeydown="handleInputKey(event)"></textarea>
                <button class="send-btn" data-action="send-msg">▶</button>
                <input type="file" id="file-input" accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx" style="display:none">
            </div>
        </div>
        <div class="chat-notes-area" id="chat-tab-notes">
            <textarea class="chat-notes-textarea" id="chat-notes-input" placeholder="Escreva uma anotacao interna sobre esta conversa..."></textarea>
            <div class="chat-notes-actions">
                <button class="btn-sm btn-primary" data-action="save-note">Salvar anotacao</button>
            </div>
        </div>
    `;

    loadScriptsForMenu();
    autoResizeTextarea(document.getElementById('chat-input'));
    setupFileAttachment();
}

let _lastMessagesHash = '';

async function loadMessages(convId, chatId) {
    try {
        const data = await apiFetch(`/api/messages/${convId}`);
        const msgs = data.messages || [];
        const wrap = document.getElementById('messages-wrap');
        if (!wrap) return;

        // Hash check — evita re-render se nada mudou (elimina flicker do polling)
        const newHash = msgs.map(m => `${m.id}:${m.created_at}`).join('|');
        if (newHash === _lastMessagesHash) return;
        _lastMessagesHash = newHash;

        if (msgs.length === 0) {
            wrap.textContent = '';
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            empty.textContent = 'Nenhuma mensagem ainda';
            wrap.appendChild(empty);
            return;
        }

        // Deduplica: se bot e atendente enviaram msg com mesmo conteúdo (polling salva duplicata),
        // mantém apenas a versão bot para evitar bolha duplicada
        const deduped = [];
        const botContents = new Set();
        for (const m of msgs) {
            if (m.sender_type === 'bot' && m.content) {
                botContents.add(m.content.trim());
            }
        }
        for (const m of msgs) {
            // Pula mensagem outbound/human que é duplicata de uma mensagem bot
            if (m.sender_type !== 'bot' && m.direction === 'outbound' && m.content && botContents.has(m.content.trim())) {
                continue;
            }
            deduped.push(m);
        }

        wrap.innerHTML = deduped.map(renderMessage).join('');
        wrap.scrollTop = wrap.scrollHeight;
    } catch (err) {
        console.error('Messages error:', err);
    }
}

function renderMessage(msg) {
    // SPEC v2 §3 — 5 tipos: inbound, outbound, bot, note, system
    const isSystem = msg.sender_type === 'system';
    const isBot    = msg.sender_type === 'bot';
    const isNote   = msg.sender_type === 'note';
    const isOut    = msg.direction === 'outbound';
    const cls      = isSystem ? 'system'
                   : isNote   ? 'note'
                   : isBot    ? 'bot'
                   : isOut    ? 'outbound'
                              : 'inbound';
    const time     = formatTime(msg.created_at);

    // Nome do remetente — preenche apenas pra in/out/bot/note (system não tem)
    let sender = '';
    if (isNote) {
        sender = msg.sent_by_name || msg.sender_name || 'Nota interna';
    } else if (isBot) {
        sender = '🤖 Bot';
    } else if (isOut) {
        sender = msg.sent_by_name || msg.sender_name || 'Equipe';
    } else if (!isSystem) {
        // inbound — autor é o lead (preenchido pelo conversation lead)
        sender = msg.sender_name || (currentConversation?.leads?.name) || '';
    }

    // Type label da coluna esquerda (SPEC §3)
    const typeLabels = { inbound: 'Lead', outbound: 'Atendente', bot: 'Bot', note: 'Nota interna' };
    const typeLabel = typeLabels[cls] || '';

    // Renderiza attachments (imagens, vídeos, documentos).
    // Espelha o approach do v3: usa msg.unipile_message_id + att.id direto
    // pra montar /api/attachments/:msgId/:attId. Detecta imagem por
    // att.type ('image'/'img'/'sticker') OU mime_type 'image/...'.
    let attachmentsHtml = '';
    const atts = msg.attachments || [];
    for (const att of atts) {
        const t = String(att.type || '').toLowerCase();
        const mime = (att.mime_type || att.mimetype || '').toLowerCase();
        const isImg = t === 'image' || t === 'img' || t.includes('sticker') || mime.startsWith('image/');
        const isVideo = t === 'video' || mime.startsWith('video/');
        const isAudio = t === 'audio' || mime.startsWith('audio/');
        const isSticker = !!att.sticker || t.includes('sticker') || mime === 'image/webp';
        const name = att.name || att.filename || (isSticker ? 'Sticker' : isImg ? 'Imagem' : 'arquivo');

        // Proxy URL: precisa do unipile_message_id da msg + att.id.
        let proxyUrl = '';
        if (msg.unipile_message_id && att.id) {
            proxyUrl = `/api/attachments/${encodeURIComponent(msg.unipile_message_id)}/${encodeURIComponent(att.id)}`;
        } else if ((att.uri || '').startsWith('http')) {
            proxyUrl = att.uri;
        }

        // Fallback: se attachment não tem URL renderizável (msg antiga sem
        // unipile_message_id, ou Unipile não enviou att.id), mostra placeholder
        // pra usuário saber que tinha mídia ali. Antes renderizava bubble
        // vazio (silent fail) — pior UX.
        if (!proxyUrl) {
            const icon = isSticker ? '🎟️' : isVideo ? '🎬' : isAudio ? '🎵' : isImg ? '🖼️' : '📎';
            const label = isSticker ? 'Sticker' : (name || 'Mídia');
            attachmentsHtml += `<div class="msg-attachment msg-file msg-unavailable" title="Mídia indisponível (sem URL)">
                <span style="opacity:0.6">${icon} ${escHtml(label)}</span>
            </div>`;
            continue;
        }

        if (isImg) {
            const styleAttr = isSticker ? ' style="max-width:140px;max-height:140px;background:transparent"' : '';
            attachmentsHtml += `<div class="msg-attachment msg-image${isSticker ? ' msg-sticker' : ''}">
                <img src="${proxyUrl}" alt="${escHtml(name)}" loading="lazy"${styleAttr} onclick="window.open(this.src,'_blank')">
            </div>`;
        } else if (isVideo) {
            attachmentsHtml += `<div class="msg-attachment msg-video">
                <video src="${proxyUrl}" controls preload="metadata" style="max-width:100%;border-radius:8px;"></video>
            </div>`;
        } else if (isAudio) {
            attachmentsHtml += `<div class="msg-attachment msg-audio">
                <audio src="${proxyUrl}" controls preload="metadata" style="width:100%;"></audio>
            </div>`;
        } else {
            attachmentsHtml += `<div class="msg-attachment msg-file">
                <a href="${proxyUrl}" target="_blank" rel="noopener" class="file-link">📎 ${escHtml(name)}</a>
            </div>`;
        }
    }

    // Conteúdo de texto com links clicáveis. Esconde o placeholder do Unipile
    // ("-- Unipile cannot display ... --") quando temos attachment renderizado.
    const isUnipilePlaceholder = msg.content && /Unipile cannot display/i.test(msg.content);
    const showText = msg.content && !isUnipilePlaceholder;
    // Resolve placeholders {{<id>@lid}} / {{<id>@s.whatsapp.net}} que o Unipile
    // mete literal em mensagens de evento (reações). Em DM 1-1 só há 1 attendee
    // não-self, então o sender resolvido (acima) ou o lead da conversa cobrem
    // 100% dos casos. Em grupos esse renderMessage não é usado (rota separada).
    const resolvedContent = showText
        ? resolveLidPlaceholders(msg.content, sender || currentConversation?.leads?.name)
        : '';
    const textContent = showText ? linkify(escHtml(resolvedContent)) : (atts.length ? '' : '(mídia)');

    // Status de entrega — só faz sentido em msgs outbound (humano ou bot).
    // ghost_chat = msg ficou presa em chat fantasma (nro WhatsApp na variante errada);
    // pode ter sido re-enviada na alternativa (1ª msg) ou ficou órfã (msgs subsequentes).
    let deliveryHtml = '';
    const isGhost = isOut && msg.failed_reason === 'ghost_chat';
    if (isOut && !isNote) {
        const seen = !!msg.seen;
        const delivered = !!msg.delivered;
        let icon, label, klass;
        if (isGhost)         { icon = '⚠'; label = 'Não entregue (chat fantasma) — variante errada do número'; klass = 'msg-check ghost'; }
        else if (seen)       { icon = '✓✓'; label = 'Lido';      klass = 'msg-check read'; }
        else if (delivered)  { icon = '✓✓'; label = 'Entregue';  klass = 'msg-check delivered'; }
        else                 { icon = '✓';  label = 'Enviado';   klass = 'msg-check sent'; }
        deliveryHtml = `<span class="${klass}" title="${label}">${icon}</span>`;
    }

    // System messages: linha centralizada simples (SPEC §3)
    if (isSystem) {
        return `<div class="msg-bubble msg-row msg-system system">${textContent}</div>`;
    }

    // Demais tipos: grid 88px meta + 1fr content + auto status (SPEC §3)
    const ghostClass = isGhost ? ' msg-ghost-chat' : '';
    return `<div class="msg-bubble msg-row msg-${cls} ${cls}${ghostClass}">
        <div class="msg-meta">
            ${typeLabel ? `<div class="msg-type">${typeLabel}</div>` : ''}
            ${sender ? `<div class="msg-author" title="${escHtml(sender)}">${escHtml(sender)}</div>` : ''}
        </div>
        <div class="msg-content">
            ${attachmentsHtml}
            ${textContent ? `<div class="msg-text">${textContent}</div>` : ''}
            ${isGhost ? '<div class="msg-ghost-note" title="Não chegou ao destinatário — variante do número estava errada">⚠ Não entregue (chat fantasma)</div>' : ''}
        </div>
        <div class="msg-status-col">
            <span class="msg-time">${time}</span>
            ${deliveryHtml}
        </div>
    </div>`;
}

function linkify(text) {
    // Converte URLs em links clicáveis (já recebe HTML escaped)
    return text.replace(
        /https?:\/\/[^\s&lt;&quot;]+/g,
        url => {
            // Desescapa para obter a URL real
            const realUrl = url.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
            const display = realUrl.length > 50 ? realUrl.substring(0, 47) + '...' : realUrl;
            return `<a href="${realUrl}" target="_blank" rel="noopener" class="msg-link">${display}</a>`;
        }
    );
}

/**
 * Substitui placeholders `{{<id>@lid}}` ou `{{<id>@s.whatsapp.net}}` que o
 * Unipile mete literal no `text` de mensagens de evento (reactions, system
 * messages). Esses ids são WhatsApp Linked Identifiers (LID) ou JIDs que só o
 * dono dos contatos consegue resolver — Unipile entrega cru e cabe à UI usar
 * o nome que já temos do attendee da conversa (em DM, é o lead).
 *
 * Em grupos esse renderMessage não é usado (há rota separada com
 * group_participants), por isso o fallback simples (1 nome) é suficiente.
 */
function resolveLidPlaceholders(text, fallbackName) {
    if (!text || !fallbackName) return text;
    return text.replace(/\{\{[^{}]*?@(?:lid|s\.whatsapp\.net)\}\}/g, fallbackName);
}

// --- File Attachment ---
let _pendingFile = null;

function setupFileAttachment() {
    const fileInput = document.getElementById('file-input');
    if (!fileInput) return;

    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (!file) return;
        if (file.size > 16 * 1024 * 1024) {
            toast('Arquivo muito grande (máx 16MB)', 'error');
            fileInput.value = '';
            return;
        }
        _pendingFile = file;
        showAttachPreview(file);
    });

    const chatInput = document.getElementById('chat-input');
    if (chatInput && !chatInput.dataset.pasteBound) {
        chatInput.dataset.pasteBound = '1';
        chatInput.addEventListener('paste', (e) => {
            const items = e.clipboardData?.items;
            if (!items) return;
            for (const item of items) {
                if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
                const blob = item.getAsFile();
                if (!blob) continue;
                e.preventDefault();
                if (blob.size > 16 * 1024 * 1024) {
                    toast('Imagem muito grande (máx 16MB)', 'error');
                    return;
                }
                const ext = (blob.type.split('/')[1] || 'png').split(';')[0];
                const file = new File([blob], `pasted-${Date.now()}.${ext}`, { type: blob.type });
                _pendingFile = file;
                showAttachPreview(file);
                toast('Imagem colada — pressione Enviar', 'success');
                return;
            }
        });
    }
}

function showAttachPreview(file) {
    const preview = document.getElementById('attach-preview');
    const content = document.getElementById('attach-preview-content');
    if (!preview || !content) return;

    const mime = file.type || '';
    const sizeMB = (file.size / 1024 / 1024).toFixed(1);

    if (mime.startsWith('image/')) {
        const url = URL.createObjectURL(file);
        content.innerHTML = `<img src="${url}" class="attach-thumb"><span class="attach-name">${escHtml(file.name)} (${sizeMB}MB)</span>`;
    } else if (mime.startsWith('video/')) {
        content.innerHTML = `<span class="attach-icon">🎬</span><span class="attach-name">${escHtml(file.name)} (${sizeMB}MB)</span>`;
    } else if (mime.startsWith('audio/')) {
        content.innerHTML = `<span class="attach-icon">🎵</span><span class="attach-name">${escHtml(file.name)} (${sizeMB}MB)</span>`;
    } else {
        content.innerHTML = `<span class="attach-icon">📎</span><span class="attach-name">${escHtml(file.name)} (${sizeMB}MB)</span>`;
    }
    preview.style.display = 'flex';
}

function removeAttachment() {
    _pendingFile = null;
    const preview = document.getElementById('attach-preview');
    const fileInput = document.getElementById('file-input');
    if (preview) preview.style.display = 'none';
    if (fileInput) fileInput.value = '';
}

let _sending = false;
async function sendMsg() {
    if (_sending) return; // lock: evita duplo envio (Enter + clique)
    const input = document.getElementById('chat-input');
    const text  = (input?.value || '').trim();
    if (!text && !_pendingFile) return;
    if (!currentConversation) return;

    const chatId = currentConversation.whatsapp_chat_id || null;
    _sending = true;
    const sendBtn = document.querySelector('[data-action="send-msg"]');
    if (sendBtn) sendBtn.disabled = true;

    // Snapshot do file e limpa imediatamente: o upload vai usar a referência
    // local (fileToSend), e qualquer Enter/clique extra cai no lock acima.
    const fileToSend = _pendingFile;
    _pendingFile = null;
    if (fileToSend) removeAttachment();

    input.value = '';
    input.style.height = '';

    try {
        let res;

        if (fileToSend) {
            // Envia com mídia via FormData
            const fd = new FormData();
            fd.append('file', fileToSend);
            if (text) fd.append('text', text);
            if (chatId) fd.append('chatId', chatId);

            const response = await fetch(`/api/messages/${currentConversation.id}/send-media`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${getToken()}` },
                body: fd,
            });
            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error || 'Erro ao enviar mídia');
            }
            res = await response.json();
        } else {
            // Envio de texto normal
            res = await apiFetch(`/api/messages/${currentConversation.id}/send`, {
                method: 'POST', body: JSON.stringify({ text, chatId }),
            });
        }

        // Se o chat foi iniciado agora, atualiza o chatId na conversa local
        if (res.chat_started && !currentConversation.whatsapp_chat_id) {
            await loadInbox();
            currentConversation = allConversations.find(c => c.id === currentConversation.id) || currentConversation;
        }

        _lastMessagesHash = ''; // Força reload das mensagens
        await loadMessages(currentConversation.id);
    } catch (err) {
        // Backend envia error_code estruturado pra erros conhecidos do envio.
        // err.message já vem amigável pt-BR pelos casos mapeados em
        // mapSendError() (ex: invalid_recipient). Pra erros desconhecidos
        // cai no fallback genérico.
        if (err.code === 'invalid_recipient') {
            toast(err.message, 'error', 8000);
        } else if (err.code === 'unipile_error') {
            const detail = err.body?.unipile_detail ? `: ${err.body.unipile_detail}` : '';
            toast(`Falha no WhatsApp${detail}. Tente novamente em alguns minutos.`, 'error', 6000);
        } else {
            toast(`Erro ao enviar: ${err.message}`, 'error');
        }
        // Recarrega mensagens — failed_reason gravado pelo backend aparece
        // como msg falha no histórico (UI futura pode renderizar diferente).
        _lastMessagesHash = '';
        await loadMessages(currentConversation.id).catch(() => {});
    } finally {
        _sending = false;
        if (sendBtn) sendBtn.disabled = false;
    }
}

function handleInputKey(e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        sendMsg();
    }
}

function autoResizeTextarea(el) {
    if (!el) return;
    el.addEventListener('input', () => {
        el.style.height = '';
        el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    });
}

// --- Scripts Menu ---

async function loadScriptsForMenu() {
    try {
        const data = await apiFetch('/api/scripts');
        allScripts = data.scripts || [];
        renderScriptsMenu();
    } catch { /* silencioso */ }
}

function renderScriptsMenu() {
    const menu = document.getElementById('scripts-menu');
    if (!menu) return;

    if (allScripts.length === 0) {
        menu.innerHTML = `<div style="padding:12px;text-align:center;color:var(--text-muted);font-size:12px">Nenhum script</div>`;
        return;
    }

    menu.innerHTML = allScripts.map(s => `
        <div class="scripts-menu-item" data-action="apply-script" data-id="${s.id}">
            <div class="script-item-title">${escHtml(s.title)}</div>
            <div class="script-item-preview">${escHtml(truncate(s.content, 60))}</div>
        </div>
    `).join('');
}

function toggleScriptsMenu() {
    document.getElementById('scripts-menu')?.classList.toggle('open');
}

document.addEventListener('click', e => {
    if (!e.target.closest('.scripts-dropdown')) {
        document.getElementById('scripts-menu')?.classList.remove('open');
    }
});

/**
 * Insere o script no textarea de mensagem (sem enviar).
 * Substitui variáveis: {{first_name}}, {{nome}}, {{org_name}}, {{empresa}}
 * — case-insensitive, espaços tolerados.
 * Usuário revisa o conteúdo e clica enviar manualmente.
 */
function applyScript(scriptId) {
    const script = allScripts.find(s => s.id === scriptId);
    if (!script || !currentConversation) return;

    document.getElementById('scripts-menu')?.classList.remove('open');

    // Garante que está na aba "Mensagem" (não em "Anotações internas")
    if (typeof switchChatTab === 'function') switchChatTab('message');

    // Substitui variáveis a partir do lead da conversa
    const lead = currentConversation.leads || {};
    const fullName  = (lead.name || '').trim();
    const firstName = fullName.split(/\s+/)[0] || '';
    const orgName   = (lead.company_name || '').trim();

    const filled = (script.content || '')
        .replace(/\{\{\s*first[_\s-]?name\s*\}\}/gi, firstName)
        .replace(/\{\{\s*nome\s*\}\}/gi,            firstName)
        .replace(/\{\{\s*primeiro[_\s-]?nome\s*\}\}/gi, firstName)
        .replace(/\{\{\s*org[_\s-]?name\s*\}\}/gi,  orgName)
        .replace(/\{\{\s*organizacao\s*\}\}/gi,     orgName)
        .replace(/\{\{\s*empresa\s*\}\}/gi,         orgName);

    const input = document.getElementById('chat-input');
    if (!input) return;
    input.value = filled;
    input.focus();
    // Move cursor pro fim
    input.setSelectionRange(filled.length, filled.length);
    // Re-dispara auto-resize do textarea (existe em outras partes do código)
    if (typeof autoResizeTextarea === 'function') autoResizeTextarea(input);
    input.dispatchEvent(new Event('input'));

    // Avisa caso alguma variável não tenha sido substituída
    const missing = [];
    if (filled.match(/\{\{\s*first[_\s-]?name\s*\}\}|\{\{\s*nome\s*\}\}|\{\{\s*primeiro[_\s-]?nome\s*\}\}/gi)) missing.push('primeiro nome');
    if (filled.match(/\{\{\s*org[_\s-]?name\s*\}\}|\{\{\s*empresa\s*\}\}|\{\{\s*organizacao\s*\}\}/gi)) missing.push('empresa');
    if (missing.length > 0) {
        toast(`Script "${script.title}" inserido. Faltou: ${missing.join(', ')}.`, 'warning');
    } else {
        toast(`Script "${script.title}" inserido. Revise e envie.`, 'info');
    }
}

// --- Lead Panel ---

function renderLeadPanel(conv) {
    const lead = conv.leads || {};
    const name = lead.name || formatPhone(lead.phone) || 'Desconhecido';
    const initial = name.charAt(0).toUpperCase();

    // Mostra o content, esconde o empty
    const emptyEl = document.getElementById('lead-panel-empty');
    const contentEl = document.getElementById('lead-panel-content');
    if (emptyEl) emptyEl.style.display = 'none';
    if (contentEl) contentEl.style.display = 'flex';

    // Preenche info do lead
    const avatarEl = document.getElementById('lp-avatar');
    if (avatarEl) avatarEl.textContent = initial;
    const nameEl = document.getElementById('lp-name');
    if (nameEl) nameEl.textContent = name;
    const phoneEl = document.getElementById('lp-phone');
    if (phoneEl) phoneEl.textContent = formatPhone(lead.phone);
    const compEl = document.getElementById('lp-company');
    if (compEl) {
        compEl.textContent = lead.company_name || '';
        compEl.style.display = lead.company_name ? '' : 'none';
    }
    const jobEl = document.getElementById('lp-job-title');
    if (jobEl) {
        jobEl.textContent = lead.job_title || 'Adicionar cargo';
        jobEl.classList.toggle('lp-muted', !lead.job_title);
    }

    // Badge de tipo — clicável para Admin (alterna inbound/prospecting)
    const typeBadge = document.getElementById('lp-type-badge');
    if (typeBadge) {
        const typeLabels = { inbound: 'Inbound', prospecting: 'Prospeccao' };
        const cType = conv.type || 'inbound';
        typeBadge.textContent = typeLabels[cType] || cType;
        typeBadge.className = `conv-type-badge ${cType}`;

        if (currentUser?.role === 'Admin') {
            typeBadge.classList.add('clickable');
            typeBadge.title = 'Clique para alterar tipo';
            typeBadge.onclick = async () => {
                const newType = cType === 'inbound' ? 'prospecting' : 'inbound';
                await apiFetch(`/api/inbox/${conv.id}/type`, {
                    method: 'PATCH',
                    body: JSON.stringify({ type: newType }),
                });
                conv.type = newType;
                renderLeadPanel(conv);
                loadInbox();
                toast(`Tipo alterado para ${typeLabels[newType]}`, 'success');
            };
        } else {
            typeBadge.classList.remove('clickable');
            typeBadge.onclick = null;
            typeBadge.title = '';
        }
    }

    // Busca TODOS os deals vinculados ao telefone no Pipedrive
    selectedDealId = null;
    loadDealsForLead(lead, conv);

    // Atividades ficam escondidas até um deal ser selecionado
    const actSection = document.getElementById('lp-activities-section');
    if (actSection) actSection.style.display = 'none';

    // Botao criar deal
    const btnCreateDeal = document.getElementById('btn-create-deal-lp');
    if (btnCreateDeal) {
        btnCreateDeal.onclick = () => syncLeadPanelPipedrive(lead.id, conv.id);
    }

    // Botao vincular a deal existente
    const btnLinkDeal = document.getElementById('btn-link-deal-lp');
    if (btnLinkDeal) {
        btnLinkDeal.onclick = () => toggleLinkDealSearch(lead.id);
    }

    // Botao sync Pipedrive
    const btnSync = document.getElementById('btn-sync-pipedrive-lp');
    if (btnSync) {
        btnSync.onclick = () => syncLeadPanelPipedrive(lead.id, conv.id);
    }

    // --- Populate new sections ---
    // Sobre a conversa
    const convIdEl = document.getElementById('lp-conv-id');
    if (convIdEl) convIdEl.textContent = conv.id?.substring(0, 8) || '—';
    const convStatusEl = document.getElementById('lp-conv-status');
    if (convStatusEl) {
        const statusMap = { waiting: 'Aguardando', in_progress: 'Em andamento', routed: 'Roteado', closed: 'Fechado' };
        convStatusEl.textContent = statusMap[conv.status] || conv.status || '—';
    }
    const convOriginEl = document.getElementById('lp-conv-origin');
    if (convOriginEl) {
        const originMap = { form: 'Formulario', whatsapp_direct: 'WhatsApp Direto', prospecting: 'Prospeccao' };
        convOriginEl.textContent = originMap[lead.origin] || lead.origin || '—';
    }
    const convAssignedEl = document.getElementById('lp-conv-assigned');
    if (convAssignedEl) convAssignedEl.textContent = conv.assigned_to || 'Nao atribuido';
    const convCreatedEl = document.getElementById('lp-conv-created');
    if (convCreatedEl) convCreatedEl.textContent = conv.created_at ? formatDate(conv.created_at) : '—';

    // Tags
    const tagsEl = document.getElementById('lp-tags');
    if (tagsEl) {
        const tags = [];
        if (lead.classification) tags.push(`<span class="lp-tag tag-${lead.classification}">${classLabel(lead.classification)}</span>`);
        if (conv.type) tags.push(`<span class="lp-tag tag-${conv.type === 'prospecting' ? 'wa' : 'form'}">${conv.type === 'prospecting' ? 'Prospeccao' : 'Inbound'}</span>`);
        if (conv.status === 'waiting') tags.push('<span class="lp-tag tag-waiting">Aguardando</span>');
        tagsEl.innerHTML = tags.length ? tags.join('') : '<span class="lp-muted">Sem tags</span>';
    }

    // Edição inline de contato
    setupInlineEdit(lead, conv);

    // Historico de conversas do lead
    renderLeadHistory(lead.id, conv.id);

    // Eventos da conversa
    renderConvEvents();

    renderScriptsPanelList();
}

// --- Inline Edit de contato ---
function setupInlineEdit(lead, conv) {
    document.querySelectorAll('.lp-edit-btn').forEach(btn => {
        btn.onclick = () => {
            const field = btn.dataset.field;
            const wrap = btn.parentElement;
            const span = wrap.querySelector('span');
            const currentVal = field === 'phone'        ? (lead.phone || '') :
                               field === 'name'         ? (lead.name || '') :
                               field === 'job_title'    ? (lead.job_title || '') :
                               (lead.company_name || '');

            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'lp-inline-input';
            input.value = currentVal;
            if (field === 'phone') input.placeholder = '31971335127';
            if (field === 'name') input.placeholder = 'Nome do contato';
            if (field === 'company_name') input.placeholder = 'Empresa';
            if (field === 'job_title') input.placeholder = 'Cargo (ex: CMO)';

            span.style.display = 'none';
            btn.style.display = 'none';
            wrap.insertBefore(input, btn);
            input.focus();
            input.select();

            let _saving = false;
            const save = async () => {
                if (_saving) return;
                _saving = true;
                const newVal = input.value.trim();
                if (newVal && newVal !== currentVal) {
                    try {
                        await apiFetch(`/api/leads/${lead.id}`, {
                            method: 'PUT',
                            body: JSON.stringify({ [field]: newVal }),
                        });
                        lead[field] = newVal;
                        toast('Contato atualizado', 'success');
                        renderLeadPanel(conv);
                        loadInbox();
                    } catch (err) {
                        toast('Erro: ' + err.message, 'error');
                        _saving = false;
                    }
                }
                cancel();
            };

            const cancel = () => {
                if (input.parentElement) input.remove();
                span.style.display = '';
                btn.style.display = '';
            };

            input.addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); save(); }
                if (e.key === 'Escape') cancel();
            });
            // Blur: save only after small delay (avoid saving partial value on accidental click)
            input.addEventListener('blur', () => setTimeout(() => { if (!_saving) save(); }, 200));
        };
    });
}

// --- Lead History (other conversations of the same lead) ---
async function renderLeadHistory(leadId, currentConvId) {
    const el = document.getElementById('lp-history-list');
    if (!el || !leadId) return;
    const otherConvs = allConversations.filter(c => c.lead_id === leadId && c.id !== currentConvId);
    if (otherConvs.length === 0) {
        el.innerHTML = '<span class="lp-muted">Nenhuma conversa anterior</span>';
        return;
    }
    el.innerHTML = otherConvs.map(c => {
        const statusMap = { waiting: 'Aguardando', in_progress: 'Andamento', routed: 'Roteado', closed: 'Fechado' };
        return `<div class="lp-history-item" data-action="select-conversation" data-id="${c.id}">
            <span>${formatDate(c.created_at)}</span>
            <span class="lp-history-status tag-${c.status === 'waiting' ? 'waiting' : 'form'}">${statusMap[c.status] || c.status}</span>
        </div>`;
    }).join('');
}

// --- Conversation Events Timeline ---
function renderConvEvents() {
    const el = document.getElementById('lp-events-list');
    if (!el || !currentConversation) return;
    const conv = currentConversation;
    const events = [];

    // Created
    if (conv.created_at) events.push({ text: 'Conversa criada', time: conv.created_at });
    // Routed
    if (conv.assigned_to) events.push({ text: `Atribuida a ${conv.assigned_to}`, time: conv.updated_at || conv.created_at });

    events.sort((a, b) => new Date(b.time) - new Date(a.time));

    if (events.length === 0) {
        el.innerHTML = '<span class="lp-muted">Nenhum evento registrado</span>';
        return;
    }
    el.innerHTML = events.map(ev => `
        <div class="lp-event">
            <div class="lp-event-dot"></div>
            <div>
                <div>${escHtml(ev.text)}</div>
                <div class="lp-event-time">${formatDate(ev.time)}</div>
            </div>
        </div>
    `).join('');
}

// --- Vincular lead a deal existente (search manual) ---
let _linkDealSearchTimer = null;
function toggleLinkDealSearch(leadId) {
    const box = document.getElementById('lp-link-deal-search');
    if (!box) return;
    const isOpen = box.style.display !== 'none';
    box.style.display = isOpen ? 'none' : 'block';
    if (isOpen) return;

    const input = document.getElementById('lp-link-deal-input');
    const results = document.getElementById('lp-link-deal-results');
    if (input) {
        input.value = '';
        input.focus();
        input.oninput = () => {
            clearTimeout(_linkDealSearchTimer);
            const q = input.value.trim();
            if (q.length < 2) {
                if (results) results.innerHTML = '';
                return;
            }
            _linkDealSearchTimer = setTimeout(() => runLinkDealSearch(q, leadId), 300);
        };
    }
}

async function runLinkDealSearch(q, leadId) {
    const results = document.getElementById('lp-link-deal-results');
    if (!results) return;
    results.innerHTML = '<div class="lp-muted" style="font-size:12px;padding:8px">Buscando...</div>';
    try {
        const data = await apiFetch(`/api/pipedrive/search-deals?q=${encodeURIComponent(q)}`);
        const deals = data?.deals || [];
        if (deals.length === 0) {
            results.innerHTML = '<div class="lp-muted" style="font-size:12px;padding:8px">Nenhum deal encontrado</div>';
            return;
        }
        results.innerHTML = deals.map(d => `
            <div class="link-deal-result" data-deal-id="${d.id}" style="padding:10px;border:1px solid var(--border);border-radius:8px;cursor:pointer;transition:border-color .15s">
                <div style="font-weight:600;font-size:13px;color:var(--text-primary)">${escHtml(d.title)}</div>
                <div style="font-size:11px;color:var(--text-muted);margin-top:2px">
                    ${escHtml(d.org_name)} · ${escHtml(d.person_name)}
                    · <span style="color:${d.status === 'won' ? 'var(--green)' : d.status === 'lost' ? 'var(--red)' : 'var(--accent)'}">${escHtml(d.status_label)}</span>
                </div>
                <div style="font-size:11px;color:var(--text-muted)">#${d.id} · ${escHtml(d.stage_name)} · ${escHtml(d.value)}</div>
            </div>
        `).join('');
        results.querySelectorAll('.link-deal-result').forEach(el => {
            el.addEventListener('click', () => linkLeadToDeal(leadId, el.dataset.dealId));
        });
    } catch (err) {
        results.innerHTML = `<div style="color:var(--red);font-size:12px;padding:8px">Erro: ${escHtml(err.message)}</div>`;
    }
}

async function linkLeadToDeal(leadId, dealId) {
    if (!confirm(`Vincular esta conversa ao Deal #${dealId}?`)) return;
    try {
        await apiFetch(`/api/leads/${leadId}/link-to-deal`, {
            method: 'POST',
            body: JSON.stringify({ deal_id: parseInt(dealId) }),
        });
        toast(`✓ Conversa vinculada ao Deal #${dealId}`, 'success');
        // Recarrega o painel lateral
        if (currentConversation) renderLeadPanel(currentConversation);
    } catch (err) {
        toast(`Falha: ${err.message}`, 'error');
    }
}

async function syncLeadPanelPipedrive(leadId, convId) {
    try {
        await apiFetch(`/api/leads/${leadId}/sync-crm`, { method: 'POST' });
        toast('Lead sincronizado com Pipedrive!', 'success');
        await loadInbox();
        const refreshed = allConversations.find(c => c.id === convId);
        if (refreshed) renderLeadPanel(refreshed);
    } catch (err) {
        toast(`Erro: ${err.message}`, 'error');
    }
}

async function loadDealsForLead(lead, conv) {
    const loading  = document.getElementById('lp-deal-loading');
    const picker   = document.getElementById('lp-deal-picker');
    const notfound = document.getElementById('lp-deal-notfound');
    const listEl   = document.getElementById('lp-deal-list');

    const hintEl = document.getElementById('lp-deal-hint');

    if (loading) loading.style.display   = '';
    if (picker) picker.style.display     = 'none';
    if (notfound) notfound.style.display = 'none';
    if (hintEl) hintEl.style.display     = '';

    try {
        const data = await apiFetch(`/api/leads/${lead.id}/deals`);
        const deals = data?.deals || [];
        const persons = data?.persons || [];
        const labelOptions = data?.label_options || [];

        // Renderiza labels do person (primeiro person encontrado)
        renderPersonLabels(lead, persons, labelOptions);

        // Cargo: se Pipedrive tem job_title, ele é a fonte da verdade.
        // Atualiza display e persiste no lead se mudou.
        const pdJobTitle = persons.find(p => p.job_title)?.job_title || null;
        if (pdJobTitle) {
            const jobEl = document.getElementById('lp-job-title');
            if (jobEl) {
                jobEl.textContent = pdJobTitle;
                jobEl.classList.remove('lp-muted');
            }
            if (pdJobTitle !== lead.job_title) {
                lead.job_title = pdJobTitle;
                apiFetch(`/api/leads/${lead.id}`, {
                    method: 'PUT',
                    body: JSON.stringify({ job_title: pdJobTitle }),
                }).catch(() => { /* não bloqueia UI */ });
            }
        }

        if (deals.length === 0) {
            if (notfound) notfound.style.display = '';
            return;
        }

        // Auto-cache: ao abrir a conversa, mesmo sem o user clicar em
        // nenhum deal, salva o org_name pra preencher conv-list.company.
        // Prioriza o deal que bate com lead.crm_deal_id; senão o 1º.
        try {
            if (lead?.id) {
                const matchedDeal = lead.crm_deal_id
                    ? deals.find(d => String(d.id) === String(lead.crm_deal_id))
                    : null;
                const orgFromDeal = (matchedDeal || deals[0])?.org_name || '';
                if (orgFromDeal) {
                    localStorage.setItem(`atd:org:${lead.id}`, orgFromDeal);
                }
            }
        } catch (_) {}

        // Renderiza lista de deals como cards clicáveis
        if (listEl) {
            listEl.innerHTML = deals.map(d => {
                const statusBadge = d.status === 'won' ? 'deal-won'
                    : d.status === 'lost' ? 'deal-lost' : 'deal-open';
                return `
                    <div class="deal-picker-item" data-deal-id="${d.id}" data-deal-title="${escHtml(d.title)}" data-deal-org="${escHtml(d.org_name || '')}">
                        <div class="deal-picker-radio"></div>
                        <div class="deal-picker-info">
                            <div class="deal-picker-title">${escHtml(d.title)}</div>
                            <div class="deal-picker-meta">
                                <span class="deal-stage-badge">${escHtml(d.stage_name)}</span>
                                <span class="deal-status-badge ${statusBadge}">${d.status}</span>
                            </div>
                            ${d.person_name ? `<div class="deal-picker-person">${escHtml(d.person_name)}</div>` : ''}
                        </div>
                        <a href="${d.link}" target="_blank" class="deal-picker-link" title="Ver no Pipedrive" onclick="event.stopPropagation()">↗</a>
                    </div>`;
            }).join('');

            // Event delegation para seleção de deal
            listEl.onclick = (e) => {
                const item = e.target.closest('.deal-picker-item');
                if (!item) return;
                selectDeal(item, lead, conv);
            };
        }

        if (picker) picker.style.display = '';

        // Auto-seleciona em ordem de prioridade:
        // 1. Só tem 1 deal → seleciona ele
        // 2. lead.crm_deal_id (vindo do backend) bate com um deal
        // 3. localStorage[atd:deal:CONV_ID] (escolha anterior do usuário)
        let lastSavedDealId = null;
        try { lastSavedDealId = localStorage.getItem(`atd:deal:${conv.id}`); } catch (_) {}

        if (deals.length === 1) {
            const firstItem = listEl?.querySelector('.deal-picker-item');
            if (firstItem) selectDeal(firstItem, lead, conv);
        } else if (lead.crm_deal_id) {
            const matchItem = listEl?.querySelector(`[data-deal-id="${lead.crm_deal_id}"]`);
            if (matchItem) selectDeal(matchItem, lead, conv);
        } else if (lastSavedDealId) {
            const matchItem = listEl?.querySelector(`[data-deal-id="${lastSavedDealId}"]`);
            if (matchItem) selectDeal(matchItem, lead, conv);
        }
    } catch {
        if (notfound) notfound.style.display = '';
    } finally {
        if (loading) loading.style.display = 'none';
    }
}

function selectDeal(itemEl, lead, conv) {
    selectedDealId = itemEl.dataset.dealId;
    const dealTitle = itemEl.dataset.dealTitle;
    const dealOrg = itemEl.dataset.dealOrg || '';

    // Persistência frontend-only: salva escolha por conv + org por lead.
    // Backend não tem endpoint pra atualizar leads.crm_deal_id após seleção,
    // então uso localStorage pra fingir que persiste — auto-restore no render.
    try {
        if (conv?.id) localStorage.setItem(`atd:deal:${conv.id}`, selectedDealId);
        if (lead?.id && dealOrg) localStorage.setItem(`atd:org:${lead.id}`, dealOrg);
    } catch (_) {}

    const listEl = document.getElementById('lp-deal-list');
    const hintEl = document.getElementById('lp-deal-hint');

    // Colapsa lista — mostra só o deal selecionado em modo compacto
    if (listEl) {
        listEl.innerHTML = `
            <div class="deal-selected-compact">
                <div class="deal-selected-info">
                    <div class="deal-picker-title">${escHtml(dealTitle)}</div>
                    <div class="deal-picker-meta"><span class="deal-stage-badge">#${selectedDealId}</span></div>
                </div>
                <a href="https://brandmonitor.pipedrive.com/deal/${selectedDealId}" target="_blank" class="deal-picker-link" title="Ver no Pipedrive">↗</a>
                <button class="btn-deal-change" id="btn-deal-change" title="Alterar deal">Alterar</button>
            </div>`;

        // Botão "Alterar" recarrega a lista completa
        const btnChange = document.getElementById('btn-deal-change');
        if (btnChange) {
            btnChange.onclick = (e) => {
                e.stopPropagation();
                loadDealsForLead(lead, conv);
            };
        }
    }
    if (hintEl) hintEl.style.display = 'none';

    // Mostra seção de atividades
    const actSection = document.getElementById('lp-activities-section');
    if (actSection) actSection.style.display = '';

    // Esconde "Nenhum deal vinculado"
    const notfound = document.getElementById('lp-deal-notfound');
    if (notfound) notfound.style.display = 'none';

    setupActivityButtons(conv, lead);
}

function setupActivityButtons(conv, lead) {
    const btnNote = document.getElementById('btn-act-note');
    if (btnNote) btnNote.onclick = () => createDealNote(conv, lead);

    // Botões WA BB/FR/VM — criam atividade concluída no Pipedrive com subject tagueado
    document.querySelectorAll('.btn-wa-tag').forEach(btn => {
        btn.onclick = () => createWaTagActivity(conv, btn.dataset.waTag, btn);
    });
}

const WA_TAG_LABELS = { BB: 'Brand Bidding', FR: 'Fraude', VM: 'Violação de Marca' };

async function createWaTagActivity(conv, tag, btnEl) {
    if (!selectedDealId) {
        toast('Selecione um deal primeiro', 'warning');
        return;
    }
    if (!WA_TAG_LABELS[tag]) return;

    const label = WA_TAG_LABELS[tag];
    if (!confirm(`Criar atividade WhatsApp ${label} concluída no Deal #${selectedDealId}?`)) return;

    const originalText = btnEl?.textContent;
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = '⏳'; }
    try {
        const res = await apiFetch(`/api/inbox/${conv.id}/wa-activity`, {
            method: 'POST',
            body: JSON.stringify({ tag, deal_id: selectedDealId }),
        });
        toast(`Atividade WhatsApp ${res.tag_label || label} criada ✓`, 'success');
    } catch (err) {
        toast(`Erro: ${err.message}`, 'error');
    } finally {
        if (btnEl) { btnEl.disabled = false; btnEl.textContent = originalText; }
    }
}

async function createDealNote(conv, lead) {
    if (!selectedDealId) {
        toast('Selecione um deal primeiro', 'warning');
        return;
    }
    const btn = document.getElementById('btn-act-note');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Salvando...'; }
    try {
        await apiFetch(`/api/leads/${lead.id}/notes`, {
            method: 'POST',
            body: JSON.stringify({ conversation_id: conv.id, deal_id: selectedDealId }),
        });
        toast(`Anotação com transcrição salva no Deal #${selectedDealId}!`, 'success');
    } catch (err) {
        toast(`Erro: ${err.message}`, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '📝 Salvar transcrição como anotação'; }
    }
}


// --- Pipedrive Person Labels ---

function renderPersonLabels(lead, persons, labelOptions) {
    const container = document.getElementById('lp-labels-container');
    const section = document.getElementById('lp-labels-section');
    if (!container) return;

    if (!persons || persons.length === 0) {
        container.innerHTML = '<span class="lp-muted">Número não encontrado no Pipedrive</span>';
        return;
    }

    // Usa o primeiro person (mais relevante)
    const person = persons[0];
    const currentLabelIds = person.label_ids || [];

    const colorMap = { blue: '#3B82F6', red: '#EF4444', yellow: '#EAB308', purple: '#A855F7', 'dark-gray': '#6B7280', green: '#22C55E' };

    container.innerHTML = labelOptions.map(opt => {
        const active = currentLabelIds.includes(opt.id);
        const color = colorMap[opt.color] || '#6B7280';
        return `<button class="pd-label-btn${active ? ' active' : ''}" data-label-id="${opt.id}" data-person-id="${person.id}" style="--label-color: ${color}">
            ${escHtml(opt.label)}
        </button>`;
    }).join('');

    // Click handler — toggle label
    container.onclick = async (e) => {
        const btn = e.target.closest('.pd-label-btn');
        if (!btn) return;

        const labelId = parseInt(btn.dataset.labelId);
        const personId = parseInt(btn.dataset.personId);
        const isActive = btn.classList.contains('active');

        // Toggle
        let newLabelIds;
        if (isActive) {
            newLabelIds = currentLabelIds.filter(id => id !== labelId);
        } else {
            newLabelIds = [...currentLabelIds, labelId];
        }

        btn.classList.toggle('active');
        btn.disabled = true;

        try {
            const res = await apiFetch(`/api/leads/${lead.id}/person-labels`, {
                method: 'PUT',
                body: JSON.stringify({ person_id: personId, label_ids: newLabelIds }),
            });
            // Update local state
            person.label_ids = res.label_ids || newLabelIds;
            currentLabelIds.length = 0;
            currentLabelIds.push(...person.label_ids);
            toast(`Etiqueta ${isActive ? 'removida' : 'adicionada'}`, 'success');
        } catch (err) {
            // Revert toggle on error
            btn.classList.toggle('active');
            toast(`Erro: ${err.message}`, 'error');
        } finally {
            btn.disabled = false;
        }
    };
}

function renderScriptsPanelList() {
    const list = document.getElementById('scripts-panel-list');
    if (!list || allScripts.length === 0) return;

    list.innerHTML = allScripts.slice(0, 6).map(s => `
        <div class="script-panel-item" data-action="apply-script" data-id="${s.id}">
            <div class="script-panel-title">${escHtml(s.title)}</div>
            <div class="script-panel-cat">${catLabel(s.category)}</div>
        </div>
    `).join('');
}

// --- Routing & Closing ---

async function routeConv(convId, team) {
    try {
        await apiFetch('/api/inbox/route', {
            method: 'POST',
            body: JSON.stringify({ conversation_id: convId, to_team: team }),
        });
        toast(`Conversa atribuida ao ${team === 'comercial' ? 'Comercial' : 'OPEC'}`, 'success');
        await loadInbox();
        if (currentConversation?.id === convId) {
            currentConversation.assigned_to = team;
            currentConversation.status = 'routed';
            renderLeadPanel(currentConversation);
        }
    } catch (err) {
        toast(`Erro: ${err.message}`, 'error');
    }
}

async function closeConv(convId) {
    if (!confirm('Encerrar esta conversa?')) return;
    try {
        await apiFetch(`/api/inbox/${convId}/close`, {
            method: 'POST', body: JSON.stringify({ reason: 'Encerrado pelo atendente' }),
        });
        toast('Conversa encerrada', 'info');
        currentConversation = null;
        document.getElementById('chat-area').innerHTML = '<div class="empty-state-pro"><div class="empty-illustration"><svg class="icon"><use href="/icons.svg#icon-inbox"></use></svg></div><h4 class="empty-title">Selecione uma conversa</h4><p class="empty-desc">Escolha uma conversa na lista ao lado</p></div>';
        const lpEmpty = document.getElementById('lead-panel-empty');
        const lpContent = document.getElementById('lead-panel-content');
        if (lpEmpty) lpEmpty.style.display = '';
        if (lpContent) lpContent.style.display = 'none';
        await loadInbox();
    } catch (err) {
        toast(`Erro: ${err.message}`, 'error');
    }
}

// --- LEADS ---

async function loadLeads() {
    const tbody = document.getElementById('leads-tbody');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="8" class="loading-row">Carregando...</td></tr>`;

    try {
        const search = document.getElementById('leads-search')?.value || '';
        const origin = document.getElementById('leads-filter-origin')?.value || '';
        const cls    = document.getElementById('leads-filter-class')?.value || '';

        let qs = `?limit=100`;
        if (search) qs += `&search=${encodeURIComponent(search)}`;
        if (origin) qs += `&origin=${origin}`;
        if (cls)    qs += `&classification=${cls}`;

        const data = await apiFetch(`/api/leads${qs}`);
        const leads = data.leads || [];

        if (leads.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8" class="loading-row">Nenhum lead encontrado</td></tr>`;
            return;
        }

        tbody.innerHTML = leads.map(lead => {
            const hasCrm = !!lead.crm_deal_id;
            const crmCell = hasCrm
                ? `<a href="https://brandmonitor.pipedrive.com/deal/${lead.crm_deal_id}" target="_blank" class="crm-synced">✅ #${lead.crm_deal_id}</a>`
                : `<button class="btn-pipedrive" id="pd-btn-${lead.id}" data-action="sync-lead" data-id="${lead.id}">📤 Pipedrive</button>`;
            return `<tr>
                <td><strong>${escHtml(lead.name || '—')}</strong></td>
                <td>${escHtml(lead.company_name || '—')}</td>
                <td>${escHtml(lead.phone || '—')}</td>
                <td><span class="tag tag-${lead.origin === 'form' ? 'form' : 'wa'}">${originLabel(lead.origin)}</span></td>
                <td><span class="tag tag-${lead.classification || 'unclassified'}">${classLabel(lead.classification)}</span></td>
                <td>${crmCell}</td>
                <td>${formatDate(lead.created_at)}</td>
                <td><button class="btn-sm" data-action="sync-lead" data-id="${lead.id}">↑ Sync</button></td>
            </tr>`;
        }).join('');
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="8" class="loading-row" style="color:var(--red)">Erro: ${err.message}</td></tr>`;
    }
}

// Setup filtros de leads
function setupLeadFilters() {
    const setupLeadFilter = id => {
        const el = document.getElementById(id);
        el?.addEventListener('change', loadLeads);
    };
    const searchEl = document.getElementById('leads-search');
    searchEl?.addEventListener('input', debounce(loadLeads, 400));
    setupLeadFilter('leads-filter-origin');
    setupLeadFilter('leads-filter-class');
}

// --- CSV Export ---
async function exportLeadsCSV() {
    try {
        const data = await apiFetch('/api/leads?limit=5000');
        const leads = data.leads || [];
        if (leads.length === 0) {
            toast('Nenhum lead para exportar', 'info');
            return;
        }

        const headers = ['Nome', 'Empresa', 'Telefone', 'Email', 'Origem', 'Classificacao', 'CRM Deal ID', 'Data Criacao'];
        const rows = leads.map(l => [
            l.name || '',
            l.company_name || '',
            l.phone || '',
            l.email || '',
            l.origin || '',
            l.classification || '',
            l.crm_deal_id || '',
            l.created_at ? new Date(l.created_at).toLocaleDateString('pt-BR') : '',
        ]);

        const csvContent = [headers, ...rows]
            .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
            .join('\n');

        const BOM = '\uFEFF';
        const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `leads-branddi-${new Date().toISOString().slice(0,10)}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast('CSV exportado com sucesso!', 'success');
    } catch (err) {
        toast(`Erro ao exportar: ${err.message}`, 'error');
    }
}

// --- DASHBOARD ---

async function loadDashboard() {
    const days = document.getElementById('dash-period')?.value || 30;
    const userFilter = document.getElementById('dash-user-filter')?.value || '';
    const accountFilter = document.getElementById('dash-account-filter')?.value || '';
    const typeFilter = document.getElementById('dash-type-filter')?.value || '';

    const qs = new URLSearchParams({ days });
    if (userFilter)    qs.set('user_id', userFilter);
    if (accountFilter) qs.set('account_id', accountFilter);
    if (typeFilter)    qs.set('type', typeFilter);

    try {
        const data = await apiFetch(`/api/dashboard/analytics?${qs}`);

        const setKpi = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val ?? '—'; };

        // Atividade
        setKpi('kpi-sent', fmtNum(data.messages?.sent));
        setKpi('kpi-received', fmtNum(data.messages?.received));
        setKpi('kpi-reply-rate', fmtPct(data.messages?.reply_rate));
        setKpi('kpi-first-resp', fmtDurationMs(data.messages?.avg_first_response_ms));

        // Leads
        setKpi('kpi-total', fmtNum(data.totals?.leads));
        setKpi('kpi-comercial', fmtNum(data.totals?.comercial));
        setKpi('kpi-opec', fmtNum(data.totals?.opec));
        setKpi('kpi-convs', fmtNum(data.totals?.conversations));
        const total = data.totals?.leads || 1;
        setKpi('kpi-comercial-pct', `${Math.round((data.totals?.comercial||0)/total*100)}%`);
        setKpi('kpi-opec-pct', `${Math.round((data.totals?.opec||0)/total*100)}%`);

        // Ações
        setKpi('kpi-act-bb', fmtNum(data.activities?.wa_bb));
        setKpi('kpi-act-fr', fmtNum(data.activities?.wa_fr));
        setKpi('kpi-act-vm', fmtNum(data.activities?.wa_vm));
        setKpi('kpi-transcripts', fmtNum(data.activities?.transcripts));
        setKpi('kpi-apollo', fmtNum(data.apollo?.triggered));
        const apolloSubEl = document.getElementById('kpi-apollo-sub');
        if (apolloSubEl) {
            const matched = data.apollo?.matched_with_phone || 0;
            apolloSubEl.textContent = matched > 0 ? `${matched} com número` : 'enriquecimentos';
        }

        renderDashCharts(data);
        renderDashTables(data);
    } catch (err) {
        console.error('Dashboard error:', err);
        // Reset KPIs pra "—" pra não ficar com dados velhos
        ['kpi-sent','kpi-received','kpi-reply-rate','kpi-first-resp',
         'kpi-total','kpi-comercial','kpi-opec','kpi-convs',
         'kpi-comercial-pct','kpi-opec-pct',
         'kpi-act-bb','kpi-act-fr','kpi-act-vm','kpi-transcripts','kpi-apollo'
        ].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '—'; });
        // Mensagem inline em vez de toast cruel — possíveis causas:
        // - sem dados no período (filtro muito restrito)
        // - bug backend conhecido: data=null em query supabase quando não há msgs
        const apolloSubEl = document.getElementById('kpi-apollo-sub');
        if (apolloSubEl) apolloSubEl.textContent = 'Sem dados no período';
        toast('Sem dados disponíveis no período selecionado', 'warn');
    }
}

function fmtNum(n) { return n == null ? '—' : Number(n).toLocaleString('pt-BR'); }
function fmtPct(r) { return r == null ? '—' : `${Math.round(r * 100)}%`; }
function fmtDurationMs(ms) {
    if (ms == null) return '—';
    const sec = Math.round(ms / 1000);
    if (sec < 60)      return `${sec}s`;
    if (sec < 3600)    return `${Math.round(sec/60)}min`;
    if (sec < 86400)   return `${(sec/3600).toFixed(1)}h`;
    return `${(sec/86400).toFixed(1)}d`;
}

function renderDashTables(data) {
    const isAdmin = currentUser?.role === 'Admin';
    const uWrap = document.getElementById('dash-user-table-wrap');
    const aWrap = document.getElementById('dash-account-table-wrap');
    if (uWrap) uWrap.style.display = isAdmin ? '' : 'none';
    if (aWrap) aWrap.style.display = isAdmin ? '' : 'none';

    // Tabela usuários
    const utbody = document.getElementById('dash-user-tbody');
    if (utbody) {
        const rows = data.byUser || [];
        if (rows.length === 0) {
            utbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:16px">Sem atividade no período</td></tr>';
        } else {
            utbody.innerHTML = rows.map(u => `
                <tr>
                    <td><b>${escHtml(u.name)}</b></td>
                    <td style="text-align:right">${fmtNum(u.sent)}</td>
                    <td style="text-align:right">${fmtNum(u.received)}</td>
                    <td style="text-align:right">${fmtPct(u.reply_rate)}</td>
                    <td style="text-align:right">${fmtNum(u.conversations)}</td>
                    <td style="text-align:right">${fmtDurationMs(u.avg_first_response_ms)}</td>
                </tr>
            `).join('');
        }
    }

    // Tabela números
    const atbody = document.getElementById('dash-account-tbody');
    if (atbody) {
        const rows = data.byAccount || [];
        if (rows.length === 0) {
            atbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:16px">Sem atividade no período</td></tr>';
        } else {
            atbody.innerHTML = rows.map(a => `
                <tr>
                    <td><code>${escHtml(a.phone)}</code></td>
                    <td>${escHtml(a.owner_name || '—')}</td>
                    <td style="text-align:right">${fmtNum(a.sent)}</td>
                    <td style="text-align:right">${fmtNum(a.received)}</td>
                    <td style="text-align:right">${fmtPct(a.reply_rate)}</td>
                    <td style="text-align:right">${fmtNum(a.conversations)}</td>
                </tr>
            `).join('');
        }
    }
}

async function setupDashFilters() {
    const isAdmin = currentUser?.role === 'Admin';
    document.querySelectorAll('#panel-dashboard .admin-only').forEach(el => {
        el.style.display = isAdmin ? '' : 'none';
    });
    if (!isAdmin) return;

    // Popula filtros só pro Admin
    try {
        const users = (await apiFetch('/api/users')).users || [];
        const userSel = document.getElementById('dash-user-filter');
        if (userSel) {
            userSel.innerHTML = '<option value="">Todos atendentes</option>' +
                users.filter(u => u.active).map(u =>
                    `<option value="${u.id}">${escHtml(u.name)} (${u.role})</option>`
                ).join('');
        }
    } catch { /* ignora */ }
    try {
        const accounts = (await apiFetch('/api/whatsapp/accounts')).accounts || [];
        const acctSel = document.getElementById('dash-account-filter');
        if (acctSel) {
            acctSel.innerHTML = '<option value="">Todos números</option>' +
                accounts.map(a =>
                    `<option value="${a.id}">${escHtml(a.phone_number || a.name || a.id)}</option>`
                ).join('');
        }
    } catch { /* ignora */ }
}

function setupDashPeriod() {
    ['dash-period', 'dash-user-filter', 'dash-account-filter', 'dash-type-filter'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', loadDashboard);
    });
    setupDashFilters();
}

function renderDashCharts(data) {
    // Chart: Envios × Respostas por dia (linha dupla)
    const byDay = data.byDay || [];
    const dayLabels = byDay.map(d => d.date);
    const sentData = byDay.map(d => d.sent);
    const recvData = byDay.map(d => d.received);

    if (chartDay) chartDay.destroy();
    const ctx1 = document.getElementById('chart-msgs-day')?.getContext('2d');
    if (ctx1) {
        chartDay = new Chart(ctx1, {
            type: 'line',
            data: {
                labels: dayLabels,
                datasets: [
                    {
                        label: 'Enviados',
                        data: sentData,
                        borderColor: '#00E5FF',
                        backgroundColor: 'rgba(0,229,255,.1)',
                        borderWidth: 2,
                        fill: true,
                        tension: .35,
                        pointRadius: 3,
                    },
                    {
                        label: 'Respostas',
                        data: recvData,
                        borderColor: '#34D399',
                        backgroundColor: 'rgba(52,211,153,.1)',
                        borderWidth: 2,
                        fill: true,
                        tension: .35,
                        pointRadius: 3,
                    }
                ]
            },
            options: chartOpts({ yMin: 0 }),
        });
    }

    // Chart: Origem
    if (chartOrigin) chartOrigin.destroy();
    const ctx2 = document.getElementById('chart-origin')?.getContext('2d');
    const originData = data.byOrigin || {};
    if (ctx2) {
        chartOrigin = new Chart(ctx2, {
            type: 'doughnut',
            data: {
                labels: ['Formulario', 'WhatsApp', 'Prospeccao'],
                datasets: [{
                    data: [originData.form||0, originData.whatsapp_direct||0, originData.prospecting||0],
                    backgroundColor: ['#3B82F6','#00E5FF','#F59E0B'],
                    borderWidth: 0,
                }]
            },
            options: { ...chartOpts(), cutout: '68%' },
        });
    }

    // Chart: Classificacao
    if (chartClass) chartClass.destroy();
    const ctx3 = document.getElementById('chart-classification')?.getContext('2d');
    const clsData = data.byClassification || {};
    if (ctx3) {
        chartClass = new Chart(ctx3, {
            type: 'doughnut',
            data: {
                labels: ['Comercial', 'OPEC', 'Nao classificado'],
                datasets: [{
                    data: [clsData.comercial||0, clsData.opec||0, clsData.unclassified||0],
                    backgroundColor: ['#00E5FF','#F59E0B','#374151'],
                    borderWidth: 0,
                }]
            },
            options: { ...chartOpts(), cutout: '68%' },
        });
    }
}

function chartOpts(extra = {}) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: {
                labels: { color: '#9AA3B8', font: { family: 'Inter', size: 11 }, boxWidth: 12 }
            }
        },
        scales: extra.yMin !== undefined ? {
            y: {
                min: extra.yMin,
                grid: { color: 'rgba(255,255,255,.05)' },
                ticks: { color: '#9AA3B8', font: { family: 'Inter', size: 10 } }
            },
            x: {
                grid: { color: 'rgba(255,255,255,.03)' },
                ticks: { color: '#9AA3B8', font: { family: 'Inter', size: 10 }, maxTicksLimit: 8 }
            }
        } : undefined,
        ...extra,
    };
}

// --- SCRIPTS ---

function setupScriptCats() {
    document.querySelectorAll('.script-cat-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.script-cat-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentScriptCat = btn.dataset.cat;
            renderScriptsGrid();
        });
    });
}

async function loadScripts() {
    try {
        const data = await apiFetch('/api/scripts');
        allScripts = data.scripts || [];
        renderScriptsGrid();
    } catch (err) {
        const grid = document.getElementById('scripts-grid');
        if (grid) grid.innerHTML = `<div class="empty-state"><p style="color:var(--red)">Erro ao carregar</p></div>`;
    }
}

function renderScriptsGrid() {
    const grid = document.getElementById('scripts-grid');
    if (!grid) return;
    let filtered = allScripts;
    if (currentScriptCat) filtered = filtered.filter(s => s.category === currentScriptCat);

    // Filtro de visibilidade (público/meus/todos)
    const visFilter = document.getElementById('scripts-visibility-filter')?.value || 'all';
    if (visFilter === 'public') filtered = filtered.filter(s => s.is_public !== false);
    else if (visFilter === 'mine') filtered = filtered.filter(s => s.owner_user_id === currentUser?.id);

    if (filtered.length === 0) {
        grid.innerHTML = `<div class="empty-state"><p>Nenhum script nesta categoria</p></div>`;
        return;
    }

    const userId = currentUser?.id;
    const isAdmin = currentUser?.role === 'Admin';

    grid.innerHTML = filtered.map(s => {
        const isMine = s.owner_user_id === userId;
        const canEdit = isMine || isAdmin || !s.owner_user_id;
        const privacyBadge = s.is_public === false
            ? `<span class="tag" style="background:rgba(139,92,246,.15);color:#a78bfa;font-size:10px">🔒 Pessoal</span>`
            : '';
        return `
        <div class="script-card${s.is_public === false ? ' script-private' : ''}">
            <div class="script-card-header">
                <div class="script-card-title">${escHtml(s.title)} ${privacyBadge}</div>
                <div class="script-card-actions">
                    ${canEdit ? `<button class="icon-btn" data-action="edit-script" data-id="${s.id}" title="Editar">✏️</button>
                    <button class="icon-btn danger" data-action="delete-script" data-id="${s.id}" title="Remover">🗑</button>` : ''}
                </div>
            </div>
            <div class="script-card-category">
                <span class="tag tag-${s.category === 'comercial' ? 'comercial' : s.category === 'opec' ? 'opec' : 'wa'}">${catLabel(s.category)}</span>
            </div>
            <div class="script-card-content">${escHtml(s.content)}</div>
        </div>`;
    }).join('');
}

function setupScriptForm() {
    document.getElementById('btn-new-script')?.addEventListener('click', () => {
        document.getElementById('modal-script-title').textContent = 'Novo Script';
        document.getElementById('script-id').value = '';
        document.getElementById('form-script').reset();
        openModal('modal-script');
    });

    // Toggle de visibilidade — atualiza label
    document.getElementById('script-is-public')?.addEventListener('change', e => {
        const label = document.getElementById('script-visibility-label');
        if (label) label.textContent = e.target.checked
            ? 'Público — visível para toda a equipe'
            : 'Pessoal — só você vê este script';
    });

    // Filtro de visibilidade no painel
    document.getElementById('scripts-visibility-filter')?.addEventListener('change', () => renderScriptsGrid());

    document.getElementById('form-script')?.addEventListener('submit', async e => {
        e.preventDefault();
        const id = document.getElementById('script-id').value;
        const payload = {
            category:  document.getElementById('script-category').value,
            title:     document.getElementById('script-title').value,
            content:   document.getElementById('script-content').value,
            is_public: document.getElementById('script-is-public')?.checked ?? true,
        };
        try {
            if (id) {
                await apiFetch(`/api/scripts/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
                toast('Script atualizado!', 'success');
            } else {
                await apiFetch('/api/scripts', { method: 'POST', body: JSON.stringify(payload) });
                toast('Script criado!', 'success');
            }
            closeModal('modal-script');
            await loadScripts();
        } catch (err) {
            toast(`Erro: ${err.message}`, 'error');
        }
    });
}

function editScript(scriptId) {
    const s = allScripts.find(x => x.id === scriptId);
    if (!s) return;
    document.getElementById('modal-script-title').textContent = 'Editar Script';
    document.getElementById('script-id').value = s.id;
    document.getElementById('script-category').value = s.category;
    document.getElementById('script-title').value = s.title;
    document.getElementById('script-content').value = s.content;
    const pub = document.getElementById('script-is-public');
    if (pub) pub.checked = s.is_public !== false;
    const label = document.getElementById('script-visibility-label');
    if (label) label.textContent = s.is_public !== false
        ? 'Público — visível para toda a equipe'
        : 'Pessoal — só você vê este script';
    openModal('modal-script');
}

async function deleteScript(scriptId) {
    if (!confirm('Desativar este script?')) return;
    try {
        await apiFetch(`/api/scripts/${scriptId}`, { method: 'DELETE' });
        toast('Script removido', 'info');
        await loadScripts();
    } catch (err) {
        toast(`Erro: ${err.message}`, 'error');
    }
}

// --- API Helper ---

async function apiFetch(url, options = {}) {
    const token = getToken();
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(url, { ...options, headers });

    // Sessao expirada — lanca erro para o caller decidir o que fazer
    if (res.status === 401) {
        const err = new Error('Sessao expirada');
        err.status = 401;
        throw err;
    }
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        const e = new Error(err.error || res.statusText);
        e.status = res.status;
        // Anexa campos estruturados pra o caller decidir UX (ex: erro de
        // envio do WhatsApp com error_code='invalid_recipient' tem msg amigável)
        e.code = err.error_code || null;
        e.body = err;
        throw e;
    }
    return res.json();
}

/** Exibe o usuario logado no side-nav */
function setupCurrentUser() {
    if (!currentUser) return;

    const container = document.getElementById('side-nav-user');
    if (container) {
        // Avatar + logout movidos pro chip da topbar (dropdown). Mantém o
        // container vazio pra não quebrar seletores legados.
        container.replaceChildren();
        container.removeAttribute('title');
        container.className = 'side-nav-user is-empty';
    }

    // SPEC v2 §8 — preenche o user chip do topbar
    if (typeof updateTopbarUser === 'function') updateTopbarUser();

    const isAdmin = currentUser.role === 'Admin';

    // Admin ve o link de usuarios nas configuracoes
    if (isAdmin) {
        document.querySelectorAll('.admin-only').forEach(el => el.style.display = '');
    }

    // Visibilidade por role: Dashboard só para Admin
    const dashTab = document.getElementById('tab-dashboard');
    if (dashTab) dashTab.style.display = isAdmin ? '' : 'none';

    // Acesso ao Atendimento Site: admin sempre, outros se permissions.site_access
    const hasSiteAccess = isAdmin || currentUser?.permissions?.site_access === true;
    const siteBtn = document.getElementById('btn-site');
    if (siteBtn) siteBtn.style.display = hasSiteAccess ? '' : 'none';
}


// --- Modal ---
function openModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'flex';
}
function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
}
document.querySelectorAll('.modal-overlay')?.forEach(overlay => {
    overlay.addEventListener('click', e => {
        if (e.target === overlay) overlay.style.display = 'none';
    });
});

// --- Toast ---
function toast(msg, type = 'info', durationMs = 3500) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    const iconMap = { success: 'icon-check', error: 'icon-alert', info: 'icon-info', warning: 'icon-alert' };
    const iconId = iconMap[type] || 'icon-info';
    el.innerHTML = `<svg class="icon icon-sm"><use href="/icons.svg#${iconId}"></use></svg> ${escHtml(msg)}`;
    container.appendChild(el);
    setTimeout(() => {
        el.classList.add('toast-out');
        el.addEventListener('animationend', () => el.remove());
    }, durationMs);
}

// --- New Msg Notif ---
function showNewMsgNotif(text) {
    const notif = document.getElementById('new-msg-notif');
    const notifText = document.getElementById('notif-text');
    if (!notif || !notifText) return;
    notifText.textContent = text;
    notif.style.display = 'flex';
    setTimeout(() => { notif.style.display = 'none'; }, 4000);
    notif.onclick = () => { notif.style.display = 'none'; };
}

// --- Utils ---
function escHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function truncate(str, n) { return str.length > n ? str.slice(0, n) + '...' : str; }
function formatPhone(phone) {
    if (!phone) return '—';
    const d = String(phone).replace(/\D/g, '');
    // 11 dígitos BR: (DD) 9XXXX-XXXX
    if (d.length === 11) return `(${d.slice(0,2)}) ${d[2]}${d.slice(3,7)}-${d.slice(7)}`;
    // 10 dígitos: (DD) XXXX-XXXX
    if (d.length === 10) return `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`;
    return phone;
}
function classLabel(cls) {
    return { comercial: '🟢 Comercial', opec: '🟡 OPEC', unclassified: '⚪ Aguardando', prospecting: '🔵 Prospeccao' }[cls] || cls || '—';
}
function catLabel(cat) {
    return { welcome: '👋 Boas-vindas', comercial: '🟢 Comercial', opec: '🟡 OPEC', qualification: '❓ Qualificacao', closing: '🤝 Encerramento' }[cat] || cat;
}
function originLabel(origin) {
    return { form: '📋 Formulario', whatsapp_direct: '📱 WhatsApp', prospecting: '🔍 Prospeccao' }[origin] || origin || '—';
}
function formatTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
}
function formatDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function relativeTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - new Date(ts).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'agora';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
}
function debounce(fn, ms) {
    let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// --- WhatsApp Connect via QR Code ---

let _waAccountId = null;

async function checkWaStatus() {
    const detail = document.getElementById('wa-status-detail');
    if (!detail) return;
    detail.textContent = '⏳ Verificando...';

    try {
        const data = await apiFetch('/api/whatsapp/accounts');
        const accounts = data.accounts || [];

        if (accounts.length > 0) {
            const acc = accounts[0];
            _waAccountId = acc.id;
            const identifier = acc.name || acc.identifier || acc.id;
            detail.innerHTML = `<span style="color:#00E5FF">✅ Conectado</span> — ${identifier}`;

            const btnQR = document.getElementById('btn-wa-generate-qr');
            const btnDis = document.getElementById('btn-wa-disconnect');
            const qrArea = document.getElementById('wa-qr-area');
            if (btnQR) btnQR.style.display = 'none';
            if (btnDis) btnDis.style.display = 'inline-flex';
            if (qrArea) qrArea.style.display = 'none';
        } else {
            _waAccountId = null;
            detail.innerHTML = `<span style="color:#F59E0B">⚠️ Nenhuma conta conectada</span>`;
            const btnQR = document.getElementById('btn-wa-generate-qr');
            const btnDis = document.getElementById('btn-wa-disconnect');
            if (btnQR) btnQR.style.display = 'inline-flex';
            if (btnDis) btnDis.style.display = 'none';
        }
    } catch (err) {
        detail.innerHTML = `<span style="color:#EF4444">❌ Erro ao verificar: ${err.message}</span>`;
    }
}

function openWaConnect() {
    openModal('modal-wa-connect');
    const qrArea = document.getElementById('wa-qr-area');
    if (qrArea) qrArea.style.display = 'none';
    closeReconnectArea();
    renderWaAccountsInModal();
    checkWaStatus();
}

function closeWaConnect() {
    closeModal('modal-wa-connect');
    closeReconnectArea();
    if (_reconnectPollInterval) { clearInterval(_reconnectPollInterval); _reconnectPollInterval = null; }
    checkHealth();
}

// ─── Lista de contas no modal + botão Religar por conta ──────────────
async function renderWaAccountsInModal() {
    const listEl = document.getElementById('wa-accounts-list');
    if (!listEl) return;
    listEl.replaceChildren();

    let accounts = [];
    try {
        const data = await apiFetch('/api/whatsapp/accounts');
        accounts = data.accounts || [];
    } catch (err) {
        const msg = document.createElement('div');
        msg.style.cssText = 'padding:12px;color:var(--text-3);font-size:13px;text-align:center';
        msg.textContent = `Erro ao listar contas: ${err.message}`;
        listEl.appendChild(msg);
        return;
    }

    if (accounts.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding:16px;color:var(--text-3);font-size:13px;text-align:center';
        empty.textContent = 'Nenhum número WhatsApp atribuído a você.';
        listEl.appendChild(empty);
        return;
    }

    const isAdmin = currentUser?.role === 'Admin';
    const myIds = new Set(currentUser?.permissions?.whatsapp_accounts || []);

    // Pra Admin: divide em 2 grupos — "Suas contas" (em permissions) + "Outras"
    // Pra non-admin: o backend já filtra; mostra tudo sem seção
    const mine = accounts.filter(a => myIds.has(a.id));
    const others = accounts.filter(a => !myIds.has(a.id));

    if (isAdmin && mine.length > 0 && others.length > 0) {
        listEl.appendChild(_makeSectionHeader('Suas contas'));
        for (const a of mine) listEl.appendChild(_makeAccountRow(a, true));
        listEl.appendChild(_makeSectionHeader('Outras contas'));
        for (const a of others) listEl.appendChild(_makeAccountRow(a, false));
    } else {
        for (const a of accounts) listEl.appendChild(_makeAccountRow(a, myIds.has(a.id)));
    }
}

function _makeSectionHeader(text) {
    const h = document.createElement('div');
    h.style.cssText = 'font-size:11px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:var(--text-3);padding:6px 4px 2px;margin-top:6px';
    h.textContent = text;
    return h;
}

function _makeAccountRow(a, isMine) {
    const isConnected = s => /^(ok|connected|running|ok_for_now)$/i.test(s || '');
    const ok = isConnected(a.status);
    const isAdmin = currentUser?.role === 'Admin';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg-tertiary);border-radius:8px';
    if (isMine) row.style.outline = '1.5px solid var(--accent-mid)';

    const dot = document.createElement('span');
    dot.style.cssText = `width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${ok ? '#10b981' : '#f59e0b'}`;

    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0';

    const labelRow = document.createElement('div');
    labelRow.style.cssText = 'display:flex;align-items:center;gap:6px';

    if (isMine) {
        const star = document.createElement('span');
        star.title = 'Você opera essa conta';
        star.style.cssText = 'color:var(--accent);font-size:11px';
        star.textContent = '⭐';
        labelRow.appendChild(star);
    }

    const label = document.createElement('div');
    label.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1';
    label.textContent = a.display_name || a.phone_number || a.name || a.id;
    labelRow.appendChild(label);

    if (isAdmin) {
        const editBtn = document.createElement('button');
        editBtn.title = 'Editar label';
        editBtn.style.cssText = 'background:transparent;border:none;color:var(--text-3);cursor:pointer;font-size:11px;padding:2px 4px';
        editBtn.textContent = '✏️';
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _editAccountLabel(a);
        });
        labelRow.appendChild(editBtn);
    }

    const status = document.createElement('div');
    status.style.cssText = 'font-size:11px;color:var(--text-3);margin-top:2px';
    status.textContent = ok ? 'Conectado' : `Desconectado (${a.status || 'unknown'}) — religue`;

    info.appendChild(labelRow);
    info.appendChild(status);

    const btn = document.createElement('button');
    btn.className = ok ? 'btn-secondary' : 'btn-primary';
    btn.style.cssText = 'padding:6px 12px;font-size:12px;flex-shrink:0';
    btn.textContent = ok ? 'Religar' : '🔌 Religar';
    btn.addEventListener('click', () => startReconnect(a));

    row.appendChild(dot);
    row.appendChild(info);
    row.appendChild(btn);
    return row;
}

// Inline edit do display_label (admin only)
async function _editAccountLabel(account) {
    const current = account.display_name || account.phone_number || '';
    const newLabel = prompt(`Novo label pra "${current}":`, current);
    if (newLabel === null) return;
    const trimmed = newLabel.trim();

    try {
        await apiFetch(`/api/whatsapp/accounts/${account.id}/label`, {
            method: 'PATCH',
            body: JSON.stringify({ display_label: trimmed || null }),
        });
        toast(trimmed ? `Label atualizado: "${trimmed}"` : 'Label removido', 'success');
        renderWaAccountsInModal();
    } catch (err) {
        toast(`Erro: ${err.message}`, 'error');
    }
}

let _reconnectPollInterval = null;
let _reconnectUrl = null;
let _reconnectAccountId = null;

async function startReconnect(acc) {
    _reconnectAccountId = acc.id;
    const area = document.getElementById('wa-reconnect-area');
    const target = document.getElementById('wa-reconnect-target');
    const qrEl = document.getElementById('wa-reconnect-qr');
    const urlEl = document.getElementById('wa-reconnect-url');
    if (!area || !target || !qrEl || !urlEl) return;

    area.style.display = '';
    target.textContent = `Religando: ${acc.display_name || acc.phone_number || acc.name || acc.id}`;
    qrEl.replaceChildren();
    const loading = document.createElement('span');
    loading.style.cssText = 'color:#666;font-size:13px';
    loading.textContent = '⚙️ Tentando religar sem QR...';
    qrEl.appendChild(loading);
    urlEl.value = '';

    // Tentativa 1: restart sem QR. ~30% das quedas resolvem aqui.
    try {
        const restart = await apiFetch(`/api/whatsapp/accounts/${acc.id}/restart-session`, { method: 'POST' });
        if (restart?.success) {
            qrEl.replaceChildren();
            const ok = document.createElement('span');
            ok.style.cssText = 'color:#10b981;font-size:14px;font-weight:600';
            ok.textContent = '✅ Religada sem QR! Aguardando confirmação da Unipile...';
            qrEl.appendChild(ok);
            toast('Sessão restaurada — sem QR', 'success');
            // dispara refresh do status global pra topbar atualizar
            if (typeof refreshMyAccountsStatus === 'function') refreshMyAccountsStatus();
            // recarrega o modal pra refletir
            setTimeout(() => { renderWaAccountsInModal(); }, 2500);
            return;
        }
    } catch (err) {
        console.warn('Restart falhou, indo pra QR:', err.message);
    }

    // Tentativa 2: QR scan via hosted link
    loading.textContent = '⏳ Gerando QR...';
    try {
        const data = await apiFetch(`/api/whatsapp/accounts/${acc.id}/reconnect-link`, { method: 'POST' });
        const url = data.url;
        if (!url) throw new Error('Sem URL');
        _reconnectUrl = url;
        urlEl.value = url;

        // Render QR da URL hosted
        qrEl.replaceChildren();
        const canvas = document.createElement('canvas');
        qrEl.appendChild(canvas);
        try {
            new QRious({ element: canvas, value: url, size: 220, level: 'M', background: 'white', foreground: '#000' });
        } catch (qrErr) {
            const fb = document.createElement('a');
            fb.href = url; fb.target = '_blank';
            fb.style.cssText = 'color:var(--accent);font-size:12px;word-break:break-all';
            fb.textContent = url;
            qrEl.appendChild(fb);
        }

        // Polling: verifica a cada 4s se a conta voltou pra OK
        if (_reconnectPollInterval) clearInterval(_reconnectPollInterval);
        const startTime = Date.now();
        _reconnectPollInterval = setInterval(async () => {
            // Timeout 10 min
            if (Date.now() - startTime > 10 * 60_000) {
                clearInterval(_reconnectPollInterval); _reconnectPollInterval = null;
                return;
            }
            try {
                const r = await apiFetch('/api/whatsapp/accounts');
                const found = (r.accounts || []).find(x => x.id === _reconnectAccountId);
                if (found && /^(ok|connected|running|ok_for_now)$/i.test(found.status)) {
                    clearInterval(_reconnectPollInterval); _reconnectPollInterval = null;
                    toast('✅ Conta religada com sucesso', 'success');
                    closeReconnectArea();
                    renderWaAccountsInModal();
                }
            } catch { /* ignora erros transitórios de polling */ }
        }, 4000);
    } catch (err) {
        qrEl.replaceChildren();
        const errEl = document.createElement('span');
        errEl.style.cssText = 'color:#ef4444;font-size:13px';
        errEl.textContent = `❌ ${err.message}`;
        qrEl.appendChild(errEl);
    }
}

function closeReconnectArea() {
    const area = document.getElementById('wa-reconnect-area');
    if (area) area.style.display = 'none';
    if (_reconnectPollInterval) { clearInterval(_reconnectPollInterval); _reconnectPollInterval = null; }
}

function copyReconnectUrl() {
    if (!_reconnectUrl) return;
    navigator.clipboard?.writeText(_reconnectUrl).then(
        () => toast('Link copiado', 'info'),
        () => toast('Falha ao copiar', 'error')
    );
}

async function generateWaQR() {
    const btn = document.getElementById('btn-wa-generate-qr');
    const qrArea = document.getElementById('wa-qr-area');
    const container = document.getElementById('wa-qr-container');

    if (btn) { btn.disabled = true; btn.textContent = '⏳ Gerando...'; }
    if (qrArea) qrArea.style.display = 'block';
    if (container) container.innerHTML = '<span style="color:#666">⏳ Aguardando QR code da Unipile...</span>';

    try {
        const res = await fetch('/api/whatsapp/connect', { method: 'POST' });
        const json = await res.json();

        if (json.error) throw new Error(json.error);

        const checkpoint = json.checkpoint || json;
        const qrData = checkpoint.qrcode || checkpoint.qr_code || json.qr_code;

        if (qrData && container) {
            container.innerHTML = '';

            if (qrData.startsWith('data:image') || qrData.startsWith('iVBOR')) {
                container.innerHTML = `<img src="${qrData.startsWith('data:') ? qrData : 'data:image/png;base64,' + qrData}"
                    style="max-width:250px;border-radius:8px">`;
            } else {
                const canvas = document.createElement('canvas');
                container.appendChild(canvas);
                try {
                    new QRious({ element: canvas, value: qrData, size: 240, level: 'M', background: 'white', foreground: '#000' });
                } catch (qrErr) {
                    container.innerHTML = `<span style="color:red">Erro ao renderizar QR: ${qrErr.message}</span>`;
                }
            }

            _pollWaConnection();

        } else if (json.object === 'Account' || json.id) {
            if (container) container.innerHTML = '<span style="color:#00E5FF;font-size:16px">✅ Conta conectada!</span>';
            setTimeout(() => { checkWaStatus(); checkHealth(); }, 1000);
        } else {
            if (container) container.innerHTML = `<pre style="font-size:10px;color:#888;max-width:280px;overflow:auto;white-space:pre-wrap;text-align:left">${JSON.stringify(json, null, 2)}</pre>`;
        }
    } catch (err) {
        if (container) container.innerHTML = `<span style="color:#EF4444">❌ ${err.message}</span>`;
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '📱 Gerar novo QR'; }
    }
}

function _pollWaConnection() {
    let attempts = 0;
    const maxAttempts = 40;

    const interval = setInterval(async () => {
        attempts++;
        if (attempts >= maxAttempts) {
            clearInterval(interval);
            return;
        }
        try {
            const data = await apiFetch('/api/whatsapp/accounts');
            if ((data.accounts || []).length > 0) {
                clearInterval(interval);
                const container = document.getElementById('wa-qr-container');
                if (container) container.innerHTML = '<span style="color:#00E5FF;font-size:20px">✅ WhatsApp Conectado!</span>';
                setTimeout(() => {
                    checkWaStatus();
                    checkHealth();
                }, 1500);
            }
        } catch { /* ignora erros de polling */ }
    }, 3000);
}

async function disconnectWa() {
    if (!_waAccountId) return;
    try {
        await apiFetch(`/api/whatsapp/accounts/${_waAccountId}`, { method: 'DELETE' });
        toast('WhatsApp desconectado', 'info');
        _waAccountId = null;
        checkWaStatus();
        checkHealth();
    } catch (err) {
        toast(`Erro ao desconectar: ${err.message}`, 'error');
    }
}

// --- SETTINGS ---

let _settingsData = null;

async function openSettingsModal() {
    const modal = document.getElementById('modal-settings');
    if (modal) modal.style.display = 'flex';

    // Sync selects de Aparência com prefs salvas (SPEC v2 §5)
    if (typeof syncAppearanceSelectsFromPrefs === 'function') {
        syncAppearanceSelectsFromPrefs();
    }

    const isAdmin = currentUser?.role === 'Admin';

    // Mostra/esconde aba de usuários (Admin only)
    const tabUsers = document.querySelector('[data-stab="users"]');
    if (tabUsers) tabUsers.style.display = isAdmin ? '' : 'none';

    // Mostra/esconde seções admin (bot, pipedrive, agent name)
    document.querySelectorAll('.admin-section').forEach(el => {
        el.style.display = isAdmin ? '' : 'none';
    });

    try {
        // Carrega perfil pessoal do user logado
        const profileRes = await apiFetch('/api/settings/my-profile');
        const profile = profileRes.profile || {};
        const myNameEl = document.getElementById('settings-my-name');
        if (myNameEl) myNameEl.value = profile.name || '';

        // Foto do user
        const preview = document.getElementById('settings-photo-preview');
        if (preview) {
            if (profile.avatar_url) {
                preview.innerHTML = `<img src="${profile.avatar_url}" alt="foto" />`;
            } else {
                preview.innerHTML = `<span id="settings-photo-icon">👤</span>`;
            }
        }

        // Se Admin, carrega configs globais + dados Pipedrive
        if (isAdmin) {
            const [settRes, pdRes] = await Promise.all([
                apiFetch('/api/settings'),
                apiFetch('/api/settings/pipedrive-data'),
            ]);
            _settingsData = settRes.settings;
            const { pipelines = [], stages = [], users = [] } = pdRes;

            // Agent name global (do bot)
            const agentNameEl = document.getElementById('settings-agent-name');
            if (agentNameEl) agentNameEl.value = _settingsData.agent_name || '';

            // Chatbot mode (ai | manual | off)
            const botMode = _settingsData.bot_mode || 'ai';
            const botModeEl = document.getElementById(`bot-mode-${botMode}`);
            if (botModeEl) botModeEl.checked = true;

            // Apollo enrichment (admin only)
            const apolloEl = document.getElementById('settings-apollo-enabled');
            if (apolloEl) apolloEl.checked = !!_settingsData.apollo_enabled;
            const apolloAutoEl = document.getElementById('settings-apollo-auto-match');
            if (apolloAutoEl) apolloAutoEl.checked = !!_settingsData.apollo_auto_match;

            // Bot 24h
            const awayEnabledEl = document.getElementById('settings-away-enabled');
            if (awayEnabledEl) awayEnabledEl.checked = !!_settingsData.away_enabled;
            const awayMinEl = document.getElementById('settings-away-minutes');
            if (awayMinEl) awayMinEl.value = _settingsData.away_minutes ?? 10;
            const awayMsgEl = document.getElementById('settings-away-message');
            if (awayMsgEl) awayMsgEl.value = _settingsData.away_message || '';

            // Funis
            const pipelineSel = document.getElementById('settings-pipeline');
            if (pipelineSel) {
                pipelineSel.innerHTML = pipelines.map(p =>
                    `<option value="${p.id}" ${p.id == _settingsData.pipedrive_pipeline_id ? 'selected' : ''}>${p.name}</option>`
                ).join('');
            }

            // Etapas
            const stageSel = document.getElementById('settings-stage');
            if (stageSel) {
                stageSel.innerHTML = stages.map(s =>
                    `<option value="${s.id}" ${s.id == _settingsData.pipedrive_stage_id ? 'selected' : ''}>${s.name}</option>`
                ).join('') || '<option value="">Nenhuma etapa encontrada</option>';
            }

            // Proprietarios
            const ownerSel = document.getElementById('settings-owner');
            if (ownerSel) {
                ownerSel.innerHTML = `<option value="">— Nao atribuido —</option>` +
                    users.map(u =>
                        `<option value="${u.id}" ${u.id == _settingsData.pipedrive_owner_id ? 'selected' : ''}>${u.name}</option>`
                    ).join('');
            }

            window._pdUsers = users;
        }

    } catch (err) {
        toast(`Erro ao carregar configuracoes: ${err.message}`, 'error');
    }
}

function switchSettingsTab(tabId) {
    document.querySelectorAll('.settings-tab').forEach(t =>
        t.classList.toggle('active', t.dataset.stab === tabId)
    );
    document.querySelectorAll('.settings-tab-panel').forEach(p => {
        const isActive = p.id === `stab-${tabId}`;
        p.classList.toggle('active', isActive);
        // Limpa inline display — deixa o CSS controlar via .active (flex) vs default (none)
        p.style.display = '';
    });

    if (tabId === 'users') loadUsersList();
}

// --- User Management ---
async function loadUsersList() {
    const container = document.getElementById('users-list');
    if (!container) return;
    container.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">Carregando...</div>';

    try {
        const data = await apiFetch('/api/users');
        renderUsersList(data.users || []);
    } catch (err) {
        container.innerHTML = `<div style="color:var(--red-soft)">Erro: ${err.message}</div>`;
    }
}

let _cachedUsers = [];

function renderUsersList(users) {
    _cachedUsers = users;
    const container = document.getElementById('users-list');
    if (!container) return;

    if (users.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted);font-size:13px">Nenhum usuario cadastrado.</div>';
        return;
    }

    container.innerHTML = users.map(u => {
        const initial = (u.name || u.email || '?').charAt(0).toUpperCase();
        const inactive = !u.active;
        return `
        <div class="user-list-item${inactive ? ' user-inactive' : ''}">
            <div class="user-avatar-sm">${initial}</div>
            <div class="user-info">
                <div class="user-name-row">
                    <span class="user-name">${escHtml(u.name || '—')}</span>
                    <span class="role-badge ${u.role}">${u.role}</span>
                    ${inactive ? '<span style="font-size:10px;color:var(--text-muted)">(inativo)</span>' : ''}
                </div>
                <div class="user-email">${escHtml(u.email)}</div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0">
                <button class="btn-sm btn-outline" style="padding:5px 10px;font-size:11px"
                    data-action="edit-user" data-user-id="${u.id}">✏️</button>
                <button class="btn-sm btn-outline" style="padding:5px 10px;font-size:11px"
                    data-action="toggle-user" data-user-id="${u.id}" data-activate="${inactive}">
                    ${inactive ? '✅ Ativar' : '🚫 Desativar'}
                </button>
                ${inactive ? `<button class="btn-sm" style="padding:5px 10px;font-size:11px;border:1px solid #f04646;color:#ff8a8a;background:rgba(240,70,70,0.08)"
                    data-action="delete-user-permanent" data-user-id="${u.id}" data-user-name="${escHtml(u.name || u.email)}"
                    title="Apagar permanentemente do banco">🗑️</button>` : ''}
            </div>
        </div>`;
    }).join('');
}

async function deleteUserPermanent(userId, userName) {
    if (!confirm(`⚠️ IRREVERSÍVEL\n\nApagar o usuário "${userName}" permanentemente do banco?`)) return;
    try {
        await apiFetch(`/api/users/${userId}/permanent`, { method: 'DELETE' });
        toast('Usuário apagado permanentemente', 'success');
        loadUsersList();
    } catch (err) {
        toast(`Falha ao apagar: ${err.message}`, 'error');
    }
}

function openAddUserForm() {
    const titleEl = document.getElementById('user-form-title');
    if (titleEl) titleEl.textContent = 'Novo usuario';
    const idEl = document.getElementById('uf-id');
    if (idEl) idEl.value = '';
    const nameEl = document.getElementById('uf-name');
    if (nameEl) nameEl.value = '';
    const emailEl = document.getElementById('uf-email');
    if (emailEl) emailEl.value = '';
    const pwEl = document.getElementById('uf-password');
    if (pwEl) pwEl.value = '';
    const roleEl = document.getElementById('uf-role');
    if (roleEl) roleEl.value = 'Usuario';
    const tokenEl = document.getElementById('uf-pipedrive-token');
    if (tokenEl) { tokenEl.value = ''; tokenEl.placeholder = 'Cole o token aqui (Pipedrive > Config > Preferencias > API)'; }
    const tokenStatus = document.getElementById('uf-token-status');
    if (tokenStatus) { tokenStatus.textContent = 'Necessario para que atividades aparecam como criadas por este usuario no Pipedrive'; tokenStatus.style.color = 'var(--text-muted)'; }
    populatePdUsersDropdown(null);
    populatePermissions({});
    const wrap = document.getElementById('user-form-wrap');
    if (wrap) wrap.style.display = '';
}

function openEditUserForm(user) {
    const titleEl = document.getElementById('user-form-title');
    if (titleEl) titleEl.textContent = 'Editar usuario';
    const idEl = document.getElementById('uf-id');
    if (idEl) idEl.value = user.id;
    const nameEl = document.getElementById('uf-name');
    if (nameEl) nameEl.value = user.name || '';
    const emailEl = document.getElementById('uf-email');
    if (emailEl) emailEl.value = user.email;
    const pwEl = document.getElementById('uf-password');
    if (pwEl) pwEl.value = '';
    const roleEl = document.getElementById('uf-role');
    if (roleEl) roleEl.value = user.role;
    // Pipedrive token
    const tokenEl = document.getElementById('uf-pipedrive-token');
    if (tokenEl) {
        tokenEl.value = '';
        tokenEl.placeholder = user.pipedrive_api_token
            ? 'Token salvo ••••••. Deixe vazio para manter.'
            : 'Cole o token aqui (Pipedrive > Config > Preferencias > API)';
    }
    const tokenStatus = document.getElementById('uf-token-status');
    if (tokenStatus) {
        tokenStatus.textContent = user.pipedrive_api_token
            ? '✅ Token configurado. Deixe vazio para manter.'
            : 'Necessario para que atividades aparecam como criadas por este usuario no Pipedrive';
        tokenStatus.style.color = user.pipedrive_api_token ? 'var(--accent)' : 'var(--text-muted)';
    }
    populatePdUsersDropdown(user.pipedrive_user_id);
    populatePermissions(user.permissions || {});
    const wrap = document.getElementById('user-form-wrap');
    if (wrap) wrap.style.display = '';
}

function populatePermissions(perms) {
    // Conversation types
    const inboundCb = document.getElementById('uf-perm-inbound');
    const prospCb = document.getElementById('uf-perm-prospecting');
    const types = perms.conversation_types || [];
    if (inboundCb) inboundCb.checked = types.includes('inbound');
    if (prospCb) prospCb.checked = types.includes('prospecting');

    // Apollo enrichment permission (per-user)
    const apolloCb = document.getElementById('uf-perm-apollo');
    if (apolloCb) apolloCb.checked = !!perms.apollo_enabled;

    // WhatsApp accounts
    const waContainer = document.getElementById('uf-wa-accounts');
    if (!waContainer) return;
    const allowedAccounts = perms.whatsapp_accounts || [];

    apiFetch('/api/whatsapp/accounts').then(data => {
        const accounts = data?.accounts || [];
        if (accounts.length === 0) {
            waContainer.textContent = 'Nenhuma conta WhatsApp conectada';
            return;
        }
        waContainer.innerHTML = accounts.map(a => {
            const checked = allowedAccounts.includes(a.id) ? 'checked' : '';
            const label = a.connection_params?.im?.phone_number || a.name || a.id;
            return `<label class="perm-check"><input type="checkbox" value="${a.id}" class="uf-wa-check" ${checked} /> ${escHtml(String(label))}</label>`;
        }).join('');
    }).catch(() => {
        waContainer.textContent = 'Erro ao carregar contas';
    });
}

function getPermissionsFromForm() {
    const types = [];
    if (document.getElementById('uf-perm-inbound')?.checked) types.push('inbound');
    if (document.getElementById('uf-perm-prospecting')?.checked) types.push('prospecting');

    const waAccounts = [];
    document.querySelectorAll('.uf-wa-check:checked').forEach(cb => {
        waAccounts.push(cb.value);
    });

    const apolloEnabled = !!document.getElementById('uf-perm-apollo')?.checked;

    return { conversation_types: types, whatsapp_accounts: waAccounts, apollo_enabled: apolloEnabled };
}

function populatePdUsersDropdown(selectedId) {
    const sel = document.getElementById('uf-pipedrive-user');
    if (!sel) return;
    const users = window._pdUsers || [];
    sel.innerHTML = `<option value="">— Nao vincular —</option>` +
        users.map(u =>
            `<option value="${u.id}" ${u.id == selectedId ? 'selected' : ''}>${u.name}</option>`
        ).join('');
}

function closeAddUserForm() {
    const wrap = document.getElementById('user-form-wrap');
    if (wrap) wrap.style.display = 'none';
}

function toggleTokenVisibility() {
    const el = document.getElementById('uf-pipedrive-token');
    if (!el) return;
    el.type = el.type === 'password' ? 'text' : 'password';
}

async function saveUser() {
    const id       = document.getElementById('uf-id')?.value;
    const name     = document.getElementById('uf-name')?.value.trim();
    const email    = document.getElementById('uf-email')?.value.trim();
    const password = document.getElementById('uf-password')?.value;
    const role     = document.getElementById('uf-role')?.value;
    const pdUserId = document.getElementById('uf-pipedrive-user')?.value;
    const pdToken  = document.getElementById('uf-pipedrive-token')?.value.trim();
    const permissions = getPermissionsFromForm();

    if (!name || !email) { toast('Nome e e-mail sao obrigatorios', 'error'); return; }
    if (!id && !password) { toast('Senha obrigatoria para novo usuario', 'error'); return; }

    try {
        const body = { name, email, role, pipedrive_user_id: pdUserId || null, permissions };
        if (password) body.password = password;
        if (pdToken) body.pipedrive_api_token = pdToken; // só envia se preenchido (não sobrescreve com vazio)

        if (id) {
            await apiFetch(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
            toast('Usuario atualizado!', 'success');
        } else {
            await apiFetch('/api/users', { method: 'POST', body: JSON.stringify(body) });
            toast('Usuario criado!', 'success');
        }
        closeAddUserForm();
        loadUsersList();
    } catch (err) {
        toast(`Erro: ${err.message}`, 'error');
    }
}

async function toggleUserActive(userId, setActive) {
    try {
        await apiFetch(`/api/users/${userId}`, {
            method: 'PATCH',
            body: JSON.stringify({ active: setActive }),
        });
        toast(setActive ? 'Usuario ativado' : 'Usuario desativado', 'success');
        loadUsersList();
    } catch (err) {
        toast(`Erro: ${err.message}`, 'error');
    }
}

async function loadSettingsStages(pipelineId) {
    if (!pipelineId) return;
    const stageSel = document.getElementById('settings-stage');
    if (!stageSel) return;
    stageSel.innerHTML = '<option>Carregando...</option>';
    try {
        const { stages } = await apiFetch(`/api/settings/stages?pipeline_id=${pipelineId}`);
        stageSel.innerHTML = stages.map(s =>
            `<option value="${s.id}">${s.name}</option>`
        ).join('') || '<option value="">Nenhuma etapa</option>';
    } catch {
        stageSel.innerHTML = '<option value="">Erro ao carregar</option>';
    }
}

function closeSettingsModal() {
    const modal = document.getElementById('modal-settings');
    if (modal) modal.style.display = 'none';
}

function handlePhotoUpload(input) {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
        toast('Foto muito grande (max 4MB)', 'error');
        return;
    }
    const reader = new FileReader();
    reader.onload = e => {
        const b64 = e.target.result;
        const preview = document.getElementById('settings-photo-preview');
        if (preview) {
            preview.innerHTML = `<img src="${b64}" alt="foto" />`;
            preview.dataset.photo = b64;
        }
    };
    reader.readAsDataURL(file);
}

async function saveSettings() {
    const isAdmin = currentUser?.role === 'Admin';
    const preview = document.getElementById('settings-photo-preview');

    try {
        // 1. Salva perfil pessoal (todos os users)
        const myName = document.getElementById('settings-my-name')?.value.trim();
        const profilePayload = { name: myName || '' };
        if (preview?.dataset.photo) profilePayload.avatar_url = preview.dataset.photo;

        await apiFetch('/api/settings/my-profile', {
            method: 'PATCH',
            body: JSON.stringify(profilePayload),
        });

        // Atualiza nome no header/localStorage
        if (myName && currentUser) {
            currentUser.name = myName;
            localStorage.setItem('ba_user', JSON.stringify(currentUser));
        }

        // 2. Se Admin, salva configs globais (bot, pipedrive)
        if (isAdmin) {
            const pipelineSel = document.getElementById('settings-pipeline');
            const stageSel    = document.getElementById('settings-stage');
            const ownerSel    = document.getElementById('settings-owner');

            if (pipelineSel && stageSel && ownerSel) {
                const ownerOpt    = ownerSel.options[ownerSel.selectedIndex];
                const pipelineOpt = pipelineSel.options[pipelineSel.selectedIndex];
                const stageOpt    = stageSel.options[stageSel.selectedIndex];

                const botModeSel = document.querySelector('input[name="bot-mode"]:checked');
                const payload = {
                    agent_name:  document.getElementById('settings-agent-name')?.value.trim() || '',
                    agent_photo: preview?.dataset.photo || _settingsData?.agent_photo || '',
                    bot_mode:    botModeSel?.value || 'ai',
                    away_enabled: document.getElementById('settings-away-enabled')?.checked || false,
                    away_minutes: parseInt(document.getElementById('settings-away-minutes')?.value) || 10,
                    away_message: document.getElementById('settings-away-message')?.value.trim() || '',
                    apollo_enabled: document.getElementById('settings-apollo-enabled')?.checked || false,
                    apollo_auto_match: document.getElementById('settings-apollo-auto-match')?.checked || false,
                    pipedrive_pipeline_id:   parseInt(pipelineSel.value) || null,
                    pipedrive_pipeline_name: pipelineOpt?.text || '',
                    pipedrive_stage_id:      parseInt(stageSel.value) || null,
                    pipedrive_stage_name:    stageOpt?.text || '',
                    pipedrive_owner_id:      ownerSel.value ? parseInt(ownerSel.value) : null,
                    pipedrive_owner_name:    ownerOpt?.text || 'Nao atribuido',
                };
                await apiFetch('/api/settings', { method: 'POST', body: JSON.stringify(payload) });
            }
        }

        toast('Configuracoes salvas!', 'success');
        closeSettingsModal();
    } catch (err) {
        toast(`Erro ao salvar: ${err.message}`, 'error');
    }
}

// --- Pipedrive Sync Button ---

async function syncLeadToPipedrive(leadId, btnEl) {
    if (!leadId) return;
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = '⏳ Enviando...'; }
    try {
        const res = await apiFetch(`/api/leads/${leadId}/sync-crm`, { method: 'POST' });
        if (res.already_synced) {
            toast(`Deal #${res.crm_deal_id} ja existente no Pipedrive`, 'info');
        } else {
            toast(`✅ ${res.message}`, 'success');
            if (btnEl) {
                btnEl.textContent = `✅ Deal #${res.crm_deal_id}`;
                btnEl.classList.add('synced');
                btnEl.disabled = false;
            }
        }
        loadLeads();
    } catch (err) {
        toast(`Erro ao enviar: ${err.message}`, 'error');
        if (btnEl) { btnEl.disabled = false; btnEl.textContent = '📤 Enviar Pipedrive'; }
    }
}


// --- HISTORY ---

async function loadHistory() {
    const search = document.getElementById('history-search')?.value || '';
    const status = document.getElementById('history-filter-status')?.value || '';
    const days   = document.getElementById('history-filter-days')?.value || '30';
    const tbody  = document.getElementById('history-tbody');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="8" class="loading-row">Carregando...</td></tr>';

    const params = new URLSearchParams({ limit: '100' });
    if (search) params.set('search', search);
    if (status) params.set('status', status);
    if (days)   params.set('days', days);

    try {
        const { conversations = [] } = await apiFetch(`/api/history?${params}`);

        if (!conversations.length) {
            tbody.innerHTML = '<tr><td colspan="8" class="loading-row">Nenhuma conversa encontrada</td></tr>';
            return;
        }

        tbody.innerHTML = conversations.map(conv => {
            const lead  = conv.leads || {};
            const date  = new Date(conv.updated_at || conv.created_at).toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' });
            const cls   = lead.classification || 'unclassified';
            const clsTags = { comercial: '🟢 Comercial', opec: '🟡 OPEC', unclassified: '⚪ Nao class.' };
            const statusLabels = { closed: '✅ Encerrada', in_progress: '💬 Em andamento', waiting: '⏳ Aguardando', human: '👤 Humano' };
            const crmLink = lead.crm_deal_id
                ? `<a href="https://brandmonitor.pipedrive.com/deal/${lead.crm_deal_id}" target="_blank" class="crm-synced">#${lead.crm_deal_id}</a>`
                : `<span class="crm-pending">—</span>`;

            return `<tr class="history-row" data-action="open-history" data-id="${conv.id}" data-name="${escHtml(lead.name||'Lead')}">
                <td>${date}</td>
                <td><strong>${escHtml(lead.name || '—')}</strong><br><span style="font-size:11px;color:var(--text-muted)">${escHtml(lead.phone || '')}</span></td>
                <td>${escHtml(lead.company_name || '—')}</td>
                <td><span style="font-size:11px">${conv.channel || 'whatsapp'}</span></td>
                <td><span class="tag tag-${cls}">${clsTags[cls] || cls}</span></td>
                <td><span style="font-size:11px">${statusLabels[conv.status] || conv.status || '—'}</span></td>
                <td>${crmLink}</td>
                <td><button class="btn-sm" data-action="open-history" data-id="${conv.id}" data-name="${escHtml(lead.name||'Lead')}">💬 Ver</button></td>
            </tr>`;
        }).join('');

    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="8" class="loading-row" style="color:var(--red)">Erro: ${err.message}</td></tr>`;
    }
}

async function openHistoryMessages(convId, leadName) {
    const modal = document.getElementById('modal-history-msgs');
    const body  = document.getElementById('modal-history-body');
    const title = document.getElementById('modal-history-title');
    if (!modal) return;

    if (title) title.textContent = `💬 ${leadName}`;
    if (body) body.innerHTML = '<div class="loading-row">Carregando...</div>';
    modal.style.display = 'flex';

    try {
        const { messages = [] } = await apiFetch(`/api/history/${convId}/messages`);

        if (!messages.length) {
            if (body) body.innerHTML = '<div class="loading-row">Nenhuma mensagem encontrada</div>';
            return;
        }

        if (body) {
            body.innerHTML = messages.map(msg => {
                const time = new Date(msg.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                const date = new Date(msg.created_at).toLocaleDateString('pt-BR');
                const cls  = msg.direction === 'inbound' ? 'inbound' : msg.sender_type === 'bot' ? 'bot' : 'outbound';
                const sender = msg.sender_type === 'bot' ? '🤖 Bot' : msg.direction === 'inbound' ? '👤 Lead' : '👩 Atendente';
                return `<div class="msg-bubble ${cls}" style="max-width:85%">
                    <div class="msg-text">${escHtml(msg.content || '')}</div>
                    <div class="msg-meta">
                        <span class="msg-sender ${cls === 'bot' ? 'bot-label' : ''}">${escHtml(sender)}</span>
                        <span class="msg-time">${date} ${time}</span>
                    </div>
                </div>`;
            }).join('');

            body.scrollTop = body.scrollHeight;
        }

    } catch (err) {
        if (body) body.innerHTML = `<div class="loading-row" style="color:var(--red)">Erro: ${escHtml(err.message)}</div>`;
    }
}

// Setup history filters
function setupHistoryFilters() {
    const histSearch = document.getElementById('history-search');
    const histStatus = document.getElementById('history-filter-status');
    const histDays   = document.getElementById('history-filter-days');

    histSearch?.addEventListener('input', debounce(loadHistory, 350));
    histStatus?.addEventListener('change', loadHistory);
    histDays?.addEventListener('change', loadHistory);
}


// ===================================================================
//  WINDOW EXPORTS — all functions used in inline onclick handlers
//  (necessary because script is type="module")
// ===================================================================
// ─── DEALS TAB (Pipedrive Integration) ─────────────────────────────
// ===================================================================

let _selectedDealForOutbound = null;
let _selectedContactForOutbound = null;

function loadDeals() {
    // Deals tab agora é busca — foca no input
    const input = document.getElementById('deals-search');
    if (input) { input.value = ''; input.focus(); }
    const results = document.getElementById('deals-results');
    if (results) results.innerHTML = '<div class="deals-empty">Digite o nome da empresa ou deal acima para buscar no Pipedrive</div>';
}

async function searchDeals() {
    const input = document.getElementById('deals-search');
    const results = document.getElementById('deals-results');
    if (!input || !results) return;

    const q = input.value.trim();
    if (q.length < 2) {
        results.innerHTML = '<div class="deals-empty">Digite pelo menos 2 caracteres para buscar</div>';
        return;
    }

    results.innerHTML = '<div class="deals-empty">Buscando...</div>';

    try {
        const data = await apiFetch(`/api/pipedrive/search-deals?q=${encodeURIComponent(q)}`);
        const deals = data?.deals || [];

        if (deals.length === 0) {
            results.innerHTML = '<div class="deals-empty">Nenhum deal encontrado para "' + escHtml(q) + '"</div>';
            return;
        }

        results.innerHTML = deals.map(d => {
            const statusCls = d.status === 'won' ? 'deal-won' : d.status === 'lost' ? 'deal-lost' : 'deal-open';
            const participants = d.participant_count || 0;
            return `
            <div class="deal-result-item" data-action="open-deal-contacts" data-deal-id="${d.id}">
                <div class="deal-result-left">
                    <div class="deal-result-title">${escHtml(d.title)}</div>
                    <div class="deal-result-meta">
                        <span class="deal-result-org">${escHtml(d.org_name)}</span>
                        <span class="deal-stage-badge">${escHtml(d.stage_name)}</span>
                        <span class="deal-status-badge ${statusCls}">${escHtml(d.status_label)}</span>
                        <span class="deal-result-value">${escHtml(d.value)}</span>
                    </div>
                    <div class="deal-result-person">
                        ${escHtml(d.person_name)} ${participants > 0 ? `(+${participants} participantes)` : ''}
                    </div>
                </div>
                <div class="deal-result-right">
                    <span class="deal-result-action">Ver contatos →</span>
                </div>
            </div>`;
        }).join('');
    } catch (err) {
        results.innerHTML = '<div class="deals-empty">Erro: ' + escHtml(err.message) + '</div>';
    }
}

// Cache do toggle Apollo (invalida após 60s pra pegar mudança de admin razoavelmente rápido)
let _apolloEnabledCache = { value: null, ts: 0 };
async function _getApolloEnabled() {
    // Feature ativa = toggle global admin + (Admin OU user com permissions.apollo_enabled)
    const isAdmin = currentUser?.role === 'Admin';
    const userAllowed = !!currentUser?.permissions?.apollo_enabled;
    if (!isAdmin && !userAllowed) return false;

    if (_apolloEnabledCache.value !== null && (Date.now() - _apolloEnabledCache.ts) < 60_000) {
        return _apolloEnabledCache.value;
    }
    try {
        const data = await apiFetch('/api/settings');
        const globalEnabled = !!data?.settings?.apollo_enabled;
        _apolloEnabledCache = { value: globalEnabled, ts: Date.now() };
        return globalEnabled;
    } catch {
        return false;
    }
}

function renderDealContactRow(c, apolloEnabled) {
    const phones = c.phones || [];
    const roleParts = [];
    if (c.job_title) roleParts.push(escHtml(c.job_title));
    if (c.org_name)  roleParts.push(escHtml(c.org_name));
    const roleLine = roleParts.length > 0
        ? `<div class="deal-contact-role">${roleParts.join(' · ')}</div>`
        : '';

    // Sem telefone → card não-clicável, botão "Extrair número" se Apollo disponível
    if (phones.length === 0) {
        const extractBtn = apolloEnabled
            ? `<button class="btn-apollo-enrich" type="button" data-action="apollo-extract-phone" data-person-id="${c.id}" data-person-name="${escHtml(c.name)}" title="Garimpar número com Apollo (1 crédito)">🔍 Extrair número</button>`
            : `<span class="deal-contact-nophone">Sem número</span>`;
        return `
            <div class="deal-contact-item deal-contact-no-phone" data-person-id="${c.id}" data-name="${escHtml(c.name)}">
                <div class="deal-contact-info">
                    <div class="deal-contact-name">${escHtml(c.name)}</div>
                    ${roleLine}
                    <div class="deal-contact-phone-empty">— sem telefone no Pipedrive —</div>
                </div>
                <div class="deal-contact-actions">
                    ${extractBtn}
                </div>
            </div>
        `;
    }

    // Com telefone: card clicável (inicia conversa) + botão Apollo pra enriquecer
    const apolloBtn = apolloEnabled
        ? `<button class="btn-apollo-enrich" type="button" data-action="apollo-enrich" data-person-id="${c.id}" data-person-name="${escHtml(c.name)}" title="Enriquecer dados com Apollo (1 crédito)">🔍 Apollo</button>`
        : '';
    // has_whatsapp vem do último apollo_enrichments completed (server-side join).
    // false → card bloqueado com badge "Sem WhatsApp"; null/undefined → comportamento padrão.
    const noWa = c.has_whatsapp === false;
    const cardClass = noWa ? 'deal-contact-no-whatsapp' : 'deal-contact-clickable';
    const rightAction = noWa
        ? '<span class="deal-contact-nophone deal-contact-nowa" title="Apollo achou número mas WhatsApp não está ativo. Tente email/LinkedIn ou confirme no Pipedrive.">⚠ Sem WhatsApp</span>'
        : '<span class="deal-result-action">Iniciar →</span>';
    return phones.map(phone => `
        <div class="deal-contact-item ${cardClass}" data-person-id="${c.id}" data-phone="${escHtml(phone)}" data-name="${escHtml(c.name)}">
            <div class="deal-contact-info">
                <div class="deal-contact-name">${escHtml(c.name)}</div>
                ${roleLine}
                <div class="deal-contact-phone">${escHtml(phone)}</div>
            </div>
            <div class="deal-contact-actions">
                ${apolloBtn}
                ${rightAction}
            </div>
        </div>
    `).join('');
}

async function apolloEnrichPerson(personId, personName, btnEl) {
    if (!personId) return;
    const card = btnEl?.closest('.deal-contact-item');
    const actionsEl = btnEl?.closest('.deal-contact-actions');
    try {
        if (btnEl) { btnEl.disabled = true; btnEl.textContent = '⏳ Garimpando...'; }
        const res = await apiFetch('/api/apollo/enrich-and-save/' + personId, { method: 'POST' });

        if (!res.matched) {
            replaceCardActions(actionsEl, '<span class="deal-contact-nophone">Apollo não encontrou</span>');
            if (card) card.classList.add('deal-contact-apollo-miss');
            toast('Apollo não encontrou dados para esse contato.', 'warning');
            return;
        }

        // Backend devolve phone_outcome explícito. Fallback pra compat com deploy antigo:
        const outcome = res.phone_outcome
            || (res.phone_pending ? 'reveal_pending' : 'had_in_pipedrive');

        if (outcome === 'had_in_pipedrive') {
            toastSyncEnrichment(res.sync_updated, { hadPhone: true });
            replaceCardActions(actionsEl, '<span class="deal-contact-nophone">Já tinha número</span>');
            return;
        }

        if (outcome === 'unavailable') {
            toastSyncEnrichment(res.sync_updated, { hadPhone: false });
            replaceCardActions(actionsEl, '<span class="deal-contact-nophone">Apollo não tem número</span>');
            if (card) card.classList.add('deal-contact-apollo-miss');
            return;
        }

        if (outcome === 'sync_returned' && res.phone) {
            renderPhoneFoundOnCard(card, actionsEl, res.phone, res.has_whatsapp);
            announcePhoneFound(res.phone, res.has_whatsapp);
            return;
        }

        // reveal_pending — espera webhook via polling
        if (btnEl) btnEl.textContent = '⏳ Aguardando Apollo...';
        const result = await pollApolloEnrichment(res.ref, 45_000);

        if (result?.phone) {
            renderPhoneFoundOnCard(card, actionsEl, result.phone, result.has_whatsapp);
            announcePhoneFound(result.phone, result.has_whatsapp);
        } else {
            replaceCardActions(actionsEl, '<span class="deal-contact-nophone">Apollo sem número</span>');
            if (card) card.classList.add('deal-contact-apollo-miss');
            toast('Apollo não conseguiu revelar o número deste contato.', 'warning');
        }
    } catch (err) {
        toast('Erro Apollo: ' + err.message, 'error');
        if (btnEl) { btnEl.disabled = false; btnEl.textContent = '🔍 Tentar novamente'; }
    }
}

// Toast contextual: distingue "achou e tem WA" / "achou mas sem WA" / "achou, WA não verificado".
function announcePhoneFound(phone, hasWhatsapp) {
    if (hasWhatsapp === false) {
        toast(`Número ${phone} encontrado — mas sem WhatsApp ativo. Tente email/LinkedIn.`, 'warning');
    } else if (hasWhatsapp === true) {
        toast(`Número encontrado: ${phone} ✓ (WhatsApp ativo)`, 'success');
    } else {
        toast(`Número encontrado: ${phone} ✓`, 'success');
    }
}

// Mostra toast contextual sobre os campos sync que Apollo trouxe (cargo/email).
// hadPhone indica se Pipedrive já tinha número (muda a frase de fallback).
function toastSyncEnrichment(syncUpdated, { hadPhone }) {
    const parts = [];
    if (syncUpdated?.job_title) parts.push(`cargo: ${syncUpdated.job_title}`);
    if (syncUpdated?.email) parts.push('email');
    if (parts.length > 0) {
        toast(`Apollo atualizou ${parts.join(', ')} ✓`, 'success');
    } else if (hadPhone) {
        toast('Apollo encontrou, mas não havia campos vazios para atualizar.', 'info');
    } else {
        toast('Apollo achou o contato, mas não tem o telefone dele.', 'warning');
    }
}

// Atualiza o card pra refletir o phone descoberto pelo Apollo.
// hasWhatsapp = true → card clicável (Iniciar →); false → bloqueado com badge "Sem WhatsApp ⚠";
// null → clicável + nota "WA não verificado" (Unipile instável, não vamos bloquear).
function renderPhoneFoundOnCard(card, actionsEl, phone, hasWhatsapp = null) {
    if (!card) return;
    card.classList.remove('deal-contact-no-phone');
    card.dataset.phone = phone;
    const emptyEl = card.querySelector('.deal-contact-phone-empty');
    if (emptyEl) {
        emptyEl.className = 'deal-contact-phone';
        emptyEl.textContent = phone;
    }
    if (hasWhatsapp === false) {
        card.classList.remove('deal-contact-clickable');
        card.classList.add('deal-contact-no-whatsapp');
        replaceCardActions(actionsEl,
            '<span class="deal-contact-nophone deal-contact-nowa" title="Apollo achou número mas WhatsApp não está ativo. Tente email/LinkedIn ou confirme no Pipedrive.">⚠ Sem WhatsApp</span>');
    } else {
        card.classList.add('deal-contact-clickable');
        const note = hasWhatsapp === null
            ? '<span class="deal-result-action-note" title="Verificação de WhatsApp indisponível agora — pode tentar mesmo assim.">WA não verificado</span>'
            : '';
        replaceCardActions(actionsEl, `${note}<span class="deal-result-action">Iniciar →</span>`);
    }
}

async function pollApolloEnrichment(ref, timeoutMs = 45_000) {
    const start = Date.now();
    const intervalMs = 3000;
    while (Date.now() - start < timeoutMs) {
        await new Promise(r => setTimeout(r, intervalMs));
        try {
            const data = await apiFetch('/api/apollo/enrichment/' + ref);
            if (data.status === 'completed') {
                return { phone: data.phone || null, has_whatsapp: data.has_whatsapp ?? null };
            }
            if (data.status === 'not_found' || data.status === 'error') return null;
        } catch { /* continua tentando */ }
    }
    return null; // timeout
}

function replaceCardActions(actionsEl, html) {
    if (!actionsEl) return;
    actionsEl.innerHTML = html;
}

async function openDealContacts(dealId) {
    const modal = document.getElementById('deal-contacts-modal');
    const list = document.getElementById('deal-contacts-list');
    const title = document.getElementById('deal-contacts-title');
    const form = document.getElementById('deal-outbound-form');
    if (!modal || !list) return;

    modal.style.display = 'flex';
    list.textContent = 'Carregando contatos...';
    if (form) form.style.display = 'none';
    _selectedContactForOutbound = null;
    _selectedDealForOutbound = dealId;

    try {
        const data = await apiFetch(`/api/pipedrive/deal/${dealId}/contacts`);
        const contacts = data?.contacts || [];
        if (title && data?.deal) title.textContent = `Contatos — ${data.deal.title}`;

        if (contacts.length === 0) {
            list.textContent = 'Nenhum contato com telefone encontrado neste deal.';
            return;
        }

        const apolloEnabled = await _getApolloEnabled();
        list.innerHTML = contacts.map(c => renderDealContactRow(c, apolloEnabled)).join('');

        // Click = seleciona e inicia conversa direto (botões Apollo têm ação separada)
        list.onclick = async (e) => {
            // Apollo: enriquecer dados (contato que já tem telefone)
            const enrichBtn = e.target.closest('[data-action="apollo-enrich"]');
            if (enrichBtn) {
                e.stopPropagation();
                await apolloEnrichPerson(enrichBtn.dataset.personId, enrichBtn.dataset.personName, enrichBtn);
                return;
            }

            // Apollo: extrair número (contato sem telefone no Pipedrive)
            const extractBtn = e.target.closest('[data-action="apollo-extract-phone"]');
            if (extractBtn) {
                e.stopPropagation();
                await apolloEnrichPerson(extractBtn.dataset.personId, extractBtn.dataset.personName, extractBtn);
                return;
            }

            const item = e.target.closest('.deal-contact-clickable');
            if (!item) return;

            _selectedContactForOutbound = {
                person_id: item.dataset.personId,
                phone: item.dataset.phone,
                name: item.dataset.name,
            };

            // Feedback visual
            item.style.opacity = '0.5';
            item.style.pointerEvents = 'none';
            const actionEl = item.querySelector('.deal-result-action');
            if (actionEl) actionEl.textContent = 'Criando...';

            await sendOutbound();
        };
    } catch (err) {
        list.textContent = 'Erro: ' + err.message;
    }
}

let _sendingOutbound = false;
async function sendOutbound() {
    // Guard contra double-click — sem isso, 2 conversas idênticas eram criadas
    // se o user clicasse rápido enquanto a 1ª request estava no ar.
    if (_sendingOutbound) return;
    if (!_selectedDealForOutbound || !_selectedContactForOutbound) {
        toast('Selecione um contato primeiro', 'warning');
        return;
    }
    _sendingOutbound = true;

    const btn = document.getElementById('btn-send-outbound');
    if (btn) { btn.disabled = true; btn.textContent = 'Criando conversa...'; }

    try {
        const res = await apiFetch('/api/pipedrive/start-outbound', {
            method: 'POST',
            body: JSON.stringify({
                deal_id: _selectedDealForOutbound,
                person_id: _selectedContactForOutbound.person_id,
                phone: _selectedContactForOutbound.phone,
            }),
        });

        toast(`Conversa com ${_selectedContactForOutbound.name} aberta no inbox!`, 'success');

        // Fecha modal e vai para o inbox
        closeDealContactsModal();
        switchTab('inbox');

        // (Tabs Tudo/Site/Prospecao removidas — todas conversas são prospecting)
        await loadInbox();

        // Seleciona a conversa recém criada — selectConversation tem fallback
        // que faz fetch individual se a conv não está em allConversations
        if (res.conversation_id) {
            await selectConversation(res.conversation_id);
        }
    } catch (err) {
        toast('Erro: ' + err.message, 'error');
    } finally {
        _sendingOutbound = false;
        if (btn) { btn.disabled = false; btn.textContent = 'Iniciar Conversa WhatsApp'; }
    }
}

function closeDealContactsModal() {
    const modal = document.getElementById('deal-contacts-modal');
    if (modal) modal.style.display = 'none';
}

async function importWhatsAppHistory() {
    const btn = document.getElementById('btn-import-history');
    if (btn) { btn.disabled = true; btn.textContent = 'Importando...'; }

    try {
        const res = await apiFetch('/api/conversations/import-history', { method: 'POST' });
        toast(`Importado: ${res.imported} conversas (${res.skipped} ja existiam)`, 'success');
        loadInbox();
    } catch (err) {
        toast('Erro: ' + err.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Importar Historico WhatsApp'; }
    }
}

// ===================================================================

// Auth
window.logout = logout;

// Tabs
window.switchTab = switchTab;
window.switchSettingsTab = switchSettingsTab;

// Inbox / Chat
window.selectConversation = selectConversation;
window.sendMsg            = sendMsg;
window.handleInputKey     = handleInputKey;
window.toggleScriptsMenu  = toggleScriptsMenu;
window.applyScript        = applyScript;
window.setInboxFilter     = setInboxFilter;

// Routing
window.routeConv = routeConv;
window.closeConv = closeConv;

// Leads
window.syncLeadToPipedrive = syncLeadToPipedrive;
window.exportLeadsCSV      = exportLeadsCSV;

// Scripts
window.editScript        = editScript;
window.deleteScript      = deleteScript;

// Modals
window.openModal  = openModal;
window.closeModal = closeModal;

// Settings
window.openSettingsModal   = openSettingsModal;
window.closeSettingsModal  = closeSettingsModal;
window.saveSettings        = saveSettings;
window.loadSettingsStages  = loadSettingsStages;
window.handlePhotoUpload   = handlePhotoUpload;

// Users
window.openAddUserForm       = openAddUserForm;
window.closeAddUserForm      = closeAddUserForm;
window.saveUser              = saveUser;
window.openEditUserForm      = openEditUserForm;
window.toggleUserActive      = toggleUserActive;
window.toggleTokenVisibility = toggleTokenVisibility;

// WhatsApp
window.openWaConnect      = openWaConnect;
window.closeWaConnect     = closeWaConnect;
window.generateWaQR       = generateWaQR;
window.disconnectWa       = disconnectWa;
window.copyReconnectUrl   = copyReconnectUrl;
window.closeReconnectArea = closeReconnectArea;

// History
window.openHistoryMessages      = openHistoryMessages;

// Dashboard
window.loadDashboard = loadDashboard;
