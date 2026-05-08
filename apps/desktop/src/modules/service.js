// @ts-check
/// <reference lib="dom" />
/** @typedef {import('../../../../src/cli/schema').InstallProgressOutputT} InstallProgress */
/** @typedef {import('../../../../src/cli/schema').ServiceStatusOutputT} ServiceStatus */
/** @typedef {import('../../../../src/cli/schema').ServiceInstallOutputT} ServiceInstall */
/** @typedef {import('../../../../src/cli/schema').ServiceStartOutputT} ServiceStart */
/** @typedef {import('../../../../src/cli/schema').ServiceStopOutputT} ServiceStop */
/** @typedef {import('../../../../src/cli/schema').ServiceUninstallOutputT} ServiceUninstall */
/** @typedef {import('../../../../src/cli/schema').DaemonKillOutputT} DaemonKill */
/** @typedef {import('../../../../src/cli/schema').DoctorOutputT} DoctorReport */

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

/** @typedef {{ invoke: (cmd: string, args: { args: string[] }) => Promise<unknown>, formatInvokeError: (err: unknown) => string, doctorPoller: { current: unknown, refresh: () => Promise<unknown>, waitForCondition: (pred: (r: DoctorReport) => boolean, timeoutMs: number, pollMs: number) => Promise<unknown> } }} ServiceDeps */

/**
 * @param {ServiceDeps} deps
 * @param {{ unattended: boolean, autoStart: boolean }} state
 * @param {'install' | 'start' | 'stop' | 'uninstall'} action
 */
export async function serviceAction(deps, state, action) {
  const planEl = document.getElementById("service-plan")
  const summaryEl = document.getElementById("service-summary")
  const alertEl = document.getElementById("post-stop-alert")
  const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById("service-install"))
  // The whole flow takes 5–10 s (foreground guard + cli invoke + 8 s
  // settle wait). Without disabling the button + showing real step
  // progress, users see "安装中…" forever and can't tell where it's
  // stuck. Phase labels read CLI's install-progress.json (true state)
  // for the install-command portion, falling back to client-known phase
  // names for foreground-check + daemon-settle (which are wizard-side).
  const originalLabel = btn ? btn.innerHTML : ''
  /** @type {(() => void) | null} */
  let progressStop = null
  /** @param {string} text */
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
    // Open the technical-details panel + start with a "preparing" header
    // so the user sees real-time activity instead of clicking the chevron
    // on an empty box. Each progress event below appends a line.
    if (planEl) {
      planEl.textContent = `[${nowStamp()}] 准备安装…\n`
      planEl.classList.add("show")
    }
    /** @param {string} line */
    const appendPlan = (line) => {
      if (!planEl) return
      planEl.textContent += line.endsWith('\n') ? line : line + '\n'
      planEl.scrollTop = planEl.scrollHeight
    }
    progressStop = startProgressPolling(deps, setBtnLabel, appendPlan)
  }
  try {
    return await serviceActionInner(deps, state, action, planEl, summaryEl, alertEl)
  } finally {
    if (progressStop) progressStop()
    restoreBtn()
  }
}

function nowStamp() {
  const d = new Date()
  /** @param {number} n */
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * Poll install-progress.json (written by CLI's installService.onProgress).
 * Updates the button label AND the technical-details log so the user can
 * follow along step-by-step in both places.
 * @param {{ invoke: (cmd: string, args: { args: string[] }) => Promise<unknown> }} deps
 * @param {(text: string) => void} setBtnLabel
 * @param {((line: string) => void) | null} appendPlan
 * @returns {() => void}
 */
function startProgressPolling(deps, setBtnLabel, appendPlan) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null
  /** @type {string | null} */
  let lastShown = null
  let cancelled = false
  const tick = async () => {
    if (cancelled) return
    try {
      const p = /** @type {InstallProgress | null} */ (await deps.invoke("wechat_cli_json", { args: ["install-progress", "--json"] }).catch(() => null))
      if (p && typeof p.step === 'number' && typeof p.total === 'number') {
        const ageMs = typeof p.ts === 'number' ? Date.now() - p.ts : 0
        if (ageMs >= 0 && ageMs < PROGRESS_STALE_MS) {
          const key = `${p.step}/${p.total}/${p.label}`
          if (key !== lastShown) {
            lastShown = key
            setBtnLabel(`安装中… (${p.step}/${p.total}) ${escapeHtml(p.label || '')}`)
            if (appendPlan) appendPlan(`[${nowStamp()}] (${p.step}/${p.total}) ${p.label || ''}`)
          }
        }
      }
    } catch { /* polling is best-effort */ }
    if (!cancelled) timer = setTimeout(tick, PROGRESS_POLL_MS)
  }
  tick()
  return () => { cancelled = true; if (timer) clearTimeout(timer) }
}

/** @param {unknown} s */
function escapeHtml(s) {
  /** @type {Record<string, string>} */
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return String(s).replace(/[&<>"']/g, (c) => map[c] ?? c)
}

/**
 * @param {ServiceDeps} deps
 * @param {{ unattended: boolean, autoStart: boolean }} state
 * @param {'install' | 'start' | 'stop' | 'uninstall'} action
 * @param {HTMLElement | null} planEl
 * @param {HTMLElement | null} summaryEl
 * @param {HTMLElement | null} alertEl
 */
async function serviceActionInner(deps, state, action, planEl, summaryEl, alertEl) {
  // summaryEl is always present in the wizard DOM; cast away null for clean TS.
  const summary = /** @type {HTMLElement} */ (summaryEl)
  if (alertEl) alertEl.hidden = true
  if (action === "install") {
    // Hard-severity gate: if the selected agent backend (Claude/Codex)
    // isn't installed, registering the systemd unit succeeds but every
    // inbound message dies in SDK spawn — the "fake success" trap. Refuse
    // here with a single inline line; user reads the doctor row above
    // (which already shows the npm install command + 复制 button).
    const hardReds = collectHardReds(/** @type {DoctorReport | null} */ (deps.doctorPoller.current))
    if (hardReds.length > 0) {
      summary.textContent = `先装 ${hardReds.join("、")} — daemon 起来后无法工作。复制上方命令即可。`
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
    const status = /** @type {ServiceStatus | null} */ (await deps.invoke("wechat_cli_json", { args: ["service", "status", "--json"] }).catch(() => null))
    if (status && status.alive && !status.installed && status.pid) {
      summary.textContent = "检测到前台 daemon 仍在运行，需要先停掉再安装服务。"
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
  /** @type {ServiceInstall | ServiceStart | ServiceStop | ServiceUninstall} */
  let result
  try {
    result = /** @type {ServiceInstall | ServiceStart | ServiceStop | ServiceUninstall} */ (await deps.invoke("wechat_cli_json", { args }))
  } catch (err) {
    const friendly = deps.formatInvokeError(err)
    summary.textContent = friendly
    if (planEl) {
      const errObj = /** @type {Error | null} */ (err instanceof Error ? err : null)
      planEl.textContent += `\n[${nowStamp()}] ❌ service ${action} 失败：\n${friendly}\n\n— 原始错误 —\n${errObj?.stack || String(err)}\n`
      planEl.classList.add("show")
      planEl.scrollTop = planEl.scrollHeight
    }
    return
  }
  if (planEl) {
    if (action === "install") {
      planEl.textContent += `\n[${nowStamp()}] ✓ CLI 返回结果：\n${JSON.stringify(result, null, 2)}\n`
      planEl.scrollTop = planEl.scrollHeight
    } else {
      // For non-install actions (start/stop/uninstall), no progressive log;
      // just dump the result as before.
      planEl.textContent = JSON.stringify(result, null, 2)
    }
  }
  // Narrow dryRun: only present on the ok:true branch of each service action schema.
  const dryRun = result.ok ? result.dryRun : false
  if (dryRun) {
    summary.textContent = action === "stop"
      ? "演示模式：实际未停止 daemon（DRY_RUN）。"
      : "演示模式：实际未执行（DRY_RUN）。"
  } else if (result.ok) {
    summary.textContent = action === "stop" ? "服务已停止。" : "服务已启动。"
  }
  // After install/start, the daemon takes 1-3s to spawn, write server.pid,
  // and finish bootstrap. doctorPoller.waitForCondition refreshes every
  // 500ms (with subscriber notifications) until daemon.alive=true or 8s.
  if (!dryRun && (action === "install" || action === "start")) {
    if (planEl && action === "install") {
      planEl.textContent += `[${nowStamp()}] ⏳ 等待 daemon 就绪…（最多 ${DAEMON_SETTLE_TIMEOUT_MS / 1000}s）\n`
      planEl.scrollTop = planEl.scrollHeight
    }
    await deps.doctorPoller.waitForCondition(
      r => !!r.checks.daemon.alive,
      DAEMON_SETTLE_TIMEOUT_MS,
      DAEMON_SETTLE_POLL_MS,
    )
  }
  const post = /** @type {DoctorReport | null} */ (await deps.doctorPoller.refresh())
  if (action === "stop" && !dryRun && post?.checks.daemon.alive && post.checks.daemon.pid) {
    showPostStopAlert(post.checks.daemon.pid)
  }
  if (!dryRun && (action === "install" || action === "start")) {
    if (post?.checks.daemon.alive) {
      summary.textContent = `服务已启动 · pid ${post.checks.daemon.pid}`
      if (planEl && action === "install") {
        planEl.textContent += `[${nowStamp()}] ✓ daemon alive (pid ${post.checks.daemon.pid})\n`
        planEl.scrollTop = planEl.scrollHeight
      }
    } else if (post?.checks.service?.installed) {
      summary.textContent = "服务已安装但 daemon 未运行（systemctl 可能正在重试，30s 后再看）。"
      if (planEl && action === "install") {
        planEl.textContent += `[${nowStamp()}] ⚠ 服务已注册但 daemon 未起来 — 可能 systemctl/launchd/schtasks 在重试，30s 后查 service status\n`
        planEl.scrollTop = planEl.scrollHeight
      }
    }
  }
}

/** @param {string} id */
function isToggleOn(id) {
  const el = document.getElementById(id)
  return !!el && el.classList.contains("on")
}

// Walk the doctor checks; return human-friendly names of any failed
// check whose severity is "hard" (would make the install useless).
// Soft reds (no bound account, allowlist empty) DON'T block — those
// can be fixed any time after install.
/** @param {DoctorReport | null | undefined} report */
function collectHardReds(report) {
  if (!report?.checks) return []
  const out = []
  const c = report.checks
  if (c.provider && !c.provider.ok && c.provider.severity === "hard") {
    out.push(c.provider.provider === "codex" ? "Codex" : "Claude Code")
  }
  return out
}

/**
 * @param {number} pid
 */
export function showPostStopAlert(pid) {
  const alertEl = document.getElementById("post-stop-alert")
  const pidEl = document.getElementById("post-stop-pid")
  if (!alertEl || !pidEl) return
  pidEl.textContent = String(pid)
  alertEl.hidden = false
}

/**
 * @param {{ invoke: (cmd: string, args: { args: string[] }) => Promise<unknown>, formatInvokeError: (err: unknown) => string, doctorPoller: { refresh: () => Promise<unknown> } }} deps
 */
export async function forceKillDaemon(deps) {
  const pidEl = document.getElementById("post-stop-pid")
  const alertEl = document.getElementById("post-stop-alert")
  // summaryEl is always present in the wizard DOM; cast away null for clean TS.
  const summaryEl = /** @type {HTMLElement} */ (document.getElementById("service-summary"))
  const pid = Number.parseInt(pidEl?.textContent || "", 10)
  if (!Number.isFinite(pid) || pid <= 0) return
  summaryEl.textContent = `正在 kill pid ${pid}…`
  /** @type {DaemonKill} */
  let result
  try {
    result = /** @type {DaemonKill} */ (await deps.invoke("wechat_cli_json", { args: ["daemon", "kill", String(pid), "--json"] }))
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
