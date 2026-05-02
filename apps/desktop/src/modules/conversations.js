// Conversations module — RFC 03 P5.2 read-only mode display.
// Owns the dashboard's per-chat mode table (#conversations-body,
// #conversations-meta). Read-only by design: all mode flips happen in
// the chat itself via /cc /codex /both /chat (RFC 03 §5).
//
// Rendering is driven by a periodic `wechat-cc conversations list --json`
// poll. The poll is independent of the doctor poll because it reads a
// different file (conversations.json vs the live daemon socket) and has
// a different freshness contract — modes change only when the user types
// a slash command, so a 10s tick is plenty.

import { conversationRows, escapeHtml } from "../view.js"

export function renderConversations(report) {
  const tbody = document.getElementById("conversations-body")
  const meta = document.getElementById("conversations-meta")
  if (!tbody) return
  const rows = conversationRows(report?.conversations || [])
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" style="padding: 16px; text-align: center; color: var(--ink-3);">暂无会话 — 用户首次发消息后会出现。</td></tr>`
    if (meta) meta.textContent = "0 个会话"
    return
  }
  tbody.innerHTML = rows.map(row => `
    <tr>
      <td class="name">${escapeHtml(row.name)}</td>
      <td class="id">${escapeHtml(row.chatId)}</td>
      <td><span class="mode-badge mode-${row.badge.tone}">${escapeHtml(row.badge.label)}</span> <span class="mode-detail">${escapeHtml(row.badge.detail)}</span></td>
    </tr>
  `).join("")
  if (meta) meta.textContent = `${rows.length} 个会话`
}
