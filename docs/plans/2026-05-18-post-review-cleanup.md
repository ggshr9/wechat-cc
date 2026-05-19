# Post-Review Cleanup Plan (2026-05-18)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Triage and fix the findings of the 2026-05-18 full-repo review. Six CRITICAL items (data-correctness + security) ship as a single hotfix release (v0.5.18). HIGH items go out as four scoped PRs targeting v0.6.0. MED + LOW items are batched into cleanup PRs once the higher tiers are merged.

**Source review:** in-session output from 6 parallel reviewer agents covering `src/core`, daemon orchestration, daemon features, MCP + lib, CLI + entry scripts, and the desktop app. Findings spot-checked against current source (verified CRITICALs C1–C6 and HIGHs H-OrderSwap / H-DeadStub / H-Coordinator-* are all real).

**Out of scope:**
- Re-architecture (anything that breaks the AgentProvider contract — defer to a separate RFC).
- New features (memory_delete tool, etc. — listed under Phase 4 as opportunistic cleanups, not user-facing additions).
- Documentation rewrites (docs/rfc/* updates roll with relevant code PR).

---

## Phase 0 — Branch hygiene (today)

**Tasks:**

- [ ] **0.1 Squash-merge PR #36 (`feat/setup-single-page`)**
  - CI all green (build × 3 + e2e), mergeable: CLEAN. No review fix piggybacks — scope stays single-page setup.
  - `gh pr merge 36 --squash --delete-branch`
  - Pulls in: `src/core/conversation-coordinator.ts`, `src/core/codex-agent-provider.ts`, `apps/desktop/src/{main.js,modules/*,index.html,styles.css}`, `cli.ts`, `src/lib/agent-config.ts`, spec/plan docs.

- [ ] **0.2 Sync local master + clean stale local branches**
  - Local master is ahead of `origin/master` by 2 commits (00a248f, db41a51) that mirror PR #36's spec/plan commits — once PR #36 is squash-merged those local copies are redundant.
  - `git checkout master && git fetch origin && git reset --hard origin/master`
  - Delete stale local branches whose `origin` has been pruned: `git branch -D feature/project-switch fix/admin-check-mcp-tools fix/switch-post-greeting`

- [ ] **0.3 Rebase moxiuwen's logo branch onto new master, open PR**
  - Branch `origin/dev_moxiuwen` (2 commits: f26bd68 chore icons + 9836160 UI logo wiring) is logo-only, no logic. Conflicts with PR #36 expected in `apps/desktop/src/{index.html, styles.css}` from line drift, not semantic overlap.
  - Approach: do NOT force-push `dev_moxiuwen` (it's moxiuwen's branch). Cherry-pick onto a fresh branch:
    ```
    git checkout -b chore/desktop-logo-rebase master
    git cherry-pick f26bd68 9836160
    # resolve hunk drift in index.html (cc/cx → img src) + styles.css (.logo / .dash-brand .mark)
    git push -u origin chore/desktop-logo-rebase
    gh pr create --title "chore(desktop): adopt wechat-cc logo (rebased from moxiuwen)" --body "..." # co-author trailer
    ```
  - Co-author trailer: `Co-Authored-By: 莫秀文 <m1941696989@gmail.com>`

- [ ] **0.4 Align version numbers**
  - `Cargo.toml` is 0.5.13, `tauri.conf.json` is 0.5.17, `index.html` hardcodes `v0.5.13`.
  - Will be bumped together as part of Phase 1's v0.5.18 release commit; no separate task.

---

## Phase 1 — v0.5.18 hotfix: CRITICAL data + security (this week)

**Branch:** `fix/v0.5.18-critical-review` off post-Phase-0 master.

### Task 1.1 — C1: Cross-provider clobber on stale session

**Files:**
- Modify: `src/core/session-store.ts:154` (add `deleteOne(alias, provider)` method)
- Modify: `src/core/session-manager.ts:106` (call `deleteOne` instead of `delete`)
- Modify: `src/core/session-store.test.ts` (add test)
- Modify: `src/core/session-manager.test.ts` (add test)

- [ ] **Write failing test in `session-store.test.ts`:**

  ```typescript
  it('deleteOne removes only the specified provider row', () => {
    const store = openSessionStore(db)
    store.upsert('proj-x', 'claude', { session_id: 'c1' })
    store.upsert('proj-x', 'codex',  { session_id: 'x1' })

    store.deleteOne('proj-x', 'claude')

    expect(store.get('proj-x', 'claude')).toBeUndefined()
    expect(store.get('proj-x', 'codex')?.session_id).toBe('x1')
  })
  ```

- [ ] **Run; expect compile error (method missing).**
- [ ] **Add method to `session-store.ts`:** SQL `DELETE FROM sessions WHERE alias = ? AND provider = ?`; prepared statement named `stmtDeleteOne`.
- [ ] **Update `session-manager.ts:106`:** `this.opts.sessionStore?.deleteOne(alias, providerId)` — `providerId` is in scope in that closure.
- [ ] **Re-run; expect pass. Also run `session-manager.test.ts` to confirm no regression.**

### Task 1.2 — C2: send-reply ctx_token guard

**Files:**
- Modify: `src/lib/send-reply.ts:106`
- Modify: `src/lib/send-reply.test.ts` (or similar — confirm path)

- [ ] **Test:** with `userAccountIds[chatId] = 'acc-1'` set and `contextTokens[chatId]` absent, assert `sendReplyOnce(...)` returns `{ ok: false, error: <missing-token message> }` and that `ilinkSendMessage` was NOT called.
- [ ] **Run; expect fail (currently passes the guard, calls ilink, returns try/catch error).**
- [ ] **Change `if (!ctxToken && !persistedAccountId)` to `if (!ctxToken)`.** Update error message: `unknownChatIdError(chatId)` is misleading when the account IS known — introduce `missingContextTokenError(chatId)` returning `chat ${chatId} 还没向 bot 发过消息（缺 context_token），请让对方先发一条消息再重试`.
- [ ] **Re-run; expect pass.**

### Task 1.3 — C3 + C4: log-viewer hostname + XSS

**Files:**
- Modify: `log-viewer.ts:70-110` (formatLine + render) and `:126` (Bun.serve)

- [ ] **C3 — bind to localhost:** `Bun.serve({ port: PORT, hostname: '127.0.0.1', fetch: ... })`. Match the pattern at `docs.ts:632`.
- [ ] **C4 — escape log lines:** rewrite `formatLine` to return a DocumentFragment-equivalent JSON (`{ ts, tag, body }`), and render in the client by:
  - Creating `<span class="ts">`, `<span class="tag">` via `document.createElement` + `textContent`.
  - Setting body via `.textContent` (never `.innerHTML`).
- [ ] **Add test:** seed a log line containing `<script>alert(1)</script>`, GET `/api/logs`, assert response body contains the literal `&lt;script&gt;` (or that DOM rendering does not parse it as a script — easier as a Playwright snapshot test if there isn't an existing test file).

### Task 1.4 — C5 + C6: desktop CSP + image src

**Files:**
- Modify: `apps/desktop/src-tauri/tauri.conf.json:23`
- Modify: `apps/desktop/src/main.js:528-532` (`openImageLightbox`)

- [ ] **C5 — set CSP:**
  ```json
  "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' tauri: ipc: https://ipc.localhost"
  ```
  Iterate: launch dev build, watch console for CSP violations, narrow as needed. `'unsafe-inline'` for `style-src` is acceptable for now (vanilla CSS app); tighten later if React/Tauri adds inline scripts.

- [ ] **C6 — element-create the img instead of innerHTML:**
  ```js
  function openImageLightbox(src) {
    const lb = document.getElementById("lightbox")
    const body = document.getElementById("lightbox-body")
    if (!lb || !body) return
    body.textContent = ""           // clear
    const img = document.createElement("img")
    img.className = "lightbox-img"
    img.alt = "image"
    img.src = src                   // setter coerces, does not parse HTML
    body.appendChild(img)
    lb.hidden = false
    lb.setAttribute("aria-hidden", "false")
  }
  ```

- [ ] **Playwright:** launch desktop, open an attachment in dashboard, confirm lightbox renders and ESC dismisses; also confirm no CSP violations in dev-tools console.

### Task 1.5 — Release v0.5.18

- [ ] Bump `Cargo.toml` + `tauri.conf.json` + `index.html` (`dash-version`) to `0.5.18` in one commit.
- [ ] Write `docs/releases/2026-05-18-v0.5.18.md` (matches existing release-notes format under `docs/releases/`).
- [ ] Tag + push: `git tag v0.5.18 && git push origin v0.5.18`. CI auto-mirrors `desktop-v0.5.18`.

---

## Phase 2 — v0.6.0: HIGH consistency + concurrency (next 2 weeks)

Four scoped PRs, each independently mergeable.

### PR A — Delete dead code (~30 min, zero risk)

**Files:**
- Delete: `src/daemon/ilink-glue.ts:311-318` (`startLongPollLoops` stub that throws)
- Delete: `src/core/chatroom-protocol.ts` + `src/core/chatroom-protocol.test.ts` (dead post-v0.5.8 rewrite — only tests reference it)
- Modify: `src/core/chatroom-moderator.ts` (`genericContinuePrompt` final branch — re-attach the "max_rounds" notice text that lived in `maxRoundsSuffix`)
- Modify: `src/core/prompt-builder.ts:168` and `src/core/conversation-coordinator.ts:57` (update stale comments referencing removed module)
- Delete: `apps/desktop/src/modules/wizard.js:115-119` (dead alias `renderDoctorWizard` + comment)

- [ ] Run `bun --bun vitest run` after each deletion to confirm nothing else imports the symbols.
- [ ] Run `bun x tsc --noEmit` and `bun run depcheck`.

### PR B — Inbound pipeline correctness (~1 h)

**Files:**
- Modify: `src/daemon/inbound/build.ts:44-45` (swap order: guard before permission-reply)
- Modify: `src/daemon/inbound/mw-guard.ts:14` (drop `&& state.ip` from condition; fallback IP string)
- Modify: `src/daemon/onboarding.ts` echo-dispatch (increment `createTimeMs` by 1 to bypass dedup, OR add explicit `skipDedup: true` flag to InboundMsg that the dedup middleware honors)
- Add: tests for each: network-down + permission reply, network-down + no-IP guard firing, new-user-first-message dispatching

- [ ] Each test first (TDD) — three new specs, expect-fail, then implement.

### PR C — Chatroom concurrency safety (~2-3 h, biggest)

**Files:**
- Modify: `src/core/conversation-coordinator.ts:302` (shallow-copy history before mutation)
- Modify: `src/core/conversation-coordinator.ts:319-321` (haikuEval stub: call `fallbackDecision` directly, match the comment's claim)
- Modify: `src/core/conversation-coordinator.ts:394` (await abort signal during `collectTurn`)
- Modify: `src/core/conversation-coordinator.ts:443` (on abort, pop the trailing user entry from history to keep it well-formed)
- Modify: `src/core/chatroom-moderator.ts:237` (`fallbackDecision` returns `continue` for `round === maxRounds`, reserve `end` for `> maxRounds`)
- Modify: `src/core/agent-provider.ts` (interface: add optional `cancel?(): Promise<void>`)
- Modify: `src/core/claude-agent-provider.ts` (implement `cancel` via `q.interrupt()`)
- Modify: `src/core/codex-agent-provider.ts` (implement `cancel` via `activeAborter.abort()`)
- Add: tests for each — abort during round body, abort persistence not corrupting history, fallback final round produces 🎯 prefix

- [ ] Stress test scenario: dispatch two chatroom messages in same chat within 200ms; assert moderator history has both user entries + alternating speaker entries with no duplicates.

### PR D — Companion isolation (~1.5 h)

**Files:**
- Modify: `src/daemon/wiring/tick-bodies.ts:46` (companion tick uses dedicated alias `_companion` OR checks `sessionManager.isInFlight(alias, providerId)` and skips with `[companion] skipping push tick: user session in-flight`)
- Modify: `src/daemon/main.ts:60-63` (merge `isEnabled` + `isSnoozed` into one callback that reads config once)
- Decide and document: skip vs abort (recommend skip + warning log; documented in `docs/rfc/03-multi-agent-architecture.md` as a follow-up note)
- Add: test that user dispatch + companion tick in same chat does not contention-fail; assert tick was skipped if `inFlight === true`

### PR E — Capability matrix + prompt-builder polish (~30 min)

**Files:**
- Modify: `src/daemon/bootstrap/index.ts:199` (`canUseTool` becomes a per-dispatch closure reading current chat mode from `conversationStore`)
- Modify: `src/core/capability-matrix.ts:181` (`assertMatrixComplete` derives provider list from `registry.list()` rather than hardcoded `['claude','codex']`)
- Modify: `src/core/prompt-builder.ts:48` (use `providerId` — inject `你是 ${providerId}` line in `baseChannelSection`)

---

## Phase 3 — MED cleanup batch (1 PR or 3 mini-PRs)

Roll the MED items from the review into a single `chore/post-review-med` PR (split if review feedback wants smaller chunks):

| Area | File:line | Change |
|---|---|---|
| build hygiene | `src/lib/spawn-windowshide.test.ts:54` | Extend scan root past `src/` to cover root-level `docs.ts`, `cli.ts`, `setup.ts` etc.; then fix the now-failing `docs.ts:136` |
| security | `docs.ts:128-152` | Add SHA-256 verification against published checksums when downloading cloudflared |
| robustness | `src/lib/access.ts:36-45` | Throw named `AccessConfigCorruptError` instead of `process.exit(1)`; let `bootstrap` decide |
| network | `src/lib/ilink.ts:160` | `isRetryableSendError` regex `/\s5\d\d:/` → `/5\d\d/`; AbortController: always `ctrl.abort()` in `finally` before clearing timeout |
| db | `src/lib/db.ts:232-243` | Add `IF NOT EXISTS` to all migration `CREATE TABLE` DDL |
| mcp | `src/mcp-servers/delegate/main.ts:65` | Validate `WECHAT_DELEGATE_PEER` against `^[a-z][a-z0-9_-]{0,30}$` |
| mcp | `src/mcp-servers/wechat/main.ts:136` | Zod-refine `dir` arg with length/null-byte caps |
| memory | `src/daemon/memory/fs-api.ts:70` | Remove dead third condition `rel.startsWith(\`..${...}\`)` |
| onboarding | `src/daemon/onboarding.ts:37` | Escape hyphen in `NICKNAME_RE` |
| voice | `src/daemon/ilink/voice.ts:60` | Add `ctx_token` guard mirroring `sendFile` |
| cli | `cli.ts:1395-1436` | Distinguish "stale token" from "auth rejected" in `mode set` error |
| desktop | `apps/desktop/src/modules/service.js:304` | Per-step try/catch with correct `stage` |
| desktop | `apps/desktop/src/modules/dashboard.js:14` | Null-guard `getElementById` before `.textContent`/`.innerHTML` |
| single-instance | `src/daemon/single-instance.ts:51` | macOS: verify image name via `ps -p <pid> -o comm=`, not just PID existence |
| bootstrap | `src/daemon/bootstrap/index.ts:242` | Cache companion config; invalidate on toggle (evict session) |
| admin | `src/daemon/admin-commands.ts:329` | Await `pollHandle.stopAccount(id).waitForExit()` (new method) before `rmSync` |
| inbound | `src/daemon/inbound/{mw-activity,mw-milestone,mw-welcome}.ts` | Wrap `await next()` in try; only run post-next side effects if it resolved cleanly |
| wiring | `src/daemon/wiring/side-effects.ts:64-68` | Replace `as unknown as { type, message }` with proper SDK message discriminated union types |
| coordinator | `src/core/conversation-coordinator.ts:319-321` | Already covered in PR C |
| versioning | `Cargo.toml` / `tauri.conf.json` / `index.html` | Single source of truth — read version from `package.json` at build time |

---

## Phase 4 — LOW polish (opportunistic)

| File:line | Change |
|---|---|
| `cli.ts:50-141` | Delete `HELP_TEXT`; let citty's auto-generated help take over |
| `setup.ts:88` | Windows restart hint → PowerShell `Stop/Start-ScheduledTask` |
| `src/core/claude-agent-provider.ts:113-114` + `session-manager.ts:103` | `console.error` → `log()` (info-level) for `[SESSION_INIT]` / `[SESSION_RESUME]` |
| `src/lib/log.ts:43` | Rotate `.log` → `.log.1` → `.log.2` (one extra generation, ~25 LOC) |
| `src/lib/send-reply.ts:55-68` | `chunk()` boundary: `space > 1`, fallback `cut = limit` to prevent space-at-0 infinite loop |
| `src/daemon/tts/voice-config.ts:64-74` | `writeFileSync(tmp, ..., { mode: 0o600 })` in one call |
| `src/mcp-servers/wechat/main.ts:500-507` | Log only status + endpoint to stderr; omit body |
| `apps/desktop/src/modules/sessions.js:1106` | `alert()` → inline toast/error strip |
| `apps/desktop/src/modules/logs.js:96-97` | Add `?.` optional chaining on `getElementById` |
| `src/mcp-servers/wechat/main.ts` (+features/tools) | Add `memory_delete` MCP tool (uses existing `MemoryFS.delete`) |

---

## False positives confirmed against source (do NOT fix)

- **`src/daemon/media.ts:266-274` ffmpeg missing `windowsHide:true`** — agent misread; line 284 has `{ stdio: [...], windowsHide: true }`. No action.

---

## Release sequence

| Tag | Contents | Target |
|---|---|---|
| `v0.5.18` | Phase 0 (PRs #36 + dev_moxiuwen rebased) + Phase 1 (6 CRITICAL fixes) | This week |
| `v0.6.0-rc.1` | Phase 2 PRs A–E (includes `AgentSession.cancel` — minor bump) | Next 2 weeks |
| `v0.6.0` | + Phase 3 MED cleanup | 3 weeks |
| `v0.6.1` | Phase 4 LOW polish + any field bug reports | rolling |
