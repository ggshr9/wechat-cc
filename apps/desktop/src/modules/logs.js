// Logs pane module. Tails the daemon's channel.log via `wechat-cc logs
// --tail N --json`, renders one row per entry, and refreshes on user
// click + on a slow background tick (10s — log lines change less often
// than doctor state, and reading the whole file each tick is wasteful).
//
// Owns: #logs-body, #logs-meta, #logs-tail-select, #logs-refresh,
//       #logs-count
// Tag classification (info/warn/error) is heuristic — daemon log tags
// are free-form so we pattern-match well-known shapes; unknown tags
// render in the neutral default color.

import { escapeHtml } from "../view.js"

const TAG_TONES = {
  // error-tone: things that imply something broke
  ERROR: "error", FATAL: "error", PANIC: "error",
  CRASH: "error", FAIL: "error",
  // warn-tone: needs attention but not broken
  SESSION_EXPIRED: "warn", STREAM_DROP: "warn",
  POLL_ERROR: "warn", TIMEOUT: "warn",
  // info-tone: green-path lifecycle
  SESSION_INIT: "info", SESSION_RESUME: "info",
  POLL: "info", BOOT: "info", READY: "info",
}

function tagToneClass(tag) {
  const upper = String(tag || "").toUpperCase()
  if (TAG_TONES[upper]) return `tag-${TAG_TONES[upper]}`
  // Heuristic for tags we haven't enumerated: any tag containing FAIL,
  // ERROR, PANIC → error; EXPIRED, DROP, TIMEOUT → warn.
  if (/FAIL|ERROR|PANIC|CRASH/.test(upper)) return "tag-error"
  if (/EXPIRED|DROP|TIMEOUT|RETRY/.test(upper)) return "tag-warn"
  return ""
}

function formatLocalTime(iso) {
  if (!iso) return ""
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const d = new Date(t)
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
}

function renderRows(entries) {
  if (!entries.length) return `<p class="empty-state">没有日志（daemon 还没产生事件）。</p>`
  return entries.map(e => {
    const isCont = !e.tag && !e.timestamp
    const cls = isCont ? "logs-row continuation" : "logs-row"
    const ts = e.timestamp ? formatLocalTime(e.timestamp) : ""
    const tag = e.tag || ""
    const tagClass = tagToneClass(e.tag)
    return `
      <div class="${cls}">
        <span class="ts">${escapeHtml(ts)}</span>
        <span class="tag ${tagClass}">${escapeHtml(tag)}</span>
        <span class="msg">${escapeHtml(e.message)}</span>
      </div>
    `
  }).join("")
}

let logsState = { lastResult: null, busy: false, autoTimer: null }

export async function loadLogsPane(deps) {
  if (logsState.busy) return
  logsState.busy = true
  const select = document.getElementById("logs-tail-select")
  const tail = Number.parseInt(select?.value || "50", 10) || 50
  const body = document.getElementById("logs-body")
  body.innerHTML = `<p class="empty-state">加载中…</p>`
  let result
  try {
    result = await deps.invoke("wechat_cli_json", { args: ["logs", "--tail", String(tail), "--json"] })
  } catch (err) {
    logsState.busy = false
    body.innerHTML = `<p class="empty-state">读取失败：${escapeHtml(deps.formatInvokeError(err))}</p>`
    return
  }
  logsState.busy = false
  if (!result.ok) {
    body.innerHTML = `<p class="empty-state">读取失败：${escapeHtml(result.error || "unknown")}</p>`
    return
  }
  logsState.lastResult = result
  body.innerHTML = renderRows(result.entries)
  // Scroll to bottom — user expects to see the most recent entry without
  // reaching for the scrollbar. Skip if user scrolled up manually within
  // the last refresh (we don't track that yet; revisit if it gets noisy).
  body.scrollTop = body.scrollHeight
  document.getElementById("logs-meta").textContent =
    `${result.entries.length}/${result.totalLines} 行 · ${result.logFile.split("/").pop()}`
  const navCount = document.getElementById("logs-count")
  if (navCount) navCount.textContent = result.entries.length > 0 ? String(result.entries.length) : ""
}

// Start a 10s auto-refresh tick while the logs pane is the active one.
// stopLogsAutoRefresh stops it. main.js wires these to switchPane.
export function startLogsAutoRefresh(deps, intervalMs = 10000) {
  if (logsState.autoTimer) return
  logsState.autoTimer = setInterval(() => loadLogsPane(deps), intervalMs)
}

export function stopLogsAutoRefresh() {
  if (logsState.autoTimer) {
    clearInterval(logsState.autoTimer)
    logsState.autoTimer = null
  }
}
