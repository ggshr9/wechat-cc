import { mockInvoke } from "./mock.js"
import { doctorRows, pollAdvance, daemonStatusLine, escapeHtml } from "./view.js"

const state = {
  doctor: null,
  setup: null,
  currentBaseUrl: null,
  selectedProvider: "claude",
  unattended: true,
  qrTimer: null,
  qrErrors: 0,
}

const titles = {
  doctor: ["检查环境", "确认本机可以运行 wechat-cc。"],
  provider: ["选择 Agent", "选择手机消息要进入的本机 agent。"],
  wechat: ["绑定微信", "扫码后在手机上确认登录。"],
  service: ["后台运行", "安装开机自启并启动 daemon。"],
}

const mock = !window.__TAURI__?.core?.invoke
document.getElementById("runtime-label").textContent = mock ? "Preview mode" : "Desktop setup"

async function invoke(command, args = {}) {
  if (!mock) return await window.__TAURI__.core.invoke(command, args)
  return mockInvoke(command, args, state)
}

function showScreen(name) {
  document.querySelectorAll(".screen").forEach(el => el.classList.remove("active"))
  document.querySelector(`#screen-${name}`).classList.add("active")
  document.querySelectorAll(".step").forEach(el => el.classList.toggle("active", el.dataset.step === name))
  document.getElementById("screen-title").textContent = titles[name][0]
  document.getElementById("screen-subtitle").textContent = titles[name][1]
}

async function loadDoctor() {
  const report = await invoke("wechat_cli_json", { args: ["doctor", "--json"] })
  state.doctor = report
  renderDoctor(report)
}

function renderDoctor(report) {
  const grid = document.getElementById("checks")
  grid.innerHTML = doctorRows(report).map(([name, check]) => `
    <div class="check ${check.ok ? "ok" : "bad"}">
      <strong>${escapeHtml(name)}</strong>
      <span>${escapeHtml(check.path || "missing")}</span>
    </div>
  `).join("")
  document.getElementById("claude-meta").textContent = report.checks.claude.ok ? report.checks.claude.path : "未检测到"
  document.getElementById("codex-meta").textContent = report.checks.codex.ok ? report.checks.codex.path : "未检测到"
  updateService(report.checks.daemon)
}

function updateService(daemon) {
  const line = daemonStatusLine(daemon)
  document.getElementById("service-dot").className = `dot ${line.cls}`
  document.getElementById("service-text").textContent = line.text
}

// Reflect provider in the UI without writing to the backend. Used at startup
// so opening the GUI doesn't silently overwrite a value the user previously
// set via CLI.
function applyProviderUI(provider) {
  state.selectedProvider = provider
  document.querySelectorAll(".provider-option").forEach(btn => btn.classList.toggle("selected", btn.dataset.provider === provider))
}

// Commit a user-initiated provider switch to the backend, carrying the
// current unattended-toggle state along so it survives.
async function commitProvider(provider) {
  applyProviderUI(provider)
  const args = provider === "codex"
    ? ["provider", "set", "codex", "--model", document.getElementById("codex-model").value, "--unattended", state.unattended ? "true" : "false"]
    : ["provider", "set", "claude", "--unattended", state.unattended ? "true" : "false"]
  await invoke("wechat_cli_text", { args })
}

async function loadAgentConfig() {
  const config = await invoke("wechat_cli_json", { args: ["provider", "show", "--json"] })
  const provider = config.provider === "codex" ? "codex" : "claude"
  state.unattended = config.dangerouslySkipPermissions !== false
  applyProviderUI(provider)
  if (config.model) document.getElementById("codex-model").value = config.model
  const toggle = document.getElementById("unattended-toggle")
  if (toggle) toggle.checked = state.unattended
}

async function renderQrInto(box, text) {
  if (mock) {
    box.textContent = text
    return
  }
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
      document.getElementById("qr-message").textContent = "请点「刷新二维码」重试。"
    }
    return
  }
  document.getElementById("qr-raw").textContent = JSON.stringify(result, null, 2)
  const advance = pollAdvance(state, result)
  if (advance.stopTimer) clearInterval(state.qrTimer)
  if (advance.currentBaseUrl !== undefined) state.currentBaseUrl = advance.currentBaseUrl
  if (advance.qrTitle !== undefined) document.getElementById("qr-title").textContent = advance.qrTitle
  if (advance.qrMessage !== undefined) document.getElementById("qr-message").textContent = advance.qrMessage
  if (advance.continueEnabled !== undefined) document.getElementById("continue-service").disabled = !advance.continueEnabled
}

async function serviceAction(action) {
  const planEl = document.getElementById("service-plan")
  const summaryEl = document.getElementById("service-summary")
  // Snapshot toggle state at click time so the install both persists and
  // re-writes the plist with --dangerously matching the user's choice.
  if (action === "install") {
    state.unattended = document.getElementById("unattended-toggle").checked
  }
  const args = ["service", action, "--json"]
  if (action === "install") args.push("--unattended", state.unattended ? "true" : "false")
  let result
  try {
    result = await invoke("wechat_cli_json", { args })
  } catch (err) {
    planEl.textContent = `service ${action} 失败:\n${err}`
    summaryEl.textContent = "操作失败，详见下方日志。"
    return
  }
  planEl.textContent = JSON.stringify(result, null, 2)
  if (result.alive || result.ok) {
    summaryEl.textContent = action === "stop" ? "服务已停止。" : "服务已启动。"
  }
  await loadDoctor()
}

document.querySelectorAll(".step").forEach(btn => btn.addEventListener("click", () => showScreen(btn.dataset.step)))
document.getElementById("refresh-btn").addEventListener("click", loadDoctor)
document.getElementById("continue-provider").addEventListener("click", () => showScreen("provider"))
document.getElementById("continue-wechat").addEventListener("click", () => { showScreen("wechat"); refreshQr() })
document.getElementById("continue-service").addEventListener("click", () => showScreen("service"))
document.getElementById("qr-refresh").addEventListener("click", refreshQr)
document.getElementById("service-install").addEventListener("click", () => serviceAction("install"))
document.getElementById("service-stop").addEventListener("click", () => serviceAction("stop"))
document.getElementById("copy-diagnostics").addEventListener("click", async () => {
  await navigator.clipboard?.writeText(JSON.stringify(state.doctor, null, 2))
})
document.querySelectorAll(".provider-option").forEach(btn => btn.addEventListener("click", () => commitProvider(btn.dataset.provider)))
const unattendedToggle = document.getElementById("unattended-toggle")
if (unattendedToggle) {
  unattendedToggle.addEventListener("change", () => {
    state.unattended = unattendedToggle.checked
  })
}

// Boot: read what's already persisted, reflect it in the UI without writing
// anything back. The user's explicit clicks (Provider cards, Install button)
// are the only paths that mutate backend state from here on.
loadAgentConfig().then(loadDoctor).catch(err => {
  console.error("init failed", err)
  loadDoctor()
})
