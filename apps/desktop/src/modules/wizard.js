// Wizard UI module — environment check rendering, step navigation, and
// the "进入控制台" gate.
//
// Owns:
//   #checks (env-check list), #claude-meta, #codex-meta
//   .wizard .screen + .steps .step (step 1-4 nav)
//   #enter-dashboard (gated on daemon.alive)
//   #wizard-foot-dot/text + #dash-rail-dot/text (footer status pills)
// Subscribes to: doctorPoller (renders env list on each successful poll)

import { doctorRows, daemonStatusLine, escapeHtml } from "../view.js"

const STEP_ORDER = ["doctor", "provider", "wechat", "service"]

export function renderDoctorWizard(report) {
  const list = document.getElementById("checks")
  if (!list) return
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

export function updateFooterStatus(daemon) {
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

// Gate "进入控制台" on daemon.alive: it makes no sense to send the user to
// a control panel that says "Daemon offline · press restart" — they came
// from the wizard precisely to get the daemon UP. Disabled state with a
// helper title gives them a clear reason instead of a dead-end click.
export function refreshEnterDashboardButton(report) {
  const btn = document.getElementById("enter-dashboard")
  if (!btn) return
  const alive = !!report?.checks?.daemon?.alive
  btn.disabled = !alive
  if (alive) btn.removeAttribute("title")
  else btn.title = "daemon 还没启动 · 先点「安装并启动」"
}

// Imperative step navigator. Caller (main.js) wires the .steps buttons
// + continue-* buttons to this. Returns the resolved step name so callers
// can persist it in their own state if needed.
export function showStep(stepState, name) {
  stepState.currentStep = name
  document.querySelectorAll(".wizard .screen").forEach(el => el.classList.remove("active"))
  document.querySelector(`#screen-${name}`).classList.add("active")
  const idx = STEP_ORDER.indexOf(name)
  document.querySelectorAll(".steps .step").forEach((el) => {
    const stepIdx = STEP_ORDER.indexOf(el.dataset.step)
    el.classList.remove("is-done", "is-active")
    if (stepIdx < idx) el.classList.add("is-done")
    else if (stepIdx === idx) el.classList.add("is-active")
    const num = el.querySelector(".num")
    if (num) num.textContent = stepIdx < idx ? "✓" : String(stepIdx + 1)
  })
  document.getElementById("wizard-step-of").textContent = `step ${idx + 1} of ${STEP_ORDER.length}`
  return name
}

export const STEP_ORDER_EXPORTED = STEP_ORDER
