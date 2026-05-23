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
import { collectTurn } from '../../core/agent-provider'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { ProviderId } from '../../core/conversation'
import { loadAgentConfig } from '../../lib/agent-config'
import { TIER_PROFILES, type TierProfile } from '../../core/user-tier'

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

  // Pin Claude model from agent-config.json (or stable full ID fallback).
  // Same rationale as the main bootstrap: don't inherit `~/.claude/.claude.json`
  // model resolution into the daemon's spawned subprocess. See bootstrap/index.ts
  // for the 2026-05-08 incident write-up.
  const claudeModel = configuredAgent.provider === 'claude' && configuredAgent.model
    ? configuredAgent.model
    : 'claude-opus-4-7'

  const delegateClaude = createClaudeAgentProvider({
    sdkOptionsForProject: (_alias: string, path: string, _tierProfile: TierProfile): Options => {
      const o: Options = {
        cwd: path,
        model: claudeModel,
        // Plain claude_code preset — no wechat-specific append. Peer
        // doesn't see wechat conversation history; it's a clean slate.
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        // Same rationale as bootstrap/index.ts: don't inherit user-global
        // ~/.claude/settings.json into the daemon-spawned subprocess.
        settingSources: ['project', 'local'],
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
    // sandboxMode + approvalPolicy moved out of CodexAgentProviderOptions in
    // Task 6 — they're now derived per-spawn from spawnOpts.tierProfile inside
    // the provider. See the dispatchDelegate call below for the tier choice
    // and its rationale.
    //
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
      session = await provider.spawn(
        { alias: '_delegate', path: cwd ?? deps.stateDir },
        // Trusted tier preserves the pre-Task-6 delegate posture:
        //   - Claude side: permissionMode='default' with no canUseTool wiring →
        //     equivalent to the prior delegate (no per-tool prompts because the
        //     delegate path never set canUseTool; auto-allow inside the SDK).
        //   - Codex side: sandboxMode='workspace-write' + approvalPolicy='never'
        //     → exactly the prior delegate codex config (writes constrained to
        //     cwd, no UI prompts).
        // Admin tier would have moved codex to danger-full-access — a regression
        // from the original "read-mostly" delegate stance. If a future task
        // wants a tighter delegate posture (e.g. read-only), add a dedicated
        // DELEGATE_PROFILE alongside TIER_PROFILES.
        { tierProfile: TIER_PROFILES.trusted },
      )
      const result = await collectTurn(session.dispatch(prompt))
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
