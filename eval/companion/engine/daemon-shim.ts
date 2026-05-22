/**
 * Eval-harness daemon boot. Mirrors src/daemon/__e2e__/harness.ts but:
 *   - never installs a fake SDK (real claude / codex subprocesses)
 *   - exposes daemonHandle.fireTick (Task 3) to the engine
 *   - returns the raw stateDir so the engine can seed memory files +
 *     observations BEFORE the daemon boots (avoids races with introspect)
 *
 * Side-effect import of '../../../src/daemon/__e2e__/fake-media' replaces
 * materializeAttachments with a local-file stub so eval doesn't hit the
 * ilink CDN. Real CDN access from a regression test would be flaky and slow.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startFakeIlink, type FakeIlinkHandle, type OutboundMsg } from '../../../src/daemon/__e2e__/fake-ilink-server'
import '../../../src/daemon/__e2e__/fake-media'
import type { RawUpdate } from '../../../src/daemon/poll-loop'
import type { DaemonHandle } from '../../../src/daemon/main'
import { SAFE_INFINITY_MS } from './clock'

export interface EvalDaemonOpts {
  /** chatId → user_name. Populates user_names.json so onboarding is skipped. */
  knownUsers: Record<string, string>
  /** Initial companion config (passed straight through; eval always wants enabled=true). */
  companion: { enabled: boolean; default_chat_id: string }
}

export interface EvalDaemon {
  ilink: FakeIlinkHandle
  stateDir: string
  daemonHandle: DaemonHandle
  sendText(chatId: string, text: string, opts?: { createTimeMs?: number }): void
  waitForReplyTo(chatId: string, timeoutMs?: number): Promise<readonly OutboundMsg[]>
  /** Snapshot of all outbound messages routed to chatId so far. */
  outboundFor(chatId: string): readonly OutboundMsg[]
  stop(): Promise<void>
}

let messageIdCounter = 1
function nextMessageId(): number { return messageIdCounter++ }

export async function startEvalDaemon(opts: EvalDaemonOpts): Promise<EvalDaemon> {
  const ilink = await startFakeIlink()
  const stateDir = mkdtempSync(join(tmpdir(), 'wechat-cc-eval-'))
  mkdirSync(join(stateDir, 'inbox'), { recursive: true })
  mkdirSync(join(stateDir, 'memory'), { recursive: true })
  mkdirSync(join(stateDir, 'accounts', 'bot1'), { recursive: true })

  writeFileSync(join(stateDir, 'access.json'), JSON.stringify({
    allowFrom: ['*'], admins: ['evaladmin'],
  }, null, 2))

  writeFileSync(join(stateDir, 'accounts', 'bot1', 'account.json'), JSON.stringify({
    botId: 'bot1', userId: 'owner1', baseUrl: ilink.baseUrl,
  }, null, 2))
  writeFileSync(join(stateDir, 'accounts', 'bot1', 'token'), 'fake-token')

  writeFileSync(join(stateDir, 'user_names.json'), JSON.stringify(opts.knownUsers))
  const userAccountIds: Record<string, string> = {}
  for (const chatId of Object.keys(opts.knownUsers)) userAccountIds[chatId] = 'bot1'
  writeFileSync(join(stateDir, 'user_account_ids.json'), JSON.stringify(userAccountIds))

  mkdirSync(join(stateDir, 'companion'), { recursive: true })
  writeFileSync(join(stateDir, 'companion', 'config.json'), JSON.stringify({
    enabled: opts.companion.enabled,
    default_chat_id: opts.companion.default_chat_id,
    snooze_until: null,
    last_introspect_at: null,
    timezone: 'UTC',
  }, null, 2))

  const origStateDir = process.env.WECHAT_CC_STATE_DIR
  const origWechatStateDir = process.env.WECHAT_STATE_DIR
  process.env.WECHAT_CC_STATE_DIR = stateDir
  process.env.WECHAT_STATE_DIR = stateDir

  const { bootDaemon } = await import('../../../src/daemon/main')
  const daemonHandle = await bootDaemon({
    stateDir,
    dangerously: false,
    schedulerIntervalMs: SAFE_INFINITY_MS,
  })

  await new Promise(r => setTimeout(r, 50))

  return {
    ilink,
    stateDir,
    daemonHandle,
    sendText(chatId, text, sendOpts) {
      const update: RawUpdate = {
        message_id: nextMessageId(),
        from_user_id: chatId,
        to_user_id: 'bot1',
        create_time_ms: sendOpts?.createTimeMs ?? Date.now(),
        message_type: 1,
        message_state: 2,
        item_list: [{ type: 1, msg_id: `m${nextMessageId()}`, text_item: { text } }],
        context_token: `ctx-${chatId}`,
      }
      ilink.enqueueInbound(update)
    },
    waitForReplyTo(chatId, timeoutMs = 120_000) {
      return ilink.waitForOutbound(
        msgs => msgs.some(m => m.endpoint === 'sendmessage' && m.chatId === chatId),
        timeoutMs,
      )
    },
    outboundFor(chatId) {
      return ilink.outbox().filter(m => m.endpoint === 'sendmessage' && m.chatId === chatId)
    },
    async stop() {
      await daemonHandle.shutdown()
      if (origStateDir === undefined) delete process.env.WECHAT_CC_STATE_DIR
      else process.env.WECHAT_CC_STATE_DIR = origStateDir
      if (origWechatStateDir === undefined) delete process.env.WECHAT_STATE_DIR
      else process.env.WECHAT_STATE_DIR = origWechatStateDir
      try { await ilink.stop() } catch { /* ignore */ }
      try { rmSync(stateDir, { recursive: true, force: true }) } catch { /* ignore */ }
    },
  }
}
