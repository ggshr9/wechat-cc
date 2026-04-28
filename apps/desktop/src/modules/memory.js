// Memory pane module. Lists Companion v2 memory files (per-user grouping)
// and renders selected .md files with the vendored `marked` parser.
//
// Owns: #memory-sidebar, #memory-rendered, #memory-meta, #memory-count,
//       #memory-content-head, #memory-content-path, #memory-content-mtime
// Reads userNames from the doctor poller's current report (no fresh fetch).

import { escapeHtml, formatRelativeTime } from "../view.js"

const memoryState = { users: [], selected: null, marked: null }

async function loadMarked() {
  if (memoryState.marked) return memoryState.marked
  // marked is vendored locally at ./vendor/marked.js (no CDN dependency
  // at runtime, so the memory pane works offline + in a packaged app).
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
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}k`
  return `${(n / 1024 / 1024).toFixed(1)}M`
}
