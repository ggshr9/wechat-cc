/**
 * mode-commands — slash commands that switch a chat's Conversation Mode
 * (RFC 03 §4.1 P2 scope).
 *
 * Recognised in P2:
 *   /cc                    → solo mode, provider=claude
 *   /codex                 → solo mode, provider=codex
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
import { botNameForMode } from './bot-name'

export interface ModeCommandsDeps {
  coordinator: Pick<ConversationCoordinator, 'getMode' | 'setMode' | 'cancel'>
  registry: Pick<ProviderRegistry, 'has' | 'get' | 'list'>
  /** Default provider id, surfaced by /mode + /solo for status messages. */
  defaultProviderId: ProviderId
  sendMessage(chatId: string, text: string): Promise<{ msgId: string; error?: string }>
  /** Persist a per-chat nickname. Used by /name. */
  setUserName(chatId: string, name: string): Promise<void>
  /** Lookup current nickname for this chat (null if none). Used by /whoami. */
  getUserName(chatId: string): string | null
  log: (tag: string, line: string) => void
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
    return null
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

  return {
    async handle(msg) {
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
            await reply(msg.chatId, `❓ 未知的 peer \`${peerSlash}\`。支持: cc, codex (例: /cc + codex / /codex + cc)`)
            return true
          }
          if (peerProviderId === providerId) {
            await reply(msg.chatId, `❓ 主从模式两侧不能是同一个 provider (你写的是 ${peerSlash} + ${peerSlash})。`)
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
          '可用命令: /cc /codex /both /chat /cc + codex /codex + cc /solo /stop /mode',
        ]
        await reply(msg.chatId, lines.join('\n'))
        return true
      }

      // /both — parallel mode (RFC 03 P3 — both shipped providers reply concurrently)
      if (slashWord.toLowerCase() === 'both' && tail === '') {
        try {
          deps.coordinator.setMode(msg.chatId, { kind: 'parallel' })
        } catch (err) {
          await reply(msg.chatId, `❌ /both 启用失败: ${err instanceof Error ? err.message : String(err)}`)
          return true
        }
        await reply(msg.chatId, '✅ 并行模式开启。下条消息开始 Claude 和 Codex 同时回复（每条会带 [Claude] / [Codex] 前缀）。')
        deps.log('MODE_CMD', `chat=${msg.chatId} → parallel`)
        return true
      }

      // /chat — chatroom mode (RFC 03 P5: two agents take turns via @-tag routing)
      if (slashWord.toLowerCase() === 'chat' && tail === '') {
        try {
          deps.coordinator.setMode(msg.chatId, { kind: 'chatroom' })
        } catch (err) {
          await reply(msg.chatId, `❌ /chat 启用失败: ${err instanceof Error ? err.message : String(err)}`)
          return true
        }
        await reply(
          msg.chatId,
          '✅ 聊天室模式开启。Claude 和 Codex 会在你的下一条消息后轮流讨论（最多 4 轮内部 round），用 @ 路由（@user 给你，@codex / @claude 给对方）。每条回复都带 [Claude] / [Codex] 前缀。/stop 退出。',
        )
        deps.log('MODE_CMD', `chat=${msg.chatId} → chatroom`)
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
        const botName = botNameForMode(cur)
        const wxLine = msg.userName
          ? `WeChat: ${msg.userName} (${trunc(msg.userId, 12)})`
          : `WeChat: ${trunc(msg.userId, 12)}`
        const lines = [
          `🪪 你: ${nick}`,
          `   ${wxLine}`,
          `🤖 bot account: ${trunc(msg.accountId, 12)}`,
          `   当前回应: ${botName} (${describeMode(cur)})`,
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

      // Not a mode command — let other handlers (admin-commands, onboarding,
      // coordinator) take it.
      return false
    },
  }
}
