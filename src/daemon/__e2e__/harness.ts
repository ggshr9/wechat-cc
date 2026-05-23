/**
 * Test daemon harness — boots the full daemon (same path as main.ts) but
 * with a fake ilink server, fake SDKs, and a temporary stateDir.
 *
 * PRECONDITION: src/daemon/main.ts must honor process.env.WECHAT_CC_STATE_DIR.
 * P-T11 patches that. Until then, e2e tests using this harness will pollute
 * ~/.claude/channels/wechat — DON'T RUN THE TESTS BEFORE P-T11 LANDS.
 *
 * Each test:
 *   const daemon = await startTestDaemon({ claudeScript: ... })
 *   try {
 *     daemon.sendText('chat1', 'hi')
 *     const replies = await daemon.waitForReplyTo('chat1')
 *     expect(replies[0]?.text).toBe('hello back')
 *   } finally { await daemon.stop() }
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startFakeIlink, type FakeIlinkHandle, type OutboundMsg } from './fake-ilink-server'
import { installFakeClaude, installClaudeSpawnRecorder, installFakeCodex, installCodexSpawnRecorder, installFakeCursor, installCursorSpawnRecorder, installFakeModerator, type FakeSdkScript, type ModeratorScript } from './fake-sdk'
// Side-effect import: registers vi.mock('../media') so attachments
// materialize to local stub files instead of hitting the real ilink CDN.
// MUST come before bootDaemon imports to take effect.
import './fake-media'
import type { RawUpdate } from '../poll-loop'

export interface TestDaemonAccount {
  id: string
  botId: string
  userId: string
  baseUrl: string
  token: string
  syncBuf: string
}

export interface TestDaemonOpts {
  claudeScript?: FakeSdkScript
  codexScript?: FakeSdkScript
  cursorScript?: FakeSdkScript
  /**
   * Scripted decisions for the chatroom haiku moderator (single-shot
   * `query({ prompt: string })` calls). Returns the JSON decision string
   * the coordinator parses. Without this, single-shot queries fall back
   * to claudeScript.onDispatch which yields the speaker reply path.
   */
  moderatorScript?: ModeratorScript
  /** --dangerously flag */
  dangerously?: boolean
  /** preset access.json — default: allowFrom: ['*'], admins: ['testadmin'] */
  access?: { allowFrom?: string[]; admins?: string[]; trusted?: string[] }
  /**
   * Optional callback fired with the SDK options passed to `query()` for
   * each streaming Claude spawn (AgentSession). Used by tier-permissions
   * e2e tests to assert that admin / trusted / guest chats produce
   * different `permissionMode` + `disallowedTools` shapes.
   *
   * Not called for cheapEval (single-shot string prompt) or moderator
   * paths — only for the session-spawn path that goes through
   * sdkOptionsForProject(alias, path, tierProfile).
   */
  recordClaudeSpawnOptions?: (options: Record<string, unknown>) => void
  /**
   * Optional callback fired with the thread options passed to
   * `Codex.startThread()` / `resumeThread()` for each spawned codex
   * AgentSession. Used by tier-permissions e2e tests to assert that
   * admin / trusted / guest chats produce different `sandboxMode` +
   * `approvalPolicy` shapes on the codex side.
   *
   * Not called for cheapEval — the cheap codex thread uses `thread.run()`
   * (not runStreamed), which the fake doesn't implement, so the recorder
   * naturally only fires on the session-spawn path.
   */
  recordCodexSpawnOptions?: (options: Record<string, unknown>) => void
  /**
   * Optional callback fired with the AgentOptions object passed to
   * `Agent.create()` / `Agent.resume()` for each spawned cursor
   * AgentSession. Used by tier-permissions e2e tests to assert that
   * admin / trusted / guest chats produce different sandboxOptions
   * shapes on the cursor side.
   *
   * Unlike Claude and Codex, Cursor has no cheap-eval path — every
   * cursor invocation goes through Agent.create / Agent.resume, so
   * this recorder fires on all cursor spawns.
   */
  recordCursorSpawnOptions?: (options: Record<string, unknown>) => void
  /** preset companion config — default: disabled */
  companion?: { enabled?: boolean; default_chat_id?: string }
  /** preset bot accounts — default: 1 fake bot pointing at fake ilink */
  accounts?: TestDaemonAccount[]
  /** Pre-set conversation modes (chatId → Mode). Persisted to conversations.json so coordinator picks them up. */
  modes?: Record<string, { kind: 'solo' | 'parallel' | 'primary_tool' | 'chatroom'; provider?: string; primary?: string; secondary?: string; max_rounds?: number }>
  /**
   * Pre-known users (chatId → name). Populates user_names.json so onboarding
   * is skipped for these users. Default: { chat1: 'testuser' }.
   * Pass `{}` to disable all pre-population (for onboarding tests).
   */
  knownUsers?: Record<string, string>
  /**
   * When set, reuse this stateDir instead of creating a fresh tmp one.
   * The harness will skip mkdtemp + skip cleanup on stop (caller owns it).
   * Used by restart-persistence tests that boot daemon twice on the same
   * on-disk SQLite db to verify state survives a stop+start cycle.
   */
  stateDirOverride?: string
}

export interface DaemonHandle {
  ilink: FakeIlinkHandle
  stateDir: string
  /** Enqueue a text inbound from chatId (default to_user_id is 'bot1'). */
  sendText(chatId: string, text: string, opts?: { contextToken?: string; createTimeMs?: number; toUserId?: string }): void
  /**
   * Enqueue an image inbound (RawUpdate type=2). The fake-media stub
   * materializes a 3-byte stub file at <stateDir>/inbox/<chatId>/, and
   * the inbound pipeline rewrites attachment.path to that local path
   * before formatInbound emits the [image:/path] marker.
   */
  sendImage(chatId: string, opts?: { createTimeMs?: number; toUserId?: string; contextToken?: string }): void
  /** Wait until outbox has a sendmessage to this chatId. */
  waitForReplyTo(chatId: string, timeoutMs?: number): Promise<readonly OutboundMsg[]>
  /** Wait until any predicate over the outbox is satisfied. */
  waitForOutbound(predicate: (msgs: readonly OutboundMsg[]) => boolean, timeoutMs?: number): Promise<readonly OutboundMsg[]>
  /** Stop daemon (signals SIGTERM equivalent), clean up stateDir. */
  stop(): Promise<void>
}

let messageIdCounter = 1
function nextMessageId(): number { return messageIdCounter++ }

export async function startTestDaemon(opts: TestDaemonOpts = {}): Promise<DaemonHandle> {
  // 1. Set up fake ilink + stateDir (fresh tmp by default, or caller-provided
  // for restart-persistence tests that need to share state across two boots).
  const ilink = await startFakeIlink()
  const stateDir = opts.stateDirOverride ?? mkdtempSync(join(tmpdir(), 'wechat-cc-e2e-'))
  const ownsStateDir = opts.stateDirOverride === undefined
  mkdirSync(join(stateDir, 'inbox'), { recursive: true })
  mkdirSync(join(stateDir, 'memory'), { recursive: true })
  mkdirSync(join(stateDir, 'accounts'), { recursive: true })

  // 2. Write access.json
  const access: { allowFrom: string[]; admins: string[]; trusted?: string[] } = {
    allowFrom: opts.access?.allowFrom ?? ['*'],
    admins: opts.access?.admins ?? ['testadmin'],
    ...(opts.access?.trusted ? { trusted: opts.access.trusted } : {}),
  }
  writeFileSync(join(stateDir, 'access.json'), JSON.stringify(access, null, 2))

  // 3. Write fake bot account(s) — format: accounts/<id>/account.json + token
  const accounts: TestDaemonAccount[] = opts.accounts ?? [{
    id: 'bot1', botId: 'bot1', userId: 'owner1',
    baseUrl: ilink.baseUrl, token: 'fake-token', syncBuf: '',
  }]
  for (const a of accounts) {
    const acctDir = join(stateDir, 'accounts', a.id)
    mkdirSync(acctDir, { recursive: true })
    writeFileSync(join(acctDir, 'account.json'), JSON.stringify({ botId: a.botId, userId: a.userId, baseUrl: a.baseUrl }, null, 2))
    writeFileSync(join(acctDir, 'token'), a.token)
    if (a.syncBuf) writeFileSync(join(acctDir, 'sync_buf'), a.syncBuf)
  }

  // 4. Pre-populate routing state so send-reply can route without waiting for
  // debounced state-store flush, and so onboarding is skipped for known users.
  const knownUsers = 'knownUsers' in opts ? opts.knownUsers : { chat1: 'testuser' }
  if (knownUsers && Object.keys(knownUsers).length > 0) {
    // user_names.json — onboarding check (isKnownUser)
    writeFileSync(join(stateDir, 'user_names.json'), JSON.stringify(knownUsers))
    // user_account_ids.json — sendReplyOnce routing (chatId → accountId)
    const defaultAccountId = accounts[0]?.id ?? 'bot1'
    const userAccountIds: Record<string, string> = {}
    for (const chatId of Object.keys(knownUsers)) userAccountIds[chatId] = defaultAccountId
    writeFileSync(join(stateDir, 'user_account_ids.json'), JSON.stringify(userAccountIds))
  }

  // 5. Write companion config if provided
  if (opts.companion) {
    writeFileSync(join(stateDir, 'companion-config.json'), JSON.stringify({
      enabled: opts.companion.enabled ?? false,
      snooze_until: null,
      default_chat_id: opts.companion.default_chat_id ?? null,
      last_introspect_at: null,
    }, null, 2))
  }

  // 5. Install fake SDKs (BEFORE importing daemon main)
  const cleanups: Array<() => void> = []
  if (opts.claudeScript) {
    const { uninstall } = installFakeClaude(opts.claudeScript)
    cleanups.push(uninstall)
  }
  if (opts.codexScript) {
    const { uninstall } = installFakeCodex(opts.codexScript)
    cleanups.push(uninstall)
  }
  if (opts.cursorScript) {
    const { uninstall } = installFakeCursor(opts.cursorScript)
    cleanups.push(uninstall)
  }
  if (opts.moderatorScript) {
    const { uninstall } = installFakeModerator(opts.moderatorScript)
    cleanups.push(uninstall)
  }
  if (opts.recordClaudeSpawnOptions) {
    const { uninstall } = installClaudeSpawnRecorder(opts.recordClaudeSpawnOptions)
    cleanups.push(uninstall)
  }
  if (opts.recordCodexSpawnOptions) {
    const { uninstall } = installCodexSpawnRecorder(opts.recordCodexSpawnOptions)
    cleanups.push(uninstall)
  }
  if (opts.recordCursorSpawnOptions) {
    const { uninstall } = installCursorSpawnRecorder(opts.recordCursorSpawnOptions)
    cleanups.push(uninstall)
  }

  // 5b. Pre-set conversation modes — written to conversations.json (legacy
  // file) so the SQLite migration in conversation-store picks them up at
  // boot. Without this, every chat defaults to solo+claude regardless of
  // what the test wants to exercise. Shape mirrors the v0.x persistence:
  // `{ conversations: { <chatId>: { mode: <mode> } } }`.
  if (opts.modes && Object.keys(opts.modes).length > 0) {
    const conversations: Record<string, { mode: unknown }> = {}
    for (const [chatId, mode] of Object.entries(opts.modes)) {
      conversations[chatId] = { mode }
    }
    writeFileSync(join(stateDir, 'conversations.json'), JSON.stringify({ conversations }, null, 2))
  }

  // 6. Override env to point daemon at test stateDir.
  // WECHAT_CC_STATE_DIR is read by main.ts; WECHAT_STATE_DIR is read by
  // config.ts (send-reply.ts, access.ts, log.ts) which are module-level
  // singletons — but they DO re-read from disk each call (sendReplyOnce
  // passes stateDir arg or reads from the env-resolved STATE_DIR).
  // Setting both ensures the routing files (context_tokens, user_account_ids)
  // are written and read from the same directory.
  const origStateDir = process.env.WECHAT_CC_STATE_DIR
  const origWechatStateDir = process.env.WECHAT_STATE_DIR
  process.env.WECHAT_CC_STATE_DIR = stateDir
  process.env.WECHAT_STATE_DIR = stateDir
  let argvAdded = false
  if (opts.dangerously && !process.argv.includes('--dangerously')) {
    process.argv.push('--dangerously')
    argvAdded = true
  }

  // 7. Boot daemon via exported bootDaemon — no SIGTERM needed for shutdown.
  // NOTE: import is dynamic so vi.mock has time to register before SDK loads.
  const { bootDaemon } = await import('../main')
  const daemonHandle = await bootDaemon({ stateDir, dangerously: opts.dangerously ?? false })

  // Give polling loop a moment to spin up.
  await new Promise(r => setTimeout(r, 50))

  const defaultBotId = accounts[0]?.botId ?? 'bot1'

  return {
    ilink,
    stateDir,
    sendText(chatId, text, sendOpts) {
      const update: RawUpdate = {
        message_id: nextMessageId(),
        from_user_id: chatId,
        to_user_id: sendOpts?.toUserId ?? defaultBotId,
        create_time_ms: sendOpts?.createTimeMs ?? Date.now(),
        message_type: 1,
        message_state: 2,
        item_list: [{ type: 1, msg_id: `m${nextMessageId()}`, text_item: { text } }],
        // Mirror real ilink: every inbound carries context_token. Tests that
        // want to exercise the missing-token path can pass `contextToken: ''`
        // explicitly. Without a default, assertChatRoutable would reject
        // every reply at preflight (fix/v0.5.18 tightened the guard).
        context_token: sendOpts?.contextToken ?? `ctx-${chatId}`,
      }
      if (process.env.E2E_DEBUG_ILINK) console.log('[harness] sendText enqueue:', JSON.stringify(update).slice(0, 200))
      ilink.enqueueInbound(update)
    },
    sendImage(chatId, sendOpts) {
      // RawUpdate item.type=2 carries an image_item.media object that
      // poll-loop JSON.stringifies into the attachment caption. The
      // fake-media mock then rewrites <pending-cdn-ref> to a real local
      // path before mw-attachments runs in the inbound pipeline.
      const update: RawUpdate = {
        message_id: nextMessageId(),
        from_user_id: chatId,
        to_user_id: sendOpts?.toUserId ?? defaultBotId,
        create_time_ms: sendOpts?.createTimeMs ?? Date.now(),
        message_type: 1,
        message_state: 2,
        item_list: [{
          type: 2,
          msg_id: `m${nextMessageId()}`,
          image_item: { media: { full_url: 'fake://e2e-image' } },
        }],
        context_token: sendOpts?.contextToken ?? `ctx-${chatId}`,
      }
      if (process.env.E2E_DEBUG_ILINK) console.log('[harness] sendImage enqueue:', JSON.stringify(update).slice(0, 200))
      ilink.enqueueInbound(update)
    },
    waitForReplyTo(chatId, timeoutMs = 5000) {
      return ilink.waitForOutbound(
        msgs => msgs.some(m => m.endpoint === 'sendmessage' && m.chatId === chatId),
        timeoutMs,
      )
    },
    waitForOutbound(predicate, timeoutMs = 5000) {
      return ilink.waitForOutbound(predicate, timeoutMs)
    },
    async stop() {
      // Shut down via DaemonHandle — no SIGTERM, safe in test runner.
      await daemonHandle.shutdown()
      cleanups.forEach(fn => fn())
      if (origStateDir === undefined) delete process.env.WECHAT_CC_STATE_DIR
      else process.env.WECHAT_CC_STATE_DIR = origStateDir
      if (origWechatStateDir === undefined) delete process.env.WECHAT_STATE_DIR
      else process.env.WECHAT_STATE_DIR = origWechatStateDir
      if (argvAdded) {
        const idx = process.argv.indexOf('--dangerously')
        if (idx >= 0) process.argv.splice(idx, 1)
      }
      try { await ilink.stop() } catch {}
      if (ownsStateDir) {
        try { rmSync(stateDir, { recursive: true, force: true }) } catch {}
      }
    },
  }
}
