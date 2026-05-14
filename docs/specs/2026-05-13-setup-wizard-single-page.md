# Spec · Setup Wizard · Single-page first-run

**Status**: Draft · 2026-05-13
**Scope**: Collapse the 4-step desktop setup wizard (doctor → provider → wechat → service) into a single page. Move backend toggles to a dashboard settings drawer. Silent-install the background service on first bind so window close never kills the daemon.
**Effort**: ~600 lines wizard.js/index.html rework + 1 service-manager auto-install entry point + 1 auth-error translation path + ~15 tests
**Depends on**: existing service-manager.ts (launchagent / systemd-user / scheduled-task — already admin-free on all 3 OS)
**Targets**: v0.6 desktop refresh

---

## Problem

The current 4-step wizard (`apps/desktop/src/index.html:23-188`) treats first-run as a sequence of decisions a小白 user shouldn't have to make:

1. **Step 1 (doctor)** runs an env check that, in compiled-bundle mode, only ever shows two real rows: claude and codex (bun/git are hidden — see `view.js:18`, `doctor.ts:62-65`).
2. **Step 2 (provider)** asks the user to "choose an agent" — but v2.0 multi-provider makes selection a runtime choice (`/cc` / `/codex` / `/both` per chat). The choice at setup is fiction.
3. **Step 3 (wechat)** scans QR. This is the only step that actually has to happen up-front.
4. **Step 4 (service)** asks the user to click "安装并启动", then surfaces three power-user toggles (开机自启 / 自动同意工具调用 / 网络守护) before they've sent a single message.

Steps 1+2 are the same information presented twice. Step 4 is a wall of decisions whose tradeoffs require already understanding how the system behaves — exactly what first-run users don't have. Net effect: 4 button clicks to reach the dashboard, half of which serve no first-time decision.

The setup should answer one question: **"can I scan now?"** Everything else can be revisited from the dashboard.

## Goals

- **One page**, one primary action ("扫码绑定微信").
- **Two agent cards** that double as the env check — installed/not-installed, with install-guide link when missing.
- **Silent service install** on first bind, so closing the desktop window never silently kills the daemon.
- **No backend toggles in setup.** Move 开机自启 / 自动同意 / 网络守护 / 关窗即终止 to a dashboard settings drawer with sane defaults pre-applied.
- **0-agent gating**: 扫码 button disabled until at least one agent is detected; user can install an agent and the card refreshes live (doctor-poller already 2s-polls).
- **Auth-expired translation**: when an installed agent throws an auth error on the first message, surface a Chinese-friendly "登录已过期，请在电脑上重新 login" in WeChat, not the raw SDK error.

## Non-goals

- **Auth-state detection at setup time.** Cross-platform credential storage (Mac Keychain / Win Credential Manager / Linux libsecret) makes "installed but not logged in" fiddly to detect reliably without spending an SDK probe call. We catch the failure at first-message time instead. Cards stay binary: 已安装 / 未安装.
- **Multi-agent visual indication of "active" agent.** No active state — both agents are equally available, switched per-chat by user.
- **WSL bridging.** The existing `env-tip-wsl` notice (`wizard.js:41-53`) stays as a folded detail on the page; not in scope to fix the underlying limitation here.
- **Re-onboarding existing v0.5.x users.** Users with an `accounts/<id>/` already bound skip setup entirely and land in dashboard — same as today.

---

## The single page

```
┌────────────────────────────────────────────────────────────┐
│  wechat-cc                                                 │
│  把 AI agent 接到你的微信                                   │
│                                                            │
│  ┌──────────────────┐  ┌──────────────────┐                │
│  │  CC              │  │  CX              │                │
│  │  Claude Code     │  │  Codex           │                │
│  │  ✓ 已安装         │  │  ✗ 未安装         │                │
│  │  /usr/local/bin… │  │  安装指南 ↗       │                │
│  └──────────────────┘  └──────────────────┘                │
│                                                            │
│  ① 检测到 WSL  · GUI 仅识别 Windows 端 (折叠详情)             │
│                                                            │
│         [  扫码绑定微信  ─→  ]                              │
│                                                            │
│  扫码后进入控制台。后台服务、开机自启等可在控制台 设置 里调整。│
│  ──────────────────────────────────────────────────────── │
│  ● 服务状态：未启动                                          │
└────────────────────────────────────────────────────────────┘
```

### Agent cards

Two cards, side by side, each derived from `report.checks.{claude,codex}`:

| State | Visual | Text |
|---|---|---|
| `ok=true` | 浅绿 ink border, check icon | `✓ 已安装` + path 灰显 |
| `ok=false` | 边框去高亮, hint icon | `✗ 未安装` + `安装指南 ↗` link |

No "Recommended" badge, no per-agent "selected" state. Both cards remain clickable for future settings (e.g., per-agent model preferences in v0.7), but in v0.6 they are status displays only.

### CTA button

Single primary button: `扫码绑定微信 ─→`.

Disabled when both cards are `✗ 未安装`, with tooltip: `先在终端装一个 agent，本页会自动检测`.

Click handler does, in order:

1. Call `install_service_silently()` (new entry point — see Implementation below). Shows a thin progress strip under the button: `安装后台服务… [▰▰▰▱▱▱]`.
2. Start daemon via that service (no in-process spawn).
3. Wait for daemon HTTP alive (≤ 15s total: 5s normal + 10s extended).
4. Trigger `/setup` QR generation, open QR modal (modal, not page nav).
5. Poll scan status; on success close modal, route to dashboard.

If **any** of steps 1-3 fail, the button reverts to its idle label, an error strip appears under it (`后台服务安装失败 · 详情 ↓ · 重试`), and the user does **not** proceed to QR. This matches today's step-4 behavior — service must be running before binding. There is no in-process fallback: the entire value proposition of "关窗后 daemon 继续跑" depends on the service being installed, so degrading silently to in-process daemon would mislead users into thinking they're set up when they're not. Hard fail + retry button + log link is the right shape.

### What's gone from setup

| Removed | Where it lives now | Default |
|---|---|---|
| Env check page | Implicit in agent cards | — |
| Provider selection | Per-chat slash commands `/cc` `/codex` `/both` | — |
| Service install button | Auto-runs on first 扫码 click | always install |
| 开机自启 toggle | Dashboard → 设置 → 后台服务 | **ON** |
| 自动同意工具调用 (`--dangerously`) toggle | Dashboard → 设置 → 行为 | **ON** |
| 网络守护 toggle | Dashboard → 设置 → 行为 | OFF |
| 关窗即终止 daemon (new) | Dashboard → 设置 → 后台服务 | OFF |

---

## Silent service install

This is the core engineering chunk. Service-manager already supports admin-free install on all three OS:

| OS | Mechanism | File path | Sudo/UAC? |
|---|---|---|---|
| macOS | launchd user agent | `~/Library/LaunchAgents/wechat-cc.plist` | No |
| Linux | systemd `--user` | `~/.config/systemd/user/wechat-cc.service` | No |
| Windows | Scheduled task | `\wechat-cc` (user scope) | No (since v0.5.0 schtasks saga) |

What changes: instead of `apps/desktop/src/main.js` calling `installService` only when the user clicks "安装并启动", the new flow calls it as part of the 扫码 button's onclick. The progress events (`install-progress.json`) already exist and feed the desktop UI — we just hook them to a thin strip instead of a full step page.

### Failure modes

All three are handled the same way: surface the error inline under the 扫码 button (expandable details + retry), do **not** proceed to QR, do **not** fall back to in-process daemon. The user stays on the setup page until install succeeds — matching today's step-4 behavior, just inlined.

1. **launchd / systemd / schtasks invocation fails.** Possible causes: filesystem write fail, systemd not active in this session, schtasks denied by enterprise GPO.
   → Error strip: `安装后台服务失败 [详情] [重试]`. 详情 unfolds the underlying stderr + log path.
2. **Service installs but daemon fails to start.** Daemon errors logged to channel.log.
   → Same error strip, 详情 links to `channel.log` tail.
3. **Service installs and daemon starts but HTTP API doesn't come up within 5s.** Rare; likely port collision or migration in progress.
   → Extend the wait by 10s with progress feedback; if still down, treat as (2).

Rationale: the entire benefit of v0.6's silent install is "关窗后 daemon 继续跑". Falling back to an in-process daemon to "make setup feel smooth" would silently strip that benefit — the user would scan, chat, close the window, and only discover days later that their setup never installed the service. Hard fail is the honest shape.

---

## Auth-error translation

When an agent (claude or codex) throws an auth error on first message, the daemon currently surfaces the raw SDK error to the user via `send-reply.ts`. Replace with a normalized translator in the inbound pipeline:

```
// src/daemon/inbound/translate-agent-error.ts (new)
//
// Catches common agent failure signatures and rewrites them into
// 中文 user-facing strings. Falls through to raw error if no match.
//
//   "401 Unauthorized" / "session expired" / "API key" /
//   "OAuth token has expired" / similar
//     → "Claude 登录已过期，请在电脑上跑 `claude login` 后再试"
//
//   codex equivalents
//     → "Codex 登录已过期，请在电脑上重新 `codex login` 后再试"
```

Lives in `src/daemon/inbound/`. Inserted right before the final reply path; no behavioral change for non-auth errors.

**Why "已过期" not "需要登录"**: most failures of this kind happen after a working install — the user *has* logged in once, the session just lapsed. Phrasing it as "expired" matches reality and respects the user's prior setup work.

---

## Dashboard settings drawer

Out of strict scope for this spec, but the destination matters because we're moving 4 toggles. Sketch only:

```
Dashboard ─→ ⚙ 设置
  ├ 后台服务
  │   服务类型: launchd user agent / systemd user / scheduled task
  │   ☑ 开机自启
  │   ☐ 关窗即终止 daemon (高级)
  │   [卸载服务] [重装]
  ├ 行为
  │   ☑ 自动同意工具调用（关闭后微信里每次都要回 y/n）
  │   ☐ 网络守护（30s 探活）
  ├ 账号
  │   <已绑定账号列表 + 解绑>
  ├ Agent
  │   Claude path: /usr/local/bin/claude  [重新检测]
  │   Codex path:  未安装  [安装指南 ↗]
```

The full drawer design ships in a follow-up spec; this spec only locks **where toggles move** and **what defaults they get** — see table in "What's gone from setup".

---

## Flow

```
[GUI 首次启动]
   │
   ▼
[setup 单页]
   │  agent cards live-polled (2s)
   │
   │  ┌─ 0 agents: 按钮 disabled
   │  └─ ≥1 agent: 按钮可点
   │
   ▼
[点击 "扫码绑定微信"]
   │
   ├─→ install_service_silently()
   │      │
   │      │     ┌── 失败 ──→ 按钮下方错误条
   │      │     │              [详情] [重试]
   │      │     │              留在本页，不进 QR
   │      ▼     │
   │   service ready
   │      │
   │      ▼
   │   daemon 启动 (HTTP alive ≤15s)
   │      │
   │      │     ┌── 超时 ──→ 同上错误条
   │      ▼     │
   │   ✓ 成功 ──┘
   ▼
[QR modal 弹出]
   │  /setup 生成 QR
   │  扫码 + 手机确认
   │
   ▼
[扫码成功] → dashboard
```

---

## Implementation

### Files touched

| File | Change |
|---|---|
| `apps/desktop/src/index.html` | Delete `screen-doctor` / `screen-provider` / `screen-service`. Replace 4-step nav with single-page block. QR modal moves into a `<dialog>` element. |
| `apps/desktop/src/modules/wizard.js` | Collapse to single-page renderer. Remove `STEP_ORDER`, `showStep`. Keep `renderDoctorWizard` but trim to two agent cards only. Add `enableScanButton(report)`. |
| `apps/desktop/src/main.js` | New `handleScanClick()`: sequence install → start → QR. Remove all step-navigation wiring. |
| `apps/desktop/src/modules/qr.js` *(new)* | Extracted QR modal logic (currently inlined). |
| `apps/desktop/src/styles.css` | Drop `.steps`, `.step`, `.wizard .screen`. Add `.setup-page`, `.agent-cards`, `.install-strip`, `.qr-modal`. |
| `src/daemon/inbound/translate-agent-error.ts` *(new)* | Auth-error → Chinese friendly translation. |
| `src/daemon/inbound/build.ts` | Wire translate-agent-error into reply path. |
| `apps/desktop/src/modules/settings-drawer.js` *(new, stub)* | Stub the drawer with 后台服务 / 行为 / Agent sections so toggles have a home. Full drawer ships in follow-up spec; this spec only delivers the structural shell so removed setup toggles can reappear there with their defaults. |

### Tests

| Test | Verifies |
|---|---|
| `wizard.test.ts` | Agent cards reflect doctor report; CTA disabled iff both agents missing. |
| `wizard.test.ts` | 0-agent → 1-agent live transition (doctor poller emits) enables CTA without reload. |
| `main.test.ts` | `handleScanClick` calls install → start → QR in order; on install failure renders error strip and does **not** proceed to QR or spawn in-process daemon. |
| `translate-agent-error.test.ts` | 401 / token expired / API key errors → "登录已过期" message; non-auth errors pass through. |
| Playwright `wizard.spec.ts` | Single-page DOM contract; clicking 扫码 with no agents is a no-op; with ≥1 agent triggers QR modal. |
| Playwright `wizard.spec.ts` | After successful bind, route to `#dashboard` not `#screen-service`. |

### Migration of v0.5.x users

Users who already have at least one bound account skip setup entirely (existing `hasAccounts()` gate in main.js). No data migration needed.

For users mid-setup at upgrade time: they'll land on the new single page on next launch. Their partial state (e.g., env-check passed but no QR scanned) is harmless to discard — nothing was persisted that the new page can't re-derive.

### Default migration for upgrading users

The 4 toggles get new defaults (ON / ON / OFF / OFF). For existing users with explicit choices saved:

| Setting | Has saved value? | Behavior |
|---|---|---|
| 开机自启 | Yes | Preserve user's saved value |
| 开机自启 | No | Default ON, install service on next launch |
| 自动同意工具调用 | Yes | Preserve |
| 自动同意工具调用 | No | Default ON |
| 网络守护 | Yes | Preserve |
| 网络守护 | No | Default OFF (unchanged) |

Upgrading users who had service uninstalled and have not opted into a future relaunch are not silently re-enrolled — their explicit "off" choice wins. Only fresh installs and users who never made a choice get the new defaults.

---

## Risks

1. **Silent install on Windows could fail on locked-down corporate machines** (GPO blocks schtasks). Same failure mode the current v0.5.x step-4 hits; user is blocked at the setup page with an actionable error strip until resolved. No regression vs today.
2. **The "auth expired" translator misfires on a non-auth error that happens to mention "401" in its body.** Mitigated by matching on stable SDK error shapes, not free-form substring search. Worst case: a misleading hint, not a behavior break.
3. **Moving toggles to a not-yet-built settings drawer.** This spec ships the drawer shell so the toggles have a destination. The full drawer design (per-account preferences, agent path overrides, etc.) gets its own spec — but the four moved-out toggles must work in the shell as soon as v0.6 ships, otherwise we've stranded users who want strict mode.
4. **Users who relied on the visible 4-step wizard as a sense of "installation completeness".** Mitigated by the explicit progress strip under the 扫码 button — the install still happens, it's just inline and labelled, not a separate screen.

## Rollout

- v0.6 desktop only. CLI `wechat-cc setup` flow is unchanged.
- Release notes call out: "首次安装更简单 · 关窗不再停止 daemon · 后台服务自动安装"。
- Existing v0.5.x users see no change unless they enter setup again (which they generally don't after first bind).
