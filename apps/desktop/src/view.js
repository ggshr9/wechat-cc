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

// Format the daemon health line shown in the sidebar status strip.
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
