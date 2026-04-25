/**
 * Admin-only commands intercepted BEFORE routing to Claude:
 *   /health                    — report active + expired bots, session pool, uptime
 *   清理 <bot-id>               — remove one expired bot
 *   清理所有过期                 — remove every bot currently flagged expired
 *
 * Non-admin senders get silently dropped (matches the /project command
 * behaviour in the legacy server.ts). Admin check goes through
 * access.ts::isAdmin so admins + allowFrom fallback both work.
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { ingestFromChannel } from 'hearth'
import type { InboundMsg } from '../core/prompt-format'
import type { SessionStateStore, ExpiredBot } from './session-state'

export interface AdminCommandsDeps {
  stateDir: string
  isAdmin: (chatId: string) => boolean
  sessionState: SessionStateStore
  pollHandle: { stopAccount: (id: string) => void; running: () => string[] }
  resolveUserName: (chatId: string) => string | undefined
  sendMessage: (chatId: string, text: string) => Promise<{ msgId: string; error?: string }>
  log: (tag: string, line: string) => void
  /** ISO timestamp when the daemon booted (for uptime display). */
  startedAt: string
}

export interface AdminCommands {
  /** Returns true iff the message was consumed (admin command handled or silently dropped). */
  handle(msg: InboundMsg): Promise<boolean>
}

const CLEANUP_RE = /^\s*清理\s*(all-expired|所有过期|[a-zA-Z0-9-]+-im-bot)\s*$/
const HEARTH_INGEST_RE = /^\s*\/hearth\s+ingest\s+([\s\S]+)$/
const HEARTH_HELP_RE = /^\s*\/hearth(\s+help)?\s*$/

export function makeAdminCommands(deps: AdminCommandsDeps): AdminCommands {
  return {
    async handle(msg) {
      const text = msg.text.trim()
      const isCmd = text === '/health' || CLEANUP_RE.test(text) || HEARTH_INGEST_RE.test(text) || HEARTH_HELP_RE.test(text)
      if (!isCmd) return false

      if (!deps.isAdmin(msg.chatId)) {
        deps.log('ADMIN_CMD', `non-admin ${msg.chatId} sent "${text.slice(0, 30)}" — dropped`)
        return true
      }

      if (text === '/health') {
        await sendHealthReport(deps, msg.chatId)
        return true
      }

      const cleanup = CLEANUP_RE.exec(text)
      if (cleanup) {
        await runCleanup(deps, msg.chatId, cleanup[1]!)
        return true
      }

      const hearthIngest = HEARTH_INGEST_RE.exec(text)
      if (hearthIngest) {
        await runHearthIngest(deps, msg, hearthIngest[1]!)
        return true
      }

      if (HEARTH_HELP_RE.test(text)) {
        await sendHearthHelp(deps, msg.chatId)
        return true
      }

      return false
    },
  }
}

async function runHearthIngest(deps: AdminCommandsDeps, msg: InboundMsg, content: string): Promise<void> {
  const vault = process.env.HEARTH_VAULT
  if (!vault) {
    await deps.sendMessage(msg.chatId, '❌ HEARTH_VAULT 未设置。daemon 启动时加 env：HEARTH_VAULT=/path/to/vault')
    return
  }
  const agent = (process.env.HEARTH_AGENT === 'claude' ? 'claude' : 'mock') as 'mock' | 'claude'
  const trimmed = content.trim()
  if (trimmed.length === 0) {
    await deps.sendMessage(msg.chatId, '用法：/hearth ingest <text>  （把 text 喂给 hearth ingest，落到 pending）')
    return
  }
  try {
    const result = await ingestFromChannel(
      {
        channel: 'wechat',
        message_id: `wechat-${msg.accountId}-${Date.now()}`,
        from: msg.chatId,
        text: trimmed,
        received_at: new Date(msg.createTimeMs || Date.now()).toISOString(),
      },
      { vaultRoot: vault, agent, hearthStateDir: join(homedir(), '.hearth') },
    )
    if (result.ok) {
      const lines = [
        '🔥 hearth: ' + result.summary,
        '',
        `source: ${result.source_path}`,
      ]
      if (result.requires_review) lines.push('💡 这是一个 ChangePlan，apply 之前在 CLI 跑：hearth pending show ' + result.change_id)
      await deps.sendMessage(msg.chatId, lines.join('\n'))
    } else {
      await deps.sendMessage(msg.chatId, '❌ hearth ingest 失败: ' + result.summary + (result.error ? '\n详情: ' + result.error.slice(0, 500) : ''))
    }
    deps.log('HEARTH', `${msg.chatId} ingest agent=${agent} ok=${result.ok}`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    await deps.sendMessage(msg.chatId, '❌ hearth ingest 异常: ' + detail.slice(0, 500))
    deps.log('HEARTH', `ingest threw: ${detail}`)
  }
}

async function sendHearthHelp(deps: AdminCommandsDeps, adminChatId: string): Promise<void> {
  const vault = process.env.HEARTH_VAULT ?? '(未设置 HEARTH_VAULT)'
  const agent = process.env.HEARTH_AGENT === 'claude' ? 'claude' : 'mock'
  const lines = [
    '🔥 hearth (v0.3.0 channel adapter spike)',
    '',
    'vault: ' + vault,
    'agent: ' + agent,
    '',
    '命令：',
    '  /hearth ingest <text>   把 text 喂给 hearth，生成 pending ChangePlan',
    '  /hearth                 显示这条 help',
    '',
    'apply / list / show 走 CLI（v0.3.1 会上 wechat 内 /hearth list/apply）：',
    '  hearth pending list',
    '  hearth pending show <change_id>',
    '  hearth pending apply <change_id> --vault ' + vault,
  ]
  await deps.sendMessage(adminChatId, lines.join('\n'))
}

async function sendHealthReport(deps: AdminCommandsDeps, adminChatId: string): Promise<void> {
  const active = deps.pollHandle.running()
  const expired = deps.sessionState.listExpired()

  const lines: string[] = ['🩺 daemon 健康']
  lines.push(`启动时间: ${deps.startedAt}`)
  lines.push('')

  lines.push(`活跃 bot (${active.length}):`)
  if (active.length === 0) lines.push('  (无 — 需要 wechat-cc setup)')
  else for (const id of active) lines.push(`  ✅ ${id}`)

  if (expired.length > 0) {
    lines.push('')
    lines.push(`⚠️ 过期 bot (${expired.length}):`)
    for (const e of expired) lines.push(`  - ${e.id} (${hoursSince(e.first_seen_expired_at)})`)
    lines.push('')
    lines.push('清理：')
    lines.push(`  "清理 ${expired[0]!.id}"  (单个)`)
    lines.push('  "清理所有过期"            (全部)')
  } else {
    lines.push('')
    lines.push('✨ 无过期 bot')
  }

  const result = await deps.sendMessage(adminChatId, lines.join('\n'))
  if (result.error) {
    deps.log('ADMIN_CMD', `/health reply to ${adminChatId} failed: ${result.error}`)
  }
}

async function runCleanup(deps: AdminCommandsDeps, adminChatId: string, target: string): Promise<void> {
  const expired = deps.sessionState.listExpired()
  let victims: ExpiredBot[]

  if (target === 'all-expired' || target === '所有过期') {
    victims = expired
  } else {
    const match = expired.find(e => e.id === target)
    if (!match) {
      await deps.sendMessage(adminChatId, `❌ ${target} 不在过期列表里。先发 /health 确认。`)
      return
    }
    victims = [match]
  }

  if (victims.length === 0) {
    await deps.sendMessage(adminChatId, '没有过期 bot 需要清理。')
    return
  }

  const results: string[] = []
  for (const v of victims) {
    try {
      deps.pollHandle.stopAccount(v.id)
      rmSync(join(deps.stateDir, 'accounts', v.id), { recursive: true, force: true })
      deps.sessionState.clear(v.id)
      results.push(`  ✓ ${v.id}`)
      deps.log('ADMIN_CMD', `cleaned up expired bot ${v.id}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push(`  ❌ ${v.id}: ${msg}`)
      deps.log('ADMIN_CMD', `cleanup ${v.id} failed: ${msg}`)
    }
  }

  await deps.sendMessage(adminChatId, [
    `清理完成 (${victims.length}):`,
    ...results,
    '',
    '重扫：wechat-cc setup',
  ].join('\n'))
}

function hoursSince(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  if (Number.isNaN(ms) || ms < 0) return '?h'
  const h = Math.floor(ms / 3_600_000)
  if (h < 1) return '<1h'
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}
