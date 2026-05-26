# Dashboard Reconnect Diagnose — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user clicks "重新连接" on the dashboard, show **one** diagnosis card identifying the most likely root cause + the recommended action, instead of the current one-size-fits-all `service stop` + `kill-residual` + `service start` chain that silently overkills transient hiccups and obscures real failures.

**Architecture:** Pure-function `diagnose(report, healthOk, lastError, lastRestart)` in `apps/desktop/src/view.js` returns `{ code: 0–8, title, hint, primary, secondary? }`. `dashboard.js:restartDaemon` is rewritten to (a) refresh doctor + direct-ping `/v1/health`, (b) call `diagnose`, (c) render a diagnosis card with the primary action button. Existing `restartButtonState` keeps working for the resting-state label; `diagnose` only fires on click. Telemetry per click goes to channel.log so we can tune the heuristics from real usage.

**Tech Stack:** Vanilla JS (no framework) / Tauri IPC / vitest for `view.js` units / Playwright for the click→card UX (`apps/desktop/playwright/dashboard.spec.ts` already exists).

**Background:** Reading the existing dashboard code revealed there is no persistent connection to lose — the dashboard polls `wechat-cc doctor --json` every 5s via Tauri IPC subprocess. "重新连接" is actually a hard daemon restart (`dashboard.js:229`), not a connection retry. Users get 5 outcomes from one button. This plan introduces a real diagnostic layer.

---

## The 9 categories (one of these is rendered per click)

Detection signals are all already exposed by `doctor --json` (see `src/cli/doctor.ts:102-137 DoctorReport`) except where noted as "needs new probe".

| Code | 用户语言 | 检测信号 | 主按钮 | 备用 |
|---|---|---|---|---|
| **0** | 没事,只是 dashboard 没刷新 | `daemon.alive=true` 且最近 5s 内事件正常 | 自动消失,不弹卡 | — |
| **1** | 后台服务挂了 | `daemon.alive=false` 且 `service.installed=true` 且 `daemon.pid≠null` | 一键重启后台(=当前 restartDaemon) | 看 logs |
| **2** | 后台服务从没启动过 | `daemon.alive=false` 且 `daemon.pid=null` 且 `service.installed=true` | 启动后台(`service start`) | 看 logs |
| **3** | 后台服务没安装 | `service.installed=false` | 去向导装服务 | 如果 daemon 在前台跑: "先停前台再装" |
| **4** | AI 工具缺失(易踩坑) | `checks[agent.provider].severity='hard'` | 显示 `fix.command`(可一键复制)或 `fix.link` | 换 provider → 跳设置 |
| **5** | WeChat 账号过期或没绑 | `accounts.count=0` 或 `expiredBots[]` 非空 | 重新扫码(`routeToWizardBind`) | 看 ilink 日志 |
| **6** | 白名单空,没人能用 | `accounts.count>0` 且 `access.allowFromCount=0` | 去设置 → 允许列表 | 看 access.json |
| **7** | Dashboard 自己卡了(罕见) | `doctor-poller.lastError` 连续 N 次失败 **且**直接 ping `/v1/health` 成功 | 重启 Dashboard(`Cmd-Q` 重开) | 重启电脑 |
| **8** | Windows 权限不够 | 上一次 restart 后 `pid` 没换 | 右键以管理员身份运行 | PowerShell `Stop-ScheduledTask` |

**Priority order in `diagnose()` matters** — earlier checks shadow later ones:
1. Windows pid-unchanged (8) — only after a known restart attempt
2. lastError but health-ping ok (7) — frontend stuck
3. provider hard-missing (4) — daemon alive but every reply will fail
4. service not installed (3)
5. daemon dead → 1 or 2 by pid-presence
6. access empty (6)
7. accounts empty / expired (5)
8. all green (0)

---

## File Map

| File | Action |
|---|---|
| `apps/desktop/src/view.js` | Modify: add `diagnose(report, healthOk, lastError, lastRestart)` pure function (export). Place near `restartButtonState()` line 151. |
| `apps/desktop/src/view.test.ts` | Modify: add 9-case suite (one per code 0–8) + edge cases (provider check shadows service-state, expiredBots vs accounts.count=0 differentiation, lastRestart absent). |
| `apps/desktop/src/modules/dashboard.js` | Modify: rewrite `restartDaemon` (line 229). Sequence: (1) refresh doctor + ping `/v1/health` in parallel, (2) call `diagnose()`, (3) render diagnosis card, (4) on primary-button click route to the right action (existing `routeToWizardService/Bind`, new `routeToProviderSettings/AccessSettings`, or `runRestartSequence` which is the existing service-stop+kill+start chain renamed). |
| `apps/desktop/src/modules/dashboard.test.ts` | Modify: cover the 9 diagnose-to-action branches with fake doctor reports. |
| `apps/desktop/src/index.html` | Modify: add `<div id="reconnect-diagnose-card">` slot near the existing `#dash-pending`. Hidden by default. |
| `apps/desktop/src/main.js` | Modify: add `routeToProviderSettings` + `routeToAccessSettings` callbacks to `deps`. Add `healthProbe` to deps — initially a stub returning `null` so Step 1 ships without Step 3 plumbing. |
| `apps/desktop/src/health-probe.js` | **New** (Step 3 only): direct fetch of `http://127.0.0.1:<port>/v1/health` with the internal-api bearer token. Needs daemon to expose the port via a new doctor field or via Tauri IPC. |
| `apps/desktop/playwright/dashboard.spec.ts` | Modify: add per-category click → card-text assertion (3-4 scenarios is enough — daemon dead, provider missing, account expired, all-green-no-card). |
| `src/cli/doctor.ts` | (Step 3 only) Modify: include `daemon.internal_api: { port, token_file_path }` in DaemonSnapshot when daemon alive, so dashboard can ping `/v1/health` without parsing internal-token from disk. |

---

## Tasks

### Step 1 — `diagnose()` pure function + tests (M0, ~1 day)

This is the foundation. Self-contained, ships independently of UI rewrite.

- [ ] **T1.1** Write 9 failing test cases in `view.test.ts` — one per code 0–8 with minimal mock `report` / `healthOk` / `lastError` / `lastRestart` arguments. Verify RED.
- [ ] **T1.2** Add 4 priority-order test cases: (a) provider-hard shadows service-installed=false; wait — actually provider check should NOT shadow "service not installed" because if service isn't installed, daemon isn't running, so provider hard-missing is moot. Revisit priority list — provider check requires `daemon.alive=true`. Reorder: (1) win pid-unchanged → (2) frontend stuck → (3) daemon-state branch (1/2/3 by pid+installed) → (4) provider hard (only if daemon alive) → (5) access empty → (6) accounts/expired → (0).
- [ ] **T1.3** Add 4 edge cases: (a) `lastRestart=null` + Windows = no code 8; (b) `lastError=null` = no code 7; (c) `expiredBots=[]` + `accounts.count>0` = no code 5; (d) all-green report returns code 0 with no card.
- [ ] **T1.4** Implement `diagnose()` in `view.js` matching the type below. Verify GREEN.
- [ ] **T1.5** Run `bun --bun vitest run apps/desktop/src/view.test.ts` — confirm full pass.

**Function signature:**

```ts
export interface DiagnoseInput {
  report: DoctorReport          // from doctor-poller.current; required
  healthOk: boolean | null      // null when ping not yet wired (Step 1); ignored when null
  lastError: unknown | null     // doctor-poller.lastError; null if last poll succeeded
  lastRestart?: { pidUnchanged: boolean } | null
}

export interface DiagnoseOutput {
  code: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
  title: string                 // 用户语言一句话,例: "后台服务挂了"
  hint: string                  // 一段补充,例: "Daemon 进程残留 pid 文件但已死,可能是 OOM 或 panic"
  primary: { label: string; action: PrimaryAction }
  secondary?: { label: string; action: SecondaryAction }
}

export type PrimaryAction =
  | { kind: 'auto-dismiss' }                          // code 0
  | { kind: 'run-restart-sequence' }                  // code 1, 2
  | { kind: 'route-to-wizard'; step: 'service' | 'wechat' }  // code 3, 5
  | { kind: 'show-fix'; command?: string; link?: string }    // code 4
  | { kind: 'route-to-settings'; section: 'access' | 'provider' }  // code 6
  | { kind: 'restart-dashboard' }                     // code 7
  | { kind: 'show-platform-hint'; platform: 'win32' } // code 8
```

### Step 2 — Diagnosis card UI + restartDaemon rewrite (M1, ~1 day)

- [ ] **T2.1** Add `#reconnect-diagnose-card` slot in `index.html`. Hidden by default. Style: subtle border, title bold, hint smaller, primary button on right, secondary as text link.
- [ ] **T2.2** Write `renderDiagnoseCard(deps, diagnosis)` in `dashboard.js`. Pure DOM mutation, no state, no async — clicking the primary button dispatches to deps callbacks per `PrimaryAction.kind`.
- [ ] **T2.3** Rewrite `restartDaemon(deps)` (line 229): refresh doctor → call `diagnose({ report, healthOk: null, lastError: deps.doctorPoller.lastError })` → render card. Move the actual stop+kill+start chain into a new `runRestartSequence(deps)` function, called from the card only when primary.kind === 'run-restart-sequence'.
- [ ] **T2.4** Add 4 Playwright scenarios in `dashboard.spec.ts`: dead-daemon click shows code-1 card and triggers restart on primary; account-expired click shows code-5 card; provider-missing click shows code-4 card with copy button; all-green click shows nothing (or "一切正常" toast that dismisses in 1.5s).
- [ ] **T2.5** Verify: `bun --bun vitest run apps/desktop/`, then `bun --bun playwright test --grep "reconnect-diagnose"`.

### Step 3 — Health-probe direct ping (M2, ~half day)

Unlocks category 7 (frontend stuck vs daemon stuck differentiation).

- [ ] **T3.1** Extend `DaemonSnapshot` in `src/cli/doctor.ts:26` with `internal_api?: { port: number; token_file_path: string }` when daemon alive.
- [ ] **T3.2** Wire `readDaemon(stateDir)` to read those from the daemon's runtime-info file.
- [ ] **T3.3** Add `apps/desktop/src/health-probe.js` exporting `pingHealth(port, tokenFilePath, timeoutMs): Promise<boolean>`. Uses `fetch` + `AbortController`.
- [ ] **T3.4** Replace `healthOk: null` stub in dashboard.js with real `await pingHealth(...)`. Update Playwright scenarios.

### Step 4 — Telemetry (M3, ~1 hour)

- [ ] **T4.1** On every reconnect click, write a `[RECONNECT_DIAGNOSE]` line to channel.log via existing `deps.invoke("wechat_cli_json", { args: ["log", "info", ...] })` (or new IPC if log-from-frontend not wired). Fields: `code`, `daemon_alive`, `service_installed`, `provider`, `lastError_present`, `health_ok`.
- [ ] **T4.2** Sanity: 1 week after ship, grep the log for code distribution. If code-0 (no-op) is 80%+, we know the button is being mis-clicked → consider de-emphasising it.

---

## Reusable scaffolding already in the repo

| What | Where | Why useful |
|---|---|---|
| `nextActions[]` enum | `src/cli/doctor.ts:171-190` | Daemon already classifies into 7 actions (`install_bun`, `install_codex`, `run_wechat_setup`, `fix_access_allowlist`, `install_service`, `start_service`, `install_cursor`) — diagnose() mostly maps these to UI codes |
| `checks.X.fix: { command, action, link }` | Each failed check carries its own fix hint | Code 4's "show command" button just renders `report.checks[provider].fix.command` |
| `routeToWizardService` / `routeToWizardBind` | `apps/desktop/src/main.js:118,124` | Already injected via deps — codes 3 and 5 reuse |
| `doctorPoller.lastError` | `apps/desktop/src/doctor-poller.js:64` | Exposed but not yet consumed by UI — code 7 uses |
| `serviceStatus()` four-state machine | `src/cli/doctor.ts:337-346` | running/stale/stopped/missing maps to codes 0/1/2/3 |

---

## Out of scope (intentional)

- **Auto-reconnect**: no background retry. User intent is what triggers diagnose — silently restarting daemon when poller fails would mask root causes the user needs to see.
- **Dashboard refactor to use a state-machine library**: keep vanilla JS pattern.
- **Real-time event stream (WebSocket/SSE)**: still polling-based; reconnect button is the affordance.
- **Reconnect history view**: telemetry goes to log only; no UI for now.

---

## Verification

- `bun --bun tsc --noEmit` — clean (no new ambient types)
- `bun --bun vitest run` — all passing (2130 baseline + new tests)
- `bun run depcheck` — 0 violations
- Manual smoke (each developer machine): kill daemon → click reconnect → expect code-1 card → click primary → expect "已重启" + card dismisses
