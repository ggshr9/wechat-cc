export interface InboundMsg {
  chatId: string
  userId: string
  userName?: string
  text: string
  msgType: string
  createTimeMs: number
  /**
   * A quoted/replied-to message, extracted inline from ilink's `ref_msg`.
   * ilink gives us the content (text or a media-type label), never a stable
   * id — so this is the actual quoted text, not a lookup key. Rendered as a
   * `<quote type="…">…</quote>` element inside the <wechat> envelope.
   */
  quote?: { type: string; text: string }
  accountId: string
  /**
   * ilink-issued per-chat context token. ilink requires it on outbound
   * sendmessage; without it sendmessage returns errcode=-14 (session
   * timeout). The daemon captures this from each incoming message and
   * persists to context_tokens.json, then reads it back when replying.
   *
   * This field was lost in the v1.0 phase-1 rebuild — the old server.ts
   * did `if (msg.context_token) contextTokens.set(...)`; the new
   * src/daemon/main.ts dropped the field. v0.3.1 wires it back.
   */
  contextToken?: string
  attachments?: { kind: 'image' | 'file' | 'voice'; path: string; caption?: string }[]
}

export function formatInbound(m: InboundMsg): string {
  const attrs = [
    `chat_id="${escAttr(m.chatId)}"`,
    `user="${escAttr(m.userName ?? m.userId)}"`,
    `user_id="${escAttr(m.userId)}"`,
    `account="${escAttr(m.accountId)}"`,
    `msg_type="${escAttr(m.msgType)}"`,
    `ts="${new Date(m.createTimeMs).toISOString()}"`,
  ].filter(Boolean).join(' ')

  const attachmentLines = (m.attachments ?? []).map(a => {
    const caption = a.caption ? ` ${escBody(a.caption)}` : ''
    return `[${a.kind}:${a.path}]${caption}`
  })

  const quoteEl = m.quote
    ? `<quote type="${escAttr(m.quote.type)}">${escBody(m.quote.text)}</quote>`
    : ''
  const body = [quoteEl, escBody(m.text), ...attachmentLines].filter(Boolean).join('\n')
  return `<wechat ${attrs}>\n${body}\n</wechat>`
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escBody(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
