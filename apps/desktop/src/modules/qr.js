// @ts-check
/// <reference lib="dom" />
/** @typedef {import('../../../../src/cli/schema').SetupQrJsonOutputT} SetupQrJson */
/** @typedef {import('../../../../src/cli/schema').SetupPollOutputT} SetupPoll */
/**
 * @typedef {{ invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>, mock: boolean }} Deps
 * @typedef {{ setup: SetupQrJson | null, currentBaseUrl: string | null, qrTimer: ReturnType<typeof setInterval> | null, qrErrors: number }} QrState
 */

// QR / setup-poll module. Owns the wizard's bind-WeChat screen lifecycle:
// fetch a QR payload via `setup --qr-json`, render it via the qrcode_svg
// command (or the test-shim's placeholder), poll setup-poll every 2s
// until confirmed/expired, then swap the QR for a checkmark + accountId.
//
// Owns: #qr-box, #qr-title, #qr-message, #qr-poll, #qr-ttl, #qr-raw,
//       #continue-service, #qr-refresh
// Reads from / writes to a passed-in `state` bag for setup + qrTimer +
// currentBaseUrl + qrErrors so main.js can clear it on mode switch.

import { pollAdvance, escapeHtml } from "../view.js"

const POLL_INTERVAL_MS = 2000
const MAX_POLL_ERRORS = 5

/**
 * @param {Deps} deps
 * @param {QrState} state
 */
export async function refreshQr(deps, state) {
  if (state.qrTimer != null) clearInterval(state.qrTimer)
  sessionStorage.removeItem("qrPollCount")
  state.qrErrors = 0
  const qr = /** @type {SetupQrJson} */ (await deps.invoke("wechat_cli_json", { args: ["setup", "--qr-json"] }))
  state.setup = qr
  state.currentBaseUrl = null
  const qrBox = /** @type {HTMLElement} */ (document.getElementById("qr-box"))
  await renderQrInto(deps, qrBox, qr.qrcode_img_content)
  const titleEl = document.getElementById("qr-title")
  const messageEl = document.getElementById("qr-message")
  const pollEl = document.getElementById("qr-poll")
  const ttlEl = document.getElementById("qr-ttl")
  const rawEl = document.getElementById("qr-raw")
  const continueBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("continue-service"))
  if (titleEl) titleEl.textContent = "等待扫码"
  if (messageEl) messageEl.textContent = "用微信扫描二维码。"
  if (pollEl) pollEl.hidden = false
  if (ttlEl) ttlEl.textContent = qr.expires_in_ms
    ? `${Math.floor(qr.expires_in_ms / 1000)}s ttl`
    : "scan now"
  if (rawEl) rawEl.textContent = JSON.stringify(qr, null, 2)
  if (continueBtn) continueBtn.disabled = true
  state.qrTimer = setInterval(() => pollQr(deps, state), POLL_INTERVAL_MS)
}

/**
 * @param {Deps} deps
 * @param {HTMLElement} box
 * @param {string} text
 */
async function renderQrInto(deps, box, text) {
  if (deps.mock) { box.textContent = text; return }
  try {
    const svg = /** @type {string} */ (await deps.invoke("render_qr_svg", { text }))
    box.innerHTML = svg
  } catch (err) {
    box.textContent = `${text}\n\n(渲染失败: ${err})`
  }
}

/**
 * @param {Deps} deps
 * @param {QrState} state
 */
async function pollQr(deps, state) {
  if (!state.setup) return
  const args = ["setup-poll", "--qrcode", state.setup.qrcode, "--json"]
  if (state.currentBaseUrl) args.splice(3, 0, "--base-url", state.currentBaseUrl)
  let result
  try {
    result = /** @type {SetupPoll} */ (await deps.invoke("wechat_cli_json", { args }))
    state.qrErrors = 0
  } catch (err) {
    state.qrErrors = (state.qrErrors || 0) + 1
    const rawEl = document.getElementById("qr-raw")
    if (rawEl) rawEl.textContent = `轮询失败 (${state.qrErrors}/${MAX_POLL_ERRORS}):\n${err}`
    if (state.qrErrors >= MAX_POLL_ERRORS) {
      if (state.qrTimer != null) clearInterval(state.qrTimer)
      const titleEl = document.getElementById("qr-title")
      const messageEl = document.getElementById("qr-message")
      const pollEl = document.getElementById("qr-poll")
      if (titleEl) titleEl.textContent = "轮询暂停"
      if (messageEl) messageEl.textContent = "请点「生成二维码」重试。"
      if (pollEl) pollEl.hidden = true
    }
    return
  }
  const rawEl2 = document.getElementById("qr-raw")
  if (rawEl2) rawEl2.textContent = JSON.stringify(result, null, 2)
  const advance = pollAdvance(state, result)
  if (advance.stopTimer) {
    if (state.qrTimer != null) clearInterval(state.qrTimer)
    const pollEl = document.getElementById("qr-poll")
    if (pollEl) pollEl.hidden = true
  }
  if (advance.currentBaseUrl !== undefined) state.currentBaseUrl = advance.currentBaseUrl
  if (advance.qrTitle !== undefined) { const el = document.getElementById("qr-title"); if (el) el.textContent = advance.qrTitle }
  if (advance.qrMessage !== undefined) { const el = document.getElementById("qr-message"); if (el) el.textContent = advance.qrMessage }
  if (advance.continueEnabled !== undefined) {
    const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById("continue-service"))
    if (btn) btn.disabled = !advance.continueEnabled
  }
  // After confirmed binding, hide the QR + TTL — leaving the code on screen
  // is confusing (user already scanned, the code is now invalid) and the
  // primary CTA in the header ("继续") tells them what to do next.
  if (result.status === "confirmed") {
    const box = document.getElementById("qr-box")
    if (box) box.innerHTML = `<div style="font-size: 13px; color: var(--green-ink); padding: 24px 12px; text-align: center; line-height: 1.6;">✓<br>已绑定<br><span style="font-family: var(--mono); font-size: 11px; color: var(--ink-3);">${escapeHtml(result.accountId || "")}</span></div>`
    const ttl = document.getElementById("qr-ttl")
    if (ttl) ttl.textContent = "—"
    // The "已绑定" badge in the right column already conveys success —
    // the raw-response toggle is debug noise after that.
    const rawToggle = document.getElementById("qr-raw-toggle")
    if (rawToggle) rawToggle.hidden = true
    const raw = document.getElementById("qr-raw")
    if (raw) { raw.classList.remove("show"); raw.hidden = true }
  }
}
