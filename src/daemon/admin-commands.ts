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
import type { InboundMsg } from '../core/prompt-format'
import type { ProviderRegistry } from '../core/provider-registry'
import type { SessionManager } from '../core/session-manager'
import type { SessionStore } from '../core/session-store'
import type { SessionStateStore, ExpiredBot } from './session-state'
import { loadHearthApi, type HearthApi, type HearthLoadResult } from './hearth-adapter'

export interface AdminCommandsDeps {
  stateDir: string
  isAdmin: (chatId: string) => boolean
  sessionState: SessionStateStore
  pollHandle: {
    stopAccount: (id: string) => void
    stopAccountAndWait: (id: string) => Promise<void>
    running: () => string[]
  }
  resolveUserName: (chatId: string) => string | undefined
  sendMessage: (chatId: string, text: string) => Promise<{ msgId: string; error?: string }>
  /** Optional. When wired, /hearth ingest publishes the plan as a share-page card. */
  sharePage?: (title: string, content: string, opts?: { needs_approval?: boolean; chat_id?: string; account_id?: string }) => Promise<{ url: string; slug: string }>
  /** Optional loader for tests; production discovers hearth lazily. */
  loadHearthApi?: () => Promise<HearthLoadResult>
  log: (tag: string, line: string) => void
  /** ISO timestamp when the daemon booted (for uptime display). */
  startedAt: string
  /** chatId → project alias resolver; same lookup the coordinator uses. */
  resolveProject: (chatId: string) => { alias: string; path: string } | null
  registry: Pick<ProviderRegistry, 'list'>
  sessionManager: Pick<SessionManager, 'release' | 'list'>
  sessionStore: Pick<SessionStore, 'get' | 'delete'>
}

export interface AdminCommands {
  /** Returns true iff the message was consumed (admin command handled or silently dropped). */
  handle(msg: InboundMsg): Promise<boolean>
}

const CLEANUP_RE = /^\s*清理\s*(all-expired|所有过期|[a-zA-Z0-9-]+-im-bot)\s*$/
const HEARTH_INGEST_RE = /^\s*\/hearth\s+ingest(?:\s+([\s\S]+))?$/
const HEARTH_LIST_RE = /^\s*\/hearth\s+list\s*$/
const HEARTH_SHOW_RE = /^\s*\/hearth\s+show\s+([A-Za-z0-9_-]+)\s*$/
const HEARTH_APPLY_RE = /^\s*\/hearth\s+apply\s+([A-Za-z0-9_-]+)\s*$/
const HEARTH_HELP_RE = /^\s*\/hearth(\s+help)?\s*$/
// /reset and the Chinese alias /重置 both drop the current chat's AI sessions
// (every registered provider) so the next dispatch starts from a fresh
// subprocess + clean keychain read. Emergency recovery hatch for the operator
// when the desktop dashboard isn't reachable.
const RESET_RE = /^\s*\/(?:reset|重置)\s*$/
// /health ai is the AI-side companion of /health: per-provider session state
// for the current chat. Does not run the underlying CLIs (zero token, zero
// network) — just inspects the daemon's own bookkeeping.
const HEALTH_AI_RE = /^\s*\/health\s+ai\s*$/

export function makeAdminCommands(deps: AdminCommandsDeps): AdminCommands {
  return {
    async handle(msg) {
      const text = msg.text.trim()
      const isCmd = text === '/health' || HEALTH_AI_RE.test(text) || RESET_RE.test(text) || CLEANUP_RE.test(text) || HEARTH_INGEST_RE.test(text) || HEARTH_LIST_RE.test(text) || HEARTH_SHOW_RE.test(text) || HEARTH_APPLY_RE.test(text) || HEARTH_HELP_RE.test(text)
      if (!isCmd) return false

      if (!deps.isAdmin(msg.chatId)) {
        deps.log('ADMIN_CMD', `non-admin ${msg.chatId} sent "${text.slice(0, 30)}" — dropped`)
        return true
      }

      if (text === '/health') {
        await sendHealthReport(deps, msg.chatId)
        return true
      }

      if (HEALTH_AI_RE.test(text)) {
        await sendAiHealthReport(deps, msg.chatId)
        return true
      }

      if (RESET_RE.test(text)) {
        await runReset(deps, msg.chatId)
        return true
      }

      const cleanup = CLEANUP_RE.exec(text)
      if (cleanup) {
        await runCleanup(deps, msg.chatId, cleanup[1]!)
        return true
      }

      const hearthIngest = HEARTH_INGEST_RE.exec(text)
      if (hearthIngest) {
        await runHearthIngest(deps, msg, hearthIngest[1] ?? '')
        return true
      }

      if (HEARTH_LIST_RE.test(text)) {
        await runHearthList(deps, msg.chatId)
        return true
      }

      const hearthShow = HEARTH_SHOW_RE.exec(text)
      if (hearthShow) {
        await runHearthShow(deps, msg.chatId, hearthShow[1]!)
        return true
      }

      const hearthApply = HEARTH_APPLY_RE.exec(text)
      if (hearthApply) {
        await runHearthApply(deps, msg, hearthApply[1]!)
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
  const hearth = await getHearthOrReply(deps, msg.chatId)
  if (!hearth) return
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
    const result = await hearth.ingestFromChannel(
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
      ]
      // If the daemon is wired with share_page, publish a richer review card
      // and surface the URL alongside. The plan stays in pending either way —
      // share is a presentation surface, not a commit step.
      if (deps.sharePage && result.change_id) {
        try {
          const md = hearth.renderPlanMarkdown(result.change_id, { hearthStateDir: join(homedir(), '.hearth') })
          if (md.ok) {
            const card = await deps.sharePage(md.title ?? 'Hearth ChangePlan', md.markdown, {
              needs_approval: true,
              chat_id: msg.chatId,
            })
            lines.push('', '📄 review: ' + card.url)
          }
        } catch (err) {
          deps.log('HEARTH', `share_page failed: ${err instanceof Error ? err.message : err}`)
        }
      }
      lines.push('', '↪ apply: /hearth apply ' + result.change_id)
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

async function runHearthList(deps: AdminCommandsDeps, adminChatId: string): Promise<void> {
  const hearth = await getHearthOrReply(deps, adminChatId)
  if (!hearth) return
  try {
    const r = hearth.listPending({ hearthStateDir: join(homedir(), '.hearth'), limit: 10 })
    await deps.sendMessage(adminChatId, r.rendered)
    deps.log('HEARTH', `${adminChatId} list — ${r.items.length} shown`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    await deps.sendMessage(adminChatId, '❌ /hearth list 异常: ' + detail.slice(0, 500))
  }
}

async function runHearthShow(deps: AdminCommandsDeps, adminChatId: string, changeId: string): Promise<void> {
  const hearth = await getHearthOrReply(deps, adminChatId)
  if (!hearth) return
  try {
    const r = hearth.showPending(changeId, { hearthStateDir: join(homedir(), '.hearth') })
    await deps.sendMessage(adminChatId, r.rendered)
    deps.log('HEARTH', `${adminChatId} show ${changeId} ok=${r.ok}`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    await deps.sendMessage(adminChatId, '❌ /hearth show 异常: ' + detail.slice(0, 500))
  }
}

async function runHearthApply(deps: AdminCommandsDeps, msg: InboundMsg, changeId: string): Promise<void> {
  const hearth = await getHearthOrReply(deps, msg.chatId)
  if (!hearth) return
  const vault = process.env.HEARTH_VAULT
  if (!vault) {
    await deps.sendMessage(msg.chatId, '❌ HEARTH_VAULT 未设置')
    return
  }
  try {
    const r = await hearth.applyForOwner(changeId, {
      vaultRoot: vault,
      hearthStateDir: join(homedir(), '.hearth'),
      ownerId: msg.chatId,
      channel: 'wechat',
    })
    await deps.sendMessage(msg.chatId, r.rendered)
    deps.log('HEARTH', `${msg.chatId} apply ${changeId} ok=${r.ok}`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    await deps.sendMessage(msg.chatId, '❌ /hearth apply 异常: ' + detail.slice(0, 500))
  }
}

async function getHearthOrReply(deps: AdminCommandsDeps, chatId: string): Promise<HearthApi | null> {
  const loaded = await (deps.loadHearthApi ?? loadHearthApi)()
  if (loaded.ok) return loaded.api

  const detail = loaded.error ? `\n详情: ${loaded.error.slice(0, 300)}` : ''
  await deps.sendMessage(chatId, [
    '❌ hearth 未安装或未配置，wechat-cc 其他功能不受影响。',
    '',
    '可选配置：',
    '  export HEARTH_HOME=/path/to/hearth',
    '  export HEARTH_MODULE=hearth',
    '  export HEARTH_VAULT=/path/to/vault',
    '',
    '然后重启 wechat-cc，再使用 /hearth。' + detail,
  ].join('\n'))
  deps.log('HEARTH', `not available reason=${loaded.reason} checked=${loaded.checked.join(', ')}`)
  return null
}

async function sendHearthHelp(deps: AdminCommandsDeps, adminChatId: string): Promise<void> {
  const vault = process.env.HEARTH_VAULT ?? '(未设置 HEARTH_VAULT)'
  const agent = process.env.HEARTH_AGENT === 'claude' ? 'claude' : 'mock'
  const lines = [
    '🔥 hearth (v0.3.1 channel review surface)',
    '',
    'vault: ' + vault,
    'agent: ' + agent,
    '',
    '命令：',
    '  /hearth ingest <text>      把 text 喂给 hearth，生成 pending ChangePlan',
    '  /hearth list               看一下当前 pending 队列',
    '  /hearth show <change_id>   预览某一份 ChangePlan',
    '  /hearth apply <change_id>  apply 到 vault（owner 直发即授权）',
    '  /hearth                    显示这条 help',
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
      // Await the loop's full unwind before rmSync — otherwise the
      // background poll's still-open long-poll fetch may try to
      // re-read state from the account dir we're about to delete,
      // racing with rmSync. Replaces the fire-and-forget stopAccount.
      await deps.pollHandle.stopAccountAndWait(v.id)
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

async function runReset(deps: AdminCommandsDeps, adminChatId: string): Promise<void> {
  const proj = deps.resolveProject(adminChatId)
  if (!proj) {
    await deps.sendMessage(adminChatId, '❌ 本聊天未绑定任何项目，没有可重置的会话。')
    return
  }
  // Release every registered provider's in-memory session for this alias,
  // then wipe the persisted resume-id row so the next dispatch is a clean
  // start. Releasing release() is idempotent (no-op if nothing cached).
  const providers = deps.registry.list()
  for (const p of providers) {
    try {
      await deps.sessionManager.release(proj.alias, p)
    } catch (err) {
      deps.log('ADMIN_CMD', `/reset release ${proj.alias}/${p} failed: ${err instanceof Error ? err.message : err}`)
    }
  }
  deps.sessionStore.delete(proj.alias)
  deps.log('ADMIN_CMD', `/reset chat=${adminChatId} alias=${proj.alias} providers=${providers.join(',')}`)
  await deps.sendMessage(
    adminChatId,
    `✓ 已重置 AI 会话\n  chat: ${adminChatId}\n  project: ${proj.alias}\n  providers: ${providers.join(', ') || '(无)'}\n\n下一条消息会从干净状态开始。`,
  )
}

async function sendAiHealthReport(deps: AdminCommandsDeps, adminChatId: string): Promise<void> {
  const proj = deps.resolveProject(adminChatId)
  if (!proj) {
    await deps.sendMessage(adminChatId, '❌ 本聊天未绑定任何项目，无法查询 AI 会话状态。')
    return
  }
  const providers = deps.registry.list()
  const lines: string[] = ['🤖 AI 会话状态', `project: ${proj.alias}`, '']
  if (providers.length === 0) {
    lines.push('(无已注册的 provider — 检查 daemon 启动日志)')
  } else {
    for (const p of providers) {
      const rec = deps.sessionStore.get(proj.alias, p)
      if (rec) {
        const age = humanAge(Date.parse(rec.last_used_at))
        lines.push(`  ${p}: 会话 ${rec.session_id.slice(0, 8)}… (${age} 前)`)
      } else {
        lines.push(`  ${p}: 无会话`)
      }
    }
  }
  lines.push('', '重置：/reset  （丢掉所有 provider 的会话，下一条从头开始）')
  await deps.sendMessage(adminChatId, lines.join('\n'))
}

/** "5m ago" style — minutes / hours / days. Returns "<1m" for sub-minute. */
function humanAge(parsedAtMs: number): string {
  if (Number.isNaN(parsedAtMs)) return '?'
  const sec = Math.floor((Date.now() - parsedAtMs) / 1000)
  if (sec < 60) return '<1m'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function hoursSince(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  if (Number.isNaN(ms) || ms < 0) return '?h'
  const h = Math.floor(ms / 3_600_000)
  if (h < 1) return '<1h'
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}
