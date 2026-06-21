# 乙 v2 Phase 1 — WebSocket Task Channel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the brain→hand blocking HTTP `POST /a2a/exec` with a persistent **WebSocket + JSON-RPC 2.0** channel where the **hand connects outbound to the brain**, so delegation survives long agent runs and (later phases) works through NAT — while keeping v1 push mode fully working.

**Architecture:** Inverts the v1 client/server roles. v1: brain is an HTTP client, hand runs the inbound A2A server. v2: the **brain runs a ws hub** (accepts hand connections, tracks `handId → connection`, dispatches tasks and awaits the JSON-RPC response); the **hand runs a ws client** that connects out, handshakes, and runs its local agent (the existing `onExec`/`dispatchDelegate`) on each dispatched task. Three transport-agnostic core modules (protocol, hub, hand) get full TDD; thin Bun-ws I/O glue gets in-process integration tests. Routing is per-hand: `transport: 'push'` keeps the v1 HTTP path, `transport: 'ws'` uses the hub.

**Tech Stack:** Bun (`Bun.serve` with a `websocket` handler on the brain; the global `WebSocket` client on the hand), TypeScript, Zod (agent-config schema), Vitest via `bun --bun vitest run`.

---

## File Structure

**New (core, transport-agnostic — the testable heart):**
- `src/core/yi-protocol.ts` — JSON-RPC 2.0 message builders + parser for the 乙 channel (`initialize`, `initialized`, `task/dispatch` request + its response). Pure functions.
- `src/core/yi-hub.ts` — BRAIN side. Tracks connected hands (`handId → send fn`), `dispatchTask(handId, task, timeoutMs)` sends a `task/dispatch` request and resolves on the correlated response. Transport-agnostic (takes a `send` callback).
- `src/core/yi-hand.ts` — HAND side. Drives the handshake and, on `task/dispatch`, calls an injected `onExec` and replies. Transport-agnostic.

**New (I/O glue — thin, integration-tested):**
- `src/daemon/yi-ws-server.ts` — wraps `Bun.serve` ws → feeds `yi-hub`.
- `src/daemon/yi-ws-client.ts` — wraps `WebSocket` (outbound + reconnect) → drives `yi-hand`.

**Modified:**
- `src/lib/agent-config.ts` — add optional `transport: 'push' | 'ws'` to the `A2AAgentRecord` schema; add `yi_hub_listen` (brain) + `yi_brain` (hand) config blocks.
- `src/daemon/bootstrap/index.ts` — start the ws hub+server when `yi_hub_listen` is set; start the ws client when `yi_brain` is set; expose the hub for dispatch.
- `src/daemon/wiring/pipeline-deps.ts` — `delegateToHand` routes by `hand.transport` (ws → hub, push → existing HTTP).

**Reused unchanged:** `src/core/a2a-delegate.ts` (push path stays), `src/core/a2a-client.ts`, `src/core/a2a-registry.ts` API, `src/daemon/admin-commands.ts` (`让X执行` calls the same `delegateToHand` dep).

---

## Conventions for the implementer

- Run a single test file: `bun --bun vitest run path/to/file.test.ts`
- Run the whole suite: `bun --bun vitest run`
- Typecheck: `bunx tsc --noEmit` (must stay at **0** errors)
- Module-boundary check: `bun run depcheck` (must stay clean — note `src/core` must not import `src/daemon`)
- Commit message trailer (every commit):
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- `ExecResult` already exists in `src/core/a2a-server.ts`: `type ExecResult = { ok: true; response: string } | { ok: false; reason: string }`. Reuse it — import the type; do not redefine.

---

## Task 1: JSON-RPC protocol module

**Files:**
- Create: `src/core/yi-protocol.ts`
- Test: `src/core/yi-protocol.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/core/yi-protocol.test.ts
import { describe, expect, it } from 'vitest'
import { buildRequest, buildResponse, buildError, buildNotification, parseMessage } from './yi-protocol'

describe('yi-protocol', () => {
  it('builds + parses a request', () => {
    const raw = buildRequest(7, 'task/dispatch', { taskId: 't1', peer: 'claude', prompt: 'hi' })
    const msg = parseMessage(raw)
    expect(msg).toEqual({ kind: 'request', id: 7, method: 'task/dispatch', params: { taskId: 't1', peer: 'claude', prompt: 'hi' } })
  })

  it('builds + parses a response', () => {
    const msg = parseMessage(buildResponse(7, { taskId: 't1', ok: true, response: 'done' }))
    expect(msg).toEqual({ kind: 'response', id: 7, result: { taskId: 't1', ok: true, response: 'done' } })
  })

  it('builds + parses an error', () => {
    const msg = parseMessage(buildError(7, -32603, 'boom'))
    expect(msg).toEqual({ kind: 'error', id: 7, error: { code: -32603, message: 'boom' } })
  })

  it('builds + parses a notification (no id)', () => {
    const msg = parseMessage(buildNotification('initialized'))
    expect(msg).toEqual({ kind: 'notification', method: 'initialized', params: undefined })
  })

  it('returns a malformed marker for non-JSON / non-2.0', () => {
    expect(parseMessage('not json').kind).toBe('malformed')
    expect(parseMessage(JSON.stringify({ id: 1 })).kind).toBe('malformed')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/core/yi-protocol.test.ts`
Expected: FAIL — `buildRequest` (etc.) not exported / module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/yi-protocol.ts
/**
 * 乙 v2 wire messages — JSON-RPC 2.0 over a WebSocket text frame (one message
 * per frame). Phase 1 methods:
 *   - request  `initialize`     params { handId, clientName, capabilities, authToken }
 *   - response (to initialize)  result { sessionId }
 *   - notification `initialized` (no params)
 *   - request  `task/dispatch`  params { taskId, peer, prompt, cwd? }
 *   - response (to task/dispatch) result { taskId, ok, response? , reason? }
 * Pure: build + parse only. No I/O.
 */
export type YiParsed =
  | { kind: 'request'; id: number; method: string; params: unknown }
  | { kind: 'response'; id: number; result: unknown }
  | { kind: 'error'; id: number | null; error: { code: number; message: string } }
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'malformed' }

export function buildRequest(id: number, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params })
}
export function buildResponse(id: number, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}
export function buildError(id: number | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
}
export function buildNotification(method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
}

export function parseMessage(raw: string | Buffer): YiParsed {
  let m: Record<string, unknown>
  try { m = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')) as Record<string, unknown> }
  catch { return { kind: 'malformed' } }
  if (!m || m.jsonrpc !== '2.0') return { kind: 'malformed' }
  if ('error' in m && m.error && typeof m.error === 'object') {
    const e = m.error as { code?: unknown; message?: unknown }
    return { kind: 'error', id: typeof m.id === 'number' ? m.id : null, error: { code: Number(e.code ?? -1), message: String(e.message ?? '') } }
  }
  if ('result' in m && typeof m.id === 'number') return { kind: 'response', id: m.id, result: m.result }
  if (typeof m.method === 'string' && typeof m.id === 'number') return { kind: 'request', id: m.id, method: m.method, params: m.params }
  if (typeof m.method === 'string') return { kind: 'notification', method: m.method, params: m.params }
  return { kind: 'malformed' }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --bun vitest run src/core/yi-protocol.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/yi-protocol.ts src/core/yi-protocol.test.ts
git commit -m "feat(yi): v2 wire protocol — JSON-RPC 2.0 build/parse

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Brain-side hub (dispatch + response correlation)

**Files:**
- Create: `src/core/yi-hub.ts`
- Test: `src/core/yi-hub.test.ts`

The hub is transport-agnostic: a hand "connects" by calling `attach(handId, send)`, where `send(raw)` writes a frame to that hand's socket. `dispatchTask` sends a `task/dispatch` request and returns a promise resolved by the matching response (correlated by JSON-RPC `id`), with a timeout. Inbound frames from a hand are fed back via `onMessage(handId, raw)`.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/yi-hub.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createYiHub } from './yi-hub'
import { parseMessage, buildResponse } from './yi-protocol'

describe('yi-hub', () => {
  it('dispatchTask sends task/dispatch and resolves on the correlated response', async () => {
    const hub = createYiHub()
    const sent: string[] = []
    hub.attach('home', (raw) => { sent.push(raw) })

    const p = hub.dispatchTask('home', { peer: 'claude', prompt: 'read README' }, 5000)
    // The hub sent a task/dispatch request; reply with the matching id.
    const req = parseMessage(sent[0]!)
    expect(req.kind).toBe('request')
    if (req.kind !== 'request') throw new Error('expected request')
    expect(req.method).toBe('task/dispatch')
    const taskId = (req.params as { taskId: string }).taskId
    hub.onMessage('home', buildResponse(req.id, { taskId, ok: true, response: 'the readme' }))

    await expect(p).resolves.toEqual({ ok: true, response: 'the readme' })
  })

  it('returns ok:false when the hand is not connected', async () => {
    const hub = createYiHub()
    await expect(hub.dispatchTask('ghost', { peer: 'claude', prompt: 'x' }, 1000))
      .resolves.toEqual({ ok: false, reason: 'hand_offline' })
  })

  it('times out a task with no response', async () => {
    vi.useFakeTimers()
    const hub = createYiHub()
    hub.attach('home', () => {})
    const p = hub.dispatchTask('home', { peer: 'claude', prompt: 'x' }, 1000)
    vi.advanceTimersByTime(1001)
    await expect(p).resolves.toEqual({ ok: false, reason: 'timeout' })
    vi.useRealTimers()
  })

  it('detach drops the hand (subsequent dispatch is offline)', async () => {
    const hub = createYiHub()
    hub.attach('home', () => {})
    hub.detach('home')
    await expect(hub.dispatchTask('home', { peer: 'claude', prompt: 'x' }, 1000))
      .resolves.toEqual({ ok: false, reason: 'hand_offline' })
  })

  it('isConnected reflects attach/detach', () => {
    const hub = createYiHub()
    expect(hub.isConnected('home')).toBe(false)
    hub.attach('home', () => {})
    expect(hub.isConnected('home')).toBe(true)
    hub.detach('home')
    expect(hub.isConnected('home')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/core/yi-hub.test.ts`
Expected: FAIL — `createYiHub` missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/yi-hub.ts
/**
 * 乙 v2 BRAIN hub — tracks connected hands and dispatches tasks to them over
 * the persistent channel, correlating each task/dispatch request with its
 * JSON-RPC response by id. Transport-agnostic: a hand is "attached" with a
 * send(raw) callback; the I/O layer feeds inbound frames via onMessage().
 */
import { buildRequest, parseMessage } from './yi-protocol'
import type { ExecResult } from './a2a-server'

export interface YiDispatch { peer: 'claude' | 'codex'; prompt: string; cwd?: string }

interface Pending { resolve: (r: ExecResult) => void; timer: ReturnType<typeof setTimeout> }

export interface YiHub {
  attach(handId: string, send: (raw: string) => void): void
  detach(handId: string): void
  isConnected(handId: string): boolean
  onMessage(handId: string, raw: string): void
  dispatchTask(handId: string, task: YiDispatch, timeoutMs: number): Promise<ExecResult>
}

export function createYiHub(): YiHub {
  const conns = new Map<string, (raw: string) => void>()
  const pending = new Map<number, Pending>()   // jsonrpc id → waiter
  let nextId = 1
  let nextTask = 1

  function settle(id: number, r: ExecResult): void {
    const p = pending.get(id)
    if (!p) return
    clearTimeout(p.timer)
    pending.delete(id)
    p.resolve(r)
  }

  return {
    attach(handId, send) { conns.set(handId, send) },
    detach(handId) { conns.delete(handId) },
    isConnected(handId) { return conns.has(handId) },
    onMessage(_handId, raw) {
      const msg = parseMessage(raw)
      if (msg.kind === 'response') {
        const res = msg.result as { ok?: boolean; response?: unknown; reason?: unknown }
        settle(msg.id, res && res.ok
          ? { ok: true, response: String(res.response ?? '') }
          : { ok: false, reason: String(res?.reason ?? 'unknown') })
      } else if (msg.kind === 'error') {
        if (typeof msg.id === 'number') settle(msg.id, { ok: false, reason: msg.error.message })
      }
      // requests/notifications from the hand are ignored in Phase 1
    },
    dispatchTask(handId, task, timeoutMs) {
      const send = conns.get(handId)
      if (!send) return Promise.resolve<ExecResult>({ ok: false, reason: 'hand_offline' })
      const id = nextId++
      const taskId = `t${nextTask++}`
      return new Promise<ExecResult>((resolve) => {
        const timer = setTimeout(() => settle(id, { ok: false, reason: 'timeout' }), timeoutMs)
        pending.set(id, { resolve, timer })
        try {
          send(buildRequest(id, 'task/dispatch', { taskId, peer: task.peer, prompt: task.prompt, ...(task.cwd ? { cwd: task.cwd } : {}) }))
        } catch (err) {
          settle(id, { ok: false, reason: err instanceof Error ? err.message : String(err) })
        }
      })
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --bun vitest run src/core/yi-hub.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/yi-hub.ts src/core/yi-hub.test.ts
git commit -m "feat(yi): v2 brain hub — dispatch + response correlation + timeout

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Hand-side handler (handshake + run + reply)

**Files:**
- Create: `src/core/yi-hand.ts`
- Test: `src/core/yi-hand.test.ts`

Transport-agnostic: `createYiHand({ handId, authToken, capabilities, onExec })` returns an object with `helloFrame()` (the `initialize` request to send on connect) and `onMessage(raw): Promise<string[]>` returning frames to send back. On a `task/dispatch` request it calls `onExec` and returns the JSON-RPC response.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/yi-hand.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createYiHand } from './yi-hand'
import { parseMessage, buildResponse, buildRequest } from './yi-protocol'

const base = { handId: 'home', authToken: 'k'.repeat(16), capabilities: ['exec'] }

describe('yi-hand', () => {
  it('helloFrame is an initialize request carrying handId + authToken', () => {
    const hand = createYiHand({ ...base, onExec: async () => ({ ok: true, response: 'x' }) })
    const msg = parseMessage(hand.helloFrame())
    expect(msg.kind).toBe('request')
    if (msg.kind !== 'request') throw new Error('expected request')
    expect(msg.method).toBe('initialize')
    expect(msg.params).toMatchObject({ handId: 'home', authToken: 'k'.repeat(16), capabilities: ['exec'] })
  })

  it('on task/dispatch, runs onExec and replies with the result (same id)', async () => {
    const onExec = vi.fn().mockResolvedValue({ ok: true, response: 'README body' })
    const hand = createYiHand({ ...base, onExec })
    // simulate the brain accepting the initialize first (a response, ignored)
    await hand.onMessage(buildResponse(1, { sessionId: 's1' }))
    const out = await hand.onMessage(buildRequest(42, 'task/dispatch', { taskId: 't1', peer: 'claude', prompt: 'read README', cwd: '/tmp' }))
    expect(onExec).toHaveBeenCalledWith({ peer: 'claude', prompt: 'read README', cwd: '/tmp' })
    expect(out).toHaveLength(1)
    const resp = parseMessage(out[0]!)
    expect(resp).toEqual({ kind: 'response', id: 42, result: { taskId: 't1', ok: true, response: 'README body' } })
  })

  it('replies ok:false when onExec returns a failure', async () => {
    const hand = createYiHand({ ...base, onExec: async () => ({ ok: false, reason: 'no agent' }) })
    const out = await hand.onMessage(buildRequest(9, 'task/dispatch', { taskId: 't2', peer: 'claude', prompt: 'x' }))
    expect(parseMessage(out[0]!)).toEqual({ kind: 'response', id: 9, result: { taskId: 't2', ok: false, reason: 'no agent' } })
  })

  it('ignores non-dispatch messages (returns no frames)', async () => {
    const hand = createYiHand({ ...base, onExec: async () => ({ ok: true, response: 'x' }) })
    expect(await hand.onMessage(buildResponse(1, { sessionId: 's1' }))).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/core/yi-hand.test.ts`
Expected: FAIL — `createYiHand` missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/yi-hand.ts
/**
 * 乙 v2 HAND handler — connects out to the brain, sends `initialize`, then runs
 * the local agent (onExec) on each `task/dispatch` and replies with its result.
 * Transport-agnostic: helloFrame() is what the I/O layer sends on ws-open;
 * onMessage(raw) returns the frames to send back.
 */
import { buildRequest, buildResponse, parseMessage } from './yi-protocol'
import type { ExecResult } from './a2a-server'
import type { YiDispatch } from './yi-hub'

export interface YiHandDeps {
  handId: string
  authToken: string
  capabilities: string[]
  onExec: (task: YiDispatch) => Promise<ExecResult>
}

export interface YiHand {
  helloFrame(): string
  onMessage(raw: string): Promise<string[]>
}

export function createYiHand(deps: YiHandDeps): YiHand {
  return {
    helloFrame() {
      return buildRequest(1, 'initialize', {
        handId: deps.handId, clientName: 'wechat-cc', capabilities: deps.capabilities, authToken: deps.authToken,
      })
    },
    async onMessage(raw) {
      const msg = parseMessage(raw)
      if (msg.kind !== 'request' || msg.method !== 'task/dispatch') return []
      const p = msg.params as { taskId: string; peer: 'claude' | 'codex'; prompt: string; cwd?: string }
      let result: ExecResult
      try {
        result = await deps.onExec({ peer: p.peer, prompt: p.prompt, ...(p.cwd ? { cwd: p.cwd } : {}) })
      } catch (err) {
        result = { ok: false, reason: err instanceof Error ? err.message : String(err) }
      }
      return [buildResponse(msg.id, { taskId: p.taskId, ...result })]
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --bun vitest run src/core/yi-hand.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/yi-hand.ts src/core/yi-hand.test.ts
git commit -m "feat(yi): v2 hand handler — handshake + run onExec + reply

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Brain ws server glue (Bun.serve websocket → hub)

**Files:**
- Create: `src/daemon/yi-ws-server.ts`
- Test: `src/daemon/yi-ws-server.test.ts`

Verifies the `initialize` handshake authenticates the hand (via an injected `verify(handId, token)`), attaches it to the hub, and that the hub can dispatch over the live ws. Uses a **real local ws** (a Bun `WebSocket` client in the test) against the started server.

- [ ] **Step 1: Write the failing test**

```ts
// src/daemon/yi-ws-server.test.ts
import { afterEach, describe, expect, it } from 'vitest'
import { createYiHub } from '../core/yi-hub'
import { createYiWsServer } from './yi-ws-server'
import { buildResponse, parseMessage } from '../core/yi-protocol'

let stop: (() => void) | null = null
afterEach(() => { stop?.(); stop = null })

describe('yi-ws-server', () => {
  it('authenticates initialize, attaches to hub, dispatches over the live socket', async () => {
    const hub = createYiHub()
    const server = createYiWsServer({ host: '127.0.0.1', port: 0, hub, verify: (id, tok) => id === 'home' && tok === 'k'.repeat(16) })
    await server.start(); stop = () => void server.stop()

    // A hand connects out, sends initialize, then answers task/dispatch.
    const ws = new WebSocket(`ws://127.0.0.1:${server.port()}`)
    await new Promise<void>((r) => { ws.onopen = () => r() })
    ws.onmessage = (ev) => {
      const m = parseMessage(String(ev.data))
      if (m.kind === 'request' && m.method === 'task/dispatch') {
        const taskId = (m.params as { taskId: string }).taskId
        ws.send(buildResponse(m.id, { taskId, ok: true, response: 'pong' }))
      }
    }
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { handId: 'home', clientName: 'x', capabilities: ['exec'], authToken: 'k'.repeat(16) } }))

    // wait until the hub sees the hand attached
    await new Promise<void>((r) => { const t = setInterval(() => { if (hub.isConnected('home')) { clearInterval(t); r() } }, 5) })
    await expect(hub.dispatchTask('home', { peer: 'claude', prompt: 'ping' }, 3000)).resolves.toEqual({ ok: true, response: 'pong' })
    ws.close()
  })

  it('rejects a bad authToken (does not attach)', async () => {
    const hub = createYiHub()
    const server = createYiWsServer({ host: '127.0.0.1', port: 0, hub, verify: () => false })
    await server.start(); stop = () => void server.stop()
    const ws = new WebSocket(`ws://127.0.0.1:${server.port()}`)
    await new Promise<void>((r) => { ws.onopen = () => r() })
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { handId: 'home', clientName: 'x', capabilities: [], authToken: 'wrong' } }))
    await new Promise((r) => setTimeout(r, 50))
    expect(hub.isConnected('home')).toBe(false)
    ws.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/daemon/yi-ws-server.test.ts`
Expected: FAIL — `createYiWsServer` missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/daemon/yi-ws-server.ts
/**
 * 乙 v2 BRAIN ws I/O — accepts outbound hand connections, runs the initialize
 * handshake (authenticated by verify(handId, token)), attaches each hand to the
 * hub, and bridges inbound frames → hub.onMessage. Bind 127.0.0.1 / tailnet
 * only — this is the brain's rendezvous (later: behind a cloudflared tunnel).
 */
import type { YiHub } from '../core/yi-hub'
import { buildError, buildResponse, parseMessage } from '../core/yi-protocol'

export interface YiWsServerOpts {
  host: string
  port: number
  hub: YiHub
  verify: (handId: string, authToken: string) => boolean
}

interface SockData { handId: string | null }

export interface YiWsServer {
  start(): Promise<void>
  stop(): Promise<void>
  port(): number
}

export function createYiWsServer(opts: YiWsServerOpts): YiWsServer {
  let server: ReturnType<typeof Bun.serve> | null = null

  return {
    async start() {
      if (server) return
      server = Bun.serve<SockData, undefined>({
        hostname: opts.host,
        port: opts.port,
        fetch(req, srv) {
          if (srv.upgrade(req, { data: { handId: null } })) return undefined
          return new Response('expected websocket', { status: 426 })
        },
        websocket: {
          message(ws, raw) {
            const msg = parseMessage(typeof raw === 'string' ? raw : Buffer.from(raw))
            // Pre-handshake: the only accepted frame is initialize.
            if (ws.data.handId === null) {
              if (msg.kind === 'request' && msg.method === 'initialize') {
                const p = msg.params as { handId?: unknown; authToken?: unknown }
                if (typeof p.handId === 'string' && typeof p.authToken === 'string' && opts.verify(p.handId, p.authToken)) {
                  ws.data.handId = p.handId
                  opts.hub.attach(p.handId, (out) => { try { ws.send(out) } catch { /* closed */ } })
                  ws.send(buildResponse(msg.id, { sessionId: `s_${p.handId}` }))
                } else {
                  ws.send(buildError(msg.kind === 'request' ? msg.id : null, -32600, 'unauthorized'))
                  ws.close()
                }
              } else {
                ws.send(buildError(null, -32600, 'expected initialize'))
                ws.close()
              }
              return
            }
            // Post-handshake: forward to the hub (responses to dispatched tasks).
            opts.hub.onMessage(ws.data.handId, typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'))
          },
          close(ws) {
            if (ws.data.handId) opts.hub.detach(ws.data.handId)
          },
        },
      })
    },
    async stop() { server?.stop(); server = null },
    port() { if (!server) throw new Error('yi-ws-server not started'); return server.port! },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --bun vitest run src/daemon/yi-ws-server.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/yi-ws-server.ts src/daemon/yi-ws-server.test.ts
git commit -m "feat(yi): v2 brain ws server — authed handshake + hub bridge

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Hand ws client glue (outbound WebSocket + reconnect → yi-hand)

**Files:**
- Create: `src/daemon/yi-ws-client.ts`
- Test: `src/daemon/yi-ws-client.test.ts`

Connects outbound to the brain's ws server, sends `helloFrame()` on open, pipes each inbound frame through `yi-hand.onMessage` and writes the returned frames back. Reconnects with capped backoff on close. The test stands up a real `createYiWsServer` + `createYiHub` (Task 4) and drives an end-to-end dispatch through the client.

- [ ] **Step 1: Write the failing test**

```ts
// src/daemon/yi-ws-client.test.ts
import { afterEach, describe, expect, it } from 'vitest'
import { createYiHub } from '../core/yi-hub'
import { createYiWsServer } from './yi-ws-server'
import { createYiWsClient } from './yi-ws-client'

let cleanup: Array<() => void> = []
afterEach(() => { cleanup.forEach((f) => f()); cleanup = [] })

describe('yi-ws-client', () => {
  it('connects out, handshakes, and serves a dispatched task end-to-end', async () => {
    const hub = createYiHub()
    const server = createYiWsServer({ host: '127.0.0.1', port: 0, hub, verify: (id, t) => id === 'home' && t === 'k'.repeat(16) })
    await server.start(); cleanup.push(() => void server.stop())

    const client = createYiWsClient({
      brainUrl: `ws://127.0.0.1:${server.port()}`,
      handId: 'home', authToken: 'k'.repeat(16), capabilities: ['exec'],
      onExec: async (task) => ({ ok: true, response: `ran:${task.prompt}` }),
    })
    client.start(); cleanup.push(() => client.stop())

    await new Promise<void>((r) => { const t = setInterval(() => { if (hub.isConnected('home')) { clearInterval(t); r() } }, 5) })
    await expect(hub.dispatchTask('home', { peer: 'claude', prompt: 'hello' }, 3000)).resolves.toEqual({ ok: true, response: 'ran:hello' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/daemon/yi-ws-client.test.ts`
Expected: FAIL — `createYiWsClient` missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/daemon/yi-ws-client.ts
/**
 * 乙 v2 HAND ws I/O — connects OUTBOUND to the brain's rendezvous, sends the
 * initialize frame on open, runs each task via yi-hand, and reconnects with
 * capped backoff. Outbound-only: works behind NAT, no inbound port.
 */
import { createYiHand, type YiHandDeps } from '../core/yi-hand'

export interface YiWsClientOpts extends YiHandDeps {
  brainUrl: string
  log?: (msg: string) => void
}

export interface YiWsClient {
  start(): void
  stop(): void
}

export function createYiWsClient(opts: YiWsClientOpts): YiWsClient {
  const hand = createYiHand(opts)
  let ws: WebSocket | null = null
  let stopped = false
  let backoff = 1000

  function connect(): void {
    if (stopped) return
    ws = new WebSocket(opts.brainUrl)
    ws.onopen = () => { backoff = 1000; ws!.send(hand.helloFrame()) }
    ws.onmessage = async (ev) => {
      const out = await hand.onMessage(String(ev.data))
      for (const frame of out) { try { ws?.send(frame) } catch { /* closed */ } }
    }
    ws.onclose = () => {
      ws = null
      if (stopped) return
      opts.log?.(`yi: disconnected from ${opts.brainUrl}, retry in ${backoff}ms`)
      setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, 30_000)
    }
    ws.onerror = () => { try { ws?.close() } catch { /* noop */ } }
  }

  return {
    start() { stopped = false; connect() },
    stop() { stopped = true; try { ws?.close() } catch { /* noop */ } ws = null },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --bun vitest run src/daemon/yi-ws-client.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/yi-ws-client.ts src/daemon/yi-ws-client.test.ts
git commit -m "feat(yi): v2 hand ws client — outbound connect + reconnect + serve

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Config schema — `transport` field + brain/hand blocks

**Files:**
- Modify: `src/lib/agent-config.ts:47-62` (the `A2AAgentRecord` schema) + the top-level `AgentConfig` schema
- Test: `src/lib/agent-config.test.ts`

- [ ] **Step 1: Write the failing test** (append to `src/lib/agent-config.test.ts`)

```ts
import { A2AAgentRecord } from './agent-config'

describe('A2AAgentRecord.transport', () => {
  it('defaults transport to "push" when absent', () => {
    const rec = A2AAgentRecord.parse({
      id: 'home', name: 'home', url: 'http://h/a2a',
      inbound_api_key: 'k'.repeat(16), outbound_api_key: 'o', capabilities: ['exec'],
    })
    expect(rec.transport).toBe('push')
  })
  it('accepts transport "ws"', () => {
    const rec = A2AAgentRecord.parse({
      id: 'home', name: 'home', url: 'http://h/a2a',
      inbound_api_key: 'k'.repeat(16), outbound_api_key: 'o', capabilities: ['exec'], transport: 'ws',
    })
    expect(rec.transport).toBe('ws')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/lib/agent-config.test.ts`
Expected: FAIL — `transport` is `undefined` / unknown key stripped.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/agent-config.ts`, add to the `A2AAgentRecord = z.object({ ... })` (after `paused`):

```ts
  transport: z.enum(['push', 'ws']).default('push'),
```

In the same file, add to the top-level `AgentConfig` schema (alongside `a2a_listen`):

```ts
  // Brain: accept outbound hand connections (乙 v2 ws hub). Bind tailnet/loopback.
  yi_hub_listen: z.object({ host: z.string(), port: z.number() }).optional(),
  // Hand: connect outbound to a brain's ws hub.
  yi_brain: z.object({ url: z.string(), handId: z.string(), authToken: z.string().min(16) }).optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --bun vitest run src/lib/agent-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent-config.ts src/lib/agent-config.test.ts
git commit -m "feat(yi): config — A2A transport field + yi_hub_listen/yi_brain

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Route `delegateToHand` by transport (ws → hub)

**Files:**
- Modify: `src/daemon/wiring/pipeline-deps.ts` (the `delegateToHand` closure, ~lines 119-132)
- Modify: `src/daemon/bootstrap/index.ts` (create the hub + ws server when `yi_hub_listen` set; pass `hub` into pipeline deps via `boot`)
- Test: `src/daemon/wiring/pipeline-deps-delegate.test.ts` (new, focused)

The existing `delegateToHand` resolves the hand from the registry, then HTTP-POSTs. After this task: if `hand.transport === 'ws'`, call `hub.dispatchTask(hand.id, ...)`; else keep the existing push path. Make the closure take an injected `hub` so it's unit-testable without a daemon.

- [ ] **Step 1: Write the failing test**

```ts
// src/daemon/wiring/pipeline-deps-delegate.test.ts
import { describe, expect, it, vi } from 'vitest'
import { makeDelegateToHand } from './pipeline-deps'

describe('makeDelegateToHand routing', () => {
  const wsHand = { id: 'home', name: '家里', url: 'http://x/a2a', inbound_api_key: 'k'.repeat(16), outbound_api_key: 'o', capabilities: ['exec'], paused: false, transport: 'ws' as const }

  it('routes a ws hand through the hub', async () => {
    const hub = { dispatchTask: vi.fn().mockResolvedValue({ ok: true, response: 'via-ws' }), attach: vi.fn(), detach: vi.fn(), isConnected: () => true, onMessage: vi.fn() }
    const delegate = makeDelegateToHand({
      listHands: () => [wsHand],
      hub,
      pushDelegate: vi.fn(),
      selfId: 'wechat-cc',
      timeoutMs: 1000,
    })
    await expect(delegate('家里', 'do x')).resolves.toEqual({ ok: true, response: 'via-ws' })
    expect(hub.dispatchTask).toHaveBeenCalledWith('home', { peer: 'claude', prompt: 'do x' }, 1000)
  })

  it('unknown hand → known list', async () => {
    const delegate = makeDelegateToHand({ listHands: () => [wsHand], hub: { dispatchTask: vi.fn() } as never, pushDelegate: vi.fn(), selfId: 'x', timeoutMs: 1000 })
    await expect(delegate('火星', 'x')).resolves.toEqual({ ok: false, reason: 'unknown_hand', knownHands: ['家里'] })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/daemon/wiring/pipeline-deps-delegate.test.ts`
Expected: FAIL — `makeDelegateToHand` not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/daemon/wiring/pipeline-deps.ts`, extract the delegate logic into an exported, injectable factory and call it from the existing closure. Add near the top-level exports:

```ts
import type { YiHub, YiDispatch } from '../../core/yi-hub'
import type { ExecResult } from '../../core/a2a-server'
import type { A2AAgentRecord } from '../../lib/agent-config'

export interface DelegateDeps {
  listHands: () => readonly A2AAgentRecord[]   // exec-capable agents only
  hub: Pick<YiHub, 'dispatchTask' | 'isConnected'>
  pushDelegate: (hand: A2AAgentRecord, task: YiDispatch, selfId: string, timeoutMs: number) => Promise<ExecResult>
  selfId: string
  timeoutMs: number
}

export function makeDelegateToHand(deps: DelegateDeps) {
  return async (handName: string, task: string): Promise<ExecResult & { knownHands?: string[] }> => {
    const hands = deps.listHands().filter(a => a.capabilities?.includes('exec'))
    const hand = hands.find(a => a.id === handName || a.name === handName)
    if (!hand) return { ok: false, reason: 'unknown_hand', knownHands: hands.map(a => a.name || a.id) }
    const dispatch: YiDispatch = { peer: 'claude', prompt: task }
    if (hand.transport === 'ws') return deps.hub.dispatchTask(hand.id, dispatch, deps.timeoutMs)
    return deps.pushDelegate(hand, dispatch, deps.selfId, deps.timeoutMs)
  }
}
```

Then in the existing `delegateToHand` closure (~line 119), delegate to this factory, wiring `pushDelegate` to the current HTTP path (`createA2AClient` + `doDelegate` from `a2a-delegate`) and `hub` from `boot.yiHub` (added in the bootstrap step below). Keep the `A2A 未启用` guard for when neither hub nor registry is available.

In `src/daemon/bootstrap/index.ts`, after the A2A registry/server wiring: when `configuredAgent.yi_hub_listen` is set, create `const yiHub = createYiHub()` and `const yiServer = createYiWsServer({ host, port, hub: yiHub, verify: (id, tok) => !!a2aRegistry.verifyBearer(id, tok) })`, `await yiServer.start()`, and add `yiHub` to the returned `boot` object so `pipeline-deps` can reach it. When `configuredAgent.yi_brain` is set, create `const yiClient = createYiWsClient({ brainUrl, handId, authToken, capabilities: ['exec'], onExec: (t) => dispatchDelegate(t.peer, t.prompt, t.cwd) })` and `yiClient.start()`. (Reuse the existing `dispatchDelegate` — the same local-agent runner v1's `/a2a/exec` uses.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --bun vitest run src/daemon/wiring/pipeline-deps-delegate.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run typecheck + depcheck + commit**

Run: `bunx tsc --noEmit` → 0 errors; `bun run depcheck` → no violations (note: `pipeline-deps` and `bootstrap` are in `src/daemon`, allowed to import `src/core` — verify `yi-hub`/`yi-ws-*` imports don't cross a forbidden boundary).

```bash
git add src/daemon/wiring/pipeline-deps.ts src/daemon/bootstrap/index.ts src/daemon/wiring/pipeline-deps-delegate.test.ts
git commit -m "feat(yi): route delegate by transport (ws→hub) + bootstrap wiring

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: End-to-end + backward-compat verification

**Files:**
- Test: `src/daemon/yi-e2e.test.ts` (new)

Stand up a brain hub+server and a hand client over real local ws, then drive `makeDelegateToHand` end-to-end; and assert a `transport: 'push'` hand still takes the HTTP path (mock `pushDelegate`, assert the hub is NOT used).

- [ ] **Step 1: Write the test**

```ts
// src/daemon/yi-e2e.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createYiHub } from '../core/yi-hub'
import { createYiWsServer } from './yi-ws-server'
import { createYiWsClient } from './yi-ws-client'
import { makeDelegateToHand } from './wiring/pipeline-deps'

let cleanup: Array<() => void> = []
afterEach(() => { cleanup.forEach((f) => f()); cleanup = [] })

const wsHand = { id: 'home', name: '家里', url: 'http://x/a2a', inbound_api_key: 'k'.repeat(16), outbound_api_key: 'o', capabilities: ['exec'], paused: false, transport: 'ws' as const }
const pushHand = { ...wsHand, id: 'office', name: '公司', transport: 'push' as const }

describe('乙 v2 end-to-end', () => {
  it('让X执行 reaches a ws hand over a live socket', async () => {
    const hub = createYiHub()
    const server = createYiWsServer({ host: '127.0.0.1', port: 0, hub, verify: (id, t) => id === 'home' && t === 'k'.repeat(16) })
    await server.start(); cleanup.push(() => void server.stop())
    const client = createYiWsClient({ brainUrl: `ws://127.0.0.1:${server.port()}`, handId: 'home', authToken: 'k'.repeat(16), capabilities: ['exec'], onExec: async (t) => ({ ok: true, response: `ran:${t.prompt}` }) })
    client.start(); cleanup.push(() => client.stop())
    await new Promise<void>((r) => { const t = setInterval(() => { if (hub.isConnected('home')) { clearInterval(t); r() } }, 5) })

    const delegate = makeDelegateToHand({ listHands: () => [wsHand], hub, pushDelegate: vi.fn(), selfId: 'wechat-cc', timeoutMs: 3000 })
    await expect(delegate('家里', 'sync logs')).resolves.toEqual({ ok: true, response: 'ran:sync logs' })
  })

  it('a push hand still uses the HTTP path (hub untouched)', async () => {
    const hub = { dispatchTask: vi.fn(), isConnected: () => false } as never
    const pushDelegate = vi.fn().mockResolvedValue({ ok: true, response: 'via-http' })
    const delegate = makeDelegateToHand({ listHands: () => [pushHand], hub, pushDelegate, selfId: 'wechat-cc', timeoutMs: 3000 })
    await expect(delegate('公司', 'x')).resolves.toEqual({ ok: true, response: 'via-http' })
    expect(pushDelegate).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the test**

Run: `bun --bun vitest run src/daemon/yi-e2e.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 3: Full gate + commit**

Run: `bun --bun vitest run` (whole suite green) · `bunx tsc --noEmit` (0) · `bun run depcheck` (clean).

```bash
git add src/daemon/yi-e2e.test.ts
git commit -m "test(yi): v2 end-to-end ws dispatch + push backward-compat

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Out of scope for Phase 1 (later phases — do NOT build here)

- Streaming `task/progress`, heartbeat/ping, seq/ack, `resume` (Phase 2).
- End-to-end encryption / Noise (Phase 3).
- cloudflared tunnel / brain-as-rendezvous / multi-hand multiplexing beyond the basic `handId` map (Phase 4).
- `切到<name>` (`bot/takeover`) over the channel (Phase 4).
- Pairing-code provisioning of `yi_brain` (a follow-up to `hand invite`/`join`); for Phase 1, `yi_hub_listen`/`yi_brain` are set in `agent-config.json` by hand.
- Offline-hand WeChat reply copy ("它没连上来") — the hub already returns `hand_offline`; wire the friendly message in `admin-commands.runDelegate` as a small Phase 2 follow-up.

---

## Self-Review

**Spec coverage (Phase 1 rows of the design doc):** ws + JSON-RPC (Task 1) · initialize/initialized handshake (Tasks 3, 4) · task/dispatch + result (Tasks 2, 3) · outbound hand (Task 5) · replaces blocking HTTP POST (Task 7 routing; push retained) · backward compat (Tasks 6, 7, 8). Streaming/relay/E2E correctly deferred. ✓

**Placeholder scan:** every code step contains complete code; commands have expected output. No TBD/“handle errors”/“similar to”. ✓

**Type consistency:** `ExecResult` imported from `a2a-server` everywhere (not redefined). `YiDispatch` defined in `yi-hub.ts` (Task 2), imported by `yi-hand.ts` (Task 3) and `pipeline-deps` (Task 7). `createYiHub`/`createYiHand`/`createYiWsServer`/`createYiWsClient`/`makeDelegateToHand` names are used identically across tasks. Handshake id `1` for `initialize` is consistent between `yi-hand.helloFrame()` (Task 3) and the server test (Task 4). ✓
