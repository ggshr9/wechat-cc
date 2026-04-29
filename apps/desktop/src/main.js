// main.js — boot, mode router, and event-listener wiring. Per-feature logic
// lives in modules/ (wizard, qr, service, dashboard, memory, update). The
// doctor lifecycle is owned by doctor-poller.js; main.js just wires its
// subscribers + invokes refresh from action handlers.

import { invoke as ipcInvoke, formatInvokeError } from "./ipc.js"
import { initialMode, restartButtonState } from "./view.js"
import { createDoctorPoller } from "./doctor-poller.js"
import { renderDoctorWizard, refreshEnterDashboardButton, updateFooterStatus, showStep as wizardShowStep } from "./modules/wizard.js"
import { refreshQr } from "./modules/qr.js"
import { serviceAction, forceKillDaemon } from "./modules/service.js"
import { renderDashboard, renderRestartButton, setPending, updateClock, restartDaemon, stopDaemon, handleAccountRowClick } from "./modules/dashboard.js"
import { loadMemoryPane, wireMemoryButtons } from "./modules/memory.js"
import { loadLogsPane, startLogsAutoRefresh, stopLogsAutoRefresh } from "./modules/logs.js"
import { loadUpdateProbe, applyUpdate } from "./modules/update.js"

const state = {
  setup: null,
  currentBaseUrl: null,
  selectedProvider: "claude",
  unattended: true,
  autoStart: false,
  qrTimer: null,
  qrErrors: 0,
  clockTimer: null,
  mode: "loading",
  currentStep: "doctor",
  updateProbed: false,
}

const mock = !window.__TAURI__?.core?.invoke

// macOS uses titleBarStyle: "Overlay" — window content extends under the
// traffic-light area. CSS reads data-platform to add top padding on the rail
// so the brand block doesn't sit behind the close/min/max buttons.
if (/Mac/i.test(navigator.platform || navigator.userAgent || "")) {
  document.documentElement.dataset.platform = "macos"
}

// Brief click feedback shared across all "刷新" buttons (overview/memory/logs):
// disable + replace label text with "已刷新" → revert after 1.2s. Stops users
// from double-clicking and confirms the click without leaving stale text
// behind (the prior overview-only `setPending("已刷新")` never cleared).
async function withRefreshFeedback(button, fn) {
  if (!button) return await fn()
  const labelNode = Array.from(button.childNodes).find(
    n => n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 0,
  )
  const original = labelNode ? labelNode.textContent : null
  button.disabled = true
  try {
    await fn()
  } finally {
    if (labelNode) labelNode.textContent = " 已刷新"
    setTimeout(() => {
      if (labelNode && original !== null) labelNode.textContent = original
      button.disabled = false
    }, 1200)
  }
}

// `state` carried through ipcInvoke for the mock path so dev-mode mocks can
// react to selectedProvider/unattended/autoStart toggles in real time.
const invoke = (cmd, args) => ipcInvoke(cmd, args, state)

const doctorPoller = createDoctorPoller({ invoke, intervalMs: 5000 })

// Bag passed to module functions instead of imported singletons. Keeps each
// module testable in isolation (any conformant deps object → run the module
// in a JSDOM/happy-dom harness).
const deps = {
  invoke,
  formatInvokeError,
  doctorPoller,
  mock,
  setPending,
  // Dashboard's restart button routes to the wizard service step when no
  // service is registered — needs a way to flip mode + step without
  // direct-importing this file. Capture as a callback.
  routeToWizardService: () => {
    setMode("wizard")
    showStep("service")
  },
}

// ─── mode router ──────────────────────────────────────────────────────

function setMode(mode) {
  state.mode = mode
  document.documentElement.dataset.mode = mode
  if (mode === "dashboard") {
    doctorPoller.start()
    if (!state.clockTimer) state.clockTimer = setInterval(updateClock, 1000)
    updateClock()
    if (!state.updateProbed) {
      state.updateProbed = true
      loadUpdateProbe(deps).catch(err => console.error("update probe failed", err))
    }
  } else {
    doctorPoller.stop()
    if (state.clockTimer) { clearInterval(state.clockTimer); state.clockTimer = null }
  }
}

function showStep(name) { wizardShowStep(state, name) }

// ─── doctor subscribers ──────────────────────────────────────────────

function wireDoctorSubscribers() {
  doctorPoller.subscribe(renderDoctorWizard)
  doctorPoller.subscribe(refreshEnterDashboardButton)
  doctorPoller.subscribe(report => updateFooterStatus(report.checks.daemon))
  doctorPoller.subscribe(renderDashboardIfActive)
  doctorPoller.subscribe(renderRestartButton)
}

function renderDashboardIfActive(report) {
  if (state.mode !== "dashboard") return
  renderDashboard(report)
}

// ─── agent picker ────────────────────────────────────────────────────

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
  if (state.mode === "dashboard") doctorPoller.refresh()
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

// ─── pane switching ──────────────────────────────────────────────────

function switchPane(name) {
  document.querySelectorAll(".dash-nav-link[data-pane]").forEach(el =>
    el.classList.toggle("active", el.dataset.pane === name && !el.classList.contains("disabled"))
  )
  document.querySelectorAll(".dash-pane[data-pane]").forEach(el => {
    el.hidden = el.dataset.pane !== name
  })
  // Logs pane gets a 10s auto-refresh tick while active; stop it on
  // pane switch so we don't burn CPU tailing log files no one is reading.
  if (name === "logs") {
    loadLogsPane(deps).catch(err => console.error("logs load failed", err))
    startLogsAutoRefresh(deps)
  } else {
    stopLogsAutoRefresh()
  }
  if (name === "memory") loadMemoryPane(deps).catch(err => {
    console.error("memory load failed", err)
    document.getElementById("memory-rendered").innerHTML =
      `<p class="empty-state">加载失败：${formatInvokeError(err)}</p>`
  })
}

// ─── DOM event wiring ────────────────────────────────────────────────

function wireEvents() {
  document.querySelectorAll(".steps .step").forEach(btn =>
    btn.addEventListener("click", () => showStep(btn.dataset.step))
  )
  document.getElementById("continue-provider").addEventListener("click", () => showStep("provider"))
  document.getElementById("continue-wechat").addEventListener("click", () => showStep("wechat"))
  document.getElementById("continue-service").addEventListener("click", () => showStep("service"))
  document.getElementById("qr-refresh").addEventListener("click", () => refreshQr({ invoke, mock }, state))
  document.getElementById("service-install").addEventListener("click", () => serviceAction(deps, state, "install"))
  document.getElementById("post-stop-kill")?.addEventListener("click", () => forceKillDaemon(deps))
  document.getElementById("enter-dashboard").addEventListener("click", () => setMode("dashboard"))
  document.getElementById("copy-diagnostics").addEventListener("click", async () => {
    await navigator.clipboard?.writeText(JSON.stringify(doctorPoller.current, null, 2))
  })

  document.querySelectorAll(".agent[data-provider]").forEach(btn =>
    btn.addEventListener("click", () => commitProvider(btn.dataset.provider))
  )

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

  document.getElementById("dash-refresh").addEventListener("click", (e) =>
    withRefreshFeedback(e.currentTarget, () => doctorPoller.refresh()),
  )
  document.getElementById("dash-stop").addEventListener("click", () => stopDaemon(deps))
  document.getElementById("dash-restart").addEventListener("click", () => restartDaemon(deps))
  document.getElementById("memory-refresh")?.addEventListener("click", (e) =>
    withRefreshFeedback(e.currentTarget, () => loadMemoryPane(deps)),
  )
  wireMemoryButtons(deps)
  document.getElementById("logs-refresh")?.addEventListener("click", (e) =>
    withRefreshFeedback(e.currentTarget, () => loadLogsPane(deps)),
  )
  document.getElementById("logs-tail-select")?.addEventListener("change", () => loadLogsPane(deps))
  document.getElementById("update-check-btn")?.addEventListener("click", () => loadUpdateProbe(deps))
  document.getElementById("update-apply-btn")?.addEventListener("click", () => applyUpdate(deps))

  document.getElementById("accounts-body").addEventListener("click", ev => handleAccountRowClick(deps, ev))

  document.querySelectorAll("[data-action='open-wizard']").forEach(btn =>
    btn.addEventListener("click", () => setMode("wizard"))
  )
  document.querySelectorAll("[data-action='open-dashboard']").forEach(btn =>
    btn.addEventListener("click", () => setMode("dashboard"))
  )

  document.querySelectorAll(".dash-nav-link[data-pane]").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("disabled")) return
      switchPane(btn.dataset.pane)
    })
  })
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
  wireDoctorSubscribers()
  wireEvents()
  await loadAgentConfig().catch(err => console.error("agent config load failed", err))
  const report = await doctorPoller.refresh()
  if (!report) {
    setMode("wizard")
    return
  }
  const decision = initialMode(report)
  if (decision.mode === "wizard" && decision.step) showStep(decision.step)
  setMode(decision.mode)
}

boot()
