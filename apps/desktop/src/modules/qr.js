// @ts-check
/// <reference lib="dom" />
/** @typedef {import('../../../../src/cli/schema').SetupQrJsonOutputT} SetupQrJson */
/** @typedef {import('../../../../src/cli/schema').SetupPollOutputT} SetupPoll */
/**
 * @typedef {{ invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>, mock: boolean }} Deps
 * @typedef {{ setup: SetupQrJson | null, currentBaseUrl: string | null, qrTimer: ReturnType<typeof setInterval> | null, qrConfirmTimer: ReturnType<typeof setTimeout> | null, qrErrors: number }} QrState
 * @typedef {{ onConfirmed?: () => void, onCancel?: () => void }} QrCallbacks
 */

// QR / setup-poll module. Renders a QR into the #qr-modal <dialog>:
// fetch via `setup --qr-json`, render via render_qr_svg (or shim
// placeholder), poll setup-poll every 2s until confirmed/expired,
// then invoke the onConfirmed callback. The dialog show/close is
// owned by openQrModal — refreshQr just paints into whatever
// existing DOM is present.
//
// Owns: #qr-box, #qr-message, #qr-raw, #qr-raw-toggle, #qr-refresh
//       #qr-modal, #qr-modal-close
// Reads from / writes to a passed-in `state` bag for setup +
// qrTimer + currentBaseUrl + qrErrors.

import { pollAdvance, escapeHtml } from "../view.js"

const POLL_INTERVAL_MS = 2000
const MAX_POLL_ERRORS = 5

/**
 * Open the QR <dialog>, generate a QR, poll for scan, then on
 * `confirmed` close the dialog and call onBound. On terminal poll
 * failure or user manually closing the dialog, just clean up state.
 *
 * @param {Deps} deps
 * @param {QrState} state
 * @param {{ onBound: () => void }} opts
 */
export async function openQrModal(deps, state, opts) {
  const dialog = /** @type {HTMLDialogElement | null} */ (document.getElementById("qr-modal"))
  if (!dialog) throw new Error("qr-modal element not found")

  if (typeof dialog.showModal === "function") dialog.showModal()
  else dialog.setAttribute("open", "")

  const cleanup = () => {
    if (state.qrTimer != null) { clearInterval(state.qrTimer); state.qrTimer = null }
    // The 800ms "success badge → onConfirmed" timer (set in pollQr) must
    // also be cancellable from cleanup — otherwise a user who closes the
    // modal in that window still triggers onBound from a stale closure.
    if (state.qrConfirmTimer != null) { clearTimeout(state.qrConfirmTimer); state.qrConfirmTimer = null }
    if (typeof dialog.close === "function" && dialog.open) dialog.close()
    else dialog.removeAttribute("open")
  }

  // Wire close-button (idempotent — once per open).
  const closeBtn = document.getElementById("qr-modal-close")
  const onCloseClick = () => {
    cleanup()
    if (closeBtn) closeBtn.removeEventListener("click", onCloseClick)
  }
  if (closeBtn) closeBtn.addEventListener("click", onCloseClick, { once: true })

  // ESC key on a <dialog> fires a 'cancel' event before closing — hook
  // it for one-shot cleanup. We don't preventDefault: native ESC-to-close
  // is the right UX.
  const onCancelEvt = () => {
    cleanup()
    dialog.removeEventListener("cancel", onCancelEvt)
  }
  dialog.addEventListener("cancel", onCancelEvt, { once: true })

  try {
    await refreshQr(deps, state, {
      onConfirmed: () => {
        cleanup()
        opts.onBound()
      },
      onCancel: () => {
        cleanup()
      },
    })
  } catch (err) {
    cleanup()
    throw err
  }
}

/**
 * Generate + render a QR and start polling. Optional callbacks fire
 * when polling reaches a terminal state.
 *
 * @param {Deps} deps
 * @param {QrState} state
 * @param {QrCallbacks} [callbacks]
 */
export async function refreshQr(deps, state, callbacks = {}) {
  if (state.qrTimer != null) clearInterval(state.qrTimer)
  sessionStorage.removeItem("qrPollCount")
  state.qrErrors = 0
  const qr = /** @type {SetupQrJson} */ (await deps.invoke("wechat_cli_json", { args: ["setup", "--qr-json"] }))
  state.setup = qr
  state.currentBaseUrl = null
  const qrBox = /** @type {HTMLElement} */ (document.getElementById("qr-box"))
  if (qrBox) await renderQrInto(deps, qrBox, qr.qrcode_img_content)
  const messageEl = document.getElementById("qr-message")
  const rawEl = document.getElementById("qr-raw")
  if (messageEl) messageEl.textContent = "用微信扫描二维码后在手机里点确认。"
  if (rawEl) rawEl.textContent = JSON.stringify(qr, null, 2)
  state.qrTimer = setInterval(() => pollQr(deps, state, callbacks), POLL_INTERVAL_MS)
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
 * @param {QrCallbacks} callbacks
 */
async function pollQr(deps, state, callbacks) {
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
      if (state.qrTimer != null) { clearInterval(state.qrTimer); state.qrTimer = null }
      const messageEl = document.getElementById("qr-message")
      if (messageEl) messageEl.textContent = "轮询失败 — 请关闭重试。"
      callbacks.onCancel?.()
    }
    return
  }
  const rawEl2 = document.getElementById("qr-raw")
  if (rawEl2) rawEl2.textContent = JSON.stringify(result, null, 2)
  const advance = pollAdvance(state, result)
  if (advance.stopTimer && state.qrTimer != null) {
    clearInterval(state.qrTimer)
    state.qrTimer = null
  }
  if (advance.currentBaseUrl !== undefined) state.currentBaseUrl = advance.currentBaseUrl
  if (advance.qrMessage !== undefined) {
    const el = document.getElementById("qr-message"); if (el) el.textContent = advance.qrMessage
  }
  // After confirmed binding, show success badge briefly in the QR box,
  // then let the caller (openQrModal) close the dialog via onConfirmed.
  if (result.status === "confirmed") {
    const box = document.getElementById("qr-box")
    const label = result.scenario === "redundant"   ? "已连接"
                : result.scenario === "reconnect"   ? "已重连"
                : result.scenario === "new_account" ? "已切换"
                :                                     "已绑定"
    if (box) box.innerHTML = `<div style="font-size: 13px; color: var(--green-ink); padding: 24px 12px; text-align: center; line-height: 1.6;">✓<br>${label}<br><span style="font-family: var(--mono); font-size: 11px; color: var(--ink-3);">${escapeHtml(result.accountId || "")}</span></div>`
    const rawToggle = document.getElementById("qr-raw-toggle")
    if (rawToggle) rawToggle.hidden = true
    const raw = document.getElementById("qr-raw")
    if (raw) { raw.classList.remove("show"); raw.hidden = true }
    // Brief pause so the user sees the success badge before the dialog
    // closes. Stored on state so cleanup() can cancel it if the user
    // dismisses the modal in this 800ms window (otherwise the stale
    // onConfirmed fires after close, leaking onBound side-effects).
    state.qrConfirmTimer = setTimeout(() => {
      state.qrConfirmTimer = null
      callbacks.onConfirmed?.()
    }, 800)
  }
}
