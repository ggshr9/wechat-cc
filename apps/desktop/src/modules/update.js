// @ts-check
/// <reference lib="dom" />
/** @typedef {import('../../../../src/cli/schema').UpdateCheckOutputT} UpdateCheck */
/** @typedef {import('../../../../src/cli/schema').UpdateApplyOutputT} UpdateApply */
/**
 * @typedef {{ invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>, formatInvokeError: (err: unknown) => string, setPending: (msg: string) => void, doctorPoller: { refresh: () => Promise<unknown> } }} Deps
 */

// Update card module. Renders + drives the dashboard's "更新" card:
// `loadUpdateProbe` runs on dashboard entry + when the user clicks
// 检查更新; `applyUpdate` runs on 立即升级 click.
//
// Owns: #update-card, #update-headline, #update-body, #update-meta,
//       #update-check-btn, #update-apply-btn
// Hides the entire card when probe.reason='not_a_git_repo' (compiled-
// bundle mode — desktop users update via re-downloading from Releases).

import { updateProbeLine, updateApplyLine } from "../view.js"

/** @type {{ busy: boolean, lastProbe: UpdateCheck | null }} */
const updateState = { busy: false, lastProbe: null }

/**
 * @param {{ tone: string, headline: string, body: string }} line
 * @param {{ metaText?: string, canApply?: boolean }} [opts]
 */
function renderUpdateCard(line, opts = {}) {
  const card = document.getElementById("update-card")
  const headline = document.getElementById("update-headline")
  const body = document.getElementById("update-body")
  const meta = document.getElementById("update-meta")
  const checkBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("update-check-btn"))
  const applyBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("update-apply-btn"))
  if (!card) return
  if (line.tone === "hide") {
    card.hidden = true
    return
  }
  card.hidden = false
  card.dataset.tone = line.tone
  if (headline) headline.textContent = line.headline
  if (body) body.textContent = line.body
  if (opts.metaText !== undefined && meta) meta.textContent = opts.metaText
  const showApply = !!opts.canApply && !updateState.busy
  if (applyBtn) { applyBtn.hidden = !showApply; applyBtn.disabled = updateState.busy }
  if (checkBtn) checkBtn.disabled = updateState.busy
}

/**
 * @param {Deps} deps
 * @param {{ afterApply?: boolean }} [opts]
 */
export async function loadUpdateProbe(deps, opts = {}) {
  if (updateState.busy) return
  updateState.busy = true
  renderUpdateCard({ tone: "info", headline: "检查中…", body: "正在 git fetch + 比对 origin/master" }, { metaText: "检查中…", canApply: false })
  let probe
  try {
    probe = /** @type {UpdateCheck} */ (await deps.invoke("wechat_cli_json", { args: ["update", "--check", "--json"] }))
  } catch (err) {
    updateState.busy = false
    renderUpdateCard({ tone: "bad", headline: "检查失败", body: deps.formatInvokeError(err) }, { metaText: "失败", canApply: false })
    return
  }
  updateState.busy = false
  updateState.lastProbe = probe
  const line = updateProbeLine(probe)
  const sha = (probe?.currentCommit || "").slice(0, 7) || "—"
  const canApply = !!(probe?.ok && probe?.updateAvailable && !probe?.dirty && (probe?.aheadOfRemote ?? 0) === 0)
  renderUpdateCard(line, { metaText: `at ${sha}`, canApply })
  if (opts.afterApply) deps.setPending("升级完成 · 已重新检查")
}

/** @param {Deps} deps */
export async function applyUpdate(deps) {
  if (updateState.busy) return
  updateState.busy = true
  renderUpdateCard({ tone: "info", headline: "升级中…", body: "停服务 → git pull → bun install → 重启服务" }, { metaText: "升级中…", canApply: false })
  deps.setPending("升级中…")
  let result
  try {
    result = /** @type {UpdateApply} */ (await deps.invoke("wechat_cli_json", { args: ["update", "--json"] }))
  } catch (err) {
    updateState.busy = false
    renderUpdateCard({ tone: "bad", headline: "升级失败", body: deps.formatInvokeError(err) }, { metaText: "失败", canApply: false })
    deps.setPending(`升级失败：${deps.formatInvokeError(err)}`)
    return
  }
  updateState.busy = false
  const line = updateApplyLine(result)
  renderUpdateCard(line, { metaText: result.ok ? "已完成" : "失败", canApply: false })
  await deps.doctorPoller.refresh().catch(() => {})
  await loadUpdateProbe(deps, { afterApply: true }).catch(() => {})
}
