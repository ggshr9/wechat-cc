/**
 * haiku-eval — one-shot Claude Haiku call used by the chatroom moderator.
 *
 * Extracted from bootstrap so its auth-failure interception is testable.
 * Without the interception a stale-credential moderator silently emits
 * "Not logged in · Please run /login" as assistant text, which fails the
 * downstream JSON parse and degrades to forced alternation — no log, no
 * notice, just a chatroom that stopped making good decisions.
 */
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'

export interface MakeHaikuEvalDeps {
  /** Real `claude` binary path, threaded through to bypass the SDK's
   *  bundled-bun-compile findClaudePath() trap (see bootstrap for the
   *  full story). Optional in source mode. */
  claudeBin?: string
  log: (tag: string, line: string) => void
  /** Test-only injection. Production uses dynamic import of the SDK. */
  queryImpl?: (args: { prompt: string; options?: Options }) => AsyncGenerator<SDKMessage, void>
}

// Mirror the provider's marker set (see claude-agent-provider.ts). The
// moderator runs against the SAME credential chain as the speakers, so
// when speakers are stale the moderator is too.
const AUTH_FAIL_RE = /(Please run \/login|Not logged in)/i

export function makeHaikuEval(deps: MakeHaikuEvalDeps): (prompt: string) => Promise<string> {
  return async (prompt: string) => {
    const queryFn = deps.queryImpl ?? ((await import('@anthropic-ai/claude-agent-sdk')).query as never)
    const q = (queryFn as (args: { prompt: string; options?: Options }) => AsyncGenerator<SDKMessage, void>)({
      prompt,
      options: {
        model: 'claude-haiku-4-5',
        maxTurns: 1,
        ...(deps.claudeBin ? { pathToClaudeCodeExecutable: deps.claudeBin } : {}),
      },
    })
    let text = ''
    for await (const raw of q) {
      const msg = raw as unknown as { type?: string; message?: { content?: unknown } }
      if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
        for (const part of msg.message.content as Array<{ type?: string; text?: string }>) {
          if (part.type === 'text' && typeof part.text === 'string') text += part.text
        }
      }
    }
    // Throw instead of returning the sentinel string so evaluateRound's
    // existing `haiku eval threw` branch handles the fallback. The log
    // tag matches the structured one solo/parallel/chatroom emit through
    // handleAuthFailed — same vocabulary across all four paths.
    if (AUTH_FAIL_RE.test(text)) {
      deps.log('AUTH_FAILED', `haiku moderator credentials stale: ${text.slice(0, 160)}`)
      throw new Error(`auth_failed: ${text.slice(0, 120)}`)
    }
    return text
  }
}
