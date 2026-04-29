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
