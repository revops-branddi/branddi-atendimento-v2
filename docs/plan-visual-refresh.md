# Visual Refresh (Geist + Azul Branddi + Temas) — Plano de Implementação

**Objetivo:** Aplicar no app o visual aprovado no mockup (`design_handoff_v2/mockup-redesign-final.html`) com a config validada pelo Sergio em 07/08/2026: **tema Claro (default) · accent Azul Branddi · densidade Compacta · mensagens Bolhas · painel do lead Fixo** — adicionando os temas Escuro e Alto Contraste como opção.

**Arquitetura:** Camada aditiva `public/css/theme.css` carregada DEPOIS de `style-v2.css`, seguindo o padrão já estabelecido no codebase (source-order wins entre `:root`; rollback = comentar 1 `<link>`). Zero mudança de lógica em `app.js` além de: registrar a pref `theme` no sistema de Aparência existente (`APPEARANCE_DEFAULTS`/`APPEARANCE_VALID`) e 1 linha no FOUC-guard. Backend (`src/`) intocado.

**Tech Stack:** CSS vanilla (custom properties), Geist + Geist Mono via Google Fonts, sistema de prefs existente (`localStorage["atd:prefs"]` + `data-*` no `<html>`).

**Verificação:** `npm test` (suite existente) + checklist manual "não quebrou nada" (seção final) + validação visual no preview da Vercel antes do merge.

**Delta real (recon 07/08):** o app JÁ é light/compact/bubbles com teal `#0F9D8F`. O que muda:
1. Fonte: DM Sans/Inter → Geist (+ Geist Mono para números)
2. Accent: teal `#0F9D8F` → Azul Branddi (`#177A8B` no light / `#0ACFDE` no dark)
3. Temas: hoje light hardcoded → sistema `[data-theme]` com dark + contrast opcionais
4. Login re-skin + polish pontual vs mockup

**Fora de escopo (decidido):** `/public/site` (fluxo morto — canal migrou pra Cloud API); consolidação dos 3 CSS num só (refactor futuro, quando o theme.css estabilizar); volta do modo tabular (removido do app em maio; Sergio escolheu Bolhas no mockup — YAGNI).

---

### Task 0: Branch

- [ ] **Step 0.1: Criar branch**

```bash
cd "/Users/sergiomunoz/CBM Claude/Atendimento-v2"
git checkout main && git pull && git checkout -b feat/visual-refresh
```

---

### Task 1: Fonte Geist + esqueleto do theme.css

**Arquivos:**
- Criar: `public/css/theme.css`
- Modificar: `public/index.html` (linhas 20–22: links de fonte; linha ~27: novo link CSS)

- [ ] **Step 1.1: Criar `public/css/theme.css`**

```css
/* ============================================================
   Branddi Atendimento — Visual Refresh (mockup aprovado 07/08/26)
   ============================================================
   Camada final da cascata: carregada DEPOIS de style.css e
   style-v2.css. Mesmo padrão aditivo do bloco v2 no fim do
   style-v2.css: redefine tokens em :root, source-order vence.
   ROLLBACK: comentar o <link href="/css/theme.css"> no index.html
   e restaurar os links de fonte antigos (DM Sans/Inter).
   Config aprovada: light default · Azul Branddi · compact · bubbles.
   ============================================================ */

/* ─── 1. Tipografia — Geist ─────────────────────────────────── */
:root {
  --font: 'Geist', 'DM Sans', system-ui, -apple-system, sans-serif;
  --font-mono: 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace;
}

/* Números, telefones, IDs, horários e valores em mono tabular */
.msg-time, .conv-time, .lead-phone, .lp-field .v.mono,
.stat-value, .kpi-value, .table-pro td.num {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 1.2: Trocar links de fonte no `public/index.html`**

Substituir (linhas 20–22):
```html
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
    <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&display=swap" rel="stylesheet" />
```
por:
```html
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
```

- [ ] **Step 1.3: Adicionar link do theme.css no `public/index.html`**

Logo após o link do `style-v2.css` (linha ~27):
```html
    <!-- Visual refresh (mockup 07/08/26). Comente a linha abaixo para rollback. -->
    <link rel="stylesheet" href="/css/theme.css" />
```

- [ ] **Step 1.4: Verificar**

```bash
npm start
```
Abrir `http://localhost:3838` → app renderiza em Geist (inspecionar `body` → computed font-family). Nada mais mudou.

- [ ] **Step 1.5: Rodar testes + commit**

```bash
npm test
git add public/css/theme.css public/index.html
git commit -m "feat: swap app typeface to Geist via theme.css layer"
```

---

### Task 2: Accent Azul Branddi (tema claro)

**Arquivos:**
- Modificar: `public/css/theme.css` (append)

- [ ] **Step 2.1: Append no `theme.css`**

```css
/* ─── 2. Accent — Azul Branddi (light) ──────────────────────
   Paleta oficial do manual: Azul #0ACFDE · Turquesa #299FB1 ·
   Teal #177A8B · Marinho #031C2D. No tema claro usamos o Teal
   oficial #177A8B (contraste AA sobre branco); o Azul #0ACFDE
   brilha no tema escuro (Task 4). */
:root {
  --accent:      #177A8B;
  --accent-50:   #E8F1F3;
  --accent-100:  #C6DFE4;
  --accent-300:  #6FAEBC;
  --accent-600:  #177A8B;
  --accent-700:  #115F6D;

  /* Legacy rgba tokens (consumidos pelo CSS antigo) */
  --accent-dim:    rgba(23, 122, 139, 0.10);
  --accent-soft:   rgba(23, 122, 139, 0.08);
  --accent-mid:    rgba(23, 122, 139, 0.20);
  --accent-glow:   rgba(23, 122, 139, 0.06);
  --border-accent: rgba(23, 122, 139, 0.30);

  /* Tokens que carregam o accent embutido */
  --bg-active:     rgba(23, 122, 139, 0.10);
  --msg-outbound:  #177A8B;
  --teal:          #177A8B;
}
```

- [ ] **Step 2.2: Caçar teal hardcoded fora de vars**

```bash
grep -n "0F9D8F\|15, 157, 143\|0f9d8f" public/style-v2.css public/style.css public/index.html public/app.js
```
Para cada ocorrência FORA de definição de var (ex.: `rgba(15,157,143,0.04)` no msg-outbound tabular, radio-card checked, etc.): trocar por `var(--accent-dim)` / `var(--bg-active)` conforme o caso — editar no próprio arquivo de origem (mudança de valor, não de estrutura).

- [ ] **Step 2.3: Verificar**

Reload → CTAs, tab ativa, badges "Em andamento", snippet "↩", borda das mensagens outbound: tudo azul petróleo `#177A8B`. Nenhum teal `#0F9D8F` sobrando (conferir visualmente Inbox + Settings + Lead Panel).

- [ ] **Step 2.4: Commit**

```bash
git add -A && git commit -m "feat: switch accent to official Branddi palette (light theme)"
```

---

### Task 3: Infra de temas (pref + FOUC + select na Aparência)

**Arquivos:**
- Modificar: `public/app.js` (linhas ~871–881: `APPEARANCE_DEFAULTS` / `APPEARANCE_VALID`)
- Modificar: `public/index.html` (FOUC script linhas 29–38 + seção Aparência ~linha 1040)

- [ ] **Step 3.1: Registrar pref `theme` no `app.js`**

```js
const APPEARANCE_DEFAULTS = {
    theme:        'light',
    messageStyle: 'bubbles',
    density:      'compact',
    chatBg:       'dots',
};
const APPEARANCE_VALID = {
    theme:        ['light', 'dark', 'contrast'],
    messageStyle: ['bubbles'],
    density:      ['compact', 'comfortable'],
    chatBg:       ['dots', 'watermark', 'pattern'],
};
```
(O `applyAppearancePrefsOnLoad` e o handler genérico `[data-pref]` já cuidam do resto — nada mais muda no JS.)

- [ ] **Step 3.2: FOUC-guard no `index.html`**

Adicionar 1 linha dentro do script existente (linha ~33):
```js
          if (prefs.theme) d.theme = prefs.theme;
```

- [ ] **Step 3.3: Select de Tema na Aparência (`index.html`, antes do select de mensagens ~linha 1040)**

Seguir o markup exato dos selects vizinhos (`settings-input` + `data-pref`):
```html
                        <div class="settings-field">
                            <label class="settings-label" for="pref-theme">Tema</label>
                            <select id="pref-theme" class="settings-input" data-pref="theme">
                                <option value="light">Claro</option>
                                <option value="dark">Escuro</option>
                                <option value="contrast">Alto contraste</option>
                            </select>
                        </div>
```
> Conferir a classe real do wrapper dos selects vizinhos antes de colar (ler bloco 1035–1060 inteiro) e replicar.

- [ ] **Step 3.4: Verificar**

Settings → Geral → Aparência → Tema: trocar pra "Escuro" seta `html[data-theme="dark"]` (ainda sem CSS = nada visível muda), persiste no reload via localStorage. Voltar pra Claro.

- [ ] **Step 3.5: Commit**

```bash
git add public/app.js public/index.html
git commit -m "feat: add theme preference plumbing (light/dark/contrast)"
```

---

### Task 4: Tema Escuro

**Arquivos:**
- Modificar: `public/css/theme.css` (append)

- [ ] **Step 4.1: Append bloco dark**

Os tokens legacy (`--bg-deep`, `--bg-surface`, etc.) já apontam via `var()` pros tokens base — redefinir os base é suficiente. Só os rgba literais precisam de redefinição própria.

```css
/* ─── 3. Tema Escuro ────────────────────────────────────────── */
[data-theme="dark"] {
  --bg-base:    #0B1014;
  --bg-elev-1:  #11181E;
  --bg-elev-2:  #1A2329;
  --bg-elev-3:  #232F37;
  --bg-hover:   #1A2329;
  --bg-active:  rgba(10, 207, 222, 0.12);

  --border-sm:  #1C262D;
  --border-md:  #232F37;
  --border-lg:  #2F3D47;

  --text-1:     #E8EEF1;
  --text-2:     #93A1AA;
  --text-3:     #5C6B75;
  --text-muted: #5C6B75;

  /* Azul Branddi oficial brilha no escuro */
  --accent:      #0ACFDE;
  --accent-50:   #07333A;
  --accent-100:  #0A454C;
  --accent-300:  #23AFC0;
  --accent-600:  #0ACFDE;
  --accent-700:  #56DEE9;

  --accent-dim:    rgba(10, 207, 222, 0.12);
  --accent-soft:   rgba(10, 207, 222, 0.08);
  --accent-mid:    rgba(10, 207, 222, 0.22);
  --accent-glow:   rgba(10, 207, 222, 0.06);
  --border-accent: rgba(10, 207, 222, 0.30);

  --msg-inbound:  #5C6B75;
  --msg-outbound: #0ACFDE;
  --teal:         #0ACFDE;

  --sh-sm: 0 1px 2px rgba(0,0,0,0.4);
  --sh-md: 0 4px 12px rgba(0,0,0,0.5);
  --sh-lg: 0 12px 32px rgba(0,0,0,0.6);
}
```

- [ ] **Step 4.2: Auditar hex hardcoded que quebram o dark**

```bash
grep -nE "#[Ff]{3,6}\b|#fff\b|white\b" public/style-v2.css | grep -v "^\s*--" | head -40
```
Alvos conhecidos (recon): fundos brancos literais em skeletons/scrollbar/print, o `background:#dc2626` inline do `topbar-down-badge` no index.html (→ `var(--danger)`), padrão de dots do `.chat-area::before`. Corrigir apenas o que aparece quebrado ao navegar TODAS as telas em dark (Inbox, Grupos, Deals, Leads, Scripts, Histórico, Dashboard, Settings, WA Connect, modais). Componentes que devem ficar brancos mesmo no dark (QR box, botão Google) NÃO mexer.

- [ ] **Step 4.3: Verificar + commit**

Tema Escuro em todas as telas sem "flashes brancos". Comparar com screenshot de referência `design_handoff_v2/img/mockup-02-inbox-dark-azul.png`.

```bash
git add -A && git commit -m "feat: add dark theme"
```

---

### Task 5: Tema Alto Contraste (AAA)

**Arquivos:**
- Modificar: `public/css/theme.css` (append)

- [ ] **Step 5.1: Append bloco contrast**

```css
/* ─── 4. Tema Alto Contraste (WCAG AAA) ─────────────────────── */
[data-theme="contrast"] {
  --bg-base:    #000000;
  --bg-elev-1:  #0A0A0A;
  --bg-elev-2:  #141414;
  --bg-elev-3:  #1F1F1F;
  --bg-hover:   #141414;
  --bg-active:  rgba(250, 204, 21, 0.14);

  --border-sm:  #2A2A2A;
  --border-md:  #2A2A2A;
  --border-lg:  #4A4A4A;

  --text-1:     #FFFFFF;
  --text-2:     #C9C9C9;
  --text-3:     #8A8A8A;
  --text-muted: #C9C9C9;

  --accent:      #FACC15;
  --accent-50:   #332A04;
  --accent-100:  #4A3D06;
  --accent-300:  #D4AC0D;
  --accent-600:  #FACC15;
  --accent-700:  #FDE047;

  --accent-dim:    rgba(250, 204, 21, 0.14);
  --accent-soft:   rgba(250, 204, 21, 0.10);
  --accent-mid:    rgba(250, 204, 21, 0.24);
  --accent-glow:   rgba(250, 204, 21, 0.08);
  --border-accent: rgba(250, 204, 21, 0.45);

  --success: #4ADE80;
  --warning: #FACC15;
  --danger:  #FB7185;
  --msg-inbound:  #8A8A8A;
  --msg-outbound: #FACC15;
  --teal:         #FACC15;
}
```

- [ ] **Step 5.2: Verificar + commit**

```bash
git add public/css/theme.css && git commit -m "feat: add high-contrast (AAA) theme"
```

---

### Task 6: Login re-skin

**Arquivos:**
- Modificar: `public/login.html` (link de fonte linha 19 + `<style>` inline linha 20+)

- [ ] **Step 6.1: Trocar fonte** — mesmo swap da Task 1 (Geist no lugar de DM Sans).

- [ ] **Step 6.2: Alinhar o `<style>` inline aos tokens aprovados**

Ler o `<style>` inteiro (306 linhas no arquivo) e ajustar valores: fundo `#F6F7F8` com radial `rgba(23,122,139,0.08)` no topo, card branco radius 16px borda `#E4E7EB`, accent `#177A8B`, textos `#0E1620`/`#5A6672`. Estrutura/IDs intocados (login Google + form e-mail funcionam por id).

- [ ] **Step 6.3: Verificar + commit**

Login local: Google button, form e-mail/senha, mensagens de erro — tudo funcional, visual = mockup ("Ver tela de login").

```bash
git add public/login.html && git commit -m "feat: restyle login page to approved design"
```

---

### Task 7: Polish + QA visual lado-a-lado com o mockup

**Arquivos:**
- Modificar: `public/css/theme.css` (append; correções pontuais nos arquivos de origem quando fizer sentido)

- [ ] **Step 7.1: Servir mockup + app lado a lado**

```bash
cd design_handoff_v2 && python3 -m http.server 8477 &
# mockup: http://localhost:8477/mockup-redesign-final.html · app: http://localhost:3838
```

- [ ] **Step 7.2: Checklist por tela** (corrigir divergências que saltam aos olhos; não perseguir pixel-perfect em tela secundária)

- [ ] Inbox: conv-row (borda ativa, unread, ↩ replied, AvatarStack, arquivada), chat header, banner "Enviando como", composer, bolhas dos 5 tipos
- [ ] Lead panel: abas, contact block, deal card, WA BB/FR/VM, etiquetas
- [ ] Grupos · Deals · Leads · Histórico: tabelas (header uppercase, hover, tags)
- [ ] Scripts: chips de categoria + cards
- [ ] Dashboard: KPI cards (valores em Geist Mono), gráficos legíveis nos 3 temas
- [ ] Modais Settings + WA Connect: tabs, radio-cards do bot, status pills

- [ ] **Step 7.3: Commit**

```bash
git add -A && git commit -m "polish: align components with approved mockup"
```

---

### Task 8: Validação "não quebrou nada" + testes

- [ ] `npm test` → suite verde
- [ ] Login Google funciona · Login e-mail/senha funciona
- [ ] Lista de conversas carrega e atualiza · clicar abre chat + lead panel
- [ ] Enviar mensagem funciona (chega no WhatsApp) · anotação interna salva
- [ ] Banner "Enviando como" + troca de conta (feature #189) intactos
- [ ] Filtros (Atendente/Usuário/Arquivadas) · busca ⌘K
- [ ] Scripts aplicam no chat · WA BB/FR/VM registram atividade
- [ ] Sincronizar Pipedrive · etiquetas togglam
- [ ] Grupos, Deals, Leads, Histórico, Dashboard carregam
- [ ] Settings salva (perfil, bot, prefs de aparência persistem no reload)
- [ ] WA Connect mostra QR
- [ ] Os 3 temas OK em todas as telas · rollback testado (comentar `<link>` volta ao visual atual)

---

### Task 9: PR + preview + merge

- [ ] **Step 9.1: Push + PR**

```bash
git push -u origin feat/visual-refresh
gh pr create --title "feat: visual refresh — Geist, official Branddi accent, theme system" --body "..."
```
PR body: screenshots dos 3 temas + link do mockup de referência + nota de rollback.

- [ ] **Step 9.2: Validação do Sergio no preview da Vercel** (checkpoint humano — visual é veredito dele)

- [ ] **Step 9.3: Merge + verificação em produção**
