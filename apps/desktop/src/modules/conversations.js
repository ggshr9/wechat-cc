// Conversations module — RFC 03 P5.2 mode display + programmatic switch.
// Owns the dashboard's per-chat mode table (#conversations-body,
// #conversations-meta). Mode can now be flipped from the console via
// the dropdown — fires `mode set <chatId> <shorthand> --json` through
// the same coordinator.setMode path that /cc /codex use, plus a wechat
// reply "🎛 已切换到 X（来自控制台）".
//
// Rendering is driven by a periodic `wechat-cc conversations list --json`
// poll (10s tick). Dropdown onChange fires immediately; poller picks up the
// new persisted mode on next tick.

import { conversationRows, escapeHtml } from "../view.js"

// Map badge.tone → the closest shorthand for pre-selecting the dropdown.
// parallel → both, primary_tool → primary (no clean shorthand, use cc as fallback).
function modeToShorthand(mode) {
  if (!mode || typeof mode !== "object") return "cc"
  if (mode.kind === "solo") return mode.provider === "codex" ? "codex" : "cc"
  if (mode.kind === "parallel") return "both"
  if (mode.kind === "chatroom") return "chat"
  if (mode.kind === "primary_tool") return mode.primary === "codex" ? "codex" : "cc"
  return "cc"
}

// Truncate long opaque ids (wxid_xxxx, gh_xxxx) so the table stays scannable.
// Full value is preserved in `title` attributes for hover-to-reveal.
function truncate(s, n) {
  if (!s) return ""
  return s.length > n ? `${s.slice(0, n)}…` : s
}

export function renderConversations(report, deps) {
  const tbody = document.getElementById("conversations-body")
  const meta = document.getElementById("conversations-meta")
  if (!tbody) return
  const rows = conversationRows(report?.conversations || [])
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" style="padding: 16px; text-align: center; color: var(--ink-3);">暂无会话 — 用户首次发消息后会出现。</td></tr>`
    if (meta) meta.textContent = "0 个会话"
    return
  }
  const conversations = report?.conversations || []
  tbody.innerHTML = rows.map(row => {
    const conv = conversations.find(c => c.chat_id === row.chatId)
    const currentShorthand = conv ? modeToShorthand(conv.mode) : "cc"
    // PR5 Task 22: primary column is the human user (name + truncated wxid);
    // chatId moves to the row's title attribute for debugging.
    const userIdShort = truncate(row.userId || "", 10)
    const userCell = row.userName
      ? `${escapeHtml(row.userName)} <span class="dim" title="${escapeHtml(row.userId || "")}">(${escapeHtml(userIdShort)})</span>`
      : `<span class="dim" title="${escapeHtml(row.userId || "")}">(等待识别) ${escapeHtml(userIdShort)}</span>`
    const acctCell = row.accountId
      ? `<span title="${escapeHtml(row.accountId)}">${escapeHtml(truncate(row.accountId, 12))}</span>`
      : `<span class="dim">--</span>`
    return `
    <tr title="chat: ${escapeHtml(row.chatId)}">
      <td class="name">${userCell}</td>
      <td class="id">${acctCell}</td>
      <td>
        <select class="mode-select mode-${row.badge.tone}" data-chat-id="${escapeHtml(row.chatId)}" data-current="${escapeHtml(currentShorthand)}">
          <option value="cc"${currentShorthand === "cc" ? " selected" : ""}>/cc (Claude solo)</option>
          <option value="codex"${currentShorthand === "codex" ? " selected" : ""}>/codex (Codex solo)</option>
          <option value="both"${currentShorthand === "both" ? " selected" : ""}>/both (Parallel)</option>
          <option value="chat"${currentShorthand === "chat" ? " selected" : ""}>/chat (Chatroom)</option>
        </select>${row.badge.tone === "solo" ? "" : `
        <span class="mode-detail">${escapeHtml(row.badge.detail)}</span>`}
      </td>
    </tr>
  `
  }).join("")
  if (meta) meta.textContent = `${rows.length} 个会话`

  // Wire change handlers for mode-select dropdowns.
  tbody.querySelectorAll("select.mode-select").forEach(sel => {
    sel.addEventListener("change", async (ev) => {
      const select = ev.currentTarget
      const chatId = select.dataset.chatId
      const newMode = select.value
      const prevMode = select.dataset.current

      // Optimistic UI: update the select's tone class immediately.
      const toneMap = { cc: "solo", codex: "solo", both: "parallel", chat: "chatroom" }
      select.className = `mode-select mode-${toneMap[newMode] || "solo"}`

      if (!deps?.invoke) return

      try {
        await deps.invoke("wechat_cli_json", { args: ["mode", "set", chatId, newMode, "--json"] })
        // Success: update current shorthand so next change event has a correct prev value.
        select.dataset.current = newMode
      } catch (err) {
        // Failure: revert to previous selection + show error border.
        select.value = prevMode
        select.className = `mode-select mode-${toneMap[prevMode] || "solo"} mode-select-error`
        // Clear error indication after 3s.
        setTimeout(() => {
          select.classList.remove("mode-select-error")
        }, 3000)
      }
    })
  })
}
