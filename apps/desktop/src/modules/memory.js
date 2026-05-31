// @ts-check
/// <reference lib="dom" />
/** @typedef {import('../../../../src/cli/schema').MemoryListOutputT} MemoryList */
/** @typedef {import('../../../../src/cli/schema').MemoryReadOutputT} MemoryRead */
/** @typedef {import('../../../../src/cli/schema').MemoryWriteOutputT} MemoryWrite */
/** @typedef {import('../../../../src/cli/schema').ObservationsListOutputT} ObservationsList */
/** @typedef {import('../../../../src/cli/schema').MilestonesListOutputT} MilestonesList */
/** @typedef {import('../../../../src/cli/schema').EventsListOutputT} EventsList */
/**
 * @typedef {{ invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>, formatInvokeError: (err: unknown) => string, doctorPoller: { current: { userNames?: Record<string, string> } | null } }} Deps
 */

// Memory pane module. Lists Companion v2 memory files (per-user grouping),
// renders selected .md files with the vendored `marked` parser, and lets
// the user edit + save them in-place via `wechat-cc memory write`.
//
// Owns: #memory-sidebar, #memory-rendered, #memory-meta, #memory-count,
//       #memory-content-head, #memory-content-path, #memory-content-mtime,
//       #memory-edit-btn, #memory-cancel-btn, #memory-save-btn,
//       #memory-editor (textarea), #memory-status (save feedback)

import { escapeHtml, formatRelativeTime } from "../view.js"
import { observationRow, milestoneCard } from "./observations.js"
import { decisionRow } from "./decisions.js"

// `selected` doubles as the edit-target identity (userId + path) AND the
// "we have a file open" flag for the edit button visibility. `editing`
// flips the textarea/render visibility; `pristine` is the unsaved-content
// snapshot used by the cancel path.
/** @type {{ users: MemoryList, observations: ObservationsList["observations"], milestones: MilestonesList["milestones"], selected: { userId: string, path: string } | null, marked: { parse: (s: string) => string } | null, editing: boolean, pristine: string, dirtySwitchPending: string | null }} */
const memoryState = {
  users: [],
  observations: [],
  milestones: [],
  selected: null,
  marked: null,
  editing: false,
  pristine: "",
  // Dirty-switch two-step: tracks "userId:relPath" of the file the user
  // tried to switch to while editing. Second click on the same file
  // within 3s commits the switch (§1.3 #8 绝不弹窗).
  dirtySwitchPending: null,
}

async function loadMarked() {
  if (memoryState.marked) return memoryState.marked
  try {
    const mod = await import("../vendor/marked.js")
    memoryState.marked = /** @type {{ parse: (s: string) => string }} */ (mod.marked || mod.defaults || mod)
    return memoryState.marked
  } catch (err) {
    console.warn("local marked load failed, falling back to <pre>", err)
    memoryState.marked = { parse: (/** @type {string} */ s) => `<pre>${escapeHtml(s)}</pre>` }
    return memoryState.marked
  }
}

/** @param {Deps} deps */
export async function loadMemoryPane(deps) {
  const result = /** @type {MemoryList} */ (await deps.invoke("wechat_cli_json", { args: ["memory", "list", "--json"] }))
  memoryState.users = Array.isArray(result) ? result : []
  renderMemorySidebar(deps)
  const totalFiles = memoryState.users.reduce((s, u) => s + u.fileCount, 0)
  const metaEl = document.getElementById("memory-meta")
  if (metaEl) metaEl.textContent = `${memoryState.users.length} 个用户 · ${totalFiles} 文件`
  const navCount = document.getElementById("memory-count")
  if (navCount) navCount.textContent = totalFiles > 0 ? String(totalFiles) : ""
  renderMemoryProfileOverview(deps)
}

/** @param {Deps} deps */
function renderMemorySidebar(deps) {
  const sidebar = document.getElementById("memory-sidebar")
  if (!sidebar) return
  const userNames = deps.doctorPoller.current?.userNames || {}
  if (memoryState.users.length === 0) {
    sidebar.innerHTML = `<div class="empty" style="margin: 0; padding: 18px; font-size: 12px;"><div class="h">空</div><div class="sub">memory/ 还没文件——Claude 还没写过笔记。</div></div>`
    return
  }
  sidebar.innerHTML = memoryState.users.map(u => {
    const friendly = userNames[u.userId] || u.userId.split("@")[0]
    return `
      <div class="mem-grp">
        <div class="grp">
          <span>${escapeHtml(friendly)}</span>
          <span class="count">${u.fileCount}</span>
        </div>
        ${u.files.map(f => `
          <button class="mem-file" data-user="${escapeHtml(u.userId)}" data-path="${escapeHtml(f.path)}" data-mtime="${escapeHtml(f.mtime)}">
            <span>${escapeHtml(f.path)}</span>
            <span class="b">${formatBytes(f.size)}</span>
          </button>
        `).join("")}
      </div>
    `
  }).join("")
  sidebar.querySelectorAll(".mem-file").forEach(el => {
    const btn = /** @type {HTMLElement} */ (el)
    btn.addEventListener("click", () => openMemoryFile(deps, btn.dataset.user || "", btn.dataset.path || "", btn.dataset.mtime || ""))
  })
}

/**
 * @param {Deps} deps
 * @param {string} userId
 * @param {string} relPath
 * @param {string} mtime
 */
async function openMemoryFile(deps, userId, relPath, mtime) {
  // Bail out cleanly if user clicks a different file mid-edit. We don't
  // discard their text silently — surface the choice.
  if (memoryState.editing) {
    // Inline two-step instead of native modal (§1.3 #8). Surface the
    // warning via memory-status; user clicks the same file again within
    // 3s to confirm. Closure-scoped flag on memoryState avoids yet
    // another module-level state.
    const target = `${userId}:${relPath}`
    if (memoryState.dirtySwitchPending !== target) {
      memoryState.dirtySwitchPending = target
      setStatus("当前文件有未保存的修改。再点一次切换会丢弃修改。", "info")
      // Auto-clear after 3s.
      setTimeout(() => {
        if (memoryState.dirtySwitchPending === target) {
          memoryState.dirtySwitchPending = null
          setStatus(null)
        }
      }, 3000)
      return
    }
    // Confirmed.
    memoryState.dirtySwitchPending = null
    setEditMode(false)
  }
  document.querySelectorAll(".mem-file").forEach(el => {
    const btn = /** @type {HTMLElement} */ (el)
    el.classList.toggle("active", btn.dataset.user === userId && btn.dataset.path === relPath)
  })
  const head = document.getElementById("memory-content-head")
  const pathEl = document.getElementById("memory-content-path")
  const mtimeEl = document.getElementById("memory-content-mtime")
  const rendered = document.getElementById("memory-rendered")
  const userNames = deps.doctorPoller.current?.userNames || {}
  const friendly = userNames[userId] || userId.split("@")[0]
  if (pathEl) pathEl.textContent = `${friendly} / ${relPath}`
  if (mtimeEl) mtimeEl.textContent = `updated ${formatRelativeTime(mtime)}`
  if (head) head.hidden = false
  setStatus(null)
  if (rendered) rendered.innerHTML = `<p class="empty-state">读取中…</p>`
  let result
  try {
    result = /** @type {MemoryRead} */ (await deps.invoke("wechat_cli_json", { args: ["memory", "read", userId, relPath, "--json"] }))
  } catch (err) {
    if (rendered) rendered.innerHTML = `<p class="empty-state">读取失败：${escapeHtml(deps.formatInvokeError(err))}</p>`
    return
  }
  if (!result.ok) {
    if (rendered) rendered.innerHTML = `<p class="empty-state">读取失败：${escapeHtml(result.error || "unknown")}</p>`
    return
  }
  const marked = await loadMarked()
  if (rendered) rendered.innerHTML = marked.parse(result.content)
  memoryState.selected = { userId, path: relPath }
  memoryState.pristine = result.content
  // Show the edit button now that there's content to edit.
  const editBtn = document.getElementById("memory-edit-btn")
  if (editBtn) editBtn.hidden = false
}

// Toggle textarea ↔ rendered. `editing=true` swaps in the textarea
// pre-filled with current content; `editing=false` shows the rendered
// markdown. Save/cancel button visibility is gated on `editing`.
/** @param {boolean} editing */
function setEditMode(editing) {
  memoryState.editing = editing
  const rendered = document.getElementById("memory-rendered")
  const editor = /** @type {HTMLTextAreaElement | null} */ (document.getElementById("memory-editor"))
  const editBtn = document.getElementById("memory-edit-btn")
  const saveBtn = document.getElementById("memory-save-btn")
  const cancelBtn = document.getElementById("memory-cancel-btn")
  if (editing) {
    if (editor) { editor.value = memoryState.pristine; editor.hidden = false; editor.focus() }
    if (rendered) rendered.hidden = true
    if (editBtn) editBtn.hidden = true
    if (saveBtn) saveBtn.hidden = false
    if (cancelBtn) cancelBtn.hidden = false
  } else {
    if (editor) editor.hidden = true
    if (rendered) rendered.hidden = false
    if (editBtn) editBtn.hidden = !memoryState.selected  // keep hidden if nothing open
    if (saveBtn) saveBtn.hidden = true
    if (cancelBtn) cancelBtn.hidden = true
  }
}

/**
 * @param {string | null} message
 * @param {string} [tone]
 */
function setStatus(message, tone) {
  const el = document.getElementById("memory-status")
  if (!el) return
  if (!message) { el.hidden = true; return }
  el.hidden = false
  el.textContent = message
  if (tone) el.dataset.tone = tone
}

/** @param {Deps} deps */
async function saveCurrent(deps) {
  if (!memoryState.selected || !memoryState.editing) return
  const editor = /** @type {HTMLTextAreaElement | null} */ (document.getElementById("memory-editor"))
  const content = editor ? editor.value : ""
  if (content === memoryState.pristine) {
    setStatus("内容未改动", "info")
    setEditMode(false)
    return
  }
  // Encode for shell-safe arg passing. The btoa(unescape(encodeURIComponent))
  // dance handles UTF-8 chars (btoa alone fails on multibyte).
  let bodyB64
  try {
    bodyB64 = btoa(unescape(encodeURIComponent(content)))
  } catch (err) {
    setStatus(`编码失败：${err}`, "bad")
    return
  }
  setStatus("保存中…", "info")
  const saveBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("memory-save-btn"))
  const cancelBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("memory-cancel-btn"))
  if (saveBtn) saveBtn.disabled = true
  if (cancelBtn) cancelBtn.disabled = true
  let result
  try {
    result = /** @type {MemoryWrite} */ (await deps.invoke("wechat_cli_json", {
      args: ["memory", "write", memoryState.selected.userId, memoryState.selected.path, "--body-base64", bodyB64, "--json"],
    }))
  } catch (err) {
    if (saveBtn) saveBtn.disabled = false
    if (cancelBtn) cancelBtn.disabled = false
    setStatus(`保存失败：${deps.formatInvokeError(err)}`, "bad")
    return
  }
  if (saveBtn) saveBtn.disabled = false
  if (cancelBtn) cancelBtn.disabled = false
  if (!result.ok) {
    setStatus(`保存失败：${result.error || "unknown"}`, "bad")
    return
  }
  // Re-render the saved content + update pristine baseline + refresh
  // the file list so size/mtime reflect the new state.
  memoryState.pristine = content
  const marked = await loadMarked()
  const renderedEl = document.getElementById("memory-rendered")
  if (renderedEl) renderedEl.innerHTML = marked.parse(content)
  setEditMode(false)
  setStatus(`已保存 (${result.bytesWritten}B)`, "ok")
  setTimeout(() => setStatus(null), 2500)
  await loadMemoryPane(deps).catch(() => {})
}

// Wire edit/save/cancel buttons. main.js calls this once at boot.
/** @param {Deps} deps */
export function wireMemoryButtons(deps) {
  document.getElementById("memory-edit-btn")?.addEventListener("click", () => {
    if (!memoryState.selected) return
    setEditMode(true)
    setStatus(null)
  })
  document.getElementById("memory-cancel-btn")?.addEventListener("click", () => {
    setEditMode(false)
    setStatus(null)
  })
  document.getElementById("memory-save-btn")?.addEventListener("click", () => saveCurrent(deps))
}

/** @param {number} n */
function formatBytes(n) {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}k`
  return `${(n / 1024 / 1024).toFixed(1)}M`
}

/** @param {Deps} deps */
function renderMemoryProfileOverview(deps) {
  const root = document.getElementById("memory-profile-content")
  if (!root) return

  const user = memoryState.users[0] || null
  const userNames = deps.doctorPoller.current?.userNames || {}
  const friendly = user ? (userNames[user.userId] || user.userId.split("@")[0] || user.userId) : "你"
  const totalFiles = memoryState.users.reduce((sum, u) => sum + u.fileCount, 0)
  const latestFileMtime = memoryState.users
    .flatMap(u => u.files.map(f => f.mtime))
    .sort()
    .at(-1)
  const latestObservation = memoryState.observations[0]?.ts
  const updatedAt = latestObservation || latestFileMtime
  const profile = buildMemoryProfileModel(friendly, totalFiles, updatedAt)

  root.innerHTML = `
    <div class="memory-artboard" id="memory-artboard">
    <div class="memory-profile-hero">
      <div class="memory-profile-copy">
        <div class="memory-profile-kicker">
          <span class="spark">✦</span>
          <span>${escapeHtml(profile.kicker)}</span>
        </div>
        <h1>${escapeHtml(profile.title)}</h1>
        <p>${escapeHtml(profile.summary)}</p>
        <div class="memory-profile-tags">
          ${profile.tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join("")}
        </div>
      </div>
      <div class="memory-profile-companion" aria-label="人格画像指标">
        <div class="metric-bubble metric-bubble-a">
          <strong>${profile.metrics.expression}%</strong>
          <span>表达欲</span>
        </div>
        <div class="metric-bubble metric-bubble-b">
          <strong>${profile.metrics.safety}%</strong>
          <span>安全感</span>
        </div>
        <div class="memory-avatar-wrap">
          <img src="./assets/memory-companion.png" alt="" />
        </div>
        <div class="metric-bubble metric-bubble-c">
          <strong>${profile.metrics.memory}</strong>
          <span>记忆密度</span>
        </div>
        <div class="metric-bubble metric-bubble-d">
          <strong>${escapeHtml(profile.metrics.companion)}</strong>
          <span>陪伴需求</span>
        </div>
      </div>
    </div>

    <div class="memory-profile-grid">
      <section class="profile-panel profile-panel-tall">
        <h2>长期人格倾向</h2>
        <div class="profile-insight">
          <span class="quote-mark">“</span>
          <div>
            <h3>一句话人格洞察</h3>
            <p>${escapeHtml(profile.insight)}</p>
          </div>
        </div>
        <div class="profile-trait-list">
          ${profile.traits.map(trait => `
            <article class="profile-trait">
              <span class="trait-icon" aria-hidden="true">${trait.icon}</span>
              <div>
                <h3>${escapeHtml(trait.title)}</h3>
                <p>${escapeHtml(trait.body)}</p>
              </div>
            </article>
          `).join("")}
        </div>
      </section>

      <div class="profile-side-stack">
        <section class="profile-panel">
          <h2>互动偏好画像</h2>
          <div class="preference-grid">
            ${profile.preferences.map(item => `
              <article>
                <h3>${escapeHtml(item.title)}</h3>
                <p>${escapeHtml(item.body)}</p>
              </article>
            `).join("")}
          </div>
        </section>

        <section class="profile-panel">
          <h2>AI记住你的事情</h2>
          <div class="memory-snippet-grid">
            ${profile.snippets.map(item => `
              <article>
                <h3>${escapeHtml(item.title)}</h3>
                <p>${escapeHtml(item.body)}</p>
              </article>
            `).join("")}
          </div>
        </section>
      </div>
    </div>
    </div>
  `
  requestAnimationFrame(fitMemoryArtboard)
}

function fitMemoryArtboard() {
  const root = document.getElementById("memory-profile-content")
  const board = document.getElementById("memory-artboard")
  if (!root || !board) return
  const rootRect = root.getBoundingClientRect()
  const boardRect = board.getBoundingClientRect()
  const designWidth = 1680
  const designHeight = 1180
  const scale = Math.min(rootRect.width / designWidth, rootRect.height / designHeight, 1.08)
  board.style.setProperty("--memory-artboard-scale", String(Math.max(0.1, scale)))
  root.style.setProperty("--memory-artboard-scaled-height", `${designHeight * scale}px`)
}

if (typeof window !== "undefined") {
  window.addEventListener("resize", fitMemoryArtboard)
}

/**
 * @param {string} friendly
 * @param {number} totalFiles
 * @param {string | undefined} updatedAt
 */
function buildMemoryProfileModel(friendly, totalFiles, updatedAt) {
  const observations = memoryState.observations.filter(obs => !obs.archived)
  const milestones = memoryState.milestones
  const obsBodies = observations.map(obs => obs.body).filter(Boolean)
  const primaryObservation = obsBodies[0]
  const expression = clamp(58 + observations.length * 7 + totalFiles * 2, 62, 88)
  const safety = clamp(64 + milestones.length * 4 - Math.max(0, observations.length - 4) * 2, 58, 84)
  const memoryLabel = totalFiles > 0 ? `${totalFiles}份` : "生成中"
  const companionLabel = observations.length >= 3 ? "中高" : observations.length >= 1 ? "温和" : "待校准"
  const freshness = updatedAt ? ` · 更新于 ${formatRelativeTime(updatedAt)}` : ""
  const remembered = obsBodies.slice(0, 4)

  return {
    kicker: `数字人格空间 · 实时更新${freshness}`,
    title: `CC眼中的${friendly}`,
    summary: primaryObservation
      ? `这些画像来自最近的长期记忆、观察和里程碑。CC 正在把零散对话整理成可被你检查、修正和继续生长的理解。`
      : `这里会逐步汇总 CC 在长期对话中形成的画像。现在先展示页面结构；有观察、里程碑和记忆文件后会自动替换为真实内容。`,
    tags: deriveProfileTags(observations, totalFiles),
    metrics: {
      expression,
      safety,
      memory: memoryLabel,
      companion: companionLabel,
    },
    insight: primaryObservation || "CC 还在收集足够的对话信号；等你们多聊几轮，这里会变成一句更贴近你的长期洞察。",
    traits: [
      {
        icon: "♡",
        title: "情绪表达",
        body: observations.some(obs => obs.tone === "concern")
          ? "压力和担心会被记录为需要照看的信号，CC 会尽量减少打扰式追问。"
          : "更适合温和、具体、不过度解释的表达方式。",
      },
      {
        icon: "☷",
        title: "社交模式",
        body: "偏好有上下文的深度交流，不喜欢冷启动式寒暄；回复质量比回复频率更重要。",
      },
      {
        icon: "⚭",
        title: "关系模式",
        body: milestones.length > 0
          ? "稳定的互动会被保留下来，CC 会把重要节点变成可回看的长期记忆。"
          : "长期关系里的连续性会在这里积累，先从偏好、项目和最近关注点开始。",
      },
      {
        icon: "♧",
        title: "压力状态",
        body: "压力升高时更需要清晰边界、低噪声提醒，以及能直接进入问题的协助。",
      },
    ],
    preferences: [
      { title: "喜欢", body: "具体、有上下文、能延续前文的回应。复杂事项先整理结构，再推进执行。" },
      { title: "不喜欢", body: "泛泛寒暄、重复确认、没有记住前情的建议。" },
      { title: "需要", body: "在重要项目和长期关系里保持连续性，同时允许你随时修正记忆。" },
      { title: "风险", body: "画像只是辅助理解，不能替代你的真实表达；不确定的推断需要保持可见。" },
    ],
    snippets: remembered.length > 0
      ? remembered.map((body, index) => ({
          title: index === 0 ? "最近观察" : `记忆片段 ${index + 1}`,
          body,
        }))
      : [
          { title: "等待第一批观察", body: "当 Companion 写下 observation 后，这里会显示它记住的具体事情。" },
          { title: "保留可编辑入口", body: "下方的记忆文件仍然可以打开、编辑和保存，方便你纠正 CC 的理解。" },
          { title: "连接项目上下文", body: "项目、偏好和长期目标会逐步汇总到这里，而不是只散落在聊天记录里。" },
          { title: "保持透明", body: "后续接入真实画像生成时，会继续保留来源和修正路径。" },
        ],
  }
}

/**
 * @param {ObservationsList["observations"]} observations
 * @param {number} totalFiles
 */
function deriveProfileTags(observations, totalFiles) {
  const tags = ["长期关系型人格", "重视被记住", "偏好深度交流"]
  if (observations.some(obs => obs.tone === "curious")) tags.unshift("强探索欲")
  if (observations.some(obs => obs.tone === "concern")) tags.unshift("需要低打扰")
  if (observations.some(obs => obs.tone === "proud")) tags.unshift("会被新进展点亮")
  if (totalFiles > 0) tags.push("记忆可编辑")
  return [...new Set(tags)].slice(0, 7)
}

/**
 * @param {number} n
 * @param {number} min
 * @param {number} max
 */
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n))
}

// Memory pane top zone — Claude's recent observations + milestone cards.
// Loads from CLI: observations list + milestones list. Empty state already
// in HTML (Task 9). Refresh on pane switch + manual button.
/** @param {Deps} deps */
export async function loadMemoryTopZone(deps) {
  const chatId = await currentChatId(deps)
  if (!chatId) return  // no chat configured yet — leave empty-state visible

  const obsBox = document.getElementById("memory-observations")
  const msBox = document.getElementById("memory-milestones")
  if (!obsBox || !msBox) return

  try {
    const [obsResp, msResp] = /** @type {[ObservationsList, MilestonesList]} */ (await Promise.all([
      deps.invoke("wechat_cli_json", { args: ["observations", "list", chatId, "--json"] }),
      deps.invoke("wechat_cli_json", { args: ["milestones", "list", chatId, "--json"] }),
    ]))
    const observations = (obsResp.observations || []).slice(0, 3)
    memoryState.observations = obsResp.observations || []
    memoryState.milestones = msResp.milestones || []
    renderMemoryProfileOverview(deps)
    if (observations.length === 0) {
      // Keep design-language §1.3 #5 — empty states have narrative, not "暂无数据"
      obsBox.innerHTML = `<p class="empty-state">Claude 还没注意到什么——这是它的安静日子。</p>`
    } else {
      obsBox.innerHTML = observations.map(observationRow).join("")
    }
    msBox.innerHTML = (msResp.milestones || []).slice(-2).map(milestoneCard).join("")
  } catch (err) {
    console.error("memory top zone load failed", err)
  }
}

// Memory pane bottom — Claude's recent decisions (events.jsonl folded zone).
// Lazy-loaded on first toggle expand to avoid a hot-path read on every pane
// switch.
/** @param {Deps} deps */
export async function loadMemoryDecisions(deps) {
  const chatId = await currentChatId(deps)
  if (!chatId) return

  const box = document.getElementById("memory-decisions-body")
  if (!box) return

  try {
    const resp = /** @type {EventsList} */ (await deps.invoke("wechat_cli_json", {
      args: ["events", "list", chatId, "--json", "--limit", "30"],
    }))
    const events = (resp.events || []).reverse() // newest first
    if (events.length === 0) {
      box.innerHTML = `<p class="empty-state">还没记录到决策。</p>`
    } else {
      box.innerHTML = events.map(decisionRow).join("")
    }
  } catch (err) {
    console.error("memory decisions load failed", err)
  }
}

/**
 * @param {Deps} deps
 * @param {string} obsId
 */
export async function archiveObservation(deps, obsId) {
  const chatId = await currentChatId(deps)
  if (!chatId) return
  try {
    await deps.invoke("wechat_cli_json", {
      args: ["observations", "archive", chatId, obsId, "--json"],
    })
    await loadMemoryTopZone(deps)
  } catch (err) {
    console.error("archive observation failed", err)
  }
}

// Resolve the chat to query — must be in chat_id format (e.g.
// `<hash>@im.wechat`), the same key the daemon uses for memory/<chat_id>/.
// memoryState.users is populated by loadMemoryPane (`memory list --json`)
// and each user.userId is already a chat_id, so reuse it. v0.4 single-chat
// owner assumption: the first user IS the chat. v0.5 surfaces a picker.
//
// Returns Promise<string|null> — best-effort populates memoryState.users
// once if the pane was queried before loadMemoryPane completed.
/**
 * @param {Deps} deps
 * @returns {Promise<string | null>}
 */
async function currentChatId(deps) {
  if (memoryState.users.length === 0) {
    try { await loadMemoryPane(deps) } catch { /* fall through */ }
  }
  return memoryState.users[0]?.userId ?? null
}
