/**
 * Admin-only commands intercepted BEFORE routing to Claude:
 *   /health                    — report active + expired bots, session pool, uptime
 *   清理 <bot-id>               — remove one expired bot
 *   清理所有过期                 — remove every bot currently flagged expired
 *   整理记忆 / 重新整理你对我的理解  — re-synthesize the overview memory from local Claude memory
 *
 * Non-admin senders get silently dropped (matches the /project command
 * behaviour in the legacy server.ts). Admin check goes through
 * access.ts::isAdmin so admins + allowFrom fallback both work.
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { NICKNAME_RE, NICKNAME_MAX_LEN } from './nickname'
import { isoFromMs } from '../lib/iso-time'
import type { InboundMsg } from '../core/prompt-format'
import type { ProviderRegistry } from '../core/provider-registry'
import type { SessionManager } from '../core/session-manager'
import type { SessionStore } from '../core/session-store'
import type { SessionStateStore, ExpiredBot } from './session-state'
import { loadHearthApi, type HearthApi, type HearthLoadResult } from './hearth-adapter'
import type { SynthesizeResult } from '../cli/memory-synthesis'

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
  getBotName: () => string | null
  setBotName: (name: string | null) => Promise<void>
  botNameFallback: (chatId: string) => string  // mode-derived; shown when bot_name is null
  /**
   * Optional. Re-synthesize the admin's "overview memory" from their local
   * Claude per-project memory, using the admin conversation's provider.
   * Wired in pipeline-deps where the registry + coordinator are in scope.
   */
  synthesizeMemory?: (adminChatId: string) => Promise<SynthesizeResult>
  /**
   * Optional. Read back the admin's synthesized overview ("CC 眼中的你") so they
   * can see what the bot currently understands about them. Returns null when no
   * overview has been synthesized yet. Wired in pipeline-deps.
   */
  readOverview?: (adminChatId: string) => Promise<string | null>
  /**
   * Optional. Delegate a task to a registered "hand" (another machine running
   * wechat-cc with A2A exec). Returns the hand's result, or a list of known
   * hands when the name doesn't resolve. Wired in pipeline-deps.
   */
  delegateToHand?: (handName: string, task: string) => Promise<
    { ok: true; response: string } | { ok: false; reason: string; knownHands?: string[] }
  >
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
// Re-synthesize the overview memory ("CC 眼中的你") from local Claude memory.
// Natural-language Chinese phrasings + slash aliases — the admin just asks the
// bot to refresh its understanding.
const SYNTHESIZE_RE = /^\s*(?:\/(?:synthesize|整理记忆)|重新整理记忆|整理一下记忆|整理记忆|重新整理你对我的理解|更新你对我的理解|更新记忆)\s*$/
// READ BACK the synthesized overview — show the admin what the bot understands
// about them. Distinct from SYNTHESIZE_RE (which *regenerates*): these are
// "show me", anchored so they don't collide with the 重新整理/更新 phrasings.
const SHOW_OVERVIEW_RE = /^\s*(?:\/overview|你对我的理解|看看你对我的理解|你眼中的我|你怎么(?:理解|看)我|你记得我(?:什么|啥)|查看记忆|看一下记忆|看下记忆|看记忆)\s*[?？]?\s*$/
// 让/派 <hand> 执行/跑 <task> — delegate a task to another machine ("hand").
// 让/派 (imperative) + 执行/跑 keeps casual speech from matching; an unknown
// hand name still replies with the known list (doubles as discovery).
const DELEGATE_RE = /^\s*(?:让|派)\s*(\S+?)\s*(?:执行|跑)\s*[:：]?\s*(\S[\s\S]*?)\s*$/
// Pronouns aren't hand names — without this, casual speech like "让我执行一下X"
// or "让它跑起来" would be hijacked as a delegate command (and reply "没找到叫
// 「我」的手"). Excluding them lets such phrases fall through to normal chat;
// real hands are named 家里/公司/home etc., never a pronoun.
const DELEGATE_PRONOUNS = new Set(['我', '你', '您', '他', '她', '它', '咱', '俺', '我们', '你们', '他们', '她们', '它们', '咱们', '大家', '自己'])
export function isDelegateName(name: string): boolean {
  return !DELEGATE_PRONOUNS.has(name.trim())
}

// /botname <new-name>  — set the bot's user-facing self-name (admin only)
// /botname 跳过 / 不用 / 没有 / skip / clear / 清除  — clear (fall back to mode-derived)
// /botname             — show current
//
// NOTE: this is intentionally NOT `/name`. /name is the pre-existing
// user-self-rename command owned by mode-commands.ts:310-320 (PR2 #17 —
// "this user wants to be called X" → setUserName per-chat). Confusing
// the two would either silently swallow non-admin user-renames in
// mw-admin or accidentally redefine /name's meaning for admins. The
// rename to /botname is a deliberate disambiguation of the two scopes:
//   /name <X>     → per-chat user nickname (any sender, via mode-commands)
//   /botname <X>  → global bot self-name   (admin only, via this handler)
const BOTNAME_RE = /^\s*\/botname(?:\s+(.+?))?\s*$/
const BOTNAME_SKIP_WORDS = new Set(['跳过', '不用', '没有', 'skip', 'clear', '清除'])
// Same nickname constraint as onboarding + /name — sourced from ./nickname so
// the allowed set can't drift between them (was a hand-maintained duplicate).
const BOTNAME_VALID_RE = NICKNAME_RE
const BOTNAME_MAX_LEN = NICKNAME_MAX_LEN

export function makeAdminCommands(deps: AdminCommandsDeps): AdminCommands {
  return {
    async handle(msg) {
      const text = msg.text.trim()
      // Match the delegate trigger once — and only treat it as a command when
      // the name isn't a pronoun, so "让我执行一下X" falls through to normal chat.
      const delegateMatch = DELEGATE_RE.exec(text)
      const isDelegate = !!delegateMatch && isDelegateName(delegateMatch[1]!)
      const isCmd = text === '/health' || HEALTH_AI_RE.test(text) || SYNTHESIZE_RE.test(text) || SHOW_OVERVIEW_RE.test(text) || isDelegate || RESET_RE.test(text) || CLEANUP_RE.test(text) || HEARTH_INGEST_RE.test(text) || HEARTH_LIST_RE.test(text) || HEARTH_SHOW_RE.test(text) || HEARTH_APPLY_RE.test(text) || HEARTH_HELP_RE.test(text) || BOTNAME_RE.test(text)
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

      if (SHOW_OVERVIEW_RE.test(text)) {
        await runShowOverview(deps, msg.chatId)
        return true
      }

      if (SYNTHESIZE_RE.test(text)) {
        // Fire-and-forget: synthesis is a slow LLM call — don't block the
        // message pipeline. We ack now and reply with the result when done.
        void runSynthesize(deps, msg.chatId)
        return true
      }

      if (isDelegate) {
        // Fire-and-forget: the hand runs a full agent — slow. Ack + reply later.
        void runDelegate(deps, msg.chatId, delegateMatch![1]!.trim(), delegateMatch![2]!.trim())
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

      const botnameMatch = text.match(BOTNAME_RE)
      if (botnameMatch) {
        const arg = botnameMatch[1]?.trim()
        // /botname (no arg) — show current
        if (!arg) {
          const current = deps.getBotName()
          const display = current && current.trim() ? current.trim() : deps.botNameFallback(msg.chatId)
          await deps.sendMessage(msg.chatId, `我现在叫 ${display}`)
          return true
        }
        // /botname 跳过 — explicit clear
        if (BOTNAME_SKIP_WORDS.has(arg.toLowerCase())) {
          try {
            await deps.setBotName(null)
            const fallback = deps.botNameFallback(msg.chatId)
            await deps.sendMessage(msg.chatId, `好的，回到默认「${fallback}」`)
          } catch (err) {
            deps.log('ADMIN_CMD', `/botname clear failed: ${err}`)
            await deps.sendMessage(msg.chatId, '我没记住，稍后再试 /botname')
          }
          return true
        }
        // /botname <new-name> — validate + set
        if (arg.length > BOTNAME_MAX_LEN) {
          await deps.sendMessage(msg.chatId, `「${arg}」太长（最多 ${BOTNAME_MAX_LEN} 字符）。再试一次?`)
          return true
        }
        if (!BOTNAME_VALID_RE.test(arg)) {
          await deps.sendMessage(msg.chatId, `「${arg}」不行：只支持中文/字母/数字/空格/_/- (1-24 字)`)
          return true
        }
        try {
          await deps.setBotName(arg)
          await deps.sendMessage(msg.chatId, `好的，从现在开始我叫 ${arg}`)
        } catch (err) {
          deps.log('ADMIN_CMD', `/botname set failed: ${err}`)
          await deps.sendMessage(msg.chatId, '我没记住，稍后再试 /botname')
        }
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
        received_at: isoFromMs(msg.createTimeMs || Date.now(), Date.now()),
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

// Admin chats with a synthesis in flight — guards against a double-tap firing
// a second (paid) LLM run before the first replies.
const synthesizeInFlight = new Set<string>()

/**
 * Prepare the synthesized overview for a WeChat read-back: strip the machine
 * stamp comment synthesizeOverview prepends (`<!-- … · <iso> -->`) — which
 * would otherwise show as raw text in plain-text WeChat — and surface its
 * timestamp as a friendly "（整理于 …）" line instead.
 */
export function formatOverviewForDisplay(raw: string): string {
  const trimmed = raw.trim()
  const m = trimmed.match(/^<!--\s*([\s\S]*?)\s*-->\s*/)
  if (!m) return trimmed
  const body = trimmed.slice(m[0].length).trim()
  const tsM = m[1]!.match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/)
  const when = tsM ? `（整理于 ${new Date(tsM[1]!).toLocaleString()}）\n\n` : ''
  return `${when}${body}`
}

async function runShowOverview(deps: AdminCommandsDeps, adminChatId: string): Promise<void> {
  if (!deps.readOverview) {
    await deps.sendMessage(adminChatId, '记忆查看暂不可用（daemon 未接线）。').catch(() => {})
    return
  }
  try {
    const raw = (await deps.readOverview(adminChatId))?.trim()
    if (!raw) {
      await deps.sendMessage(adminChatId, '我还没整理过对你的理解。说「整理记忆」我就生成一份。')
      return
    }
    const display = formatOverviewForDisplay(raw)
    await deps.sendMessage(adminChatId, `🧠 我目前对你的理解：\n\n${display}`)
    deps.log('ADMIN_CMD', `show-overview chat=${adminChatId} bytes=${display.length}`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    await deps.sendMessage(adminChatId, `读取记忆失败：${detail.slice(0, 160)}`).catch(() => {})
    deps.log('ADMIN_CMD', `show-overview failed chat=${adminChatId}: ${detail}`)
  }
}

async function runSynthesize(deps: AdminCommandsDeps, adminChatId: string): Promise<void> {
  // Whole body is guarded: runSynthesize is dispatched fire-and-forget (the
  // pipeline doesn't await it), so ANY escaping rejection — including the
  // "整理中" ack send — would surface as an unhandled rejection.
  if (!deps.synthesizeMemory) {
    await deps.sendMessage(adminChatId, '记忆整理暂不可用（daemon 未接线）。').catch(() => {})
    return
  }
  if (synthesizeInFlight.has(adminChatId)) {
    await deps.sendMessage(adminChatId, '还在整理上一次，稍等一下…').catch(() => {})
    return
  }
  synthesizeInFlight.add(adminChatId)
  try {
    await deps.sendMessage(adminChatId, '🧠 正在重新整理我对你的理解…')
    const r = await deps.synthesizeMemory(adminChatId)
    let lines: string[]
    if (r.written) {
      lines = ['✅ 整理完成，我对你的理解已更新。']
      // Reflect BOTH sides — synthesis spans work (项目) and life (微信观察),
      // so show what got folded in, not just the project count.
      const parts: string[] = []
      if (r.projectsFound > 0) parts.push(`${r.projectsFound} 个项目（${r.projectNames.join('、')}）`)
      const life: string[] = []
      if (r.observationsFound > 0) life.push(`${r.observationsFound} 条观察`)
      if (r.milestonesFound > 0) life.push(`${r.milestonesFound} 个里程碑`)
      if (r.memoryNotesFound > 0) life.push(`${r.memoryNotesFound} 篇记忆笔记`)
      if (life.length) parts.push(`生活侧 ${life.join('、')}`)
      if (parts.length) lines.push(`综合了：${parts.join('；')}`)
    } else {
      lines = ['没找到可整理的记忆（本机项目记忆 + 微信生活观察都还是空的）。']
    }
    await deps.sendMessage(adminChatId, lines.join('\n'))
    deps.log('ADMIN_CMD', `synthesize chat=${adminChatId} projects=${r.projectsFound} written=${!!r.written}`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    await deps.sendMessage(adminChatId, `整理失败：${detail.slice(0, 160)}`).catch(() => {})
    deps.log('ADMIN_CMD', `synthesize failed chat=${adminChatId}: ${detail}`)
  } finally {
    synthesizeInFlight.delete(adminChatId)
  }
}

/**
 * Map the machine reason codes delegateToHand can surface into a short
 * human line for WeChat. Unknown reasons pass through (already-readable
 * messages, or codes worth seeing verbatim) so we never hide real errors.
 */
export function friendlyDelegateReason(reason: string): string {
  if (reason === 'paused') return '那台手当前已暂停。'
  if (reason === 'timeout' || /timed? ?out/i.test(reason)) return '那台手超时未响应(任务太久或离线)。'
  if (reason === 'malformed hand response') return '那台手返回了无法识别的结果。'
  if (/^http_401$|unauthorized/i.test(reason)) return '配对密钥不匹配,需要重新配对(hand invite / hand join)。'
  if (/^http_/.test(reason)) return `那台手返回错误(${reason})。`
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|network|abort/i.test(reason)) return '连不上那台手(检查它是否开机、A2A 是否在 Tailscale IP 上监听)。'
  return reason
}

async function runDelegate(deps: AdminCommandsDeps, adminChatId: string, handName: string, task: string): Promise<void> {
  if (!deps.delegateToHand) {
    await deps.sendMessage(adminChatId, '派活功能未启用(没配置 A2A / 没有可派的"手")。').catch(() => {})
    return
  }
  try {
    await deps.sendMessage(adminChatId, `🤝 派给「${handName}」执行中…`)
    const r = await deps.delegateToHand(handName, task)
    if (r.ok) {
      await deps.sendMessage(adminChatId, `「${handName}」的结果:\n${r.response}`)
    } else if (r.reason === 'unknown_hand') {
      // No hand by that name. If some are registered, list them (doubles as
      // discovery); if none are, guide the operator to pair one.
      await deps.sendMessage(adminChatId, r.knownHands && r.knownHands.length
        ? `没找到叫「${handName}」的手。已注册的:${r.knownHands.join('、')}`
        : '还没配对任何手。在那台机器上跑 wechat-cc hand invite,再在这台 hand join。')
    } else {
      await deps.sendMessage(adminChatId, `派活失败:${friendlyDelegateReason(r.reason)}`)
    }
    deps.log('ADMIN_CMD', `delegate chat=${adminChatId} hand=${handName} ok=${r.ok}`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    await deps.sendMessage(adminChatId, `派活失败:${detail.slice(0, 160)}`).catch(() => {})
    deps.log('ADMIN_CMD', `delegate failed chat=${adminChatId} hand=${handName}: ${detail}`)
  }
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
      //
      // stopAccountAndWait itself swallows the loop's exceptions
      // (logged inside runLoop), so the outer catch below ONLY catches
      // rmSync / sessionState.clear failures — not stop failures.
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
      // /reset only touches the admin's own session — other chats on the
      // same alias keep their independent sessions intact.
      await deps.sessionManager.release({ alias: proj.alias, providerId: p, chatId: adminChatId })
    } catch (err) {
      deps.log('ADMIN_CMD', `/reset release ${proj.alias}/${p} failed: ${err instanceof Error ? err.message : err}`)
    }
  }
  // Matches the release() bucket above — wipe the admin's chat_id rows.
  deps.sessionStore.delete({ alias: proj.alias, chatId: adminChatId })
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
      // /health ai inspects the admin's own session row.
      const rec = deps.sessionStore.get({ alias: proj.alias, provider: p, chatId: adminChatId })
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
