import { mockInvoke } from "./mock.js"
import {
  doctorRows, pollAdvance, daemonStatusLine, escapeHtml,
  initialMode, dashboardHero, accountRows, configRows, formatRelativeTime,
} from "./view.js"

const state = {
  doctor: null,
  setup: null,
  currentBaseUrl: null,
  selectedProvider: "claude",
  unattended: true,
  autoStart: false,
  qrTimer: null,
  qrErrors: 0,
  dashTimer: null,
  clockTimer: null,
  mode: "loading",
  currentStep: "doctor",
}

const stepOrder = ["doctor", "provider", "wechat", "service"]

const mock = !window.__TAURI__?.core?.invoke

async function invoke(command, args = {}) {
  if (!mock) return await window.__TAURI__.core.invoke(command, args)
  return mockInvoke(command, args, state)
}

function formatInvokeError(err) {
  const msg = String(err?.message ?? err ?? "未知错误")
  if (/Failed to fetch|NetworkError|ECONNREFUSED|fetch failed/.test(msg)) {
    return window.__WECHAT_CC_SHIM__
      ? "无法连接到 wechat-cc CLI（开发 shim 已停止）。"
      : "无法连接到 wechat-cc CLI。请检查 daemon 进程是否运行。"
  }
  return msg
}

// ─── mode router ──────────────────────────────────────────────────────

function setMode(mode) {
  state.mode = mode
  document.documentElement.dataset.mode = mode
  if (mode === "dashboard") {
    if (!state.dashTimer) state.dashTimer = setInterval(refreshDashboard, 5000)
    if (!state.clockTimer) state.clockTimer = setInterval(updateClock, 1000)
    refreshDashboard()
    updateClock()
  } else {
    if (state.dashTimer) { clearInterval(state.dashTimer); state.dashTimer = null }
    if (state.clockTimer) { clearInterval(state.clockTimer); state.clockTimer = null }
  }
}

// ─── wizard ──────────────────────────────────────────────────────────

function showStep(name) {
  state.currentStep = name
  document.querySelectorAll(".wizard .screen").forEach(el => el.classList.remove("active"))
  document.querySelector(`#screen-${name}`).classList.add("active")

  const idx = stepOrder.indexOf(name)
  document.querySelectorAll(".steps .step").forEach((el) => {
    const stepIdx = stepOrder.indexOf(el.dataset.step)
    el.classList.remove("is-done", "is-active")
    if (stepIdx < idx) el.classList.add("is-done")
    else if (stepIdx === idx) el.classList.add("is-active")
    const num = el.querySelector(".num")
    if (num) num.textContent = stepIdx < idx ? "✓" : String(stepIdx + 1)
  })
  document.getElementById("wizard-step-of").textContent = `step ${idx + 1} of ${stepOrder.length}`
}

function renderDoctorWizard(report) {
  const list = document.getElementById("checks")
  list.innerHTML = doctorRows(report).map(([name, check]) => `
    <div class="env-row${check.ok ? "" : " bad"}">
      <span class="ic">${
        check.ok
          ? '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3 3 7-7"/></svg>'
          : '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4l8 8M12 4l-8 8"/></svg>'
      }</span>
      <span class="nm">${escapeHtml(name)}</span>
      <span class="val">${escapeHtml(check.path || "missing")}</span>
    </div>
  `).join("")
  document.getElementById("claude-meta").textContent = report.checks.claude.ok ? report.checks.claude.path : "未检测到"
  document.getElementById("codex-meta").textContent = report.checks.codex.ok ? report.checks.codex.path : "未检测到"
  updateFooterStatus(report.checks.daemon)
}

function updateFooterStatus(daemon) {
  const line = daemonStatusLine(daemon)
  for (const id of ["wizard-foot-dot", "dash-rail-dot"]) {
    const el = document.getElementById(id)
    if (el) el.className = `dot ${line.cls}`
  }
  for (const id of ["wizard-foot-text", "dash-rail-text"]) {
    const el = document.getElementById(id)
    if (el) el.textContent = line.text
  }
}

function applyProviderUI(provider) {
  state.selectedProvider = provider
  document.querySelectorAll(".agent[data-provider]").forEach(btn =>
    btn.classList.toggle("selected", btn.dataset.provider === provider)
  )
}

async function commitProvider(provider) {
  applyProviderUI(provider)
  const args = ["provider", "set", provider, "--unattended", state.unattended ? "true" : "false"]
  await invoke("wechat_cli_text", { args })
  if (state.mode === "dashboard") refreshDashboard()
}

async function loadAgentConfig() {
  const config = await invoke("wechat_cli_json", { args: ["provider", "show", "--json"] })
  const provider = config.provider === "codex" ? "codex" : "claude"
  state.unattended = config.dangerouslySkipPermissions !== false
  state.autoStart = config.autoStart === true
  applyProviderUI(provider)
  setToggle("unattended-toggle", state.unattended)
  setToggle("autostart-toggle", state.autoStart)
}

function setToggle(id, on) {
  const el = document.getElementById(id)
  if (!el) return
  el.classList.toggle("on", !!on)
  el.setAttribute("aria-pressed", on ? "true" : "false")
}

async function loadDoctor() {
  const report = await invoke("wechat_cli_json", { args: ["doctor", "--json"] })
  state.doctor = report
  renderDoctorWizard(report)
  return report
}

async function renderQrInto(box, text) {
  if (mock) { box.textContent = text; return }
  try {
    const svg = await invoke("render_qr_svg", { text })
    box.innerHTML = svg
  } catch (err) {
    box.textContent = `${text}\n\n(渲染失败: ${err})`
  }
}

async function refreshQr() {
  clearInterval(state.qrTimer)
  sessionStorage.removeItem("qrPollCount")
  state.qrErrors = 0
  const qr = await invoke("wechat_cli_json", { args: ["setup", "--qr-json"] })
  state.setup = qr
  state.currentBaseUrl = null
  await renderQrInto(document.getElementById("qr-box"), qr.qrcode_img_content)
  document.getElementById("qr-title").textContent = "等待扫码"
  document.getElementById("qr-message").textContent = "用微信扫描二维码。"
  document.getElementById("qr-poll").hidden = false
  document.getElementById("qr-ttl").textContent = qr.expires_in_ms
    ? `${Math.floor(qr.expires_in_ms / 1000)}s ttl`
    : "scan now"
  document.getElementById("qr-raw").textContent = JSON.stringify(qr, null, 2)
  document.getElementById("continue-service").disabled = true
  state.qrTimer = setInterval(pollQr, 2000)
}

async function pollQr() {
  if (!state.setup) return
  const args = ["setup-poll", "--qrcode", state.setup.qrcode, "--json"]
  if (state.currentBaseUrl) args.splice(3, 0, "--base-url", state.currentBaseUrl)
  let result
  try {
    result = await invoke("wechat_cli_json", { args })
    state.qrErrors = 0
  } catch (err) {
    state.qrErrors = (state.qrErrors || 0) + 1
    document.getElementById("qr-raw").textContent = `轮询失败 (${state.qrErrors}/5):\n${err}`
    if (state.qrErrors >= 5) {
      clearInterval(state.qrTimer)
      document.getElementById("qr-title").textContent = "轮询暂停"
      document.getElementById("qr-message").textContent = "请点「生成二维码」重试。"
      document.getElementById("qr-poll").hidden = true
    }
    return
  }
  document.getElementById("qr-raw").textContent = JSON.stringify(result, null, 2)
  const advance = pollAdvance(state, result)
  if (advance.stopTimer) {
    clearInterval(state.qrTimer)
    document.getElementById("qr-poll").hidden = true
  }
  if (advance.currentBaseUrl !== undefined) state.currentBaseUrl = advance.currentBaseUrl
  if (advance.qrTitle !== undefined) document.getElementById("qr-title").textContent = advance.qrTitle
  if (advance.qrMessage !== undefined) document.getElementById("qr-message").textContent = advance.qrMessage
  if (advance.continueEnabled !== undefined) document.getElementById("continue-service").disabled = !advance.continueEnabled
}

async function serviceAction(action) {
  const planEl = document.getElementById("service-plan")
  const summaryEl = document.getElementById("service-summary")
  const alertEl = document.getElementById("post-stop-alert")
  if (alertEl) alertEl.hidden = true
  if (action === "install") {
    state.unattended = isToggleOn("unattended-toggle")
    state.autoStart = isToggleOn("autostart-toggle")
  }
  const args = ["service", action, "--json"]
  if (action === "install") {
    args.push("--unattended", state.unattended ? "true" : "false")
    args.push("--auto-start", state.autoStart ? "true" : "false")
  }
  let result
  try {
    result = await invoke("wechat_cli_json", { args })
  } catch (err) {
    const friendly = formatInvokeError(err)
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
  const post = await loadDoctor()
  if (action === "stop" && !result.dryRun && post?.checks.daemon.alive && post.checks.daemon.pid) {
    showPostStopAlert(post.checks.daemon.pid)
  }
}

function isToggleOn(id) {
  const el = document.getElementById(id)
  return !!el && el.classList.contains("on")
}

function showPostStopAlert(pid) {
  const alertEl = document.getElementById("post-stop-alert")
  const pidEl = document.getElementById("post-stop-pid")
  if (!alertEl || !pidEl) return
  pidEl.textContent = String(pid)
  alertEl.hidden = false
}

async function forceKillDaemon() {
  const pidEl = document.getElementById("post-stop-pid")
  const alertEl = document.getElementById("post-stop-alert")
  const summaryEl = document.getElementById("service-summary")
  const pid = Number.parseInt(pidEl?.textContent || "", 10)
  if (!Number.isFinite(pid) || pid <= 0) return
  summaryEl.textContent = `正在 kill pid ${pid}…`
  let result
  try {
    result = await invoke("wechat_cli_json", { args: ["daemon", "kill", String(pid), "--json"] })
  } catch (err) {
    summaryEl.textContent = `kill 失败：${formatInvokeError(err)}`
    return
  }
  if (result.killed) {
    summaryEl.textContent = `已 kill pid ${pid}（${result.message}）。`
    if (alertEl) alertEl.hidden = true
  } else {
    summaryEl.textContent = `kill 失败：${result.message}`
  }
  await loadDoctor()
}

// ─── dashboard ───────────────────────────────────────────────────────

async function refreshDashboard(opts = {}) {
  const report = await loadDoctor().catch(err => {
    setPending(`刷新失败：${formatInvokeError(err)}`)
    return null
  })
  if (!report) return
  setPending(opts.message || "")
  renderDashboard(report)
}

function renderDashboard(report) {
  const hero = dashboardHero(report.checks.daemon, report.checks.accounts.count)
  const card = document.getElementById("hero-card")
  card.classList.toggle("warn", hero.tone !== "ok")
  document.getElementById("hero-headline").textContent = `Daemon ${hero.headline}`
  // Compose meta line: "pid X · N accounts live · …" using monospaced separators.
  const metaParts = [`<b>${escapeHtml(hero.meta1)}</b>`, `<b>${escapeHtml(hero.meta2)}</b>`]
  document.getElementById("hero-meta").innerHTML = metaParts.join('<span class="sep">·</span>')

  // Live indicator at the foot
  const live = document.getElementById("dash-live")
  const liveText = document.getElementById("dash-live-text")
  if (hero.tone === "ok") {
    live.dataset.tone = "ok"
    liveText.textContent = "Live · daemon"
  } else {
    live.dataset.tone = "warn"
    liveText.textContent = "Daemon offline"
  }
  document.getElementById("dash-state-dir").textContent = report.stateDir || ""

  const accounts = report.checks.accounts.items || []
  const expired = report.expiredBots || []
  const expiredById = Object.fromEntries(expired.map(b => [b.botId, b]))
  const tbody = document.getElementById("accounts-body")

  // Skip re-render if user has an inline confirm open (poll race).
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
      return `
        <tr data-bot-id="${escapeHtml(row.id)}" data-name="${escapeHtml(row.name)}">
          <td class="name">${escapeHtml(row.name)}</td>
          <td class="id">${escapeHtml(row.id)}</td>
          <td>${badge}</td>
          <td class="exp">${escapeHtml(expCell)}</td>
          <td class="act">
            <button class="btn danger" data-action="ask-delete">删除</button>
          </td>
        </tr>
      `
    }).join("")
  }
  const expiredCount = expired.length
  const meta = expiredCount > 0
    ? `${accounts.length} 个 · ${expiredCount} 已过期`
    : `${accounts.length} 个 · ${report.checks.access.allowFromCount} 用户允许`
  document.getElementById("accounts-meta").textContent = meta

  // config table
  const cfg = document.getElementById("config-table")
  cfg.innerHTML = configRows(report, report.stateDir).map(([k, v]) => `
    <tr><td class="k">${escapeHtml(k)}</td><td class="v">${escapeHtml(v)}</td></tr>
  `).join("")
}

function setPending(msg) {
  const el = document.getElementById("dash-pending")
  if (el) el.textContent = msg
}

function updateClock() {
  const el = document.getElementById("dash-clock")
  if (!el) return
  const now = new Date()
  el.textContent = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
}

async function restartDaemon() {
  setPending("停止…")
  try {
    await invoke("wechat_cli_json", { args: ["service", "stop", "--json"] })
  } catch { /* tolerate */ }
  setPending("启动…")
  try {
    await invoke("wechat_cli_json", { args: ["service", "start", "--json"] })
  } catch (err) {
    setPending(`启动失败：${formatInvokeError(err)}`)
    return
  }
  await refreshDashboard({ message: "已重启" })
  setTimeout(() => setPending(""), 2000)
}

// ─── wiring ──────────────────────────────────────────────────────────

document.querySelectorAll(".steps .step").forEach(btn =>
  btn.addEventListener("click", () => showStep(btn.dataset.step))
)
document.getElementById("continue-provider").addEventListener("click", () => showStep("provider"))
document.getElementById("continue-wechat").addEventListener("click", () => showStep("wechat"))
document.getElementById("continue-service").addEventListener("click", () => showStep("service"))
document.getElementById("qr-refresh").addEventListener("click", refreshQr)
document.getElementById("service-install").addEventListener("click", () => serviceAction("install"))
document.getElementById("service-stop").addEventListener("click", () => serviceAction("stop"))
document.getElementById("post-stop-kill")?.addEventListener("click", forceKillDaemon)
document.getElementById("enter-dashboard").addEventListener("click", () => setMode("dashboard"))
document.getElementById("copy-diagnostics").addEventListener("click", async () => {
  await navigator.clipboard?.writeText(JSON.stringify(state.doctor, null, 2))
})

// agent picker (clean light: .agent buttons)
document.querySelectorAll(".agent[data-provider]").forEach(btn =>
  btn.addEventListener("click", () => commitProvider(btn.dataset.provider))
)

// toggles — click to flip class + persist intent
document.querySelectorAll("[data-toggle]").forEach(t => {
  t.addEventListener("click", () => {
    t.classList.toggle("on")
    const on = t.classList.contains("on")
    t.setAttribute("aria-pressed", on ? "true" : "false")
    if (t.id === "unattended-toggle") state.unattended = on
    if (t.id === "autostart-toggle") state.autoStart = on
  })
})

document.getElementById("qr-raw-toggle").addEventListener("click", () => {
  document.getElementById("qr-raw").classList.toggle("show")
})
document.getElementById("service-plan-toggle").addEventListener("click", () => {
  document.getElementById("service-plan").classList.toggle("show")
})

document.getElementById("dash-refresh").addEventListener("click", () => refreshDashboard({ message: "已刷新" }))
document.getElementById("dash-restart").addEventListener("click", restartDaemon)
document.getElementById("memory-refresh")?.addEventListener("click", () => loadMemoryPane())

// Account row inline two-step confirm (table version)
document.getElementById("accounts-body").addEventListener("click", async (ev) => {
  const btn = ev.target.closest("button[data-action]")
  if (!btn) return
  const row = btn.closest("tr[data-bot-id]")
  if (!row) return
  const action = btn.dataset.action
  if (action === "ask-delete") {
    const actCell = row.querySelector("td.act")
    actCell.innerHTML = `
      <span class="confirm-inline">
        删除 <em>${escapeHtml(row.dataset.name)}</em>?
        <button class="btn ghost" data-action="cancel-delete">取消</button>
        <button class="btn danger-strong" data-action="confirm-delete">确定删除</button>
      </span>
    `
    return
  }
  if (action === "cancel-delete") {
    const actCell = row.querySelector("td.act")
    actCell.innerHTML = `<button class="btn danger" data-action="ask-delete">删除</button>`
    return
  }
  if (action === "confirm-delete") {
    const botId = row.dataset.botId
    const actCell = row.querySelector("td.act")
    actCell.innerHTML = `<span style="color: var(--ink-3); font-size: 11px;">删除中…</span>`
    row.classList.add("removing")
    setPending(`删除 ${row.dataset.name}…`)
    try {
      await invoke("wechat_cli_json", { args: ["account", "remove", botId, "--json"] })
    } catch (err) {
      row.classList.remove("removing")
      actCell.innerHTML = `<button class="btn danger" data-action="ask-delete">删除</button>`
      setPending(`删除失败：${formatInvokeError(err)}`)
      return
    }
    setPending(`已删除 ${row.dataset.name} · 重启 daemon 生效`)
    await refreshDashboard()
  }
})

document.querySelectorAll(".mode-link[data-action='open-wizard']").forEach(btn =>
  btn.addEventListener("click", () => setMode("wizard"))
)

// ─── dashboard pane switching ─────────────────────────────────────────

document.querySelectorAll(".dash-nav-link[data-pane]").forEach(btn => {
  btn.addEventListener("click", () => {
    if (btn.classList.contains("disabled")) return
    switchPane(btn.dataset.pane)
  })
})

function switchPane(name) {
  document.querySelectorAll(".dash-nav-link[data-pane]").forEach(el =>
    el.classList.toggle("active", el.dataset.pane === name && !el.classList.contains("disabled"))
  )
  document.querySelectorAll(".dash-pane[data-pane]").forEach(el => {
    el.hidden = el.dataset.pane !== name
  })
  if (name === "memory") loadMemoryPane().catch(err => {
    console.error("memory load failed", err)
    document.getElementById("memory-rendered").innerHTML =
      `<p class="empty-state">加载失败：${escapeHtml(formatInvokeError(err))}</p>`
  })
}

// ─── Memory pane ──────────────────────────────────────────────────────

const memoryState = { users: [], selected: null, marked: null }

async function loadMarked() {
  if (memoryState.marked) return memoryState.marked
  // marked is vendored locally at ./vendor/marked.js (no CDN dependency
  // at runtime, so the memory pane works offline + in a packaged app).
  try {
    const mod = await import("./vendor/marked.js")
    memoryState.marked = mod.marked || mod.default || mod
    return memoryState.marked
  } catch (err) {
    console.warn("local marked load failed, falling back to <pre>", err)
    memoryState.marked = { parse: (s) => `<pre>${escapeHtml(s)}</pre>` }
    return memoryState.marked
  }
}

async function loadMemoryPane() {
  const result = await invoke("wechat_cli_json", { args: ["memory", "list", "--json"] })
  memoryState.users = Array.isArray(result) ? result : []
  renderMemorySidebar()
  const totalFiles = memoryState.users.reduce((s, u) => s + u.fileCount, 0)
  document.getElementById("memory-meta").textContent = `${memoryState.users.length} 个用户 · ${totalFiles} 文件`
  const navCount = document.getElementById("memory-count")
  if (navCount) navCount.textContent = totalFiles > 0 ? String(totalFiles) : ""
}

function renderMemorySidebar() {
  const sidebar = document.getElementById("memory-sidebar")
  const userNames = state.doctor?.userNames || {}
  if (memoryState.users.length === 0) {
    sidebar.innerHTML = `<div class="empty" style="margin: 0; padding: 18px; font-size: 12px;"><div class="h">空</div><div class="sub">memory/ 还没文件——Claude 还没写过笔记。</div></div>`
    return
  }
  sidebar.innerHTML = memoryState.users.map(u => {
    const friendly = userNames[u.userId] || u.userId.split("@")[0]
    return `
      <div class="mem-grp">
        <div class="grp">
          <span>${escapeHtml(friendly)}</span>
          <span class="count">${u.fileCount}</span>
        </div>
        ${u.files.map(f => `
          <button class="mem-file" data-user="${escapeHtml(u.userId)}" data-path="${escapeHtml(f.path)}" data-mtime="${escapeHtml(f.mtime)}">
            <span>${escapeHtml(f.path)}</span>
            <span class="b">${formatBytes(f.size)}</span>
          </button>
        `).join("")}
      </div>
    `
  }).join("")
  sidebar.querySelectorAll(".mem-file").forEach(btn =>
    btn.addEventListener("click", () => openMemoryFile(btn.dataset.user, btn.dataset.path, btn.dataset.mtime))
  )
}

async function openMemoryFile(userId, relPath, mtime) {
  document.querySelectorAll(".mem-file").forEach(el =>
    el.classList.toggle("active", el.dataset.user === userId && el.dataset.path === relPath)
  )
  const head = document.getElementById("memory-content-head")
  const pathEl = document.getElementById("memory-content-path")
  const mtimeEl = document.getElementById("memory-content-mtime")
  const rendered = document.getElementById("memory-rendered")
  const userNames = state.doctor?.userNames || {}
  const friendly = userNames[userId] || userId.split("@")[0]
  pathEl.textContent = `${friendly} / ${relPath}`
  mtimeEl.textContent = `updated ${formatRelativeTime(mtime)}`
  head.hidden = false
  rendered.innerHTML = `<p class="empty-state">读取中…</p>`
  let result
  try {
    result = await invoke("wechat_cli_json", { args: ["memory", "read", userId, relPath, "--json"] })
  } catch (err) {
    rendered.innerHTML = `<p class="empty-state">读取失败：${escapeHtml(formatInvokeError(err))}</p>`
    return
  }
  if (!result.ok) {
    rendered.innerHTML = `<p class="empty-state">读取失败：${escapeHtml(result.error || "unknown")}</p>`
    return
  }
  const marked = await loadMarked()
  rendered.innerHTML = marked.parse(result.content)
  memoryState.selected = { userId, path: relPath }
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}k`
  return `${(n / 1024 / 1024).toFixed(1)}M`
}

// ─── boot ────────────────────────────────────────────────────────────

function showDevBannerIfShim() {
  if (!window.__WECHAT_CC_SHIM__) return
  const banner = document.getElementById("dev-banner")
  if (!banner) return
  banner.innerHTML = window.__WECHAT_CC_DRY_RUN__
    ? `<b>演示模式 (DRY_RUN)</b> · service install / stop / start 不会真实生效，但能演练交互流程`
    : `<b>开发 shim 模式</b> · 操作走真实 CLI（未启用 DRY_RUN）`
  banner.hidden = false
}

async function boot() {
  showDevBannerIfShim()
  await loadAgentConfig().catch(err => console.error("agent config load failed", err))
  const report = await loadDoctor().catch(err => { console.error("doctor load failed", err); return null })
  if (!report) {
    setMode("wizard")
    return
  }
  const decision = initialMode(report)
  if (decision.mode === "wizard" && decision.step) showStep(decision.step)
  setMode(decision.mode)
}

boot()
