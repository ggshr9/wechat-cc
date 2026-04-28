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

export async function refreshQr(deps, state) {
  clearInterval(state.qrTimer)
  sessionStorage.removeItem("qrPollCount")
  state.qrErrors = 0
  const qr = await deps.invoke("wechat_cli_json", { args: ["setup", "--qr-json"] })
  state.setup = qr
  state.currentBaseUrl = null
  await renderQrInto(deps, document.getElementById("qr-box"), qr.qrcode_img_content)
  document.getElementById("qr-title").textContent = "等待扫码"
  document.getElementById("qr-message").textContent = "用微信扫描二维码。"
  document.getElementById("qr-poll").hidden = false
  document.getElementById("qr-ttl").textContent = qr.expires_in_ms
    ? `${Math.floor(qr.expires_in_ms / 1000)}s ttl`
    : "scan now"
  document.getElementById("qr-raw").textContent = JSON.stringify(qr, null, 2)
  document.getElementById("continue-service").disabled = true
  state.qrTimer = setInterval(() => pollQr(deps, state), POLL_INTERVAL_MS)
}

async function renderQrInto(deps, box, text) {
  if (deps.mock) { box.textContent = text; return }
  try {
    const svg = await deps.invoke("render_qr_svg", { text })
    box.innerHTML = svg
  } catch (err) {
    box.textContent = `${text}\n\n(渲染失败: ${err})`
  }
}

async function pollQr(deps, state) {
  if (!state.setup) return
  const args = ["setup-poll", "--qrcode", state.setup.qrcode, "--json"]
  if (state.currentBaseUrl) args.splice(3, 0, "--base-url", state.currentBaseUrl)
  let result
  try {
    result = await deps.invoke("wechat_cli_json", { args })
    state.qrErrors = 0
  } catch (err) {
    state.qrErrors = (state.qrErrors || 0) + 1
    document.getElementById("qr-raw").textContent = `轮询失败 (${state.qrErrors}/${MAX_POLL_ERRORS}):\n${err}`
    if (state.qrErrors >= MAX_POLL_ERRORS) {
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
