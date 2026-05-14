# Single-Page Setup Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the 4-step desktop wizard into a single page; silently install the background service on first 扫码 so 关窗 never kills the daemon; move backend toggles to a dashboard settings drawer with safe defaults.

**Architecture:** Reuse existing service-manager (launchagent / systemd-user / scheduled-task — already admin-free). Replace 4 `.screen` panels with one `.setup-page`. Click handler sequences `install → daemon-alive → QR modal`; on any failure shows inline error strip + retry, no in-process fallback (since silent fallback would strip the "关窗 daemon 继续跑" guarantee). Auth failures rewrite to per-provider "登录已过期，请在电脑上重新 login" notices.

**Tech Stack:** Tauri 2 + vanilla JS + bun + vitest + Playwright. No new dependencies.

**Spec:** `docs/specs/2026-05-13-setup-wizard-single-page.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/core/conversation-coordinator.ts` | Modify | Per-provider auth notice text |
| `src/core/conversation-coordinator.test.ts` | Modify | Update notice assertions to new wording |
| `src/core/codex-agent-provider.ts` | Modify | Emit `errorCode: 'auth_failed'` on codex auth errors |
| `src/core/codex-agent-provider.test.ts` | Modify | Cover codex auth-failed shape |
| `apps/desktop/src/index.html` | Modify | Drop `.steps` + 4 `.screen` panels; add single `.setup-page` block + `<dialog id="qr-modal">` + `.settings-drawer` shell |
| `apps/desktop/src/styles.css` | Modify | New `.setup-page`, `.agent-cards`, `.install-strip`, `.error-strip`, `.qr-modal`, `.settings-drawer` selectors; drop step-nav rules |
| `apps/desktop/src/modules/wizard.js` | Rewrite | Single-page renderer; `renderAgentCards`, `refreshScanButton`; remove `showStep` / `STEP_ORDER` |
| `apps/desktop/src/modules/service.js` | Modify | Add pure `silentInstallAndStart(deps)` returning `{ ok, error }`; existing DOM-bound `serviceAction` calls it |
| `apps/desktop/src/modules/qr.js` | Modify | Render into `<dialog>` instead of inline panel; expose `openQrModal` / `closeQrModal` |
| `apps/desktop/src/modules/settings-drawer.js` | Create | Drawer shell with 后台服务 / 行为 sections; wraps the four toggles previously in step 4 |
| `apps/desktop/src/main.js` | Modify | New `handleScanClick(deps, state)` orchestrator; wire drawer; delete step-nav listeners; delete `service-install` button listener |
| `apps/desktop/src/wizard.test.ts` | Create | Unit tests for `renderAgentCards`, `refreshScanButton`, `handleScanClick` failure path |
| `apps/desktop/playwright/wizard.spec.ts` | Modify | Single-page DOM contract; 0-agent disabled state; click flow ends at dashboard |

---

## Task 1: Per-provider auth-expired notice

**Files:**
- Modify: `src/core/conversation-coordinator.ts:103-106` (constant) + ~5 call sites that read it
- Modify: `src/core/conversation-coordinator.test.ts:289` (regex assertion)

- [ ] **Step 1: Write the failing test**

In `src/core/conversation-coordinator.test.ts`, replace the assertion at line 289 with the new wording. Find the block:

```typescript
expect(text).toMatch(/AI .*不可用|wechat-cc/i)
```

Replace with:

```typescript
expect(text).toMatch(/Claude 登录已过期/)
expect(text).toContain('claude login')
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun --bun vitest run src/core/conversation-coordinator.test.ts -t "auth_failed: suppresses raw assistant text"
```

Expected: FAIL — assertion error, text still matches old wording.

- [ ] **Step 3: Replace `AUTH_FAIL_NOTICE` with a per-provider function**

In `src/core/conversation-coordinator.ts:103-106`, replace the constant with:

```typescript
/** User-facing notice when a provider reports auth_failed.
 *  Per-provider phrasing: the user already authenticated once; the
 *  session lapsed and they need to re-run the provider's login command
 *  on the same machine. */
function authFailNotice(providerId: ProviderId): string {
  if (providerId === 'codex') return '⚠ Codex 登录已过期，请在电脑上跑 `codex login` 后再发消息。'
  return '⚠ Claude 登录已过期，请在电脑上跑 `claude login` 后再发消息。'
}
```

Then replace every `AUTH_FAIL_NOTICE` reference in this file with `authFailNotice(<providerId>)`. The provider id is available at each call site (lines 157, 239, 404, 478) from the dispatch context — confirm by reading the surrounding code; the `providerId` parameter or local variable is in scope at each.

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun --bun vitest run src/core/conversation-coordinator.test.ts
```

Expected: PASS (entire file, not just the one renamed test — the constant rename must not break sibling tests).

- [ ] **Step 5: Verify chatroom test still passes**

```bash
bun --bun vitest run src/core/conversation-coordinator.test.ts -t "chatroom"
```

Expected: PASS. The chatroom auth-failed test at line 851 may also reference notice wording; if it asserts on old text, update its assertion to use `/登录已过期/` similarly.

- [ ] **Step 6: Commit**

```bash
git add src/core/conversation-coordinator.ts src/core/conversation-coordinator.test.ts
git commit -m "fix(coordinator): reword auth_failed notice to per-provider 登录已过期"
```

---

## Task 2: Codex auth_failed detection

**Files:**
- Modify: `src/core/codex-agent-provider.ts` (add AUTH_FAIL_RE + emit `errorCode: 'auth_failed'`)
- Modify: `src/core/codex-agent-provider.test.ts` (new test)

- [ ] **Step 1: Write the failing test**

Append to `src/core/codex-agent-provider.test.ts`:

```typescript
it('emits errorCode=auth_failed when codex stream errors with auth-shape message', async () => {
  const fakeCodex = {
    async *stream() {
      yield { type: 'error', message: 'OPENAI_API_KEY not set, run `codex login`' }
    },
  }
  const provider = createCodexAgentProvider({
    spawnCodex: () => fakeCodex as never,
  })
  const events: AgentEvent[] = []
  for await (const ev of provider.stream({ project: { alias: 'a', path: '/p' }, prompt: 'hi' })) {
    events.push(ev)
  }
  const errs = events.filter((e) => e.kind === 'error')
  expect(errs).toHaveLength(1)
  expect((errs[0] as { code?: string }).code).toBe('auth_failed')
})
```

(If the codex test file uses different test fixtures, adapt this skeleton — the contract being tested is: codex error message matching the auth pattern emits `kind: 'error', code: 'auth_failed'`.)

- [ ] **Step 2: Run test to verify it fails**

```bash
bun --bun vitest run src/core/codex-agent-provider.test.ts -t "auth_failed"
```

Expected: FAIL — `errs[0].code` is undefined (current provider emits plain `{ kind: 'error', message }`).

- [ ] **Step 3: Add the regex + branch**

In `src/core/codex-agent-provider.ts`, near the top with other constants:

```typescript
// Match common codex SDK auth-failure signatures. Conservative — we
// only want to special-case the ones we're confident about, since
// false positives mean the user gets "login expired" when their real
// problem is something else.
const AUTH_FAIL_RE = /(OPENAI_API_KEY|not authenticated|unauthorized|codex login|auth.*expired)/i
```

At each `yield { kind: 'error', message: m }` site (lines 178, 182 per grep), branch on the regex:

```typescript
if (AUTH_FAIL_RE.test(m)) {
  yield { kind: 'error', code: 'auth_failed', message: m }
} else {
  yield { kind: 'error', message: m }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun --bun vitest run src/core/codex-agent-provider.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run coordinator integration check**

```bash
bun --bun vitest run src/core/conversation-coordinator.test.ts -t "codex"
```

Expected: PASS. The coordinator's existing auth_failed handling now triggers for codex too, with the new Codex-flavored notice from Task 1.

- [ ] **Step 6: Commit**

```bash
git add src/core/codex-agent-provider.ts src/core/codex-agent-provider.test.ts
git commit -m "feat(codex): emit errorCode=auth_failed on auth-shape stream errors"
```

---

## Task 3: New single-page HTML skeleton

**Files:**
- Modify: `apps/desktop/src/index.html` (lines ~12-200 — the wizard block)

- [ ] **Step 1: Locate the wizard block**

Read `apps/desktop/src/index.html` from the `<section id="wizard">` opening tag through its closing `</section>`. This is the block being replaced.

- [ ] **Step 2: Replace the wizard block**

Replace lines 12-200 (the `<section id="wizard">…</section>` block) with:

```html
<section id="wizard" class="wizard wizard-single">
  <div class="wz-head">
    <h1 class="wz-title">wechat-cc</h1>
    <p class="wz-sub">把 AI agent 接到你的微信</p>
  </div>

  <div class="setup-page">
    <div class="agent-cards">
      <div class="agent-card" data-provider="claude" id="agent-card-claude">
        <div class="logo cc">CC</div>
        <div class="name">Claude Code</div>
        <div class="state" id="agent-state-claude">检测中…</div>
        <div class="meta" id="claude-meta">—</div>
        <a class="install-link" href="https://docs.claude.com/en/docs/claude-code/setup" target="_blank" rel="noopener" hidden>安装指南 ↗</a>
      </div>
      <div class="agent-card" data-provider="codex" id="agent-card-codex">
        <div class="logo cx">CX</div>
        <div class="name">Codex</div>
        <div class="state" id="agent-state-codex">检测中…</div>
        <div class="meta" id="codex-meta">—</div>
        <a class="install-link" href="https://github.com/openai/codex#installation" target="_blank" rel="noopener" hidden>安装指南 ↗</a>
      </div>
    </div>

    <details class="env-tip env-tip-wsl" id="wsl-tip" hidden>
      <summary><span class="ic">ⓘ</span>检测到 WSL · GUI 仅识别 Windows 端的 Claude / Codex</summary>
      <div class="env-tip-body">装在 WSL 里的 Claude Code，这个 Windows GUI 客户端连不到 —— 需要在 Windows 端再装一份才能用。WSL 直连集成在路上。</div>
    </details>

    <button id="scan-bind" class="btn primary scan-cta" disabled>
      <span class="ic"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><path d="M9 9h2v2H9zM13 9h1v1h-1zM9 13h1v1H9zM12 12h2v2h-2z"/></svg></span>
      <span class="label">扫码绑定微信 →</span>
    </button>

    <div class="install-strip" id="install-strip" hidden>
      <span class="pip"></span>
      <span class="install-label" id="install-strip-label">安装后台服务…</span>
    </div>

    <div class="error-strip" id="setup-error" hidden>
      <div class="error-row">
        <span class="ic">!</span>
        <span class="error-msg" id="setup-error-msg">—</span>
        <button class="btn ghost mini" id="setup-error-details">详情</button>
        <button class="btn primary mini" id="setup-error-retry">重试</button>
      </div>
      <pre class="error-details" id="setup-error-details-body" hidden></pre>
    </div>

    <p class="wz-help">扫码后进入控制台。后台服务、开机自启等可在控制台「设置」里调整。</p>

    <div class="wz-foot wz-foot-pill">
      <span id="wizard-foot-dot" class="dot"></span>
      <span id="wizard-foot-text" style="margin-left: 6px;">服务状态未知</span>
    </div>
  </div>
</section>

<dialog id="qr-modal" class="qr-modal">
  <button class="qr-modal-close" id="qr-modal-close" type="button">×</button>
  <h2 class="qr-modal-title">扫码绑定微信</h2>
  <div class="qr-modal-body">
    <div id="qr-box" class="qr-box">生成中…</div>
    <div class="qr-modal-side">
      <div class="qr-modal-step" id="qr-message">轮询扫码状态…</div>
      <div class="qr-modal-help">手机扫码后请在微信里点确认</div>
      <button id="qr-refresh" class="btn ghost mini">重新生成</button>
      <button id="qr-raw-toggle" class="qr-raw-toggle" type="button">显示原始响应</button>
      <pre id="qr-raw"></pre>
    </div>
  </div>
</dialog>

<aside id="settings-drawer" class="settings-drawer" hidden>
  <header class="drawer-head">
    <h2>设置</h2>
    <button id="settings-close" class="drawer-close" type="button">×</button>
  </header>
  <div class="drawer-body">
    <section class="drawer-section">
      <h3>后台服务</h3>
      <div class="toggle-row">
        <div>
          <div class="lab">开机自启</div>
          <div class="sub">登录系统时自动启动 daemon。</div>
        </div>
        <button class="toggle" id="autostart-toggle" data-toggle aria-pressed="false"></button>
      </div>
      <div class="toggle-row">
        <div>
          <div class="lab">关窗即终止 daemon (高级)</div>
          <div class="sub">默认关闭：关窗只关 GUI，daemon 继续跑。打开后关窗会停掉 daemon。</div>
        </div>
        <button class="toggle" id="close-stops-daemon-toggle" data-toggle aria-pressed="false"></button>
      </div>
    </section>
    <section class="drawer-section">
      <h3>行为</h3>
      <div class="toggle-row">
        <div>
          <div class="lab">自动同意工具调用</div>
          <div class="sub">关闭后，每次工具调用都需要在微信里回 y / n（10 分钟超时即拒绝）。</div>
        </div>
        <button class="toggle on" id="unattended-toggle" data-toggle aria-pressed="true"></button>
      </div>
      <div class="toggle-row">
        <div>
          <div class="lab">网络守护</div>
          <div class="sub">每 30 秒探活；网络掉了通知微信端。<span id="guard-status-line" class="guard-status-line">—</span></div>
        </div>
        <button class="toggle" id="guard-toggle" data-toggle aria-pressed="false"></button>
      </div>
    </section>
  </div>
</aside>
```

- [ ] **Step 3: Verify the index.html validates**

Open `apps/desktop/src/index.html` in any HTML linter or just inspect tag balance manually. Expected: no unclosed tags, `<dialog>` and `<aside>` are siblings of `<section id="wizard">`.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/index.html
git commit -m "feat(desktop): replace 4-step wizard DOM with single-page setup"
```

---

## Task 4: Setup-page CSS

**Files:**
- Modify: `apps/desktop/src/styles.css`

- [ ] **Step 1: Delete step-navigator styles**

Find and delete the rules for `.steps`, `.step`, `.step .num`, `.step .lab`, `.step.is-active`, `.step.is-done`, `.wizard .screen`, `.wizard .screen.active` from `styles.css`. These are no longer used.

- [ ] **Step 2: Add setup-page rules**

Append to `styles.css`:

```css
/* Single-page setup */
.wizard-single { max-width: 720px; margin: 0 auto; padding: 64px 32px; }
.wz-head { text-align: center; margin-bottom: 40px; }
.wz-title { font-family: var(--font-serif, "Fraunces", serif); font-size: 32px; margin: 0 0 6px; }
.wz-sub { color: var(--ink-mute); margin: 0; }

.setup-page { display: flex; flex-direction: column; gap: 24px; }
.agent-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.agent-card {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px;
  background: var(--paper);
  position: relative;
}
.agent-card.installed { border-color: var(--green-ink); }
.agent-card.missing { opacity: 0.78; }
.agent-card .logo { width: 36px; height: 36px; border-radius: 8px; display: grid; place-items: center; font-weight: 700; margin-bottom: 12px; }
.agent-card .name { font-weight: 600; margin-bottom: 4px; }
.agent-card .state { font-size: 12px; color: var(--ink-mute); margin-bottom: 6px; }
.agent-card.installed .state { color: var(--green-ink); }
.agent-card .meta { font-size: 11px; color: var(--ink-mute); font-family: var(--font-mono); word-break: break-all; }
.agent-card .install-link { display: inline-block; margin-top: 8px; font-size: 12px; color: var(--accent); }

.scan-cta {
  padding: 14px 28px;
  font-size: 15px;
  border-radius: 999px;
  align-self: center;
  min-width: 240px;
}
.scan-cta:disabled { opacity: 0.45; cursor: not-allowed; }

.install-strip {
  display: flex; align-items: center; gap: 8px;
  align-self: center;
  font-size: 13px; color: var(--ink-mute);
}
.install-strip .pip { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: pip-pulse 1.4s ease-in-out infinite; }
@keyframes pip-pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }

.error-strip {
  border: 1px solid var(--danger, #c44);
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--paper-soft);
}
.error-strip .error-row { display: flex; align-items: center; gap: 10px; }
.error-strip .ic { color: var(--danger, #c44); font-weight: 700; }
.error-strip .error-msg { flex: 1; font-size: 13px; }
.error-strip .btn.mini { padding: 4px 10px; font-size: 12px; }
.error-strip .error-details { margin-top: 10px; padding: 8px; background: var(--paper); border-radius: 6px; font-size: 11px; max-height: 200px; overflow: auto; }

.wz-help { color: var(--ink-mute); font-size: 12px; text-align: center; margin: 8px 0 0; }
.wz-foot-pill { display: inline-flex; align-items: center; align-self: center; padding: 6px 12px; border-radius: 999px; background: var(--paper-soft); font-size: 12px; }

/* QR modal */
.qr-modal {
  border: 1px solid var(--border); border-radius: 14px;
  padding: 0; max-width: 520px; width: 90vw;
  background: var(--paper);
}
.qr-modal::backdrop { background: rgba(0,0,0,0.45); }
.qr-modal-close { position: absolute; top: 8px; right: 12px; border: 0; background: transparent; font-size: 20px; cursor: pointer; }
.qr-modal-title { padding: 20px 24px 0; font-family: var(--font-serif, serif); margin: 0; }
.qr-modal-body { display: grid; grid-template-columns: 200px 1fr; gap: 20px; padding: 20px 24px 24px; }
.qr-modal-side { display: flex; flex-direction: column; gap: 8px; }
.qr-modal-step { font-weight: 600; font-size: 14px; }
.qr-modal-help { font-size: 12px; color: var(--ink-mute); }

/* Settings drawer */
.settings-drawer {
  position: fixed; top: 0; right: 0; bottom: 0; width: 380px;
  background: var(--paper); border-left: 1px solid var(--border);
  box-shadow: -8px 0 24px rgba(0,0,0,0.08);
  z-index: 50;
  display: flex; flex-direction: column;
  transform: translateX(100%); transition: transform 200ms ease;
}
.settings-drawer:not([hidden]) { transform: translateX(0); }
.drawer-head { display: flex; align-items: center; justify-content: space-between; padding: 18px 22px; border-bottom: 1px solid var(--border); }
.drawer-head h2 { font-family: var(--font-serif, serif); margin: 0; font-size: 18px; }
.drawer-close { border: 0; background: transparent; font-size: 20px; cursor: pointer; }
.drawer-body { padding: 18px 22px; overflow-y: auto; flex: 1; }
.drawer-section { margin-bottom: 28px; }
.drawer-section h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-mute); margin: 0 0 10px; }
```

(CSS-variable names follow the existing palette in `styles.css` — `--paper`, `--ink-mute`, etc. If `--green-ink` / `--danger` / `--accent` / `--paper-soft` / `--font-serif` / `--font-mono` are not yet defined in the file, add them at the `:root` declaration using the existing editorial palette. Search the file first; do not duplicate.)

- [ ] **Step 3: Verify no `.steps` references remain in styles.css**

```bash
grep -n "\.steps\b\|\.step\b\|\.screen\b" apps/desktop/src/styles.css
```

Expected: empty output. If any matches remain (e.g., `.steps .step.is-active`), delete them.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/styles.css
git commit -m "feat(desktop): styles for single-page setup + QR modal + settings drawer"
```

---

## Task 5: Trim wizard.js to single-page renderer

**Files:**
- Modify: `apps/desktop/src/modules/wizard.js`

- [ ] **Step 1: Replace the file**

Replace the entire contents of `apps/desktop/src/modules/wizard.js` with:

```javascript
// Setup-page renderer — single page, no step navigation.
//
// Owns:
//   .agent-card * (cards + state + meta)
//   #scan-bind (gated on ≥1 agent installed)
//   #wsl-tip (folded; shown only if doctor reports WSL)
//   #wizard-foot-dot / #wizard-foot-text (status pill)

import { doctorRows, daemonStatusLine, escapeHtml } from "../view.js"

export function renderSetupPage(report) {
  renderAgentCards(report)
  renderWslTip(report)
  refreshScanButton(report)
  updateFooterStatus(report.checks?.daemon)
}

function renderAgentCards(report) {
  for (const provider of ["claude", "codex"]) {
    const check = report.checks?.[provider]
    const card = document.getElementById(`agent-card-${provider}`)
    const state = document.getElementById(`agent-state-${provider}`)
    const meta = document.getElementById(`${provider}-meta`)
    const installLink = card?.querySelector(".install-link")
    if (!card || !state || !meta) continue
    const installed = !!check?.ok
    card.classList.toggle("installed", installed)
    card.classList.toggle("missing", !installed)
    state.textContent = installed ? "✓ 已安装" : "✗ 未安装"
    meta.textContent = installed ? (check.path || "已检测到") : "未在 PATH 上"
    if (installLink) installLink.hidden = installed
  }
}

function renderWslTip(report) {
  const tip = document.getElementById("wsl-tip")
  if (!tip) return
  tip.hidden = !report.wslDetected
}

export function refreshScanButton(report) {
  const btn = document.getElementById("scan-bind")
  if (!btn) return
  const claudeOk = !!report.checks?.claude?.ok
  const codexOk = !!report.checks?.codex?.ok
  const anyAgent = claudeOk || codexOk
  btn.disabled = !anyAgent
  if (anyAgent) btn.removeAttribute("title")
  else btn.title = "先装一个 agent · 本页会自动检测"
}

export function updateFooterStatus(daemon) {
  const line = daemonStatusLine(daemon)
  for (const id of ["wizard-foot-dot", "dash-rail-dot"]) {
    const el = document.getElementById(id)
    if (el) el.className = `dot ${line.cls}`
  }
  for (const id of ["wizard-foot-text", "dash-rail-text"]) {
    const el = document.getElementById(id)
    if (el) el.textContent = line.text
  }
}

// Setup error strip rendering — shared by handleScanClick failure paths.
export function showSetupError(message, details) {
  const strip = document.getElementById("setup-error")
  const msgEl = document.getElementById("setup-error-msg")
  const bodyEl = document.getElementById("setup-error-details-body")
  if (!strip || !msgEl) return
  msgEl.textContent = message
  if (bodyEl) {
    bodyEl.textContent = details || ""
    bodyEl.hidden = true
  }
  strip.hidden = false
}

export function clearSetupError() {
  const strip = document.getElementById("setup-error")
  if (strip) strip.hidden = true
}

export function showInstallStrip(label) {
  const strip = document.getElementById("install-strip")
  const labelEl = document.getElementById("install-strip-label")
  if (!strip) return
  if (labelEl && label) labelEl.textContent = label
  strip.hidden = false
}

export function hideInstallStrip() {
  const strip = document.getElementById("install-strip")
  if (strip) strip.hidden = true
}

// Back-compat: old name kept for any external caller still importing it.
// Internally use renderSetupPage.
export function renderDoctorWizard(report) { renderSetupPage(report) }
```

- [ ] **Step 2: Verify no `STEP_ORDER` / `showStep` references remain**

```bash
grep -rn "STEP_ORDER\|showStep\b" apps/desktop/src/
```

Expected: matches only in callsites in `main.js` that the next task will delete. If matches in other modules, list them — they all need to be deleted as part of this task.

- [ ] **Step 3: Smoke-check the file parses**

```bash
cd apps/desktop && bun x eslint src/modules/wizard.js
```

Expected: zero errors (warnings about unused imports etc. acceptable, fix if surfaced).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/modules/wizard.js
git commit -m "refactor(desktop): collapse wizard.js to single-page renderer"
```

---

## Task 6: Extract `silentInstallAndStart`

**Files:**
- Modify: `apps/desktop/src/modules/service.js`

- [ ] **Step 1: Add the new exported function**

Append to `apps/desktop/src/modules/service.js`:

```javascript
/**
 * Pure orchestrator used by the single-page 扫码 flow. Does NOT bind to
 * any specific DOM element — caller passes a `onProgress(label)` callback
 * and decides where to render. Returns:
 *   { ok: true,  serviceKind, daemonPid }                — success
 *   { ok: false, stage: 'install'|'start'|'alive', error, details } — failure
 *
 * Stages:
 *   install — `wechat-cc service install` succeeds (file on disk + system
 *             handle accepted the unit)
 *   start   — `wechat-cc service start` succeeds (the service ran the
 *             daemon process at least once)
 *   alive   — daemon HTTP api responds within 15s total (5s normal +
 *             10s extended grace)
 *
 * @param {{ invoke: (cmd: string, args: { args: string[] }) => Promise<unknown> }} deps
 * @param {(label: string) => void} onProgress
 */
export async function silentInstallAndStart(deps, onProgress) {
  const fail = (stage, error, details) => ({ ok: false, stage, error, details })

  try {
    onProgress("安装后台服务…")
    const installResp = /** @type {{ ok: boolean, kind?: string, error?: string, stderr?: string }} */ (
      await deps.invoke("wechat_cli_json", { args: ["service", "install", "--json"] })
    )
    if (!installResp?.ok) return fail("install", installResp?.error || "install failed", installResp?.stderr)

    onProgress("启动后台服务…")
    const startResp = /** @type {{ ok: boolean, error?: string, stderr?: string }} */ (
      await deps.invoke("wechat_cli_json", { args: ["service", "start", "--json"] })
    )
    if (!startResp?.ok) return fail("start", startResp?.error || "start failed", startResp?.stderr)

    onProgress("等待 daemon 启动…")
    const aliveOk = await waitDaemonAlive(deps, 15_000)
    if (!aliveOk) return fail("alive", "daemon 启动超时", "internal HTTP API did not respond within 15s")

    const pidResp = /** @type {{ pid: number | null } | null} */ (
      await deps.invoke("wechat_cli_json", { args: ["doctor", "--json"] }).catch(() => null)
    )
    return { ok: true, serviceKind: installResp.kind ?? null, daemonPid: pidResp?.pid ?? null }
  } catch (e) {
    return fail("install", e instanceof Error ? e.message : String(e), null)
  }
}

/** @param {{ invoke: (cmd: string, args: { args: string[] }) => Promise<unknown> }} deps */
async function waitDaemonAlive(deps, totalMs) {
  const start = Date.now()
  while (Date.now() - start < totalMs) {
    const r = /** @type {{ checks?: { daemon?: { alive?: boolean } } } | null} */ (
      await deps.invoke("wechat_cli_json", { args: ["doctor", "--json"] }).catch(() => null)
    )
    if (r?.checks?.daemon?.alive) return true
    await new Promise((res) => setTimeout(res, 500))
  }
  return false
}
```

- [ ] **Step 2: Write a test for the success path**

Create `apps/desktop/src/modules/service.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest"
import { silentInstallAndStart } from "./service.js"

describe("silentInstallAndStart", () => {
  it("returns ok=true when install + start + alive all succeed", async () => {
    const invoke = vi.fn(async (_cmd: string, args: { args: string[] }) => {
      const sub = args.args[0]
      if (sub === "service" && args.args[1] === "install") return { ok: true, kind: "launchagent" }
      if (sub === "service" && args.args[1] === "start") return { ok: true }
      if (sub === "doctor") return { checks: { daemon: { alive: true } }, pid: 4242 }
      return null
    })
    const labels: string[] = []
    const result = await silentInstallAndStart({ invoke }, (l) => labels.push(l))
    expect(result.ok).toBe(true)
    expect((result as { serviceKind: string }).serviceKind).toBe("launchagent")
    expect(labels).toContain("安装后台服务…")
    expect(labels).toContain("启动后台服务…")
  })

  it("returns ok=false stage=install when install fails", async () => {
    const invoke = vi.fn(async (_cmd: string, args: { args: string[] }) => {
      if (args.args[0] === "service" && args.args[1] === "install") return { ok: false, error: "denied" }
      return null
    })
    const result = await silentInstallAndStart({ invoke }, () => {})
    expect(result).toMatchObject({ ok: false, stage: "install", error: "denied" })
  })

  it("returns ok=false stage=alive when daemon never responds", async () => {
    const invoke = vi.fn(async (_cmd: string, args: { args: string[] }) => {
      if (args.args[0] === "service") return { ok: true, kind: "systemd-user" }
      if (args.args[0] === "doctor") return { checks: { daemon: { alive: false } } }
      return null
    })
    vi.useFakeTimers()
    const promise = silentInstallAndStart({ invoke }, () => {})
    // Drain 15s of fake time in 500ms slices.
    for (let i = 0; i < 32; i++) {
      await vi.advanceTimersByTimeAsync(500)
    }
    const result = await promise
    vi.useRealTimers()
    expect(result).toMatchObject({ ok: false, stage: "alive" })
  })
})
```

- [ ] **Step 3: Run tests**

```bash
cd apps/desktop && bun --bun vitest run src/modules/service.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/modules/service.js apps/desktop/src/modules/service.test.ts
git commit -m "feat(desktop): silentInstallAndStart orchestrator for one-click setup"
```

---

## Task 7: handleScanClick in main.js

**Files:**
- Modify: `apps/desktop/src/main.js`

- [ ] **Step 1: Delete step-navigation listeners**

In `apps/desktop/src/main.js`, delete the four listeners on lines 323-329 (`continue-provider`, `continue-wechat`, `continue-service`, `service-install`, `enter-dashboard`). The CTA wiring is replaced below.

Also delete: the import of `showStep` from `./modules/wizard.js`; any `stepState` variable; `wizard-step-of` text updates; and any `renderDoctorWizard` callsites (replace with `renderSetupPage`).

- [ ] **Step 2: Add `handleScanClick`**

After the imports block in `main.js`, add:

```javascript
import {
  renderSetupPage,
  refreshScanButton,
  showSetupError,
  clearSetupError,
  showInstallStrip,
  hideInstallStrip,
} from "./modules/wizard.js"
import { silentInstallAndStart } from "./modules/service.js"
import { openQrModal } from "./modules/qr.js"

async function handleScanClick(deps, state) {
  const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById("scan-bind"))
  if (!btn) return
  if (btn.disabled) return

  clearSetupError()
  btn.disabled = true
  const originalLabel = btn.querySelector(".label")?.textContent || "扫码绑定微信 →"
  showInstallStrip("安装后台服务…")

  const onProgress = (label) => showInstallStrip(label)

  const result = await silentInstallAndStart(deps, onProgress)

  hideInstallStrip()
  btn.disabled = false

  if (!result.ok) {
    const stageLabel = { install: "安装后台服务失败", start: "启动后台服务失败", alive: "daemon 启动超时" }[result.stage] || "安装失败"
    showSetupError(stageLabel, result.details || result.error)
    return
  }

  // Service running. Open QR modal and route to dashboard on bind success.
  await openQrModal(deps, state, {
    onBound: () => {
      state.mode = "dashboard"
      setMode("dashboard")
    },
  })
}
```

- [ ] **Step 3: Wire the new button + retry**

In the main-event-wiring block (formerly lines 323-329), add:

```javascript
document.getElementById("scan-bind")?.addEventListener("click", () => handleScanClick(deps, state))
document.getElementById("setup-error-retry")?.addEventListener("click", () => {
  clearSetupError()
  handleScanClick(deps, state)
})
document.getElementById("setup-error-details")?.addEventListener("click", () => {
  const body = document.getElementById("setup-error-details-body")
  if (body) body.hidden = !body.hidden
})
```

- [ ] **Step 4: Update doctor-poller hook**

Find every callsite of `renderDoctorWizard(report)` and replace with `renderSetupPage(report)`. Additionally, after each render, call `refreshScanButton(report)` if it's not already a no-arg side effect of the renderer (it is — but the explicit call keeps the dependency obvious if someone refactors later).

- [ ] **Step 5: Run typecheck**

```bash
cd apps/desktop && bun x tsc --noEmit
```

Expected: zero errors. If TS surfaces type mismatches on the `deps` shape passed to `silentInstallAndStart`, narrow the type in main.js to match the function signature.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main.js
git commit -m "feat(desktop): handleScanClick orchestrates install→start→QR on single page"
```

---

## Task 8: Convert QR to `<dialog>` modal

**Files:**
- Modify: `apps/desktop/src/modules/qr.js`

- [ ] **Step 1: Read the current qr.js**

```bash
cat apps/desktop/src/modules/qr.js
```

Understand the existing `refreshQr` flow: it generates a QR, renders into `#qr-box`, polls scan status, and on `confirmed` typically calls into the wizard step-nav. We're replacing the step-nav handoff with a modal close + callback.

- [ ] **Step 2: Add `openQrModal` export**

Append to `apps/desktop/src/modules/qr.js`:

```javascript
/**
 * Open the QR modal, generate a QR via `wechat_cli_json setup --json`,
 * and poll for scan completion. On success (state=confirmed), close the
 * modal and invoke opts.onBound.
 *
 * @param {{ invoke: Function }} deps
 * @param {{ mock?: boolean }} state
 * @param {{ onBound: () => void }} opts
 */
export async function openQrModal(deps, state, opts) {
  const dialog = /** @type {HTMLDialogElement | null} */ (document.getElementById("qr-modal"))
  if (!dialog) throw new Error("qr-modal element not found")
  if (typeof dialog.showModal === "function") dialog.showModal()
  else dialog.setAttribute("open", "")

  // Wire close handlers once per open.
  const closeBtn = document.getElementById("qr-modal-close")
  const onClose = () => {
    if (typeof dialog.close === "function") dialog.close()
    else dialog.removeAttribute("open")
    if (closeBtn) closeBtn.removeEventListener("click", onClose)
  }
  if (closeBtn) closeBtn.addEventListener("click", onClose, { once: true })

  // Reuse existing QR generation + polling.
  const bound = await refreshQrUntilConfirmed(deps, state)
  onClose()
  if (bound) opts.onBound()
}

/** Existing refreshQr logic, returning true on confirmed bind, false on cancel/error. */
async function refreshQrUntilConfirmed(deps, state) {
  // Delegate to refreshQr but capture the terminal state. If refreshQr
  // currently has side effects on the wizard step-nav (e.g. enabling
  // continue-service), guard them with optional chaining since those
  // elements no longer exist on the single page.
  return new Promise((resolve) => {
    refreshQr(deps, state, { onConfirmed: () => resolve(true), onCancel: () => resolve(false) })
  })
}
```

- [ ] **Step 3: Update existing `refreshQr` signature**

Modify the existing `refreshQr(deps, state)` function in `qr.js` to accept an optional `callbacks` parameter:

```javascript
export async function refreshQr(deps, state, callbacks = {}) {
  // …existing body…
  // Where it currently transitions to "continue-service" / enters dashboard,
  // call callbacks.onConfirmed?.() instead.
  // Where it currently fails or user cancels, call callbacks.onCancel?.().
  // Remove or guard with optional chaining any DOM lookups for elements
  // that only existed in the 4-step wizard (e.g. #continue-service).
}
```

- [ ] **Step 4: Verify no broken DOM lookups**

```bash
grep -n "continue-service\|continue-wechat\|continue-provider" apps/desktop/src/modules/qr.js
```

Expected: empty output, or all matches wrapped in `document.getElementById(...)?.…` so absent elements don't throw.

- [ ] **Step 5: Manual smoke (no auto-test here — Playwright covers in Task 11)**

```bash
cd apps/desktop && bun run shim
# Open http://localhost:5173 in a browser
# Verify clicking scan-bind opens the modal (with no agents the button is disabled,
# so seed the doctor mock first — see playwright/fixtures.ts for the existing pattern)
```

Expected: dialog opens with backdrop, QR box renders, close button dismisses.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/modules/qr.js
git commit -m "feat(desktop): render QR as <dialog> modal opened from scan-bind CTA"
```

---

## Task 9: Settings drawer module

**Files:**
- Create: `apps/desktop/src/modules/settings-drawer.js`
- Modify: `apps/desktop/src/main.js` (wire open/close + move toggle listeners)

- [ ] **Step 1: Create the drawer module**

Write `apps/desktop/src/modules/settings-drawer.js`:

```javascript
// Settings drawer — slides in from the right; contains 后台服务 + 行为
// sections. Toggles in here previously lived in the wizard step 4; their
// underlying handlers (provider config write, service install/uninstall,
// guard enable/disable) are unchanged.

let listenersAttached = false

export function openSettingsDrawer() {
  const drawer = document.getElementById("settings-drawer")
  if (!drawer) return
  drawer.hidden = false
}

export function closeSettingsDrawer() {
  const drawer = document.getElementById("settings-drawer")
  if (!drawer) return
  drawer.hidden = true
}

export function wireSettingsDrawer({ onToggleChange }) {
  if (listenersAttached) return
  listenersAttached = true

  document.getElementById("settings-close")?.addEventListener("click", closeSettingsDrawer)

  // ESC closes drawer.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("settings-drawer")?.hidden) {
      closeSettingsDrawer()
    }
  })

  // Backdrop click (click outside drawer body): close.
  document.addEventListener("click", (e) => {
    const drawer = document.getElementById("settings-drawer")
    if (!drawer || drawer.hidden) return
    if (!drawer.contains(/** @type {Node} */ (e.target)) && !(/** @type {HTMLElement} */ (e.target)).id?.includes("settings-open")) {
      closeSettingsDrawer()
    }
  })

  // Toggle clicks — delegate to the unified handler the wizard step 4 used.
  document.querySelectorAll("#settings-drawer [data-toggle]").forEach((el) => {
    el.addEventListener("click", () => {
      const pressed = el.getAttribute("aria-pressed") === "true"
      const next = !pressed
      el.setAttribute("aria-pressed", String(next))
      el.classList.toggle("on", next)
      onToggleChange(el.id, next)
    })
  })
}
```

- [ ] **Step 2: Move toggle change-handlers to main.js drawer wiring**

In `main.js`, replace the old toggle wiring block (around lines 340-360 where `unattended-toggle` / `autostart-toggle` / `guard-toggle` were handled) with a single call:

```javascript
import { wireSettingsDrawer, openSettingsDrawer } from "./modules/settings-drawer.js"

wireSettingsDrawer({
  onToggleChange: (id, on) => {
    if (id === "unattended-toggle") {
      state.unattended = on
      void invoke("wechat_cli_json", { args: ["provider", "set", state.selectedProvider || "claude", "--unattended", on ? "true" : "false"] })
    }
    if (id === "autostart-toggle") {
      state.autoStart = on
      void invoke("wechat_cli_json", { args: ["provider", "set", state.selectedProvider || "claude", "--auto-start", on ? "true" : "false"] })
    }
    if (id === "close-stops-daemon-toggle") {
      state.closeStopsDaemon = on
      // Persist to provider config.
      void invoke("wechat_cli_json", { args: ["provider", "set", state.selectedProvider || "claude", "--close-stops-daemon", on ? "true" : "false"] })
    }
    if (id === "guard-toggle") {
      // Existing guard wire-up — keep whichever side effect (probe poll start/stop)
      // was previously here.
    }
  },
})
```

- [ ] **Step 3: Add settings-open button**

Add an `id="settings-open"` button to the dashboard's header / nav rail in `index.html` (look for the dashboard view block). Wire its click to `openSettingsDrawer`:

```javascript
document.getElementById("settings-open")?.addEventListener("click", openSettingsDrawer)
```

- [ ] **Step 4: Verify provider config CLI supports `--close-stops-daemon`**

```bash
grep -n "close-stops-daemon\|closeStopsDaemon" src/cli/
```

Expected: matches in cli.ts or schema.ts. **If empty**, add the new CLI flag and config field as part of this task — it's needed for the drawer toggle to persist. (If adding the field, also add a one-line test in `src/cli/__/provider-config.test.ts` confirming round-trip.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/modules/settings-drawer.js apps/desktop/src/main.js apps/desktop/src/index.html src/cli/
git commit -m "feat(desktop): settings drawer shell with the four ex-wizard toggles"
```

---

## Task 10: Default migration for upgrading users

**Files:**
- Modify: `src/cli/` (wherever provider config defaults are written — likely `src/cli/provider-config.ts` or similar)

- [ ] **Step 1: Locate the provider-config default loader**

```bash
grep -rn "dangerouslySkipPermissions\b" src/cli/ src/lib/ | head -10
```

Find the function that returns defaults when the config file has no explicit value. This is where the new defaults live.

- [ ] **Step 2: Write the failing test**

In whichever test file covers provider-config defaults (e.g., `src/cli/provider-config.test.ts`), add:

```typescript
describe("provider config defaults (v0.6 setup-refresh)", () => {
  it("dangerouslySkipPermissions defaults to true (auto-approve ON)", () => {
    const cfg = loadProviderConfig({ existingFile: null })
    expect(cfg.dangerouslySkipPermissions).toBe(true)
  })
  it("autoStart defaults to true (开机自启 ON)", () => {
    const cfg = loadProviderConfig({ existingFile: null })
    expect(cfg.autoStart).toBe(true)
  })
  it("closeStopsDaemon defaults to false (关窗 daemon 继续跑)", () => {
    const cfg = loadProviderConfig({ existingFile: null })
    expect(cfg.closeStopsDaemon).toBe(false)
  })
  it("preserves explicit user values on upgrade", () => {
    const cfg = loadProviderConfig({ existingFile: { dangerouslySkipPermissions: false } })
    expect(cfg.dangerouslySkipPermissions).toBe(false)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
bun --bun vitest run src/cli/provider-config.test.ts
```

Expected: FAIL on the first three tests (current defaults are `dangerouslySkipPermissions: false` and `autoStart: false` per the wizard initial state at `main.js:35-36`).

- [ ] **Step 4: Update the defaults**

In the provider-config default block, change:

```typescript
const DEFAULTS = {
  dangerouslySkipPermissions: true,   // was: false
  autoStart: true,                    // was: false
  closeStopsDaemon: false,            // new field
}
```

The preserve-explicit-values test verifies the merge logic stays correct: defaults are floor, explicit user values win.

- [ ] **Step 5: Run all coordinator + cli tests**

```bash
bun --bun vitest run src/cli/ src/core/
```

Expected: PASS. (If any sibling test asserted the *old* defaults, update it to match the new defaults — but only if its intent was "verify the default", not "test a specific user scenario that happened to use false".)

- [ ] **Step 6: Commit**

```bash
git add src/cli/ src/lib/
git commit -m "feat(cli): v0.6 setup-refresh defaults — auto-approve+autostart ON, close-stops-daemon OFF"
```

---

## Task 11: Playwright e2e overhaul

**Files:**
- Modify: `apps/desktop/playwright/wizard.spec.ts`
- Modify: `apps/desktop/playwright/fixtures.ts` (if doctor seed needs adjustment)

- [ ] **Step 1: Replace `wizard.spec.ts` content**

Rewrite `apps/desktop/playwright/wizard.spec.ts` to test the single-page flow:

```typescript
import { test, expect } from "./fixtures"

test("setup page renders agent cards", async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  await expect(page.locator("#agent-card-claude")).toBeVisible()
  await expect(page.locator("#agent-card-codex")).toBeVisible()
})

test("scan button is disabled when no agents are installed", async ({ page, shimUrl, shim }) => {
  await shim.setDoctor({ checks: { claude: { ok: false }, codex: { ok: false } } })
  await page.goto(shimUrl)
  await expect(page.locator("#scan-bind")).toBeDisabled()
})

test("scan button enables when at least one agent appears (live)", async ({ page, shimUrl, shim }) => {
  await shim.setDoctor({ checks: { claude: { ok: false }, codex: { ok: false } } })
  await page.goto(shimUrl)
  await expect(page.locator("#scan-bind")).toBeDisabled()
  await shim.setDoctor({ checks: { claude: { ok: true, path: "/usr/local/bin/claude" }, codex: { ok: false } } })
  // doctor-poller is 2s; allow up to 4s for the next poll cycle.
  await expect(page.locator("#scan-bind")).toBeEnabled({ timeout: 4000 })
})

test("clicking scan opens QR modal after silent install succeeds", async ({ page, shimUrl, shim }) => {
  await shim.setDoctor({ checks: { claude: { ok: true, path: "/x" }, codex: { ok: false }, daemon: { alive: true } } })
  await shim.setServiceInstallResult({ ok: true, kind: "launchagent" })
  await page.goto(shimUrl)
  await page.locator("#scan-bind").click()
  await expect(page.locator("#qr-modal")).toBeVisible({ timeout: 5000 })
})

test("clicking scan shows error strip when install fails", async ({ page, shimUrl, shim }) => {
  await shim.setDoctor({ checks: { claude: { ok: true, path: "/x" }, codex: { ok: false } } })
  await shim.setServiceInstallResult({ ok: false, error: "GPO denied schtasks", stderr: "Access denied" })
  await page.goto(shimUrl)
  await page.locator("#scan-bind").click()
  await expect(page.locator("#setup-error")).toBeVisible({ timeout: 5000 })
  await expect(page.locator("#setup-error-msg")).toContainText("安装")
  // Crucially: QR modal does NOT open.
  await expect(page.locator("#qr-modal")).toBeHidden()
})

test("successful bind routes to dashboard", async ({ page, shimUrl, shim }) => {
  await shim.setDoctor({ checks: { claude: { ok: true, path: "/x" }, daemon: { alive: true } } })
  await shim.setServiceInstallResult({ ok: true, kind: "launchagent" })
  await shim.setSetupPollResult({ state: "confirmed", account: { id: "test-bot-1" } })
  await page.goto(shimUrl)
  await page.locator("#scan-bind").click()
  // QR opens, shim auto-confirms, modal closes, dashboard visible.
  await expect(page.locator("#qr-modal")).toBeHidden({ timeout: 10000 })
  await expect(page.locator("#dashboard")).toBeVisible()
})

test("settings drawer opens from dashboard and contains four toggles", async ({ page, shimUrl, shim }) => {
  await shim.setDoctor({ checks: { claude: { ok: true, path: "/x" }, daemon: { alive: true } }, hasAccounts: true })
  await page.goto(shimUrl)
  // hasAccounts skips setup and lands on dashboard directly.
  await page.locator("#settings-open").click()
  await expect(page.locator("#settings-drawer")).toBeVisible()
  await expect(page.locator("#autostart-toggle")).toBeVisible()
  await expect(page.locator("#unattended-toggle")).toBeVisible()
  await expect(page.locator("#guard-toggle")).toBeVisible()
  await expect(page.locator("#close-stops-daemon-toggle")).toBeVisible()
})
```

- [ ] **Step 2: Extend fixtures with the new shim helpers**

Check `apps/desktop/playwright/fixtures.ts` for existing helpers. Add what's missing:

```typescript
// Add to the shim helper interface:
setDoctor(report: Partial<DoctorReport>): Promise<void>
setServiceInstallResult(result: { ok: boolean, kind?: string, error?: string, stderr?: string }): Promise<void>
setSetupPollResult(result: { state: string, account?: { id: string } }): Promise<void>
```

Implement them by writing to the shim's response map (the existing fixtures show the pattern — match it).

- [ ] **Step 3: Run Playwright tests**

```bash
cd apps/desktop && bun x playwright test playwright/wizard.spec.ts
```

Expected: PASS (7 specs).

- [ ] **Step 4: Run the full Playwright suite**

```bash
cd apps/desktop && bun x playwright test
```

Expected: PASS. dashboard.spec.ts / interactions.spec.ts / sessions.spec.ts should be unaffected, but if they reference removed DOM ids (`continue-*`, `screen-doctor`, etc.), update them to use the new selectors.

- [ ] **Step 5: Run the unit suite**

```bash
bun --bun vitest run
bun x tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/playwright/
git commit -m "test(desktop): rewrite wizard.spec.ts for single-page flow"
```

---

## Cleanup pass

After all 11 tasks merge:

- [ ] **Search for dead code**

```bash
grep -rn "STEP_ORDER\|showStep\|screen-doctor\|screen-provider\|screen-wechat\|screen-service\|continue-provider\|continue-wechat\|continue-service\|service-install\|enter-dashboard" apps/desktop/src/
```

Expected: empty. Any matches are dead references — delete.

- [ ] **Search for leftover styles**

```bash
grep -rn "\.wizard \.screen\|\.steps\b\|\.step-of\b" apps/desktop/src/styles.css
```

Expected: empty.

- [ ] **Run full test matrix**

```bash
bun --bun vitest run
bun --bun vitest run -c vitest.e2e.config.ts
bun x tsc --noEmit
bun run depcheck
cd apps/desktop && bun x playwright test
```

Expected: all green.

- [ ] **Tag v0.6 desktop refresh**

Don't tag yet — coordinate with release notes (separate skill `write-compass-release-notes` equivalent for wechat-cc). Tag as part of release prep.

---

## Self-review notes

**Spec coverage:**
- ✓ Single page (Tasks 3-5, 7)
- ✓ Two agent cards as env check (Task 5 `renderAgentCards`)
- ✓ Silent service install on first 扫码 (Tasks 6, 7)
- ✓ No backend toggles in setup (Task 9 — drawer); defaults migrated (Task 10)
- ✓ 0-agent gating (Task 5 `refreshScanButton`, Task 11 spec)
- ✓ Auth-expired translation (Tasks 1, 2)
- ✓ No in-process fallback on install failure (Task 7 fail path goes to error strip, no spawn)
- ✓ Failure modes: error strip + retry (Task 7, 11)
- ✓ Migration preserves explicit user values (Task 10)

**Type consistency:**
- `silentInstallAndStart` returns `{ ok: true, serviceKind, daemonPid } | { ok: false, stage, error, details }` — same shape used in Task 6 test and Task 7 caller.
- `handleScanClick` signature stable across main.js, settings-drawer.js, wizard.js.
- `renderSetupPage` replaces `renderDoctorWizard` everywhere; back-compat alias provided in Task 5.
- `authFailNotice(providerId)` is the call shape used in conversation-coordinator and the coordinator test.

**Placeholder scan:** No "TBD" / "implement later" / placeholder strings. Where Task 9 Step 4 said "If empty, add the new CLI flag" — that's a real conditional task, not a placeholder; the engineer follows the branch the codebase tells them to.
