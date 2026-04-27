// Pure view-model functions. No DOM, no IPC, no globals — easy to unit-test
// from Bun (see view.test.ts) without spinning up a browser.

export function doctorRows(report) {
  return [
    ["Bun", report.checks.bun],
    ["Git", report.checks.git],
    ["Claude", report.checks.claude],
    ["Codex", report.checks.codex],
    ["微信账号", { ok: report.checks.accounts.ok, path: `${report.checks.accounts.count} 个账号` }],
    ["Allowlist", { ok: report.checks.access.ok, path: `${report.checks.access.allowFromCount} 个用户` }],
    ["Provider", { ok: report.checks.provider.ok, path: report.checks.provider.provider }],
    ["Daemon", { ok: report.checks.daemon.alive, path: report.checks.daemon.alive ? `pid ${report.checks.daemon.pid}` : "stopped" }],
  ]
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
    return {
      stopTimer: true,
      qrTitle: "绑定成功",
      qrMessage: `${result.accountId} 已保存。`,
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

// Format the daemon health line shown in the wizard sidebar status strip.
// Kept stable for view.test.ts — don't change shape or copy.
export function daemonStatusLine(daemon) {
  return {
    cls: daemon.alive ? "ok" : "warn",
    text: daemon.alive ? `运行中 pid=${daemon.pid}` : "未运行",
  }
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  }[ch]))
}

// ─── dashboard / mode-routing helpers ─────────────────────────────────

// Boot routing: dashboard once we have a bound account AND service installed
// (running or not — running is the happy path, stopped is the "I just rebooted
// and the daemon hasn't spawned yet" path that the dashboard handles cleanly
// with a Restart button). Wizard otherwise, parked at the first unfinished
// step so power users don't redo work.
export function initialMode(report) {
  const hasAccount = report.checks.accounts.count > 0
  if (hasAccount && report.checks.provider.ok) return { mode: "dashboard" }
  if (!report.checks.bun.ok || !report.checks.git.ok) return { mode: "wizard", step: "doctor" }
  if (!report.checks.provider.ok) return { mode: "wizard", step: "provider" }
  if (!hasAccount) return { mode: "wizard", step: "wechat" }
  return { mode: "wizard", step: "service" }
}

// Hero block for the dashboard top: "DAEMON · running" with a sub-line.
export function dashboardHero(daemon, accountCount) {
  if (daemon.alive) {
    return {
      headline: "running",
      tone: "ok",
      meta1: `pid ${daemon.pid}`,
      meta2: accountCount === 1 ? "1 account live" : `${accountCount} accounts live`,
    }
  }
  if (daemon.pid !== null) {
    return {
      headline: "stale",
      tone: "warn",
      meta1: `pid ${daemon.pid} · gone`,
      meta2: "service may need a restart",
    }
  }
  return {
    headline: "stopped",
    tone: "warn",
    meta1: "no daemon process",
    meta2: "press restart to bring it up",
  }
}

// Each row for the dashboard accounts table. Resolve a friendly display
// name through user_names.json (keyed by the wechat userId that owns the
// scan); fall back to the short bot id (directory name minus -im-bot).
// expiredBots — list of {botId, firstSeenExpiredAt} from session-state.json
// drives the badge. Account rows for which there is no expired entry are
// shown as `active` (we don't have a positive heartbeat from ilink — only
// the errcode=-14 negative signal).
export function accountRows(items, userNames = {}, expiredBots = [], now = Date.now()) {
  const expiredById = Object.create(null)
  for (const b of expiredBots) expiredById[b.botId] = b
  return items.map(item => {
    const friendly = userNames[item.userId]
    const shortId = (item.id || "").replace(/-im-bot$/, "")
    const expired = expiredById[item.id]
    const badge = expired
      ? { tone: "warn", label: `已过期 · ${formatRelativeTime(expired.firstSeenExpiredAt, now)}` }
      : { tone: "ok", label: "active" }
    return {
      name: friendly || shortId || item.id,
      id: item.id,
      badge,
      expired: !!expired,
    }
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

// Configuration table rows shown on the dashboard.
export function configRows(report, stateDir) {
  const provider = report.checks.provider
  const access = report.checks.access
  const providerLabel = provider.provider + (report.checks.provider.model ? ` (${report.checks.provider.model})` : "")
  return [
    ["Provider", providerLabel, "ok"],
    ["Provider binary", provider.binaryPath || "missing", provider.ok ? "ok" : "bad"],
    ["Allowlist", `${access.allowFromCount} 个用户 · ${access.dmPolicy}`, access.ok ? "ok" : "warn"],
    ["State directory", stateDir, "ok"],
  ]
}
