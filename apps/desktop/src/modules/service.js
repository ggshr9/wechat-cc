// Service install/stop module. Owns the wizard's background-service screen:
// invokes `service install/stop --json`, pre-checks for foreign daemons,
// renders the post-stop alert, drives the "force kill" path, and waits
// up to 8s for daemon.alive=true after install/start.
//
// Owns: #service-summary, #service-plan, #service-install,
//       #post-stop-alert, #post-stop-pid, #post-stop-kill,
//       #unattended-toggle, #autostart-toggle, #service-plan-toggle
// Wizard no longer has its own stop button — daily start/stop is the
// dashboard's job; wizard is for first-install and reconfiguration only.
// Crash-respawn (KeepAlive / Restart=always) is unconditional in v0.4+; the
// 守护进程 toggle was retired because no one wanted it off.
// Reads service status via `deps.invoke` directly (one-shot) and uses
// `deps.doctorPoller.waitForCondition` for the post-action settle.

const DAEMON_SETTLE_TIMEOUT_MS = 8000
const DAEMON_SETTLE_POLL_MS = 500
const PROGRESS_POLL_MS = 250
// Stale guard: if a previous install crashed before clearing the file, ignore
// progress events older than this. Real installs finish in <15s.
const PROGRESS_STALE_MS = 30_000

export async function serviceAction(deps, state, action) {
  const planEl = document.getElementById("service-plan")
  const summaryEl = document.getElementById("service-summary")
  const alertEl = document.getElementById("post-stop-alert")
  const btn = document.getElementById("service-install")
  // The whole flow takes 5–10 s (foreground guard + cli invoke + 8 s
  // settle wait). Without disabling the button + showing real step
  // progress, users see "安装中…" forever and can't tell where it's
  // stuck. Phase labels read CLI's install-progress.json (true state)
  // for the install-command portion, falling back to client-known phase
  // names for foreground-check + daemon-settle (which are wizard-side).
  const originalLabel = btn ? btn.innerHTML : ''
  let progressStop = null
  const setBtnLabel = (text) => { if (btn) btn.innerHTML = text }
  if (btn) {
    btn.disabled = true
    setBtnLabel(action === "stop" ? "停止中…" : "安装中…")
  }
  const restoreBtn = () => {
    if (!btn) return
    btn.disabled = false
    btn.innerHTML = originalLabel
  }
  if (action === "install") {
    progressStop = startProgressPolling(deps, setBtnLabel)
  }
  try {
    return await serviceActionInner(deps, state, action, planEl, summaryEl, alertEl, setBtnLabel)
  } finally {
    if (progressStop) progressStop()
    restoreBtn()
  }
}

/**
 * Poll install-progress.json (written by CLI's installService.onProgress) and
 * update the button label. Returns a stop fn that cancels the interval.
 *
 * Reads via shim.invoke('install_progress_read') — Tauri/shim side reads the
 * file under STATE_DIR. Returns null when file is missing or stale.
 */
function startProgressPolling(deps, setBtnLabel) {
  let timer = null
  let lastShown = null
  let cancelled = false
  const tick = async () => {
    if (cancelled) return
    try {
      const p = await deps.invoke("wechat_cli_json", { args: ["install-progress", "--json"] }).catch(() => null)
      if (p && typeof p.step === 'number' && typeof p.total === 'number') {
        const ageMs = typeof p.ts === 'number' ? Date.now() - p.ts : 0
        if (ageMs >= 0 && ageMs < PROGRESS_STALE_MS) {
          const key = `${p.step}/${p.total}/${p.label}`
          if (key !== lastShown) {
            lastShown = key
            setBtnLabel(`安装中… (${p.step}/${p.total}) ${escapeHtml(p.label || '')}`)
          }
        }
      }
    } catch { /* polling is best-effort */ }
    if (!cancelled) timer = setTimeout(tick, PROGRESS_POLL_MS)
  }
  tick()
  return () => { cancelled = true; if (timer) clearTimeout(timer) }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

async function serviceActionInner(deps, state, action, planEl, summaryEl, alertEl) {
  if (alertEl) alertEl.hidden = true
  if (action === "install") {
    // Hard-severity gate: if the selected agent backend (Claude/Codex)
    // isn't installed, registering the systemd unit succeeds but every
    // inbound message dies in SDK spawn — the "fake success" trap. Refuse
    // here with a single inline line; user reads the doctor row above
    // (which already shows the npm install command + 复制 button).
    const hardReds = collectHardReds(deps.doctorPoller.current)
    if (hardReds.length > 0) {
      summaryEl.textContent = `先装 ${hardReds.join("、")} — daemon 起来后无法工作。复制上方命令即可。`
      return
    }
    state.unattended = isToggleOn("unattended-toggle")
    state.autoStart = isToggleOn("autostart-toggle")
    // Pre-install guard: if a daemon is currently running OUTSIDE any
    // installed service (foreground source-mode bun, e.g. PID 691574 from
    // before the GUI was installed), wedge it. Otherwise systemd will
    // start a second daemon, the second one hits the server.pid lock,
    // exits, Restart=always loops, user is stuck. Surface the existing
    // post-stop-alert UI but with pre-install copy so the user can
    // force-kill before we touch any unit files.
    const status = await deps.invoke("wechat_cli_json", { args: ["service", "status", "--json"] }).catch(() => null)
    if (status && status.alive && !status.installed && status.pid) {
      summaryEl.textContent = "检测到前台 daemon 仍在运行，需要先停掉再安装服务。"
      showPostStopAlert(status.pid)
      const headEl = document.querySelector("#post-stop-alert .h")
      if (headEl) headEl.textContent = `先停掉前台 daemon (pid ${status.pid}) — 否则装上的 service 会立刻被 PID 锁挤掉`
      return
    }
  }
  const args = ["service", action, "--json"]
  if (action === "install") {
    args.push("--unattended", state.unattended ? "true" : "false")
    args.push("--auto-start", state.autoStart ? "true" : "false")
  }
  let result
  try {
    result = await deps.invoke("wechat_cli_json", { args })
  } catch (err) {
    const friendly = deps.formatInvokeError(err)
    summaryEl.textContent = friendly
    planEl.textContent = `service ${action} 失败：\n${friendly}\n\n— 原始错误 —\n${err?.stack || err}`
    planEl.classList.add("show")
    return
  }
  planEl.textContent = JSON.stringify(result, null, 2)
  if (result.dryRun) {
    summaryEl.textContent = action === "stop"
      ? "演示模式：实际未停止 daemon（DRY_RUN）。"
      : "演示模式：实际未执行（DRY_RUN）。"
  } else if (result.alive || result.ok) {
    summaryEl.textContent = action === "stop" ? "服务已停止。" : "服务已启动。"
  }
  // After install/start, the daemon takes 1-3s to spawn, write server.pid,
  // and finish bootstrap. doctorPoller.waitForCondition refreshes every
  // 500ms (with subscriber notifications) until daemon.alive=true or 8s.
  if (!result.dryRun && (action === "install" || action === "start")) {
    await deps.doctorPoller.waitForCondition(
      r => !!r?.checks?.daemon?.alive,
      DAEMON_SETTLE_TIMEOUT_MS,
      DAEMON_SETTLE_POLL_MS,
    )
  }
  const post = await deps.doctorPoller.refresh()
  if (action === "stop" && !result.dryRun && post?.checks.daemon.alive && post.checks.daemon.pid) {
    showPostStopAlert(post.checks.daemon.pid)
  }
  if (!result.dryRun && (action === "install" || action === "start")) {
    if (post?.checks.daemon.alive) {
      summaryEl.textContent = `服务已启动 · pid ${post.checks.daemon.pid}`
    } else if (post?.checks.service?.installed) {
      summaryEl.textContent = "服务已安装但 daemon 未运行（systemctl 可能正在重试，30s 后再看）。"
    }
  }
}

function isToggleOn(id) {
  const el = document.getElementById(id)
  return !!el && el.classList.contains("on")
}

// Walk the doctor checks; return human-friendly names of any failed
// check whose severity is "hard" (would make the install useless).
// Soft reds (no bound account, allowlist empty) DON'T block — those
// can be fixed any time after install.
function collectHardReds(report) {
  if (!report?.checks) return []
  const out = []
  const c = report.checks
  if (c.provider && !c.provider.ok && c.provider.severity === "hard") {
    out.push(c.provider.provider === "codex" ? "Codex" : "Claude Code")
  }
  return out
}

export function showPostStopAlert(pid) {
  const alertEl = document.getElementById("post-stop-alert")
  const pidEl = document.getElementById("post-stop-pid")
  if (!alertEl || !pidEl) return
  pidEl.textContent = String(pid)
  alertEl.hidden = false
}

export async function forceKillDaemon(deps) {
  const pidEl = document.getElementById("post-stop-pid")
  const alertEl = document.getElementById("post-stop-alert")
  const summaryEl = document.getElementById("service-summary")
  const pid = Number.parseInt(pidEl?.textContent || "", 10)
  if (!Number.isFinite(pid) || pid <= 0) return
  summaryEl.textContent = `正在 kill pid ${pid}…`
  let result
  try {
    result = await deps.invoke("wechat_cli_json", { args: ["daemon", "kill", String(pid), "--json"] })
  } catch (err) {
    summaryEl.textContent = `kill 失败：${deps.formatInvokeError(err)}`
    return
  }
  if (result.killed) {
    summaryEl.textContent = `已 kill pid ${pid}（${result.message}）。`
    if (alertEl) alertEl.hidden = true
  } else {
    summaryEl.textContent = `kill 失败：${result.message}`
  }
  await deps.doctorPoller.refresh()
}
