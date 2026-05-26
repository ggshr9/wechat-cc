// Dashboard module. Owns the overview pane: daemon hero, bound-accounts
// table (incl. inline two-step delete confirm), footer pid indicator,
// and the smart restart-daemon button.
//
// Owns: #hero-card, #hero-headline, #hero-meta, #accounts-body,
//       #accounts-meta, #dash-pending, #dash-restart,
//       #dash-refresh, #dash-rail-clock (rail-foot wall clock)
// Subscribes to: doctorPoller (renderDashboard + renderRestartButton fire
// on every successful poll automatically).

import { dashboardHero, accountRows, formatRelativeTime, escapeHtml, restartButtonState, deleteAccountConfirmCopy } from "../view.js"

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
        <span class="provider-chip">${escapeHtml(report.checks.provider.provider || "codex")}</span>
        <span class="provider-chevron">⌄</span>
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
  const visibleLabel = report.checks.daemon?.alive ? "重新连接" : "重新连接"
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

// Smart restart: if no service is registered, route to the wizard service
// step instead of shelling out to systemctl/launchctl which would fail
// noisily. Refresh first to avoid acting on stale cache.
export async function restartDaemon(deps) {
  setPending("重新连接…")
  const cached = await deps.doctorPoller.refresh() ?? deps.doctorPoller.current
  if (cached) {
    const choice = restartButtonState(cached.checks.daemon, cached.checks.service)
    if (choice.action === "install") {
      deps.routeToWizardService()
      setPending("需要先安装后台服务")
      return
    }
  }

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
    // pid didn't change — Stop-Process likely got Access Denied
    setPending("未能重启 daemon — pid 没换。可能是权限问题（dashboard 不是管理员启动）。试试：彻底关闭 → 右键以管理员身份打开。")
    return
  }
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
