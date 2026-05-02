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

export interface ModeCommandsDeps {
  coordinator: Pick<ConversationCoordinator, 'getMode' | 'setMode'>
  registry: Pick<ProviderRegistry, 'has' | 'get' | 'list'>
  /** Default provider id, surfaced by /mode + /solo for status messages. */
  defaultProviderId: ProviderId
  sendMessage(chatId: string, text: string): Promise<{ msgId: string; error?: string }>
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
          '可用命令: /cc /codex /both /cc + codex /codex + cc /solo /mode',
          '即将支持 (P5): /chat',
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

      // /chat — chatroom (P5 reserved)
      if (slashWord.toLowerCase() === 'chat' && tail === '') {
        await reply(msg.chatId, '🚧 聊天室模式 (/chat) 在 P5 才上线，当前版本未实现。')
        return true
      }

      // Not a mode command — let other handlers (admin-commands, onboarding,
      // coordinator) take it.
      return false
    },
  }
}
