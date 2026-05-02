/**
 * Bare delegate providers + one-shot dispatch (RFC 03 P4).
 *
 * Constructed separately from the registry's main providers because they
 * intentionally have NO mcpServers configured: a delegated peer must not
 * have access to wechat tools (would let it pretend to reply directly to
 * the user) or its own delegate-mcp (would allow recursion). Recursion
 * prevention is structural here, not counter-based.
 *
 * Each delegate call spawns a fresh thread; SessionManager isn't involved
 * because these are throwaway one-shot consultations.
 */
import { createClaudeAgentProvider } from '../../core/claude-agent-provider'
import { createCodexAgentProvider } from '../../core/codex-agent-provider'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { ProviderId } from '../../core/conversation'
import { loadAgentConfig } from '../../lib/agent-config'

export interface DelegateBuildDeps {
  /** State dir — used as the default cwd when caller doesn't pass one. */
  stateDir: string
  /** Optional override path for the claude-code binary. */
  claudeBin?: string
}

export type DelegateDispatch = (
  peer: ProviderId,
  prompt: string,
  cwd?: string,
) =>
  Promise<
    | { ok: true; response: string; num_turns?: number; duration_ms?: number }
    | { ok: false; reason: string }
  >

export function buildDelegateDispatch(deps: DelegateBuildDeps): DelegateDispatch {
  const configuredAgent = loadAgentConfig(deps.stateDir)

  const delegateClaude = createClaudeAgentProvider({
    sdkOptionsForProject: (_alias: string, path: string): Options => {
      const o: Options = {
        cwd: path,
        // Plain claude_code preset — no wechat-specific append. Peer
        // doesn't see wechat conversation history; it's a clean slate.
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        // Safer than bypassPermissions: delegate is read-mostly. Skip
        // the permission relay too — there's no human to ask, and
        // delegated peers shouldn't be writing to disk anyway.
        permissionMode: 'default',
        ...(deps.claudeBin ? { pathToClaudeCodeExecutable: deps.claudeBin } : {}),
      }
      return o
    },
  })

  const delegateCodex = createCodexAgentProvider({
    ...(process.env.CODEX_MODEL || configuredAgent.model
      ? { model: process.env.CODEX_MODEL ?? configuredAgent.model }
      : {}),
    approvalPolicy: 'never',
    // Read-only sandbox: delegate is for "ask a question", not "do work".
    // Spike 3 confirmed read-only blocks writes cleanly.
    sandboxMode: 'read-only',
    // Deliberately NO mcpServers — bare-bones is the structural
    // recursion-prevention guarantee.
  })

  /**
   * Run a one-shot prompt against the bare delegate provider for `peer`.
   * Used by internal-api's /v1/delegate route. Spawns a fresh thread,
   * dispatches once, closes. Cold-start cost (~3-5s) per call is
   * accepted as the price of "consult the peer cleanly."
   *
   * `cwd` (RFC 03 review #10): when caller passes one, peer can Read /
   * Bash files there (e.g. the calling agent's project). Otherwise
   * peer runs in deps.stateDir (a stable location with no project
   * files), preserving the "ask, don't do" framing.
   */
  return async function dispatchDelegate(peer, prompt, cwd) {
    const provider = peer === 'claude' ? delegateClaude
                   : peer === 'codex' ? delegateCodex
                   : null
    if (!provider) return { ok: false, reason: `unknown_peer: ${peer}` }
    const started = Date.now()
    let session: Awaited<ReturnType<typeof provider.spawn>> | null = null
    try {
      session = await provider.spawn({ alias: '_delegate', path: cwd ?? deps.stateDir })
      const result = await session.dispatch(prompt)
      const response = result.assistantText.join('\n').trim()
      return { ok: true, response, duration_ms: Date.now() - started }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    } finally {
      if (session) {
        try { await session.close() } catch { /* swallow shutdown errors */ }
      }
    }
  }
}
