# Inbound Pipeline + Lifecycle + Capability Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `src/daemon/main.ts` (627 LOC) into a koa-style inbound pipeline + per-subsystem lifecycle modules + a capability matrix as the single source of truth for `mode × provider × permissionMode`. Single-PR cutover.

**Architecture:** Three new layers — `Lifecycle` interface (`src/lib/lifecycle.ts`) coordinated by `LifecycleSet` (LIFO 5s-timeout sequential stop); 13-mw koa-style inbound pipeline (`src/daemon/inbound/`) with factory closures for deps; 16-row `CAPABILITY_MATRIX` (`src/core/capability-matrix.ts`) consumed by coordinator / permission-relay / codex provider / internal-api. `main.ts` shrinks to ~80 LOC.

**Tech Stack:** Bun 1.3+, TypeScript, vitest 4.x, Zod (existing), bun:sqlite (existing), koa-style compose (self-written ~30 LOC), MCP SDK (existing).

**Spec:** `docs/specs/2026-05-03-inbound-pipeline-architecture.md`
**RFC:** `docs/rfc/04-inbound-pipeline-and-capability-matrix.md`

**Verification commands** (run after every task that touches code):
- `bun --bun vitest run <file>` — single test file
- `bun --bun vitest run` — full suite (~700 existing + ~100 new)
- `bun x tsc --noEmit` — typecheck
- `bun run depcheck` — module boundary lint

**File-tree at completion:** see spec §8 (48 new + 10 modified + 0 deleted).

---

## Task 1: Lifecycle module (`lib/lifecycle.ts`)

**Files:**
- Create: `src/lib/lifecycle.ts`
- Create: `src/lib/lifecycle.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/lifecycle.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { LifecycleSet, LifecycleStopError, type Lifecycle } from './lifecycle'

const mkLog = () => {
  const lines: string[] = []
  return { log: (tag: string, line: string) => lines.push(`${tag} ${line}`), lines }
}

const mkLifecycle = (name: string, stop: () => Promise<void>): Lifecycle => ({ name, stop })

describe('LifecycleSet', () => {
  it('stops handles in reverse registration order (LIFO)', async () => {
    const order: string[] = []
    const { log } = mkLog()
    const lc = new LifecycleSet(log)
    lc.register(mkLifecycle('a', async () => { order.push('a') }))
    lc.register(mkLifecycle('b', async () => { order.push('b') }))
    lc.register(mkLifecycle('c', async () => { order.push('c') }))
    await lc.stopAll()
    expect(order).toEqual(['c', 'b', 'a'])
  })

  it('runs stops sequentially, not concurrently', async () => {
    const { log } = mkLog()
    const lc = new LifecycleSet(log)
    let aDone = false
    lc.register(mkLifecycle('a', async () => {
      await new Promise(r => setTimeout(r, 30))
      aDone = true
    }))
    lc.register(mkLifecycle('b', async () => {
      // b stops first (LIFO); when its stop returns, a hasn't started
      expect(aDone).toBe(false)
    }))
    await lc.stopAll()
    expect(aDone).toBe(true)
  })

  it('continues stopping after one failure and aggregates the error', async () => {
    const { log } = mkLog()
    const lc = new LifecycleSet(log)
    const stopped: string[] = []
    lc.register(mkLifecycle('a', async () => { stopped.push('a') }))
    lc.register(mkLifecycle('b', async () => { throw new Error('boom') }))
    lc.register(mkLifecycle('c', async () => { stopped.push('c') }))
    await expect(lc.stopAll()).rejects.toBeInstanceOf(LifecycleStopError)
    expect(stopped).toEqual(['c', 'a'])
  })

  it('times out individual stop after 5000ms', async () => {
    vi.useFakeTimers()
    const { log } = mkLog()
    const lc = new LifecycleSet(log)
    lc.register(mkLifecycle('hang', () => new Promise(() => { /* never resolves */ })))
    const stopPromise = lc.stopAll()
    await vi.advanceTimersByTimeAsync(5001)
    await expect(stopPromise).rejects.toBeInstanceOf(LifecycleStopError)
    vi.useRealTimers()
  })

  it('is a no-op for empty set', async () => {
    const { log } = mkLog()
    const lc = new LifecycleSet(log)
    await expect(lc.stopAll()).resolves.toBeUndefined()
  })

  it('logs name + duration on success', async () => {
    const { log, lines } = mkLog()
    const lc = new LifecycleSet(log)
    lc.register(mkLifecycle('alpha', async () => {}))
    await lc.stopAll()
    expect(lines.some(l => l.startsWith('LIFECYCLE stopped alpha'))).toBe(true)
  })

  it('logs failure with name + error message', async () => {
    const { log, lines } = mkLog()
    const lc = new LifecycleSet(log)
    lc.register(mkLifecycle('beta', async () => { throw new Error('xyz') }))
    await expect(lc.stopAll()).rejects.toBeInstanceOf(LifecycleStopError)
    expect(lines.some(l => l.includes('stop beta failed') && l.includes('xyz'))).toBe(true)
  })

  it('LifecycleStopError carries failed/total/details', async () => {
    const { log } = mkLog()
    const lc = new LifecycleSet(log)
    lc.register(mkLifecycle('a', async () => {}))
    lc.register(mkLifecycle('b', async () => { throw new Error('x') }))
    try { await lc.stopAll(); throw new Error('should have thrown') }
    catch (err) {
      expect(err).toBeInstanceOf(LifecycleStopError)
      const e = err as LifecycleStopError
      expect(e.failed).toBe(1)
      expect(e.total).toBe(2)
      expect(e.details).toHaveLength(1)
      expect(e.details[0]!.name).toBe('b')
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/lib/lifecycle.test.ts`
Expected: FAIL with "Cannot find module './lifecycle'"

- [ ] **Step 3: Implement `src/lib/lifecycle.ts`**

```ts
/**
 * Standard shape every register*(deps) function returns.
 * stop MUST be idempotent — main.ts shutdown may call it multiple times
 * if a SIGTERM lands during graceful SIGINT handling.
 */
export interface Lifecycle {
  readonly name: string
  stop(): Promise<void>
}

export class LifecycleStopError extends Error {
  constructor(
    public readonly failed: number,
    public readonly total: number,
    public readonly details: Array<{ name: string; err: unknown }>,
  ) {
    super(`${failed}/${total} lifecycle handles failed to stop cleanly`)
    this.name = 'LifecycleStopError'
  }
}

/**
 * Aggregates a set of Lifecycle handles. Stops them in REVERSE registration
 * order (LIFO) — sequential, not concurrent. 5s per-handle timeout. One
 * failure does NOT abort subsequent stops.
 */
export class LifecycleSet {
  constructor(private readonly log: (tag: string, line: string) => void) {}
  private readonly handles: Lifecycle[] = []

  register(handle: Lifecycle): void { this.handles.push(handle) }

  async stopAll(): Promise<void> {
    const ordered = [...this.handles].reverse()
    const failures: Array<{ name: string; err: unknown }> = []
    for (const h of ordered) {
      const t0 = Date.now()
      try {
        await Promise.race([
          h.stop(),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error('stop timeout (5000ms)')), 5000),
          ),
        ])
        this.log('LIFECYCLE', `stopped ${h.name} (${Date.now() - t0}ms)`)
      } catch (err) {
        this.log('LIFECYCLE', `stop ${h.name} failed (${Date.now() - t0}ms): ${
          err instanceof Error ? err.message : err
        }`)
        failures.push({ name: h.name, err })
      }
    }
    if (failures.length > 0) {
      throw new LifecycleStopError(failures.length, this.handles.length, failures)
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --bun vitest run src/lib/lifecycle.test.ts`
Expected: PASS, 8/8 tests green.

- [ ] **Step 5: Typecheck**

Run: `bun x tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/lifecycle.ts src/lib/lifecycle.test.ts
git commit -m "feat(lib): add Lifecycle interface + LifecycleSet (LIFO sequential stop, 5s timeout)"
```

---

## Task 2: Capability matrix (`core/capability-matrix.ts`)

**Files:**
- Create: `src/core/capability-matrix.ts`
- Create: `src/core/capability-matrix.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/capability-matrix.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import {
  CAPABILITY_MATRIX,
  lookup,
  assertSupported,
  UnsupportedCombinationError,
  type MatrixRow,
  type PermissionMode,
} from './capability-matrix'
import type { Mode, ProviderId } from './conversation'

describe('CAPABILITY_MATRIX', () => {
  it('contains exactly 16 rows (4 modes × 2 providers × 2 perms)', () => {
    expect(CAPABILITY_MATRIX).toHaveLength(16)
  })

  it.each(CAPABILITY_MATRIX)(
    'row $mode/$provider/$permissionMode round-trips through lookup',
    (row: MatrixRow) => {
      expect(lookup(row.mode, row.provider, row.permissionMode)).toBe(row)
    },
  )

  it.each(CAPABILITY_MATRIX)(
    'row $mode/$provider/$permissionMode satisfies invariants',
    (row: MatrixRow) => {
      if (row.provider === 'claude') expect(row.approvalPolicy).toBeNull()
      if (row.provider === 'codex')  expect(row.approvalPolicy).not.toBeNull()
      if (row.permissionMode === 'dangerously') expect(row.askUser).toBe('never')
      if (row.mode === 'primary_tool') expect(row.delegate).toBe('loaded')
      else                              expect(row.delegate).toBe('unloaded')
      if (row.mode === 'parallel' || row.mode === 'chatroom') expect(row.replyPrefix).toBe('always')
      if (row.mode === 'solo') expect(row.replyPrefix).toBe('never')
      if (row.mode === 'primary_tool') expect(row.replyPrefix).toBe('on-fallback-only')
    },
  )

  it('every row currently has forbidden=false (v1.0)', () => {
    for (const row of CAPABILITY_MATRIX) expect(row.forbidden).toBe(false)
  })
})

describe('lookup', () => {
  it('throws on unknown combo', () => {
    expect(() => lookup('solo' as Mode['kind'], 'mystery' as ProviderId, 'strict' as PermissionMode))
      .toThrow(/no row for/)
  })
})

describe('assertSupported', () => {
  it('passes when combo is supported (forbidden=false)', () => {
    expect(() => assertSupported('solo', 'claude', 'strict')).not.toThrow()
  })

  it('throws UnsupportedCombinationError when forbidden', () => {
    // simulate by mutating a row's forbidden flag for one assertion only
    const row = CAPABILITY_MATRIX[0]!
    const original = row.forbidden
    ;(row as { forbidden: boolean }).forbidden = true
    try {
      expect(() => assertSupported(row.mode, row.provider, row.permissionMode))
        .toThrow(UnsupportedCombinationError)
    } finally {
      ;(row as { forbidden: boolean }).forbidden = original
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/core/capability-matrix.test.ts`
Expected: FAIL with "Cannot find module './capability-matrix'".

- [ ] **Step 3: Implement `src/core/capability-matrix.ts`**

Implement per spec §5.1–5.3 (full 16-row data, lookup, assertSupported, assertMatrixComplete with module-load assertion). Copy the entire spec §5.2 MATRIX verbatim. Key elements:

```ts
import type { Mode, ProviderId } from './conversation'

export type PermissionMode = 'strict' | 'dangerously'

export interface Capability {
  askUser: 'per-tool' | 'never'
  replyPrefix: 'always' | 'never' | 'on-fallback-only'
  approvalPolicy: 'untrusted' | 'on-request' | 'never' | null
  delegate: 'loaded' | 'unloaded'
  forbidden: boolean
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
  /* ... 15 more rows verbatim from spec §5.2 ... */
]

export function lookup(
  mode: Mode['kind'],
  provider: ProviderId,
  permissionMode: PermissionMode,
): Capability {
  const row = CAPABILITY_MATRIX.find(r =>
    r.mode === mode && r.provider === provider && r.permissionMode === permissionMode,
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

function assertMatrixComplete(): void {
  const modes: Mode['kind'][] = ['solo', 'parallel', 'primary_tool', 'chatroom']
  const providers: ProviderId[] = ['claude', 'codex']
  const perms: PermissionMode[] = ['strict', 'dangerously']
  const expected = modes.length * providers.length * perms.length
  if (CAPABILITY_MATRIX.length !== expected) {
    throw new Error(`capability-matrix incomplete: have ${CAPABILITY_MATRIX.length} rows, expected ${expected}`)
  }
  for (const m of modes) for (const p of providers) for (const pm of perms) {
    const found = CAPABILITY_MATRIX.find(r => r.mode === m && r.provider === p && r.permissionMode === pm)
    if (!found) throw new Error(`capability-matrix missing row: mode=${m} provider=${p} perm=${pm}`)
  }
}
assertMatrixComplete()
```

⚠ The complete `CAPABILITY_MATRIX` literal must be copied exactly from spec §5.2 (16 rows). Do not paraphrase any field — `notes` content matters for error messages.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --bun vitest run src/core/capability-matrix.test.ts`
Expected: PASS, ~22 tests green.

- [ ] **Step 5: Typecheck + depcheck**

Run: `bun x tsc --noEmit && bun run depcheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/capability-matrix.ts src/core/capability-matrix.test.ts
git commit -m "feat(core): add capability-matrix (16 rows, load-time completeness assertion)"
```

---

## Task 3: Inbound pipeline foundation (types + compose)

**Files:**
- Create: `src/daemon/inbound/types.ts`
- Create: `src/daemon/inbound/compose.ts`
- Create: `src/daemon/inbound/compose.test.ts`

- [ ] **Step 1: Write `compose.test.ts` (failing)**

```ts
import { describe, it, expect, vi } from 'vitest'
import { compose } from './compose'
import type { InboundCtx, Middleware } from './types'

const mkCtx = (): InboundCtx => ({
  msg: {} as InboundCtx['msg'],
  receivedAtMs: Date.now(),
  requestId: 'r1',
})

describe('compose', () => {
  it('runs middlewares in registration order, inner after outer next()', async () => {
    const order: string[] = []
    const a: Middleware = async (_ctx, next) => { order.push('a-pre'); await next(); order.push('a-post') }
    const b: Middleware = async (_ctx, next) => { order.push('b-pre'); await next(); order.push('b-post') }
    const c: Middleware = async () => { order.push('c') }
    await compose([a, b, c])(mkCtx())
    expect(order).toEqual(['a-pre', 'b-pre', 'c', 'b-post', 'a-post'])
  })

  it('short-circuits when middleware does not call next()', async () => {
    const inner = vi.fn()
    const a: Middleware = async () => { /* no next */ }
    await compose([a, inner])(mkCtx())
    expect(inner).not.toHaveBeenCalled()
  })

  it('handles empty array', async () => {
    await expect(compose([])(mkCtx())).resolves.toBeUndefined()
  })

  it('propagates errors thrown by inner middleware', async () => {
    const a: Middleware = async (_c, next) => { await next() }
    const b: Middleware = async () => { throw new Error('boom') }
    await expect(compose([a, b])(mkCtx())).rejects.toThrow('boom')
  })

  it('outer middleware can catch inner thrown error', async () => {
    let caught: unknown = null
    const a: Middleware = async (_c, next) => { try { await next() } catch (e) { caught = e } }
    const b: Middleware = async () => { throw new Error('x') }
    await compose([a, b])(mkCtx())
    expect((caught as Error).message).toBe('x')
  })

  it('rejects when middleware calls next() twice', async () => {
    const a: Middleware = async (_c, next) => { await next(); await next() }
    await expect(compose([a, async () => {}])(mkCtx()))
      .rejects.toThrow(/next\(\) called multiple times/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/daemon/inbound/compose.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `types.ts`**

```ts
// src/daemon/inbound/types.ts
import type { InboundMsg } from '../../core/prompt-format'

export type ConsumedBy = 'admin' | 'mode' | 'onboarding' | 'permission-reply' | 'guard'

export interface InboundCtx {
  readonly msg: InboundMsg
  readonly receivedAtMs: number
  readonly requestId: string
  consumedBy?: ConsumedBy
  attachmentsMaterialized?: boolean
}

export type Middleware = (ctx: InboundCtx, next: () => Promise<void>) => Promise<void>
export type PipelineRun = (ctx: InboundCtx) => Promise<void>
```

- [ ] **Step 4: Implement `compose.ts`**

```ts
// src/daemon/inbound/compose.ts
import type { Middleware, PipelineRun, InboundCtx } from './types'

export function compose(mws: ReadonlyArray<Middleware>): PipelineRun {
  return function run(ctx: InboundCtx): Promise<void> {
    let lastIndex = -1
    function dispatch(i: number): Promise<void> {
      if (i <= lastIndex) {
        return Promise.reject(new Error('next() called multiple times in same middleware'))
      }
      lastIndex = i
      const fn = mws[i]
      if (!fn) return Promise.resolve()
      try {
        return Promise.resolve(fn(ctx, () => dispatch(i + 1)))
      } catch (err) {
        return Promise.reject(err)
      }
    }
    return dispatch(0)
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun --bun vitest run src/daemon/inbound/compose.test.ts`
Expected: PASS, 6/6 tests green.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/inbound/types.ts src/daemon/inbound/compose.ts src/daemon/inbound/compose.test.ts
git commit -m "feat(inbound): add compose() + InboundCtx/Middleware types"
```

---

## Task 4: Trace + capture-ctx + typing middlewares (T-tier)

**Files:**
- Create: `src/daemon/inbound/mw-trace.ts` + `.test.ts`
- Create: `src/daemon/inbound/mw-capture-ctx.ts` + `.test.ts`
- Create: `src/daemon/inbound/mw-typing.ts` + `.test.ts`

- [ ] **Step 1: Write `mw-trace.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeMwTrace } from './mw-trace'
import type { InboundCtx } from './types'

const mkCtx = (): InboundCtx => ({
  msg: { chatId: 'c1' } as InboundCtx['msg'],
  receivedAtMs: Date.now(),
  requestId: 'req1',
})

describe('mwTrace', () => {
  it('logs INBOUND with consumed=dispatched when consumedBy unset', async () => {
    const lines: Array<[string, string]> = []
    const mw = makeMwTrace({ log: (t, l) => lines.push([t, l]) })
    await mw(mkCtx(), async () => {})
    expect(lines.some(([t, l]) => t === 'INBOUND' && l.includes('consumed=dispatched'))).toBe(true)
  })

  it('logs consumed=<consumedBy> when set', async () => {
    const lines: Array<[string, string]> = []
    const mw = makeMwTrace({ log: (t, l) => lines.push([t, l]) })
    const ctx = mkCtx()
    await mw(ctx, async () => { ctx.consumedBy = 'admin' })
    expect(lines.some(([t, l]) => t === 'INBOUND' && l.includes('consumed=admin'))).toBe(true)
  })

  it('catches inner error, logs INBOUND_ERROR, does not rethrow', async () => {
    const lines: Array<[string, string]> = []
    const mw = makeMwTrace({ log: (t, l) => lines.push([t, l]) })
    await expect(mw(mkCtx(), async () => { throw new Error('inner-boom') })).resolves.toBeUndefined()
    expect(lines.some(([t, l]) => t === 'INBOUND_ERROR' && l.includes('inner-boom'))).toBe(true)
  })
})
```

- [ ] **Step 2: Implement `mw-trace.ts`**

```ts
import type { Middleware } from './types'

export interface TraceMwDeps {
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void
}

function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err) }

export function makeMwTrace(deps: TraceMwDeps): Middleware {
  return async (ctx, next) => {
    const start = Date.now()
    try {
      await next()
    } catch (err) {
      deps.log('INBOUND_ERROR', `req=${ctx.requestId} chat=${ctx.msg.chatId} threw: ${errMsg(err)}`, {
        event: 'inbound_uncaught',
        request_id: ctx.requestId,
        chat_id: ctx.msg.chatId,
        error: errMsg(err),
      })
      // 不 rethrow —— 保 polling loop 活
    } finally {
      deps.log('INBOUND',
        `req=${ctx.requestId} chat=${ctx.msg.chatId} consumed=${ctx.consumedBy ?? 'dispatched'} ms=${Date.now() - start}`)
    }
  }
}
```

- [ ] **Step 3: Run mw-trace tests**

Run: `bun --bun vitest run src/daemon/inbound/mw-trace.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 4: Write `mw-capture-ctx.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeMwCaptureCtx } from './mw-capture-ctx'
import type { InboundCtx } from './types'

const mkCtx = (over: Partial<InboundCtx['msg']> = {}): InboundCtx => ({
  msg: { chatId: 'c1', accountId: 'a1', contextToken: 'ct1', ...over } as InboundCtx['msg'],
  receivedAtMs: Date.now(),
  requestId: 'r1',
})

describe('mwCaptureCtx', () => {
  it('calls markChatActive + captureContextToken before next()', async () => {
    const calls: string[] = []
    const mw = makeMwCaptureCtx({
      markChatActive: (c, a) => calls.push(`mark:${c}:${a}`),
      captureContextToken: (c, t) => calls.push(`tok:${c}:${t}`),
    })
    await mw(mkCtx(), async () => calls.push('next'))
    expect(calls).toEqual(['mark:c1:a1', 'tok:c1:ct1', 'next'])
  })

  it('skips captureContextToken when token absent', async () => {
    const tokens: string[] = []
    const mw = makeMwCaptureCtx({
      markChatActive: () => {},
      captureContextToken: (c, t) => tokens.push(`${c}:${t}`),
    })
    await mw(mkCtx({ contextToken: undefined }), async () => {})
    expect(tokens).toEqual([])
  })
})
```

- [ ] **Step 5: Implement `mw-capture-ctx.ts`**

```ts
import type { Middleware } from './types'

export interface CaptureCtxMwDeps {
  markChatActive(chatId: string, accountId: string): void
  captureContextToken(chatId: string, token: string): void
}

export function makeMwCaptureCtx(deps: CaptureCtxMwDeps): Middleware {
  return async (ctx, next) => {
    deps.markChatActive(ctx.msg.chatId, ctx.msg.accountId)
    if (ctx.msg.contextToken) deps.captureContextToken(ctx.msg.chatId, ctx.msg.contextToken)
    await next()
  }
}
```

- [ ] **Step 6: Run mw-capture-ctx tests**

Run: `bun --bun vitest run src/daemon/inbound/mw-capture-ctx.test.ts`
Expected: PASS, 2/2.

- [ ] **Step 7: Write `mw-typing.test.ts` + implement `mw-typing.ts`**

```ts
// mw-typing.test.ts
import { describe, it, expect, vi } from 'vitest'
import { makeMwTyping } from './mw-typing'
import type { InboundCtx } from './types'

describe('mwTyping', () => {
  it('fires sendTyping (no await) and continues', async () => {
    const sendTyping = vi.fn(async () => {})
    const mw = makeMwTyping({ sendTyping })
    let nextCalled = false
    await mw(
      { msg: { chatId: 'c1', accountId: 'a1' } as InboundCtx['msg'], receivedAtMs: 0, requestId: 'r' },
      async () => { nextCalled = true },
    )
    expect(sendTyping).toHaveBeenCalledWith('c1', 'a1')
    expect(nextCalled).toBe(true)
  })

  it('does not throw if sendTyping rejects', async () => {
    const mw = makeMwTyping({ sendTyping: async () => { throw new Error('x') } })
    await expect(mw(
      { msg: { chatId: 'c1', accountId: 'a1' } as InboundCtx['msg'], receivedAtMs: 0, requestId: 'r' },
      async () => {},
    )).resolves.toBeUndefined()
  })
})
```

```ts
// mw-typing.ts
import type { Middleware } from './types'

export interface TypingMwDeps {
  sendTyping(chatId: string, accountId: string): Promise<void>
}

export function makeMwTyping(deps: TypingMwDeps): Middleware {
  return async (ctx, next) => {
    deps.sendTyping(ctx.msg.chatId, ctx.msg.accountId).catch(() => { /* swallow */ })
    await next()
  }
}
```

- [ ] **Step 8: Run all T-tier mw tests + commit**

```bash
bun --bun vitest run src/daemon/inbound/mw-trace.test.ts src/daemon/inbound/mw-capture-ctx.test.ts src/daemon/inbound/mw-typing.test.ts
```
Expected: 7 tests green.

```bash
git add src/daemon/inbound/mw-trace*.ts src/daemon/inbound/mw-capture-ctx*.ts src/daemon/inbound/mw-typing*.ts
git commit -m "feat(inbound): add T-tier middlewares (trace + capture-ctx + typing)"
```

---

## Task 5: mw-admin (S-tier intercept)

**Files:**
- Create: `src/daemon/inbound/mw-admin.ts` + `.test.ts`

- [ ] **Step 1: Write `mw-admin.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeMwAdmin } from './mw-admin'
import type { InboundCtx } from './types'

const mkCtx = (): InboundCtx => ({
  msg: { chatId: 'c1', text: '/health' } as InboundCtx['msg'],
  receivedAtMs: 0,
  requestId: 'r',
})

describe('mwAdmin', () => {
  it('short-circuits when handler returns true; sets consumedBy=admin', async () => {
    const next = vi.fn()
    const handler = { handle: vi.fn(async () => true) }
    const mw = makeMwAdmin({ adminHandler: handler })
    const ctx = mkCtx()
    await mw(ctx, next)
    expect(ctx.consumedBy).toBe('admin')
    expect(next).not.toHaveBeenCalled()
  })

  it('passes through when handler returns false', async () => {
    const next = vi.fn(async () => {})
    const handler = { handle: vi.fn(async () => false) }
    const mw = makeMwAdmin({ adminHandler: handler })
    const ctx = mkCtx()
    await mw(ctx, next)
    expect(ctx.consumedBy).toBeUndefined()
    expect(next).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Implement `mw-admin.ts`**

```ts
import type { Middleware, InboundCtx } from './types'

export interface AdminHandler {
  handle(msg: InboundCtx['msg']): Promise<boolean>
}

export interface AdminMwDeps {
  adminHandler: AdminHandler
}

export function makeMwAdmin(deps: AdminMwDeps): Middleware {
  return async (ctx, next) => {
    if (await deps.adminHandler.handle(ctx.msg)) {
      ctx.consumedBy = 'admin'
      return
    }
    await next()
  }
}
```

The `AdminHandler` interface deliberately matches `makeAdminCommands` return shape from `src/daemon/admin-commands.ts` — wiring in main-wiring.ts will pass that through directly.

- [ ] **Step 3: Run + commit**

```bash
bun --bun vitest run src/daemon/inbound/mw-admin.test.ts
git add src/daemon/inbound/mw-admin*.ts
git commit -m "feat(inbound): add mwAdmin (S-tier short-circuit)"
```

---

## Task 6: mw-mode

**Files:**
- Create: `src/daemon/inbound/mw-mode.ts` + `.test.ts`

- [ ] **Step 1: Write `mw-mode.test.ts`** (mirror Task 5 shape: short-circuit case + pass-through case, 2 tests). Use `consumedBy = 'mode'`.

- [ ] **Step 2: Implement `mw-mode.ts`** (identical structure to mw-admin, with `ModeHandler` interface matching `makeModeCommands` return shape from `src/daemon/mode-commands.ts`).

- [ ] **Step 3: Run + commit**

```bash
bun --bun vitest run src/daemon/inbound/mw-mode.test.ts
git add src/daemon/inbound/mw-mode*.ts
git commit -m "feat(inbound): add mwMode (S-tier mode-switch intercept)"
```

---

## Task 7: mw-onboarding

**Files:**
- Create: `src/daemon/inbound/mw-onboarding.ts` + `.test.ts`

- [ ] **Step 1: Write `mw-onboarding.test.ts`** (same pattern as mw-admin, `consumedBy = 'onboarding'`).

- [ ] **Step 2: Implement `mw-onboarding.ts`** (interface matches `makeOnboardingHandler` return from `src/daemon/onboarding.ts`).

- [ ] **Step 3: Run + commit**

```bash
bun --bun vitest run src/daemon/inbound/mw-onboarding.test.ts
git add src/daemon/inbound/mw-onboarding*.ts
git commit -m "feat(inbound): add mwOnboarding (S-tier nickname capture)"
```

---

## Task 8: mw-permission-reply + mw-guard

**Files:**
- Create: `src/daemon/inbound/mw-permission-reply.ts` + `.test.ts`
- Create: `src/daemon/inbound/mw-guard.ts` + `.test.ts`

- [ ] **Step 1: Write `mw-permission-reply.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeMwPermissionReply } from './mw-permission-reply'
import type { InboundCtx } from './types'

describe('mwPermissionReply', () => {
  it('short-circuits when handlePermissionReply consumes (returns true); sets consumedBy=permission-reply', async () => {
    const next = vi.fn()
    const mw = makeMwPermissionReply({ handlePermissionReply: () => true, log: () => {} })
    const ctx: InboundCtx = { msg: { chatId: 'c1', text: 'y abc12' } as InboundCtx['msg'], receivedAtMs: 0, requestId: 'r' }
    await mw(ctx, next)
    expect(ctx.consumedBy).toBe('permission-reply')
    expect(next).not.toHaveBeenCalled()
  })

  it('passes through when handler returns false', async () => {
    const next = vi.fn(async () => {})
    const mw = makeMwPermissionReply({ handlePermissionReply: () => false, log: () => {} })
    await mw({ msg: { chatId: 'c1', text: 'hi' } as InboundCtx['msg'], receivedAtMs: 0, requestId: 'r' }, next)
    expect(next).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Implement `mw-permission-reply.ts`**

```ts
import type { Middleware } from './types'

export interface PermissionReplyMwDeps {
  handlePermissionReply(text: string): boolean
  log: (tag: string, line: string) => void
}

export function makeMwPermissionReply(deps: PermissionReplyMwDeps): Middleware {
  return async (ctx, next) => {
    if (deps.handlePermissionReply(ctx.msg.text ?? '')) {
      deps.log('PERMISSION', `consumed reply from chat=${ctx.msg.chatId}`)
      ctx.consumedBy = 'permission-reply'
      return
    }
    await next()
  }
}
```

- [ ] **Step 3: Write `mw-guard.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeMwGuard } from './mw-guard'
import type { InboundCtx } from './types'

describe('mwGuard', () => {
  it('refuses + sets consumedBy=guard when guard enabled and not reachable', async () => {
    const sendMessage = vi.fn(async () => ({ msgId: 'm1' }))
    const mw = makeMwGuard({
      guardEnabled: () => true,
      guardState: () => ({ reachable: false, ip: '1.2.3.4' }),
      sendMessage,
      log: () => {},
    })
    const ctx: InboundCtx = { msg: { chatId: 'c1' } as InboundCtx['msg'], receivedAtMs: 0, requestId: 'r' }
    const next = vi.fn()
    await mw(ctx, next)
    expect(ctx.consumedBy).toBe('guard')
    expect(sendMessage).toHaveBeenCalledOnce()
    expect(next).not.toHaveBeenCalled()
  })

  it('passes through when guard disabled', async () => {
    const next = vi.fn(async () => {})
    const mw = makeMwGuard({
      guardEnabled: () => false,
      guardState: () => ({ reachable: false, ip: '1.2.3.4' }),
      sendMessage: vi.fn(),
      log: () => {},
    })
    await mw({ msg: { chatId: 'c1' } as InboundCtx['msg'], receivedAtMs: 0, requestId: 'r' }, next)
    expect(next).toHaveBeenCalledOnce()
  })

  it('passes through when reachable', async () => {
    const next = vi.fn(async () => {})
    const mw = makeMwGuard({
      guardEnabled: () => true,
      guardState: () => ({ reachable: true, ip: '1.2.3.4' }),
      sendMessage: vi.fn(),
      log: () => {},
    })
    await mw({ msg: { chatId: 'c1' } as InboundCtx['msg'], receivedAtMs: 0, requestId: 'r' }, next)
    expect(next).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 4: Implement `mw-guard.ts`**

```ts
import type { Middleware } from './types'

export interface GuardMwDeps {
  guardEnabled(): boolean
  guardState(): { reachable: boolean; ip: string | null }
  sendMessage(chatId: string, text: string): Promise<{ msgId: string }>
  log: (tag: string, line: string) => void
}

export function makeMwGuard(deps: GuardMwDeps): Middleware {
  return async (ctx, next) => {
    const enabled = deps.guardEnabled()
    const state = deps.guardState()
    if (enabled && !state.reachable && state.ip) {
      deps.log('GUARD', `dropping inbound chat=${ctx.msg.chatId} — network DOWN ip=${state.ip}`)
      await deps.sendMessage(ctx.msg.chatId, `🛑 出口 IP ${state.ip} → 网络探测失败。VPN 掉了？修好再发。`)
      ctx.consumedBy = 'guard'
      return
    }
    await next()
  }
}
```

- [ ] **Step 5: Run + commit**

```bash
bun --bun vitest run src/daemon/inbound/mw-permission-reply.test.ts src/daemon/inbound/mw-guard.test.ts
git add src/daemon/inbound/mw-permission-reply*.ts src/daemon/inbound/mw-guard*.ts
git commit -m "feat(inbound): add mwPermissionReply + mwGuard (S-tier)"
```

---

## Task 9: mw-attachments (E-tier enrichment)

**Files:**
- Create: `src/daemon/inbound/mw-attachments.ts` + `.test.ts`

- [ ] **Step 1: Write `mw-attachments.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeMwAttachments } from './mw-attachments'
import type { InboundCtx } from './types'

describe('mwAttachments', () => {
  it('calls materializeAttachments before next() and sets attachmentsMaterialized', async () => {
    const order: string[] = []
    const mw = makeMwAttachments({
      materializeAttachments: async () => { order.push('mat') },
      inboxDir: '/tmp/inbox',
      log: () => {},
    })
    const ctx: InboundCtx = { msg: { chatId: 'c1' } as InboundCtx['msg'], receivedAtMs: 0, requestId: 'r' }
    await mw(ctx, async () => order.push('next'))
    expect(order).toEqual(['mat', 'next'])
    expect(ctx.attachmentsMaterialized).toBe(true)
  })
})
```

- [ ] **Step 2: Implement `mw-attachments.ts`**

```ts
import type { Middleware, InboundCtx } from './types'

export interface AttachmentsMwDeps {
  materializeAttachments(msg: InboundCtx['msg'], inboxDir: string, log: (tag: string, line: string) => void): Promise<void>
  inboxDir: string
  log: (tag: string, line: string) => void
}

export function makeMwAttachments(deps: AttachmentsMwDeps): Middleware {
  return async (ctx, next) => {
    await deps.materializeAttachments(ctx.msg, deps.inboxDir, deps.log)
    ctx.attachmentsMaterialized = true
    await next()
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
bun --bun vitest run src/daemon/inbound/mw-attachments.test.ts
git add src/daemon/inbound/mw-attachments*.ts
git commit -m "feat(inbound): add mwAttachments (E-tier enrichment)"
```

---

## Task 10: mw-activity + mw-milestone + mw-welcome (W-tier wraps)

**Files:**
- Create: `src/daemon/inbound/mw-activity.ts` + `.test.ts`
- Create: `src/daemon/inbound/mw-milestone.ts` + `.test.ts`
- Create: `src/daemon/inbound/mw-welcome.ts` + `.test.ts`

- [ ] **Step 1: Write `mw-activity.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeMwActivity } from './mw-activity'
import type { InboundCtx } from './types'

const mkCtx = (over: Partial<InboundCtx> = {}): InboundCtx => ({
  msg: { chatId: 'c1', createTimeMs: 1000 } as InboundCtx['msg'],
  receivedAtMs: 5000,
  requestId: 'r',
  ...over,
})

describe('mwActivity', () => {
  it('calls recordInbound after next() when consumedBy unset', async () => {
    const recordInbound = vi.fn(async () => {})
    const mw = makeMwActivity({ recordInbound, log: () => {} })
    await mw(mkCtx(), async () => {})
    expect(recordInbound).toHaveBeenCalledWith('c1', new Date(1000))
  })

  it('uses receivedAtMs when createTimeMs is absent', async () => {
    const recordInbound = vi.fn(async () => {})
    const mw = makeMwActivity({ recordInbound, log: () => {} })
    await mw(mkCtx({ msg: { chatId: 'c1' } as InboundCtx['msg'] }), async () => {})
    expect(recordInbound).toHaveBeenCalledWith('c1', new Date(5000))
  })

  it('skips when consumedBy is set', async () => {
    const recordInbound = vi.fn(async () => {})
    const mw = makeMwActivity({ recordInbound, log: () => {} })
    const ctx = mkCtx()
    await mw(ctx, async () => { ctx.consumedBy = 'admin' })
    expect(recordInbound).not.toHaveBeenCalled()
  })

  it('catches recordInbound failure (does not throw)', async () => {
    const lines: string[] = []
    const mw = makeMwActivity({
      recordInbound: async () => { throw new Error('db down') },
      log: (t, l) => lines.push(`${t} ${l}`),
    })
    await expect(mw(mkCtx(), async () => {})).resolves.toBeUndefined()
    // Allow microtask queue to flush
    await new Promise(r => setImmediate(r))
    expect(lines.some(l => l.startsWith('ACTIVITY') && l.includes('db down'))).toBe(true)
  })
})
```

- [ ] **Step 2: Implement `mw-activity.ts`** (per spec §4.5).

```ts
import type { Middleware } from './types'

export interface ActivityMwDeps {
  recordInbound(chatId: string, when: Date): Promise<void>
  log: (tag: string, line: string) => void
}

export function makeMwActivity(deps: ActivityMwDeps): Middleware {
  return async (ctx, next) => {
    await next()
    if (ctx.consumedBy) return
    const when = new Date(ctx.msg.createTimeMs ?? ctx.receivedAtMs)
    deps.recordInbound(ctx.msg.chatId, when).catch(err =>
      deps.log('ACTIVITY', `record failed for ${ctx.msg.chatId}: ${err instanceof Error ? err.message : err}`),
    )
  }
}
```

- [ ] **Step 3: Implement mw-milestone.ts + test (mirrors mw-activity shape)**

```ts
// mw-milestone.ts
import type { Middleware } from './types'

export interface MilestoneMwDeps {
  fireMilestonesFor(chatId: string): Promise<void>
  log: (tag: string, line: string) => void
}

export function makeMwMilestone(deps: MilestoneMwDeps): Middleware {
  return async (ctx, next) => {
    await next()
    if (ctx.consumedBy) return
    deps.fireMilestonesFor(ctx.msg.chatId).catch(err =>
      deps.log('MILESTONE', `detect failed for ${ctx.msg.chatId}: ${err instanceof Error ? err.message : err}`),
    )
  }
}
```

Test mirrors mw-activity (4 cases: fires after next, uses chatId, skips on consumed, catches failure).

- [ ] **Step 4: Implement mw-welcome.ts + test (mirrors mw-activity shape)**

```ts
// mw-welcome.ts
import type { Middleware } from './types'

export interface WelcomeMwDeps {
  maybeWriteWelcomeObservation(chatId: string): Promise<void>
  log: (tag: string, line: string) => void
}

export function makeMwWelcome(deps: WelcomeMwDeps): Middleware {
  return async (ctx, next) => {
    await next()
    if (ctx.consumedBy) return
    deps.maybeWriteWelcomeObservation(ctx.msg.chatId).catch(err =>
      deps.log('OBSERVE', `welcome write failed for ${ctx.msg.chatId}: ${err instanceof Error ? err.message : err}`),
    )
  }
}
```

Test mirrors mw-activity.

- [ ] **Step 5: Run + commit**

```bash
bun --bun vitest run src/daemon/inbound/mw-activity.test.ts src/daemon/inbound/mw-milestone.test.ts src/daemon/inbound/mw-welcome.test.ts
git add src/daemon/inbound/mw-activity*.ts src/daemon/inbound/mw-milestone*.ts src/daemon/inbound/mw-welcome*.ts
git commit -m "feat(inbound): add W-tier wraps (activity + milestone + welcome)"
```

---

## Task 11: mw-dispatch (D-tier terminal)

**Files:**
- Create: `src/daemon/inbound/mw-dispatch.ts` + `.test.ts`

- [ ] **Step 1: Write `mw-dispatch.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeMwDispatch } from './mw-dispatch'
import type { InboundCtx } from './types'

describe('mwDispatch', () => {
  it('calls coordinator.dispatch with ctx.msg; never calls next()', async () => {
    const dispatch = vi.fn(async () => {})
    const next = vi.fn()
    const mw = makeMwDispatch({ coordinator: { dispatch } })
    const msg = { chatId: 'c1' } as InboundCtx['msg']
    await mw({ msg, receivedAtMs: 0, requestId: 'r' }, next)
    expect(dispatch).toHaveBeenCalledWith(msg)
    expect(next).not.toHaveBeenCalled()
  })

  it('propagates dispatch errors (caught by mwTrace at outer)', async () => {
    const mw = makeMwDispatch({ coordinator: { dispatch: async () => { throw new Error('coord-boom') } } })
    await expect(mw({ msg: {} as InboundCtx['msg'], receivedAtMs: 0, requestId: 'r' }, async () => {}))
      .rejects.toThrow('coord-boom')
  })
})
```

- [ ] **Step 2: Implement `mw-dispatch.ts`**

```ts
import type { Middleware, InboundCtx } from './types'

export interface DispatchMwDeps {
  coordinator: {
    dispatch(msg: InboundCtx['msg']): Promise<void>
  }
}

export function makeMwDispatch(deps: DispatchMwDeps): Middleware {
  return async (ctx, _next) => {
    await deps.coordinator.dispatch(ctx.msg)
    // terminal — never calls next()
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
bun --bun vitest run src/daemon/inbound/mw-dispatch.test.ts
git add src/daemon/inbound/mw-dispatch*.ts
git commit -m "feat(inbound): add mwDispatch (D-tier terminal)"
```

---

## Task 12: Pipeline composer (`build.ts`) + integration test

**Files:**
- Create: `src/daemon/inbound/build.ts`
- Create: `src/daemon/inbound/pipeline.integration.test.ts`

- [ ] **Step 1: Implement `build.ts`**

```ts
import type { PipelineRun } from './types'
import { compose } from './compose'
import { makeMwTrace, type TraceMwDeps } from './mw-trace'
import { makeMwCaptureCtx, type CaptureCtxMwDeps } from './mw-capture-ctx'
import { makeMwTyping, type TypingMwDeps } from './mw-typing'
import { makeMwAdmin, type AdminMwDeps } from './mw-admin'
import { makeMwMode, type ModeMwDeps } from './mw-mode'
import { makeMwOnboarding, type OnboardingMwDeps } from './mw-onboarding'
import { makeMwPermissionReply, type PermissionReplyMwDeps } from './mw-permission-reply'
import { makeMwGuard, type GuardMwDeps } from './mw-guard'
import { makeMwAttachments, type AttachmentsMwDeps } from './mw-attachments'
import { makeMwActivity, type ActivityMwDeps } from './mw-activity'
import { makeMwMilestone, type MilestoneMwDeps } from './mw-milestone'
import { makeMwWelcome, type WelcomeMwDeps } from './mw-welcome'
import { makeMwDispatch, type DispatchMwDeps } from './mw-dispatch'

export interface InboundPipelineDeps {
  trace: TraceMwDeps
  capture: CaptureCtxMwDeps
  typing: TypingMwDeps
  admin: AdminMwDeps
  mode: ModeMwDeps
  onboarding: OnboardingMwDeps
  permissionReply: PermissionReplyMwDeps
  guard: GuardMwDeps
  attachments: AttachmentsMwDeps
  activity: ActivityMwDeps
  milestone: MilestoneMwDeps
  welcome: WelcomeMwDeps
  dispatch: DispatchMwDeps
}

export function buildInboundPipeline(d: InboundPipelineDeps): PipelineRun {
  return compose([
    makeMwTrace(d.trace),
    makeMwCaptureCtx(d.capture),
    makeMwTyping(d.typing),
    makeMwAdmin(d.admin),
    makeMwMode(d.mode),
    makeMwOnboarding(d.onboarding),
    makeMwPermissionReply(d.permissionReply),
    makeMwGuard(d.guard),
    makeMwAttachments(d.attachments),
    makeMwActivity(d.activity),
    makeMwMilestone(d.milestone),
    makeMwWelcome(d.welcome),
    makeMwDispatch(d.dispatch),
  ])
}
```

- [ ] **Step 2: Write `pipeline.integration.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest'
import { buildInboundPipeline, type InboundPipelineDeps } from './build'
import type { InboundCtx } from './types'

function fakeDeps(over: Partial<{
  adminConsumes: boolean; modeConsumes: boolean; onboardingConsumes: boolean;
  permConsumes: boolean; guardEnabled: boolean; guardReachable: boolean;
}> = {}): { deps: InboundPipelineDeps; spy: { dispatch: ReturnType<typeof vi.fn>; activity: ReturnType<typeof vi.fn>; milestone: ReturnType<typeof vi.fn>; welcome: ReturnType<typeof vi.fn> } } {
  const dispatch = vi.fn(async () => {})
  const activity = vi.fn(async () => {})
  const milestone = vi.fn(async () => {})
  const welcome = vi.fn(async () => {})
  const log = () => {}
  const deps: InboundPipelineDeps = {
    trace: { log },
    capture: { markChatActive: () => {}, captureContextToken: () => {} },
    typing: { sendTyping: async () => {} },
    admin: { adminHandler: { handle: async () => over.adminConsumes ?? false } },
    mode: { modeHandler: { handle: async () => over.modeConsumes ?? false } },
    onboarding: { onboardingHandler: { handle: async () => over.onboardingConsumes ?? false } },
    permissionReply: { handlePermissionReply: () => over.permConsumes ?? false, log },
    guard: {
      guardEnabled: () => over.guardEnabled ?? false,
      guardState: () => ({ reachable: over.guardReachable ?? true, ip: '1.2.3.4' }),
      sendMessage: async () => ({ msgId: 'm1' }),
      log,
    },
    attachments: { materializeAttachments: async () => {}, inboxDir: '/tmp', log },
    activity: { recordInbound: activity, log },
    milestone: { fireMilestonesFor: milestone, log },
    welcome: { maybeWriteWelcomeObservation: welcome, log },
    dispatch: { coordinator: { dispatch } },
  }
  return { deps, spy: { dispatch, activity, milestone, welcome } }
}

const mkCtx = (): InboundCtx => ({
  msg: { chatId: 'c1', accountId: 'a1', text: 'hi' } as InboundCtx['msg'],
  receivedAtMs: 0,
  requestId: 'r1',
})

describe('inbound pipeline (integration)', () => {
  it('full happy path: dispatch + W-tier all fire', async () => {
    const { deps, spy } = fakeDeps()
    const run = buildInboundPipeline(deps)
    await run(mkCtx())
    expect(spy.dispatch).toHaveBeenCalledOnce()
    // Allow fire-and-forget to settle
    await new Promise(r => setImmediate(r))
    expect(spy.activity).toHaveBeenCalledOnce()
    expect(spy.milestone).toHaveBeenCalledOnce()
    expect(spy.welcome).toHaveBeenCalledOnce()
  })

  it('admin short-circuit: dispatch + W-tier all skipped', async () => {
    const { deps, spy } = fakeDeps({ adminConsumes: true })
    const run = buildInboundPipeline(deps)
    const ctx = mkCtx()
    await run(ctx)
    expect(spy.dispatch).not.toHaveBeenCalled()
    expect(spy.activity).not.toHaveBeenCalled()
    expect(spy.milestone).not.toHaveBeenCalled()
    expect(spy.welcome).not.toHaveBeenCalled()
    expect(ctx.consumedBy).toBe('admin')
  })

  it('mode short-circuit: dispatch + W-tier all skipped', async () => {
    const { deps, spy } = fakeDeps({ modeConsumes: true })
    await buildInboundPipeline(deps)(mkCtx())
    expect(spy.dispatch).not.toHaveBeenCalled()
  })

  it('onboarding short-circuit', async () => {
    const { deps, spy } = fakeDeps({ onboardingConsumes: true })
    await buildInboundPipeline(deps)(mkCtx())
    expect(spy.dispatch).not.toHaveBeenCalled()
  })

  it('permission-reply short-circuit', async () => {
    const { deps, spy } = fakeDeps({ permConsumes: true })
    await buildInboundPipeline(deps)(mkCtx())
    expect(spy.dispatch).not.toHaveBeenCalled()
  })

  it('guard short-circuit when enabled and unreachable', async () => {
    const { deps, spy } = fakeDeps({ guardEnabled: true, guardReachable: false })
    await buildInboundPipeline(deps)(mkCtx())
    expect(spy.dispatch).not.toHaveBeenCalled()
  })

  it('dispatch error is caught by trace; pipeline does not reject', async () => {
    const { deps } = fakeDeps()
    deps.dispatch.coordinator.dispatch = async () => { throw new Error('coord-boom') }
    await expect(buildInboundPipeline(deps)(mkCtx())).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 3: Run integration test**

Run: `bun --bun vitest run src/daemon/inbound/pipeline.integration.test.ts`
Expected: PASS, 7/7.

- [ ] **Step 4: Run full inbound suite**

Run: `bun --bun vitest run src/daemon/inbound/`
Expected: all green (~50 tests across 14 files).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/inbound/build.ts src/daemon/inbound/pipeline.integration.test.ts
git commit -m "feat(inbound): assemble pipeline + integration test (13 mw, 7 paths)"
```

---

## Task 13: internal-api lifecycle wrapper (async)

**Files:**
- Create: `src/daemon/internal-api/lifecycle.ts`

`internal-api/index.ts` already exposes `start()` returning `{ port, tokenFilePath }` and `stop()`. We wrap to expose the `Lifecycle` shape with extras. No new test file — existing `internal-api.test.ts` covers behaviour.

- [ ] **Step 1: Implement `internal-api/lifecycle.ts`**

```ts
import type { Lifecycle } from '../../lib/lifecycle'
import { createInternalApi, type InternalApiDeps, type InternalApiDelegateDep } from './index'

export interface InternalApiLifecycle extends Lifecycle {
  readonly baseUrl: string
  readonly tokenFilePath: string
  setDelegate(d: InternalApiDelegateDep): void
}

/**
 * Async because HTTP server bind is async; bootstrap needs the actual port
 * before constructing the wechat-mcp stdio MCP spec.
 */
export async function registerInternalApi(deps: InternalApiDeps): Promise<InternalApiLifecycle> {
  const api = createInternalApi(deps)
  const { port, tokenFilePath } = await api.start()
  return {
    name: 'internal-api',
    baseUrl: `http://127.0.0.1:${port}`,
    tokenFilePath,
    setDelegate: (d) => api.setDelegate(d),
    stop: () => api.stop(),
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `bun x tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/internal-api/lifecycle.ts
git commit -m "feat(daemon): add registerInternalApi (async lifecycle wrapper)"
```

---

## Task 14: companion lifecycle (push + introspect)

**Files:**
- Create: `src/daemon/companion/lifecycle.ts`
- Create: `src/daemon/companion/lifecycle.test.ts`

- [ ] **Step 1: Write `lifecycle.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest'
import { registerCompanionPush, registerCompanionIntrospect } from './lifecycle'

describe('registerCompanionPush', () => {
  it('returns a Lifecycle with name=companion-push', () => {
    const lc = registerCompanionPush({
      isEnabled: () => false,
      isSnoozed: () => false,
      log: () => {},
      onTick: async () => {},
    })
    expect(lc.name).toBe('companion-push')
    expect(typeof lc.stop).toBe('function')
  })

  it('stop() is idempotent', async () => {
    const lc = registerCompanionPush({
      isEnabled: () => false,
      isSnoozed: () => false,
      log: () => {},
      onTick: async () => {},
    })
    await lc.stop()
    await expect(lc.stop()).resolves.toBeUndefined()
  })
})

describe('registerCompanionIntrospect', () => {
  it('returns a Lifecycle with name=companion-introspect', () => {
    const lc = registerCompanionIntrospect({
      isEnabled: () => false,
      isSnoozed: () => false,
      log: () => {},
      onTick: async () => {},
    })
    expect(lc.name).toBe('companion-introspect')
  })
})
```

- [ ] **Step 2: Implement `lifecycle.ts`**

```ts
import type { Lifecycle } from '../../lib/lifecycle'
import { startCompanionScheduler } from './scheduler'

export interface CompanionPushDeps {
  isEnabled(): boolean
  isSnoozed(): boolean
  log: (tag: string, line: string) => void
  onTick(): Promise<void>
}

const PUSH_INTERVAL_MS = 20 * 60 * 1000
const INTROSPECT_INTERVAL_MS = 24 * 60 * 60 * 1000
const JITTER = 0.3

export function registerCompanionPush(deps: CompanionPushDeps): Lifecycle {
  const stop = startCompanionScheduler({
    name: 'push',
    intervalMs: PUSH_INTERVAL_MS,
    jitterRatio: JITTER,
    isEnabled: deps.isEnabled,
    isSnoozed: deps.isSnoozed,
    log: deps.log,
    onTick: deps.onTick,
  })
  let stopped = false
  return {
    name: 'companion-push',
    stop: async () => { if (!stopped) { stopped = true; await stop() } },
  }
}

export interface CompanionIntrospectDeps extends CompanionPushDeps {}

export function registerCompanionIntrospect(deps: CompanionIntrospectDeps): Lifecycle {
  const stop = startCompanionScheduler({
    name: 'introspect',
    intervalMs: INTROSPECT_INTERVAL_MS,
    jitterRatio: JITTER,
    isEnabled: deps.isEnabled,
    isSnoozed: deps.isSnoozed,
    log: deps.log,
    onTick: deps.onTick,
  })
  let stopped = false
  return {
    name: 'companion-introspect',
    stop: async () => { if (!stopped) { stopped = true; await stop() } },
  }
}
```

Note: startup-catch-up for introspect (the `maybeStartupIntrospect` from current main.ts) lives in `startup-sweeps.ts` (Task 19), not here.

- [ ] **Step 3: Run + commit**

```bash
bun --bun vitest run src/daemon/companion/lifecycle.test.ts
git add src/daemon/companion/lifecycle.ts src/daemon/companion/lifecycle.test.ts
git commit -m "feat(daemon): add companion lifecycle (push + introspect schedulers)"
```

---

## Task 15: guard lifecycle

**Files:**
- Create: `src/daemon/guard/lifecycle.ts`
- Create: `src/daemon/guard/lifecycle.test.ts`

- [ ] **Step 1: Write `lifecycle.test.ts`**

Mirror Task 14 — verify name='guard', stop is idempotent. Also verify the lifecycle exposes a `current()` method (since main.ts calls `stopGuard.current()` in mwGuard's deps wiring) — see existing guard/scheduler.ts for the shape.

```ts
import { describe, it, expect } from 'vitest'
import { registerGuard } from './lifecycle'

describe('registerGuard', () => {
  it('returns a Lifecycle with name=guard and current() method', () => {
    const lc = registerGuard({
      pollMs: 30_000,
      isEnabled: () => false,
      probeUrl: () => 'https://google.com',
      ipifyUrl: () => 'https://api.ipify.org',
      log: () => {},
      onStateChange: async () => {},
    })
    expect(lc.name).toBe('guard')
    expect(typeof lc.current).toBe('function')
    expect(lc.current()).toEqual(expect.objectContaining({ reachable: expect.any(Boolean) }))
  })
})
```

- [ ] **Step 2: Implement `guard/lifecycle.ts`**

```ts
import type { Lifecycle } from '../../lib/lifecycle'
import { startGuardScheduler, type GuardSchedulerDeps, type GuardState } from './scheduler'

export interface GuardLifecycle extends Lifecycle {
  current(): GuardState
}

export function registerGuard(deps: GuardSchedulerDeps): GuardLifecycle {
  const handle = startGuardScheduler(deps)
  return {
    name: 'guard',
    stop: () => handle.stop(),
    current: () => handle.current(),
  }
}
```

(If the scheduler's exported types differ from the names used here, adjust per the actual exports in `src/daemon/guard/scheduler.ts`.)

- [ ] **Step 3: Run + commit**

```bash
bun --bun vitest run src/daemon/guard/lifecycle.test.ts
git add src/daemon/guard/lifecycle*.ts
git commit -m "feat(daemon): add guard lifecycle wrapper"
```

---

## Task 16: sessions + ilink lifecycles

**Files:**
- Create: `src/daemon/sessions-lifecycle.ts` + `.test.ts`
- Create: `src/daemon/ilink-lifecycle.ts` + `.test.ts`

- [ ] **Step 1: Write tests + implementations together (two small wrappers)**

```ts
// sessions-lifecycle.ts
import type { Lifecycle } from '../lib/lifecycle'
import type { SessionManager } from '../core/session-manager'
import type { SessionStore } from '../core/session-store'
import type { ConversationStore } from '../core/conversation-store'

export interface SessionsLifecycleDeps {
  sessionManager: Pick<SessionManager, 'shutdown'>
  sessionStore: Pick<SessionStore, 'flush'>
  conversationStore: Pick<ConversationStore, 'flush'>
}

export function registerSessions(deps: SessionsLifecycleDeps): Lifecycle {
  let stopped = false
  return {
    name: 'sessions',
    stop: async () => {
      if (stopped) return
      stopped = true
      await deps.sessionManager.shutdown()
      await deps.sessionStore.flush()
      await deps.conversationStore.flush()
    },
  }
}
```

```ts
// sessions-lifecycle.test.ts
import { describe, it, expect, vi } from 'vitest'
import { registerSessions } from './sessions-lifecycle'

describe('registerSessions', () => {
  it('stop() calls shutdown, then both flushes, in order', async () => {
    const order: string[] = []
    const lc = registerSessions({
      sessionManager: { shutdown: vi.fn(async () => { order.push('shutdown') }) },
      sessionStore: { flush: vi.fn(async () => { order.push('store') }) },
      conversationStore: { flush: vi.fn(async () => { order.push('conv') }) },
    })
    await lc.stop()
    expect(order).toEqual(['shutdown', 'store', 'conv'])
  })

  it('stop() is idempotent', async () => {
    const shutdown = vi.fn(async () => {})
    const lc = registerSessions({
      sessionManager: { shutdown },
      sessionStore: { flush: vi.fn(async () => {}) },
      conversationStore: { flush: vi.fn(async () => {}) },
    })
    await lc.stop(); await lc.stop()
    expect(shutdown).toHaveBeenCalledOnce()
  })
})
```

```ts
// ilink-lifecycle.ts
import type { Lifecycle } from '../lib/lifecycle'

export interface IlinkLifecycleDeps {
  ilink: { flush(): Promise<void> }
}

export function registerIlink(deps: IlinkLifecycleDeps): Lifecycle {
  let stopped = false
  return {
    name: 'ilink',
    stop: async () => {
      if (stopped) return
      stopped = true
      await deps.ilink.flush()
    },
  }
}
```

```ts
// ilink-lifecycle.test.ts
import { describe, it, expect, vi } from 'vitest'
import { registerIlink } from './ilink-lifecycle'

describe('registerIlink', () => {
  it('stop() calls ilink.flush', async () => {
    const flush = vi.fn(async () => {})
    const lc = registerIlink({ ilink: { flush } })
    await lc.stop()
    expect(flush).toHaveBeenCalledOnce()
  })

  it('stop() is idempotent', async () => {
    const flush = vi.fn(async () => {})
    const lc = registerIlink({ ilink: { flush } })
    await lc.stop(); await lc.stop()
    expect(flush).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run + commit**

```bash
bun --bun vitest run src/daemon/sessions-lifecycle.test.ts src/daemon/ilink-lifecycle.test.ts
git add src/daemon/sessions-lifecycle*.ts src/daemon/ilink-lifecycle*.ts
git commit -m "feat(daemon): add sessions + ilink lifecycle wrappers"
```

---

## Task 17: polling lifecycle (with reconcile)

**Files:**
- Create: `src/daemon/polling-lifecycle.ts`
- Create: `src/daemon/polling-lifecycle.test.ts`

- [ ] **Step 1: Write `polling-lifecycle.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest'
import { registerPolling } from './polling-lifecycle'
import type { InboundCtx } from './inbound/types'

describe('registerPolling', () => {
  it('returns Lifecycle with name=polling and reconcile()', () => {
    const lc = registerPolling({
      stateDir: '/tmp/wechat-cc',
      accounts: [],
      ilink: { getUpdates: async () => ({ updates: [] }) },
      parse: () => [],
      resolveUserName: () => undefined,
      log: () => {},
      runPipeline: async (_ctx: InboundCtx) => {},
    })
    expect(lc.name).toBe('polling')
    expect(typeof lc.reconcile).toBe('function')
  })

  it('stop() is idempotent', async () => {
    const lc = registerPolling({
      stateDir: '/tmp/wechat-cc',
      accounts: [],
      ilink: { getUpdates: async () => ({ updates: [] }) },
      parse: () => [],
      resolveUserName: () => undefined,
      log: () => {},
      runPipeline: async () => {},
    })
    await lc.stop(); await expect(lc.stop()).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Implement `polling-lifecycle.ts`**

```ts
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Lifecycle } from '../lib/lifecycle'
import { startLongPollLoops, parseUpdates, type RawUpdate } from './poll-loop'
import { loadAllAccounts, type IlinkAccount } from './ilink-glue'
import type { PipelineRun } from './inbound/types'

export interface PollingDeps {
  stateDir: string
  accounts: IlinkAccount[]
  ilink: {
    getUpdates(accountId: string, baseUrl: string, token: string, syncBuf?: string): Promise<{
      updates?: RawUpdate[]
      sync_buf?: string
      expired?: boolean
    }>
  }
  parse: typeof parseUpdates
  resolveUserName(chatId: string): string | undefined
  log: (tag: string, line: string) => void
  runPipeline: PipelineRun
}

export interface PollingLifecycle extends Lifecycle {
  reconcile(): Promise<void>
  /** Used by admin commands (`/health` cleanup of expired bot sessions). */
  stopAccount(accountId: string): Promise<void>
  /** Returns currently-running account ids. */
  running(): string[]
  /** Add a freshly-bound account to the polling loop without restart. */
  addAccount(account: IlinkAccount): void
}

export function registerPolling(deps: PollingDeps): PollingLifecycle {
  let stopped = false
  const inboxDir = join(deps.stateDir, 'inbox')
  mkdirSync(inboxDir, { recursive: true })

  const handle = startLongPollLoops({
    accounts: deps.accounts,
    ilink: deps.ilink,
    parse: deps.parse,
    resolveUserName: deps.resolveUserName,
    log: deps.log,
    onInbound: async (msg) => {
      const requestId = Math.random().toString(16).slice(2, 10)
      await deps.runPipeline({
        msg,
        receivedAtMs: Date.now(),
        requestId,
      })
    },
  })

  return {
    name: 'polling',
    stop: async () => {
      if (stopped) return
      stopped = true
      await handle.stop()
    },
    reconcile: async () => {
      const latest = await loadAllAccounts(deps.stateDir)
      const known = new Set(handle.running())
      const fresh = latest.filter(a => !known.has(a.id))
      if (fresh.length === 0) {
        deps.log('RECONCILE', 'no new accounts')
        return
      }
      for (const a of fresh) handle.addAccount(a)
      deps.log('RECONCILE', `picked up ${fresh.length} new account(s): ${fresh.map(a => a.id).join(', ')}`)
    },
    stopAccount: (id) => handle.stopAccount(id),
    running: () => handle.running(),
    addAccount: (a) => handle.addAccount(a),
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
bun --bun vitest run src/daemon/polling-lifecycle.test.ts
git add src/daemon/polling-lifecycle*.ts
git commit -m "feat(daemon): add polling lifecycle with reconcile() for SIGUSR1"
```

---

## Task 18: main-wiring (deps factory hub)

**Files:**
- Create: `src/daemon/main-wiring.ts`

This file holds all dep factories that main.ts would otherwise carry inline. It does NOT have its own tests — its components are tested individually; main.ts's startup is covered by `apps/desktop/shim.e2e.test.ts`.

- [ ] **Step 1: Implement `main-wiring.ts`**

```ts
import { join } from 'node:path'
import type { Db } from '../lib/db'
import type { IlinkAdapter } from './ilink-glue'
import type { Bootstrap } from './bootstrap'
import { isAdmin } from '../lib/access'
import { makeAdminCommands } from './admin-commands'
import { makeModeCommands } from './mode-commands'
import { makeOnboardingHandler } from './onboarding'
import { materializeAttachments } from './media'
import { loadCompanionConfig, saveCompanionConfig } from './companion/config'
import { loadGuardConfig } from './guard/store'
import { buildMemorySnapshot } from './memory/snapshot'
import { buildDetectorContext } from './milestones/build-context'
import { detectMilestones } from './milestones/detector'
import { makeMilestonesStore } from './milestones/store'
import { makeEventsStore } from './events/store'
import { makeActivityStore } from './activity/store'
import { makeObservationsStore } from './observations/store'
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { InboundPipelineDeps } from './inbound/build'
import type { CompanionPushDeps, CompanionIntrospectDeps } from './companion/lifecycle'
import type { GuardSchedulerDeps } from './guard/scheduler'
import type { SessionsLifecycleDeps } from './sessions-lifecycle'
import type { IlinkLifecycleDeps } from './ilink-lifecycle'
import type { PollingDeps } from './polling-lifecycle'
import type { StartupSweepDeps } from './startup-sweeps'
import type { GuardLifecycle } from './guard/lifecycle'
import type { PollingLifecycle } from './polling-lifecycle'
import { runIntrospectTick } from './companion/introspect'
import { resolveIntrospectChatId, makeIntrospectAgent } from './companion/introspect-runtime'

export interface WireMainOpts {
  stateDir: string
  db: Db
  ilink: IlinkAdapter
  boot: Bootstrap
  dangerously: boolean
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void
}

export interface WiredDeps {
  pipelineDeps: InboundPipelineDeps
  companionPushDeps: CompanionPushDeps
  companionIntrospectDeps: CompanionIntrospectDeps
  guardDeps: GuardSchedulerDeps
  sessionsDeps: SessionsLifecycleDeps
  ilinkDeps: IlinkLifecycleDeps
  pollingDeps: Omit<PollingDeps, 'runPipeline'>
  startupDeps: StartupSweepDeps
  /**
   * Late-bound references — main.ts populates `.current` after the corresponding
   * lifecycle is registered. wireMain captures these Refs into closures
   * (admin handler's pollHandle, mwGuard's guardState) so the closures see
   * the live handle without circular construction.
   */
  refs: {
    polling: { current: PollingLifecycle | null }
    guard: { current: GuardLifecycle | null }
  }
}

const STARTED_AT_ISO = new Date().toISOString()

function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err) }

export function wireMain(opts: WireMainOpts): WiredDeps {
  const { stateDir, db, ilink, boot, log } = opts
  const pollingRef: { current: PollingLifecycle | null } = { current: null }
  const guardRef: { current: GuardLifecycle | null } = { current: null }

  // Closures over per-chat side effects (formerly inline in main.ts)
  async function fireMilestonesFor(chatId: string): Promise<void> {
    const ctx = await buildDetectorContext({ stateDir, chatId, db })
    const memRoot = join(stateDir, 'memory')
    const milestones = makeMilestonesStore(db, chatId, { migrateFromFile: join(memRoot, chatId, 'milestones.jsonl') })
    const events = makeEventsStore(db, chatId, { migrateFromFile: join(memRoot, chatId, 'events.jsonl') })
    const fired = await detectMilestones(milestones, ctx)
    for (const id of fired) {
      await events.append({ kind: 'milestone', trigger: 'detector', reasoning: `milestone ${id} fired`, milestone_id: id })
    }
  }

  async function recordInbound(chatId: string, when: Date): Promise<void> {
    const memRoot = join(stateDir, 'memory')
    const store = makeActivityStore(db, chatId, { migrateFromFile: join(memRoot, chatId, 'activity.jsonl') })
    await store.recordInbound(when)
  }

  async function maybeWriteWelcomeObservation(chatId: string): Promise<void> {
    const memRoot = join(stateDir, 'memory')
    const obs = makeObservationsStore(db, chatId, { migrateFromFile: join(memRoot, chatId, 'observations.jsonl') })
    const existing = await obs.listActive()
    const archived = await obs.listArchived()
    if (existing.length === 0 && archived.length === 0) {
      await obs.append({
        body: '嗨，我是 Claude。我会慢慢理解你，把观察写在这里——你可以随时来翻、纠正、忽略。',
        tone: 'playful',
      })
    }
  }

  async function isolatedSdkEval(prompt: string): Promise<string> {
    const q = query({ prompt, options: { model: 'claude-haiku-4-5', maxTurns: 1 } })
    let text = ''
    for await (const raw of q as AsyncGenerator<SDKMessage>) {
      const msg = raw as unknown as { type: string; message?: { content?: unknown } }
      if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
        for (const part of msg.message.content as Array<{ type?: string; text?: string }>) {
          if (part.type === 'text' && typeof part.text === 'string') text += part.text
        }
      }
    }
    return text
  }

  const inboxDir = join(stateDir, 'inbox')
  const launchCwd = process.cwd()

  // Companion push tick body — same logic as legacy main.ts
  async function pushTick(): Promise<void> {
    const cfg = loadCompanionConfig(stateDir)
    if (!cfg.default_chat_id) { log('SCHED', 'skip tick — no default_chat_id'); return }
    const snapshot = ilink.loadProjects()
    const currentAlias = snapshot.current && snapshot.projects[snapshot.current] ? snapshot.current : null
    const proj = currentAlias
      ? { alias: currentAlias, path: snapshot.projects[currentAlias]!.path }
      : { alias: '_default', path: launchCwd }
    const handle = await boot.sessionManager.acquire(proj.alias, proj.path, boot.defaultProviderId)
    const tickText =
      `<companion_tick ts="${new Date().toISOString()}" default_chat_id="${cfg.default_chat_id}" />\n` +
      `定时唤醒。先 memory_list + memory_read 你觉得相关的文件。` +
      `再看当前时间和用户最近状态。决定是否向 ${cfg.default_chat_id} push，或保持沉默。` +
      `不确定就选不打扰。push 后写一条 memory 记下决策和意图（便于下次 tick 读到效果）。`
    try { await handle.dispatch(tickText) }
    catch (err) { log('SCHED', `companion tick dispatch failed: ${errMsg(err)}`) }
  }

  // Companion introspect tick body
  async function introspectTick(): Promise<void> {
    const chatId = resolveIntrospectChatId(stateDir)
    if (!chatId) { log('INTROSPECT', 'skip tick — no default_chat_id'); return }
    const memoryRoot = join(stateDir, 'memory')
    const events = makeEventsStore(db, chatId, { migrateFromFile: join(memoryRoot, chatId, 'events.jsonl') })
    const observations = makeObservationsStore(db, chatId, { migrateFromFile: join(memoryRoot, chatId, 'observations.jsonl') })
    const agent = makeIntrospectAgent({
      chatId, events, observations,
      memorySnapshot: () => buildMemorySnapshot(stateDir, chatId),
      recentInboundMessages: () => Promise.resolve([] as string[]),
      sdkEval: isolatedSdkEval,
    })
    await runIntrospectTick({ events, observations, agent, chatId, log })
    await saveCompanionConfig(stateDir, { ...loadCompanionConfig(stateDir), last_introspect_at: new Date().toISOString() })
  }

  // Build pipelineDeps
  const adminHandler = {
    handle: (msg: Parameters<ReturnType<typeof makeAdminCommands>['handle']>[0]) =>
      adminCommandsHandler.handle(msg),
  }
  const adminCommandsHandler = makeAdminCommands({
    stateDir, isAdmin,
    sessionState: ilink.sessionState,
    // Ref-indirected: pollingRef.current is null at construction time; main.ts
    // populates it after registerPolling(). Closures fire after startup so by
    // the time anyone calls /health the ref is live.
    pollHandle: {
      stopAccount: (id) => pollingRef.current?.stopAccount(id) ?? Promise.resolve(),
      running: () => pollingRef.current?.running() ?? [],
    },
    resolveUserName: (cid) => ilink.resolveUserName(cid),
    sendMessage: (cid, txt) => ilink.sendMessage(cid, txt),
    sharePage: (t, c, o) => ilink.sharePage(t, c, o),
    log,
    startedAt: STARTED_AT_ISO,
  })

  const modeHandler = makeModeCommands({
    coordinator: boot.coordinator,
    registry: boot.registry,
    defaultProviderId: boot.defaultProviderId,
    sendMessage: (cid, txt) => ilink.sendMessage(cid, txt),
    log,
  })

  const onboardingHandler = makeOnboardingHandler({
    isKnownUser: (uid) => ilink.resolveUserName(uid) !== undefined,
    setUserName: (cid, name) => ilink.setUserName(cid, name),
    sendMessage: async (cid, txt) => { await ilink.sendMessage(cid, txt) },
    log,
  })

  const pipelineDeps: InboundPipelineDeps = {
    trace: { log },
    capture: {
      markChatActive: (c, a) => ilink.markChatActive(c, a),
      captureContextToken: (c, t) => ilink.captureContextToken(c, t),
    },
    typing: { sendTyping: (c, a) => ilink.sendTyping(c, a) },
    admin: { adminHandler: adminCommandsHandler },
    mode: { modeHandler },
    onboarding: { onboardingHandler },
    permissionReply: {
      handlePermissionReply: (text) => ilink.handlePermissionReply(text),
      log,
    },
    guard: {
      guardEnabled: () => loadGuardConfig(stateDir).enabled,
      guardState: () => guardRef.current?.current() ?? { reachable: true, ip: null },
      sendMessage: (c, t) => ilink.sendMessage(c, t).then(r => r as { msgId: string }),
      log,
    },
    attachments: { materializeAttachments, inboxDir, log },
    activity: { recordInbound, log },
    milestone: { fireMilestonesFor, log },
    welcome: { maybeWriteWelcomeObservation, log },
    dispatch: { coordinator: { dispatch: (msg) => boot.coordinator.dispatch(msg) } },
  }

  return {
    pipelineDeps,
    companionPushDeps: {
      isEnabled: () => loadCompanionConfig(stateDir).enabled,
      isSnoozed: () => {
        const s = loadCompanionConfig(stateDir).snooze_until
        return !!s && Date.parse(s) > Date.now()
      },
      log,
      onTick: pushTick,
    },
    companionIntrospectDeps: {
      isEnabled: () => loadCompanionConfig(stateDir).enabled,
      isSnoozed: () => {
        const s = loadCompanionConfig(stateDir).snooze_until
        return !!s && Date.parse(s) > Date.now()
      },
      log,
      onTick: introspectTick,
    },
    guardDeps: {
      pollMs: 30_000,
      isEnabled: () => loadGuardConfig(stateDir).enabled,
      probeUrl: () => loadGuardConfig(stateDir).probe_url,
      ipifyUrl: () => loadGuardConfig(stateDir).ipify_url,
      log,
      onStateChange: async (prev, next) => {
        if (prev.reachable && !next.reachable) {
          log('GUARD', `network DOWN — shutting down all sessions (was ${prev.ip}, now ${next.ip})`)
          await boot.sessionManager.shutdown()
        }
      },
    },
    sessionsDeps: {
      sessionManager: boot.sessionManager,
      sessionStore: boot.sessionStore,
      conversationStore: boot.conversationStore,
    },
    ilinkDeps: { ilink: { flush: () => ilink.flush() } },
    pollingDeps: {
      stateDir,
      accounts: ilink.accounts,
      ilink: {
        getUpdates: (id, base, tok, sb) =>
          ilink.getUpdatesForLoop(id, base, tok, sb) as ReturnType<PollingDeps['ilink']['getUpdates']>,
      },
      parse: (raws) => raws as never,  // parseUpdates re-exported from poll-loop
      resolveUserName: (cid) => ilink.resolveUserName(cid),
      log,
    },
    startupDeps: {
      stateDir, db, ilink, log,
      runIntrospectOnce: introspectTick,
    },
    refs: { polling: pollingRef, guard: guardRef },
  }
}
```

⚠ This wiring file is large (~150 LOC) but contains zero new logic — it's a relocation of closures from current main.ts. Do not refactor or simplify any closure body during this task. Behaviour-equivalence is the contract.

- [ ] **Step 2: Typecheck**

Run: `bun x tsc --noEmit`
Expected: no errors. (If errors surface from interface mismatches with `IlinkAdapter` exports, fix by aligning types with the actual exports — do NOT change the wiring shape.)

- [ ] **Step 3: Commit**

```bash
git add src/daemon/main-wiring.ts
git commit -m "feat(daemon): add main-wiring — deps factory hub for pipeline + lifecycles"
```

---

## Task 19: startup-sweeps (one-shot fire-and-forget)

**Files:**
- Create: `src/daemon/startup-sweeps.ts`

- [ ] **Step 1: Implement `startup-sweeps.ts`**

```ts
import { join } from 'node:path'
import type { Db } from '../lib/db'
import type { IlinkAdapter } from './ilink-glue'
import { cleanupOldInbox } from './media'
import { loadCompanionConfig } from './companion/config'
import { loadAccess } from '../lib/access'
import { notifyStartup } from './notify-startup'
import { buildDetectorContext } from './milestones/build-context'
import { detectMilestones } from './milestones/detector'
import { makeMilestonesStore } from './milestones/store'
import { makeEventsStore } from './events/store'

export interface StartupSweepDeps {
  stateDir: string
  db: Db
  ilink: IlinkAdapter
  log: (tag: string, line: string) => void
  /** introspect tick body — invoked if 24h+ since last */
  runIntrospectOnce: () => Promise<void>
}

/**
 * Fire-and-forget all startup sweeps. Returns immediately; failures are
 * logged but never thrown. Does NOT block daemon ready.
 */
export function runStartupSweeps(deps: StartupSweepDeps): void {
  void runMilestoneSweep(deps)
  void runInboxCleanup(deps)
  void runStartupNotify(deps)
  void runIntrospectCatchUp(deps)
}

async function runMilestoneSweep(deps: StartupSweepDeps): Promise<void> {
  try {
    const bootChatId = loadCompanionConfig(deps.stateDir).default_chat_id
    if (!bootChatId) return
    const ctx = await buildDetectorContext({ stateDir: deps.stateDir, chatId: bootChatId, db: deps.db })
    const memRoot = join(deps.stateDir, 'memory')
    const milestones = makeMilestonesStore(deps.db, bootChatId, {
      migrateFromFile: join(memRoot, bootChatId, 'milestones.jsonl'),
    })
    const events = makeEventsStore(deps.db, bootChatId, {
      migrateFromFile: join(memRoot, bootChatId, 'events.jsonl'),
    })
    const fired = await detectMilestones(milestones, ctx)
    for (const id of fired) {
      await events.append({ kind: 'milestone', trigger: 'detector', reasoning: `milestone ${id} fired (boot sweep)`, milestone_id: id })
    }
  } catch (err) {
    deps.log('MILESTONE', `boot sweep failed: ${err instanceof Error ? err.message : err}`)
  }
}

async function runInboxCleanup(deps: StartupSweepDeps): Promise<void> {
  try {
    const inboxDir = join(deps.stateDir, 'inbox')
    const removed = cleanupOldInbox(inboxDir)
    if (removed > 0) deps.log('INBOX', `cleaned ${removed} files older than 30 days`)
  } catch (err) {
    deps.log('INBOX', `cleanup failed: ${err instanceof Error ? err.message : err}`)
  }
}

async function runStartupNotify(deps: StartupSweepDeps): Promise<void> {
  try {
    await notifyStartup(
      {
        stateDir: deps.stateDir,
        loadAccess: () => {
          const a = loadAccess()
          return { allowFrom: a.allowFrom, admins: a.admins }
        },
        send: (cid, txt) => deps.ilink.sendMessage(cid, txt),
        log: deps.log,
      },
      { pid: process.pid, accounts: deps.ilink.accounts.length, dangerously: false },
    )
  } catch (err) {
    deps.log('NOTIFY', `unhandled: ${err instanceof Error ? err.message : err}`)
  }
}

async function runIntrospectCatchUp(deps: StartupSweepDeps): Promise<void> {
  try {
    const cfg = loadCompanionConfig(deps.stateDir)
    if (!cfg.enabled) return
    const snooze = cfg.snooze_until
    if (snooze && Date.parse(snooze) > Date.now()) return
    const last = cfg.last_introspect_at
    if (last && Date.now() - Date.parse(last) < 24 * 60 * 60 * 1000) return
    await deps.runIntrospectOnce()
    deps.log('INTROSPECT', 'startup tick fired')
  } catch (err) {
    deps.log('INTROSPECT', `startup tick failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
bun x tsc --noEmit
git add src/daemon/startup-sweeps.ts
git commit -m "feat(daemon): add startup-sweeps (milestone + inbox + notify + introspect catch-up)"
```

---

## Task 20: Capability matrix integration — permission-relay

**Files:**
- Modify: `src/core/permission-relay.ts`
- Modify: `src/core/permission-relay.test.ts`

- [ ] **Step 1: Read current `permission-relay.ts` to understand `makeCanUseTool` signature**

Run: `cat src/core/permission-relay.ts | head -80`
Note the existing `CanUseToolDeps` shape and what `makeCanUseTool` returns.

- [ ] **Step 2: Add new test cases (failing)**

Add to `src/core/permission-relay.test.ts`:
```ts
import { CAPABILITY_MATRIX } from './capability-matrix'

describe('permission-relay × capability-matrix', () => {
  it.each(CAPABILITY_MATRIX.filter(r => r.askUser === 'never'))(
    '$mode/$provider/$permissionMode → askUser="never" SHOULD short-circuit to allow',
    async (row) => {
      const askUser = vi.fn(async () => 'allow' as const)
      const canUse = makeCanUseTool({
        askUser,
        defaultChatId: () => 'c1',
        log: () => {},
        mode: row.mode,
        provider: row.provider,
        permissionMode: row.permissionMode,
      })
      const result = await canUse('Bash', { command: 'ls' }, { signal: new AbortController().signal, suggestions: [] })
      expect(result.behavior).toBe('allow')
      expect(askUser).not.toHaveBeenCalled()
    },
  )

  it.each(CAPABILITY_MATRIX.filter(r => r.askUser === 'per-tool'))(
    '$mode/$provider/$permissionMode → askUser="per-tool" SHOULD invoke askUser',
    async (row) => {
      const askUser = vi.fn(async () => 'allow' as const)
      const canUse = makeCanUseTool({
        askUser,
        defaultChatId: () => 'c1',
        log: () => {},
        mode: row.mode,
        provider: row.provider,
        permissionMode: row.permissionMode,
      })
      await canUse('Bash', { command: 'ls' }, { signal: new AbortController().signal, suggestions: [] })
      expect(askUser).toHaveBeenCalled()
    },
  )
})
```

- [ ] **Step 3: Run test to verify failure**

Run: `bun --bun vitest run src/core/permission-relay.test.ts`
Expected: FAIL — new tests reference `mode`/`provider`/`permissionMode` deps not yet on `CanUseToolDeps`.

- [ ] **Step 4: Modify `permission-relay.ts`**

Add to `CanUseToolDeps` interface:
```ts
import type { Mode, ProviderId } from './conversation'
import { lookup, type PermissionMode } from './capability-matrix'

export interface CanUseToolDeps {
  // ... existing fields
  mode: Mode['kind']
  provider: ProviderId
  permissionMode: PermissionMode
}
```

Modify `makeCanUseTool` body — early in the function, before any askUser call:
```ts
return async (toolName, input, { signal, suggestions }) => {
  const cap = lookup(deps.mode, deps.provider, deps.permissionMode)
  if (cap.askUser === 'never') {
    return { behavior: 'allow', updatedInput: input }
  }
  // ... existing logic falls through
}
```

- [ ] **Step 5: Update existing test setup**

The pre-existing `makeCanUseTool` test setup needs the three new fields. Add a helper:
```ts
const baseMode = { mode: 'solo' as const, provider: 'claude' as const, permissionMode: 'strict' as const }
```
And pass `...baseMode` to every existing `makeCanUseTool({...})` call in the file.

- [ ] **Step 6: Run all permission-relay tests**

Run: `bun --bun vitest run src/core/permission-relay.test.ts`
Expected: all green (existing + ~14 new cartesian).

- [ ] **Step 7: Commit**

```bash
git add src/core/permission-relay.ts src/core/permission-relay.test.ts
git commit -m "feat(core): permission-relay reads capability-matrix; cartesian test coverage"
```

---

## Task 21: Capability matrix integration — coordinator + codex provider + bootstrap + internal-api routes

**Files:**
- Modify: `src/core/conversation-coordinator.ts`
- Modify: `src/core/conversation-coordinator.test.ts`
- Modify: `src/core/codex-agent-provider.ts`
- Modify: `src/daemon/bootstrap/index.ts`
- Modify: `src/daemon/internal-api/routes.ts`
- Modify: `src/daemon/internal-api.test.ts`

These four integrations are small (~5-line each); bundle in one task to land them atomically.

- [ ] **Step 1: Add `permissionMode` to `ConversationCoordinatorDeps`**

In `src/core/conversation-coordinator.ts`:
```ts
import { assertSupported, type PermissionMode } from './capability-matrix'

export interface ConversationCoordinatorDeps {
  // ... existing
  permissionMode: PermissionMode
}
```

In the `dispatch(msg)` method, immediately after `getMode(msg.chatId)`:
```ts
const mode = getMode(msg.chatId)
const providersInUse: ProviderId[] = mode.kind === 'solo' ? [mode.provider]
  : mode.kind === 'primary_tool' ? [mode.primary]
  : parallelProviders
for (const p of providersInUse) {
  assertSupported(mode.kind, p, deps.permissionMode)
}
```

- [ ] **Step 2: Add coordinator test (failing)**

In `src/core/conversation-coordinator.test.ts`:
```ts
import { lookup } from './capability-matrix'
// ...
it('calls assertSupported for the dispatched provider on entry', async () => {
  // Build a coordinator with a stubbed registry that has 'claude' but not 'codex'.
  // Set chat mode to solo+claude. Verify assertSupported was called.
  // (Concrete setup mirrors existing coordinator.test.ts construction patterns.)
})
```

- [ ] **Step 3: Update existing coordinator test setup** to pass `permissionMode: 'strict'` in every `createConversationCoordinator({...})` call.

- [ ] **Step 4: Modify `codex-agent-provider.ts`**

Currently the codex provider takes options inline. Verify `approvalPolicy` is accepted from caller (it already is — see existing `createCodexAgentProvider` signature). The change is bootstrap-side: bootstrap computes `approvalPolicy` from matrix.

If codex-agent-provider hardcodes the value anywhere, replace with the parameter. Likely no change needed here.

- [ ] **Step 5: Modify `daemon/bootstrap/index.ts`**

Find the codex provider creation (~line 240) and replace the hardcoded `approvalPolicy: 'never'` with:
```ts
import { lookup, type PermissionMode } from '../../core/capability-matrix'

const permissionMode: PermissionMode = deps.dangerouslySkipPermissions ? 'dangerously' : 'strict'

// when creating codex provider:
const codexCap = lookup('solo', 'codex', permissionMode)
const codexApproval = codexCap.approvalPolicy ?? 'never'

registry.register('codex', createCodexAgentProvider({
  // ...
  approvalPolicy: codexApproval,
  // ...
}), { ... })
```

Also pass `permissionMode` into the coordinator factory:
```ts
const coordinator = createConversationCoordinator({
  // ... existing fields
  permissionMode,
})
```

And thread `permissionMode` into the canUseTool builder:
```ts
const canUseTool = makeCanUseTool({
  askUser: deps.ilink.askUser,
  defaultChatId: () => deps.lastActiveChatId(),
  log: deps.log,
  // permissionMode + mode + provider per call site:
  // For Claude solo (the default), use defaults; coordinator dispatches per chat
  // — see RFC 04 §5.4 note: per-chat mode requires per-call lookup
  // For now wire static defaults; per-chat mode lookup is a follow-up.
  mode: 'solo',
  provider: 'claude',
  permissionMode,
})
```

(Per-chat dynamic lookup is a follow-up enhancement — see spec §5.5. For v1.0 the static value matches current behaviour.)

- [ ] **Step 6: Modify `daemon/internal-api/routes.ts`**

Find `maybePrefix` (in `routes.ts` or `index.ts` per actual layout). Replace mode-kind switch with capability lookup:
```ts
import { lookup, type PermissionMode } from '../../core/capability-matrix'

// Inside maybePrefix:
const cap = lookup(mode.kind, providerId, permissionMode)
if (cap.replyPrefix === 'always') return `[${displayName}] ${text}`
if (cap.replyPrefix === 'on-fallback-only') return text  // primary_tool main path: no prefix
return text  // 'never'
```

Add `permissionMode` to `InternalApiPrefixDeps` (in `internal-api/types.ts`).

- [ ] **Step 7: Update internal-api test**

In `src/daemon/internal-api.test.ts`, add ~1 test:
```ts
it('reply route prefix decision goes through capability lookup', async () => {
  // Arrange: parallel mode chat, claude provider
  // Act: POST /v1/wechat/reply
  // Assert: outgoing text starts with "[Claude]"
})
```

(If existing tests already cover this via mode-kind switch, just verify they still pass after refactor.)

- [ ] **Step 8: Run impacted tests**

Run:
```
bun --bun vitest run src/core/conversation-coordinator.test.ts src/core/permission-relay.test.ts src/daemon/internal-api.test.ts src/daemon/bootstrap.test.ts
```
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add src/core/conversation-coordinator.ts src/core/conversation-coordinator.test.ts \
        src/core/codex-agent-provider.ts src/daemon/bootstrap/index.ts \
        src/daemon/internal-api/routes.ts src/daemon/internal-api/types.ts \
        src/daemon/internal-api.test.ts
git commit -m "feat(core,daemon): wire capability-matrix into coordinator + codex + routes"
```

---

## Task 22: main.ts cutover

**Files:**
- Modify (rewrite): `src/daemon/main.ts`

This is the biggest single diff in the PR. The new file is ~80 LOC; the old is 627 LOC. Rewrite atomically.

- [ ] **Step 1: Save current main.ts as a sanity reference (transient)**

```bash
cp src/daemon/main.ts /tmp/main.ts.before
```

(Used only for scrap reference if anything is missing; deleted at task end. No `// removed` comments in the new file per CLAUDE convention.)

- [ ] **Step 2: Replace `src/daemon/main.ts` entirely**

Write the spec §6 `main.ts` verbatim. Key sections:

```ts
#!/usr/bin/env bun
if (!process.env.CLAUDE_CODE_ENTRYPOINT) {
  process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts'
}

import { join } from 'node:path'
import { homedir } from 'node:os'
import { acquireInstanceLock, releaseInstanceLock } from './single-instance'
import { openDb } from '../lib/db'
import { LifecycleSet } from '../lib/lifecycle'
import { log } from '../lib/log'
import { buildBootstrap } from './bootstrap'
import { loadAllAccounts, makeIlinkAdapter } from './ilink-glue'
import { registerInternalApi } from './internal-api/lifecycle'
import { registerCompanionPush, registerCompanionIntrospect } from './companion/lifecycle'
import { registerGuard } from './guard/lifecycle'
import { registerPolling } from './polling-lifecycle'
import { registerSessions } from './sessions-lifecycle'
import { registerIlink } from './ilink-lifecycle'
import { buildInboundPipeline } from './inbound/build'
import { runStartupSweeps } from './startup-sweeps'
import { wireMain } from './main-wiring'

const STATE_DIR = join(homedir(), '.claude', 'channels', 'wechat')
const PID_PATH = join(STATE_DIR, 'server.pid')
const DANGEROUSLY = process.argv.includes('--dangerously')

let shuttingDown = false

async function main() {
  const lock = acquireInstanceLock(PID_PATH)
  if (!lock.ok) {
    console.error(`[wechat-cc] ${lock.reason} (pid=${lock.pid}). Exiting.`)
    process.exit(1)
  }

  const accounts = await loadAllAccounts(STATE_DIR)
  if (accounts.length === 0) {
    console.error('[wechat-cc] no accounts bound. Run `wechat-cc setup` first.')
    releaseInstanceLock(PID_PATH); process.exit(1)
  }

  const db = openDb({ path: join(STATE_DIR, 'wechat-cc.db') })
  const ilink = makeIlinkAdapter({ stateDir: STATE_DIR, accounts, db })
  const lc = new LifecycleSet((tag, line) => log(tag, line))

  try {
    const internalApi = await registerInternalApi({ stateDir: STATE_DIR, ilink, db, log: (t, l) => log(t, l) /* ... full deps per createInternalApi signature; replicate from old main.ts §86-124 */ })
    lc.register(internalApi)

    const boot = buildBootstrap({
      stateDir: STATE_DIR, db, ilink,
      loadProjects: ilink.loadProjects, lastActiveChatId: ilink.lastActiveChatId,
      log: (t, l) => log(t, l),
      fallbackProject: () => ({ alias: '_default', path: process.cwd() }),
      dangerouslySkipPermissions: DANGEROUSLY,
      internalApi: { baseUrl: internalApi.baseUrl, tokenFilePath: internalApi.tokenFilePath },
    })
    internalApi.setDelegate({
      dispatchOneShot: boot.dispatchDelegate,
      knownPeers: () => boot.registry.list(),
    })

    const wired = wireMain({ stateDir: STATE_DIR, db, ilink, boot, dangerously: DANGEROUSLY, log: (t, l) => log(t, l) })
    const pipeline = buildInboundPipeline(wired.pipelineDeps)

    lc.register(registerCompanionPush(wired.companionPushDeps))
    lc.register(registerCompanionIntrospect(wired.companionIntrospectDeps))

    const guardLc = registerGuard(wired.guardDeps)
    wired.refs.guard.current = guardLc
    lc.register(guardLc)

    lc.register(registerSessions(wired.sessionsDeps))
    lc.register(registerIlink(wired.ilinkDeps))

    const pollingLc = registerPolling({ ...wired.pollingDeps, runPipeline: pipeline })
    wired.refs.polling.current = pollingLc
    lc.register(pollingLc)

    runStartupSweeps(wired.startupDeps)

    const shutdown = async (sig: string) => {
      if (shuttingDown) {
        log('DAEMON', `${sig} during shutdown — forcing exit`)
        process.exit(130)
      }
      shuttingDown = true
      log('DAEMON', `${sig} received, shutting down`)
      try { await lc.stopAll() } catch { /* logged by lc */ }
      try { db.close() } catch (err) { console.error('db close failed:', err) }
      releaseInstanceLock(PID_PATH)
      process.exit(0)
    }
    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGUSR1', () => pollingLc.reconcile().catch(err =>
      log('RECONCILE', `SIGUSR1 reconcile failed: ${err instanceof Error ? err.message : String(err)}`),
    ))

    log('DAEMON', `started pid=${process.pid} accounts=${accounts.length} mode=${
      DANGEROUSLY ? 'dangerouslySkipPermissions' : 'strict'
    }`)
    if (DANGEROUSLY) {
      log('DAEMON', 'warning: Claude will still confirm destructive ops via natural-language reply, but no permission prompts will appear.')
    }
  } catch (err) {
    log('DAEMON', `startup failed mid-init: ${err instanceof Error ? err.message : String(err)}`)
    try { await lc.stopAll() } catch {}
    db.close()
    releaseInstanceLock(PID_PATH)
    throw err
  }
}

main().catch((err) => {
  console.error('[wechat-cc] fatal:', err)
  process.exit(1)
})
```

⚠ When writing the `registerInternalApi(...)` call, replicate ALL the deps that current `createInternalApi(...)` receives in old main.ts §86-124. That dep struct must be complete or routes fail at runtime (404 / 500).

- [ ] **Step 3: Verify line count cap**

Run: `wc -l src/daemon/main.ts`
Expected: ≤ 100 lines.

- [ ] **Step 4: Remove transient backup**

```bash
rm /tmp/main.ts.before
```

- [ ] **Step 5: Typecheck**

Run: `bun x tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Run full test suite**

Run: `bun --bun vitest run`
Expected: all green (~700 existing + ~100 new ≈ 800).

- [ ] **Step 7: Smoke-test daemon start (if dev environment available)**

Run (manual):
```
bun src/daemon/main.ts
```
Expected: prints `[BOOT] internal-api listening on 127.0.0.1:<port>`, then `[DAEMON] started pid=...`. Ctrl-C → prints `[LIFECYCLE] stopped polling (...ms)` followed by other subsystems in LIFO order.

If no accounts bound, the daemon exits early with the existing message — that's fine.

- [ ] **Step 8: Commit**

```bash
git add src/daemon/main.ts
git commit -m "refactor(daemon): cut main.ts (627 → ~80 LOC) — wire pipeline + lifecycles"
```

---

## Task 23: depcruise rules + final verification

**Files:**
- Modify: `.dependency-cruiser.cjs`

- [ ] **Step 1: Add the two new rules to `.dependency-cruiser.cjs` `forbidden` array**

```js
{
  name: 'inbound-must-not-link-main',
  severity: 'error',
  comment: 'inbound mw 通过工厂注入 deps，不能 import main.ts',
  from: { path: '^src/daemon/inbound/', pathNot: '\\.test\\.ts$' },
  to: { path: '^src/daemon/main\\.ts$' },
},
{
  name: 'inbound-must-not-link-other-lifecycle',
  severity: 'error',
  comment: 'inbound mw 不能 import 其他子系统的 lifecycle 文件',
  from: { path: '^src/daemon/inbound/', pathNot: '\\.test\\.ts$' },
  to: { path: '(lifecycle\\.ts$|-lifecycle\\.ts$)' },
},
```

Add immediately before the `no-orphans` rule.

- [ ] **Step 2: Run depcheck**

Run: `bun run depcheck`
Expected: no violations. If violations are reported, the inbound mw is mis-importing something — fix at the import site.

- [ ] **Step 3: Run full verification trio**

Run all three:
```bash
bun --bun vitest run
bun x tsc --noEmit
bun run depcheck
```
Expected: all green.

- [ ] **Step 4: Commit depcruise update**

```bash
git add .dependency-cruiser.cjs
git commit -m "chore(depcheck): enforce inbound/* boundary against main.ts + sibling lifecycles"
```

- [ ] **Step 5: Final acceptance check (per RFC 04 §7)**

Verify each acceptance criterion:
- [ ] `bun --bun vitest run` 全绿
- [ ] `bun x tsc --noEmit` 无错
- [ ] `bun run depcheck` 无新违例
- [ ] `apps/desktop/shim.e2e.test.ts` 通过（run it: `bun --bun vitest run apps/desktop/shim.e2e.test.ts`）
- [ ] `wc -l src/daemon/main.ts` ≤ 100
- [ ] Manual smoke: 1 普通消息 / 1 admin / 1 `/cc` 切换 — 行为与 v0.4.5 一致

If all pass: PR ready.

---

## Self-review notes (for the implementing engineer)

- **Behaviour equivalence** is the hard contract. If a test that existed before this PR fails, do NOT change the test — find the behaviour gap in your refactor.
- **No `// removed` / `// TODO` comments**. Either implement or omit.
- **Per-chat dynamic permission lookup** is a known follow-up — Task 21 wires static defaults that match current behaviour. The matrix supports per-chat lookup; just not threaded through canUseTool yet.
- **wireMain() is large** (~150 LOC) but contains zero new logic. Resist the urge to refactor it during this PR.
- The whole PR should be ONE merged commit chain — no rebase / squash mid-task. Commits stay separate so reviewers can step through.
