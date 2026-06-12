// @ts-check
/// <reference lib="dom" />
//
// dialogue-page.js — the "对话" pane, driven by real data.
//
// Replaces the original static designer mockup. Keeps the mockup's visual
// language (the dialogue-* CSS classes, sidebar + stage layout, document-
// style conversation) but every list, message, thread, and search result
// comes from the daemon via CLI JSON commands:
//
//   sessions list-chats        → chat switcher
//   dialogue timeline          → document-style message flow (upward paging)
//   dialogue threads           → facet lenses (任务 / 知识 / 生活)
//   dialogue thread-detail     → per-episode message rendering
//   dialogue search            → in-stage hit list
//   dialogue unlock            → private-thread passphrase gate
//
// Plain JSDoc-typed JS, no framework — same style as sessions.js. The pane
// keeps a little module-scoped state (selected chat, current view, whether
// the user has unlocked private threads this session).

import { escapeHtml } from "../view.js"
import { formatRelativeTimeShort } from "./observations.js"
import { icon } from "./icons.js"

/**
 * @typedef {{ invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> }} Deps
 * @typedef {{ id: string, chatId: string, ts: string, direction: 'in'|'out', kind: string, text: string, provider?: string, source: string }} Message
 * @typedef {{ id: string, chatId: string, title: string, summary: string, facets: string[], tags: string[], private: boolean, status: 'active'|'dormant'|'done', episodes: Array<{from_ts:string,to_ts:string}>, createdTs: string, lastActive: string }} Thread
 * @typedef {{ from_ts: string, to_ts: string, messages: Message[] }} Episode
 * @typedef {'timeline'|'task'|'knowledge'|'life'} ViewId
 */

const TIMELINE_PAGE = 100

// ── module state ───────────────────────────────────────────────────────
/** @type {string|null} */
let selectedChatId = null
/** @type {ViewId} */
let currentView = "timeline"
// Session-scoped: once the user enters the right passphrase we keep private
// threads visible until the pane is re-initialised / app reloads. Never
// persisted — the lock is re-armed every launch.
let unlocked = false
// true once `dialogue unlock` reports no_lock_configured — there's nothing
// to unlock, so the lock affordance is hidden entirely.
let noLockConfigured = false
/** Chat display name keyed by chat_id (from list-chats), for the human author label. @type {Record<string,string>} */
let chatNames = {}
/** Oldest loaded timeline ts — the cursor for upward paging. @type {string|null} */
let oldestLoadedTs = null
/** Whether older timeline pages exist. */
let timelineHasMore = false
/** Guards concurrent upward-page fetches. */
let pagingInFlight = false

const VIEWS = /** @type {Array<{id: ViewId, label: string}>} */ ([
  { id: "timeline", label: "时间线" },
  { id: "task", label: "任务" },
  { id: "knowledge", label: "知识" },
  { id: "life", label: "生活" },
])

const STATUS_LABEL = { active: "进行中", dormant: "搁置", done: "完结" }

// ── small helpers ──────────────────────────────────────────────────────

/** @param {Deps} deps @param {string[]} args */
async function cli(deps, args) {
  return deps.invoke("wechat_cli_json", { args })
}

/** Initial-letter for an avatar bubble. @param {string|null|undefined} name */
function initial(name) {
  const t = String(name || "").trim()
  if (!t) return "?"
  const ch = t.charAt(0)
  return /[a-zA-Z]/.test(ch) ? ch.toUpperCase() : ch
}

/**
 * Human-facing name for the inbound (direction 'in') author of a chat.
 * Falls back to '我' when the chat has no resolved display name.
 * @param {string|null} chatId
 */
function humanName(chatId) {
  if (chatId && chatNames[chatId]) return chatNames[chatId]
  return "我"
}

/**
 * Look up a custom avatar (existence + path) via the daemon. Returns null on
 * any failure so the caller falls back to a letter bubble. Mirrors
 * sessions.js avatarInfo.
 * @param {Deps} deps @param {string} key
 * @returns {Promise<{exists:boolean,path:string}|null>}
 */
async function avatarInfo(deps, key) {
  try {
    const r = /** @type {any} */ (await cli(deps, ["avatar", "info", key, "--json"]))
    if (r && r.ok) return { exists: !!r.exists, path: String(r.path || "") }
    return null
  } catch { return null }
}

/** @param {string} path */
function attachmentUrl(path) {
  return "/attachment?path=" + encodeURIComponent(String(path || ""))
}

/**
 * Render an avatar span — custom image when available, else a coloured
 * initial bubble. Reuses the mockup's dialogue-avatar / dialogue-avatar-*
 * classes so the existing CSS keeps working.
 * @param {{ kind: 'user'|'ai', name: string, src?: string|null }} arg0
 */
function avatarHtml({ kind, name, src }) {
  if (src) {
    return `<span class="dialogue-avatar dialogue-avatar-${kind}"><img src="${escapeHtml(src)}" alt="${escapeHtml(name)}" /></span>`
  }
  return `<span class="dialogue-avatar dialogue-avatar-${kind}">${escapeHtml(initial(name))}</span>`
}

// ── skeleton ───────────────────────────────────────────────────────────

/** @param {HTMLElement} root */
function renderSkeleton(root) {
  root.innerHTML = `
    <aside class="dialogue-sidebar">
      <div id="dialogue-chat-switcher" class="dialogue-chat-switcher"></div>
      <div class="dialogue-search">
        <span class="dialogue-search-icon">${icon("search-01", { size: 16 })}</span>
        <input id="dialogue-search" type="search" placeholder="搜索对话…" autocomplete="off" />
      </div>
      <nav id="dialogue-views" class="dialogue-views">
        ${VIEWS.map(v => `<button class="dialogue-view-btn${v.id === "timeline" ? " is-active" : ""}" data-view="${v.id}">${v.label}</button>`).join("")}
      </nav>
      <div id="dialogue-groups" class="dialogue-groups" hidden></div>
    </aside>
    <section class="dialogue-stage">
      <div class="dialogue-document">
        <div class="dialogue-document-head">
          <button class="dialogue-action-pill" id="dialogue-export" type="button">
            ${icon("download-01", { size: 16 })}<span>导出 Markdown</span>
          </button>
        </div>
        <div id="dialogue-timeline" class="dialogue-scroll"></div>
        <div id="dialogue-thread-detail" class="dialogue-scroll" hidden></div>
      </div>
    </section>
    <div class="privacy-dialog" id="privacy-dialog" hidden>
      <form class="privacy-card">
        <button class="privacy-close" type="button" aria-label="关闭">${icon("cancel-01", { size: 18 })}</button>
        <span class="privacy-lock-mark">${icon("square-lock-01", { size: 20 })}</span>
        <h2>解锁私密内容</h2>
        <p>部分话题包含较私人的内容，输入密码后才能查看。</p>
        <label for="privacy-password">密码</label>
        <input id="privacy-password" type="password" autocomplete="current-password" placeholder="请输入密码" />
        <span class="privacy-error" hidden>密码不正确，请重新输入</span>
        <button class="privacy-submit" type="submit">解锁私密话题</button>
      </form>
    </div>
  `
}

// ── chat switcher ──────────────────────────────────────────────────────

/**
 * Load the chat list (list-chats) into the sidebar switcher and resolve the
 * selected chat (preserved selection, else most-recent). Mirrors sessions.js
 * loadSessionsChats consumption of list-chats.
 * @param {Deps} deps
 * @returns {Promise<boolean>} true when at least one chat exists
 */
async function loadChats(deps) {
  const switcher = document.getElementById("dialogue-chat-switcher")
  /** @type {Array<{chat_id:string,user_name:string|null,session_count:number,last_used_at?:string}>} */
  let chats = []
  try {
    const resp = /** @type {any} */ (await cli(deps, ["sessions", "list-chats", "--json"]))
    chats = (resp && resp.chats) || []
  } catch (err) {
    console.error("dialogue list-chats failed", err)
  }

  chatNames = {}
  for (const c of chats) {
    const name = c.user_name || (c.chat_id === "_legacy" ? "（早期会话）" : (c.chat_id.split("@")[0] ?? c.chat_id))
    chatNames[c.chat_id] = name
  }

  // list-chats is already sorted most-recent-first. Preserve the user's
  // current selection across refreshes; else fall back to the first chat.
  selectedChatId = (selectedChatId && chats.some(c => c.chat_id === selectedChatId))
    ? selectedChatId
    : (chats[0]?.chat_id ?? null)

  if (switcher) {
    if (chats.length <= 1) {
      // One (or zero) chat — no navigation needed, hide the switcher.
      switcher.hidden = true
      switcher.innerHTML = ""
    } else {
      switcher.hidden = false
      switcher.innerHTML = chats.map(c => {
        const active = c.chat_id === selectedChatId ? " is-active" : ""
        return `<button class="dialogue-chat-row${active}" data-chat="${escapeHtml(c.chat_id)}">
          <span class="dialogue-chat-name">${escapeHtml(chatNames[c.chat_id] || c.chat_id)}</span>
          <span class="dialogue-chat-count">${c.session_count}</span>
        </button>`
      }).join("")
    }
  }
  return chats.length > 0
}

// ── timeline ───────────────────────────────────────────────────────────

/**
 * Render a single message as a document-style turn block (reuses the
 * mockup's dialogue-turn markup). command-kind messages render as a muted
 * single-line dialogue-cmd row.
 * @param {Message} m
 * @param {{ userName: string, userAvatar?: string|null, botAvatar?: string|null }} ctx
 */
function messageHtml(m, ctx) {
  if (m.kind === "command") {
    return `<div class="dialogue-cmd" data-msg-id="${escapeHtml(m.id)}">${escapeHtml(m.text)}</div>`
  }
  const isUser = m.direction === "in"
  const name = isUser ? ctx.userName : (botLabel(m))
  const avatar = avatarHtml({
    kind: isUser ? "user" : "ai",
    name,
    src: isUser ? ctx.userAvatar : ctx.botAvatar,
  })
  const author = isUser
    ? `<div class="dialogue-author">${escapeHtml(name)}</div>`
    : `<div class="dialogue-author">${escapeHtml(name)} <span class="dialogue-ai-tag">AI</span></div>`
  const body = m.text
    .split("\n")
    .filter(line => line.length > 0)
    .map(line => `<p>${escapeHtml(line)}</p>`)
    .join("") || "<p></p>"
  return `<div class="dialogue-turn" data-msg-id="${escapeHtml(m.id)}">
    ${avatar}
    <div class="dialogue-turn-body">${author}${body}</div>
  </div>`
}

/** Bot display label — provider-aware. @param {Message} m */
function botLabel(m) {
  if (m.provider === "codex") return "Codex"
  if (m.provider === "cursor") return "Cursor"
  return "Claude"
}

/** @type {Message[]} loaded timeline messages (ascending), kept for export. */
let loadedMessages = []

/**
 * Load the newest timeline page for the selected chat and render it. Scrolls
 * to bottom (newest at bottom).
 * @param {Deps} deps
 * @param {{ beforeTs?: string, highlightId?: string }} [opts]
 */
async function loadTimeline(deps, opts = {}) {
  const stage = document.getElementById("dialogue-timeline")
  if (!stage) return
  showTimelineView()
  if (!selectedChatId) {
    stage.innerHTML = `<p class="empty-state">还没有对话。</p>`
    return
  }
  stage.innerHTML = `<p class="empty-state">加载中…</p>`

  const args = ["dialogue", "timeline", "--chat-id", selectedChatId, "--limit", String(TIMELINE_PAGE), "--json"]
  if (opts.beforeTs) args.push("--before", opts.beforeTs)

  let messages = /** @type {Message[]} */ ([])
  let hasMore = false
  try {
    const resp = /** @type {any} */ (await cli(deps, args))
    messages = (resp && resp.messages) || []
    hasMore = !!(resp && resp.hasMore)
  } catch (err) {
    stage.innerHTML = `<p class="empty-state">读取失败：${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`
    return
  }

  loadedMessages = messages
  oldestLoadedTs = messages.length > 0 ? (messages[0]?.ts ?? null) : null
  timelineHasMore = hasMore

  if (messages.length === 0) {
    stage.innerHTML = `<p class="empty-state">这个对话还没有消息。</p>`
    return
  }

  // Resolve avatars once (bot + the inbound human) — best-effort.
  const userName = humanName(selectedChatId)
  const [userInfo, botInfo] = await Promise.all([
    selectedChatId ? avatarInfo(deps, selectedChatId) : Promise.resolve(null),
    avatarInfo(deps, "claude"),
  ])
  const ctx = {
    userName,
    userAvatar: userInfo?.exists ? `${attachmentUrl(userInfo.path)}&v=${Date.now()}` : null,
    botAvatar: botInfo?.exists ? `${attachmentUrl(botInfo.path)}&v=${Date.now()}` : null,
  }

  stage.innerHTML = messages.map(m => messageHtml(m, ctx)).join("")
  // Newest at bottom — jump there on initial load.
  requestAnimationFrame(() => { stage.scrollTop = stage.scrollHeight })

  if (opts.highlightId) flashHit(stage, opts.highlightId)
  wireUpwardPaging(deps, stage, ctx)
}

/**
 * Wire scroll-near-top upward paging: when the user scrolls within 80px of
 * the top and older pages exist, fetch the prior page and prepend it,
 * preserving the visible scroll position.
 * @param {Deps} deps @param {HTMLElement} stage
 * @param {{ userName: string, userAvatar?: string|null, botAvatar?: string|null }} ctx
 */
function wireUpwardPaging(deps, stage, ctx) {
  if (stage.dataset.pagingWired === "1") return
  stage.dataset.pagingWired = "1"
  stage.addEventListener("scroll", async () => {
    if (stage.scrollTop > 80 || !timelineHasMore || pagingInFlight || !oldestLoadedTs || !selectedChatId) return
    pagingInFlight = true
    const prevHeight = stage.scrollHeight
    try {
      const args = ["dialogue", "timeline", "--chat-id", selectedChatId, "--limit", String(TIMELINE_PAGE), "--before", oldestLoadedTs, "--json"]
      const resp = /** @type {any} */ (await cli(deps, args))
      const older = /** @type {Message[]} */ ((resp && resp.messages) || [])
      timelineHasMore = !!(resp && resp.hasMore)
      if (older.length > 0) {
        oldestLoadedTs = older[0]?.ts ?? oldestLoadedTs
        loadedMessages = [...older, ...loadedMessages]
        stage.insertAdjacentHTML("afterbegin", older.map(m => messageHtml(m, ctx)).join(""))
        // Preserve scroll position so the view doesn't jump.
        requestAnimationFrame(() => { stage.scrollTop = stage.scrollHeight - prevHeight })
      }
    } catch (err) {
      console.error("dialogue upward paging failed", err)
    } finally {
      pagingInFlight = false
    }
  })
}

/** @param {HTMLElement} container @param {string} msgId */
function flashHit(container, msgId) {
  requestAnimationFrame(() => {
    const el = container.querySelector(`[data-msg-id="${cssEscape(msgId)}"]`)
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" })
      el.classList.add("dialogue-hit")
      setTimeout(() => el.classList.remove("dialogue-hit"), 2200)
    }
  })
}

/** Minimal CSS attribute-selector escaping for ids. @param {string} s */
function cssEscape(s) {
  return String(s).replace(/["\\]/g, "\\$&")
}

// ── view switching ─────────────────────────────────────────────────────

function showTimelineView() {
  const timeline = document.getElementById("dialogue-timeline")
  const detail = document.getElementById("dialogue-thread-detail")
  const groups = document.getElementById("dialogue-groups")
  if (timeline) timeline.hidden = false
  if (detail) detail.hidden = true
  if (groups) groups.hidden = true
}

function showThreadDetailView() {
  const timeline = document.getElementById("dialogue-timeline")
  const detail = document.getElementById("dialogue-thread-detail")
  if (timeline) timeline.hidden = true
  if (detail) detail.hidden = false
}

/** @param {ViewId} view */
function setActiveViewButton(view) {
  document.querySelectorAll("#dialogue-views .dialogue-view-btn").forEach(el => {
    const btn = /** @type {HTMLElement} */ (el)
    btn.classList.toggle("is-active", btn.dataset.view === view)
  })
}

/**
 * Switch to a view. timeline → message flow. facet views (task/knowledge/
 * life) → thread cards in #dialogue-groups.
 * @param {Deps} deps @param {ViewId} view
 */
async function switchView(deps, view) {
  currentView = view
  setActiveViewButton(view)
  if (view === "timeline") {
    await loadTimeline(deps)
    return
  }
  await loadThreads(deps, view)
}

// ── facet lenses (thread cards) ────────────────────────────────────────

/**
 * Load threads for a facet into #dialogue-groups as cards. Queries WITHOUT
 * --include-private unless the user has unlocked this session.
 * @param {Deps} deps @param {'task'|'knowledge'|'life'} facet
 */
async function loadThreads(deps, facet) {
  const groups = document.getElementById("dialogue-groups")
  if (!groups) return
  // Facet views show the card list in the sidebar; the stage keeps the
  // timeline area visible (cards open detail there on click).
  groups.hidden = false
  const timeline = document.getElementById("dialogue-timeline")
  const detail = document.getElementById("dialogue-thread-detail")
  if (timeline) timeline.hidden = false
  if (detail) detail.hidden = true

  if (!selectedChatId) {
    groups.innerHTML = `<p class="empty-state">还没有对话。</p>`
    return
  }
  groups.innerHTML = `<p class="empty-state">加载中…</p>`

  const args = ["dialogue", "threads", "--chat-id", selectedChatId, "--facet", facet, "--json"]
  if (unlocked) args.push("--include-private")

  /** @type {Thread[]} */
  let threads = []
  try {
    const resp = /** @type {any} */ (await cli(deps, args))
    threads = (resp && resp.threads) || []
  } catch (err) {
    groups.innerHTML = `<p class="empty-state">读取失败：${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`
    return
  }

  // The lock affordance: shown when there's something private to unlock and
  // we haven't unlocked yet. Hidden entirely when no lock is configured.
  const lockRow = (!unlocked && !noLockConfigured)
    ? `<button class="dialogue-locked-row" data-action="unlock">
        <span>${icon("square-lock-01", { size: 20 })}</span>
        <span>解锁私密话题</span>
      </button>`
    : ""

  if (threads.length === 0) {
    groups.innerHTML = `<section class="dialogue-group"><div class="dialogue-group-items">${
      lockRow || `<p class="empty-state">这个分类下还没有话题。</p>`
    }</div></section>`
    return
  }

  const cards = threads.map(t => threadCardHtml(t)).join("")
  groups.innerHTML = `<section class="dialogue-group"><div class="dialogue-group-items">${cards}${lockRow}</div></section>`
}

/** @param {Thread} t */
function threadCardHtml(t) {
  const hasTags = t.tags && t.tags.length > 0
  const tagsHtml = hasTags
    ? `<span class="dialogue-topic-tags">${t.tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join("")}</span>`
    : ""
  const status = STATUS_LABEL[t.status] || t.status
  const when = t.lastActive ? escapeHtml(formatRelativeTimeShort(t.lastActive)) : ""
  return `<button class="dialogue-topic${hasTags ? " has-tags" : ""}" data-thread="${escapeHtml(t.id)}">
    <span class="dialogue-topic-main">
      <span class="dialogue-topic-title">${escapeHtml(t.title)}</span>
      ${tagsHtml}
    </span>
    <span class="dialogue-progress">${escapeHtml(status)}${when ? ` · ${when}` : ""}</span>
  </button>`
}

/**
 * Open a thread's detail in the stage: summary + per-episode message
 * rendering, plus a "在时间线中查看" button that switches to the timeline
 * anchored at the thread's last episode.
 * @param {Deps} deps @param {string} threadId
 */
async function openThreadDetail(deps, threadId) {
  const detail = document.getElementById("dialogue-thread-detail")
  if (!detail) return
  showThreadDetailView()
  detail.innerHTML = `<p class="empty-state">加载中…</p>`

  /** @type {{ thread: Thread, episodes: Episode[] }|null} */
  let data = null
  try {
    const resp = /** @type {any} */ (await cli(deps, ["dialogue", "thread-detail", threadId, "--json"]))
    if (resp && resp.ok === false) { data = null }
    else data = resp
  } catch (err) {
    detail.innerHTML = `<p class="empty-state">读取失败：${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`
    return
  }
  if (!data || !data.thread) {
    detail.innerHTML = `<p class="empty-state">话题不存在或已删除。</p>`
    return
  }

  const t = data.thread
  const userName = humanName(selectedChatId)
  const [userInfo, botInfo] = await Promise.all([
    selectedChatId ? avatarInfo(deps, selectedChatId) : Promise.resolve(null),
    avatarInfo(deps, "claude"),
  ])
  const ctx = {
    userName,
    userAvatar: userInfo?.exists ? `${attachmentUrl(userInfo.path)}&v=${Date.now()}` : null,
    botAvatar: botInfo?.exists ? `${attachmentUrl(botInfo.path)}&v=${Date.now()}` : null,
  }

  const lastEpisode = data.episodes[data.episodes.length - 1] || null
  const anchorTs = lastEpisode ? lastEpisode.to_ts : ""
  const episodesHtml = data.episodes.map((ep, i) => {
    const body = ep.messages.map(m => messageHtml(m, ctx)).join("") || `<p class="empty-state">（无消息）</p>`
    return `<section class="dialogue-episode">
      <div class="dialogue-episode-head">片段 ${i + 1}</div>
      ${body}
    </section>`
  }).join("")

  const tagsHtml = (t.tags && t.tags.length > 0)
    ? `<span class="dialogue-topic-tags">${t.tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join("")}</span>`
    : ""

  detail.innerHTML = `
    <div class="dialogue-thread-summary">
      <div class="dialogue-thread-title">${escapeHtml(t.title)}</div>
      ${tagsHtml}
      ${t.summary ? `<p class="dialogue-thread-text">${escapeHtml(t.summary)}</p>` : ""}
      <button class="dialogue-action-pill" data-action="anchor-timeline" data-anchor="${escapeHtml(anchorTs)}" type="button">
        ${icon("time-02", { size: 16 })}<span>在时间线中查看</span>
      </button>
    </div>
    ${episodesHtml}
  `
}

// ── privacy unlock ─────────────────────────────────────────────────────

function openPrivacyDialog() {
  const modal = document.getElementById("privacy-dialog")
  if (!modal) return
  modal.hidden = false
  const input = /** @type {HTMLInputElement|null} */ (document.getElementById("privacy-password"))
  if (input) { input.value = ""; setTimeout(() => input.focus(), 0) }
  const err = modal.querySelector(".privacy-error")
  if (err instanceof HTMLElement) err.hidden = true
}

function closePrivacyDialog() {
  const modal = document.getElementById("privacy-dialog")
  if (modal) modal.hidden = true
}

/**
 * Submit the passphrase: call `dialogue unlock`. ok → flip session state,
 * re-query the current facet with --include-private. no_lock_configured →
 * hide the lock affordance entirely.
 * @param {Deps} deps @param {string} passphrase
 */
async function submitUnlock(deps, passphrase) {
  const modal = document.getElementById("privacy-dialog")
  const err = modal?.querySelector(".privacy-error")
  /** @type {{ok:boolean, error?:string}} */
  let result = { ok: false }
  try {
    result = /** @type {any} */ (await cli(deps, ["dialogue", "unlock", "--passphrase", passphrase, "--json"]))
  } catch (e) {
    console.error("dialogue unlock failed", e)
  }
  if (result.ok) {
    unlocked = true
    closePrivacyDialog()
    if (currentView !== "timeline") await loadThreads(deps, /** @type {any} */ (currentView))
    return
  }
  if (result.error === "no_lock_configured") {
    // Nothing to unlock — hide the affordance and just refresh.
    noLockConfigured = true
    closePrivacyDialog()
    if (currentView !== "timeline") await loadThreads(deps, /** @type {any} */ (currentView))
    return
  }
  if (err instanceof HTMLElement) err.hidden = false
  const input = /** @type {HTMLInputElement|null} */ (document.getElementById("privacy-password"))
  if (input) input.select()
}

// ── search ─────────────────────────────────────────────────────────────

/** @type {ReturnType<typeof setTimeout>|null} */
let searchTimer = null

/**
 * Run a search and render hits into the stage. Clicking a hit loads the
 * timeline anchored just after the hit ts with the hit message highlighted.
 * @param {Deps} deps @param {string} query
 */
async function runSearch(deps, query) {
  const trimmed = (query || "").trim()
  const stage = document.getElementById("dialogue-timeline")
  if (!stage) return
  if (trimmed.length < 2) {
    // Empty / too-short — restore the current view.
    if (currentView === "timeline") await loadTimeline(deps)
    else await loadThreads(deps, /** @type {any} */ (currentView))
    return
  }
  if (!selectedChatId) return
  showTimelineView()
  const groups = document.getElementById("dialogue-groups")
  if (groups) groups.hidden = true
  stage.innerHTML = `<p class="empty-state">搜索中…</p>`

  /** @type {Message[]} */
  let hits = []
  try {
    const resp = /** @type {any} */ (await cli(deps, ["dialogue", "search", "--chat-id", selectedChatId, trimmed, "--json"]))
    hits = (resp && resp.hits) || []
  } catch (err) {
    stage.innerHTML = `<p class="empty-state">搜索失败：${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`
    return
  }
  if (hits.length === 0) {
    stage.innerHTML = `<p class="empty-state">没找到「${escapeHtml(trimmed)}」。</p>`
    return
  }
  stage.innerHTML = `<div class="dialogue-search-hits">${hits.map(h => searchHitHtml(h)).join("")}</div>`
}

/** @param {Message} h */
function searchHitHtml(h) {
  const who = h.direction === "in" ? humanName(h.chatId) : botLabel(h)
  const snippet = h.text.length > 140 ? h.text.slice(0, 140) + "…" : h.text
  return `<button class="dialogue-hit-row" data-hit-id="${escapeHtml(h.id)}" data-hit-ts="${escapeHtml(h.ts)}">
    <span class="dialogue-hit-who">${escapeHtml(who)}</span>
    <span class="dialogue-hit-text">${escapeHtml(snippet)}</span>
  </button>`
}

/**
 * Jump from a search hit to the timeline: load the page ending just after
 * the hit ts (so the hit is on-page) and flash it.
 * @param {Deps} deps @param {string} hitId @param {string} hitTs
 */
async function openHit(deps, hitId, hitTs) {
  // --before is exclusive; nudge 1ms past the hit ts so the hit itself
  // is included on the page.
  let beforeTs = hitTs
  const ms = new Date(hitTs).getTime()
  if (Number.isFinite(ms)) beforeTs = new Date(ms + 1).toISOString()
  await loadTimeline(deps, { beforeTs, highlightId: hitId })
}

// ── export ─────────────────────────────────────────────────────────────

/**
 * Build a Markdown transcript from the currently-loaded timeline page(s)
 * and trigger a download (Tauri save_text_file, else blob fallback — same
 * approach as sessions.js exportProjectMarkdown).
 * @param {Deps} deps
 */
async function exportMarkdown(deps) {
  if (!selectedChatId || loadedMessages.length === 0) return
  const name = humanName(selectedChatId)
  const header = `# 对话 — ${name}\n\n`
  const lines = []
  for (const m of loadedMessages) {
    if (m.kind === "command") continue
    if (m.direction === "in") {
      lines.push(m.text.split("\n").map(l => `> ${l}`).join("\n"))
    } else {
      lines.push(`**${botLabel(m)}**：${m.text}`)
    }
  }
  const md = header + lines.join("\n\n") + "\n"
  const filename = `dialogue-${name}.md`
  try {
    if (/** @type {any} */ (window).__TAURI__?.core?.invoke) {
      const path = await deps.invoke("save_text_file", { filename, content: md })
      alert(`已导出：${path}`)
    } else {
      const blob = new Blob([md], { type: "text/markdown" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    }
  } catch (err) {
    console.error("dialogue export failed", err)
    alert(`导出失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

// ── event wiring ───────────────────────────────────────────────────────

/** @param {HTMLElement} root @param {Deps} deps */
function wireEvents(root, deps) {
  // Chat switcher.
  root.querySelector("#dialogue-chat-switcher")?.addEventListener("click", async (ev) => {
    const btn = ev.target instanceof Element ? ev.target.closest("[data-chat]") : null
    if (!(btn instanceof HTMLElement)) return
    const chatId = btn.dataset.chat
    if (!chatId || chatId === selectedChatId) return
    selectedChatId = chatId
    root.querySelectorAll("#dialogue-chat-switcher .dialogue-chat-row").forEach(el => {
      el.classList.toggle("is-active", /** @type {HTMLElement} */ (el).dataset.chat === chatId)
    })
    await switchView(deps, currentView)
  })

  // View nav.
  root.querySelector("#dialogue-views")?.addEventListener("click", (ev) => {
    const btn = ev.target instanceof Element ? ev.target.closest("[data-view]") : null
    if (!(btn instanceof HTMLElement) || !btn.dataset.view) return
    switchView(deps, /** @type {ViewId} */ (btn.dataset.view)).catch(err => console.error("dialogue view switch failed", err))
  })

  // Thread cards + unlock row (in #dialogue-groups).
  root.querySelector("#dialogue-groups")?.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target : null
    if (!target) return
    const unlockBtn = target.closest("[data-action='unlock']")
    if (unlockBtn) { openPrivacyDialog(); return }
    const card = target.closest("[data-thread]")
    if (card instanceof HTMLElement && card.dataset.thread) {
      openThreadDetail(deps, card.dataset.thread).catch(err => console.error("dialogue thread detail failed", err))
    }
  })

  // Thread detail "在时间线中查看" anchor.
  root.querySelector("#dialogue-thread-detail")?.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target : null
    const anchor = target?.closest("[data-action='anchor-timeline']")
    if (!(anchor instanceof HTMLElement)) return
    const ts = anchor.dataset.anchor || ""
    setActiveViewButton("timeline")
    currentView = "timeline"
    const groups = document.getElementById("dialogue-groups")
    if (groups) groups.hidden = true
    const ms = new Date(ts).getTime()
    const beforeTs = Number.isFinite(ms) ? new Date(ms + 1).toISOString() : undefined
    loadTimeline(deps, beforeTs ? { beforeTs } : {}).catch(err => console.error("dialogue anchor failed", err))
  })

  // Search hits (delegated on the timeline container).
  root.querySelector("#dialogue-timeline")?.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target : null
    const hit = target?.closest("[data-hit-id]")
    if (!(hit instanceof HTMLElement)) return
    openHit(deps, hit.dataset.hitId || "", hit.dataset.hitTs || "").catch(err => console.error("dialogue open hit failed", err))
  })

  // Search input — 250ms debounce (mirrors sessions.js wireSearch).
  const searchInput = /** @type {HTMLInputElement|null} */ (root.querySelector("#dialogue-search"))
  searchInput?.addEventListener("input", () => {
    if (searchTimer !== null) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => runSearch(deps, searchInput.value), 250)
  })

  // Export.
  root.querySelector("#dialogue-export")?.addEventListener("click", () => {
    exportMarkdown(deps).catch(err => console.error("dialogue export failed", err))
  })

  // Privacy dialog: close / submit.
  const modal = root.querySelector("#privacy-dialog")
  modal?.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target : null
    if (target?.closest(".privacy-close") || target === modal) closePrivacyDialog()
  })
  root.querySelector(".privacy-card")?.addEventListener("submit", (ev) => {
    ev.preventDefault()
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById("privacy-password"))
    if (!input) return
    submitUnlock(deps, input.value).catch(err => console.error("dialogue unlock failed", err))
  })
}

// ── entry point ────────────────────────────────────────────────────────

/**
 * Initialise the 对话 pane. Idempotent — guarded by root.dataset.ready so
 * re-entry (pane re-switch) doesn't double-wire. On first init it renders
 * the skeleton, wires events, loads the chat list, and shows the timeline.
 * @param {Deps} deps
 */
export function initDialoguePage(deps) {
  const root = document.getElementById("dialogue-root")
  if (!root) return
  if (root.dataset.ready === "true") {
    // Already mounted — just refresh the current view so re-entering the
    // pane picks up new messages.
    loadChats(deps)
      .then(() => switchView(deps, currentView))
      .catch(err => console.error("dialogue refresh failed", err))
    return
  }
  root.dataset.ready = "true"
  renderSkeleton(root)
  wireEvents(root, deps)
  loadChats(deps)
    .then(() => loadTimeline(deps))
    .catch(err => {
      console.error("dialogue init failed", err)
      const stage = document.getElementById("dialogue-timeline")
      if (stage) stage.innerHTML = `<p class="empty-state">加载失败：${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`
    })
}
