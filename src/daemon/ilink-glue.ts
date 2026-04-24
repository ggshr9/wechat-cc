import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { InboundMsg } from '../core/prompt-format'
import type { ToolDeps } from '../features/tools'
import { makeStateStore } from './state-store'
import { PendingPermissions, parsePermissionReply } from './pending-permissions'
import { buildMediaItemFromFile, buildVoiceItemFromWav, assertSendable } from './media'
import { ilinkSendMessage, ilinkSendTyping, ilinkGetConfig, botTextMessage } from '../../ilink'
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
import {
  companionDir, personasDir, profilePath, personaPath,
} from './companion/paths'
import { loadCompanionConfig, saveCompanionConfig, defaultCompanionConfig } from './companion/config'
import { listPersonas } from './companion/persona'
import { PROFILE_TEMPLATE, PERSONA_ASSISTANT_TEMPLATE, PERSONA_COMPANION_TEMPLATE } from './companion/templates'
import { Cron } from 'croner'

export interface Account {
  id: string
  botId: string
  userId: string
  baseUrl: string
  token: string
  syncBuf: string
}

export interface IlinkAdapter {
  sendMessage(chatId: string, text: string): Promise<{ msgId: string; error?: string }>
  sendFile(chatId: string, path: string): Promise<void>
  editMessage(chatId: string, msgId: string, text: string): Promise<void>
  broadcast(text: string, accountId?: string): Promise<{ ok: number; failed: number }>
  sharePage(title: string, content: string): Promise<{ url: string; slug: string }>
  resurfacePage(q: { slug?: string; title_fragment?: string }): Promise<{ url: string; slug: string } | null>
  setUserName(chatId: string, name: string): Promise<void>
  resolveUserName(chatId: string): string | undefined
  projects: ToolDeps['projects']
  voice: ToolDeps['voice']
  companion: ToolDeps['companion']
  askUser(chatId: string, prompt: string, hash: string, timeoutMs: number): Promise<'allow' | 'deny' | 'timeout'>
  loadProjects(): { projects: Record<string, { path: string; last_active: number }>; current: string | null }
  lastActiveChatId(): string | null
  markChatActive(chatId: string, accountId?: string): void
  sendTyping(chatId: string, accountId?: string): Promise<void>
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

  // Typing ticket cache (per chat). ilink returns a short-lived typing_ticket
  // from getconfig; we keep it warm for 60s to avoid a round-trip on every
  // inbound. Same TTL as legacy server.ts.
  const typingTickets = new Map<string, { ticket: string; ts: number }>()
  const TYPING_TTL_MS = 60_000

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
          // For WAV: transcode to 24kHz mono MP3 via ffmpeg and send as
          // voice_item (encode_type=7, sample_rate=24000) so WeChat renders a
          // voice bubble. Non-WAV (Qwen MP3 etc.) still goes through the
          // generic file-attachment path until we add duration parsing for
          // those containers.
          const item = ext === '.wav'
            ? await buildVoiceItemFromWav(tmpPath, chatId, acct.baseUrl, acct.token, text)
            : await buildMediaItemFromFile(tmpPath, chatId, acct.baseUrl, acct.token)
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

  // ── Companion ──────────────────────────────────────────────────────────
  const companion: ToolDeps['companion'] = {
    async enable() {
      const cfg = loadCompanionConfig(opts.stateDir)
      const alreadyScaffolded =
        existsSync(profilePath(opts.stateDir)) &&
        existsSync(personaPath(opts.stateDir, 'assistant')) &&
        existsSync(personaPath(opts.stateDir, 'companion'))
      if (alreadyScaffolded && cfg.enabled) {
        return { ok: true as const, already_configured: true as const }
      }

      // Scaffold missing files
      mkdirSync(companionDir(opts.stateDir), { recursive: true })
      mkdirSync(personasDir(opts.stateDir), { recursive: true })
      if (!existsSync(profilePath(opts.stateDir))) {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
        writeFileSync(
          profilePath(opts.stateDir),
          PROFILE_TEMPLATE.replace('{{TIMEZONE}}', tz),
          'utf8',
        )
      }
      if (!existsSync(personaPath(opts.stateDir, 'assistant'))) {
        writeFileSync(personaPath(opts.stateDir, 'assistant'), PERSONA_ASSISTANT_TEMPLATE, 'utf8')
      }
      if (!existsSync(personaPath(opts.stateDir, 'companion'))) {
        writeFileSync(personaPath(opts.stateDir, 'companion'), PERSONA_COMPANION_TEMPLATE, 'utf8')
      }

      // Flip enabled=true; preserve existing config fields if any
      const newCfg = {
        ...defaultCompanionConfig(),
        ...cfg,
        enabled: true,
        per_project_persona: {
          _default: 'assistant',
          ...cfg.per_project_persona,
        },
        default_chat_id: cfg.default_chat_id ?? lastActive ?? (Object.keys(acctStore.all()).slice(-1)[0] ?? null),
      }
      await saveCompanionConfig(opts.stateDir, newCfg)

      return {
        ok: true as const,
        state_dir: companionDir(opts.stateDir),
        personas_scaffolded: ['assistant', 'companion'],
        welcome_message:
          '开启完成。两个人格已经装好：\n' +
          '- **小助手**（当前默认）：干活为主，推送从严。CI / PR / 部署故障会提醒。\n' +
          '- **陪伴**：聊天为主，推送更随性。下班时段切过去比较舒服。\n\n' +
          '目前还没配任何触发器。要加提醒就说 "加个 CI 监控" / "每周五下午提醒我写周记" 这类。\n' +
          '要切人格就说 "切到陪伴"。要暂停就说 "别烦我" 或 "snooze 3 小时"。',
        cost_estimate_note:
          '主动推送每次评估走 Claude Agent SDK 一次短会话，典型成本约 $0.01/次。频率由你的触发器决定；默认只提醒明显需要动手的事。',
      }
    },

    async disable() {
      const cfg = loadCompanionConfig(opts.stateDir)
      cfg.enabled = false
      await saveCompanionConfig(opts.stateDir, cfg)
      return { ok: true as const, enabled: false as const }
    },

    status() {
      const cfg = loadCompanionConfig(opts.stateDir)
      const personas = listPersonas(opts.stateDir)
      const triggers = cfg.triggers.map(t => {
        let next_fire_at: string | null = null
        try {
          const c = new Cron(t.schedule, { timezone: cfg.timezone, paused: true }, () => {})
          next_fire_at = c.nextRun()?.toISOString() ?? null
        } catch {
          // bad schedule — leave next_fire_at as null
        }
        return {
          id: t.id,
          project: t.project,
          schedule: t.schedule,
          personas: t.personas,
          next_fire_at,
        }
      })
      return {
        enabled: cfg.enabled,
        timezone: cfg.timezone,
        per_project_persona: cfg.per_project_persona,
        personas_available: personas.map(p => ({
          name: p.frontmatter.name,
          display_name: p.frontmatter.display_name,
        })),
        triggers,
        snooze_until: cfg.snooze_until,
        pushes_last_24h: 0,
        runs_last_24h: 0,
      }
    },

    async snooze(minutes: number) {
      const cfg = loadCompanionConfig(opts.stateDir)
      const until = new Date(Date.now() + minutes * 60_000).toISOString()
      cfg.snooze_until = until
      await saveCompanionConfig(opts.stateDir, cfg)
      return { ok: true as const, until }
    },

    async personaSwitch(params: { persona: string; project?: string }) {
      const cfg = loadCompanionConfig(opts.stateDir)
      const available = listPersonas(opts.stateDir).map(p => p.frontmatter.name)
      if (!available.includes(params.persona)) {
        return {
          ok: false as const,
          reason: `unknown persona '${params.persona}'; available: ${available.join(', ') || '(none)'}`,
        }
      }
      const proj = params.project ?? '_default'
      cfg.per_project_persona = {
        ...cfg.per_project_persona,
        [proj]: params.persona,
      }
      await saveCompanionConfig(opts.stateDir, cfg)
      return { ok: true as const, project: proj, persona: params.persona }
    },

    async triggerAdd(params: {
      id: string
      project: string
      schedule: string
      task: string
      personas?: string[]
      on_failure?: 'silent' | 'notify-user' | 'retry-once'
    }) {
      const cfg = loadCompanionConfig(opts.stateDir)
      if (cfg.triggers.some(t => t.id === params.id)) {
        return { ok: false as const, reason: `trigger id '${params.id}' already exists` }
      }
      // Validate cron syntax via croner (throws on bad pattern)
      let next_fire_at = ''
      try {
        const c = new Cron(params.schedule, { timezone: cfg.timezone, paused: true }, () => {})
        next_fire_at = c.nextRun()?.toISOString() ?? ''
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false as const, reason: `invalid schedule: ${msg}` }
      }

      cfg.triggers.push({
        id: params.id,
        project: params.project,
        schedule: params.schedule,
        task: params.task,
        personas: params.personas ?? [],
        on_failure: params.on_failure ?? 'silent',
        created_at: new Date().toISOString(),
      })
      await saveCompanionConfig(opts.stateDir, cfg)
      return { ok: true as const, next_fire_at }
    },

    async triggerRemove(id: string) {
      const cfg = loadCompanionConfig(opts.stateDir)
      const before = cfg.triggers.length
      cfg.triggers = cfg.triggers.filter(t => t.id !== id)
      if (cfg.triggers.length === before) {
        return { ok: false as const, reason: `no trigger with id '${id}'` }
      }
      await saveCompanionConfig(opts.stateDir, cfg)
      return { ok: true as const }
    },

    async triggerPause(id: string, minutes?: number) {
      const cfg = loadCompanionConfig(opts.stateDir)
      const t = cfg.triggers.find(x => x.id === id)
      if (!t) return { ok: false as const, reason: `no trigger with id '${id}'` }
      const until = minutes
        ? new Date(Date.now() + minutes * 60_000).toISOString()
        : '9999-12-31T23:59:59Z'
      t.paused_until = until
      await saveCompanionConfig(opts.stateDir, cfg)
      return { ok: true as const, paused_until: until }
    },
  } satisfies ToolDeps['companion']

  const adapter: IlinkAdapter = {
    // ── sendMessage ───────────────────────────────────────────────────────
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

    // ── companion ─────────────────────────────────────────────────────────
    companion,

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
    // accountId is the bot that just received a message from this chat —
    // persist it so future replies route back via the same (live) bot even
    // after daemon restart. Without this write the map goes stale the first
    // time a user re-binds (new QR scan = new bot id), silently routing
    // replies to a dead session.
    markChatActive(chatId, accountId) {
      lastActive = chatId
      if (accountId && acctStore.get(chatId) !== accountId) {
        acctStore.set(chatId, accountId)
      }
    },

    // ── sendTyping ────────────────────────────────────────────────────────
    // Fire-and-forget UX hint. Best-effort — typing indicator is nice but not
    // a correctness concern, but logging each step helps diagnose the silent-
    // drop case where ilink doesn't return a typing_ticket.
    async sendTyping(chatId, accountId) {
      try {
        const acct = accountId
          ? accounts.find(a => a.id === accountId)
          : (() => {
              const id = acctStore.get(chatId)
              return id ? accounts.find(a => a.id === id) : undefined
            })()
        if (!acct) {
          console.error(`wechat channel: [TYPING] skip — no account resolvable for chat=${chatId}`)
          return
        }
        const now = Date.now()
        const cached = typingTickets.get(chatId)
        let ticket = cached && now - cached.ts < TYPING_TTL_MS ? cached.ticket : undefined
        let source = 'cache'
        if (!ticket) {
          source = 'fresh'
          const cfg = await ilinkGetConfig(acct.baseUrl, acct.token, chatId, ctxStore.get(chatId))
          if (!cfg.typing_ticket) {
            console.error(`wechat channel: [TYPING] getconfig returned no typing_ticket for chat=${chatId} acct=${acct.id} raw=${JSON.stringify(cfg).slice(0, 200)}`)
            return
          }
          ticket = cfg.typing_ticket
          typingTickets.set(chatId, { ticket, ts: now })
        }
        await ilinkSendTyping(acct.baseUrl, acct.token, chatId, ticket)
        console.error(`wechat channel: [TYPING] sent chat=${chatId} acct=${acct.id} ticket=${source}`)
      } catch (err) {
        console.error(`wechat channel: [TYPING] error chat=${chatId}: ${err instanceof Error ? err.message : err}`)
      }
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
