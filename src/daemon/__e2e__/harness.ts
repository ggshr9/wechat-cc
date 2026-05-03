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
import { installFakeClaude, installFakeCodex, type FakeSdkScript } from './fake-sdk'
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
  /** --dangerously flag */
  dangerously?: boolean
  /** preset access.json — default: allowFrom: ['*'], admins: ['testadmin'] */
  access?: { allowFrom?: string[]; admins?: string[] }
  /** preset companion config — default: disabled */
  companion?: { enabled?: boolean; default_chat_id?: string }
  /** preset bot accounts — default: 1 fake bot pointing at fake ilink */
  accounts?: TestDaemonAccount[]
}

export interface DaemonHandle {
  ilink: FakeIlinkHandle
  stateDir: string
  /** Enqueue a text inbound from chatId (default to_user_id is 'bot1'). */
  sendText(chatId: string, text: string, opts?: { contextToken?: string; createTimeMs?: number; toUserId?: string }): void
  /** Wait until outbox has a sendmessage to this chatId. */
  waitForReplyTo(chatId: string, timeoutMs?: number): Promise<readonly OutboundMsg[]>
  /** Stop daemon (signals SIGTERM equivalent), clean up stateDir. */
  stop(): Promise<void>
}

let messageIdCounter = 1
function nextMessageId(): number { return messageIdCounter++ }

export async function startTestDaemon(opts: TestDaemonOpts = {}): Promise<DaemonHandle> {
  // 1. Set up fake ilink + temp stateDir
  const ilink = await startFakeIlink()
  const stateDir = mkdtempSync(join(tmpdir(), 'wechat-cc-e2e-'))
  mkdirSync(join(stateDir, 'inbox'), { recursive: true })
  mkdirSync(join(stateDir, 'memory'), { recursive: true })
  mkdirSync(join(stateDir, 'accounts'), { recursive: true })

  // 2. Write access.json
  const access = {
    allowFrom: opts.access?.allowFrom ?? ['*'],
    admins: opts.access?.admins ?? ['testadmin'],
  }
  writeFileSync(join(stateDir, 'access.json'), JSON.stringify(access, null, 2))

  // 3. Write fake bot account(s)
  const accounts: TestDaemonAccount[] = opts.accounts ?? [{
    id: 'bot1', botId: 'bot1', userId: 'owner1',
    baseUrl: ilink.baseUrl, token: 'fake-token', syncBuf: '',
  }]
  for (const a of accounts) {
    writeFileSync(join(stateDir, 'accounts', `${a.id}.json`), JSON.stringify(a, null, 2))
  }

  // 4. Write companion config if provided
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

  // 6. Override env to point daemon at test stateDir
  const origStateDir = process.env.WECHAT_CC_STATE_DIR
  process.env.WECHAT_CC_STATE_DIR = stateDir
  let argvAdded = false
  if (opts.dangerously && !process.argv.includes('--dangerously')) {
    process.argv.push('--dangerously')
    argvAdded = true
  }

  // 7. Boot daemon — fire-and-forget. Daemon's polling loop will start
  // pulling from fake ilink within ~1s.
  // NOTE: import is dynamic so vi.mock has time to register before SDK loads.
  void import('../main').catch(err => {
    console.error('[e2e harness] daemon main() crashed:', err)
  })

  // Give the daemon a moment to start polling (typing call confirms ready).
  // Real production has a "ready" log line; tests poll the fake ilink for
  // any activity (which the daemon does on first inbound).
  await new Promise(r => setTimeout(r, 200))

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
        ...(sendOpts?.contextToken ? { context_token: sendOpts.contextToken } : {}),
      }
      ilink.enqueueInbound(update)
    },
    waitForReplyTo(chatId, timeoutMs = 5000) {
      return ilink.waitForOutbound(
        msgs => msgs.some(m => m.endpoint === 'sendmessage' && m.chatId === chatId),
        timeoutMs,
      )
    },
    async stop() {
      // Send SIGTERM equivalent — daemon's lifecycle.stopAll runs.
      // process.kill of self is acceptable in test context.
      try { process.kill(process.pid, 'SIGTERM') } catch {}
      await new Promise(r => setTimeout(r, 300))
      cleanups.forEach(fn => fn())
      if (origStateDir === undefined) delete process.env.WECHAT_CC_STATE_DIR
      else process.env.WECHAT_CC_STATE_DIR = origStateDir
      if (argvAdded) {
        const idx = process.argv.indexOf('--dangerously')
        if (idx >= 0) process.argv.splice(idx, 1)
      }
      try { await ilink.stop() } catch {}
      try { rmSync(stateDir, { recursive: true, force: true }) } catch {}
    },
  }
}
