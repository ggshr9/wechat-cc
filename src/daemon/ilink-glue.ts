import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { InboundMsg } from '../core/prompt-format'
import type { ToolDeps } from '../features/tools'

export interface Account {
  id: string
  botId: string
  userId: string
  baseUrl: string
  token: string
  syncBuf: string
}

export interface IlinkAdapter {
  sendMessage(chatId: string, text: string): Promise<{ msgId: string }>
  sendFile(chatId: string, path: string): Promise<void>
  editMessage(chatId: string, msgId: string, text: string): Promise<void>
  broadcast(text: string, accountId?: string): Promise<{ ok: number; failed: number }>
  sharePage(title: string, content: string): Promise<{ url: string; slug: string }>
  resurfacePage(q: { slug?: string; title_fragment?: string }): Promise<{ url: string; slug: string } | null>
  setUserName(chatId: string, name: string): Promise<void>
  projects: ToolDeps['projects']
  askUser(chatId: string, prompt: string, hash: string, timeoutMs: number): Promise<'allow' | 'deny' | 'timeout'>
  loadProjects(): { projects: Record<string, { path: string; last_active: number }>; current: string | null }
  lastActiveChatId(): string | null
  flush(): Promise<void>
}

export async function loadAllAccounts(stateDir: string): Promise<Account[]> {
  const dir = join(stateDir, 'accounts')
  if (!existsSync(dir)) return []
  const out: Account[] = []
  for (const id of readdirSync(dir)) {
    const acctDir = join(dir, id)
    const metaPath = join(acctDir, 'account.json')
    const tokenPath = join(acctDir, 'token')
    if (!existsSync(metaPath) || !existsSync(tokenPath)) continue
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { botId: string; userId: string; baseUrl: string }
    const token = readFileSync(tokenPath, 'utf8').trim()
    const syncBufPath = join(acctDir, 'sync_buf')
    const syncBuf = existsSync(syncBufPath) ? readFileSync(syncBufPath, 'utf8').trim() : ''
    out.push({ id, botId: meta.botId, userId: meta.userId, baseUrl: meta.baseUrl, token, syncBuf })
  }
  return out
}

export function makeIlinkAdapter(_opts: { stateDir: string; accounts: Account[] }): IlinkAdapter {
  throw new Error('makeIlinkAdapter: not yet implemented — sub-tasks 11-B through 11-G')
}

export function startLongPollLoops(_opts: {
  accounts: Account[]
  onInbound: (msg: InboundMsg) => Promise<void>
}): () => Promise<void> {
  throw new Error('startLongPollLoops: not yet implemented — sub-task 11-E')
}
