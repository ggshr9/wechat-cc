import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'

export interface PermissionRelayDeps {
  askUser: (chatId: string, prompt: string, hash: string, timeoutMs: number) => Promise<'allow' | 'deny' | 'timeout'>
  defaultChatId: () => string | null
  log: (tag: string, line: string) => void
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000

export function makeCanUseTool(deps: PermissionRelayDeps): CanUseTool {
  return async (toolName, input, opts) => {
    const chatId = deps.defaultChatId()
    if (!chatId) {
      deps.log('PERMISSION', `no default chat — auto-deny ${toolName}`)
      return { behavior: 'deny', message: 'No user session to request permission from' } satisfies PermissionResult
    }
    const hash = shortHash(opts.toolUseID)
    const prompt = opts.title ?? `Claude wants to run ${toolName} ${compactInput(input)}`
    const answer = await deps.askUser(chatId, prompt, hash, DEFAULT_TIMEOUT_MS)
    if (answer === 'allow') return { behavior: 'allow' } satisfies PermissionResult
    deps.log('PERMISSION', `${answer}: ${toolName} hash=${hash}`)
    return {
      behavior: 'deny',
      message: answer === 'timeout' ? 'User did not reply in time; request denied' : 'User denied the request',
    } satisfies PermissionResult
  }
}

function shortHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36).slice(0, 5)
}

function compactInput(input: Record<string, unknown>): string {
  const keys = Object.keys(input)
  if (keys.length === 0) return ''
  const first = keys[0]
  if (!first) return ''
  const v = input[first]
  return `${first}=${typeof v === 'string' ? v.slice(0, 40) : typeof v}`
}
