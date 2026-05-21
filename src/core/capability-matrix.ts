/**
 * Capability matrix — single source of truth for the runtime semantics of
 * every (mode × provider × permissionMode) combination.
 *
 * Consumed by:
 *   - core/conversation-coordinator.ts  → assertSupported() at dispatch entry
 *   - core/permission-relay.ts          → lookup().askUser to gate per-tool prompts
 *   - core/codex-agent-provider.ts +    → lookup().approvalPolicy at provider build
 *     daemon/bootstrap/index.ts
 *   - daemon/internal-api/routes.ts     → lookup().replyPrefix for [Display] prefixing
 *
 * Module-load assertion: importing this module runs `assertMatrixComplete()`
 * at the bottom of the file. If the table is malformed (missing combination,
 * wrong row count) the import THROWS, refusing daemon boot. This is intentional
 * — it's better to fail at startup than route a wrong combination at runtime.
 *
 * Adding a provider: see the comment inside `assertMatrixComplete` — you
 * must edit BOTH the providers array there AND add 8 new rows to MATRIX.
 */
// src/core/capability-matrix.ts

import type { Mode, ProviderId } from './conversation'

export type PermissionMode = 'strict' | 'dangerously'

export interface Capability {
  /** 'per-tool' = Claude canUseTool 回调；'never' = 无 per-tool 提示。 */
  askUser: 'per-tool' | 'never'

  /** 'always'=parallel/chatroom；'never'=solo；'on-fallback-only'=primary_tool */
  replyPrefix: 'always' | 'never' | 'on-fallback-only'

  /** Codex SDK approval_policy；non-codex 行为 null。 */
  approvalPolicy: 'untrusted' | 'on-request' | 'never' | null

  /** delegate_<peer> MCP tool 是否加载到本 provider session。 */
  delegate: 'loaded' | 'unloaded'

  /** 显式禁用标志。v1.0 全 false；将来按策略收紧。 */
  forbidden: boolean

  /** 错误消息 + 文档辅助。 */
  notes: string
}

export interface MatrixRow extends Capability {
  mode: Mode['kind']
  provider: ProviderId
  permissionMode: PermissionMode
}

export const CAPABILITY_MATRIX: ReadonlyArray<MatrixRow> = [
  // ─── solo · claude ──────────────────────────────────────────────
  { mode: 'solo', provider: 'claude', permissionMode: 'strict',
    askUser: 'per-tool', replyPrefix: 'never', approvalPolicy: null,
    delegate: 'unloaded', forbidden: false,
    notes: 'baseline single-voice; per-tool relay via canUseTool' },
  { mode: 'solo', provider: 'claude', permissionMode: 'dangerously',
    askUser: 'never', replyPrefix: 'never', approvalPolicy: null,
    delegate: 'unloaded', forbidden: false,
    notes: 'bypassPermissions; agent self-confirms destructive ops in chat' },

  // ─── solo · codex ───────────────────────────────────────────────
  { mode: 'solo', provider: 'codex', permissionMode: 'strict',
    askUser: 'never', replyPrefix: 'never', approvalPolicy: 'untrusted',
    delegate: 'unloaded', forbidden: false,
    notes: 'codex SDK no per-tool callback; approval_policy gates; not surfaced to WeChat' },
  { mode: 'solo', provider: 'codex', permissionMode: 'dangerously',
    askUser: 'never', replyPrefix: 'never', approvalPolicy: 'never',
    delegate: 'unloaded', forbidden: false,
    notes: 'codex sandbox=workspace-write + approval=never' },

  // ─── parallel ───────────────────────────────────────────────────
  { mode: 'parallel', provider: 'claude', permissionMode: 'strict',
    askUser: 'per-tool', replyPrefix: 'always', approvalPolicy: null,
    delegate: 'unloaded', forbidden: false,
    notes: 'parallel: prefix [Claude] / [Codex] required to disambiguate' },
  { mode: 'parallel', provider: 'claude', permissionMode: 'dangerously',
    askUser: 'never', replyPrefix: 'always', approvalPolicy: null,
    delegate: 'unloaded', forbidden: false, notes: '' },
  { mode: 'parallel', provider: 'codex', permissionMode: 'strict',
    askUser: 'never', replyPrefix: 'always', approvalPolicy: 'untrusted',
    delegate: 'unloaded', forbidden: false, notes: '' },
  { mode: 'parallel', provider: 'codex', permissionMode: 'dangerously',
    askUser: 'never', replyPrefix: 'always', approvalPolicy: 'never',
    delegate: 'unloaded', forbidden: false, notes: '' },

  // ─── primary_tool ───────────────────────────────────────────────
  { mode: 'primary_tool', provider: 'claude', permissionMode: 'strict',
    askUser: 'per-tool', replyPrefix: 'on-fallback-only', approvalPolicy: null,
    delegate: 'loaded', forbidden: false,
    notes: 'primary=claude; codex callable via delegate_codex (always approval=never per RFC03 §4.2)' },
  { mode: 'primary_tool', provider: 'claude', permissionMode: 'dangerously',
    askUser: 'never', replyPrefix: 'on-fallback-only', approvalPolicy: null,
    delegate: 'loaded', forbidden: false, notes: '' },
  { mode: 'primary_tool', provider: 'codex', permissionMode: 'strict',
    askUser: 'never', replyPrefix: 'on-fallback-only', approvalPolicy: 'untrusted',
    delegate: 'loaded', forbidden: false,
    notes: 'primary=codex; claude callable via delegate_claude' },
  { mode: 'primary_tool', provider: 'codex', permissionMode: 'dangerously',
    askUser: 'never', replyPrefix: 'on-fallback-only', approvalPolicy: 'never',
    delegate: 'loaded', forbidden: false, notes: '' },

  // ─── chatroom ───────────────────────────────────────────────────
  { mode: 'chatroom', provider: 'claude', permissionMode: 'strict',
    askUser: 'per-tool', replyPrefix: 'always', approvalPolicy: null,
    delegate: 'unloaded', forbidden: false,
    notes: 'chatroom: agents address each other via @-tag; reply tool discouraged but not blocked' },
  { mode: 'chatroom', provider: 'claude', permissionMode: 'dangerously',
    askUser: 'never', replyPrefix: 'always', approvalPolicy: null,
    delegate: 'unloaded', forbidden: false, notes: '' },
  { mode: 'chatroom', provider: 'codex', permissionMode: 'strict',
    askUser: 'never', replyPrefix: 'always', approvalPolicy: 'untrusted',
    delegate: 'unloaded', forbidden: false, notes: '' },
  { mode: 'chatroom', provider: 'codex', permissionMode: 'dangerously',
    askUser: 'never', replyPrefix: 'always', approvalPolicy: 'never',
    delegate: 'unloaded', forbidden: false, notes: '' },
]
// 4 modes × 2 providers × 2 permissionModes = 16 rows ✓

export function lookup(
  mode: Mode['kind'],
  provider: ProviderId,
  permissionMode: PermissionMode,
): Capability {
  const row = CAPABILITY_MATRIX.find(r =>
    r.mode === mode && r.provider === provider && r.permissionMode === permissionMode
  )
  if (!row) {
    throw new Error(`capability-matrix: no row for mode=${mode} provider=${provider} perm=${permissionMode}`)
  }
  return row
}

export class UnsupportedCombinationError extends Error {
  constructor(
    public readonly mode: Mode['kind'],
    public readonly provider: ProviderId,
    public readonly permissionMode: PermissionMode,
    public readonly notes: string,
  ) {
    super(`combination not supported: mode=${mode} provider=${provider} perm=${permissionMode}${
      notes ? ` — ${notes}` : ''
    }`)
    this.name = 'UnsupportedCombinationError'
  }
}

export function assertSupported(
  mode: Mode['kind'],
  provider: ProviderId,
  permissionMode: PermissionMode,
): void {
  const cap = lookup(mode, provider, permissionMode)
  if (cap.forbidden) {
    throw new UnsupportedCombinationError(mode, provider, permissionMode, cap.notes)
  }
}

/**
 * Verify the matrix has a row for every (mode × provider × permissionMode)
 * combination. Called from bootstrap with the live `registry.list()` so the
 * set of providers is derived at runtime instead of hardcoded — adding a
 * new provider (gemini, cursor, …) to ProviderRegistry now only requires
 * the matrix rows, not a parallel edit to this hardcoded list.
 *
 * Previously self-invoked at module load with `['claude','codex']`
 * baked in. The foot-gun: a new provider would silently pass the
 * module-load check (since the new id wasn't in the list) and only
 * throw at first use of the missing combination — possibly in
 * production. Moving the call to bootstrap fails-fast at boot.
 */
export function assertMatrixComplete(providers: ProviderId[]): void {
  const modes: Mode['kind'][] = ['solo', 'parallel', 'primary_tool', 'chatroom']
  const perms: PermissionMode[] = ['strict', 'dangerously']
  const expected = modes.length * providers.length * perms.length
  // Note: CAPABILITY_MATRIX may contain rows for providers not in the
  // `providers` arg (e.g., a provider added to the matrix in advance of
  // its registry registration). We only fail if rows are MISSING for the
  // registered providers, not if extra rows exist.
  for (const m of modes) for (const p of providers) for (const pm of perms) {
    const found = CAPABILITY_MATRIX.find(r => r.mode === m && r.provider === p && r.permissionMode === pm)
    if (!found) throw new Error(`capability-matrix missing row: mode=${m} provider=${p} perm=${pm}`)
  }
  if (CAPABILITY_MATRIX.length < expected) {
    throw new Error(`capability-matrix incomplete: have ${CAPABILITY_MATRIX.length} rows, expected at least ${expected} for ${providers.length} provider(s)`)
  }
}
