/**
 * Ilink adapter — composition root for voice / companion / transport /
 * messaging / projects / permissions. The individual concerns live in
 * src/daemon/ilink/*; this file wires them together and exposes the
 * IlinkAdapter surface that bootstrap.ts + main.ts consume.
 *
 * History: was one 550-line closure until the v1.2 ilink-glue split
 * (RFC 02 §8.4). The split is a pure refactor — same public surface,
 * same tests — but gives Task 3 (MCP tool split) cleaner module seams.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { InboundMsg } from '../core/prompt-format'
import type { WechatProjectsDep, WechatVoiceDep, WechatCompanionDep } from './wechat-tool-deps'
import { parsePermissionReply } from './pending-permissions'
import { buildMediaItemFromFile, assertSendable } from './media'
import { ilinkSendMessage } from '../lib/ilink'
import type { SessionStateStore } from './session-state'
import { sendReplyOnce } from '../lib/send-reply'
import {
  addProject,
  listProjects,
  setCurrent,
  removeProject,
} from '../lib/project-registry'
import {
  sharePage as docsShare,
  resurfacePage as docsResurface,
  onPdfRequest as docsOnPdfRequest,
} from '../../docs'
import { makeIlinkContext, type Account } from './ilink/context'
import { makeVoice } from './ilink/voice'
import { makeCompanion } from './ilink/companion'
import { makeTransport } from './ilink/transport'

export type { Account } from './ilink/context'

export interface IlinkAdapter {
  sendMessage(chatId: string, text: string): Promise<{ msgId: string; error?: string }>
  sendFile(chatId: string, path: string): Promise<void>
  editMessage(chatId: string, msgId: string, text: string): Promise<void>
  broadcast(text: string, accountId?: string): Promise<{ ok: number; failed: number }>
  sharePage(title: string, content: string, opts?: { needs_approval?: boolean; chat_id?: string; account_id?: string }): Promise<{ url: string; slug: string }>
  resurfacePage(q: { slug?: string; title_fragment?: string }): Promise<{ url: string; slug: string } | null>
  setUserName(chatId: string, name: string): Promise<void>
  resolveUserName(chatId: string): string | undefined
  projects: WechatProjectsDep
  voice: WechatVoiceDep
  companion: WechatCompanionDep
  askUser(chatId: string, prompt: string, hash: string, timeoutMs: number): Promise<'allow' | 'deny' | 'timeout'>
  loadProjects(): { projects: Record<string, { path: string; last_active: number }>; current: string | null }
  lastActiveChatId(): string | null
  markChatActive(chatId: string, accountId?: string): void
  captureContextToken(chatId: string, ctxToken?: string): void
  sendTyping(chatId: string, accountId?: string): Promise<void>
  /**
   * Long-poll wrapper for poll-loop. Detects errcode=-14 session timeout and
   * flips SessionStateStore + returns { expired: true } so the loop stops.
   */
  getUpdatesForLoop(accountId: string, baseUrl: string, token: string, syncBuf: string): Promise<{
    updates?: unknown[]
    sync_buf?: string
    expired?: boolean
  }>
  handlePermissionReply(text: string): boolean
  /** Session state accessor for admin commands (/health, cleanup). */
  sessionState: SessionStateStore
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

export function makeIlinkAdapter(opts: { stateDir: string; accounts: Account[] }): IlinkAdapter {
  const ctx = makeIlinkContext(opts)
  const { accounts, ctxStore, nameStore, acctStore, sessionState, pending, sweepTimer, projectsFile, resolveAccount, assertChatRoutable } = ctx

  const voice = makeVoice(ctx)
  const companion = makeCompanion(ctx)
  const transport = makeTransport(ctx)

  const adapter: IlinkAdapter = {
    async sendMessage(chatId, text) {
      const result = await sendReplyOnce(chatId, text)
      if (!result.ok) {
        // Keep returning a dummy msgId for back-compat with callers that
        // destructure blindly (e.g. askUser prompt send), but ALSO surface
        // the error so tool handlers can tell Claude the send actually failed.
        return { msgId: `err:${Date.now()}`, error: result.error ?? 'send failed' }
      }
      return { msgId: `sent:${Date.now()}` }
    },

    async sendFile(chatId, filePath) {
      assertSendable(filePath)
      // Fail before the CDN upload — without on-disk routing state, the
      // subsequent ilink/sendmessage will fail anyway with a less helpful
      // errcode. See unknownChatIdError() for the message.
      assertChatRoutable(chatId)
      const acct = resolveAccount(chatId)
      const item = await buildMediaItemFromFile(filePath, chatId, acct.baseUrl, acct.token)
      const ctxToken = ctxStore.get(chatId)
      await ilinkSendMessage(acct.baseUrl, acct.token, {
        to_user_id: chatId,
        message_type: 2,
        message_state: 2,
        item_list: [item],
        context_token: ctxToken,
      })
    },

    // ilink has no true edit API. We send a new message prefixed with
    // "(编辑后) " to emulate the behavior. Matches legacy server.ts.
    async editMessage(chatId, _msgId, text) {
      await adapter.sendMessage(chatId, `(编辑后) ${text}`)
    },

    async broadcast(text, accountId) {
      const allChats = Object.keys(acctStore.all())
      let ok = 0
      let failed = 0
      for (const chatId of allChats) {
        if (accountId) {
          const chatAcct = acctStore.get(chatId)
          if (chatAcct && chatAcct !== accountId) continue
        }
        const result = await sendReplyOnce(chatId, text)
        if (result.ok) ok++
        else failed++
      }
      return { ok, failed }
    },

    async sharePage(title, content, opts) {
      const r = await docsShare(title, content, opts)
      return { url: r.url, slug: r.slug }
    },

    async resurfacePage(q) {
      const r = await docsResurface(q)
      if (!r) return null
      return { url: r.url, slug: r.slug }
    },

    async setUserName(chatId, name) {
      nameStore.set(chatId, name)
    },

    resolveUserName(chatId) {
      return nameStore.get(chatId)
    },

    projects: {
      list() {
        const views = listProjects(projectsFile)
        return views.map(v => ({
          alias: v.alias,
          path: v.path,
          current: v.is_current,
        }))
      },
      async switchTo(alias) {
        try {
          setCurrent(projectsFile, alias)
          const views = listProjects(projectsFile)
          const entry = views.find(v => v.alias === alias)
          if (!entry) return { ok: false as const, reason: `alias '${alias}' not found after switch` }
          return { ok: true as const, path: entry.path }
        } catch (err) {
          return { ok: false as const, reason: err instanceof Error ? err.message : String(err) }
        }
      },
      async add(alias, path) {
        addProject(projectsFile, alias, path)
      },
      async remove(alias) {
        removeProject(projectsFile, alias)
      },
    },

    voice,
    companion,

    async askUser(chatId, prompt, hash, timeoutMs) {
      // Register pending entry first so timeout can fire even if send fails.
      const resultPromise = pending.register(hash, timeoutMs)
      // Schedule a sweep at the timeout boundary so the promise resolves
      // with 'timeout' even when the global 30s sweep interval hasn't fired.
      // Using setTimeout so fake-timer tests can advance past the timeout.
      const t = setTimeout(() => { pending.sweep() }, timeoutMs + 1)
      if (typeof t.unref === 'function') t.unref()
      // Best-effort send — don't throw if it fails.
      adapter.sendMessage(chatId, prompt).catch(() => {})
      return resultPromise
    },

    loadProjects() {
      if (!existsSync(projectsFile)) {
        return { projects: {}, current: null }
      }
      try {
        const raw = readFileSync(projectsFile, 'utf8')
        const parsed = JSON.parse(raw) as {
          projects?: Record<string, { path: string; last_active: string }>
          current?: string | null
        }
        const out: Record<string, { path: string; last_active: number }> = {}
        for (const [alias, entry] of Object.entries(parsed.projects ?? {})) {
          out[alias] = {
            path: entry.path,
            last_active: new Date(entry.last_active).getTime(),
          }
        }
        return { projects: out, current: parsed.current ?? null }
      } catch {
        return { projects: {}, current: null }
      }
    },

    lastActiveChatId: transport.lastActiveChatId,
    markChatActive: transport.markChatActive,
    captureContextToken: transport.captureContextToken,
    sendTyping: transport.sendTyping,
    getUpdatesForLoop: transport.getUpdatesForLoop,

    sessionState,

    handlePermissionReply(text) {
      const parsed = parsePermissionReply(text)
      if (!parsed) return false
      return pending.consume(parsed.hash, parsed.decision)
    },

    async flush() {
      clearInterval(sweepTimer)
      await Promise.all([
        ctxStore.flush(),
        nameStore.flush(),
        acctStore.flush(),
        sessionState.flush(),
      ])
    },
  }

  // Wire PDF delivery: docs server requests a PDF be sent to a chat.
  docsOnPdfRequest(async ({ chatId, pdfPath }) => {
    await adapter.sendFile(chatId, pdfPath)
  })

  return adapter
}

export { parsePermissionReply }

export function startLongPollLoops(_opts: {
  accounts: Account[]
  onInbound: (msg: InboundMsg) => Promise<void>
}): () => Promise<void> {
  throw new Error('startLongPollLoops: not yet implemented — sub-task 11-E')
}
