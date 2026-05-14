// Setup-page renderer — single page, no step navigation.
//
// Owns:
//   .agent-card * (cards + state + meta)
//   #scan-bind (gated on ≥1 agent installed)
//   #wsl-tip (folded; shown only if doctor reports WSL)
//   #wizard-foot-dot / #wizard-foot-text (status pill)
//   #install-strip + #setup-error (transient UI states for the
//                                  install→scan flow)

import { daemonStatusLine } from "../view.js"

export function renderSetupPage(report) {
  renderAgentCards(report)
  renderWslTip(report)
  refreshScanButton(report)
  updateFooterStatus(report.checks?.daemon)
}

function renderAgentCards(report) {
  for (const provider of ["claude", "codex"]) {
    const check = report.checks?.[provider]
    const card = document.getElementById(`agent-card-${provider}`)
    const state = document.getElementById(`agent-state-${provider}`)
    const meta = document.getElementById(`${provider}-meta`)
    const installLink = card?.querySelector(".install-link")
    if (!card || !state || !meta) continue
    const installed = !!check?.ok
    card.classList.toggle("installed", installed)
    card.classList.toggle("missing", !installed)
    state.textContent = installed ? "✓ 已安装" : "✗ 未安装"
    meta.textContent = installed ? (check.path || "已检测到") : "未在 PATH 上"
    if (installLink) installLink.hidden = installed
  }
}

function renderWslTip(report) {
  const tip = document.getElementById("wsl-tip")
  if (!tip) return
  tip.hidden = !report.wslDetected
}

export function refreshScanButton(report) {
  const btn = document.getElementById("scan-bind")
  if (!btn) return
  const claudeOk = !!report.checks?.claude?.ok
  const codexOk = !!report.checks?.codex?.ok
  const anyAgent = claudeOk || codexOk
  btn.disabled = !anyAgent
  if (anyAgent) btn.removeAttribute("title")
  else btn.title = "先装一个 agent · 本页会自动检测"
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

// Setup error strip + install progress strip — transient UI used by
// the scan-bind flow (handleScanClick in main.js).

export function showSetupError(message, details) {
  const strip = document.getElementById("setup-error")
  const msgEl = document.getElementById("setup-error-msg")
  const bodyEl = document.getElementById("setup-error-details-body")
  if (!strip || !msgEl) return
  msgEl.textContent = message
  if (bodyEl) {
    bodyEl.textContent = details || ""
    bodyEl.hidden = true
  }
  strip.hidden = false
}

export function clearSetupError() {
  const strip = document.getElementById("setup-error")
  if (strip) strip.hidden = true
}

export function showInstallStrip(label) {
  const strip = document.getElementById("install-strip")
  const labelEl = document.getElementById("install-strip-label")
  if (!strip) return
  if (labelEl && label) labelEl.textContent = label
  strip.hidden = false
}

export function hideInstallStrip() {
  const strip = document.getElementById("install-strip")
  if (strip) strip.hidden = true
}

// Back-compat alias: any existing callsite of renderDoctorWizard
// continues to work. Main.js will be updated to call renderSetupPage
// directly in Task 7; do not delete this until that lands.
export function renderDoctorWizard(report) { renderSetupPage(report) }
