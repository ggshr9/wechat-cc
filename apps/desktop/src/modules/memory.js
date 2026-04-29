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
const memoryState = {
  users: [],
  selected: null,
  marked: null,
  editing: false,
  pristine: "",
}

async function loadMarked() {
  if (memoryState.marked) return memoryState.marked
  try {
    const mod = await import("../vendor/marked.js")
    memoryState.marked = mod.marked || mod.default || mod
    return memoryState.marked
  } catch (err) {
    console.warn("local marked load failed, falling back to <pre>", err)
    memoryState.marked = { parse: (s) => `<pre>${escapeHtml(s)}</pre>` }
    return memoryState.marked
  }
}

export async function loadMemoryPane(deps) {
  const result = await deps.invoke("wechat_cli_json", { args: ["memory", "list", "--json"] })
  memoryState.users = Array.isArray(result) ? result : []
  renderMemorySidebar(deps)
  const totalFiles = memoryState.users.reduce((s, u) => s + u.fileCount, 0)
  document.getElementById("memory-meta").textContent = `${memoryState.users.length} 个用户 · ${totalFiles} 文件`
  const navCount = document.getElementById("memory-count")
  if (navCount) navCount.textContent = totalFiles > 0 ? String(totalFiles) : ""
}

function renderMemorySidebar(deps) {
  const sidebar = document.getElementById("memory-sidebar")
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
  sidebar.querySelectorAll(".mem-file").forEach(btn =>
    btn.addEventListener("click", () => openMemoryFile(deps, btn.dataset.user, btn.dataset.path, btn.dataset.mtime))
  )
}

async function openMemoryFile(deps, userId, relPath, mtime) {
  // Bail out cleanly if user clicks a different file mid-edit. We don't
  // discard their text silently — surface the choice.
  if (memoryState.editing) {
    const proceed = window.confirm("当前文件有未保存的修改。切换会丢弃改动，确认继续？")
    if (!proceed) return
    setEditMode(false)
  }
  document.querySelectorAll(".mem-file").forEach(el =>
    el.classList.toggle("active", el.dataset.user === userId && el.dataset.path === relPath)
  )
  const head = document.getElementById("memory-content-head")
  const pathEl = document.getElementById("memory-content-path")
  const mtimeEl = document.getElementById("memory-content-mtime")
  const rendered = document.getElementById("memory-rendered")
  const userNames = deps.doctorPoller.current?.userNames || {}
  const friendly = userNames[userId] || userId.split("@")[0]
  pathEl.textContent = `${friendly} / ${relPath}`
  mtimeEl.textContent = `updated ${formatRelativeTime(mtime)}`
  head.hidden = false
  setStatus(null)
  rendered.innerHTML = `<p class="empty-state">读取中…</p>`
  let result
  try {
    result = await deps.invoke("wechat_cli_json", { args: ["memory", "read", userId, relPath, "--json"] })
  } catch (err) {
    rendered.innerHTML = `<p class="empty-state">读取失败：${escapeHtml(deps.formatInvokeError(err))}</p>`
    return
  }
  if (!result.ok) {
    rendered.innerHTML = `<p class="empty-state">读取失败：${escapeHtml(result.error || "unknown")}</p>`
    return
  }
  const marked = await loadMarked()
  rendered.innerHTML = marked.parse(result.content)
  memoryState.selected = { userId, path: relPath }
  memoryState.pristine = result.content
  // Show the edit button now that there's content to edit.
  const editBtn = document.getElementById("memory-edit-btn")
  if (editBtn) editBtn.hidden = false
}

// Toggle textarea ↔ rendered. `editing=true` swaps in the textarea
// pre-filled with current content; `editing=false` shows the rendered
// markdown. Save/cancel button visibility is gated on `editing`.
function setEditMode(editing) {
  memoryState.editing = editing
  const rendered = document.getElementById("memory-rendered")
  const editor = document.getElementById("memory-editor")
  const editBtn = document.getElementById("memory-edit-btn")
  const saveBtn = document.getElementById("memory-save-btn")
  const cancelBtn = document.getElementById("memory-cancel-btn")
  if (editing) {
    editor.value = memoryState.pristine
    editor.hidden = false
    rendered.hidden = true
    editBtn.hidden = true
    saveBtn.hidden = false
    cancelBtn.hidden = false
    editor.focus()
  } else {
    editor.hidden = true
    rendered.hidden = false
    editBtn.hidden = !memoryState.selected  // keep hidden if nothing open
    saveBtn.hidden = true
    cancelBtn.hidden = true
  }
}

function setStatus(message, tone) {
  const el = document.getElementById("memory-status")
  if (!el) return
  if (!message) { el.hidden = true; return }
  el.hidden = false
  el.textContent = message
  if (tone) el.dataset.tone = tone
}

async function saveCurrent(deps) {
  if (!memoryState.selected || !memoryState.editing) return
  const editor = document.getElementById("memory-editor")
  const content = editor.value
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
  const saveBtn = document.getElementById("memory-save-btn")
  const cancelBtn = document.getElementById("memory-cancel-btn")
  saveBtn.disabled = true
  cancelBtn.disabled = true
  let result
  try {
    result = await deps.invoke("wechat_cli_json", {
      args: ["memory", "write", memoryState.selected.userId, memoryState.selected.path, "--body-base64", bodyB64, "--json"],
    })
  } catch (err) {
    saveBtn.disabled = false
    cancelBtn.disabled = false
    setStatus(`保存失败：${deps.formatInvokeError(err)}`, "bad")
    return
  }
  saveBtn.disabled = false
  cancelBtn.disabled = false
  if (!result.ok) {
    setStatus(`保存失败：${result.error || "unknown"}`, "bad")
    return
  }
  // Re-render the saved content + update pristine baseline + refresh
  // the file list so size/mtime reflect the new state.
  memoryState.pristine = content
  const marked = await loadMarked()
  document.getElementById("memory-rendered").innerHTML = marked.parse(content)
  setEditMode(false)
  setStatus(`已保存 (${result.bytesWritten}B)`, "ok")
  setTimeout(() => setStatus(null), 2500)
  await loadMemoryPane(deps).catch(() => {})
}

// Wire edit/save/cancel buttons. main.js calls this once at boot.
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

function formatBytes(n) {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}k`
  return `${(n / 1024 / 1024).toFixed(1)}M`
}

// Memory pane top zone — Claude's recent observations + milestone cards.
// Loads from CLI: observations list + milestones list. Empty state already
// in HTML (Task 9). Refresh on pane switch + manual button.
export async function loadMemoryTopZone(deps) {
  const chatId = currentChatId(deps)
  if (!chatId) return  // no chat configured yet — leave empty-state visible

  const obsBox = document.getElementById("memory-observations")
  const msBox = document.getElementById("memory-milestones")
  if (!obsBox || !msBox) return

  try {
    const [obsResp, msResp] = await Promise.all([
      deps.invoke("wechat_cli_json", { args: ["observations", "list", chatId, "--json"] }),
      deps.invoke("wechat_cli_json", { args: ["milestones", "list", chatId, "--json"] }),
    ])
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
export async function loadMemoryDecisions(deps) {
  const chatId = currentChatId(deps)
  if (!chatId) return

  const box = document.getElementById("memory-decisions-body")
  if (!box) return

  try {
    const resp = await deps.invoke("wechat_cli_json", {
      args: ["events", "list", chatId, "--json", "--limit", "30"],
    })
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

export async function archiveObservation(deps, obsId) {
  const chatId = currentChatId(deps)
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

// Resolve the chat to query — first bound account from doctor poll. v0.4 is
// single-chat; v0.5 will surface a chat picker.
function currentChatId(deps) {
  const rep = deps.doctorPoller?.current
  return rep?.checks?.accounts?.items?.[0]?.botId ?? null
}
