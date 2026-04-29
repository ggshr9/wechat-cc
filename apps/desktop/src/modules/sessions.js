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
  // 1-line LLM summary is deferred to v0.4.1 — helpers exist, no production
  // caller. Until then the placeholder is honest about why this is empty.
  const summaryText = p.summary || '(总结待 v0.4.1 上线)'
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

export async function openProjectDetail(deps, alias, opts = {}) {
  const { focusTurn = null } = opts
  const detail = document.getElementById("sessions-detail")
  const meta = document.getElementById("sessions-detail-meta")
  const jsonlBox = document.getElementById("sessions-jsonl")
  const favBtn = document.getElementById("sessions-favorite")
  if (!detail || !meta || !jsonlBox) return

  detail.dataset.alias = alias
  jsonlBox.innerHTML = `<p class="empty-state">加载中…</p>`
  detail.classList.remove('dismissed')
  detail.setAttribute('aria-hidden', 'false')

  try {
    const resp = await deps.invoke("wechat_cli_json", { args: ["sessions", "read-jsonl", alias, "--json"] })
    if (!resp.ok) {
      jsonlBox.innerHTML = `<p class="empty-state">${escapeHtml(resp.error || '读取失败')}</p>`
      meta.textContent = alias
      return
    }
    meta.textContent = `${resp.alias} · ${resp.session_id} · ${resp.turns.length} turns`
    // Render turns and tag each with data-turn-index so the focus scroll
    // can find the matching one. We tag the OUTER wrapper at the original
    // turn level — assistant turns expand into multiple .jsonl-turn divs,
    // so we wrap them in a per-turn container.
    const html = resp.turns.map((turn, idx) => `
      <div class="jsonl-turn-group" data-turn-index="${idx}">
        ${turnHtml(turn)}
      </div>
    `).join("")
    jsonlBox.innerHTML = html || `<p class="empty-state">这个 session 还没产生消息。</p>`
    if (favBtn) {
      const favs = readFavorites()
      favBtn.textContent = favs.has(alias) ? '★ 已收藏' : '☆ 收藏'
    }

    // Scroll to and highlight the focused turn (search drill-down).
    if (focusTurn !== null && focusTurn !== undefined) {
      // Wait one tick for layout to settle before scrollIntoView.
      requestAnimationFrame(() => {
        const target = jsonlBox.querySelector(`[data-turn-index="${focusTurn}"]`)
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' })
          target.classList.add('is-search-hit')
          // Pulse the highlight off after 2s — long enough for the user to
          // notice, short enough to not nag.
          setTimeout(() => target.classList.remove('is-search-hit'), 2000)
        }
      })
    }
  } catch (err) {
    jsonlBox.innerHTML = `<p class="empty-state">读取失败：${escapeHtml(String(err.message || err))}</p>`
  }
}

export function closeProjectDetail() {
  const detail = document.getElementById("sessions-detail")
  if (detail) {
    detail.classList.add('dismissed')
    detail.setAttribute('aria-hidden', 'true')
  }
}

// Render a single jsonl turn defensively. Real Claude Agent SDK jsonls
// (observed via head ~/.claude/projects/.../<session>.jsonl) carry user
// content as an array of {type:'text', text}, and assistant content as an
// array including {type:'thinking'} / {type:'text'} / {type:'tool_use'}.
// Older string-content shapes are tolerated for forward compat. Other
// SDK turn types we know about: queue-operation, last-prompt (silent),
// attachment, tool_result, system. Unknown shapes fall through to a
// compact [type] label so the viewer never throws.
export function turnHtml(turn) {
  if (!turn || typeof turn !== 'object') return ''

  // Skip silent SDK lifecycle events that don't carry user-visible content.
  if (turn.type === 'queue-operation' || turn.type === 'last-prompt') {
    return ''
  }

  // user/assistant: extract text from message.content (always array in real
  // jsonls; tolerate string for forward compat).
  if (turn.type === 'user' || turn.type === 'assistant') {
    const role = turn.type
    const content = turn.message?.content
    if (typeof content === 'string') {
      return `<div class="jsonl-turn" data-role="${role}">${escapeHtml(content)}</div>`
    }
    if (Array.isArray(content)) {
      return content.map(p => renderPart(p, role)).filter(s => s).join("")
    }
    return ''
  }

  // Attachment: render compact label with file name if present.
  if (turn.type === 'attachment') {
    const att = turn.attachment || {}
    const name = att.path || att.name || 'attachment'
    return `<div class="jsonl-turn" data-role="attachment">📎 ${escapeHtml(name)}</div>`
  }

  // tool_result: render body if present, else label.
  if (turn.type === 'tool_result') {
    const body = typeof turn.content === 'string' ? turn.content : JSON.stringify(turn.content || '').slice(0, 300)
    return `<div class="jsonl-turn" data-role="tool_result">↳ ${escapeHtml(body)}</div>`
  }

  // Fallback: compact type label so unknown SDK shapes don't break the view.
  return `<div class="jsonl-turn" data-role="other">[${escapeHtml(turn.type || 'unknown')}]</div>`
}

function renderPart(part, role) {
  if (!part || typeof part !== 'object') return ''
  if (part.type === 'text') {
    const text = part.text || ''
    if (!text.trim()) return ''
    return `<div class="jsonl-turn" data-role="${role}">${escapeHtml(text)}</div>`
  }
  if (part.type === 'thinking') {
    const thinking = part.thinking || ''
    if (!thinking.trim()) return ''
    // Thinking gets its own visual treatment — italics + muted to hint
    // that this is internal reasoning, not user-facing assistant output.
    return `<div class="jsonl-turn" data-role="thinking"><em>${escapeHtml(thinking)}</em></div>`
  }
  if (part.type === 'tool_use') {
    const name = part.name || '?'
    return `<div class="jsonl-turn" data-role="tool_use">⚙ ${escapeHtml(name)}</div>`
  }
  if (part.type === 'tool_result') {
    const body = typeof part.content === 'string' ? part.content
      : Array.isArray(part.content) ? part.content.map(c => c.text || '').filter(Boolean).join('\n')
      : JSON.stringify(part.content || '').slice(0, 300)
    return `<div class="jsonl-turn" data-role="tool_result">↳ ${escapeHtml(body)}</div>`
  }
  return ''
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

// Two-step inline confirm state (§1.3 #8 绝不弹窗). First click on the
// delete button arms; second click within 3s commits. Module-scoped so
// re-rendering the detail pane doesn't lose the armed state.
let pendingDeleteAlias = null
let pendingDeleteTimer = null

export async function deleteProject(deps) {
  const detail = document.getElementById("sessions-detail")
  const alias = detail?.dataset.alias
  if (!alias) return
  const btn = document.getElementById("sessions-delete")
  if (!btn) return

  // Two-step inline confirm: first click arms the delete (button text
  // changes + 3s revert timer); second click within 3s commits.
  if (pendingDeleteAlias === alias) {
    // Confirm: actually delete.
    clearTimeout(pendingDeleteTimer)
    pendingDeleteAlias = null
    pendingDeleteTimer = null
    btn.textContent = '删除'
    btn.classList.remove('is-confirming')
    try {
      await deps.invoke("wechat_cli_json", { args: ["sessions", "delete", alias, "--json"] })
      closeProjectDetail()
      await loadSessionsList(deps)
    } catch (err) {
      console.error("delete failed", err)
    }
    return
  }
  // Arm: change button copy, set 3s revert.
  pendingDeleteAlias = alias
  btn.textContent = '再点确认删除'
  btn.classList.add('is-confirming')
  pendingDeleteTimer = setTimeout(() => {
    pendingDeleteAlias = null
    pendingDeleteTimer = null
    btn.textContent = '删除'
    btn.classList.remove('is-confirming')
  }, 3000)
}

let searchTimer = null

export function wireSearch(deps) {
  const input = document.getElementById("sessions-search")
  if (!input) return
  input.addEventListener("input", () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => runSearch(deps, input.value), 250)
  })
}

async function runSearch(deps, query) {
  const trimmed = (query || '').trim()
  if (trimmed.length < 2) {
    // Empty/short query → restore the project list
    await loadSessionsList(deps)
    return
  }
  const body = document.getElementById("sessions-body")
  if (!body) return
  body.innerHTML = `<p class="empty-state">搜索中…</p>`
  try {
    const resp = await deps.invoke("wechat_cli_json", { args: ["sessions", "search", trimmed, "--json"] })
    const hits = resp.hits || []
    if (hits.length === 0) {
      body.innerHTML = `<p class="empty-state">没找到「${escapeHtml(trimmed)}」。</p>`
      return
    }
    body.innerHTML = hits.map(searchHitRow).join("")
  } catch (err) {
    body.innerHTML = `<p class="empty-state">搜索失败：${escapeHtml(String(err.message || err))}</p>`
  }
}

export function searchHitRow(h) {
  return `
    <button class="project-row" data-action="open-project" data-alias="${escapeHtml(h.alias)}" data-turn-index="${escapeHtml(String(h.turn_index))}">
      <span class="star"></span>
      <span class="alias">${escapeHtml(h.alias)}</span>
      <span class="summary">${escapeHtml(h.snippet)}</span>
      <span class="meta">turn ${h.turn_index}</span>
    </button>
  `
}
