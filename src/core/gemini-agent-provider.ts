/**
 * Gemini agent provider — drives Gemini via @google/genai.
 *
 * Unlike claude/codex/cursor (whose SDKs run the agentic loop), @google/genai
 * gives only model calls + tool-calling primitives, so THIS provider owns the
 * tool-use loop: generateContent → emit text → for each functionCall, gate it
 * (reusing classifyToolUse/effectivePolicy) and execute via an MCP client
 * connected to the daemon's wechat stdio server → append functionResponse →
 * loop until no functionCall → result.
 *
 * Decoupled from bootstrap via injected genai / mcpConnect / buildGate so the
 * loop is unit-testable. See docs/superpowers/specs/2026-06-04-gemini-provider-design.md.
 */
import type { PermissionMode, ProviderCapabilities } from './agent-provider'
import type { TierProfile } from './user-tier'

/** RFC 05 Phase 2 capability declaration. We OWN the loop → per-tool gating is
 *  realisable (perToolCallback). No SDK sandbox (enforcement is the tool gate,
 *  like Claude). Delegation + resume deferred to a follow-up. */
export const GEMINI_CAPABILITIES: ProviderCapabilities = {
  perToolCallback: true,
  sandboxLevels: new Set(),
  supportsDelegation: false,
  supportsResume: false,
}

export interface GeminiTierSdkOpts {
  /** strict ⇒ the per-tool gate runs; dangerously ⇒ operator bypassed everything. */
  gateEnabled: boolean
}

export function tierProfileToGeminiSdkOpts(_tp: TierProfile, permissionMode: PermissionMode): GeminiTierSdkOpts {
  return { gateEnabled: permissionMode !== 'dangerously' }
}

/** A per-spawn tool gate. allow → execute; deny → synthesize an error
 *  functionResponse so the model sees the refusal. Phase B builds the real one
 *  from effectivePolicy + askUser; tests inject a fake. */
export type ToolGateDecision = { allow: true } | { allow: false; message: string }
export type ToolGate = (toolName: string, input: Record<string, unknown>) => Promise<ToolGateDecision>
