// Pure helpers + render functions for the sessions pane.
//
// Drill-down (open detail), search, favorite/export/delete actions are
// added in Task 15+. This task ships the project list + time grouping
// only; loadSessionsList renders the empty/full list and wires the empty
// state. Refresh handler is wired in main.js.

import { escapeHtml } from "../view.js"
import { formatRelativeTimeShort } from "./observations.js"

const TODAY_MS = 24 * 3600_000
const WEEK_MS = 7 * TODAY_MS
const FAV_STORAGE_KEY = 'wechat-cc:favorite-sessions'

export function groupProjectsByRecency(projects, opts = {}) {
  const skipThresh = opts.skipGroupingThreshold ?? 0
  if (projects.length < skipThresh) {
    return { '全部': [...projects].sort(byRecencyDesc) }
  }
  const buckets = { '今天': [], '7 天内': [], '更早': [] }
  const now = Date.now()
  for (const p of projects) {
    const age = now - new Date(p.last_used_at).getTime()
    if (age < TODAY_MS) buckets['今天'].push(p)
    else if (age < WEEK_MS) buckets['7 天内'].push(p)
    else buckets['更早'].push(p)
  }
  for (const k of Object.keys(buckets)) buckets[k].sort(byRecencyDesc)
  return buckets
}

function byRecencyDesc(a, b) {
  return a.last_used_at < b.last_used_at ? 1 : -1
}

export function projectRow(p, opts = {}) {
  const summaryText = p.summary || '—'
  const summaryClass = p.summary ? 'summary' : 'summary empty'
  const star = opts.isFavorite ? '★' : '☆'
  const favClass = opts.isFavorite ? ' is-favorite' : ''
  return `
    <button class="project-row${favClass}" data-action="open-project" data-alias="${escapeHtml(p.alias)}">
      <span class="star">${star}</span>
      <span class="alias">${escapeHtml(p.alias)}</span>
      <span class="${summaryClass}">${escapeHtml(summaryText)}</span>
      <span class="meta">${escapeHtml(formatRelativeTimeShort(p.last_used_at))}</span>
    </button>
  `
}

export function readFavorites() {
  try {
    return new Set(JSON.parse(localStorage.getItem(FAV_STORAGE_KEY) || '[]'))
  } catch { return new Set() }
}

export function toggleFavorite(alias) {
  const favs = readFavorites()
  if (favs.has(alias)) favs.delete(alias)
  else favs.add(alias)
  localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify([...favs]))
}

export async function loadSessionsList(deps) {
  const body = document.getElementById("sessions-body")
  const empty = document.getElementById("sessions-empty")
  const meta = document.getElementById("sessions-meta")
  if (!body) return

  try {
    const resp = await deps.invoke("wechat_cli_json", { args: ["sessions", "list-projects", "--json"] })
    const projects = resp.projects || []

    if (projects.length === 0) {
      body.innerHTML = ''
      if (empty) {
        empty.style.display = ''
        body.appendChild(empty)
      }
      if (meta) meta.textContent = '—'
      return
    }

    if (empty) empty.style.display = 'none'
    if (meta) meta.textContent = `${projects.length} 个项目`

    const groups = groupProjectsByRecency(projects)
    const favorites = readFavorites()
    body.innerHTML = Object.entries(groups)
      .filter(([_, list]) => list.length > 0)
      .map(([name, list]) => `
        <div class="session-group">
          <div class="session-group-h">${escapeHtml(name)}</div>
          ${list.map(p => projectRow(p, { isFavorite: favorites.has(p.alias) })).join("")}
        </div>
      `).join("")
  } catch (err) {
    body.innerHTML = `<p class="empty-state">读取失败：${escapeHtml(String(err.message || err))}</p>`
  }
}

export async function openProjectDetail(deps, alias) {
  const detail = document.getElementById("sessions-detail")
  const meta = document.getElementById("sessions-detail-meta")
  const jsonlBox = document.getElementById("sessions-jsonl")
  const favBtn = document.getElementById("sessions-favorite")
  if (!detail || !meta || !jsonlBox) return

  detail.dataset.alias = alias
  jsonlBox.innerHTML = `<p class="empty-state">加载中…</p>`
  detail.hidden = false

  try {
    const resp = await deps.invoke("wechat_cli_json", { args: ["sessions", "read-jsonl", alias, "--json"] })
    if (!resp.ok) {
      jsonlBox.innerHTML = `<p class="empty-state">${escapeHtml(resp.error || '读取失败')}</p>`
      meta.textContent = alias
      return
    }
    meta.textContent = `${resp.alias} · ${resp.session_id} · ${resp.turns.length} turns`
    const html = resp.turns.map(turnHtml).join("")
    jsonlBox.innerHTML = html || `<p class="empty-state">这个 session 还没产生消息。</p>`
    if (favBtn) {
      const favs = readFavorites()
      favBtn.textContent = favs.has(alias) ? '★ 已收藏' : '☆ 收藏'
    }
  } catch (err) {
    jsonlBox.innerHTML = `<p class="empty-state">读取失败：${escapeHtml(String(err.message || err))}</p>`
  }
}

export function closeProjectDetail() {
  const detail = document.getElementById("sessions-detail")
  if (detail) detail.hidden = true
}

// Render a single jsonl turn defensively. Claude Agent SDK turns are
// shaped as { type, message: { role, content } }; content can be a string
// (user) or array of {type, text/name} (assistant). Unknown shapes get a
// generic [type] label so the viewer never throws.
function turnHtml(turn) {
  if (turn?.type === 'user' && typeof turn.message?.content === 'string') {
    return `<div class="jsonl-turn" data-role="user">${escapeHtml(turn.message.content)}</div>`
  }
  if (turn?.type === 'assistant' && Array.isArray(turn.message?.content)) {
    return turn.message.content.map(p => {
      if (p.type === 'text') return `<div class="jsonl-turn" data-role="assistant">${escapeHtml(p.text || '')}</div>`
      if (p.type === 'tool_use') return `<div class="jsonl-turn" data-role="tool_use">[tool_use: ${escapeHtml(p.name || '?')}]</div>`
      return ''
    }).join("")
  }
  return `<div class="jsonl-turn" data-role="other">[${escapeHtml(turn?.type || 'unknown')}]</div>`
}

export async function exportProjectMarkdown(deps) {
  const detail = document.getElementById("sessions-detail")
  const alias = detail?.dataset.alias
  if (!alias) return
  try {
    const resp = await deps.invoke("wechat_cli_json", { args: ["sessions", "read-jsonl", alias, "--json"] })
    if (!resp.ok) return
    const md = `# ${alias}\n\nSession: ${resp.session_id}\n\n` +
      resp.turns.map((t, i) => `## Turn ${i + 1}\n\n\`\`\`json\n${JSON.stringify(t, null, 2)}\n\`\`\`\n`).join("\n")

    if (window.__TAURI__?.dialog?.save && window.__TAURI__?.fs?.writeTextFile) {
      const path = await window.__TAURI__.dialog.save({ defaultPath: `${alias}-session.md` })
      if (path) await window.__TAURI__.fs.writeTextFile(path, md)
    } else {
      // Shim/browser fallback: download via blob
      const blob = new Blob([md], { type: 'text/markdown' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${alias}-session.md`
      a.click()
      URL.revokeObjectURL(url)
    }
  } catch (err) {
    console.error("export failed", err)
  }
}

export async function deleteProject(deps) {
  const detail = document.getElementById("sessions-detail")
  const alias = detail?.dataset.alias
  if (!alias) return
  if (!confirm(`真的要删除 ${alias} 的会话记录吗？\n\nsessions.json 条目会被移除（jsonl 文件保留在磁盘上）。`)) return
  try {
    await deps.invoke("wechat_cli_json", { args: ["sessions", "delete", alias, "--json"] })
    closeProjectDetail()
    await loadSessionsList(deps)
  } catch (err) {
    console.error("delete failed", err)
  }
}
