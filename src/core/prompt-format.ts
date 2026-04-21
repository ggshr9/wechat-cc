export interface InboundMsg {
  chatId: string
  userId: string
  userName?: string
  text: string
  msgType: string
  createTimeMs: number
  quoteTo?: string
  accountId: string
  attachments?: { kind: 'image' | 'file' | 'voice'; path: string; caption?: string }[]
}

export function formatInbound(m: InboundMsg): string {
  const attrs = [
    `chat_id="${escAttr(m.chatId)}"`,
    `user="${escAttr(m.userName ?? m.userId)}"`,
    `user_id="${escAttr(m.userId)}"`,
    `account="${escAttr(m.accountId)}"`,
    `msg_type="${escAttr(m.msgType)}"`,
    `ts="${m.createTimeMs}"`,
    m.quoteTo ? `quote_to="${escAttr(m.quoteTo)}"` : '',
  ].filter(Boolean).join(' ')

  const attachmentLines = (m.attachments ?? []).map(a => {
    const caption = a.caption ? ` ${escBody(a.caption)}` : ''
    return `[${a.kind}:${a.path}]${caption}`
  })

  const body = [escBody(m.text), ...attachmentLines].filter(Boolean).join('\n')
  return `<wechat ${attrs}>\n${body}\n</wechat>`
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escBody(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
