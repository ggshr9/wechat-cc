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
/** @type {{ users: MemoryList, selected: { userId: string, path: string } | null, marked: { parse: (s: string) => string } | null, editing: boolean, pristine: string, dirtySwitchPending: string | null }} */
const memoryState = {
  users: [],
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
