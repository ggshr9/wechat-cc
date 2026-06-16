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
import { icon } from "./icons.js"

// `selected` doubles as the edit-target identity (userId + path) AND the
// "we have a file open" flag for the edit button visibility. `editing`
// flips the textarea/render visibility; `pristine` is the unsaved-content
// snapshot used by the cancel path.
/** @typedef {{ intro: string, projects: Array<{ name: string, summary: string }> }} OverviewModel */
/** @type {{ users: MemoryList, observations: ObservationsList["observations"], milestones: MilestonesList["milestones"], selected: { userId: string, path: string } | null, marked: { parse: (s: string) => string } | null, editing: boolean, pristine: string, dirtySwitchPending: string | null, overview: OverviewModel | null }} */
const memoryState = {
  users: [],
  observations: [],
  milestones: [],
  selected: null,
  marked: null,
  editing: false,
  pristine: "",
  // Parsed `_overview.md` (the synthesized "总体记忆") — drives the artboard's
  // narrative + project map when present. Null until loaded / if absent.
  overview: null,
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
  // NOTE: profile-overview render intentionally lives in loadMemoryTopZone,
  // which runs after observations are loaded. Rendering here too would race:
  // loadMemoryPane + loadMemoryTopZone fire concurrently on pane switch, and a
  // render here paints stale (empty-observations) data that flashes/overwrites
  // the real one. loadMemoryTopZone is the single source of truth for the
  // overview, and it always follows loadMemoryPane (see main.js pane switch +
  // memory-refresh; currentChatId also backfills users first). If this is ever
  // changed so loadMemoryPane runs without loadMemoryTopZone, restore a render
  // here guarded on observations being loaded.
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

// Trigger a fresh synthesis of the admin's local Claude per-project memory
// into the "overview memory" (_overview.md) the bot reads, then reload the
// pane so the regenerated overview surfaces. Slow — one LLM call via the
// admin conversation's provider — so callers should show progress. Throws on
// a structured `ok:false` so the caller can surface the error.
/**
 * @param {Deps} deps
 * @returns {Promise<{ ok?: boolean, error?: string, projectsFound?: number, projectNames?: string[], written?: { bytesWritten: number } }>}
 */
export async function synthesizeMemory(deps) {
  const result = /** @type {{ ok?: boolean, error?: string, projectsFound?: number, projectNames?: string[], written?: { bytesWritten: number } }} */ (
    await deps.invoke("wechat_cli_json", { args: ["memory", "synthesize", "--json"] })
  )
  if (result && result.ok === false) {
    throw new Error(result.error || "synthesize failed")
  }
  // Surface the freshly written _overview.md (and any list changes).
  await loadMemoryPane(deps).catch(() => {})
  await loadMemoryTopZone(deps).catch(() => {})
  return result
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

const OVERVIEW_PATH = "_overview.md"

// Parse the synthesized `_overview.md` into an intro paragraph + project map.
// Lenient by design — the LLM output varies: tolerates `- **name** — summary`,
// `- name — summary`, `- name: summary`, with/without bold/backticks, and
// em-dash / en-dash / hyphen / colon separators.
/** @param {string} md @returns {OverviewModel | null} */
function parseOverview(md) {
  const body = String(md || "").replace(/<!--[\s\S]*?-->/g, "").trim()
  if (!body) return null
  const mapIdx = body.search(/^#{1,4}\s*项目地图/m)
  // Intro = everything before 项目地图, with markdown heading lines (# 总体记忆 /
  // ## 整体理解 …) stripped so the hero shows clean prose, not raw "#".
  const introRaw = mapIdx >= 0 ? body.slice(0, mapIdx) : body
  const intro = introRaw.split("\n").filter(l => !/^\s*#{1,6}\s/.test(l)).join("\n").trim()
  // Project map = bullets BETWEEN 项目地图 and the next heading (e.g. 生活与关系) —
  // otherwise a life-section bullet would be mis-parsed as a project.
  /** @type {Array<{ name: string, summary: string }>} */
  const projects = []
  if (mapIdx >= 0) {
    const after = body.slice(mapIdx).split("\n")
    for (let i = 1; i < after.length; i++) {
      if (/^\s*#{1,6}\s/.test(after[i])) break  // next section heading → stop
      const m = after[i].match(/^\s*[-*]\s+(.+)$/)
      if (!m) continue
      const item = m[1].replace(/\*\*/g, "").replace(/`/g, "").trim()
      // Separator must be spaced (` — `, ` - `) or a colon — otherwise a hyphen
      // INSIDE a project name (e.g. "kawanco-dev") would be mis-split.
      const sep = item.match(/^(.+?)(?:\s+[—–-]\s+|\s*[:：]\s+)(.+)$/)
      if (sep) projects.push({ name: sep[1].trim(), summary: sep[2].trim() })
      else if (item) projects.push({ name: item, summary: "" })
    }
  }
  return { intro, projects }
}

// Load + parse the synthesized overview for `chatId` into memoryState.overview.
// Missing file → overview stays null and the artboard falls back to its prior
// observation-derived model.
/** @param {Deps} deps @param {string} chatId */
async function loadOverview(deps, chatId) {
  try {
    const result = /** @type {MemoryRead} */ (await deps.invoke("wechat_cli_json", { args: ["memory", "read", chatId, OVERVIEW_PATH, "--json"] }))
    memoryState.overview = (result && result.ok && typeof result.content === "string")
      ? parseOverview(result.content)
      : null
  } catch {
    memoryState.overview = null
  }
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
          <strong>${escapeHtml(String(profile.metrics.expression))}%</strong>
          <span>表达欲</span>
        </div>
        <div class="metric-bubble metric-bubble-b">
          <strong>${escapeHtml(String(profile.metrics.safety))}%</strong>
          <span>安全感</span>
        </div>
        <div class="memory-avatar-wrap">
          <img src="./assets/memory-companion.png" alt="" />
        </div>
        <div class="metric-bubble metric-bubble-c">
          <strong>${escapeHtml(profile.metrics.memory)}</strong>
          <span>表达欲</span>
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
              <span class="trait-icon" aria-hidden="true">${icon(trait.icon, { size: 34 })}</span>
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
                <span class="preference-icon" aria-hidden="true">${icon(item.icon, { size: 30 })}</span>
                <h3>${escapeHtml(item.title)}</h3>
                <p>${escapeHtml(item.body)}</p>
              </article>
            `).join("")}
          </div>
        </section>

        <section class="profile-panel">
          <h2>${memoryState.overview && memoryState.overview.projects.length ? "CC 了解的项目" : "CC记住你的事情"}</h2>
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
  const designWidth = 1680
  const designHeight = 1320
  // Keep the profile composition filling the available width. Scaling by
  // height made larger type shrink the entire artboard and left a wide blank
  // strip on the right. Vertical overflow is intentional and scrollable.
  const scale = rootRect.width / designWidth
  const safeScale = Math.max(0.1, scale)
  const sideInset = Math.max(0, (rootRect.width - designWidth * safeScale) / 2)
  board.style.setProperty("--memory-artboard-scale", String(safeScale))
  board.style.setProperty("--memory-artboard-inset", `${sideInset}px`)
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
  const expression = observations.length || totalFiles
    ? clamp(58 + observations.length * 7 + totalFiles * 2, 62, 88)
    : 82
  const safety = milestones.length || observations.length
    ? clamp(64 + milestones.length * 4 - Math.max(0, observations.length - 4) * 2, 58, 84)
    : 65
  const memoryLabel = totalFiles > 0 ? `${totalFiles}份` : "65%"
  const companionLabel = observations.length >= 3 ? "中高" : observations.length >= 1 ? "温和" : "中高"
  const freshness = updatedAt ? ` · 更新于 ${formatRelativeTime(updatedAt)}` : ""
  const remembered = obsBodies.slice(0, 4)

  // When the synthesized overview exists, it IS the real "CC 眼中的你" content
  // (整体理解 + 项目地图). Use it for the hero narrative, insight, tags and the
  // "记住的事情" cards; the observation/placeholder model is the fallback.
  const ov = memoryState.overview
  const ovIntro = ov && ov.intro ? ov.intro.trim() : ""
  const ovProjects = ov ? ov.projects.filter(p => p.name) : []
  const ovInsight = ovIntro ? ((ovIntro.split(/(?<=[。！？!?])/)[0] || ovIntro).trim()) : ""

  return {
    kicker: ovIntro ? `本机记忆整理·CC 眼中的你${freshness}` : `数字人格空间·实时更新${freshness}`,
    title: `CC眼中的${friendly}`,
    summary: ovIntro || (primaryObservation
      ? `这些画像来自最近的长期记忆、观察和里程碑。CC 正在把零散对话整理成可被你检查、修正和继续生长的理解。`
      : `你是一个情绪细腻、长期主义、喜欢真实连接的人。\n你会被新世界点亮，也会在关系没有回应时反复确认自己的位置。`),
    tags: ovProjects.length ? ovProjects.map(p => p.name).slice(0, 7) : deriveProfileTags(observations, totalFiles),
    metrics: {
      expression,
      safety,
      memory: memoryLabel,
      companion: companionLabel,
    },
    insight: ovInsight || primaryObservation || `你正在从“设计执行者”过渡到“AI产品参与者”。你的优势不是一开始就懂技术，而是你愿意把不懂的东西拆开、追问、理解，并最终转化成可视化和产品表达。`,
    traits: [
      {
        icon: "heart-check",
        title: "情绪表达",
        body: observations.some(obs => obs.tone === "concern")
          ? "压力和担心会被记录为需要照看的信号，CC 会尽量减少打扰式追问。"
          : "低爆发，高内耗。更习惯用温和表达承载复杂感受。",
      },
      {
        icon: "user-group",
        title: "社交模式",
        body: "喜欢深度交流，不喜欢敷衍式寒暄，对回应质量敏感。",
      },
      {
        icon: "link-03",
        title: "关系模式",
        body: milestones.length > 0
          ? "稳定的互动会被保留下来，CC 会把重要节点变成可回看的长期记忆。"
          : "重视长期稳定的连接，会通过细节判断对方是否在意自己。",
      },
      {
        icon: "alert-02",
        title: "压力状态",
        body: "压力升高时会减少表达，同时会去确认自己的价值。",
      },
    ],
    preferences: [
      { icon: "heart-check", title: "喜欢", body: "更习惯用温和表达承载复杂感受，对内在原则比较坚持。" },
      { icon: "cancel-01", title: "不喜欢", body: "喜欢深度交流，不喜欢敷衍式寒暄，对回应质量敏感。" },
      { icon: "link-03", title: "需要", body: "重视长期稳定的连接，不喜欢泛泛之交，比较重视友谊。" },
      { icon: "alert-02", title: "风险", body: "压力升高时会减少表达，同时会去确认自己的价值。" },
    ],
    snippets: ovProjects.length > 0
      ? ovProjects.map(p => ({ title: p.name, body: p.summary || "——" }))
      : remembered.length > 0
      ? remembered.map((body, index) => ({
          title: index === 0 ? "最近观察" : `记忆片段 ${index + 1}`,
          body,
        }))
      : [
          { title: "你最近正在研究AI陪伴产品", body: `你关注的不只是功能，而是“AI怎么长期认识一个人”。` },
          { title: "你在参与wechat-cc项目", body: "你正在从UI设计切入，逐渐理解工程、产品和AI系统。" },
          { title: "你喜欢自然、低打扰的主动联系", body: "你希望对方记得你，但不希望这种联系变成任务提醒。" },
          { title: "你会被新世界点亮", body: "当你发现AI、工程、产品的新概念时，会有明显的兴奋和表达欲。" },
        ],
  }
}

/**
 * @param {ObservationsList["observations"]} observations
 * @param {number} totalFiles
 */
function deriveProfileTags(observations, totalFiles) {
  if (observations.length === 0 && totalFiles === 0) {
    return ["温柔型表达者", "高敏感观察者", "长期关系型人格", "低攻击性", "重视被记住", "强探索欲"]
  }
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
    // Pull the synthesized overview so the artboard shows real content (not
    // the placeholder model) when it exists.
    await loadOverview(deps, chatId)
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

// Read-only view of the admin's local Claude per-project memory — the raw
// source the synthesized overview is distilled from. Lazy-loaded on first
// fold expand. Content comes inline from `memory projects --json` (the dirs
// are local + small), so no per-file read round-trips. No editing here: this
// memory belongs to Claude Code, not wechat-cc.
/** @param {Deps} deps */
export async function loadProjectMemory(deps) {
  const box = document.getElementById("memory-projects")
  if (!box) return
  box.innerHTML = `<p class="empty-state">读取本机项目记忆中…</p>`
  let resp
  try {
    resp = /** @type {{ ok?: boolean, projects?: Array<{ name: string, index: string | null, files: Array<{ path: string, content: string }> }> }} */ (
      await deps.invoke("wechat_cli_json", { args: ["memory", "projects", "--json"] })
    )
  } catch (err) {
    box.innerHTML = `<p class="empty-state">读取失败：${escapeHtml(deps.formatInvokeError(err))}</p>`
    return
  }
  const projects = (resp && resp.projects) || []
  if (projects.length === 0) {
    box.innerHTML = `<p class="empty-state">本机 ~/.claude/projects 下还没有项目记忆。</p>`
    return
  }
  const marked = await loadMarked()
  box.innerHTML = projects.map(p => {
    /** @type {Array<{ path: string, content: string }>} */
    const files = []
    if (p.index) files.push({ path: "MEMORY.md", content: p.index })
    for (const f of p.files) files.push({ path: f.path, content: f.content })
    return `
      <div class="mem-proj-grp">
        <div class="mem-proj-head"><span>${escapeHtml(p.name)}</span><span class="count">${files.length}</span></div>
        ${files.map(f => `
          <details class="mem-proj-file">
            <summary>${escapeHtml(f.path)}</summary>
            <div class="mem-proj-rendered">${marked.parse(f.content || "")}</div>
          </details>
        `).join("")}
      </div>
    `
  }).join("")
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
