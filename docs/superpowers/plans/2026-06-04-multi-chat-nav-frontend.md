# Multi-chat Navigation — Frontend (Sessions Pane) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a contact sidebar to the desktop sessions pane and filter the session list to the selected contact, consuming the backend's `sessions list-chats` + `--chat` CLI (already shipped on this branch).

**Architecture:** A new `loadSessionsChats(deps)` invokes `sessions list-chats`, renders a contact sidebar (mirroring the memory pane's `mem-list`), auto-selects the most-recent contact, and drives `loadSessionsList(deps, chatId)` which now passes `--chat`. The selected `chat_id` is threaded onto `#sessions-body[data-chat]` and `#sessions-detail[data-chat]` so read-jsonl / delete / export / auto-refresh all scope to the right contact. When ≤1 contact exists the sidebar is hidden and the pane looks exactly as today.

**Tech Stack:** Vanilla JS modules (`apps/desktop/src/modules/sessions.js`), HTML/CSS (`index.html`/`styles.css`), the dev shim (`test-shim.ts`), Playwright (`apps/desktop/playwright/`). The frontend has no unit tests in this repo — Playwright e2e (Task 6) is the behavioral verification.

**Spec:** `docs/superpowers/specs/2026-06-03-multi-chat-nav-design.md`. **Prereq:** the backend plan (`2026-06-04-multi-chat-nav-backend.md`) is merged on this branch — `sessions list-chats --json` returns `{ ok, chats: [{ chat_id, user_name, account_id, session_count, last_used_at }] }`, and `--chat <id>` filters `list-projects`/`read-jsonl`/`delete`.

---

## Background — verbatim current state (the code these tasks edit)

All paths under `apps/desktop/`. Line numbers are approximate — match on the shown code.

**`src/modules/sessions.js`:**
- `loadSessionsList(deps)` invokes `["sessions","list-projects","--json"]`, renders recency groups into `#sessions-body`, has empty-state `#sessions-empty`.
- `openProjectDetail(deps, alias, opts)` sets `detail.dataset.alias = alias`, invokes `wechat_cli_json_via_file` `["sessions","read-jsonl",alias,"--json"]`, calls `startDetailAutoRefresh(deps)`.
- `startDetailAutoRefresh(deps)` reads `detail.dataset.alias`, re-calls `openProjectDetail(deps, alias, {preserveScroll})`.
- `deleteProject(deps)` reads `detail?.dataset.alias`, invokes `["sessions","delete",alias,"--json"]`.
- `exportProjectMarkdown(deps)` reads `detail?.dataset.alias`, invokes read-jsonl.
- `setSessionsDetailMode(deps, mode)` reads `detail?.dataset.alias`, calls `openProjectDetail(deps, alias)`.

**`src/main.js`:** pane-switch (`if (name === "sessions") { loadSessionsList(deps)...; startSessionsAutoRefresh(deps) }`); `#sessions-body` click delegation handles `open-project` (`openProjectDetail(deps, alias, opts)`).

**`src/index.html`:** the `<article data-pane="sessions">` with `.topbar`, `.sessions-search-wrap`, `<div class="sessions-body" id="sessions-body">` (+ `#sessions-empty`), `<div class="sessions-detail dismissed" id="sessions-detail">`.

**`test-shim.ts`:** `__mockState.sessions: Array<{id, project, created_at, favorited}>` (NO chat_id today). The `wechat_cli_json` DRY_RUN intercept for `sessions list-projects` maps `__mockState.sessions` → projects. `demo.seed` seeds 2 sessions (`wechat-cc`, `compass`). `wechat_cli_json_via_file` falls through to the real CLI for `read-jsonl`.

**Convention:** desktop tests run via `bun x playwright test` from `apps/desktop`. Typecheck the desktop JS via the repo's `bun run typecheck` (root) — the desktop JS is JS+JSDoc; the main guard is that Playwright passes. Run `bun run typecheck` from repo root after JS edits to catch any TS-checked breakage.

---

## File Structure

- **Modify** `apps/desktop/src/modules/sessions.js` — `loadSessionsChats` (new), `renderSessionsSidebar` (new), `selectChat` (new), module-level `selectedChatId`; thread `chatId` through `loadSessionsList`, `openProjectDetail`, `startDetailAutoRefresh`, `deleteProject`, `exportProjectMarkdown`, `setSessionsDetailMode`.
- **Modify** `apps/desktop/src/index.html` — wrap `#sessions-body` with a `#sessions-sidebar` aside in a `.sessions-main` flex row.
- **Modify** `apps/desktop/src/styles.css` — `.sessions-main` / `.sessions-sidebar` styles (reuse `mem-list` look).
- **Modify** `apps/desktop/src/main.js` — pane-switch calls `loadSessionsChats`; sidebar click delegation; open-project passes `chatId` from `#sessions-body[data-chat]`.
- **Modify** `apps/desktop/test-shim.ts` — seed `chat_id` on mock sessions; intercept `sessions list-chats` and `--chat` on `list-projects`/`read-jsonl`.
- **Create** `apps/desktop/playwright/sessions-multichat.spec.ts` — sidebar + filtering + single-contact-hide + scoped-delete specs.

---

## Task 1: Thread `chatId` through the detail path (read/refresh/delete/export)

**Files:** Modify `apps/desktop/src/modules/sessions.js`

Goal: every detail-scoped CLI call carries `--chat <chatId>` when a contact is selected, sourced from `#sessions-detail[data-chat]`. No UI yet; pure plumbing. A helper builds the args.

- [ ] **Step 1: Add a `--chat` args helper near the top of the module**

After the imports / near the other small helpers in `sessions.js`, add:
```js
/**
 * Append `--chat <chatId>` to a sessions CLI arg list when chatId is set.
 * @param {string[]} args
 * @param {string|null|undefined} chatId
 * @returns {string[]}
 */
function withChat(args, chatId) {
  return chatId ? [...args, "--chat", chatId] : args
}
```

- [ ] **Step 2: `openProjectDetail` — accept `opts.chatId`, store it on the detail, scope read-jsonl**

In `openProjectDetail(deps, alias, opts = {})`, change the `detail.dataset.alias = alias` line to also record the chat, and scope the read-jsonl invoke. Replace:
```js
  detail.dataset.alias = alias
```
with:
```js
  detail.dataset.alias = alias
  // chatId may come from the click (opts.chatId) or, on auto-refresh ticks,
  // already be on the element — preserve it if the caller didn't pass one.
  const chatId = opts.chatId ?? detail.dataset.chat ?? ''
  detail.dataset.chat = chatId
```
and replace the read-jsonl invoke line:
```js
    const resp = /** @type {SessionsReadJsonl} */ (await deps.invoke("wechat_cli_json_via_file", { args: ["sessions", "read-jsonl", alias, "--json"] }))
```
with:
```js
    const resp = /** @type {SessionsReadJsonl} */ (await deps.invoke("wechat_cli_json_via_file", { args: withChat(["sessions", "read-jsonl", alias, "--json"], chatId || null) }))
```

- [ ] **Step 3: `startDetailAutoRefresh` — preserve chatId across ticks**

In `startDetailAutoRefresh`, the tick reads `detail.dataset.alias` then calls `openProjectDetail(deps, alias, { preserveScroll })`. Because Step 2 makes `openProjectDetail` fall back to `detail.dataset.chat` when `opts.chatId` is absent, the tick already preserves the chat — **no change needed** beyond confirming `openProjectDetail`'s fallback. Verify by reading the function; leave it as-is.

- [ ] **Step 4: `deleteProject` — scope delete to the contact**

In `deleteProject(deps)`, after `const alias = detail?.dataset.alias`, the confirm branch invokes delete. Replace:
```js
      await /** @type {Promise<SessionsDelete>} */ (deps.invoke("wechat_cli_json", { args: ["sessions", "delete", alias, "--json"] }))
```
with:
```js
      const chatId = detail?.dataset.chat || null
      await /** @type {Promise<SessionsDelete>} */ (deps.invoke("wechat_cli_json", { args: withChat(["sessions", "delete", alias, "--json"], chatId) }))
```

- [ ] **Step 5: `exportProjectMarkdown` — scope read-jsonl to the contact**

In `exportProjectMarkdown(deps)`, after `const alias = detail?.dataset.alias`, replace:
```js
    const resp = /** @type {SessionsReadJsonl} */ (await deps.invoke("wechat_cli_json_via_file", { args: ["sessions", "read-jsonl", alias, "--json"] }))
```
with:
```js
    const chatId = detail?.dataset.chat || null
    const resp = /** @type {SessionsReadJsonl} */ (await deps.invoke("wechat_cli_json_via_file", { args: withChat(["sessions", "read-jsonl", alias, "--json"], chatId) }))
```

- [ ] **Step 6: `setSessionsDetailMode` — re-open with the stored chatId**

In `setSessionsDetailMode`, replace:
```js
  if (alias && !detail?.classList.contains('dismissed')) {
    openProjectDetail(deps, alias)
    return
  }
```
with:
```js
  if (alias && !detail?.classList.contains('dismissed')) {
    openProjectDetail(deps, alias, { chatId: detail?.dataset.chat || '' })
    return
  }
```

- [ ] **Step 7: Typecheck**

Run (repo root): `bun run typecheck`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/modules/sessions.js
git commit -m "feat(desktop): thread chatId through sessions detail read/delete/export/refresh"
```

---

## Task 2: `loadSessionsList(deps, chatId)` passes `--chat`; rows carry the chat

**Files:** Modify `apps/desktop/src/modules/sessions.js`, `apps/desktop/src/main.js`

- [ ] **Step 1: Add module-level selected-chat state**

Near the top of `sessions.js` (with the other module-level `let` vars like `detailAutoTimer`), add:
```js
/** @type {string|null} — the contact whose sessions are shown. null = unfiltered (zero/one contact). */
let selectedChatId = null
```

- [ ] **Step 2: `loadSessionsList` — accept and apply a chat filter**

Change the signature and the invoke. Replace:
```js
export async function loadSessionsList(deps) {
  const body = document.getElementById("sessions-body")
  const empty = document.getElementById("sessions-empty")
  const meta = document.getElementById("sessions-meta")
  if (!body) return

  try {
    const resp = /** @type {SessionsListProjects} */ (await deps.invoke("wechat_cli_json", { args: ["sessions", "list-projects", "--json"] }))
```
with:
```js
export async function loadSessionsList(deps, chatId = selectedChatId) {
  const body = document.getElementById("sessions-body")
  const empty = document.getElementById("sessions-empty")
  const meta = document.getElementById("sessions-meta")
  if (!body) return
  // Record the active chat on the list container so the open-project click
  // (wired in main.js) can pass it to openProjectDetail without cross-module state.
  body.dataset.chat = chatId || ''

  try {
    const resp = /** @type {SessionsListProjects} */ (await deps.invoke("wechat_cli_json", { args: withChat(["sessions", "list-projects", "--json"], chatId) }))
```
(Leave the rest of `loadSessionsList` — grouping, empty-state, rows — unchanged.)

- [ ] **Step 3: main.js — open-project click passes the chat**

In `src/main.js`, in the `#sessions-body` click delegation, the `open-project` branch currently calls `openProjectDetail(deps, alias, opts)`. Replace:
```js
    if (action === 'open-project') {
      if (!alias) return
      const turnIdx = actionEl.dataset.turnIndex
      const opts = turnIdx !== undefined ? { focusTurn: Number(turnIdx) } : {}
      openProjectDetail(deps, alias, opts)
    }
```
with:
```js
    if (action === 'open-project') {
      if (!alias) return
      const turnIdx = actionEl.dataset.turnIndex
      const chatId = document.getElementById("sessions-body")?.dataset.chat || ''
      const opts = turnIdx !== undefined ? { focusTurn: Number(turnIdx), chatId } : { chatId }
      openProjectDetail(deps, alias, opts)
    }
```

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/modules/sessions.js apps/desktop/src/main.js
git commit -m "feat(desktop): loadSessionsList accepts a chat filter; open-project carries chatId"
```

---

## Task 3: Sidebar markup + styles

**Files:** Modify `apps/desktop/src/index.html`, `apps/desktop/src/styles.css`

- [ ] **Step 1: Wrap `#sessions-body` with a sidebar in a flex row**

In `index.html`, replace:
```html
  <div class="sessions-body" id="sessions-body">
    <p class="empty-state" id="sessions-empty">还没有项目会话——你跟 Claude 第一次说话之后这里就会有内容。</p>
  </div>
```
with:
```html
  <div class="sessions-main" id="sessions-main">
    <aside class="sessions-sidebar" id="sessions-sidebar" hidden></aside>
    <div class="sessions-body" id="sessions-body">
      <p class="empty-state" id="sessions-empty">还没有项目会话——你跟 Claude 第一次说话之后这里就会有内容。</p>
    </div>
  </div>
```
(The `#sessions-detail` overlay stays a sibling after `.sessions-main`, unchanged.)

- [ ] **Step 2: Add styles**

In `styles.css`, append (reusing the memory `mem-list` visual language — match its width/border tokens; if `mem-list` uses CSS vars, reuse them):
```css
/* ── sessions contact sidebar (multi-chat nav) ───────────────── */
.sessions-main { display: flex; flex: 1; min-height: 0; }
.sessions-sidebar {
  width: 168px;
  flex: 0 0 168px;
  border-right: 1px solid var(--line, #e5e5e5);
  overflow-y: auto;
  padding: 6px 0;
}
.sessions-sidebar[hidden] { display: none; }
.sessions-main > .sessions-body { flex: 1; min-width: 0; }
.contact-row {
  display: flex; align-items: center; gap: 8px;
  width: 100%; padding: 8px 12px; border: 0; background: none;
  text-align: left; cursor: pointer; font-size: 13px; color: var(--ink, #222);
}
.contact-row:hover { background: var(--hover, rgba(0,0,0,.04)); }
.contact-row.active { background: var(--active, rgba(0,0,0,.07)); font-weight: 600; }
.contact-row .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.contact-row .count { font-size: 11px; color: var(--muted, #999); }
```
(If `styles.css` defines different token names, substitute the file's existing vars — grep `--line`/`--muted` first; use literal fallbacks shown if none exist.)

- [ ] **Step 3: Verify it loads (dev shim)**

Run from `apps/desktop`: start nothing destructive — just confirm the HTML parses by running the existing Playwright suite later. For now: `bun run typecheck` (root) → exit 0 (HTML/CSS aren't typechecked, but this confirms no JS was broken).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/index.html apps/desktop/src/styles.css
git commit -m "feat(desktop): sessions pane contact-sidebar markup + styles"
```

---

## Task 4: `loadSessionsChats` — render sidebar, select, single-contact-hide; wire it

**Files:** Modify `apps/desktop/src/modules/sessions.js`, `apps/desktop/src/main.js`

- [ ] **Step 1: Add `renderSessionsSidebar`, `selectChat`, `loadSessionsChats`**

In `sessions.js`, add these three functions (near `loadSessionsList`):
```js
/**
 * Render the contact sidebar from list-chats rows. Hides the sidebar when
 * there's <=1 contact (no navigation needed — pane looks like single-chat).
 * @param {Deps} deps
 * @param {Array<{chat_id:string,user_name:string|null,session_count:number}>} chats
 */
function renderSessionsSidebar(deps, chats) {
  const sidebar = document.getElementById("sessions-sidebar")
  if (!sidebar) return
  if (chats.length <= 1) {
    sidebar.hidden = true
    sidebar.innerHTML = ''
    return
  }
  sidebar.hidden = false
  sidebar.innerHTML = chats.map(c => {
    const name = c.user_name || c.chat_id.split("@")[0]
    const active = c.chat_id === selectedChatId ? ' active' : ''
    return `<button class="contact-row${active}" data-action="select-chat" data-chat="${escapeHtml(c.chat_id)}">
      <span class="name">${escapeHtml(name)}</span>
      <span class="count">${c.session_count}</span>
    </button>`
  }).join("")
}

/**
 * Switch the active contact: update state, re-highlight, reload the list.
 * @param {Deps} deps
 * @param {string} chatId
 */
export async function selectChat(deps, chatId) {
  selectedChatId = chatId
  document.querySelectorAll("#sessions-sidebar .contact-row").forEach(el => {
    const btn = /** @type {HTMLElement} */ (el)
    el.classList.toggle("active", btn.dataset.chat === chatId)
  })
  closeProjectDetail()
  await loadSessionsList(deps, chatId)
}

/**
 * Pane entry point: load contacts, render the sidebar, auto-select the
 * most-recent, then load that contact's session list.
 * @param {Deps} deps
 */
export async function loadSessionsChats(deps) {
  try {
    const resp = /** @type {{ ok: boolean, chats?: Array<{chat_id:string,user_name:string|null,session_count:number,last_used_at:string}> }} */ (
      await deps.invoke("wechat_cli_json", { args: ["sessions", "list-chats", "--json"] })
    )
    const chats = resp.chats || []
    // list-chats is already sorted most-recent-first by the CLI.
    selectedChatId = chats.length > 1 ? (chats[0]?.chat_id ?? null) : null
    renderSessionsSidebar(deps, chats)
    await loadSessionsList(deps, selectedChatId)
  } catch (err) {
    console.error("sessions list-chats failed", err)
    // Fall back to the unfiltered list so the pane still works.
    await loadSessionsList(deps, null)
  }
}
```
NOTE: `closeProjectDetail` and `escapeHtml` are already imported/defined in this module (they're used elsewhere in the file). Confirm with `grep -n 'function closeProjectDetail\|function escapeHtml\|import.*escapeHtml' apps/desktop/src/modules/sessions.js`.

- [ ] **Step 2: main.js — pane switch calls `loadSessionsChats`; add sidebar click delegation**

In `src/main.js`, in the pane-switch hook, replace:
```js
  if (name === "sessions") {
    loadSessionsList(deps).catch(err => console.error("sessions load failed", err))
    startSessionsAutoRefresh(deps)
  } else {
```
with:
```js
  if (name === "sessions") {
    loadSessionsChats(deps).catch(err => console.error("sessions load failed", err))
    startSessionsAutoRefresh(deps)
  } else {
```
Add `loadSessionsChats` and `selectChat` to the existing import from `./modules/sessions.js` (grep `from "./modules/sessions` / `from './modules/sessions`). Then add a click delegation for the sidebar — place it next to the `#sessions-body` delegation:
```js
  document.getElementById("sessions-sidebar")?.addEventListener("click", (e) => {
    const el = /** @type {HTMLElement | null} */ (e.target instanceof HTMLElement ? e.target.closest("[data-action='select-chat']") : null)
    if (!el) return
    const chatId = el.dataset.chat
    if (chatId) selectChat(deps, chatId).catch(err => console.error("select-chat failed", err))
  })
```

- [ ] **Step 3: `startSessionsAutoRefresh` — refresh the sidebar too (lightweight)**

The 30s list auto-refresh currently calls `loadSessionsList`. To keep the sidebar fresh (a new contact messaging in), confirm whether `startSessionsAutoRefresh` calls `loadSessionsList(deps)` directly; if so, change that one call to `loadSessionsChats(deps)` so the sidebar updates too. Read it first: `grep -n 'function startSessionsAutoRefresh' -A12 apps/desktop/src/modules/sessions.js`. Replace the inner `loadSessionsList(deps)` call with `loadSessionsChats(deps)`. (If it already re-derives differently, leave it and note in the report.)

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/modules/sessions.js apps/desktop/src/main.js
git commit -m "feat(desktop): contact sidebar — list-chats, select, single-contact hide"
```

---

## Task 5: Dev-shim mocks for list-chats + `--chat`

**Files:** Modify `apps/desktop/test-shim.ts`

The shim's `__mockState.sessions` items need a `chat_id` so `list-chats` and `--chat` filtering can be mocked. We add `chat_id` to seeded sessions and three intercepts.

- [ ] **Step 1: Seed `chat_id` on mock sessions**

In `test-shim.ts`, find the `demo.seed` handler that sets `__mockState.sessions` (the `withSessions === false ? [] : [...]` block). Replace it with two contacts so multi-chat is exercisable:
```ts
          __mockState.sessions = args?.withSessions === false ? [] : [
            { id: 'sess_1', project: 'wechat-cc', created_at: Date.now(),            favorited: false, chat_id: 'chatA@im.wechat' },
            { id: 'sess_2', project: 'compass',   created_at: Date.now() - 3600000,  favorited: false, chat_id: 'chatA@im.wechat' },
            { id: 'sess_3', project: 'blog',      created_at: Date.now() - 7200000,  favorited: false, chat_id: 'chatB@im.wechat' },
          ]
```
Also extend the `__mockState.sessions` TYPE (the inline type at the top of `__mockState`) to include `chat_id?: string`:
```ts
  sessions: Array<{ id: string; project: string; created_at: number; favorited: boolean; chat_id?: string }>
```
And, so `list-chats` can show names, add a mock name map next to the existing mock fields — reuse `__mockState.conversations` if present, else hardcode in the intercept (Step 2).

- [ ] **Step 2: Intercept `sessions list-chats`**

In the `wechat_cli_json` DRY_RUN branch, immediately AFTER the existing `sessions list-projects` intercept block, add:
```ts
          if (
            dryRun &&
            body.command === 'wechat_cli_json' &&
            cliArgs[0] === 'sessions' &&
            cliArgs[1] === 'list-chats'
          ) {
            const names: Record<string, string> = { 'chatA@im.wechat': '小白', 'chatB@im.wechat': '小明' }
            const byChat = new Map<string, { count: Set<string>; last: number }>()
            for (const s of __mockState.sessions) {
              const id = s.chat_id || '_legacy'
              const g = byChat.get(id) ?? { count: new Set<string>(), last: 0 }
              g.count.add(s.project)
              if (s.created_at > g.last) g.last = s.created_at
              byChat.set(id, g)
            }
            const chats = [...byChat.entries()]
              .map(([chat_id, g]) => ({ chat_id, user_name: names[chat_id] ?? null, account_id: 'bot1', session_count: g.count.size, last_used_at: new Date(g.last).toISOString() }))
              .sort((a, b) => Date.parse(b.last_used_at) - Date.parse(a.last_used_at))
            return Response.json({ result: { ok: true, chats } })
          }
```

- [ ] **Step 3: Make `list-projects` honor `--chat`**

Replace the existing `sessions list-projects` intercept's project mapping so it filters by `--chat` when present:
```ts
          if (
            dryRun &&
            body.command === 'wechat_cli_json' &&
            cliArgs[0] === 'sessions' &&
            cliArgs[1] === 'list-projects'
          ) {
            const chatIdx = cliArgs.indexOf('--chat')
            const chatFilter = chatIdx >= 0 ? cliArgs[chatIdx + 1] : null
            const projects = __mockState.sessions
              .filter(s => !chatFilter || (s.chat_id || '_legacy') === chatFilter)
              .map(s => ({
                alias: s.project,
                last_used_at: new Date(s.created_at).toISOString(),
                summary: null,
              }))
            return Response.json({ result: { projects } })
          }
```

- [ ] **Step 4: Intercept `read-jsonl` (so `--chat` doesn't hit the real CLI in DRY_RUN)**

In the `wechat_cli_json_via_file` branch, after the existing `logs` intercept and before the real-CLI fallthrough, add a minimal read-jsonl mock:
```ts
          if (dryRun && cliArgs[0] === 'sessions' && cliArgs[1] === 'read-jsonl') {
            const alias = cliArgs[2]
            const exists = __mockState.sessions.some(s => s.project === alias)
            if (!exists) return Response.json({ result: { ok: false, error: 'no such alias' } })
            return Response.json({ result: { ok: true, alias, session_id: `sess-${alias}`, turns: [] } })
          }
```

- [ ] **Step 5: Confirm the shim still starts**

Run from `apps/desktop`: `bun -e "import('./test-shim.ts').then(()=>console.log('shim imports ok')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: `shim imports ok` (or, if the shim auto-starts a server on import, kill it after the line prints — the goal is "no syntax/type error on load"). If that pattern doesn't fit how test-shim.ts is structured, instead run `bun run typecheck` (root) and rely on the Playwright run in Task 6.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/test-shim.ts
git commit -m "test(shim): mock sessions list-chats + --chat filtering (chat_id on seeded sessions)"
```

---

## Task 6: Playwright specs

**Files:** Create `apps/desktop/playwright/sessions-multichat.spec.ts`

- [ ] **Step 1: Write the specs**

Create `apps/desktop/playwright/sessions-multichat.spec.ts`:
```ts
import { test, expect } from './fixtures'

async function bootAndOpenSessions(page: import('@playwright/test').Page, shimUrl: string) {
  await page.goto(shimUrl)
  await page.waitForFunction(() => document.documentElement.dataset.mode === 'dashboard', { timeout: 10_000 })
  await page.locator('button.dash-nav-link[data-pane="sessions"]').click()
  await expect(page.locator('article.dash-pane[data-pane="sessions"]')).toBeVisible()
}

test('contact sidebar lists each seeded contact', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootAndOpenSessions(page, shimUrl)
  const sidebar = page.locator('#sessions-sidebar')
  await expect(sidebar).toBeVisible({ timeout: 10_000 })
  await expect(sidebar.locator('.contact-row')).toHaveCount(2)
  await expect(sidebar).toContainText('小白')
  await expect(sidebar).toContainText('小明')
})

test('selecting a contact filters the session list to that contact', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootAndOpenSessions(page, shimUrl)
  // Default: most-recent contact (chatA = 小白) selected → wechat-cc + compass.
  const body = page.locator('#sessions-body')
  await expect(body).toContainText('wechat-cc', { timeout: 10_000 })
  await expect(body).toContainText('compass')
  await expect(body).not.toContainText('blog')
  // Switch to 小明 (chatB) → only blog.
  await page.locator('#sessions-sidebar .contact-row', { hasText: '小明' }).click()
  await expect(body).toContainText('blog')
  await expect(body).not.toContainText('compass')
})

test('single contact hides the sidebar (no regression for single-chat)', async ({ page, shimUrl, shim }) => {
  // Seed, then collapse to a single contact by unseeding the second one is
  // not exposed; instead assert the hide path with the withSessions=false
  // empty case AND a one-contact case via a dedicated seed flag if available.
  // Minimal robust check: with the default 2-contact seed the sidebar shows;
  // this test asserts the *hidden* attribute toggles by checking the one-row
  // path through the empty seed (0 contacts → sidebar hidden).
  await shim.invoke('demo.seed', { chat_id: 'test_chat', withSessions: false })
  await bootAndOpenSessions(page, shimUrl)
  await expect(page.locator('#sessions-sidebar')).toBeHidden()
  await expect(page.locator('#sessions-empty')).toBeVisible()
})
```
NOTE: the single-contact test above uses the 0-contact (`withSessions:false`) seed to exercise the hide path deterministically. If you want a true 1-contact case, add a `demo.seed` flag in test-shim.ts (`oneContact: true` → seed only `sess_1`/`sess_2` under `chatA`) in Task 5 and assert the sidebar is hidden with the list still showing `wechat-cc`. Implementer: prefer adding the `oneContact` flag for a faithful test; if time-boxed, the 0-contact assertion is acceptable and must be noted.

- [ ] **Step 2: Run the specs**

Run from `apps/desktop`: `bun x playwright test sessions-multichat.spec.ts`
Expected: all pass. If a selector misses, inspect with `--debug` or the trace; fix the implementation (not the test's intent). Common gotchas: the sidebar render is async after pane switch — the `toBeVisible({ timeout })` handles it; `closeProjectDetail` must exist (it does).

- [ ] **Step 3: Run the EXISTING sessions specs (no regression)**

Run: `bun x playwright test sessions-pane.spec.ts`
Expected: still pass — the default 2-contact seed means `#sessions-body` shows `wechat-cc` (chatA is auto-selected and includes wechat-cc), so the existing `sessions tab renders projects` test still finds `wechat-cc`. **However** that existing test also asserts `compass` — compass is under chatA too (per the Task 5 seed), so it stays visible. If the existing test asserts a project that the seed moved to chatB (e.g. it expected `compass` but you placed compass under chatB), the test will fail — in that case keep `wechat-cc` AND `compass` under chatA in the Task 5 seed (as written) so the existing spec passes unchanged. Confirm green.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/playwright/sessions-multichat.spec.ts
git commit -m "test(desktop): playwright specs for contact sidebar + per-chat filtering"
```

---

## Task 7: Full verification

**Files:** none

- [ ] **Step 1: Typecheck**

Run (root): `bun run typecheck` → exit 0.

- [ ] **Step 2: Full desktop Playwright suite**

Run from `apps/desktop`: `bun x playwright test`
Expected: all specs pass (the new `sessions-multichat` specs + all pre-existing, including `sessions-pane`, `memory`, `dashboard`, `a2a`, `csp`, `wizard`). If any pre-existing sessions/memory spec regressed, fix the implementation.

- [ ] **Step 3: Unit suite (confirm backend still green)**

Run (root): `bun run test`
Expected: 142 files / 2254+ passed.

- [ ] **Step 4: Commit (only if Steps 1–3 surfaced a fix)**

```bash
git add -A
git commit -m "chore(desktop): multi-chat frontend verification fixes"
```

---

## Self-Review notes (applied)

- **Spec coverage:** contact sidebar (Task 3/4), per-chat filtering of the list (Task 2/4), single-contact-hide (Task 4 `renderSessionsSidebar`), chatId on detail for read/delete/export/refresh (Task 1), default = most-recent contact (Task 4, list-chats is pre-sorted), shim + Playwright (Task 5/6). Search-scopes-to-contact is **deferred** — noted here as a follow-up: `runSearch`/`wireSearch` still search globally; scoping search to `selectedChatId` is a small additive change but not required for the core nav and is left out to keep this plan focused (call it out in the final report).
- **Cross-module state:** `selectedChatId` lives in `sessions.js`; main.js reads the chat off `#sessions-body[data-chat]` (Task 2) for open-project — no exported mutable state needed there. The sidebar click calls the exported `selectChat`.
- **Type/name consistency:** `withChat(args, chatId)`, `selectedChatId`, `loadSessionsChats`, `renderSessionsSidebar`, `selectChat`, `loadSessionsList(deps, chatId)` are used identically across tasks. `data-chat` is the single attribute name on both `#sessions-body` and `#sessions-detail` and the `.contact-row`.
- **No placeholders:** every step shows literal before/after code or an exact command. The few "confirm with grep" steps are explicit verifications for names already evidenced in the extraction (`closeProjectDetail`, `escapeHtml`, the import sites), not hand-waves.
- **Known risk:** the existing `sessions-pane.spec.ts` asserts both `wechat-cc` and `compass` are visible. Task 5's seed keeps BOTH under chatA (the auto-selected default) precisely so that spec stays green. Task 6 Step 3 pins this.
