import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { InboundMsg } from '../core/prompt-format'
import type { ToolDeps } from '../features/tools'
import { makeStateStore } from './state-store'
import { PendingPermissions, parsePermissionReply } from './pending-permissions'
import { buildMediaItemFromFile, assertSendable } from './media'
import { ilinkSendMessage, botTextMessage } from '../../ilink'
import { sendReplyOnce } from '../../send-reply'
import {
  addProject,
  listProjects,
  setCurrent,
  removeProject,
} from '../../project-registry'
import {
  sharePage as docsShare,
  resurfacePage as docsResurface,
} from '../../docs'
import { loadVoiceConfig, saveVoiceConfig, type VoiceConfig } from './tts/voice-config'
import { makeHttpTTSProvider } from './tts/http-tts'
import { makeQwenProvider } from './tts/qwen'
import type { TTSProvider } from './tts/types'

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
  resolveUserName(chatId: string): string | undefined
  projects: ToolDeps['projects']
  voice: ToolDeps['voice']
  askUser(chatId: string, prompt: string, hash: string, timeoutMs: number): Promise<'allow' | 'deny' | 'timeout'>
  loadProjects(): { projects: Record<string, { path: string; last_active: number }>; current: string | null }
  lastActiveChatId(): string | null
  markChatActive(chatId: string): void
  handlePermissionReply(text: string): boolean
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
  const { stateDir, accounts } = opts

  // Ensure stateDir exists
  mkdirSync(stateDir, { recursive: true })

  // State stores
  const ctxStore = makeStateStore(join(stateDir, 'context_tokens.json'), { debounceMs: 500 })
  const nameStore = makeStateStore(join(stateDir, 'user_names.json'), { debounceMs: 500 })
  const acctStore = makeStateStore(join(stateDir, 'user_account_ids.json'), { debounceMs: 500 })

  // Pending permissions + periodic sweep
  const pending = new PendingPermissions()
  const sweepTimer = setInterval(() => { pending.sweep() }, 30_000)
  // unref so sweep timer doesn't block process exit
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref()

  // Last-active chat tracking (in-memory; fine — survives restarts via acctStore)
  let lastActive: string | null = null

  const projectsFile = join(stateDir, 'projects.json')

  // Resolve which account to use for a given chatId
  function resolveAccount(chatId: string): Account {
    const persistedId = acctStore.get(chatId)
    const found = persistedId ? accounts.find(a => a.id === persistedId) : undefined
    return found ?? accounts[0] ?? (() => { throw new Error('no accounts configured') })()
  }

  // ── Voice helpers ──────────────────────────────────────────────────────────
  function providerFromConfig(cfg: VoiceConfig): TTSProvider {
    if (cfg.provider === 'http_tts') {
      return makeHttpTTSProvider({
        baseUrl: cfg.base_url,
        model: cfg.model,
        apiKey: cfg.api_key,
        defaultVoice: cfg.default_voice,
      })
    }
    return makeQwenProvider({ apiKey: cfg.api_key })
  }

  const voice: ToolDeps['voice'] = {
    async replyVoice(chatId, text) {
      const cfg = loadVoiceConfig(stateDir)
      if (!cfg) return { ok: false as const, reason: 'not_configured' }
      try {
        const provider = providerFromConfig(cfg)
        const { audio, mimeType } = await provider.synth(
          text,
          cfg.default_voice ?? (cfg.provider === 'qwen' ? 'Cherry' : 'default'),
        )
        const tmpDir = join(stateDir, 'tts-tmp')
        mkdirSync(tmpDir, { recursive: true })
        const ext = /wav/i.test(mimeType) ? '.wav' : '.mp3'
        const tmpPath = join(tmpDir, `reply-${Date.now()}-${process.pid}${ext}`)
        writeFileSync(tmpPath, audio)
        try {
          const acct = resolveAccount(chatId)
          const item = await buildMediaItemFromFile(tmpPath, chatId, acct.baseUrl, acct.token)
          const ctxToken = ctxStore.get(chatId)
          await ilinkSendMessage(acct.baseUrl, acct.token, {
            to_user_id: chatId,
            message_type: 2,
            message_state: 2,
            item_list: [item],
            context_token: ctxToken,
          })
          const msgId = `v-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          return { ok: true as const, msgId }
        } finally {
          try { unlinkSync(tmpPath) } catch { /* best-effort */ }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const reason = /5\d\d/.test(msg) ? 'transient' : 'error'
        return { ok: false as const, reason }
      }
    },

    async saveConfig(input) {
      if (input.provider === 'http_tts') {
        if (!input.base_url || !input.model) {
          return { ok: false as const, reason: 'invalid', detail: 'http_tts needs base_url + model' }
        }
      } else {
        if (!input.api_key) {
          return { ok: false as const, reason: 'invalid', detail: 'qwen needs api_key' }
        }
      }
      const cfg: VoiceConfig = input.provider === 'http_tts'
        ? {
            provider: 'http_tts',
            base_url: input.base_url!,
            model: input.model!,
            api_key: input.api_key,
            default_voice: input.default_voice,
            saved_at: new Date().toISOString(),
          }
        : {
            provider: 'qwen',
            api_key: input.api_key!,
            default_voice: input.default_voice,
            saved_at: new Date().toISOString(),
          }
      const provider = providerFromConfig(cfg)
      const started = Date.now()
      const test = await provider.test()
      if (!test.ok) {
        return { ok: false as const, reason: test.reason, detail: test.detail }
      }
      await saveVoiceConfig(stateDir, cfg)
      return {
        ok: true as const,
        tested_ms: Date.now() - started,
        provider: input.provider,
        default_voice: input.default_voice ?? (input.provider === 'qwen' ? 'Cherry' : 'default'),
      }
    },

    configStatus() {
      const cfg = loadVoiceConfig(stateDir)
      if (!cfg) return { configured: false as const }
      return {
        configured: true as const,
        provider: cfg.provider,
        default_voice: cfg.default_voice ?? (cfg.provider === 'qwen' ? 'Cherry' : 'default'),
        base_url: cfg.provider === 'http_tts' ? cfg.base_url : undefined,
        model: cfg.provider === 'http_tts' ? cfg.model : undefined,
        saved_at: cfg.saved_at,
      }
    },
  }

  const adapter: IlinkAdapter = {
    // ── sendMessage ───────────────────────────────────────────────────────
    async sendMessage(chatId, text) {
      const result = await sendReplyOnce(chatId, text)
      if (!result.ok) {
        // Best-effort: don't throw so askUser callers don't fail at prompt time.
        // Use a client-generated msgId since ilink doesn't return one.
        return { msgId: `err:${Date.now()}` }
      }
      const msgId = `sent:${Date.now()}`
      return { msgId }
    },

    // ── sendFile ──────────────────────────────────────────────────────────
    async sendFile(chatId, filePath) {
      assertSendable(filePath)
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

    // ── editMessage ───────────────────────────────────────────────────────
    // ilink has no true edit API. We send a new message prefixed with
    // "(编辑后) " to emulate the behavior. This matches legacy server.ts
    // which also had no real edit support.
    async editMessage(chatId, _msgId, text) {
      await adapter.sendMessage(chatId, `(编辑后) ${text}`)
    },

    // ── broadcast ─────────────────────────────────────────────────────────
    async broadcast(text, accountId) {
      const allChats = Object.keys(acctStore.all())
      let ok = 0
      let failed = 0
      for (const chatId of allChats) {
        // If accountId is specified, only broadcast to chats on that account
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

    // ── sharePage ─────────────────────────────────────────────────────────
    async sharePage(title, content) {
      const r = await docsShare(title, content)
      return { url: r.url, slug: r.slug }
    },

    // ── resurfacePage ─────────────────────────────────────────────────────
    async resurfacePage(q) {
      const r = await docsResurface(q)
      if (!r) return null
      return { url: r.url, slug: r.slug }
    },

    // ── setUserName ───────────────────────────────────────────────────────
    async setUserName(chatId, name) {
      nameStore.set(chatId, name)
    },

    // ── resolveUserName ───────────────────────────────────────────────────
    resolveUserName(chatId) {
      return nameStore.get(chatId)
    },

    // ── projects ──────────────────────────────────────────────────────────
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
          // Resolve to get the path
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

    // ── voice ─────────────────────────────────────────────────────────────
    voice,

    // ── askUser ───────────────────────────────────────────────────────────
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

    // ── loadProjects ──────────────────────────────────────────────────────
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

    // ── lastActiveChatId ──────────────────────────────────────────────────
    lastActiveChatId() {
      if (lastActive) return lastActive
      // Fallback: scan acctStore for any key (last key = most recently set)
      const keys = Object.keys(acctStore.all())
      return keys.length > 0 ? keys[keys.length - 1]! : null
    },

    // ── markChatActive ────────────────────────────────────────────────────
    markChatActive(chatId) {
      lastActive = chatId
    },

    // ── handlePermissionReply ─────────────────────────────────────────────
    handlePermissionReply(text) {
      const parsed = parsePermissionReply(text)
      if (!parsed) return false
      return pending.consume(parsed.hash, parsed.decision)
    },

    // ── flush ─────────────────────────────────────────────────────────────
    async flush() {
      clearInterval(sweepTimer)
      await Promise.all([
        ctxStore.flush(),
        nameStore.flush(),
        acctStore.flush(),
      ])
    },
  }

  return adapter
}

export { parsePermissionReply }

export function startLongPollLoops(_opts: {
  accounts: Account[]
  onInbound: (msg: InboundMsg) => Promise<void>
}): () => Promise<void> {
  throw new Error('startLongPollLoops: not yet implemented — sub-task 11-E')
}
