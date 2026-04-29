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
const MODE_STORAGE_KEY = 'wechat-cc:session-detail-mode'

// Detail view 「精简 / 完整」 toggle. 精简 (compact) is the default — extracts
// only the actual user message + Claude's actual reply, hiding all SDK noise
// (attachments, ToolSearch / memory_list / memory_read tool calls, raw JSON
// tool results, system events, the <wechat ...> envelope). 完整 (detailed)
// keeps the verbose dev view (everything turnHtml renders).
function readSessionsDetailMode() {
  try {
    const stored = localStorage.getItem(MODE_STORAGE_KEY)
    return stored === 'detailed' ? 'detailed' : 'compact'
  } catch { return 'compact' }
}

function writeSessionsDetailMode(mode) {
  try { localStorage.setItem(MODE_STORAGE_KEY, mode) } catch { /* fall through */ }
}

function applyModeToToggle(mode) {
  const compactBtn = document.getElementById('sessions-mode-compact')
  const detailedBtn = document.getElementById('sessions-mode-detailed')
  if (compactBtn) compactBtn.classList.toggle('is-active', mode === 'compact')
  if (detailedBtn) detailedBtn.classList.toggle('is-active', mode === 'detailed')
}

/**
 * Extract the user's actual message text from a 'user'-type turn, stripping
 * the wechat-cc-specific <wechat ...>...</wechat> envelope that wraps every
 * inbound. Falls back to raw text content if envelope absent (forward
 * compat). Returns null for non-user turns or when extraction yields empty.
 */
export function extractUserText(turn) {
  if (!turn || turn.type !== 'user') return null
  const content = turn.message?.content
  let raw = ''
  if (typeof content === 'string') raw = content
  else if (Array.isArray(content)) {
    raw = content
      .filter(p => p && p.type === 'text' && typeof p.text === 'string')
      .map(p => p.text)
      .join('\n')
  }
  if (!raw) return null
  // Try to strip the <wechat ...> envelope — wechat-cc wraps every inbound
  // with metadata so the SDK has chat_id / user / msg_type context.
  const m = raw.match(/<wechat\b[^>]*>([\s\S]*?)<\/wechat>/)
  const text = (m ? m[1] : raw).trim()
  return text || null
}

/**
 * Extract Claude's actual reply text(s) from an 'assistant'-type turn.
 * The real reply lives in the input of mcp__wechat__reply tool calls —
 * Claude may call this multiple times in one turn, producing multiple
 * outbound messages.
 *
 * Fallback to text parts only fires when this turn AND the surrounding
 * session never invoked the reply tool. The per-session check matters
 * because after a reply tool call the model often emits a wrap-up text
 * like "已回复。" — not meant for the user, just internal status. Those
 * trailing texts must not become bubbles.
 *
 * Pass `opts.sessionHasReplyTool: true` (compute once via sessionHasReplyTool)
 * to suppress the per-turn text fallback for sessions that use the tool.
 *
 * Returns string[] (one per reply).
 */
export function extractClaudeReplies(turn, opts = {}) {
  if (!turn || turn.type !== 'assistant') return []
  const content = turn.message?.content
  if (!Array.isArray(content)) return []

  const replies = []
  for (const p of content) {
    if (p && p.type === 'tool_use' && typeof p.name === 'string' && /(^|[_/])reply$/.test(p.name)) {
      const t = p.input && typeof p.input.text === 'string' ? p.input.text : ''
      if (t.trim()) replies.push(t.trim())
    }
  }
  if (replies.length > 0) return replies
  if (opts.sessionHasReplyTool) return []

  const fallback = content
    .filter(p => p && p.type === 'text' && typeof p.text === 'string' && p.text.trim())
    .map(p => p.text.trim())
  return fallback
}

/**
 * Extract the WeChat envelope metadata (user, ts, cleaned text) from a
 * user-type turn. Returns null for non-user turns. The envelope is the
 * `<wechat chat_id="..." user="..." ts="...">...</wechat>` wrapper
 * applied by daemon/main.ts to every inbound message before SDK ingest.
 */
export function extractWechatMeta(turn) {
  if (!turn || turn.type !== 'user') return null
  const content = turn.message?.content
  let raw = ''
  if (typeof content === 'string') raw = content
  else if (Array.isArray(content)) {
    raw = content
      .filter(p => p && p.type === 'text' && typeof p.text === 'string')
      .map(p => p.text)
      .join('\n')
  }
  if (!raw) return { user: null, ts: null, text: '' }

  const open = raw.match(/<wechat\b([^>]*)>([\s\S]*?)<\/wechat>/)
  if (!open) return { user: null, ts: null, text: raw.trim() }
  const attrs = open[1] || ''
  const inner = (open[2] || '').trim()
  const userMatch = attrs.match(/\buser="([^"]*)"/)
  const tsMatch = attrs.match(/\bts="([^"]*)"/)
  const tsNum = tsMatch ? Number(tsMatch[1]) : NaN
  return {
    user: userMatch ? userMatch[1] : null,
    ts: Number.isFinite(tsNum) ? tsNum : null,
    text: inner,
  }
}

/**
 * Returns the WeChat contact name for a session — the value of the
 * `user` attribute on the first inbound user-turn envelope. Used by the
 * iPhone-frame title bar so the chat reads as "you and <contact>", not
 * the dev alias / session id.
 */
export function extractSessionContact(turns) {
  if (!Array.isArray(turns)) return null
  for (const t of turns) {
    if (!t || t.type !== 'user') continue
    const meta = extractWechatMeta(t)
    if (meta?.user) return meta.user
  }
  return null
}

/**
 * Default-avatar initial — first non-whitespace char of the name,
 * uppercased for Latin scripts so "alice" → "A". CJK passes through.
 */
export function avatarInitial(name) {
  if (!name) return '?'
  const trimmed = String(name).trim()
  if (!trimmed) return '?'
  const ch = trimmed.charAt(0)
  return /[a-zA-Z]/.test(ch) ? ch.toUpperCase() : ch
}

/**
 * Deterministic muted hsl color from a seed string. Same seed always
 * yields the same color, so a contact's avatar stays consistent across
 * reloads. 35% saturation + 50% lightness keeps it muted (matches
 * WeChat's tone — not loud).
 */
export function avatarColor(seed) {
  const s = String(seed || '?')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
  return `hsl(${h}, 35%, 50%)`
}

/**
 * Returns true if any turn in the session calls the wechat reply tool —
 * used to gate the text-fallback in extractClaudeReplies. Once Claude has
 * the reply tool available, plain-text assistant content is wrap-up
 * status, not user-facing reply.
 */
export function sessionHasReplyTool(turns) {
  if (!Array.isArray(turns)) return false
  for (const t of turns) {
    if (!t || t.type !== 'assistant') continue
    const content = t.message?.content
    if (!Array.isArray(content)) continue
    for (const p of content) {
      if (p && p.type === 'tool_use' && typeof p.name === 'string' && /(^|[_/])reply$/.test(p.name)) {
        return true
      }
    }
  }
  return false
}

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
  // Empty placeholder is just an em-dash — .summary.empty class greys it
  // out via CSS. v0.4.1's summarizer fills this in within ~30s of the next
  // sessions list-projects call (lazy fire-and-forget; refresh again to see).
  const summaryText = p.summary || '—'
  const summaryClass = p.summary ? 'summary' : 'summary empty'
  const star = opts.isFavorite ? '★' : '☆'
  const favClass = opts.isFavorite ? ' is-favorite' : ''
  const aliasAttr = escapeHtml(p.alias)
  const favLabel = opts.isFavorite ? '取消收藏' : '收藏'
  // Row-level click opens detail; star carries its own data-action so the
  // click handler routes by closest('[data-action]') and only the star
  // toggles the favorite. Star clicks don't bubble into detail-open
  // because closest() finds the inner match first.
  return `
    <button class="project-row${favClass}" data-action="open-project" data-alias="${aliasAttr}">
      <span class="star" data-action="toggle-favorite" data-alias="${aliasAttr}" role="button" tabindex="-1" aria-label="${favLabel}">${star}</span>
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
    // so we wrap them in a per-turn container. In compact mode (default),
    // hidden turn types (attachments, internal tool calls, raw tool results,
    // system events) render to '' and are filtered out before mounting.
    const mode = readSessionsDetailMode()
    applyModeToToggle(mode)
    const hasReplyTool = sessionHasReplyTool(resp.turns)
    const renderer = mode === 'detailed'
      ? (turn) => turnHtml(turn)
      : (turn) => turnHtmlCompact(turn, { sessionHasReplyTool: hasReplyTool })
    const innerTurns = resp.turns
      .map((turn, idx) => {
        const inner = renderer(turn)
        return inner ? `<div class="jsonl-turn-group" data-turn-index="${idx}">${inner}</div>` : ''
      })
      .filter(s => s)
      .join("")
    jsonlBox.classList.toggle('is-phone-mode', mode === 'compact' && innerTurns !== '')
    if (innerTurns === '') {
      jsonlBox.innerHTML = `<p class="empty-state">${
        mode === 'compact'
          ? '这个 session 还没产生对话——切到「完整」看到底层细节。'
          : '这个 session 还没产生消息。'
      }</p>`
    } else if (mode === 'compact') {
      const contactName = extractSessionContact(resp.turns) || resp.alias || alias
      jsonlBox.innerHTML = phoneFrameHtml({ contactName, chatContent: innerTurns })
    } else {
      jsonlBox.innerHTML = innerTurns
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

/**
 * Compact-mode renderer — produces WeChat-style chat-bubble markup. Only
 * the actual user message and Claude's actual reply are visible;
 * attachments, tool calls, tool results, system events all return ''.
 * The caller filters empty strings before mounting.
 *
 * Markup layout per row:
 *
 *   .wechat-row.{left|right}[data-role="user"|"assistant"]
 *     .wechat-avatar[.wechat-avatar-cc][style=bg-color]   "G" or "cc"
 *     .wechat-bubble-wrap
 *       .wechat-bubble                                    text
 *
 * Visual replica of iOS WeChat: #EDEDED background, #95EC69 right
 * bubble, #FFFFFF left bubble, 4px corners, tail pointing toward avatar.
 *
 * `opts.sessionHasReplyTool` precomputed once per session — gates the
 * text fallback so wrap-up "已回复。" status isn't rendered.
 */
export function turnHtmlCompact(turn, opts = {}) {
  if (!turn || typeof turn !== 'object') return ''

  if (turn.type === 'user') {
    const meta = extractWechatMeta(turn)
    if (!meta || !meta.text) return ''
    return wechatRow({
      side: 'left',
      role: 'user',
      avatarText: avatarInitial(meta.user),
      avatarColor: avatarColor(meta.user || ''),
      text: meta.text,
    })
  }

  if (turn.type === 'assistant') {
    const replies = extractClaudeReplies(turn, { sessionHasReplyTool: !!opts.sessionHasReplyTool })
    if (replies.length === 0) return ''
    return replies
      .map(r => wechatRow({
        side: 'right',
        role: 'assistant',
        avatarText: 'cc',
        avatarClass: 'wechat-avatar-cc',
        text: r,
      }))
      .join('')
  }

  return ''
}

/**
 * Render the iPhone-shaped frame surrounding the WeChat chat in compact
 * mode. Status bar (static 5:18 + signal/wifi/battery), title bar with
 * contact name, scrollable chat area, disabled input bar — all together
 * make the bubbles feel like they're inside a real iOS WeChat instead
 * of floating in a wide desktop pane.
 */
function phoneFrameHtml({ contactName, chatContent }) {
  const name = contactName ? escapeHtml(contactName) : '—'
  return `
    <div class="phone-frame">
      <div class="phone-screen">
        <div class="phone-island" aria-hidden="true"></div>
        <div class="phone-status">
          <span class="phone-status-time">5:18</span>
          <span class="phone-status-icons">
            <svg viewBox="0 0 17 11" width="17" height="11" fill="currentColor" aria-hidden="true"><rect x="0" y="6" width="3" height="5" rx="0.5"/><rect x="4.5" y="4" width="3" height="7" rx="0.5"/><rect x="9" y="2" width="3" height="9" rx="0.5"/><rect x="13.5" y="0" width="3" height="11" rx="0.5"/></svg>
            <svg viewBox="0 0 16 12" width="16" height="12" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2 5a8.5 8.5 0 0 1 12 0"/><path d="M4.5 7.5a5 5 0 0 1 7 0"/><circle cx="8" cy="10" r="1" fill="currentColor" stroke="none"/></svg>
            <svg viewBox="0 0 24 12" width="24" height="12" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><rect x="0.5" y="0.5" width="20" height="11" rx="2.5"/><rect x="2" y="2" width="17" height="8" rx="1" fill="currentColor"/><rect x="21.5" y="3.5" width="2" height="5" rx="0.6" fill="currentColor"/></svg>
          </span>
        </div>
        <div class="phone-title">
          <span class="phone-title-back" aria-hidden="true">⟨</span>
          <span class="phone-title-name">${name}</span>
          <span class="phone-title-more" aria-hidden="true">⋯</span>
        </div>
        <div class="phone-chat">${chatContent}</div>
        <div class="phone-input">
          <svg class="phone-input-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9 9c.5-.7 1.7-1.4 3-1.4M15 9c-.5-.7-1.7-1.4-3-1.4"/><path d="M8 15c1 1.5 2.5 2 4 2s3-.5 4-2"/></svg>
          <span class="phone-input-field">查看模式</span>
          <svg class="phone-input-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="9" cy="10" r="0.8" fill="currentColor"/><circle cx="15" cy="10" r="0.8" fill="currentColor"/><path d="M9 14c.8 1.2 2 1.8 3 1.8s2.2-.6 3-1.8"/></svg>
          <svg class="phone-input-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
        </div>
      </div>
    </div>
  `
}

function wechatRow({ side, role, avatarText, avatarColor: bg, avatarClass, text }) {
  const avatarStyle = bg ? ` style="background:${escapeHtml(bg)}"` : ''
  const avatarCls = avatarClass ? ` ${escapeHtml(avatarClass)}` : ''
  return `<div class="wechat-row ${side}" data-role="${escapeHtml(role)}">` +
    `<div class="wechat-avatar${avatarCls}"${avatarStyle}>${escapeHtml(avatarText)}</div>` +
    `<div class="wechat-bubble-wrap"><div class="wechat-bubble">${escapeHtml(text)}</div></div>` +
    `</div>`
}

// Toggle handler — called from main.js when the user clicks one of the
// segmented buttons. Persists the choice, then re-renders whatever's
// currently visible: detail (re-fetches jsonl), search results
// (re-renders rows from the existing hits), or just updates the toggle UI.
export function setSessionsDetailMode(deps, mode) {
  writeSessionsDetailMode(mode)
  applyModeToToggle(mode)
  const detail = document.getElementById('sessions-detail')
  const alias = detail?.dataset.alias
  if (alias && !detail?.classList.contains('dismissed')) {
    openProjectDetail(deps, alias)
    return
  }
  const searchInput = document.getElementById('sessions-search')
  if (searchInput?.value && searchInput.value.trim().length >= 2) {
    runSearch(deps, searchInput.value)
  }
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

/**
 * Build markdown export for a session. In `compact` mode (default for users)
 * produces a clean chat transcript — only what the user said and what
 * Claude replied; envelope, tool calls, attachments, and wrap-up status
 * messages are stripped. In `detailed` mode dumps the raw JSON per turn
 * for developer debugging.
 *
 * Pure function so it's unit-testable without DOM / Tauri.
 */
export function buildExportMarkdown(alias, sessionId, turns, mode) {
  const safeAlias = String(alias ?? '')
  const safeSid = String(sessionId ?? '')
  const turnList = Array.isArray(turns) ? turns : []
  const header = `# ${safeAlias}\n\nSession: ${safeSid}\n\n`

  if (mode === 'detailed') {
    if (turnList.length === 0) return header
    return header + turnList
      .map((t, i) => `## Turn ${i + 1}\n\n\`\`\`json\n${JSON.stringify(t, null, 2)}\n\`\`\`\n`)
      .join('\n')
  }

  // Compact: chat-style transcript. Blockquote (>) for user messages,
  // plain paragraph for Claude — keeps copy-paste readable.
  const hasReplyTool = sessionHasReplyTool(turnList)
  const lines = []
  for (const t of turnList) {
    if (!t || typeof t !== 'object') continue
    if (t.type === 'user') {
      const text = extractUserText(t)
      if (text) lines.push(text.split('\n').map(l => `> ${l}`).join('\n'))
    } else if (t.type === 'assistant') {
      const replies = extractClaudeReplies(t, { sessionHasReplyTool: hasReplyTool })
      for (const r of replies) lines.push(r)
    }
  }
  if (lines.length === 0) return header
  return header + lines.join('\n\n') + '\n'
}

export async function exportProjectMarkdown(deps) {
  const detail = document.getElementById("sessions-detail")
  const alias = detail?.dataset.alias
  if (!alias) return
  try {
    const resp = await deps.invoke("wechat_cli_json", { args: ["sessions", "read-jsonl", alias, "--json"] })
    if (!resp.ok) return
    const mode = readSessionsDetailMode()
    const md = buildExportMarkdown(resp.alias ?? alias, resp.session_id, resp.turns, mode)

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

// Auto-refresh tick while sessions pane is active. 30s — slower than logs
// (10s) because sessions list-projects is heavier (reads sessions.json +
// fires lazy summarizer) and last_used_at doesn't change as fast as a tail
// log. main.js stops the tick on pane switch, same as the logs pattern.
let sessionsAutoTimer = null

export function startSessionsAutoRefresh(deps, intervalMs = 30000) {
  if (sessionsAutoTimer) return
  sessionsAutoTimer = setInterval(() => {
    // Skip refresh when the search input has a query — would clobber the
    // user's hits with the unfiltered project list.
    const input = document.getElementById("sessions-search")
    if (input?.value?.trim().length >= 2) return
    // Skip refresh when the drill-down detail is open — the user is reading
    // a transcript, not the list.
    const detail = document.getElementById("sessions-detail")
    if (detail && !detail.classList.contains('dismissed')) return
    loadSessionsList(deps).catch(err => console.error("sessions auto-refresh failed", err))
  }, intervalMs)
}

export function stopSessionsAutoRefresh() {
  if (sessionsAutoTimer) {
    clearInterval(sessionsAutoTimer)
    sessionsAutoTimer = null
  }
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
    await loadSessionsList(deps)
    return
  }
  const body = document.getElementById("sessions-body")
  if (!body) return
  body.innerHTML = `<p class="empty-state">搜索中…</p>`
  try {
    const resp = await deps.invoke("wechat_cli_json", { args: ["sessions", "search", trimmed, "--json"] })
    const hits = resp.hits || []
    const mode = readSessionsDetailMode()
    const rows = hits.map(h => searchHitRow(h, { mode })).filter(s => s)
    if (rows.length === 0) {
      const note = mode === 'compact' && hits.length > 0
        ? `没找到「${escapeHtml(trimmed)}」的对话——切到「完整」可看 ${hits.length} 条底层匹配。`
        : `没找到「${escapeHtml(trimmed)}」。`
      body.innerHTML = `<p class="empty-state">${note}</p>`
      return
    }
    body.innerHTML = rows.join("")
  } catch (err) {
    body.innerHTML = `<p class="empty-state">搜索失败：${escapeHtml(String(err.message || err))}</p>`
  }
}

/**
 * Render one search hit row.
 *
 * `opts.mode === 'compact'` projects the snippet through the same clean
 * lens the detail view uses: user text (envelope stripped) for user
 * turns, reply-tool input (or fallback text) for assistant turns,
 * everything else hidden. This keeps cross-session search readable for
 * non-technical users — without it, snippets are raw JSON substrings
 * (`"type":"text"...`) that look like garbage.
 *
 * Returns '' when the hit's turn projects to nothing in compact mode —
 * the caller filters empty rows so noise-only hits disappear from the
 * results list.
 */
export function searchHitRow(h, opts = {}) {
  const mode = opts.mode === 'compact' ? 'compact' : 'detailed'
  let snippetText = h.snippet ?? ''

  if (mode === 'compact') {
    if (!h.turn || typeof h.turn !== 'object') return ''
    if (h.turn.type === 'user') {
      snippetText = extractUserText(h.turn) || ''
    } else if (h.turn.type === 'assistant') {
      const replies = extractClaudeReplies(h.turn, { sessionHasReplyTool: !!h.session_has_reply_tool })
      snippetText = replies.join(' / ')
    } else {
      return ''
    }
    if (!snippetText) return ''
  }

  return `
    <button class="project-row" data-action="open-project" data-alias="${escapeHtml(h.alias)}" data-turn-index="${escapeHtml(String(h.turn_index))}">
      <span class="star"></span>
      <span class="alias">${escapeHtml(h.alias)}</span>
      <span class="summary">${escapeHtml(snippetText)}</span>
      <span class="meta">turn ${h.turn_index}</span>
    </button>
  `
}
