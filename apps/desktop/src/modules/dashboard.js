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
  document.getElementById("hero-headline").textContent = `Daemon ${hero.headline}`
  const metaParts = [`<b>${escapeHtml(hero.meta1)}</b>`, `<b>${escapeHtml(hero.meta2)}</b>`]
  document.getElementById("hero-meta").innerHTML = metaParts.join('<span class="sep">·</span>')

  const accounts = report.checks.accounts.items || []
  const expired = report.expiredBots || []
  const expiredById = Object.fromEntries(expired.map(b => [b.botId, b]))
  const tbody = document.getElementById("accounts-body")

  // Skip re-render if user has an inline confirm open (poll race — the 5s
  // tick would clobber the half-filled "确定删除?" UI otherwise).
  const hasOpenConfirm = tbody.querySelector(".confirm-inline")
  if (hasOpenConfirm) {
    /* skip */
  } else if (accounts.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="padding: 28px 16px; text-align: center; color: var(--ink-3);">还没绑定微信账号。打开设置向导扫码。</td></tr>`
  } else {
    tbody.innerHTML = accountRows(accounts, report.userNames || {}, expired).map(row => {
      const expEntry = expiredById[row.id]
      const expCell = expEntry ? formatRelativeTime(expEntry.firstSeenExpiredAt) : "—"
      const badge = row.expired
        ? `<span class="badge expired"><span class="b-dot"></span>Expired</span>`
        : `<span class="badge"><span class="b-dot"></span>Active</span>`
      // Expired rows get a primary 重新扫码 affordance next to the (now
      // ghost) delete button — clicking 重新扫码 routes back into the
      // wizard's bind/QR step so the user can pair the same WeChat
      // account again. Non-expired rows keep the original danger-style
      // delete-only layout.
      const actCell = row.expired
        ? `<button class="btn primary" data-action="rebind">重新扫码</button>
           <button class="btn ghost" data-action="ask-delete">删除</button>`
        : `<button class="btn danger" data-action="ask-delete">删除</button>`
      return `
        <tr data-bot-id="${escapeHtml(row.id)}" data-name="${escapeHtml(row.name)}">
          <td class="name">${escapeHtml(row.name)}</td>
          <td class="id">${escapeHtml(row.id)}</td>
          <td>${badge}</td>
          <td class="exp">${escapeHtml(expCell)}</td>
          <td class="act">${actCell}</td>
        </tr>
      `
    }).join("")
  }
  const expiredCount = expired.length
  const meta = expiredCount > 0
    ? `${accounts.length} 个 · ${expiredCount} 已过期`
    : `${accounts.length} 个 · ${report.checks.access.allowFromCount} 用户允许`
  document.getElementById("accounts-meta").textContent = meta

}

// Mutate the dashboard's restart + stop buttons to reflect daemon+service
// state. Stored separately from renderDashboard so we can call it from
// places that don't re-render the whole hero (e.g. after account remove).
export function renderRestartButton(report) {
  const btn = document.getElementById("dash-restart")
  if (!btn) return
  const choice = restartButtonState(report.checks.daemon, report.checks.service)
  // Find the label text node (the one with non-whitespace content). The
  // button has whitespace text nodes between the icon span and the label,
  // so a naive `find(TEXT_NODE)` would replace the wrong node and leave
  // the original "重启 daemon" string sitting next to the new label.
  const labelNode = Array.from(btn.childNodes).find(
    n => n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 0,
  )
  if (labelNode) labelNode.textContent = ` ${choice.label}`
  else btn.appendChild(document.createTextNode(` ${choice.label}`))
  btn.dataset.action = choice.action
  if (choice.helper) btn.title = choice.helper
  else btn.removeAttribute("title")

  // Stop button: meaningful only when the daemon is actually running. When
  // offline, disable to make "nothing to stop" the obvious affordance
  // (instead of clicking and getting an error toast).
  const stopBtn = document.getElementById("dash-stop")
  if (stopBtn) {
    const alive = !!report.checks.daemon?.alive
    stopBtn.disabled = !alive
    if (alive) stopBtn.removeAttribute("title")
    else stopBtn.title = "daemon 未运行"
  }
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

// Stop the daemon via `service stop`. Mirrors restartDaemon's pending UX
// but only fires the stop step. After this returns, restart-button state
// re-renders to show "启动" (since daemon is now offline).
export async function stopDaemon(deps) {
  setPending("停止…")
  try {
    await deps.invoke("wechat_cli_json", { args: ["service", "stop", "--json"] })
  } catch (err) {
    setPending(`停止失败：${deps.formatInvokeError(err)}`)
    return
  }
  await deps.doctorPoller.refresh()
  setPending("已停止")
  setTimeout(() => setPending(""), 2000)
}

// Smart restart: if no service is registered, route to the wizard service
// step instead of shelling out to systemctl/launchctl which would fail
// noisily. Refresh first to avoid acting on stale cache.
export async function restartDaemon(deps) {
  const cached = await deps.doctorPoller.refresh() ?? deps.doctorPoller.current
  if (cached) {
    const choice = restartButtonState(cached.checks.daemon, cached.checks.service)
    if (choice.action === "install") {
      deps.routeToWizardService()
      setPending("")
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
  setPending("启动…")
  try {
    await deps.invoke("wechat_cli_json", { args: ["service", "start", "--json"] })
  } catch (err) {
    setPending(`启动失败：${deps.formatInvokeError(err)}`)
    return
  }

  // Wait 2s for the new daemon to register, then verify pid changed.
  // Skip pid verification entirely on non-Windows (where the command
  // returns null) — fall through to the existing OK message.
  await new Promise(r => setTimeout(r, 2000))
  let afterPid = null
  try { afterPid = await deps.invoke("wechat_daemon_pid") } catch { /* not registered */ }

  await deps.doctorPoller.refresh()

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
  const row = btn.closest("tr[data-bot-id]")
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
    const actCell = row.querySelector("td.act")
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
    actCell.innerHTML = `<button class="btn danger" data-action="ask-delete">删除</button>`
    return true
  }
  if (action === "confirm-delete") {
    const botId = row.dataset.botId
    const actCell = row.querySelector("td.act")
    actCell.innerHTML = `<span style="color: var(--ink-3); font-size: 11px;">删除中…</span>`
    row.classList.add("removing")
    setPending(`删除 ${row.dataset.name}…`)
    try {
      await deps.invoke("wechat_cli_json", { args: ["account", "remove", botId, "--json"] })
    } catch (err) {
      row.classList.remove("removing")
      actCell.innerHTML = `<button class="btn danger" data-action="ask-delete">删除</button>`
      setPending(`删除失败：${deps.formatInvokeError(err)}`)
      return true
    }
    setPending(deleteAccountConfirmCopy(row.dataset.name, deps.doctorPoller.current?.checks?.service))
    await deps.doctorPoller.refresh()
    return true
  }
  return false
}
