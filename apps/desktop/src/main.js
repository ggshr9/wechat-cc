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
import { loadMemoryPane, wireMemoryButtons, loadMemoryTopZone, loadMemoryDecisions, archiveObservation } from "./modules/memory.js"
import { loadLogsPane, startLogsAutoRefresh, stopLogsAutoRefresh } from "./modules/logs.js"
import { loadSessionsList, openProjectDetail, closeProjectDetail, toggleFavorite, exportProjectMarkdown, deleteProject, wireSearch, startSessionsAutoRefresh, stopSessionsAutoRefresh, stopDetailAutoRefresh, setSessionsDetailMode } from "./modules/sessions.js"
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

// Live status line for the network guard toggle. Pulls fresh probe
// each refresh — `wechat-cc guard status` is itself one-shot and does
// the IP + canary fetch synchronously. Fast enough for a click; not
// fast enough to call on every doctor tick (would burn one google
// HEAD per 5s), so we trigger only on toggle clicks + on dashboard
// entry (see setMode below).
async function refreshGuardStatus() {
  const el = document.getElementById("guard-status-line")
  const toggle = document.getElementById("guard-toggle")
  if (!el || !toggle) return
  el.textContent = "查询中…"
  try {
    const r = await invoke("wechat_cli_json", { args: ["guard", "status", "--json"] })
    if (r.enabled) toggle.classList.add("on")
    else toggle.classList.remove("on")
    toggle.setAttribute("aria-pressed", r.enabled ? "true" : "false")
    if (!r.enabled) {
      el.textContent = "未开启"
      delete el.dataset.state  // wipe stale color from previous run
      return
    }
    const ipPart = r.ip ? `IP ${r.ip}` : "IP 未知"
    const probePart = r.reachable ? "google ✓" : "google ✗"
    el.textContent = `${ipPart} · ${probePart}`
    el.dataset.state = r.reachable ? "ok" : "down"
  } catch (err) {
    el.textContent = `查询失败：${err?.message || err}`
  }
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

function showStep(name) {
  wizardShowStep(state, name)
  // Service step has the guard toggle — refresh status when entering so
  // the line shows current IP + reachability without waiting for a click.
  if (name === "service") refreshGuardStatus()
}

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
  if (name === "memory") {
    loadMemoryPane(deps).catch(err => {
      console.error("memory load failed", err)
      document.getElementById("memory-rendered").innerHTML =
        `<p class="empty-state">加载失败：${formatInvokeError(err)}</p>`
    })
    loadMemoryTopZone(deps).catch(err => console.error("memory top zone failed", err))
  }
  if (name === "sessions") {
    loadSessionsList(deps).catch(err => console.error("sessions load failed", err))
    startSessionsAutoRefresh(deps)
  } else {
    stopSessionsAutoRefresh()
    stopDetailAutoRefresh()
  }
}

// ─── DOM event wiring ────────────────────────────────────────────────

function wireEvents() {
  document.querySelectorAll(".steps .step").forEach(btn =>
    btn.addEventListener("click", () => showStep(btn.dataset.step))
  )
  // Single delegated handler for any [data-copy] button — used by the
  // doctor row fix-hints (`复制` button next to npm install commands).
  // Delegated so newly-rendered rows stay live without re-binding.
  document.addEventListener("click", async (ev) => {
    const t = ev.target instanceof HTMLElement ? ev.target.closest("[data-copy]") : null
    if (!t) return
    try {
      await navigator.clipboard.writeText(t.getAttribute("data-copy") || "")
      const orig = t.textContent
      t.textContent = "已复制 ✓"
      setTimeout(() => { t.textContent = orig }, 1200)
    } catch { /* clipboard denied → silent; the command is visible in the code block */ }
  })
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
    t.addEventListener("click", async () => {
      t.classList.toggle("on")
      const on = t.classList.contains("on")
      t.setAttribute("aria-pressed", on ? "true" : "false")
      if (t.id === "unattended-toggle") state.unattended = on
      if (t.id === "autostart-toggle") state.autoStart = on
      if (t.id === "guard-toggle") {
        // Persist immediately — guard config lives in its own JSON.
        // The daemon's scheduler reads loadGuardConfig() each tick so
        // the change takes effect on the next 30s poll. Refresh
        // doctor too so the status line picks up the new probe.
        try {
          await invoke("wechat_cli_json", { args: ["guard", on ? "enable" : "disable", "--json"] })
          refreshGuardStatus()
        } catch { /* best-effort — toggle stays in the UI either way */ }
      }
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
    withRefreshFeedback(e.currentTarget, async () => {
      await loadMemoryPane(deps)
      await loadMemoryTopZone(deps)
    }),
  )
  wireMemoryButtons(deps)

  // Memory top zone — handle archive button clicks via delegation
  document.getElementById("memory-observations")?.addEventListener("click", async (e) => {
    const archiveBtn = e.target.closest("[data-action='archive-observation']")
    if (archiveBtn) {
      e.stopPropagation()
      await archiveObservation(deps, archiveBtn.dataset.id)
    }
  })

  // Memory decisions — toggle folded zone, lazy-load on first expand
  document.getElementById("memory-decisions-toggle")?.addEventListener("click", () => {
    const toggle = document.getElementById("memory-decisions-toggle")
    const body = document.getElementById("memory-decisions-body")
    if (!toggle || !body) return
    const wasOpen = toggle.getAttribute("aria-expanded") === "true"
    toggle.setAttribute("aria-expanded", wasOpen ? "false" : "true")
    body.hidden = wasOpen
    if (!wasOpen) loadMemoryDecisions(deps).catch(err => console.error("decisions load failed", err))
  })

  // Memory decisions — click row to expand reasoning (CSS handles the visual via .expanded class)
  document.getElementById("memory-decisions-body")?.addEventListener("click", (e) => {
    const row = e.target.closest("[data-action='toggle-decision']")
    if (row) row.classList.toggle("expanded")
  })
  document.getElementById("logs-refresh")?.addEventListener("click", (e) =>
    withRefreshFeedback(e.currentTarget, () => loadLogsPane(deps)),
  )
  document.getElementById("sessions-refresh")?.addEventListener("click", (e) =>
    withRefreshFeedback(e.currentTarget, () => loadSessionsList(deps)),
  )
  // Sessions — list-row clicks. closest('[data-action]') routes to the
  // innermost match: clicking the star toggles favorite (and stops there);
  // clicking anywhere else on the row opens the detail.
  document.getElementById("sessions-body")?.addEventListener("click", (e) => {
    const actionEl = e.target.closest("[data-action]")
    if (!actionEl) return
    const action = actionEl.dataset.action
    const alias = actionEl.dataset.alias
    if (action === 'toggle-favorite') {
      toggleFavorite(alias)
      loadSessionsList(deps)
      return
    }
    if (action === 'open-project') {
      const turnIdx = actionEl.dataset.turnIndex
      const opts = turnIdx !== undefined ? { focusTurn: Number(turnIdx) } : {}
      openProjectDetail(deps, alias, opts)
    }
  })
  document.getElementById("sessions-back")?.addEventListener("click", closeProjectDetail)
  document.getElementById("sessions-export")?.addEventListener("click", () => exportProjectMarkdown(deps))
  document.getElementById("sessions-delete")?.addEventListener("click", () => deleteProject(deps))
  document.getElementById("sessions-mode-compact")?.addEventListener("click", () =>
    setSessionsDetailMode(deps, "compact"),
  )
  document.getElementById("sessions-mode-detailed")?.addEventListener("click", () =>
    setSessionsDetailMode(deps, "detailed"),
  )
  wireSearch(deps)
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

  // ─── Lightbox for chat-bubble image / file attachments + avatar edit ─
  document.body.addEventListener("click", (ev) => {
    const avatar = ev.target.closest(".wechat-avatar[data-avatar-key]")
    if (avatar) {
      ev.preventDefault()
      openAvatarModal(deps, avatar.dataset.avatarKey)
      return
    }
    const img = ev.target.closest(".wechat-image")
    if (img) {
      ev.preventDefault()
      openImageLightbox(img.src)
      return
    }
    const fileCard = ev.target.closest(".wechat-file-card")
    if (fileCard) {
      ev.preventDefault()
      openFileLightbox(fileCard.dataset.path, fileCard.dataset.name, fileCard.dataset.ext)
      return
    }
    const lightbox = ev.target.closest("#lightbox")
    if (lightbox && !ev.target.closest(".lightbox-body")) {
      closeLightbox()
    }
  })
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeLightbox()
  })
}

function openImageLightbox(src) {
  const lb = document.getElementById("lightbox")
  const body = document.getElementById("lightbox-body")
  if (!lb || !body) return
  body.innerHTML = `<img class="lightbox-img" src="${src}" alt="image"/>`
  lb.hidden = false
  lb.setAttribute("aria-hidden", "false")
}

async function openFileLightbox(path, name, ext) {
  const lb = document.getElementById("lightbox")
  const body = document.getElementById("lightbox-body")
  if (!lb || !body) return
  body.innerHTML = `
    <div class="lightbox-file">
      <div class="lightbox-file-head">
        <span class="lightbox-file-name">${escapeHtml(name || path || "")}</span>
        <span class="lightbox-file-tag">${escapeHtml(ext || "FILE")}</span>
      </div>
      <div class="lightbox-file-content is-empty">加载中…</div>
    </div>
  `
  lb.hidden = false
  lb.setAttribute("aria-hidden", "false")
  const content = body.querySelector(".lightbox-file-content")

  try {
    const url = "/attachment?path=" + encodeURIComponent(path)
    const r = await fetch(url)
    if (!r.ok) {
      content.classList.add("is-empty")
      content.textContent = `无法预览：${r.status} ${r.statusText}`
      return
    }
    const TEXT_EXTS = new Set(["TXT","MD","JSON","CSV","LOG","YAML","YML","XML","HTML","HTM","JS","TS","JSX","TSX","CSS","PY","SH","C","CPP","H","HPP","JAVA","GO","RS","TOML","INI","ENV","RB","PHP","SQL","CONF","DIFF","PATCH"])
    const e = (ext || "").toUpperCase()
    if (TEXT_EXTS.has(e)) {
      let text = await r.text()
      // Cap preview at ~200KB to keep DOM tractable.
      if (text.length > 200_000) text = text.slice(0, 200_000) + "\n\n…(预览已截断)"
      content.classList.remove("is-empty")
      content.textContent = text
    } else {
      // Binary: show first 1KB as hex preview so the user has *some* sense
      const buf = await r.arrayBuffer()
      const bytes = new Uint8Array(buf.slice(0, 1024))
      const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join(" ")
      content.classList.remove("is-empty")
      content.textContent = `(二进制文件，前 ${bytes.length} 字节 hex 预览):\n\n${hex}`
    }
  } catch (err) {
    content.classList.add("is-empty")
    content.textContent = "读取失败：" + (err?.message || String(err))
  }
}

// ─── Avatar edit modal ──────────────────────────────────────────────
//
// Click an avatar (.wechat-avatar with data-avatar-key) → modal opens
// inside the lightbox container, lets the user pick a new image (or
// remove the current one). Image is canvas-resized to 80×80 PNG before
// it's sent to the daemon CLI as base64. Reload reopens the chat to
// pick up the new avatar.

async function openAvatarModal(deps, key) {
  const lb = document.getElementById("lightbox")
  const body = document.getElementById("lightbox-body")
  if (!lb || !body) return
  const titleSubject = key === "claude" ? "Claude" : (extractContactNameFromOpenChat() || "联系人")
  // Look up current avatar (if any) for the preview slot.
  let info = null
  try {
    info = await deps.invoke("wechat_cli_json", { args: ["avatar", "info", key, "--json"] })
  } catch { /* ignore — preview falls back */ }
  const previewHtml = info?.exists
    ? `<img src="/attachment?path=${encodeURIComponent(info.path)}&v=${Date.now()}"/>`
    : `<span style="background:${key === "claude" ? "#586672" : "#6B655C"}; width:100%; height:100%; display:flex; align-items:center; justify-content:center;">${escapeHtml(key === "claude" ? "cc" : (titleSubject.charAt(0).toUpperCase()))}</span>`

  body.innerHTML = `
    <div class="avatar-modal">
      <h3 class="avatar-modal-title">为 ${escapeHtml(titleSubject)} 设置头像</h3>
      <div class="avatar-modal-preview" id="avatar-modal-preview">${previewHtml}</div>
      <div class="avatar-modal-drop" id="avatar-modal-drop">
        点击选择图片，或拖拽到此处
        <input type="file" id="avatar-modal-input" accept="image/png,image/jpeg,image/webp" hidden />
      </div>
      <div class="avatar-modal-actions">
        <button class="btn ghost" id="avatar-modal-remove" ${info?.exists ? "" : "disabled"}>移除自定义</button>
        <span class="btn-spacer"></span>
        <button class="btn ghost" id="avatar-modal-cancel">取消</button>
      </div>
    </div>
  `
  lb.hidden = false
  lb.setAttribute("aria-hidden", "false")

  const input = body.querySelector("#avatar-modal-input")
  const drop = body.querySelector("#avatar-modal-drop")
  const preview = body.querySelector("#avatar-modal-preview")

  drop.addEventListener("click", () => input.click())
  input.addEventListener("change", () => handleAvatarFile(deps, key, input.files?.[0], preview))
  ;["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); drop.classList.add("is-dragover")
  }))
  ;["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); drop.classList.remove("is-dragover")
  }))
  drop.addEventListener("drop", e => {
    const file = e.dataTransfer?.files?.[0]
    if (file) handleAvatarFile(deps, key, file, preview)
  })
  body.querySelector("#avatar-modal-cancel").addEventListener("click", closeLightbox)
  body.querySelector("#avatar-modal-remove").addEventListener("click", async () => {
    try {
      await deps.invoke("wechat_cli_json", { args: ["avatar", "remove", key, "--json"] })
      closeLightbox()
      reopenCurrentSession(deps)
    } catch (err) {
      preview.innerHTML = `<span style="font-size:11px; color:var(--ink-3); padding:4px;">${escapeHtml(err?.message || String(err))}</span>`
    }
  })
}

async function handleAvatarFile(deps, key, file, previewEl) {
  if (!file) return
  if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) {
    previewEl.innerHTML = `<span style="font-size:11px; color:var(--red); padding:4px;">仅支持 PNG / JPEG / WEBP</span>`
    return
  }
  if (file.size > 5 * 1024 * 1024) {
    previewEl.innerHTML = `<span style="font-size:11px; color:var(--red); padding:4px;">图片太大（>5MB）</span>`
    return
  }
  try {
    const base64 = await imageToResizedPngBase64(file, 80)
    await deps.invoke("wechat_cli_json", { args: ["avatar", "set", key, "--base64", base64, "--json"] })
    closeLightbox()
    reopenCurrentSession(deps)
  } catch (err) {
    previewEl.innerHTML = `<span style="font-size:11px; color:var(--red); padding:4px;">${escapeHtml(err?.message || String(err))}</span>`
  }
}

// Read a File / Blob → draw onto canvas square-cropped + resized → PNG base64
function imageToResizedPngBase64(blob, size) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas")
        canvas.width = size; canvas.height = size
        const ctx = canvas.getContext("2d")
        // Square-crop from center (cover behavior)
        const sw = img.naturalWidth, sh = img.naturalHeight
        const side = Math.min(sw, sh)
        const sx = (sw - side) / 2, sy = (sh - side) / 2
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size)
        const dataUrl = canvas.toDataURL("image/png")
        URL.revokeObjectURL(url)
        // Strip the data: prefix when sending to CLI
        resolve(dataUrl.replace(/^data:image\/png;base64,/, ""))
      } catch (e) { reject(e) }
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("无法读取图片")) }
    img.src = url
  })
}

function extractContactNameFromOpenChat() {
  return document.querySelector(".phone-title-name")?.textContent?.trim() || null
}

function reopenCurrentSession(deps) {
  const detail = document.getElementById("sessions-detail")
  const alias = detail?.dataset.alias
  if (alias) {
    import("./modules/sessions.js").then(m => m.openProjectDetail(deps, alias))
  }
}

function closeLightbox() {
  const lb = document.getElementById("lightbox")
  const body = document.getElementById("lightbox-body")
  if (!lb || !body) return
  if (lb.hidden) return
  body.innerHTML = ""
  lb.hidden = true
  lb.setAttribute("aria-hidden", "true")
}

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
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
