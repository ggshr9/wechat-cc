// Dashboard module. Owns the overview pane: daemon hero, bound-accounts
// table (incl. inline two-step delete confirm), footer pid indicator,
// and the smart restart-daemon button.
//
// Owns: #hero-card, #hero-headline, #hero-meta, #accounts-body,
//       #accounts-meta, #dash-pending, #dash-restart,
//       #dash-refresh, #dash-rail-clock (rail-foot wall clock)
// Subscribes to: doctorPoller (renderDashboard + renderRestartButton fire
// on every successful poll automatically).

import { dashboardHero, accountRows, formatRelativeTime, escapeHtml, restartButtonState, deleteAccountConfirmCopy, diagnose } from "../view.js"

export function renderDashboard(report) {
  const hero = dashboardHero(report.checks.daemon, report.checks.accounts.count)
  const card = document.getElementById("hero-card")
  if (!card) return
  card.classList.toggle("warn", hero.tone !== "ok")
  document.getElementById("hero-headline").textContent = hero.tone === "ok" ? "AI 正在陪伴中" : "暂时失去连接"
  document.getElementById("hero-meta").textContent = hero.tone === "ok"
    ? "一切正常，连接稳定"
    : "当前连接不稳定，正在尝试重新恢复陪伴"
  const stopBtn = document.getElementById("dash-stop")
  const restartBtn = document.getElementById("dash-restart")
  if (stopBtn) stopBtn.hidden = hero.tone !== "ok"
  if (restartBtn) restartBtn.hidden = hero.tone === "ok"

  const accounts = report.checks.accounts.items || []
  const expired = report.expiredBots || []
  const expiredById = Object.fromEntries(expired.map(b => [b.botId, b]))
  const rows = accountRows(accounts, report.userNames || {}, expired)
  const tbody = document.getElementById("accounts-body")
  const current = document.getElementById("accounts-current")

  // Skip re-render if user has an inline confirm open (poll race — the 5s
  // tick would clobber the half-filled "确定删除?" UI otherwise).
  const hasOpenConfirm = tbody.querySelector(".confirm-inline")
  if (!hasOpenConfirm && current) {
    const currentRow = rows[0]
    if (!currentRow) {
      current.innerHTML = `
        <div class="user-avatar avatar-admin">?</div>
        <div class="user-copy">
          <div class="user-name">还没有连接用户</div>
          <div class="user-sub">打开设置添加微信账号</div>
        </div>
        <span class="provider-chip">${escapeHtml(report.checks.provider.provider || "codex")}</span>
      `
      tbody.innerHTML = ""
    } else {
      // Daemon doesn't expose last-active timestamps (see view.js notes —
      // ilink gives us errcode=-14 expiry but no positive heartbeat).
      // Show honest copy: "已连接" for active, "连接已过期" for expired.
      const currentExp = expiredById[currentRow.id]
      const currentSub = currentRow.expired
        ? `连接已过期${currentExp ? ` · ${formatRelativeTime(currentExp.firstSeenExpiredAt)}` : ""}`
        : "已连接"
      current.innerHTML = `
        <div class="user-avatar avatar-admin">${avatarSvg("admin")}</div>
        <div class="user-copy">
          <div class="user-name">${escapeHtml(currentRow.name)} <span class="role-pill">管理员</span></div>
          <div class="user-sub">微信私聊，${currentSub}</div>
        </div>
        <button class="provider-switch" aria-haspopup="true" aria-label="切换 provider">
          <span class="provider-chip">${escapeHtml(report.checks.provider.provider || "codex")}</span>
          <span class="provider-chevron">⌄</span>
        </button>
      `
    }
  }

  if (hasOpenConfirm) {
    /* skip */
  } else {
    const subRows = rows.slice(1)
    const displayRows = subRows.length > 0 ? subRows : demoSubUsers()
    tbody.innerHTML = displayRows.map((row, index) => {
      const expEntry = expiredById[row.id]
      // Active: honest "已连接" — daemon has no last-active heartbeat for
      // real accounts. Demo rows (moxiuwen's placeholder set) get a more
      // populated-looking "活跃中" so the empty-state mockup still reads
      // alive without misrepresenting expired-vs-active for real users.
      const expCell = expEntry
        ? `已过期 · ${formatRelativeTime(expEntry.firstSeenExpiredAt)}`
        : row.demo ? "活跃中" : "已连接"
      // Expired rows get a primary 重新扫码 affordance next to the (now
      // ghost) delete button — clicking 重新扫码 routes back into the
      // wizard's bind/QR step so the user can pair the same WeChat
      // account again. Non-expired rows keep the original danger-style
      // delete-only layout.
      const actCell = row.expired
        ? `<button class="mini-action" data-action="rebind">重新扫码</button>
           <button class="mini-action" data-action="ask-delete">删除</button>`
        : row.demo ? "" : `<button class="mini-action" data-action="ask-delete">删除</button>`
      return `
        <div class="sub-user-card" data-bot-id="${escapeHtml(row.id)}" data-name="${escapeHtml(row.name)}">
          <button class="card-menu" aria-label="更多操作">•••</button>
          <div class="user-avatar">${avatarSvg(row.avatar || index)}</div>
          <div class="user-copy">
            <div class="user-name">${escapeHtml(row.name)}</div>
            <div class="user-sub">${escapeHtml(expCell)}</div>
          </div>
          <div class="act">${actCell}</div>
        </div>
      `
    }).join("")
  }
  const expiredCount = expired.length
  const meta = expiredCount > 0
    ? `${accounts.length} 个 · ${expiredCount} 已过期`
    : `${accounts.length} 个 · ${report.checks.access.allowFromCount} 用户允许`
  document.getElementById("accounts-meta").textContent = meta

}

function avatarSvg(seed) {
  const kind = String(seed)
  if (kind === "admin") {
    return `<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="20" r="10" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M9 42c2.8-9 7.8-13.5 15-13.5S36.2 33 39 42" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="20" cy="20" r="1.8" fill="currentColor"/><circle cx="28" cy="20" r="1.8" fill="currentColor"/><path d="M19 26c3 2 7 2 10 0" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`
  }
  const avatars = [
    `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 39V22M13 17c7 0 11 5 11 12C17 29 13 24 13 17Zm22 0c-7 0-11 5-11 12 7 0 11-5 11-12Z" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`,
    `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 8l4.8 10 11 1.6-8 7.8 1.9 11-9.7-5.1-9.7 5.1 1.9-11-8-7.8 11-1.6L24 8Z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="20" cy="25" r="1.6" fill="currentColor"/><circle cx="28" cy="25" r="1.6" fill="currentColor"/></svg>`,
    `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M13 22c0-7 5-12 11-12s11 5 11 12v8c0 4-4 8-11 8s-11-4-11-8v-8Z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16 15l-5-6M32 15l5-6" stroke="currentColor" stroke-width="1.8" fill="none"/><circle cx="20" cy="25" r="1.8" fill="currentColor"/><circle cx="28" cy="25" r="1.8" fill="currentColor"/></svg>`,
    `<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="14" y="14" width="20" height="22" rx="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M24 9v5M18 25h.1M30 25h.1M20 31h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M14 18h20l-2 20H16l-2-20Z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M17 14h14M19 28c4-4 8-4 12 0" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`,
    `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M12 31c2-8 8-11 14-8 2-5 9-4 10 2 5 1 7 9 1 13H15c-5 0-7-4-3-7Z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="22" cy="33" r="1.8" fill="currentColor"/><circle cx="30" cy="33" r="1.8" fill="currentColor"/></svg>`,
  ]
  const n = Number.isFinite(Number(seed)) ? Number(seed) : Math.abs(kind.split("").reduce((sum, ch) => sum + ch.charCodeAt(0), 0))
  return avatars[n % avatars.length]
}

function demoSubUsers() {
  return [
    { id: "demo-1", name: "麦子熟了", demo: true, avatar: 0 },
    { id: "demo-2", name: "小鱼", demo: true, avatar: 1 },
    { id: "demo-3", name: "程", demo: true, avatar: 2 },
    { id: "demo-4", name: "阿哲", demo: true, avatar: 3 },
    { id: "demo-5", name: "Summer", demo: true, avatar: 4 },
    { id: "demo-6", name: "设计师阿紫", demo: true, avatar: 5 },
  ]
}

// Mutate the dashboard's restart + stop buttons to reflect daemon+service
// state. Stored separately from renderDashboard so we can call it from
// places that don't re-render the whole hero (e.g. after account remove).
export function renderRestartButton(report) {
  const btn = document.getElementById("dash-restart")
  if (!btn) return
  const hero = dashboardHero(report.checks.daemon, report.checks.accounts?.count ?? 0)
  const showOnlineControls = hero.tone === "ok"
  const choice = restartButtonState(report.checks.daemon, report.checks.service)
  // Find the label text node (the one with non-whitespace content). The
  // button has whitespace text nodes between the icon span and the label,
  // so a naive `find(TEXT_NODE)` would replace the wrong node and leave
  // the original "重启 daemon" string sitting next to the new label.
  const labelNode = Array.from(btn.childNodes).find(
    n => n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 0,
  )
  const visibleLabel = "重新连接"
  if (labelNode) labelNode.textContent = ` ${visibleLabel}`
  else btn.appendChild(document.createTextNode(` ${visibleLabel}`))
  btn.dataset.action = choice.action
  if (choice.helper) btn.title = choice.helper
  else btn.removeAttribute("title")

  // Stop button: meaningful only when the daemon is actually running. When
  // offline, disable to make "nothing to stop" the obvious affordance
  // (instead of clicking and getting an error toast).
  const stopBtn = document.getElementById("dash-stop")
  if (stopBtn) {
    stopBtn.hidden = !showOnlineControls
    stopBtn.disabled = false
    if (showOnlineControls) stopBtn.removeAttribute("title")
    else stopBtn.title = "daemon 未运行"
  }
  btn.hidden = showOnlineControls
}

export function setPending(msg) {
  const el = document.getElementById("dash-pending")
  if (el) el.textContent = msg
}

export function updateClock() {
  const el = document.getElementById("dash-rail-clock")
  if (!el) return
  const now = new Date()
  el.textContent = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
}

// Stop the daemon via `service stop` + residual-kill. Mirrors restartDaemon's
// pending UX but only fires the stop steps. After this returns, restart-button
// state re-renders to show "启动" (since daemon is now offline).
export async function stopDaemon(deps) {
  setPending("停止…")
  let stopError = null
  try {
    await deps.invoke("wechat_cli_json", { args: ["service", "stop", "--json"] })
  } catch (err) {
    stopError = err
  }
  // Same residual-kill rationale as restartDaemon: launchctl/systemd doesn't
  // touch manual `wechat-cc run` instances, so without this step "停止" can
  // leave a daemon polling silently in the background.
  let killError = null
  try {
    await deps.invoke("wechat_cli_json", { args: ["daemon", "kill-residual", "--json"] })
  } catch (err) {
    killError = err
  }
  const report = await deps.doctorPoller.refresh()
  if (report && !report.checks.daemon?.alive) {
    deps.markDisconnected?.()
  }
  if (report?.checks.daemon?.alive) {
    setPending("断开失败：daemon 仍在运行")
    return
  }
  if (stopError || killError) {
    setPending("已断开；后台服务停止时有警告")
    setTimeout(() => setPending(""), 3000)
    return
  }
  setPending("已停止")
  setTimeout(() => setPending(""), 2000)
}

// The actual stop+kill+start chain. Called either by the old restartDaemon
// fallback path (when diagnose returns code 0 / no card) or by the
// diagnose-card's primary button click when action.kind === 'run-restart-sequence'.
export async function runRestartSequence(deps) {
  // Capture pid BEFORE the stop step. May be null on non-Windows.
  let beforePid = null
  try { beforePid = await deps.invoke("wechat_daemon_pid") } catch { /* not registered */ }

  setPending("停止…")
  try {
    await deps.invoke("wechat_cli_json", { args: ["service", "stop", "--json"] })
  } catch { /* tolerate */ }
  // Force-kill any process still holding server.pid. `service stop` only
  // terminates launchctl/systemd-managed processes — a manual `wechat-cc
  // run` started in a terminal is invisible to them and will refuse the
  // next `service start` with "another daemon already running", causing
  // a silent restart loop. This step closes that gap cross-platform.
  setPending("清理残留…")
  try {
    await deps.invoke("wechat_cli_json", { args: ["daemon", "kill-residual", "--json"] })
  } catch { /* best effort — start step will surface real failures */ }
  setPending("启动…")
  try {
    await deps.invoke("wechat_cli_json", { args: ["service", "start", "--json"] })
  } catch (err) {
    setPending("重新连接失败：后台服务启动失败")
    return
  }

  // Wait for the daemon to register instead of trusting `service start`.
  // launchctl/schtasks/systemctl can report command success even when the
  // child exits immediately during bootstrap.
  const refreshed = typeof deps.doctorPoller.waitForCondition === "function"
    ? await deps.doctorPoller.waitForCondition(r => !!r.checks.daemon?.alive, 8000, 500)
    : await deps.doctorPoller.refresh()
  if (!refreshed?.checks?.daemon?.alive) {
    setPending("重新连接失败：后台服务没起来")
    return
  }

  // Verify pid changed when the platform can report it. Non-Windows returns
  // null from wechat_daemon_pid, so the alive doctor result above is the
  // source of truth there.
  let afterPid = null
  try { afterPid = await deps.invoke("wechat_daemon_pid") } catch { /* not registered */ }
  deps.markConnected?.()

  if (beforePid !== null && afterPid !== null && beforePid === afterPid) {
    // pid didn't change — Stop-Process likely got Access Denied.
    // Record for the next diagnose() call so code 8 can fire on win32.
    _lastRestart = { pidUnchanged: true }
    setPending("未能重启 daemon — pid 没换。可能是权限问题（dashboard 不是管理员启动）。试试：彻底关闭 → 右键以管理员身份打开。")
    return
  }
  // Any other outcome: clear the signal so the next diagnose has a fresh read.
  _lastRestart = { pidUnchanged: false }
  if (beforePid !== null && afterPid === null) {
    setPending(`daemon 没起来 — 看 install-progress 或 logs 排查 (was pid ${beforePid})`)
    return
  }
  if (beforePid !== null && afterPid !== null) {
    setPending(`已重启 (pid ${beforePid} → ${afterPid})`)
    setTimeout(() => setPending(""), 3000)
    return
  }

  // Non-Windows or daemon wasn't running before — existing path
  setPending("已重启")
  setTimeout(() => setPending(""), 2000)
}

// Module-level slot: the latest deps + diagnosis rendered into the card.
// Event listeners on the card delegate through here so we never need
// replaceWith (which requires a real DOM parent node and isn't available
// in the jsdom-free test harness).
let _cardDeps = null
let _cardDiagnosis = null
// Wire the delegating listener once per module load. Fresh _cardDeps/_cardDiagnosis
// on each renderDiagnoseCard() call means stale deps can never fire.
// Test-only reset: call __resetDiagnoseCardState() in beforeEach to prevent
// listener state from leaking across test cases.
let _cardListenersWired = false

// Carries the outcome of the most recent runRestartSequence call into the
// next restartDaemon (diagnose) invocation. Cleared after consumption so
// stale signals never linger across multiple clicks.
let _lastRestart = null

// Provider-switch dropdown state. Separated from the diagnose-card state
// so the two features don't interfere with each other.
let _providerMenuOpen = false
let _providerSwitchInflight = false

// One-shot outside-click + Escape handler installed when menu opens.
// Stored so it can be removed precisely without leaking DOM listeners.
let _providerMenuOutsideHandler = null
let _providerMenuKeyHandler = null

/**
 * Wire the card's click listeners once. Safe to call multiple times.
 * Uses event delegation via the card container — avoids needing
 * element.replaceWith() when re-rendering the card.
 */
function wireCardListeners() {
  if (_cardListenersWired) return
  const card = document.getElementById("reconnect-diagnose-card")
  if (!card) return
  _cardListenersWired = true

  card.addEventListener("click", (ev) => {
    if (!_cardDeps || !_cardDiagnosis) return
    const target = ev.target
    // Ignore clicks on the fix-section copy button (it handles its own stop)
    if (target && target.closest && target.closest("#rdc-fix")) return
    const primaryBtn = document.getElementById("rdc-primary")
    const secondaryLink = document.getElementById("rdc-secondary")
    if (primaryBtn && (target === primaryBtn || primaryBtn.contains?.(target))) {
      handleDiagnoseAction(_cardDeps, _cardDiagnosis.primary.action)
      return
    }
    if (secondaryLink && (target === secondaryLink || secondaryLink.contains?.(target))) {
      ev.preventDefault()
      handleDiagnoseAction(_cardDeps, _cardDiagnosis.secondary.action)
    }
  })
}

/**
 * Render (or hide) the reconnect-diagnose card based on a diagnosis result.
 * Pure DOM mutation — no state, no async. The caller is responsible for
 * calling diagnose() and passing the result here.
 *
 * Dispatch table for primary button click (action.kind):
 *   auto-dismiss        → hide card (should never reach card render; code 0 is handled earlier)
 *   run-restart-sequence → runRestartSequence(deps)
 *   route-to-wizard     → deps.routeToWizardService() | deps.routeToWizardBind()
 *   show-fix            → copy command to clipboard / open link
 *   route-to-settings   → deps.routeToAccessSettings() | deps.routeToProviderSettings()
 *   restart-dashboard   → informational only (hint already says Cmd-Q/Alt-F4)
 *   show-platform-hint  → informational only (hint already covers win32 instructions)
 *
 * @param {object} deps  The dashboard deps bag
 * @param {{ code: number, title: string, hint: string,
 *           primary: { label: string, action: object },
 *           secondary?: { label: string, action: object } }} diagnosis
 */
export function renderDiagnoseCard(deps, diagnosis) {
  const card = document.getElementById("reconnect-diagnose-card")
  if (!card) return

  const titleEl = document.getElementById("rdc-title")
  const hintEl = document.getElementById("rdc-hint")
  const fixEl = document.getElementById("rdc-fix")
  const primaryBtn = document.getElementById("rdc-primary")
  const secondaryLink = document.getElementById("rdc-secondary")
  if (!titleEl || !hintEl || !fixEl || !primaryBtn || !secondaryLink) return

  // Store latest deps + diagnosis so the delegating listener can dispatch
  _cardDeps = deps
  _cardDiagnosis = diagnosis
  wireCardListeners()

  // Populate title and hint
  titleEl.textContent = diagnosis.title
  hintEl.textContent = diagnosis.hint

  // Warn tone for codes that indicate active failures (1, 2, 3, 4, 5, 8)
  const warnCodes = new Set([1, 2, 3, 4, 5, 8])
  card.classList.toggle("warn", warnCodes.has(diagnosis.code))

  // code 4: show fix command / link inline
  if (diagnosis.primary.action.kind === "show-fix") {
    const action = diagnosis.primary.action
    fixEl.innerHTML = ""
    if (action.command) {
      const codeEl = document.createElement("code")
      codeEl.textContent = action.command
      const copyBtn = document.createElement("button")
      copyBtn.className = "rdc-btn-primary"
      copyBtn.style.cssText = "font-size:11px;height:24px;padding:0 8px;margin-top:2px;"
      copyBtn.textContent = "复制"
      copyBtn.addEventListener("click", (e) => {
        e.stopPropagation()
        navigator.clipboard?.writeText(action.command).catch(() => {})
      })
      fixEl.appendChild(codeEl)
      fixEl.appendChild(copyBtn)
    }
    if (action.link) {
      const linkEl = document.createElement("a")
      linkEl.href = action.link
      linkEl.target = "_blank"
      linkEl.rel = "noopener"
      linkEl.textContent = action.link
      fixEl.appendChild(linkEl)
    }
    fixEl.hidden = !(action.command || action.link)
  } else {
    fixEl.hidden = true
    fixEl.innerHTML = ""
  }

  // Primary button label (click handled by delegating listener above)
  primaryBtn.textContent = diagnosis.primary.label

  // Secondary link (optional)
  if (diagnosis.secondary) {
    secondaryLink.textContent = diagnosis.secondary.label
    secondaryLink.hidden = false
  } else {
    secondaryLink.hidden = true
  }

  card.hidden = false
}

/**
 * Hide the reconnect-diagnose card.
 */
export function hideDiagnoseCard() {
  const card = document.getElementById("reconnect-diagnose-card")
  if (card) card.hidden = true
}

/**
 * TEST-ONLY: Reset all module-level card/restart state.
 * Call in beforeEach so listener wiring and restart signals don't leak
 * across test cases. The double-underscore prefix marks it as test-only.
 */
export function __resetDiagnoseCardState() {
  _cardListenersWired = false
  _cardDeps = null
  _cardDiagnosis = null
  _lastRestart = null
  _providerMenuOpen = false
  _providerSwitchInflight = false
  _providerMenuOutsideHandler = null
  _providerMenuKeyHandler = null
}

/**
 * Execute the action from a diagnose card button click.
 * @param {object} deps
 * @param {{ kind: string, step?: string, section?: string, command?: string, link?: string, platform?: string }} action
 */
export function handleDiagnoseAction(deps, action) {
  const card = document.getElementById("reconnect-diagnose-card")
  switch (action.kind) {
    case "auto-dismiss":
      if (card) card.hidden = true
      return
    case "run-restart-sequence":
      if (card) card.hidden = true
      runRestartSequence(deps)
      return
    case "route-to-wizard":
      if (action.step === "service") deps.routeToWizardService?.()
      else if (action.step === "wechat") deps.routeToWizardBind?.()
      return
    case "show-fix":
      if (action.command) navigator.clipboard?.writeText(action.command).catch(() => {})
      else if (action.link) window.open(action.link, "_blank")
      return
    case "route-to-settings":
      if (action.section === "access") deps.routeToAccessSettings?.()
      else if (action.section === "provider") deps.routeToProviderSettings?.()
      return
    case "restart-dashboard":
      setPending("请用 Cmd-Q / Alt-F4 关闭后重新打开 Dashboard")
      setTimeout(() => setPending(""), 3000)
      hideDiagnoseCard()
      return
    case "show-platform-hint":
      setPending("请以管理员身份重启 Dashboard")
      setTimeout(() => setPending(""), 3000)
      hideDiagnoseCard()
      return
    case "open-logs":
      hideDiagnoseCard()
      deps.routeToLogsPane?.()
      return
  }
}

// Smart restart: refresh → call diagnose() → show card or (code 0) show
// a brief toast. The actual stop+kill+start chain lives in runRestartSequence
// and is only invoked when the card's primary action says so.
export async function restartDaemon(deps) {
  setPending("重新连接…")
  const report = await deps.doctorPoller.refresh() ?? deps.doctorPoller.current

  if (!report) {
    // No report at all — fall back to the direct restart sequence
    return runRestartSequence(deps)
  }

  const healthOk = deps.healthProbe ? await deps.healthProbe() : null
  const capturedLastRestart = _lastRestart
  _lastRestart = null  // consume: one observation per click, never lingers
  const diagnosis = diagnose({
    report,
    healthOk,
    lastError: deps.doctorPoller.lastError ?? null,
    lastRestart: capturedLastRestart,
    platform: typeof navigator !== "undefined" ? (navigator.platform || "linux") : "linux",
  })

  // Step 4 — RECONNECT_DIAGNOSE telemetry: fire-and-forget log write.
  // Must be placed AFTER diagnose() so we capture every click (code 0 + non-0).
  // The call is deliberately not awaited — a slow daemon or broken CLI must
  // NOT delay the reconnect UI response.
  const _fields = {
    code: diagnosis.code,
    daemon_alive: !!(report?.checks?.daemon?.alive),
    service_installed: !!(report?.checks?.service?.installed),
    provider: report?.checks?.provider?.provider ?? "unknown",
    lastError_present: deps.doctorPoller.lastError != null,
    health_ok: healthOk,
    platform: typeof navigator !== "undefined" ? (navigator.platform || "unknown") : "unknown",
  }
  Promise.resolve().then(() =>
    deps.invoke("wechat_cli_json", {
      args: [
        "log",
        "RECONNECT_DIAGNOSE",
        `code=${diagnosis.code} provider=${_fields.provider}`,
        "--fields",
        JSON.stringify(_fields),
        "--json",
      ],
    }).catch(() => {/* telemetry is best-effort; ignore failures */})
  )

  // Code 0: everything is fine — show a brief "all good" toast instead of card
  if (diagnosis.code === 0) {
    setPending("一切正常，无需操作")
    setTimeout(() => setPending(""), 1500)
    hideDiagnoseCard()
    return
  }

  // Non-0: render the card. Clear any transient pending text first.
  setPending("")
  renderDiagnoseCard(deps, diagnosis)
}

// Close the provider-switch dropdown and remove its one-shot listeners.
export function closeProviderMenu() {
  const menu = document.getElementById("provider-menu")
  if (menu) menu.hidden = true
  _providerMenuOpen = false
  if (_providerMenuOutsideHandler) {
    document.removeEventListener("click", _providerMenuOutsideHandler, true)
    _providerMenuOutsideHandler = null
  }
  if (_providerMenuKeyHandler) {
    document.removeEventListener("keydown", _providerMenuKeyHandler)
    _providerMenuKeyHandler = null
  }
}

// Toggle the provider-switch dropdown.
// deps: the standard deps bag ({ invoke, doctorPoller, ... })
// report: the current doctor report (used to read the active provider)
export async function toggleProviderMenu(deps, report) {
  if (_providerMenuOpen) {
    closeProviderMenu()
    return
  }

  const menu = document.getElementById("provider-menu")
  if (!menu) return

  // Find the anchor (.provider-switch button) to position the menu below it.
  const anchor = document.querySelector(".provider-switch")
  if (!anchor) return

  const currentProvider = report?.checks?.provider?.provider || "codex"
  const providers = ["claude", "codex", "cursor"]

  // Build menu buttons
  menu.innerHTML = providers.map(p => {
    const active = p === currentProvider
    return `<button class="${active ? "provider-menu-active" : ""}" data-provider="${escapeHtml(p)}">${escapeHtml(p)}</button>`
  }).join("")

  // Position: fixed, anchored below the .provider-switch button.
  // Using getBoundingClientRect so it works regardless of scroll position.
  const rect = anchor.getBoundingClientRect()
  menu.style.top = `${rect.bottom + 4}px`
  menu.style.left = `${rect.left}px`
  menu.hidden = false
  _providerMenuOpen = true

  // Wire button clicks inside the menu
  menu.querySelectorAll("button[data-provider]").forEach(btn => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation()
      if (_providerSwitchInflight) return
      const name = btn.dataset.provider
      if (!name) return
      if (name === currentProvider) {
        closeProviderMenu()
        return
      }
      // Disable further clicks while switching
      _providerSwitchInflight = true
      menu.querySelectorAll("button").forEach(b => { b.disabled = true })
      try {
        // provider set doesn't emit JSON — use wechat_cli_text (same as
        // the wizard's commitProvider path in main.js).
        await deps.invoke("wechat_cli_text", { args: ["provider", "set", name] })
      } catch {
        setPending(`切换 provider 失败`)
        setTimeout(() => setPending(""), 3000)
        _providerSwitchInflight = false
        closeProviderMenu()
        return
      }
      closeProviderMenu()
      await runRestartSequence(deps)
      setPending(`已切换到 ${name}`)
      setTimeout(() => setPending(""), 2500)
      _providerSwitchInflight = false
    })
  })

  // Outside-click: close menu when clicking anywhere outside it
  _providerMenuOutsideHandler = (ev) => {
    if (!menu.contains(ev.target) && !(anchor.contains && anchor.contains(ev.target))) {
      closeProviderMenu()
    }
  }
  document.addEventListener("click", _providerMenuOutsideHandler, true)

  // Escape key: close menu
  _providerMenuKeyHandler = (ev) => {
    if (ev.key === "Escape") closeProviderMenu()
  }
  document.addEventListener("keydown", _providerMenuKeyHandler)
}

// Account row inline two-step confirm handler. Wired by main.js to the
// #accounts-body click event. Returns true if it handled the click.
export async function handleAccountRowClick(deps, ev) {
  const btn = ev.target.closest("button[data-action]")
  if (!btn) return false
  const row = btn.closest("[data-bot-id]")
  if (!row) return false
  const action = btn.dataset.action
  if (action === "rebind") {
    // Route to wizard bind step. Preferred: deps.routeToWizardBind (lands
    // on the QR/扫码 panel directly). Fallback: routeToWizardService —
    // not perfect targeting but at least pulls the user out of the
    // dashboard into the setup flow rather than no-op'ing the click.
    if (typeof deps.routeToWizardBind === "function") {
      deps.routeToWizardBind()
    } else if (typeof deps.routeToWizardService === "function") {
      deps.routeToWizardService()
    }
    return true
  }
  if (action === "ask-delete") {
    const actCell = row.querySelector("td.act") || row.querySelector(".act")
    if (!actCell) return false
    actCell.innerHTML = `
      <span class="confirm-inline">
        删除 <em>${escapeHtml(row.dataset.name)}</em>?
        <button class="btn ghost" data-action="cancel-delete">取消</button>
        <button class="btn danger-strong" data-action="confirm-delete">确定删除</button>
      </span>
    `
    return true
  }
  if (action === "cancel-delete") {
    const actCell = row.querySelector("td.act")
    const target = actCell || row.querySelector(".act")
    target.innerHTML = `<button class="mini-action" data-action="ask-delete">删除</button>`
    return true
  }
  if (action === "confirm-delete") {
    const botId = row.dataset.botId
    const actCell = row.querySelector("td.act") || row.querySelector(".act")
    if (!actCell) return false
    actCell.innerHTML = `<span style="color: var(--ink-3); font-size: 11px;">删除中…</span>`
    row.classList.add("removing")
    setPending(`删除 ${row.dataset.name}…`)
    try {
      await deps.invoke("wechat_cli_json", { args: ["account", "remove", botId, "--json"] })
    } catch (err) {
      row.classList.remove("removing")
      actCell.innerHTML = `<button class="mini-action" data-action="ask-delete">删除</button>`
      setPending(`删除失败：${deps.formatInvokeError(err)}`)
      return true
    }
    setPending(deleteAccountConfirmCopy(row.dataset.name, deps.doctorPoller.current?.checks?.service))
    await deps.doctorPoller.refresh()
    return true
  }
  return false
}
