/**
 * mode-commands — slash commands that switch a chat's Conversation Mode
 * (RFC 03 §4.1 P2 scope).
 *
 * Recognised in P2:
 *   /cc                    → solo mode, provider=claude
 *   /codex                 → solo mode, provider=codex
 *   /cursor                → solo mode, provider=cursor
 *   /solo                  → revert to daemon default (delete persisted mode)
 *   /mode                  → show current effective mode + registered providers
 *
 * Reserved for later (parsed but rejected with "not yet implemented"):
 *   /both                  → parallel (P3)
 *   /chat                  → chatroom (P5)
 *   /cc + codex            → primary_tool with claude primary (P4)
 *   /codex + cc            → primary_tool with codex primary (P4)
 *
 * Like admin-commands, this handler runs BEFORE the conversation
 * coordinator so the slash command is consumed and never reaches the
 * agent. Reply text goes back to the user via sendMessage. Unlike
 * admin-commands, EVERY user can flip their own chat's mode (no admin
 * gate) — this is per-chat user preference, not a system-wide change.
 */
import type { ConversationCoordinator } from '../core/conversation-coordinator'
import type { ProviderRegistry } from '../core/provider-registry'
import type { Mode, ProviderId } from '../core/conversation'
import type { InboundMsg } from '../core/prompt-format'
import { botName } from './bot-name'
import type { AgentConfig } from '../lib/agent-config'

export interface ModeCommandsDeps {
  coordinator: Pick<ConversationCoordinator, 'getMode' | 'setMode' | 'cancel'>
  registry: Pick<ProviderRegistry, 'has' | 'get' | 'list'>
  /** Default provider id, surfaced by /mode + /solo for status messages. */
  defaultProviderId: ProviderId
  /** Agent config — used to resolve the bot's self-name (override or fallback). */
  agentConfig: AgentConfig
  sendMessage(chatId: string, text: string): Promise<{ msgId: string; error?: string }>
  /** Persist a per-chat nickname. Used by /name. */
  setUserName(chatId: string, name: string): Promise<void>
  /** Lookup current nickname for this chat (null if none). Used by /whoami. */
  getUserName(chatId: string): string | null
  log: (tag: string, line: string) => void
  /** Returns true when userId belongs to an admin. Used by /help to gate the admin section. */
  isAdmin?: (userId: string) => boolean
}

export interface ModeCommands {
  /** Returns true iff the message was a slash command and was consumed. */
  handle(msg: InboundMsg): Promise<boolean>
}

// Recognized command tokens; case-insensitive on the leading slash word
// because the user might type `/CC` or `/Codex`. The provider mapping is
// case-sensitive though (canonical lowercase ids).
const COMMAND_REGEX = /^\s*\/([a-z][a-z_-]*)(?:\s+(.+))?\s*$/i

export function makeModeCommands(deps: ModeCommandsDeps): ModeCommands {
  function isProviderCommand(slashWord: string): ProviderId | null {
    const lower = slashWord.toLowerCase()
    if (lower === 'cc') return 'claude'
    if (lower === 'codex') return 'codex'
    if (lower === 'cursor') return 'cursor'
    if (lower === 'gemini') return 'gemini'
    return null
  }

  // Mirrors the delegate-mcp wiring in src/daemon/bootstrap/index.ts:322-325.
  // primary_tool mode persists ONLY `primary` on Mode — the peer is whichever
  // provider this primary's session has delegate_<peer> wired for at boot time.
  // So `/cc + cursor` can't actually work: Claude session exposes delegate_codex
  // (not delegate_cursor), and the persisted Mode wouldn't carry the peer either.
  // We surface that asymmetry up-front rather than silently substituting the
  // wired peer behind the operator's back.
  function defaultDelegatePeer(primary: ProviderId): ProviderId | null {
    if (primary === 'claude') return 'codex'
    if (primary === 'codex') return 'claude'
    if (primary === 'cursor') return 'claude'
    if (primary === 'gemini') return 'claude'
    return null
  }

  /**
   * Parse a token list (space-separated provider ids) into a validated
   * ProviderId[] or an error message describing why it's invalid. Used
   * by /chat <p...> and /parallel <p...>.
   */
  function parseParticipantsTail(tail: string, modeName: string): { ok: true; participants: ProviderId[] } | { ok: false; error: string } {
    const tokens = tail.split(/\s+/).filter(t => t.length > 0)
    if (tokens.length < 2) {
      return { ok: false, error: `❓ /${modeName} 需要 ≥2 个 participants (你写的: ${tokens.length}). 例：/${modeName} ${deps.registry.list().slice(0, 2).join(' ')}` }
    }
    const unknown = tokens.filter(t => !deps.registry.has(t))
    if (unknown.length > 0) {
      return { ok: false, error: `❌ 未知的 provider: ${unknown.join(', ')}. 已注册: ${deps.registry.list().join(', ')}` }
    }
    // Deduplicate while preserving order (operator typed the same provider twice → silent dedupe).
    const seen = new Set<string>()
    const dedup = tokens.filter(t => seen.has(t) ? false : (seen.add(t), true))
    return { ok: true, participants: dedup }
  }

  function describeMode(m: Mode): string {
    switch (m.kind) {
      case 'solo': return `solo · ${m.provider}`
      case 'primary_tool': return `primary_tool · primary=${m.primary}`
      case 'parallel': return 'parallel'
      case 'chatroom': return 'chatroom'
    }
  }

  async function reply(chatId: string, text: string): Promise<void> {
    const r = await deps.sendMessage(chatId, text)
    if (r.error) {
      deps.log('MODE_CMD', `reply to ${chatId} failed: ${r.error}`)
    }
  }

  async function handleHelp(msg: InboundMsg, admin: boolean): Promise<boolean> {
    const lines = [
      '这里是微信通道，可以直接跟我对话。可用命令：',
      '',
      '**模式切换**',
      '/cc /codex /cursor — 单 provider (solo)',
      '/cc + codex — Claude 主答，Codex 当工具 (primary_tool)',
      '/both [p1 p2 …] — 并行回复（裸=全部 provider）',
      '/chat [p1 p2 …] — 圆桌讨论',
      '/solo /stop /mode — 回到默认 / 退出 / 显示当前模式',
      '',
      '**身份**',
      '/whoami — 显示你的身份 + 当前模式',
      '/name <昵称> — 设置或改昵称',
      '',
      '**项目切换 / 陪伴**',
      '直接说"切到 <alias>"、"开启陪伴"、"别烦我" — 自然语言走得通，没做 slash 形式',
      '',
      '**文件**',
      '拖图片/文件给我即可',
      '',
      '或者直接提问、丢代码、让我跑命令。',
    ]
    if (admin) {
      lines.push(
        '',
        '**管理员命令**',
        '/health · /health ai — bot / AI 健康',
        '/reset (/重置) — 重置当前 chat',
        '/botname [name] — 设置/查看 bot 显示名',
        '/hearth help — vault 治理（hearth 子命令）',
        '清理 <bot> / 清理 all-expired — 清理过期 bot',
      )
    }
    await reply(msg.chatId, lines.join('\n'))
    deps.log('MODE_CMD', `chat=${msg.chatId} → /help (admin=${admin})`)
    return true
  }

  return {
    async handle(msg) {
      // /帮助 — Chinese alias for /help. Must be checked before COMMAND_REGEX
      // since the regex only matches ASCII slash-words.
      if (msg.text.trim() === '/帮助') {
        return handleHelp(msg, deps.isAdmin?.(msg.userId) ?? false)
      }

      const m = COMMAND_REGEX.exec(msg.text)
      if (!m) return false
      const slashWord = m[1]!
      const tail = m[2]?.trim() ?? ''

      // /cc, /codex
      const providerId = isProviderCommand(slashWord)
      if (providerId) {
        if (tail === '') {
          if (!deps.registry.has(providerId)) {
            await reply(msg.chatId, `❌ provider \`${providerId}\` 未注册。可用: ${deps.registry.list().join(', ')}`)
            return true
          }
          deps.coordinator.setMode(msg.chatId, { kind: 'solo', provider: providerId })
          const dn = deps.registry.get(providerId)?.opts.displayName ?? providerId
          await reply(msg.chatId, `✅ 这个对话切到 ${dn} (solo)。下条消息开始生效。`)
          deps.log('MODE_CMD', `chat=${msg.chatId} → solo+${providerId}`)
          return true
        }
        // /cc + codex / /codex + cc — primary_tool mode (RFC 03 P4)
        const peerMatch = /^\+\s*([a-z][a-z_-]*)\s*$/i.exec(tail)
        if (peerMatch) {
          const peerSlash = peerMatch[1]!
          const peerProviderId = isProviderCommand(peerSlash)
          if (!peerProviderId) {
            await reply(msg.chatId, `❓ 未知的 peer \`${peerSlash}\`。支持: cc, codex, cursor, gemini`)
            return true
          }
          if (peerProviderId === providerId) {
            await reply(msg.chatId, `❓ 主从模式两侧不能是同一个 provider (你写的是 ${peerSlash} + ${peerSlash})。`)
            return true
          }
          const wiredPeer = defaultDelegatePeer(providerId)
          if (wiredPeer && peerProviderId !== wiredPeer) {
            const wiredSlash = wiredPeer === 'claude' ? 'cc' : wiredPeer
            await reply(
              msg.chatId,
              `❌ ${slashWord} 的 delegate peer 在 bootstrap 里写死成 ${wiredPeer}（不是 ${peerProviderId}）。如果你想 ${providerId} 主导 + ${wiredPeer} 当工具，写 \`/${slashWord} + ${wiredSlash}\`。`,
            )
            return true
          }
          try {
            deps.coordinator.setMode(msg.chatId, { kind: 'primary_tool', primary: providerId })
          } catch (err) {
            await reply(msg.chatId, `❌ /${slashWord} + ${peerSlash} 启用失败: ${err instanceof Error ? err.message : String(err)}`)
            return true
          }
          const primaryDn = deps.registry.get(providerId)?.opts.displayName ?? providerId
          const peerDn = deps.registry.get(peerProviderId)?.opts.displayName ?? peerProviderId
          await reply(
            msg.chatId,
            `✅ 主从模式开启: ${primaryDn} 主导，需要时它会调 \`delegate_${peerProviderId}\` 工具去咨询 ${peerDn}（一次性，无对话历史）。`,
          )
          deps.log('MODE_CMD', `chat=${msg.chatId} → primary_tool primary=${providerId} peer=${peerProviderId}`)
          return true
        }
        await reply(msg.chatId, `❓ \`/${slashWord}\` 不支持参数 \`${tail}\`。试试 \`/${slashWord}\`、\`/${slashWord} + ${providerId === 'claude' ? 'codex' : 'cc'}\`、\`/solo\` 或 \`/mode\`。`)
        return true
      }

      // /solo — revert to daemon default
      if (slashWord.toLowerCase() === 'solo' && tail === '') {
        // Setting the mode to the default IS the revert: persists default
        // explicitly so future daemon-config changes don't silently shift
        // the user's chat. (Alternative would be conversationStore.delete
        // but that exposes the daemon-default at a layer above the user.)
        deps.coordinator.setMode(msg.chatId, { kind: 'solo', provider: deps.defaultProviderId })
        const dn = deps.registry.get(deps.defaultProviderId)?.opts.displayName ?? deps.defaultProviderId
        await reply(msg.chatId, `✅ 这个对话恢复默认 (solo · ${dn})。`)
        deps.log('MODE_CMD', `chat=${msg.chatId} → reset to default ${deps.defaultProviderId}`)
        return true
      }

      // /mode — status
      if (slashWord.toLowerCase() === 'mode' && tail === '') {
        const cur = deps.coordinator.getMode(msg.chatId)
        const lines = [
          `📍 当前对话模式: ${describeMode(cur)}`,
          `已注册 provider: ${deps.registry.list().join(', ')}`,
          `默认: ${deps.defaultProviderId}`,
          '',
          '可用命令: /cc /codex /cursor /gemini /both [p...] /chat [p...] /cc + codex /codex + cc /solo /stop /mode',
        ]
        await reply(msg.chatId, lines.join('\n'))
        return true
      }

      // /both — parallel mode (RFC 03 P3). Bare form uses all registered
      // providers; explicit form (/both <p1> <p2> ...) takes participants.
      // /parallel is a synonym for /both.
      if (slashWord.toLowerCase() === 'both' || slashWord.toLowerCase() === 'parallel') {
        if (tail === '') {
          try {
            deps.coordinator.setMode(msg.chatId, { kind: 'parallel' })
          } catch (err) {
            await reply(msg.chatId, `❌ /${slashWord} 启用失败: ${err instanceof Error ? err.message : String(err)}`)
            return true
          }
          await reply(msg.chatId, '✅ 并行模式开启。下条消息开始 Claude 和 Codex 同时回复（每条会带 [Claude] / [Codex] 前缀）。')
          deps.log('MODE_CMD', `chat=${msg.chatId} → parallel (no explicit participants)`)
          return true
        }
        const parsed = parseParticipantsTail(tail, slashWord.toLowerCase())
        if (!parsed.ok) {
          await reply(msg.chatId, parsed.error)
          return true
        }
        try {
          deps.coordinator.setMode(msg.chatId, { kind: 'parallel', participants: parsed.participants })
        } catch (err) {
          await reply(msg.chatId, `❌ /${slashWord} 启用失败: ${err instanceof Error ? err.message : String(err)}`)
          return true
        }
        await reply(msg.chatId, `✅ 并行模式开启 (${parsed.participants.join(' + ')})。下条消息开始同时回复。`)
        deps.log('MODE_CMD', `chat=${msg.chatId} → parallel participants=${parsed.participants.join(',')}`)
        return true
      }

      // /chat — chatroom mode (v0.5.9: persistent session, moderator-driven).
      // Bare form uses all registered providers; explicit form takes participants.
      if (slashWord.toLowerCase() === 'chat') {
        if (tail === '') {
          try {
            deps.coordinator.setMode(msg.chatId, { kind: 'chatroom' })
          } catch (err) {
            await reply(msg.chatId, `❌ /chat 启用失败: ${err instanceof Error ? err.message : String(err)}`)
            return true
          }
          const registeredList = deps.registry.list()
          const registeredDisplay = registeredList
            .map(id => deps.registry.get(id)?.opts.displayName ?? id)
            .join(' + ')
          await reply(
            msg.chatId,
            `✅ 聊天室开启。${registeredDisplay} 都"在场"了——后续消息会按上下文挑发言人。每条带 prefix。切走（/cc /codex /solo）会清空聊天室上下文。`,
          )
          deps.log('MODE_CMD', `chat=${msg.chatId} → chatroom (no explicit participants)`)
          return true
        }
        const parsed = parseParticipantsTail(tail, 'chat')
        if (!parsed.ok) {
          await reply(msg.chatId, parsed.error)
          return true
        }
        try {
          deps.coordinator.setMode(msg.chatId, { kind: 'chatroom', participants: parsed.participants })
        } catch (err) {
          await reply(msg.chatId, `❌ /chat 启用失败: ${err instanceof Error ? err.message : String(err)}`)
          return true
        }
        await reply(msg.chatId, `✅ 聊天室开启 (${parsed.participants.join(', ')})。每条回复带 prefix；切走会清空上下文。`)
        deps.log('MODE_CMD', `chat=${msg.chatId} → chatroom participants=${parsed.participants.join(',')}`)
        return true
      }

      // /stop — exit chatroom (or any non-default mode), revert to default solo.
      // RFC 03 review #11: also signals any in-flight chatroom loop to
      // preempt at its next turn boundary (mid-turn cancel isn't
      // supported — neither SDK exposes a uniform AbortSignal).
      if (slashWord.toLowerCase() === 'stop' && tail === '') {
        const wasInFlight = deps.coordinator.cancel(msg.chatId)
        deps.coordinator.setMode(msg.chatId, { kind: 'solo', provider: deps.defaultProviderId })
        const dn = deps.registry.get(deps.defaultProviderId)?.opts.displayName ?? deps.defaultProviderId
        const suffix = wasInFlight ? '；已中止 in-flight chatroom（最多多收到 1 个 turn 的输出后停止）' : ''
        await reply(msg.chatId, `✅ 已退出当前模式，恢复默认 (solo · ${dn})${suffix}。`)
        deps.log('MODE_CMD', `chat=${msg.chatId} → /stop reset to default${wasInFlight ? ' + cancel in-flight' : ''}`)
        return true
      }

      // /whoami — dump current identity + mode info
      if (slashWord.toLowerCase() === 'whoami' && tail === '') {
        const nick = deps.getUserName(msg.chatId)
        if (!nick) {
          await reply(msg.chatId, '你还没告诉我怎么称呼你。先发 `/name <昵称>` 设置一下。')
          return true
        }
        const trunc = (s: string, n: number) => s.length > n ? `${s.slice(0, n)}…` : s
        const cur = deps.coordinator.getMode(msg.chatId)
        const botNameStr = botName(cur, deps.agentConfig)
        const wxLine = msg.userName
          ? `WeChat: ${msg.userName} (${trunc(msg.userId, 12)})`
          : `WeChat: ${trunc(msg.userId, 12)}`
        const lines = [
          `🪪 你: ${nick}`,
          `   ${wxLine}`,
          `🤖 bot account: ${trunc(msg.accountId, 12)}`,
          `   当前回应: ${botNameStr} (${describeMode(cur)})`,
          `💬 chat: ${trunc(msg.chatId, 12)}`,
        ]
        await reply(msg.chatId, lines.join('\n'))
        return true
      }

      // /name <nick> — user renames themselves in this chat
      if (slashWord.toLowerCase() === 'name') {
        if (!tail) {
          await reply(msg.chatId, '❓ 用法：/name <昵称>。例：/name 丸子')
          return true
        }
        await deps.setUserName(msg.chatId, tail)
        await reply(msg.chatId, `✅ 好的，以后叫你 ${tail}。`)
        deps.log('MODE_CMD', `chat=${msg.chatId} → setUserName "${tail}"`)
        return true
      }

      // /help — user-facing command reference (/帮助 alias handled above COMMAND_REGEX)
      if (slashWord.toLowerCase() === 'help' && tail === '') {
        return handleHelp(msg, deps.isAdmin?.(msg.userId) ?? false)
      }

      // Not a mode command — let other handlers (admin-commands, onboarding,
      // coordinator) take it.
      return false
    },
  }
}
