// Update card module. Renders + drives the dashboard's "更新" card:
// `loadUpdateProbe` runs on dashboard entry + when the user clicks
// 检查更新; `applyUpdate` runs on 立即升级 click.
//
// Owns: #update-card, #update-headline, #update-body, #update-meta,
//       #update-check-btn, #update-apply-btn
// Hides the entire card when probe.reason='not_a_git_repo' (compiled-
// bundle mode — desktop users update via re-downloading from Releases).

import { updateProbeLine, updateApplyLine } from "../view.js"

const updateState = { busy: false, lastProbe: null }

function renderUpdateCard(line, opts = {}) {
  const card = document.getElementById("update-card")
  const headline = document.getElementById("update-headline")
  const body = document.getElementById("update-body")
  const meta = document.getElementById("update-meta")
  const checkBtn = document.getElementById("update-check-btn")
  const applyBtn = document.getElementById("update-apply-btn")
  if (!card) return
  if (line.tone === "hide") {
    card.hidden = true
    return
  }
  card.hidden = false
  card.dataset.tone = line.tone
  headline.textContent = line.headline
  body.textContent = line.body
  if (opts.metaText !== undefined) meta.textContent = opts.metaText
  const showApply = !!opts.canApply && !updateState.busy
  applyBtn.hidden = !showApply
  applyBtn.disabled = updateState.busy
  checkBtn.disabled = updateState.busy
}

export async function loadUpdateProbe(deps, opts = {}) {
  if (updateState.busy) return
  updateState.busy = true
  renderUpdateCard({ tone: "info", headline: "检查中…", body: "正在 git fetch + 比对 origin/master" }, { metaText: "检查中…", canApply: false })
  let probe
  try {
    probe = await deps.invoke("wechat_cli_json", { args: ["update", "--check", "--json"] })
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

export async function applyUpdate(deps) {
  if (updateState.busy) return
  updateState.busy = true
  renderUpdateCard({ tone: "info", headline: "升级中…", body: "停服务 → git pull → bun install → 重启服务" }, { metaText: "升级中…", canApply: false })
  deps.setPending("升级中…")
  let result
  try {
    result = await deps.invoke("wechat_cli_json", { args: ["update", "--json"] })
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
