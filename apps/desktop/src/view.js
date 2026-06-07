// Pure view-model functions. No DOM, no IPC, no globals — easy to unit-test
// from Bun (see view.test.ts) without spinning up a browser.

export function doctorRows(report) {
  // Re-pack the wrapper objects (accounts/access/provider) with their
  // human-friendly path while preserving severity + fix from doctor.ts.
  // Without the spread, the wizard's renderFixHint never sees the fix
  // metadata for these three checks.
  const accounts = report.checks.accounts
  const access = report.checks.access
  const provider = report.checks.provider
  const daemon = report.checks.daemon
  // In compiled-bundle mode the sidecar carries its own bun runtime and
  // never shells out to git, so showing those rows to a .msi/.dmg user
  // surfaces a developer-only concern and (worse) tells Win 小白 to run
  // a Unix-only `curl | bash` install command. Hide them entirely.
  const rows = []
  if (report.runtime !== "compiled-bundle") {
    rows.push(["Bun", report.checks.bun])
    rows.push(["Git", report.checks.git])
  }
  rows.push(["Claude", report.checks.claude])
  rows.push(["Codex", report.checks.codex])
  // Cursor's doctor check uses {ok, apiKeySet, sdkInstalled} — repack into
  // the {ok, path} shape doctorRows consumers expect. Path string surfaces
  // which leg is missing so the human-readable doctor output stays useful.
  if (report.checks.cursor) {
    const cursor = report.checks.cursor
    const path = cursor.ok
      ? "SDK + API key 就绪"
      : cursor.sdkInstalled && !cursor.apiKeySet
        ? "缺少 CURSOR_API_KEY"
        : !cursor.sdkInstalled && cursor.apiKeySet
          ? "缺少 @cursor/sdk"
          : "未配置"
    rows.push(["Cursor", { ok: !!cursor.ok, path }])
  }
  rows.push(["微信账号", { ...accounts, path: `${accounts.count} 个账号` }])
  rows.push(["Allowlist", { ...access, path: `${access.allowFromCount} 个用户` }])
  rows.push(["Provider", { ...provider, path: provider.provider }])
  rows.push(["Daemon", { ok: daemon.alive, path: daemon.alive ? `pid ${daemon.pid}` : "stopped" }])
  return rows
}

// Confirmed-scan copy keyed on `scenario` (see setup-flow.ts Scenario type).
// Tells 小白 users what actually happened — the previous "绑定成功 +
// accountId" was identical for first-scan, re-scan, redundant, and account-
// switch, which made re-scanning feel like a fresh binding every time.
// See docs/specs/2026-05-10-rescan-feedback.md.
export const SCAN_SCENARIO_COPY = {
  first:       { title: "连接成功",     message: "可以开始用了。" },
  reconnect:   { title: "重新连接成功", message: "之前的记忆和对话都还在，可以接着用。" },
  redundant:   { title: "已是连接状态", message: "你已经连接了这个账号。这次扫码刷新了连接，原对话不受影响。" },
  new_account: { title: "切换到新账号", message: "原账号的记忆保留在本地，但当前只接收新账号的消息。" },
}

// Compute the next QR-screen UI state from an incoming setup-poll result.
// Returns the patch to apply to UI + state. `prev.currentBaseUrl` may be
// updated by the redirect branch; the caller writes it back.
export function pollAdvance(prev, result) {
  if (result.status === "scaned") {
    return { stopTimer: false, qrTitle: "手机确认", qrMessage: "在微信里确认登录。", continueEnabled: false }
  }
  if (result.status === "scaned_but_redirect") {
    return { stopTimer: false, currentBaseUrl: result.baseUrl }
  }
  if (result.status === "confirmed") {
    // Defensive fallback to 'first' if scenario is missing — keeps an old
    // daemon + new desktop pairing from breaking the wizard. Schema enforces
    // the field on production payloads.
    const copy = SCAN_SCENARIO_COPY[result.scenario] ?? SCAN_SCENARIO_COPY.first
    return {
      stopTimer: true,
      qrTitle: copy.title,
      qrMessage: copy.message,
      continueEnabled: true,
    }
  }
  if (result.status === "expired") {
    return {
      stopTimer: true,
      qrTitle: "二维码过期",
      qrMessage: "刷新二维码后重新扫码。",
      continueEnabled: false,
    }
  }
  // status: "wait" or anything else — keep polling, don't change copy.
  return { stopTimer: false }
}

// Format the daemon health line shown in the wizard sidebar status strip
// + the dashboard rail-foot. The green/amber dot already conveys "alive vs
// not"; we drop the redundant 运行中 word so pid + wall clock + gear all fit
// in the 196px rail. Dead state still says 未运行 because there's no pid to
// stand in for it.
export function daemonStatusLine(daemon) {
  return {
    cls: daemon.alive ? "ok" : "warn",
    text: daemon.alive ? `pid=${daemon.pid}` : "未运行",
  }
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  }[ch]))
}

// ─── dashboard / mode-routing helpers ─────────────────────────────────

// Boot routing: dashboard once everything is set up — provider OK, an
// account is bound, AND the service is installed. Wizard otherwise,
// parked at the first unfinished step so power users don't redo work.
//
// Critically, a user who finished `bind WeChat` but had `install service`
// fail (e.g. Windows schtasks access-denied) lands BACK in the wizard at
// the service step instead of being silently dropped on a dashboard with
// a stopped daemon and no obvious way forward.
export function initialMode(report) {
  const hasAccount = report.checks.accounts.count > 0
  const serviceInstalled = !!report.checks.service?.installed
  const hasAnyProvider = !!(report.checks.claude?.ok || report.checks.codex?.ok)
  if (hasAccount && report.checks.provider.ok && serviceInstalled) return { mode: "dashboard" }
  // bun/git only block routing in source mode; in compiled-bundle the
  // sidecar is self-contained, so a user without system bun on their
  // Windows machine should NOT get parked on the env-check screen — they
  // should land where the actual missing piece is (provider / wechat /
  // service).
  if (report.runtime !== "compiled-bundle" && (!report.checks.bun.ok || !report.checks.git.ok)) {
    return { mode: "wizard", step: "doctor" }
  }
  if (!hasAnyProvider) return { mode: "wizard", step: "doctor" }
  if (!hasAccount) return { mode: "wizard", step: "wechat" }
  if (!report.checks.provider.ok) return { mode: "wizard", step: "doctor" }
  return { mode: "wizard", step: "service" }
}

// Determine the dashboard "restart daemon" button's mode + label given the
// service+daemon state. The pre-existing button blindly invoked
// `service stop` + `service start`, which fails noisily when no service unit
// is registered (systemctl: Unit not found, launchctl: Could not find domain).
// Now we surface three branches:
//   action="restart"      — service installed → safe to stop+start
//   action="install"      — service missing → button label points at wizard
//                           step "service"; clicking should navigate, not
//                           shell out to a broken command
//   action="install" + label="先停掉前台 daemon" — daemon is alive but no
//                           service is registered (foreground source-mode
//                           daemon). Restart would either no-op (no unit)
//                           or, post-install, collide with the PID lock.
export function restartButtonState(daemon, service) {
  const installed = !!(service && service.installed)
  if (installed) {
    return { action: "restart", label: "重启 daemon", helper: null }
  }
  if (daemon && daemon.alive) {
    return {
      action: "install",
      label: "去安装服务",
      helper: `daemon 在前台跑着 (pid ${daemon.pid})，需要先安装为 service 才能在 GUI 里管它`,
    }
  }
  return { action: "install", label: "去设置向导", helper: "尚未安装为后台服务；点这里走完设置向导。" }
}

/**
 * Analyse the current system state and return a reconnect-diagnosis card
 * description, or a code-0 "auto-dismiss" signal when everything is healthy.
 *
 * Priority order (first matching rule wins):
 *  8 — win pid-unchanged  only after a known restart attempt on win32
 *  7 — frontend stuck     lastError non-null AND healthOk=true
 *  3 — service not installed
 *  1 — daemon dead + service installed + pid ≠ null (crashed/OOM)
 *  2 — daemon dead + service installed + pid = null (never started)
 *  4 — provider hard-missing  ONLY when daemon.alive=true
 *  5 — accounts empty or expired
 *  6 — allowlist empty
 *  0 — all green (auto-dismiss, no card)
 *
 * See docs/plans/dashboard-reconnect-diagnose.md — Step 1.
 *
 * @param {{
 *   report: import('../src/cli/doctor.ts').DoctorReport,
 *   healthOk: boolean | null,   // null = health-probe not yet wired (Step 1 stub); code 7 never fires
 *   lastError: unknown | null,
 *   lastRestart?: { pidUnchanged: boolean } | null,
 *   platform?: string,
 * }} input
 * @returns {{
 *   code: 0|1|2|3|4|5|6|7|8,
 *   title: string,
 *   hint: string,
 *   primary: { label: string, action: object },
 *   secondary?: { label: string, action: object },
 * }}
 */
export function diagnose({ report, healthOk, lastError, lastRestart = null, platform = 'linux' }) {
  const daemon = report.checks.daemon
  const service = report.checks.service
  const accounts = report.checks.accounts
  const access = report.checks.access
  const providerName = report.checks.provider?.provider ?? 'claude'
  const providerCheck = report.checks[providerName]
  const expiredBots = report.expiredBots ?? []

  // ── 8: win32 pid-unchanged after a restart attempt ─────────────────
  // Only fire if we actually attempted a restart AND the pid stayed the same
  // (symptom: service start succeeded but the process token didn't change —
  // usually a Windows UAC / permissions issue preventing the old process from
  // dying). Requires an explicit lastRestart record so we don't misfire on
  // first load.
  if (lastRestart?.pidUnchanged === true && platform === 'win32') {
    return {
      code: 8,
      title: "Windows 权限不够",
      hint: "上一次重启后进程 pid 没变，服务可能没有足够权限替换旧进程。",
      primary: { label: "以管理员身份运行", action: { kind: 'show-platform-hint', platform: 'win32' } },
    }
  }

  // ── 7: frontend stuck (dashboard poll error, but daemon itself is fine) ──
  // lastError means the doctor-poller threw, yet healthOk=true means /v1/health
  // responds — so the daemon is alive and the bug is in our frontend poll loop.
  if (lastError != null && healthOk === true) {
    return {
      code: 7,
      title: "Dashboard 自己卡了",
      hint: "本地轮询出错，但 /v1/health 正常 — daemon 没问题，重启 Dashboard 可修复。",
      primary: { label: "重启 Dashboard", action: { kind: 'restart-dashboard' } },
    }
  }

  // ── daemon-state branch (3 / 1 / 2) ──────────────────────────────────
  if (!service?.installed) {
    // ── 3: service not installed ────────────────────────────────────
    return {
      code: 3,
      title: "后台服务没安装",
      hint: "尚未安装为后台服务，daemon 无法随系统启动。",
      primary: { label: "去向导安装服务", action: { kind: 'route-to-wizard', step: 'service' } },
    }
  }

  if (!daemon.alive) {
    if (daemon.pid !== null) {
      // ── 1: daemon dead + pid ≠ null (crashed / OOM) ─────────────
      return {
        code: 1,
        title: "后台服务挂了",
        hint: "Daemon 进程残留 pid 文件但已死，可能是 OOM 或 panic。",
        primary: { label: "一键重启后台", action: { kind: 'run-restart-sequence' } },
        secondary: { label: "查看日志", action: { kind: 'open-logs' } },
      }
    } else {
      // ── 2: daemon dead + pid = null (never started after install) ─
      return {
        code: 2,
        title: "后台服务从没启动过",
        hint: "服务已安装但尚未启动，或启动后立刻退出。",
        primary: { label: "启动后台服务", action: { kind: 'run-restart-sequence' } },
        secondary: { label: "查看日志", action: { kind: 'open-logs' } },
      }
    }
  }

  // ── 4: provider hard-missing (only checked when daemon.alive=true) ─────
  // Follow the active provider name to its per-provider check row — the
  // aggregate `provider` check carries severity only when the binary is
  // absent; the per-provider row (claude/codex/cursor) is the canonical
  // severity source per the plan spec.
  if (providerCheck?.severity === 'hard') {
    const fix = providerCheck.fix ?? {}
    return {
      code: 4,
      title: "AI 工具缺失",
      hint: `选定的 provider "${providerName}" 不可用，daemon 启动但每次回复都会失败。`,
      primary: {
        label: "查看修复方法",
        action: { kind: 'show-fix', ...(fix.command ? { command: fix.command } : {}), ...(fix.link ? { link: fix.link } : {}) },
      },
      secondary: { label: "切换 provider", action: { kind: 'route-to-settings', section: 'provider' } },
    }
  }

  // ── 6: allowlist empty ─────────────────────────────────────────────────
  // Checked before code 5 (accounts): if the user has no allowlist entries,
  // pointing them at WeChat re-bind is premature — they have no users to talk
  // to even after binding. Surface the access config first.
  if (access.allowFromCount === 0) {
    return {
      code: 6,
      title: "白名单是空的",
      hint: "有绑定账号但没有任何用户在白名单，没人能用 bot。",
      primary: { label: "去设置允许列表", action: { kind: 'route-to-settings', section: 'access' } },
    }
  }

  // ── 5: accounts empty or all expired ──────────────────────────────────
  if (accounts.count === 0) {
    return {
      code: 5,
      title: "没有绑定微信账号",
      hint: "还没绑定微信账号，扫码后才能收发消息。",
      primary: { label: "去扫码绑定", action: { kind: 'route-to-wizard', step: 'wechat' } },
    }
  }
  if (expiredBots.length > 0) {
    return {
      code: 5,
      title: "微信账号已过期",
      hint: "账号过期，bot 无法收发消息，重新扫码可恢复。",
      primary: { label: "重新扫码", action: { kind: 'route-to-wizard', step: 'wechat' } },
    }
  }

  // ── 0: all green ───────────────────────────────────────────────────────
  return {
    code: 0,
    title: "没事，只是 dashboard 没刷新",
    hint: "Daemon 运行正常，无需操作。",
    primary: { label: "好的", action: { kind: 'auto-dismiss' } },
  }
}

// Connection verdict for the overview hero. Three honest states:
//   connected   — this machine holds the live WeChat connection
//   recovering  — transient: daemon down / not yet polling (auto-recovers)
//   taken_over  — terminal: another device rebound the bot (errcode=-14);
//                 needs a re-scan to reclaim, does NOT self-heal.
// Inputs come from the doctor report + the last probe result (if any).
export function dashboardHero({ daemonAlive, accountCount, expiredCount = 0, lastProbe = null }) {
  if (lastProbe?.state === 'taken_over' || expiredCount > 0) {
    return { state: 'taken_over', tone: 'warn', headline: '本机未连接', meta: '连接在其他设备 · 重新扫码可接管' }
  }
  if (lastProbe?.state === 'connected' || (daemonAlive && accountCount > 0)) {
    return { state: 'connected', tone: 'ok', headline: 'AI 正在陪伴中', meta: '连接正常' }
  }
  return { state: 'recovering', tone: 'warn', headline: '暂时失联', meta: '正在恢复连接…' }
}

// Choose post-account-delete confirmation copy. When the service is not
// installed there's no daemon-managed restart to suggest — direct the user
// to wizard step instead. Mirrors restartButtonState's branching.
export function deleteAccountConfirmCopy(name, service) {
  const installed = !!(service && service.installed)
  if (installed) return `已删除 ${name} · 重启 daemon 生效`
  return `已删除 ${name} · 去设置向导启动后台服务以生效`
}

// Each row for the dashboard accounts table. Resolve a friendly display
// name through user_names.json (keyed by the wechat userId that owns the
// scan); fall back to the short bot id (directory name minus -im-bot).
// expiredBots — list of {botId, firstSeenExpiredAt} from the SQLite
// session_state table (via the doctor report) drives the badge. Account
// rows for which there is no expired entry are
// shown as `active` (we don't have a positive heartbeat from ilink — only
// the errcode=-14 negative signal).
// admins — list of wechat userIds from access.json admins[]. Rows whose
// userId is in admins[] get isAdmin:true and sort to the front of the list
// (stable within each group, so relative order of non-admin rows is preserved).
export function accountRows(items, userNames = {}, expiredBots = [], admins = [], now = Date.now()) {
  const expiredById = Object.create(null)
  for (const b of expiredBots) expiredById[b.botId] = b
  const rows = items.map(item => {
    const friendly = userNames[item.userId]
    const shortId = (item.id || "").replace(/-im-bot$/, "")
    const expired = expiredById[item.id]
    const badge = expired
      ? { tone: "warn", label: `已过期 · ${formatRelativeTime(expired.firstSeenExpiredAt, now)}` }
      : { tone: "ok", label: "active" }
    return {
      name: friendly || shortId || item.id,
      id: item.id,
      userId: item.userId,
      isAdmin: Array.isArray(admins) && admins.includes(item.userId),
      badge,
      expired: !!expired,
    }
  })
  // Stable sort: admin rows first, then non-admin rows in original order.
  return rows.sort((a, b) => (b.isAdmin ? 1 : 0) - (a.isAdmin ? 1 : 0))
}

// Map a Mode discriminated-union (RFC 03) to a short user-facing badge.
// label   — Chinese display text (matches /chat、/both、/cc 用语)
// detail  — secondary line (e.g. "claude" for solo, "codex+cc" for chatroom)
// tone    — CSS class hint: "solo" | "parallel" | "primary" | "chatroom"
//
// Defensive against partial/legacy shapes — older conversations.json
// entries written before P2 may have mode={kind:'solo'} without a
// provider field. Falls back to "—".
export function modeBadge(mode) {
  if (!mode || typeof mode !== "object") return { label: "—", detail: "", tone: "solo" }
  if (mode.kind === "solo") {
    return { label: "Solo", detail: mode.provider || "—", tone: "solo" }
  }
  if (mode.kind === "parallel") {
    const peers = Array.isArray(mode.providers) && mode.providers.length > 0 ? mode.providers.join(" + ") : "—"
    return { label: "Parallel", detail: peers, tone: "parallel" }
  }
  if (mode.kind === "primary_tool") {
    const primary = mode.primary || "—"
    const secondary = mode.secondary || "—"
    return { label: "Primary", detail: `${primary} (tool: ${secondary})`, tone: "primary" }
  }
  if (mode.kind === "chatroom") {
    const a = mode.providers?.[0] || "—"
    const b = mode.providers?.[1] || "—"
    return { label: "Chatroom", detail: `${a} ↔ ${b}`, tone: "chatroom" }
  }
  return { label: mode.kind || "—", detail: "", tone: "solo" }
}

// View-model for the dashboard's per-chat mode table.
// items — output of `wechat-cc conversations list --json`'s `conversations`
//   envelope. PR5 (Task 22) added user_id/account_id alongside user_name
//   sourced from conversationStore.getIdentity; the table renders those
//   as primary columns so chatId can drop to a row tooltip.
// Returns an array sorted by `tone` then chat_id (deterministic for tests).
export function conversationRows(items) {
  if (!Array.isArray(items)) return []
  return items.map(it => {
    const badge = modeBadge(it.mode)
    return {
      chatId: it.chat_id,
      name: it.user_name || it.chat_id,
      userId: it.user_id ?? null,
      accountId: it.account_id ?? null,
      userName: it.user_name ?? null,
      badge,
    }
  }).sort((a, b) => {
    if (a.badge.tone !== b.badge.tone) return a.badge.tone.localeCompare(b.badge.tone)
    return a.chatId.localeCompare(b.chatId)
  })
}

export function formatRelativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ""
  const diff = Math.max(0, now - t)
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return "刚刚"
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  return `${day} 天前`
}

// ─── update card view-models ──────────────────────────────────────────

// Single source of truth for how each `UpdateReason` (from update.ts) renders
// in the GUI. Adding a new reason: add one row here. Both `updateProbeLine`
// and `updateApplyLine` consult this table — they only diverge in the
// framing word (检查失败 / 升级被拒 / 升级失败) which is derived from the
// row's `severity`.
//
// Tone legend on the rendered card:
//   "ok"   — up to date / success (only emitted by happy-path branches, not
//            from this table)
//   "info" — update available, primary action
//   "warn" — soft-reject: applyUpdate refused, but the user can fix it
//            (dirty tree, diverged commits)
//   "bad"  — hard failure: something broke (fetch, pull, install, stop)
//   "hide" — desktop bundle, no git repo nearby — suppress the whole card.
//            User updates by re-downloading from GitHub Releases.
//
// `body(details)` reads optional structured details from the result; static
// strings are wrapped in a constant arrow to keep the row shape uniform.
export const UPDATE_REASON_COPY = {
  not_a_git_repo: {
    severity: "hide",
    label: "",
    body: () => "",
  },
  dirty_tree: {
    severity: "warn",
    label: "本地有未提交修改",
    body: (details) => {
      const files = details?.dirtyFiles || []
      if (!files.length) return "先 commit/stash/discard 再试。"
      const head = files.slice(0, 4).join("、")
      return `未提交：${head}${files.length > 4 ? ` 等 ${files.length} 个` : ""}`
    },
  },
  diverged: {
    severity: "warn",
    label: "本地领先 origin",
    body: () => "push 你的本地 commit，或 reset 后再升级。",
  },
  detached_head: {
    severity: "bad",
    label: "HEAD 游离",
    body: () => "checkout 一个分支（通常 master）再试。",
  },
  daemon_running_not_service: {
    severity: "bad",
    label: "daemon 不是 service",
    body: () => "你正在前台跑 wechat-cc run？先 Ctrl+C 停掉再升级。",
  },
  fetch_failed: {
    severity: "bad",
    label: "git fetch 失败",
    body: (details) => details?.stderr || "网络问题或 git 不可用。",
  },
  pull_conflict: {
    severity: "bad",
    label: "git pull 冲突",
    body: (details) => details?.stderr || "ff-only 失败；手动 git pull 看看。",
  },
  bun_missing: {
    severity: "bad",
    label: "找不到 bun",
    body: () => "lockfile 已变，但 PATH 上没有 bun；安装 Bun 后再试。",
  },
  install_failed: {
    severity: "bad",
    label: "bun install 失败",
    body: (details) => details?.stderr || "终端跑 bun install --frozen-lockfile 看具体错误。",
  },
  service_stop_failed: {
    severity: "bad",
    label: "无法停止 service",
    body: (details) => details?.stderr || "service.stop 抛错；先手动停服务。",
  },
}

// Frame a copy entry as a probe-mode line. Probe overlays a couple of
// reasons with copy that's tighter than the apply phrasing (网络/git 不可用
// rather than "检查失败 · git fetch 失败"); everything else falls through
// the generic header `检查失败 · <label>`.
function frameProbe(reason, fallbackMessage, details) {
  const row = UPDATE_REASON_COPY[reason]
  if (!row) return { tone: "bad", headline: "检查失败", body: fallbackMessage || reason || "未知错误" }
  if (row.severity === "hide") return { tone: "hide", headline: "", body: "" }
  if (reason === "fetch_failed") return { tone: "bad", headline: "检查失败", body: "网络问题或 git 不可用" }
  if (reason === "detached_head") return { tone: "bad", headline: "检查失败", body: "HEAD 游离，请 checkout 一个分支后重试" }
  return { tone: row.severity, headline: row.label ? `检查失败 · ${row.label}` : "检查失败", body: row.body(details) }
}

// Frame a copy entry as an apply-mode line. `severity:'warn'` reasons are
// soft-rejects (升级被拒); `severity:'bad'` are hard failures (升级失败).
function frameApply(reason, fallbackMessage, details) {
  const row = UPDATE_REASON_COPY[reason]
  if (!row) return { tone: "bad", headline: "升级失败", body: fallbackMessage || reason || "未知错误" }
  if (row.severity === "hide") return { tone: "hide", headline: "", body: "" }
  const verb = row.severity === "warn" ? "升级被拒" : "升级失败"
  return { tone: row.severity, headline: row.label ? `${verb} · ${row.label}` : verb, body: row.body(details) }
}

// Map an UpdateProbe (output of `wechat-cc update --check --json`) to a
// {tone, headline, body} card render. Probe failures route through
// `frameProbe`; happy-path probe.dirty / diverged / updateAvailable cases
// stay inline because they read probe.* fields directly (not result.reason).
export function updateProbeLine(probe) {
  if (!probe || typeof probe !== "object") {
    return { tone: "warn", headline: "未检查", body: "点检查更新" }
  }
  if (!probe.ok) return frameProbe(probe.reason, probe.message, probe.details)
  const sha = (probe.currentCommit || "").slice(0, 7) || "—"
  if (probe.dirty) {
    const n = (probe.dirtyFiles || []).length
    return { tone: "warn", headline: `本地有未提交修改 · ${sha}`, body: `${n} 个文件未提交，升级会被拒；先 commit/stash/discard 再试。` }
  }
  if ((probe.aheadOfRemote ?? 0) > 0) {
    return { tone: "warn", headline: `本地领先 origin ${probe.aheadOfRemote} commit · ${sha}`, body: "升级会被拒（diverged）；push 或 reset 后再试。" }
  }
  if (probe.updateAvailable) {
    const lock = probe.lockfileWillChange ? "（含依赖更新）" : ""
    return { tone: "info", headline: `有新版本 · ${probe.behind} commits${lock}`, body: `${sha} → ${(probe.latestCommit || "").slice(0, 7)}` }
  }
  return { tone: "ok", headline: `已是最新 · ${sha}`, body: "无需升级。" }
}

// Map an UpdateResult (apply mode) to a {tone, headline, body}. Success
// branches (ok=true) build their own copy from fromCommit/toCommit/
// daemonAction; rejection branches delegate to `frameApply`.
export function updateApplyLine(result) {
  if (!result || typeof result !== "object") {
    return { tone: "bad", headline: "升级失败", body: "未收到结果" }
  }
  if (result.ok) {
    const from = (result.fromCommit || "").slice(0, 7)
    const to = (result.toCommit || "").slice(0, 7)
    if (result.daemonAction === "restarted") {
      const lock = result.lockfileChanged ? "，依赖已重装" : ""
      return { tone: "ok", headline: `升级成功 · ${from} → ${to}`, body: `daemon 已重启${lock}。` }
    }
    if (result.daemonAction === "restart_failed") {
      return { tone: "warn", headline: `升级成功但 daemon 重启失败 · ${from} → ${to}`, body: "请到「设置向导 → 后台」手动重启服务。" }
    }
    return { tone: "ok", headline: `升级成功 · ${from} → ${to}`, body: "daemon 升级前未运行，未做重启。" }
  }
  return frameApply(result.reason, result.message, result.details)
}
