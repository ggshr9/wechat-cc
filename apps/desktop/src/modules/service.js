// Service install/stop module. Owns the wizard's background-service screen:
// invokes `service install/stop --json`, pre-checks for foreign daemons,
// renders the post-stop alert, drives the "force kill" path, and waits
// up to 8s for daemon.alive=true after install/start.
//
// Owns: #service-summary, #service-plan, #service-install, #service-stop,
//       #post-stop-alert, #post-stop-pid, #post-stop-kill,
//       #unattended-toggle, #autostart-toggle, #service-plan-toggle
// Reads service status via `deps.invoke` directly (one-shot) and uses
// `deps.doctorPoller.waitForCondition` for the post-action settle.

const DAEMON_SETTLE_TIMEOUT_MS = 8000
const DAEMON_SETTLE_POLL_MS = 500

export async function serviceAction(deps, state, action) {
  const planEl = document.getElementById("service-plan")
  const summaryEl = document.getElementById("service-summary")
  const alertEl = document.getElementById("post-stop-alert")
  if (alertEl) alertEl.hidden = true
  if (action === "install") {
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
