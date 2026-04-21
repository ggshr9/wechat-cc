# Phase 1 Core Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the MCP Channel plugin architecture with a single-process Bun daemon that drives `@anthropic-ai/claude-agent-sdk` in streaming-input mode, one keep-alive session per project, zero dev-channel dialog, all existing state files preserved.

**Architecture:**
- Single Bun daemon (`src/daemon/main.ts`) owns the ilink long-poll loop, a per-project `SessionManager`, and an in-process MCP tool server registered via `createSdkMcpServer`.
- Each project session is a single `query({ prompt: AsyncIterable<SDKUserMessage>, options })` call whose `prompt` is an async queue that stays open for the daemon's lifetime. Pushing a message = `queue.push(userMsg)`; Claude keeps its model warm across WeChat turns.
- Permission relay moves from MCP `experimental.claude/channel/permission` notifications to the SDK's `canUseTool` callback.
- `cli.ts` stops spawning `claude`. `wechat-cc run` just exec's the daemon.
- All legacy MCP-glue code (`server.ts` 2325 lines, `cli.ts` supervisor loop, `.restart-flag`, `hasClaudeSessionIn`, `start-channel.sh`, committed `.mcp.json`) is deleted — no dual-path.

**Tech Stack:**
- Bun 1.3+ (existing)
- `@anthropic-ai/claude-agent-sdk@0.2.116` (pins Spike 1 version; replaces `@modelcontextprotocol/sdk`)
- `zod@^4` (peer dep of agent-sdk, used by `tool()` input schemas)
- `vitest@^4` (existing)

**Reference docs:**
- `docs/rfc/01-architecture.md` (RFC 01, §§2–4, §7)
- `docs/spike/phase0/01-sdk-stability/spike.ts` (PASS pattern)
- `E:\1\wechat-cc-deploy-notes.md` (Windows-independent items to fold in)

---

## File Structure

**New directories / files:**

```
src/
  core/
    session-manager.ts          # per-project SDK session pool, lazy spawn, LRU evict
    session-manager.test.ts
    message-router.ts           # inbound WeChat msg → project resolve → session dispatch
    message-router.test.ts
    permission-relay.ts         # CanUseTool adapter — ask WeChat user, await y/n reply
    permission-relay.test.ts
    prompt-format.ts            # WeChat msg → SDKUserMessage content; channel-tag envelope
    prompt-format.test.ts
  features/
    tools.ts                    # createSdkMcpServer registration: reply, share_page, /project, etc.
    tools.test.ts
  daemon/
    main.ts                     # entry point: wire ilink worker + SessionManager + tool server
    main.test.ts                # smoke test for startup/shutdown ordering
    single-instance.ts          # server.pid lockfile (ported from server.ts)
    single-instance.test.ts
```

**Modified at root:**
- `cli.ts` — stripped down; `run()` just execs daemon
- `docs.ts` — one-line fix: `hostname: '127.0.0.1'`
- `package.json` — deps swap, scripts
- `README.md` / `README.zh.md` — update Quick Start to reflect no MCP Channel
- `.gitignore` — add `/.mcp.json` (just in case)

**Kept as-is (refactored only internally if at all):**
- `ilink.ts`, `access.ts`, `handoff.ts`, `log.ts`, `send-reply.ts`, `project-registry.ts`, `config.ts`, `install-user-mcp.ts`

**Deleted outright (Phase 1 cut-over):**
- `server.ts` (entire file; its surviving pieces migrate to `src/daemon/main.ts` and `src/features/tools.ts`)
- `start-channel.sh`
- `.mcp.json` (root) — old MCP Channel plugin manifest
- `.claude-plugin/` dir if it only wires MCP Channel (verify in Task 17)
- `cli.ts` supervisor loop / `readRestartFlag` / `hasClaudeSessionIn` / `buildClaudeArgs` (Task 16)
- Tests: anything that asserts MCP Channel flags or `.restart-flag` semantics (Task 18)

---

## Responsibility Contracts

**`SessionManager`** (`src/core/session-manager.ts`)
```ts
export interface SessionManagerOptions {
  maxConcurrent: number          // LRU cap; default 6
  idleEvictMs: number            // default 30 min
  sdkOptionsForProject: (alias: string, path: string) => import('@anthropic-ai/claude-agent-sdk').Options
}

export interface SessionHandle {
  alias: string
  path: string
  lastUsedAt: number
  dispatch(text: string): Promise<void>      // pushes SDKUserMessage into the session's queue
  close(): Promise<void>                     // graceful abort, drain
  onAssistantText(cb: (text: string) => void): () => void  // for Companion/debugging only; WeChat replies go via reply tool
  onResult(cb: (r: { session_id: string; num_turns: number; duration_ms: number }) => void): () => void
}

export class SessionManager {
  constructor(opts: SessionManagerOptions)
  acquire(alias: string, path: string): Promise<SessionHandle>   // lazy spawn + bump LRU
  release(alias: string): Promise<void>                           // evict
  list(): { alias: string; path: string; lastUsedAt: number }[]
  shutdown(): Promise<void>                                       // close all
}
```

**`MessageRouter`** (`src/core/message-router.ts`)
```ts
export interface RouterDeps {
  resolveProject(chatId: string): { alias: string; path: string }   // from projects.json + user_account_ids.json
  manager: SessionManager
  format: (msg: InboundMsg) => string
  log: (tag: string, line: string) => void
}

export interface InboundMsg {
  chatId: string; userId: string; userName?: string
  text: string; msgType: string; createTimeMs: number
  quoteTo?: string; accountId: string
  // media refs (image paths in inbox/, etc.) pre-materialized by ilink worker
  attachments?: { kind: 'image'|'file'|'voice'; path: string; caption?: string }[]
}

export async function routeInbound(deps: RouterDeps, msg: InboundMsg): Promise<void>
```

**`PermissionRelay`** (`src/core/permission-relay.ts`)
```ts
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'

export interface PermissionRelayDeps {
  askUser(chatId: string, prompt: string, hash: string, timeoutMs: number): Promise<'allow'|'deny'|'timeout'>
  defaultChatId(): string | null     // from last-active; fallback to admin list
  log: (tag: string, line: string) => void
}

export function makeCanUseTool(deps: PermissionRelayDeps): CanUseTool
```

**`tools.ts`** (`src/features/tools.ts`)
```ts
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'

export interface ToolDeps {
  sendReply(chatId: string, text: string): Promise<{ msgId: string }>
  sendFile(chatId: string, path: string): Promise<void>
  editMessage(chatId: string, msgId: string, text: string): Promise<void>
  broadcast(text: string, accountId?: string): Promise<{ ok: number; failed: number }>
  sharePage(title: string, content: string): Promise<{ url: string; slug: string }>
  resurfacePage(query: { slug?: string; title_fragment?: string }): Promise<{ url: string; slug: string } | null>
  setUserName(chatId: string, name: string): Promise<void>
  projects: {
    list(): { alias: string; path: string; current: boolean }[]
    switchTo(alias: string): Promise<{ ok: true; path: string } | { ok: false; reason: string }>
    add(alias: string, path: string): Promise<void>
    remove(alias: string): Promise<void>
  }
}

export function buildWechatMcpServer(deps: ToolDeps): McpSdkServerConfigWithInstance
```

**`daemon/main.ts`** entrypoint responsibilities (no public export surface — it's the binary):
1. Acquire single-instance lock (`server.pid`)
2. Load accounts, context_tokens, user_names, user_account_ids, projects, access
3. Build `ToolDeps` bound to loaded state + ilink
4. Build `SessionManagerOptions.sdkOptionsForProject` (returns `Options` with `cwd`, `mcpServers`, `canUseTool`, `systemPrompt` = channel instructions, `permissionMode: 'default'`, `settingSources: ['user','project','local']`)
5. Start ilink long-poll per account → feed into `MessageRouter`
6. Install signal handlers: flush debounced writes (context_tokens), close SessionManager, release lock
7. Expose a lightweight status file for `/wechat:status` plugin entry (stretch, optional in Phase 1)

---

## Task 0: Branch prep + dependency swap

**Files:**
- Modify: `package.json`
- Create: `src/` directory tree (empty placeholders to keep git honest)
- Check: `bun.lock`

- [ ] **Step 0.1: Confirm branch state clean**

Run:
```bash
cd "/c/Users/natewanzi/.claude/plugins/local/wechat"
git status
git log --oneline -3
```
Expected: clean working tree; HEAD at `4917d4e docs: Phase 0 planning — Agent SDK rebuild RFC + stability spike`. If not clean, stash or commit first; do not proceed on dirty tree.

- [ ] **Step 0.2: Install Agent SDK, remove MCP SDK, add zod**

Edit `package.json` dependencies block to:
```json
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "0.2.116",
    "marked": "^18.0.0",
    "qrcode-terminal": "^0.12.0",
    "zod": "^4.0.0"
  },
```

Remove `@modelcontextprotocol/sdk`. Pin Agent SDK to the exact version that passed Spike 1.

Run:
```bash
bun install
```
Expected: lockfile updates; `node_modules/@anthropic-ai/claude-agent-sdk/package.json` shows version `0.2.116`; no `@modelcontextprotocol/sdk` in deps tree (may still appear as transitive dep of `@anthropic-ai/claude-agent-sdk` — that's fine).

- [ ] **Step 0.3: Create empty src/ tree**

```bash
mkdir -p src/core src/features src/daemon
touch src/core/.gitkeep src/features/.gitkeep src/daemon/.gitkeep
```

- [ ] **Step 0.4: Add tsconfig if missing, verify strict**

Check: `cat tsconfig.json` if present. If not present, create:
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "types": ["bun-types"],
    "lib": ["ESNext"],
    "esModuleInterop": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true
  },
  "include": ["**/*.ts", "src/**/*.ts"],
  "exclude": ["node_modules", "docs/spike/**/node_modules"]
}
```

Run:
```bash
bun tsc --noEmit 2>&1 | head -40
```
Expected: errors only from current `server.ts` that will die anyway — that's fine. Record the error count so we can tell later if we introduced new ones.

- [ ] **Step 0.5: Commit**

```bash
git add package.json bun.lock tsconfig.json src/
git commit -m "chore(phase1): swap @modelcontextprotocol/sdk → @anthropic-ai/claude-agent-sdk@0.2.116"
```

---

## Task 1: `SessionHandle` + `SessionManager` skeleton (TDD)

**Files:**
- Create: `src/core/session-manager.ts`
- Create: `src/core/session-manager.test.ts`

- [ ] **Step 1.1: Write failing test — lazy spawn**

Create `src/core/session-manager.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SessionManager } from './session-manager'
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'

// Module-level spy injected via vi.mock so SessionManager uses our fake query()
const fakeQuery = vi.fn()
vi.mock('@anthropic-ai/claude-agent-sdk', async () => {
  return {
    query: (params: unknown) => fakeQuery(params),
  }
})

function makeFakeQuery(): Query {
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    // never yields on its own — caller pushes messages, test asserts receipt
    await new Promise(() => {})
  }
  const q = gen() as unknown as Query
  ;(q as any).interrupt = vi.fn()
  ;(q as any).close = vi.fn()
  return q
}

beforeEach(() => {
  fakeQuery.mockReset()
  fakeQuery.mockImplementation(() => makeFakeQuery())
})

describe('SessionManager', () => {
  it('does not spawn until acquire() is called', async () => {
    const mgr = new SessionManager({
      maxConcurrent: 4,
      idleEvictMs: 60_000,
      sdkOptionsForProject: () => ({ cwd: '/tmp/x' } as Options),
    })
    expect(fakeQuery).not.toHaveBeenCalled()
    expect(mgr.list()).toEqual([])
    await mgr.shutdown()
  })

  it('lazy-spawns on first acquire, reuses on second', async () => {
    const mgr = new SessionManager({
      maxConcurrent: 4,
      idleEvictMs: 60_000,
      sdkOptionsForProject: (alias, path) => ({ cwd: path } as Options),
    })
    const a = await mgr.acquire('proj-a', '/home/nate/proj-a')
    expect(fakeQuery).toHaveBeenCalledTimes(1)
    const a2 = await mgr.acquire('proj-a', '/home/nate/proj-a')
    expect(a).toBe(a2)
    expect(fakeQuery).toHaveBeenCalledTimes(1)
    await mgr.shutdown()
  })
})
```

- [ ] **Step 1.2: Run test to verify it fails**

```bash
bun run vitest run src/core/session-manager.test.ts
```
Expected: FAIL with `Cannot find module './session-manager'` or similar.

- [ ] **Step 1.3: Minimal SessionManager implementation**

Create `src/core/session-manager.ts`:
```ts
import { query, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

export interface SessionManagerOptions {
  maxConcurrent: number
  idleEvictMs: number
  sdkOptionsForProject: (alias: string, path: string) => Options
}

export interface SessionHandle {
  readonly alias: string
  readonly path: string
  lastUsedAt: number
  dispatch(text: string): Promise<void>
  close(): Promise<void>
  onAssistantText(cb: (text: string) => void): () => void
  onResult(cb: (r: { session_id: string; num_turns: number; duration_ms: number }) => void): () => void
}

interface Internal {
  handle: SessionHandle
  queue: AsyncQueue<SDKUserMessage>
  q: Query
  drainPromise: Promise<void>
}

export class SessionManager {
  private readonly opts: SessionManagerOptions
  private readonly sessions = new Map<string, Internal>()

  constructor(opts: SessionManagerOptions) {
    this.opts = opts
  }

  async acquire(alias: string, path: string): Promise<SessionHandle> {
    const existing = this.sessions.get(alias)
    if (existing) {
      existing.handle.lastUsedAt = Date.now()
      return existing.handle
    }
    return this.spawn(alias, path)
  }

  private async spawn(alias: string, path: string): Promise<SessionHandle> {
    const queue = new AsyncQueue<SDKUserMessage>()
    const options = this.opts.sdkOptionsForProject(alias, path)
    const q = query({ prompt: queue.iterable(), options })
    const assistantListeners = new Set<(t: string) => void>()
    const resultListeners = new Set<(r: { session_id: string; num_turns: number; duration_ms: number }) => void>()

    const handle: SessionHandle = {
      alias,
      path,
      lastUsedAt: Date.now(),
      async dispatch(text: string) {
        queue.push({
          type: 'user',
          parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'text', text }] },
        } as SDKUserMessage)
        handle.lastUsedAt = Date.now()
      },
      async close() {
        queue.end()
        ;(q as unknown as { close?: () => void }).close?.()
      },
      onAssistantText(cb) { assistantListeners.add(cb); return () => assistantListeners.delete(cb) },
      onResult(cb) { resultListeners.add(cb); return () => resultListeners.delete(cb) },
    }

    const drainPromise = (async () => {
      for await (const msg of q as AsyncGenerator<SDKMessage>) {
        if ((msg as { type: string }).type === 'assistant') {
          const content = (msg as any).message?.content
          const text = extractText(content)
          if (text) for (const cb of assistantListeners) cb(text)
        } else if ((msg as { type: string }).type === 'result') {
          const r = msg as any
          for (const cb of resultListeners) cb({
            session_id: r.session_id,
            num_turns: r.num_turns,
            duration_ms: r.duration_ms,
          })
        }
      }
    })().catch(() => {})

    this.sessions.set(alias, { handle, queue, q, drainPromise })
    return handle
  }

  async release(alias: string): Promise<void> {
    const s = this.sessions.get(alias)
    if (!s) return
    this.sessions.delete(alias)
    await s.handle.close()
    await s.drainPromise
  }

  list() {
    return Array.from(this.sessions.values()).map(s => ({
      alias: s.handle.alias,
      path: s.handle.path,
      lastUsedAt: s.handle.lastUsedAt,
    }))
  }

  async shutdown(): Promise<void> {
    const aliases = Array.from(this.sessions.keys())
    await Promise.all(aliases.map(a => this.release(a)))
  }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(b => (b && typeof b === 'object' && (b as any).type === 'text' ? (b as any).text ?? '' : '')).join('')
  }
  return ''
}

class AsyncQueue<T> {
  private buf: T[] = []
  private resolvers: ((v: IteratorResult<T>) => void)[] = []
  private closed = false
  push(v: T) {
    if (this.closed) return
    const r = this.resolvers.shift()
    if (r) r({ value: v, done: false })
    else this.buf.push(v)
  }
  end() {
    this.closed = true
    const r = this.resolvers.shift()
    if (r) r({ value: undefined as unknown as T, done: true })
  }
  iterable(): AsyncIterable<T> {
    const self = this
    return {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          next() {
            if (self.buf.length > 0) return Promise.resolve({ value: self.buf.shift() as T, done: false })
            if (self.closed) return Promise.resolve({ value: undefined as unknown as T, done: true })
            return new Promise<IteratorResult<T>>(res => self.resolvers.push(res))
          },
          async return() { self.end(); return { value: undefined as unknown as T, done: true } },
        }
      },
    }
  }
}
```

- [ ] **Step 1.4: Run test to verify it passes**

```bash
bun run vitest run src/core/session-manager.test.ts
```
Expected: 2 passed.

- [ ] **Step 1.5: Commit**

```bash
git add src/core/session-manager.ts src/core/session-manager.test.ts
git commit -m "feat(core): SessionManager lazy spawn + reuse"
```

---

## Task 2: `SessionManager.dispatch` + multi-turn queue (TDD)

**Files:**
- Modify: `src/core/session-manager.ts`
- Modify: `src/core/session-manager.test.ts`

- [ ] **Step 2.1: Add test asserting messages reach the prompt iterable in order**

Append to `src/core/session-manager.test.ts`:
```ts
  it('dispatch pushes messages in order into the prompt iterable', async () => {
    const seen: string[] = []
    fakeQuery.mockImplementation((params: any) => {
      const iter = params.prompt as AsyncIterable<SDKUserMessage>
      ;(async () => {
        for await (const m of iter) {
          const content: any = m.message?.content
          const text = Array.isArray(content) ? content.map((b: any) => b.text ?? '').join('') : content
          seen.push(text)
        }
      })().catch(() => {})
      return makeFakeQuery()
    })

    const mgr = new SessionManager({
      maxConcurrent: 4,
      idleEvictMs: 60_000,
      sdkOptionsForProject: () => ({ cwd: '/tmp/x' } as Options),
    })
    const h = await mgr.acquire('a', '/tmp/x')
    await h.dispatch('first')
    await h.dispatch('second')
    await new Promise(r => setTimeout(r, 10))
    expect(seen).toEqual(['first', 'second'])
    await mgr.shutdown()
  })
```

- [ ] **Step 2.2: Run test — should pass with current implementation**

```bash
bun run vitest run src/core/session-manager.test.ts
```
Expected: 3 passed (Task 1 tests still green; new test green).

If new test **fails**, fix `AsyncQueue` — likely off-by-one in resolver draining order.

- [ ] **Step 2.3: Commit if any fixes made, else skip**

```bash
git add -u && git commit -m "test(core): SessionManager dispatch order" || echo "no-op if nothing to commit"
```

---

## Task 3: LRU eviction + capacity (TDD)

**Files:**
- Modify: `src/core/session-manager.ts`
- Modify: `src/core/session-manager.test.ts`

- [ ] **Step 3.1: Add tests**

```ts
  it('evicts least-recently-used when capacity exceeded', async () => {
    const mgr = new SessionManager({
      maxConcurrent: 2,
      idleEvictMs: 60_000,
      sdkOptionsForProject: () => ({ cwd: '/tmp/x' } as Options),
    })
    await mgr.acquire('a', '/a')
    await mgr.acquire('b', '/b')
    // force b more recent than a
    await new Promise(r => setTimeout(r, 2))
    const handleA = await mgr.acquire('a', '/a')  // re-touches a
    expect(handleA.alias).toBe('a')
    await mgr.acquire('c', '/c')  // should evict b (LRU), keep a
    const aliases = mgr.list().map(s => s.alias).sort()
    expect(aliases).toEqual(['a', 'c'])
    await mgr.shutdown()
  })

  it('evicts idle sessions past idleEvictMs', async () => {
    vi.useFakeTimers()
    const mgr = new SessionManager({
      maxConcurrent: 10,
      idleEvictMs: 1000,
      sdkOptionsForProject: () => ({ cwd: '/tmp/x' } as Options),
    })
    await mgr.acquire('a', '/a')
    vi.advanceTimersByTime(2000)
    await mgr.sweepIdle()
    expect(mgr.list()).toEqual([])
    vi.useRealTimers()
    await mgr.shutdown()
  })
```

- [ ] **Step 3.2: Run tests — expect the LRU + sweepIdle tests to fail**

```bash
bun run vitest run src/core/session-manager.test.ts
```
Expected: 3 passed, 2 failed.

- [ ] **Step 3.3: Implement LRU eviction + sweepIdle**

In `src/core/session-manager.ts`:

Replace the body of `spawn(...)` so that after inserting into `sessions`, it calls `this.enforceCapacity()`. Add methods:

```ts
  private async enforceCapacity(): Promise<void> {
    while (this.sessions.size > this.opts.maxConcurrent) {
      const lru = this.pickLru()
      if (!lru) break
      await this.release(lru)
    }
  }

  private pickLru(): string | null {
    let worstAlias: string | null = null
    let worstAt = Infinity
    for (const [alias, s] of this.sessions) {
      if (s.handle.lastUsedAt < worstAt) { worstAt = s.handle.lastUsedAt; worstAlias = alias }
    }
    return worstAlias
  }

  async sweepIdle(): Promise<void> {
    const now = Date.now()
    for (const [alias, s] of Array.from(this.sessions.entries())) {
      if (now - s.handle.lastUsedAt >= this.opts.idleEvictMs) {
        await this.release(alias)
      }
    }
  }
```

Declare `sweepIdle` and `enforceCapacity` in the class body. Adjust `spawn` to call `this.enforceCapacity()` before returning the handle.

- [ ] **Step 3.4: Run tests — all should pass**

```bash
bun run vitest run src/core/session-manager.test.ts
```
Expected: 5 passed.

- [ ] **Step 3.5: Commit**

```bash
git add -u && git commit -m "feat(core): SessionManager LRU eviction + idle sweep"
```

---

## Task 4: Channel-tag prompt formatter (TDD)

WeChat messages need a wrapper so Claude can parse sender/chat context and knows to reply via the `reply` tool (not via text). This format becomes the daemon-to-Claude protocol.

**Files:**
- Create: `src/core/prompt-format.ts`
- Create: `src/core/prompt-format.test.ts`

- [ ] **Step 4.1: Write tests**

```ts
import { describe, it, expect } from 'vitest'
import { formatInbound } from './prompt-format'

describe('formatInbound', () => {
  it('wraps a plain text message with channel tag', () => {
    const out = formatInbound({
      chatId: 'cid1', userId: 'u1', userName: '小白',
      text: 'hello', msgType: 'text', createTimeMs: 1_000_000,
      accountId: 'acct-a',
    })
    expect(out).toContain('<wechat')
    expect(out).toContain('chat_id="cid1"')
    expect(out).toContain('user="小白"')
    expect(out).toContain('hello')
    expect(out).toContain('</wechat>')
  })

  it('escapes angle brackets inside body but preserves tag', () => {
    const out = formatInbound({
      chatId: 'c', userId: 'u', userName: 'x',
      text: '<script>alert(1)</script>', msgType: 'text', createTimeMs: 1, accountId: 'a',
    })
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
  })

  it('inlines attachments with local paths', () => {
    const out = formatInbound({
      chatId: 'c', userId: 'u', userName: 'x',
      text: '看图', msgType: 'image', createTimeMs: 1, accountId: 'a',
      attachments: [{ kind: 'image', path: '/home/u/.claude/channels/wechat/inbox/a/b.jpg' }],
    })
    expect(out).toContain('[image:/home/u/.claude/channels/wechat/inbox/a/b.jpg]')
  })

  it('includes quote reference when quoteTo set', () => {
    const out = formatInbound({
      chatId: 'c', userId: 'u', userName: 'x',
      text: '这条', msgType: 'text', createTimeMs: 1, accountId: 'a',
      quoteTo: 'prev-msg-id',
    })
    expect(out).toContain('quote_to="prev-msg-id"')
  })
})
```

- [ ] **Step 4.2: Run — fail on missing module**

```bash
bun run vitest run src/core/prompt-format.test.ts
```
Expected: FAIL.

- [ ] **Step 4.3: Implement**

Create `src/core/prompt-format.ts`:
```ts
export interface InboundMsg {
  chatId: string
  userId: string
  userName?: string
  text: string
  msgType: string
  createTimeMs: number
  quoteTo?: string
  accountId: string
  attachments?: { kind: 'image' | 'file' | 'voice'; path: string; caption?: string }[]
}

export function formatInbound(m: InboundMsg): string {
  const attrs = [
    `chat_id="${escAttr(m.chatId)}"`,
    `user="${escAttr(m.userName ?? m.userId)}"`,
    `user_id="${escAttr(m.userId)}"`,
    `account="${escAttr(m.accountId)}"`,
    `msg_type="${escAttr(m.msgType)}"`,
    `ts="${m.createTimeMs}"`,
    m.quoteTo ? `quote_to="${escAttr(m.quoteTo)}"` : '',
  ].filter(Boolean).join(' ')

  const attachmentLines = (m.attachments ?? []).map(a => {
    const caption = a.caption ? ` ${escBody(a.caption)}` : ''
    return `[${a.kind}:${a.path}]${caption}`
  })

  const body = [escBody(m.text), ...attachmentLines].filter(Boolean).join('\n')
  return `<wechat ${attrs}>\n${body}\n</wechat>`
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escBody(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
```

- [ ] **Step 4.4: Run — pass**

```bash
bun run vitest run src/core/prompt-format.test.ts
```
Expected: 4 passed.

- [ ] **Step 4.5: Commit**

```bash
git add src/core/prompt-format.ts src/core/prompt-format.test.ts
git commit -m "feat(core): channel-tag wrapper for inbound WeChat messages"
```

---

## Task 5: `MessageRouter` (TDD)

**Files:**
- Create: `src/core/message-router.ts`
- Create: `src/core/message-router.test.ts`

- [ ] **Step 5.1: Write tests**

```ts
import { describe, it, expect, vi } from 'vitest'
import { routeInbound, type RouterDeps } from './message-router'

describe('routeInbound', () => {
  it('resolves chat to project and dispatches formatted prompt', async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined)
    const acquire = vi.fn().mockResolvedValue({ alias: 'P', path: '/p', dispatch })
    const deps: RouterDeps = {
      resolveProject: () => ({ alias: 'P', path: '/p' }),
      manager: { acquire } as any,
      format: (m) => `MSG:${m.text}`,
      log: () => {},
    }
    await routeInbound(deps, {
      chatId: 'c', userId: 'u', userName: 'n',
      text: 'hi', msgType: 'text', createTimeMs: 1, accountId: 'a',
    })
    expect(acquire).toHaveBeenCalledWith('P', '/p')
    expect(dispatch).toHaveBeenCalledWith('MSG:hi')
  })

  it('logs and drops when resolver returns null project', async () => {
    const log = vi.fn()
    const acquire = vi.fn()
    const deps: RouterDeps = {
      resolveProject: () => null,
      manager: { acquire } as any,
      format: (m) => m.text,
      log,
    }
    await routeInbound(deps, {
      chatId: 'c', userId: 'u', text: 'hi', msgType: 'text', createTimeMs: 1, accountId: 'a',
    })
    expect(acquire).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalled()
  })
})
```

- [ ] **Step 5.2: Run — fail**

```bash
bun run vitest run src/core/message-router.test.ts
```

- [ ] **Step 5.3: Implement**

Create `src/core/message-router.ts`:
```ts
import type { SessionManager } from './session-manager'
import type { InboundMsg } from './prompt-format'

export interface RouterDeps {
  resolveProject(chatId: string): { alias: string; path: string } | null
  manager: Pick<SessionManager, 'acquire'>
  format: (msg: InboundMsg) => string
  log: (tag: string, line: string) => void
}

export async function routeInbound(deps: RouterDeps, msg: InboundMsg): Promise<void> {
  const proj = deps.resolveProject(msg.chatId)
  if (!proj) {
    deps.log('ROUTER', `drop: no project for chat=${msg.chatId}`)
    return
  }
  const handle = await deps.manager.acquire(proj.alias, proj.path)
  const text = deps.format(msg)
  await handle.dispatch(text)
}
```

Export `InboundMsg` type re-export from `prompt-format`:
```ts
export type { InboundMsg } from './prompt-format'
```

- [ ] **Step 5.4: Run — pass**

```bash
bun run vitest run src/core/message-router.test.ts
```
Expected: 2 passed.

- [ ] **Step 5.5: Commit**

```bash
git add src/core/message-router.ts src/core/message-router.test.ts
git commit -m "feat(core): MessageRouter.routeInbound"
```

---

## Task 6: Project resolver wired to existing stores (TDD)

Current state layout:
- `projects.json` — alias→{path, last_active}; `current` key for the active alias
- `user_account_ids.json` — `chat_id → account_id` routing
- Default: if `projects.json.current` is set, route everything there

**Files:**
- Create: `src/core/project-resolver.ts`
- Create: `src/core/project-resolver.test.ts`

- [ ] **Step 6.1: Test — resolve uses projects.current when set**

```ts
import { describe, it, expect } from 'vitest'
import { makeResolver } from './project-resolver'

describe('project-resolver', () => {
  it('returns current project when set', () => {
    const resolve = makeResolver({
      loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
    })
    expect(resolve('any-chat')).toEqual({ alias: 'P', path: '/p' })
  })

  it('returns null when no current and no chat override', () => {
    const resolve = makeResolver({
      loadProjects: () => ({ projects: {}, current: null }),
    })
    expect(resolve('any-chat')).toBeNull()
  })

  it('returns null when current alias does not exist in projects map', () => {
    const resolve = makeResolver({
      loadProjects: () => ({ projects: {}, current: 'ghost' }),
    })
    expect(resolve('any-chat')).toBeNull()
  })
})
```

- [ ] **Step 6.2: Run — fail**

- [ ] **Step 6.3: Implement**

```ts
export interface ProjectsSnapshot {
  projects: Record<string, { path: string; last_active: number }>
  current: string | null
}

export interface ResolverDeps {
  loadProjects: () => ProjectsSnapshot
}

export function makeResolver(deps: ResolverDeps): (chatId: string) => { alias: string; path: string } | null {
  return (_chatId: string) => {
    const snap = deps.loadProjects()
    const alias = snap.current
    if (!alias) return null
    const entry = snap.projects[alias]
    if (!entry) return null
    return { alias, path: entry.path }
  }
}
```

- [ ] **Step 6.4: Run — pass, commit**

```bash
bun run vitest run src/core/project-resolver.test.ts
git add src/core/project-resolver.ts src/core/project-resolver.test.ts
git commit -m "feat(core): project resolver from projects.json"
```

---

## Task 7: `PermissionRelay` — `canUseTool` adapter (TDD)

**Files:**
- Create: `src/core/permission-relay.ts`
- Create: `src/core/permission-relay.test.ts`

- [ ] **Step 7.1: Test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeCanUseTool } from './permission-relay'

describe('makeCanUseTool', () => {
  it('returns allow when user replies allow', async () => {
    const ask = vi.fn().mockResolvedValue('allow')
    const fn = makeCanUseTool({
      askUser: ask,
      defaultChatId: () => 'admin-chat',
      log: () => {},
    })
    const res = await fn('Edit', { path: '/tmp/x' }, { signal: new AbortController().signal, toolUseID: 't1' } as any)
    expect(res.behavior).toBe('allow')
    expect(ask).toHaveBeenCalledWith('admin-chat', expect.stringContaining('Edit'), expect.any(String), expect.any(Number))
  })

  it('returns deny when user replies deny', async () => {
    const fn = makeCanUseTool({
      askUser: async () => 'deny',
      defaultChatId: () => 'admin-chat',
      log: () => {},
    })
    const res = await fn('Bash', { cmd: 'rm -rf /' }, { signal: new AbortController().signal, toolUseID: 't1' } as any)
    expect(res.behavior).toBe('deny')
    if (res.behavior === 'deny') expect(res.message).toMatch(/denied/i)
  })

  it('returns deny on timeout', async () => {
    const fn = makeCanUseTool({
      askUser: async () => 'timeout',
      defaultChatId: () => 'admin-chat',
      log: () => {},
    })
    const res = await fn('Write', { path: '/x' }, { signal: new AbortController().signal, toolUseID: 't' } as any)
    expect(res.behavior).toBe('deny')
  })

  it('returns deny with auto-decline reason when no default chat', async () => {
    const ask = vi.fn()
    const fn = makeCanUseTool({
      askUser: ask,
      defaultChatId: () => null,
      log: () => {},
    })
    const res = await fn('Edit', {}, { signal: new AbortController().signal, toolUseID: 't' } as any)
    expect(res.behavior).toBe('deny')
    expect(ask).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 7.2: Run — fail**

- [ ] **Step 7.3: Implement**

```ts
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
```

- [ ] **Step 7.4: Run — pass, commit**

```bash
bun run vitest run src/core/permission-relay.test.ts
git add src/core/permission-relay.ts src/core/permission-relay.test.ts
git commit -m "feat(core): PermissionRelay — canUseTool via WeChat Q&A"
```

---

## Task 8: `features/tools.ts` — reply + edit_message + set_user_name + send_file + broadcast (TDD)

The tool schema mirrors current server.ts:1067-1230 but registered via `createSdkMcpServer` + `tool()`. Handlers call `ToolDeps` (thin adapters to existing modules `send-reply.ts`, `ilink.ts`, `docs.ts`, `project-registry.ts`).

**Files:**
- Create: `src/features/tools.ts`
- Create: `src/features/tools.test.ts`

**Contract**: `buildWechatMcpServer` returns `{ config, handlers }` — `config` goes to `Options.mcpServers`; `handlers` is a typed map exposed for tests (SDK's MCP server instance has no public handler registry, so we surface them ourselves).

```ts
// in src/features/tools.ts
export interface BuiltWechatMcp {
  config: McpSdkServerConfigWithInstance
  handlers: {
    reply: (args: { chat_id: string; text: string }) => Promise<unknown>
    edit_message: (args: { chat_id: string; msg_id: string; text: string }) => Promise<unknown>
    set_user_name: (args: { chat_id: string; name: string }) => Promise<unknown>
    send_file: (args: { chat_id: string; path: string }) => Promise<unknown>
    broadcast: (args: { text: string; account_id?: string }) => Promise<unknown>
    share_page: (args: { title: string; content: string }) => Promise<unknown>
    resurface_page: (args: { slug?: string; title_fragment?: string }) => Promise<unknown>
    list_projects: (args: Record<string, never>) => Promise<unknown>
    switch_project: (args: { alias: string }) => Promise<unknown>
    add_project: (args: { alias: string; path: string }) => Promise<unknown>
    remove_project: (args: { alias: string }) => Promise<unknown>
  }
}
export function buildWechatMcpServer(deps: ToolDeps): BuiltWechatMcp
```

- [ ] **Step 8.1: Write the tests**

```ts
import { describe, it, expect, vi } from 'vitest'
import { buildWechatMcpServer, type ToolDeps } from './tools'

function makeDeps(over: Partial<ToolDeps> = {}): ToolDeps {
  return {
    sendReply: vi.fn().mockResolvedValue({ msgId: 'm1' }),
    sendFile: vi.fn().mockResolvedValue(undefined),
    editMessage: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn().mockResolvedValue({ ok: 1, failed: 0 }),
    sharePage: vi.fn().mockResolvedValue({ url: 'https://x/abc', slug: 'abc' }),
    resurfacePage: vi.fn().mockResolvedValue({ url: 'https://x/abc', slug: 'abc' }),
    setUserName: vi.fn().mockResolvedValue(undefined),
    projects: {
      list: () => [{ alias: 'P', path: '/p', current: true }],
      switchTo: vi.fn().mockResolvedValue({ ok: true, path: '/p' }),
      add: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    ...over,
  }
}

describe('buildWechatMcpServer', () => {
  it('exposes sdk config with name=wechat', () => {
    const { config } = buildWechatMcpServer(makeDeps())
    expect(config.type).toBe('sdk')
    expect(config.name).toBe('wechat')
    expect(config.instance).toBeDefined()
  })

  it('reply tool invokes deps.sendReply', async () => {
    const deps = makeDeps()
    const { handlers } = buildWechatMcpServer(deps)
    const out = await handlers.reply({ chat_id: 'c1', text: 'hi' })
    expect(deps.sendReply).toHaveBeenCalledWith('c1', 'hi')
    expect(out).toMatchObject({ content: [{ type: 'text' }] })
  })

  it('share_page returns URL', async () => {
    const deps = makeDeps()
    const { handlers } = buildWechatMcpServer(deps)
    const out = await handlers.share_page({ title: 't', content: '# hi' })
    expect(deps.sharePage).toHaveBeenCalledWith('t', '# hi')
    expect(JSON.stringify(out)).toContain('https://x/abc')
  })

  it('switch_project surfaces failure reason', async () => {
    const deps = makeDeps({
      projects: {
        list: () => [],
        switchTo: async () => ({ ok: false, reason: 'alias not found' }),
        add: async () => {},
        remove: async () => {},
      },
    })
    const { handlers } = buildWechatMcpServer(deps)
    const out = await handlers.switch_project({ alias: 'ghost' })
    expect(JSON.stringify(out)).toContain('alias not found')
  })

  it('list_projects returns JSON list', async () => {
    const deps = makeDeps()
    const { handlers } = buildWechatMcpServer(deps)
    const out = await handlers.list_projects({})
    expect(JSON.stringify(out)).toContain('"P"')
  })
})
```

- [ ] **Step 8.2: Run — fail**

```bash
bun run vitest run src/features/tools.test.ts
```

- [ ] **Step 8.3: Implement**

```ts
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

export interface ToolDeps {
  sendReply(chatId: string, text: string): Promise<{ msgId: string }>
  sendFile(chatId: string, path: string): Promise<void>
  editMessage(chatId: string, msgId: string, text: string): Promise<void>
  broadcast(text: string, accountId?: string): Promise<{ ok: number; failed: number }>
  sharePage(title: string, content: string): Promise<{ url: string; slug: string }>
  resurfacePage(q: { slug?: string; title_fragment?: string }): Promise<{ url: string; slug: string } | null>
  setUserName(chatId: string, name: string): Promise<void>
  projects: {
    list(): { alias: string; path: string; current: boolean }[]
    switchTo(alias: string): Promise<{ ok: true; path: string } | { ok: false; reason: string }>
    add(alias: string, path: string): Promise<void>
    remove(alias: string): Promise<void>
  }
}

export interface BuiltWechatMcp {
  config: McpSdkServerConfigWithInstance
  handlers: Record<string, (args: any) => Promise<unknown>>
}

function okText(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

export function buildWechatMcpServer(deps: ToolDeps): BuiltWechatMcp {
  const handlers: Record<string, (args: any) => Promise<unknown>> = {}

  const replyDef = tool(
    'reply',
    '给当前微信用户回复文本。chat_id 必填。长文本会自动分段。',
    { chat_id: z.string(), text: z.string() },
    async ({ chat_id, text }) => {
      const { msgId } = await deps.sendReply(chat_id, text)
      return okText(JSON.stringify({ ok: true, msg_id: msgId }))
    },
  )
  handlers.reply = async (a) => (await replyDef.handler(a, undefined)) as unknown

  const editDef = tool(
    'edit_message',
    '编辑已发送的消息（需要 msg_id）。',
    { chat_id: z.string(), msg_id: z.string(), text: z.string() },
    async ({ chat_id, msg_id, text }) => {
      await deps.editMessage(chat_id, msg_id, text)
      return okText(JSON.stringify({ ok: true }))
    },
  )
  handlers.edit_message = async (a) => (await editDef.handler(a, undefined)) as unknown

  const setNameDef = tool(
    'set_user_name',
    '记住新用户的显示名称。',
    { chat_id: z.string(), name: z.string() },
    async ({ chat_id, name }) => {
      await deps.setUserName(chat_id, name)
      return okText(JSON.stringify({ ok: true }))
    },
  )
  handlers.set_user_name = async (a) => (await setNameDef.handler(a, undefined)) as unknown

  const sendFileDef = tool(
    'send_file',
    '给当前用户发送文件（本地绝对路径）。',
    { chat_id: z.string(), path: z.string() },
    async ({ chat_id, path }) => {
      await deps.sendFile(chat_id, path)
      return okText(JSON.stringify({ ok: true }))
    },
  )
  handlers.send_file = async (a) => (await sendFileDef.handler(a, undefined)) as unknown

  const broadcastDef = tool(
    'broadcast',
    '向所有在线用户群发文本。account_id 可选（不填则默认主账号）。',
    { text: z.string(), account_id: z.string().optional() },
    async ({ text, account_id }) => {
      const r = await deps.broadcast(text, account_id)
      return okText(JSON.stringify({ ok: true, ...r }))
    },
  )
  handlers.broadcast = async (a) => (await broadcastDef.handler(a, undefined)) as unknown

  const shareDef = tool(
    'share_page',
    '把 Markdown 内容发布为一次性 URL。返回 {url, slug}。',
    { title: z.string(), content: z.string() },
    async ({ title, content }) => {
      const r = await deps.sharePage(title, content)
      return okText(JSON.stringify(r))
    },
  )
  handlers.share_page = async (a) => (await shareDef.handler(a, undefined)) as unknown

  const resurfaceDef = tool(
    'resurface_page',
    '根据 slug 或标题片段重新生成一个有效 URL。',
    { slug: z.string().optional(), title_fragment: z.string().optional() },
    async ({ slug, title_fragment }) => {
      const r = await deps.resurfacePage({ slug, title_fragment })
      return okText(JSON.stringify(r ?? { ok: false, reason: 'not found' }))
    },
  )
  handlers.resurface_page = async (a) => (await resurfaceDef.handler(a, undefined)) as unknown

  const listProjectsDef = tool(
    'list_projects',
    '列出已注册的项目及当前项目。',
    {},
    async () => okText(JSON.stringify(deps.projects.list())),
  )
  handlers.list_projects = async (a) => (await listProjectsDef.handler(a, undefined)) as unknown

  const switchProjectDef = tool(
    'switch_project',
    '切换到指定项目别名。',
    { alias: z.string() },
    async ({ alias }) => okText(JSON.stringify(await deps.projects.switchTo(alias))),
  )
  handlers.switch_project = async (a) => (await switchProjectDef.handler(a, undefined)) as unknown

  const addProjectDef = tool(
    'add_project',
    '注册一个新项目（别名 + 绝对路径）。',
    { alias: z.string(), path: z.string() },
    async ({ alias, path }) => {
      await deps.projects.add(alias, path)
      return okText(JSON.stringify({ ok: true }))
    },
  )
  handlers.add_project = async (a) => (await addProjectDef.handler(a, undefined)) as unknown

  const removeProjectDef = tool(
    'remove_project',
    '移除一个已注册的项目。',
    { alias: z.string() },
    async ({ alias }) => {
      await deps.projects.remove(alias)
      return okText(JSON.stringify({ ok: true }))
    },
  )
  handlers.remove_project = async (a) => (await removeProjectDef.handler(a, undefined)) as unknown

  const config = createSdkMcpServer({
    name: 'wechat',
    version: '1.0.0',
    tools: [
      replyDef, editDef, setNameDef, sendFileDef, broadcastDef,
      shareDef, resurfaceDef,
      listProjectsDef, switchProjectDef, addProjectDef, removeProjectDef,
    ],
  })

  return { config, handlers }
}
```

- [ ] **Step 8.4: Run — pass**

```bash
bun run vitest run src/features/tools.test.ts
```
Expected: 4 passed.

- [ ] **Step 8.5: Commit**

```bash
git add src/features/tools.ts src/features/tools.test.ts
git commit -m "feat(features): createSdkMcpServer with 11 WeChat tools"
```

---

## Task 9: Single-instance lock (ported, TDD)

**Files:**
- Create: `src/daemon/single-instance.ts`
- Create: `src/daemon/single-instance.test.ts`

- [ ] **Step 9.1: Test**

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { acquireInstanceLock, releaseInstanceLock } from './single-instance'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'wcc-lock-'))
const pidPath = join(dir, 'server.pid')

afterEach(() => { releaseInstanceLock(pidPath) })

describe('single-instance', () => {
  it('acquires when no pid file exists', () => {
    const r = acquireInstanceLock(pidPath)
    expect(r.ok).toBe(true)
    expect(existsSync(pidPath)).toBe(true)
  })

  it('steals lock when pid file refers to dead process', () => {
    writeFileSync(pidPath, '999999999', 'utf8')
    const r = acquireInstanceLock(pidPath)
    expect(r.ok).toBe(true)
  })

  it('refuses when pid file refers to live process (self)', () => {
    writeFileSync(pidPath, String(process.pid), 'utf8')
    const r = acquireInstanceLock(pidPath)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/already running/i)
  })
})
```

- [ ] **Step 9.2: Run — fail, then implement**

```ts
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'

export type LockResult = { ok: true } | { ok: false; reason: string; pid: number }

export function acquireInstanceLock(pidPath: string): LockResult {
  if (existsSync(pidPath)) {
    try {
      const raw = readFileSync(pidPath, 'utf8').trim()
      const pid = Number(raw)
      if (Number.isFinite(pid) && pid > 0 && isAlive(pid)) {
        return { ok: false, reason: 'another daemon already running', pid }
      }
    } catch {}
  }
  writeFileSync(pidPath, String(process.pid), 'utf8')
  return { ok: true }
}

export function releaseInstanceLock(pidPath: string): void {
  try {
    const raw = readFileSync(pidPath, 'utf8').trim()
    if (Number(raw) === process.pid) unlinkSync(pidPath)
  } catch {}
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
```

- [ ] **Step 9.3: Run — pass, commit**

```bash
bun run vitest run src/daemon/single-instance.test.ts
git add src/daemon/single-instance.ts src/daemon/single-instance.test.ts
git commit -m "feat(daemon): single-instance lockfile (process.kill probe)"
```

---

## Task 10: `daemon/main.ts` — wiring entry point (integration-shaped tests)

This task is larger; break into two sub-commits.

**Files:**
- Create: `src/daemon/main.ts`
- Create: `src/daemon/bootstrap.ts` (extract for unit testing)
- Create: `src/daemon/bootstrap.test.ts`

**Testability note**: to avoid reaching into private fields, `buildBootstrap` also returns the raw `sdkOptionsForProject` function so tests can invoke it directly. Final `Bootstrap` interface:

```ts
export interface Bootstrap {
  sessionManager: SessionManager
  resolve: (chatId: string) => { alias: string; path: string } | null
  formatInbound: typeof formatInbound
  sdkOptionsForProject: (alias: string, path: string) => Options  // exposed for tests
}
```

- [ ] **Step 10.1: Test — bootstrap wires all parts without starting I/O**

`src/daemon/bootstrap.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { buildBootstrap } from './bootstrap'

function makeIlinkStub() {
  return {
    sendMessage: vi.fn(),
    sendFile: vi.fn(),
    editMessage: vi.fn(),
    broadcast: vi.fn(),
    sharePage: vi.fn(),
    resurfacePage: vi.fn(),
    setUserName: vi.fn(),
    projects: { list: () => [], switchTo: vi.fn(), add: vi.fn(), remove: vi.fn() },
    askUser: vi.fn(),
  }
}

describe('bootstrap', () => {
  it('sdkOptionsForProject returns cwd, wechat mcpServer, canUseTool, systemPrompt', () => {
    const b = buildBootstrap({
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
      lastActiveChatId: () => 'chat-1',
      log: () => {},
    })
    const opts = b.sdkOptionsForProject('P', '/p')
    expect(opts.cwd).toBe('/p')
    expect(opts.mcpServers).toBeDefined()
    expect(opts.mcpServers!['wechat']).toBeDefined()
    expect(opts.mcpServers!['wechat'].type).toBe('sdk')
    expect(typeof opts.canUseTool).toBe('function')
    expect(typeof opts.systemPrompt === 'string' || Array.isArray(opts.systemPrompt)).toBe(true)
  })

  it('resolve uses projects.current', () => {
    const b = buildBootstrap({
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
      lastActiveChatId: () => null,
      log: () => {},
    })
    expect(b.resolve('anyone')).toEqual({ alias: 'P', path: '/p' })
  })
})
```

- [ ] **Step 10.2: Run — fail**

- [ ] **Step 10.3: Implement `bootstrap.ts`**

```ts
import { SessionManager } from '../core/session-manager'
import { makeResolver } from '../core/project-resolver'
import { makeCanUseTool } from '../core/permission-relay'
import { formatInbound } from '../core/prompt-format'
import { buildWechatMcpServer, type ToolDeps } from '../features/tools'
import type { Options } from '@anthropic-ai/claude-agent-sdk'

export interface BootstrapDeps {
  stateDir: string
  ilink: {
    sendMessage: (chatId: string, text: string) => Promise<{ msgId: string }>
    sendFile: (chatId: string, path: string) => Promise<void>
    editMessage: (chatId: string, msgId: string, text: string) => Promise<void>
    broadcast: (text: string, accountId?: string) => Promise<{ ok: number; failed: number }>
    sharePage: (title: string, content: string) => Promise<{ url: string; slug: string }>
    resurfacePage: (q: { slug?: string; title_fragment?: string }) => Promise<{ url: string; slug: string } | null>
    setUserName: (chatId: string, name: string) => Promise<void>
    projects: ToolDeps['projects']
    askUser: (chatId: string, prompt: string, hash: string, timeoutMs: number) => Promise<'allow'|'deny'|'timeout'>
  }
  loadProjects: () => { projects: Record<string, { path: string; last_active: number }>; current: string | null }
  lastActiveChatId: () => string | null
  log: (tag: string, line: string) => void
}

export interface Bootstrap {
  sessionManager: SessionManager
  resolve: (chatId: string) => { alias: string; path: string } | null
  formatInbound: typeof formatInbound
}

const CHANNEL_SYSTEM_PROMPT = `你在 wechat-cc 的消息通道里接收来自作者个人微信的消息。规则：
- 每条入站消息用 <wechat chat_id="..." user="..." account="..." msg_type="..." ts="...">...</wechat> 包裹。回复时用 reply 工具（不要直接生成文本）。
- chat_id 是路由键；多条连续对话可能来自同一个 chat_id。
- 媒体附件以 [image:/abs/path] [file:/abs/path] [voice:/abs/path] 行内标注，用 Read/Bash 等工具打开或分析它们。
- /project 相关意图可以调 list_projects / switch_project / add_project / remove_project。
- 用户是个人开发者，偏好简短直接的中文回复。`

export function buildBootstrap(deps: BootstrapDeps): Bootstrap {
  const resolve = makeResolver({ loadProjects: deps.loadProjects })
  const toolDeps: ToolDeps = {
    sendReply: deps.ilink.sendMessage,
    sendFile: deps.ilink.sendFile,
    editMessage: deps.ilink.editMessage,
    broadcast: deps.ilink.broadcast,
    sharePage: deps.ilink.sharePage,
    resurfacePage: deps.ilink.resurfacePage,
    setUserName: deps.ilink.setUserName,
    projects: deps.ilink.projects,
  }
  const mcp = buildWechatMcpServer(toolDeps)
  const canUseTool = makeCanUseTool({
    askUser: deps.ilink.askUser,
    defaultChatId: () => deps.lastActiveChatId(),
    log: deps.log,
  })

  const sdkOptionsForProject = (_alias: string, path: string): Options => ({
    cwd: path,
    permissionMode: 'default',
    canUseTool,
    mcpServers: { wechat: mcp.config },
    systemPrompt: CHANNEL_SYSTEM_PROMPT,
    settingSources: ['user', 'project', 'local'],
  })

  const sessionManager = new SessionManager({
    maxConcurrent: 6,
    idleEvictMs: 30 * 60_000,
    sdkOptionsForProject,
  })

  return {
    sessionManager,
    resolve,
    formatInbound,
    sdkOptionsForProject,
  }
}
```

- [ ] **Step 10.4: Run — pass**

Expected test passes. If `.opts` is private, expose it via a getter for testability OR assert on behavior (acquire + check `fakeQuery` call args); the private-access `['opts']` in the test works at runtime in TS.

- [ ] **Step 10.5: Create `src/daemon/main.ts` (wires real ilink + accounts loader)**

```ts
#!/usr/bin/env bun
import { acquireInstanceLock, releaseInstanceLock } from './single-instance'
import { buildBootstrap } from './bootstrap'
import { routeInbound } from '../core/message-router'
import { loadAllAccounts, startLongPollLoops, makeIlinkAdapter } from './ilink-glue'
import { log } from '../../log'
import { join } from 'node:path'
import { homedir } from 'node:os'

const STATE_DIR = join(homedir(), '.claude', 'channels', 'wechat')
const PID_PATH = join(STATE_DIR, 'server.pid')

async function main() {
  const lock = acquireInstanceLock(PID_PATH)
  if (!lock.ok) {
    console.error(`[wechat-cc] ${lock.reason} (pid=${lock.pid}). Exiting.`)
    process.exit(1)
  }

  const accounts = await loadAllAccounts(STATE_DIR)
  if (accounts.length === 0) {
    console.error('[wechat-cc] no accounts bound. Run `wechat-cc setup` first.')
    releaseInstanceLock(PID_PATH)
    process.exit(1)
  }

  const ilink = makeIlinkAdapter({ stateDir: STATE_DIR, accounts })
  const { sessionManager, resolve, formatInbound } = buildBootstrap({
    stateDir: STATE_DIR,
    ilink,
    loadProjects: ilink.loadProjects,
    lastActiveChatId: ilink.lastActiveChatId,
    log: (tag, line) => log(tag, line),
  })

  const stopPolling = startLongPollLoops({
    accounts,
    onInbound: (msg) => routeInbound({
      resolveProject: resolve,
      manager: sessionManager,
      format: formatInbound,
      log: (tag, line) => log(tag, line),
    }, msg),
  })

  const shutdown = async () => {
    log('DAEMON', 'shutdown initiated')
    await stopPolling()
    await sessionManager.shutdown()
    await ilink.flush()
    releaseInstanceLock(PID_PATH)
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  log('DAEMON', `started pid=${process.pid} accounts=${accounts.length}`)
}

main().catch((err) => {
  console.error('[wechat-cc] fatal:', err)
  releaseInstanceLock(PID_PATH)
  process.exit(1)
})
```

**Note:** `./ilink-glue` is the adapter that re-uses existing `ilink.ts`, `send-reply.ts`, `project-registry.ts`, `docs.ts`, `access.ts`, `handoff.ts` modules from repo root. Built in the next task.

- [ ] **Step 10.6: Commit (bootstrap only; main.ts won't run yet without ilink-glue)**

```bash
git add src/daemon/bootstrap.ts src/daemon/bootstrap.test.ts src/daemon/main.ts
git commit -m "feat(daemon): bootstrap wiring + main entry skeleton"
```

---

## Task 11: `ilink-glue.ts` — adapt existing modules to daemon interfaces

This is the glue that maps the root-level files (`ilink.ts`, `send-reply.ts`, `docs.ts`, `project-registry.ts`, `access.ts`, `handoff.ts`, context/user name/account-id stores) to the shapes `bootstrap.ts` expects. Mostly plumbing; minimal new logic.

**Files:**
- Create: `src/daemon/ilink-glue.ts`
- Create: `src/daemon/ilink-glue.test.ts`

- [ ] **Step 11.1: Test — loadAllAccounts reads from accounts/ dir**

```ts
import { describe, it, expect } from 'vitest'
import { loadAllAccounts } from './ilink-glue'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('loadAllAccounts', () => {
  it('reads each subdir under accounts/ as an account', async () => {
    const state = mkdtempSync(join(tmpdir(), 'wcc-state-'))
    const acct = join(state, 'accounts', 'A1')
    mkdirSync(acct, { recursive: true })
    writeFileSync(join(acct, 'account.json'), JSON.stringify({ botId: 'b', userId: 'u', baseUrl: 'https://x' }))
    writeFileSync(join(acct, 'token'), 'TOKEN')
    const accts = await loadAllAccounts(state)
    expect(accts).toHaveLength(1)
    expect(accts[0]!.id).toBe('A1')
    expect(accts[0]!.token).toBe('TOKEN')
  })
})
```

- [ ] **Step 11.2: Run — fail**

- [ ] **Step 11.3: Implement**

```ts
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  ilinkGetUpdates, ilinkSendMessage, ilinkSendTyping,
  botTextMessage, type GetUpdatesResp,
} from '../../ilink'
import { sendReplyOnce, chunk } from '../../send-reply'
import { sharePage as docsShare, resurfacePage as docsResurface } from '../../docs'
import {
  addProject as registryAdd, listProjects as registryList, setCurrent as registrySetCurrent,
  removeProject as registryRemove,
} from '../../project-registry'
import type { InboundMsg } from '../core/prompt-format'

export interface Account { id: string; botId: string; userId: string; baseUrl: string; token: string; syncBuf: string }

export async function loadAllAccounts(stateDir: string): Promise<Account[]> {
  const dir = join(stateDir, 'accounts')
  if (!existsSync(dir)) return []
  const out: Account[] = []
  for (const id of readdirSync(dir)) {
    const acctDir = join(dir, id)
    const metaPath = join(acctDir, 'account.json')
    const tokenPath = join(acctDir, 'token')
    if (!existsSync(metaPath) || !existsSync(tokenPath)) continue
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    const token = readFileSync(tokenPath, 'utf8').trim()
    const syncBufPath = join(acctDir, 'sync_buf')
    const syncBuf = existsSync(syncBufPath) ? readFileSync(syncBufPath, 'utf8').trim() : ''
    out.push({ id, botId: meta.botId, userId: meta.userId, baseUrl: meta.baseUrl, token, syncBuf })
  }
  return out
}

// makeIlinkAdapter + startLongPollLoops: see full signatures below.
// These are ~200-line implementations that port server.ts pollLoop + handleInbound
// into adapter form. Key responsibilities:
//   - startLongPollLoops runs one ilinkGetUpdates loop per account, parses
//     messages, downloads media to inbox/, normalizes into InboundMsg, calls onInbound.
//   - makeIlinkAdapter exposes {sendMessage, sendFile, editMessage, broadcast,
//     sharePage, resurfacePage, setUserName, projects, askUser, loadProjects,
//     lastActiveChatId, flush}.
//   - askUser: registers a pending-permission entry keyed by hash, waits on a
//     Promise that resolves when pollLoop sees a 'y <hash>' or 'n <hash>' in an
//     incoming message.
//   - flush: persists context_tokens / user_names / user_account_ids before exit.

export interface IlinkAdapter {
  sendMessage(chatId: string, text: string): Promise<{ msgId: string }>
  sendFile(chatId: string, path: string): Promise<void>
  editMessage(chatId: string, msgId: string, text: string): Promise<void>
  broadcast(text: string, accountId?: string): Promise<{ ok: number; failed: number }>
  sharePage(title: string, content: string): Promise<{ url: string; slug: string }>
  resurfacePage(q: { slug?: string; title_fragment?: string }): Promise<{ url: string; slug: string } | null>
  setUserName(chatId: string, name: string): Promise<void>
  projects: {
    list(): { alias: string; path: string; current: boolean }[]
    switchTo(alias: string): Promise<{ ok: true; path: string } | { ok: false; reason: string }>
    add(alias: string, path: string): Promise<void>
    remove(alias: string): Promise<void>
  }
  askUser(chatId: string, prompt: string, hash: string, timeoutMs: number): Promise<'allow' | 'deny' | 'timeout'>
  loadProjects(): { projects: Record<string, { path: string; last_active: number }>; current: string | null }
  lastActiveChatId(): string | null
  flush(): Promise<void>
}

export function makeIlinkAdapter(opts: { stateDir: string; accounts: Account[] }): IlinkAdapter {
  // Implementation notes — write inline when doing this task:
  //   1. Load context_tokens.json / user_names.json / user_account_ids.json on
  //      startup into in-memory maps + debounced flushers (reuse pattern from
  //      server.ts:2220 — 3s debounce; flush on exit).
  //   2. sendMessage: reuse sendReplyOnce from ../../send-reply.ts.
  //   3. broadcast: iterate over known chat_ids from user_account_ids.json.
  //   4. sharePage/resurfacePage: delegate to docsShare/docsResurface from ../../docs.ts.
  //   5. projects.*: registryAdd/List/SetCurrent/Remove against
  //      join(stateDir, 'projects.json'); `current` in list is computed from the
  //      current field in that file.
  //   6. askUser: keep Map<string, { resolve: (v:'allow'|'deny')=>void, expiresAt:number }>
  //      keyed by hash. Send prompt to chatId via sendMessage. Return a Promise
  //      with setTimeout resolving to 'timeout' after timeoutMs.
  //   7. ilink poll loop resolves pending permissions when it sees PERMISSION_REPLY
  //      strict/bare patterns — copy regexes from server.ts:672-673.
  //   8. flush: persists all debounced state.
  throw new Error('TODO: implement following the notes above')
}

export function startLongPollLoops(opts: {
  accounts: Account[]
  onInbound: (msg: InboundMsg) => Promise<void>
}): () => Promise<void> {
  // Per-account: while(!stopped) { ilinkGetUpdates(...); for each msg: onInbound(); }
  // Return a stop function that flips a flag and awaits in-flight loops.
  throw new Error('TODO: implement per server.ts:2094-2166 pattern')
}
```

Step 11.4 is intentionally a sequence of sub-tasks because `makeIlinkAdapter` + `startLongPollLoops` port ~600 LOC from `server.ts`. Each sub-task is its own TDD cycle + commit.

- [ ] **Step 11.4a: Port state loaders (context_tokens, user_names, user_account_ids) with debounced writers**

Reference: `server.ts:496–548`, `2220–2231`.

Test first (`ilink-glue.test.ts`): given a tmp state dir with `context_tokens.json`, the adapter's `flush()` persists mutations and `get/set` round-trip. Then implement `makeStateStore(stateDir, filename)` returning `{ get(k), set(k, v), flush() }` with 3-second debounce; wire three of them into the adapter's private state.

Commit: `feat(daemon/glue): debounced JSON stores for context_tokens/user_names/user_account_ids`.

- [ ] **Step 11.4b: Port outbound wrappers — sendMessage, sendFile, editMessage, broadcast, setUserName**

Reference: `server.ts` CallTool handler branches (1328–1630) and `send-reply.ts`.

Test: mock `sendReplyOnce`; assert `sendMessage('c', 'hi')` calls it with the right account (resolved from `user_account_ids.json`). For `broadcast`, assert it iterates known chat_ids and aggregates `{ok, failed}`.

Commit: `feat(daemon/glue): outbound adapters wrapping send-reply + ilink`.

- [ ] **Step 11.4c: Port askUser + pending permissions registry**

Reference: `server.ts:672-673` regex, `server.ts:678-838` PendingPermission logic.

Extract PERMISSION_REPLY regexes verbatim. Implement a `PendingPermissions` Map keyed by 5-char hash. `askUser` adds an entry + sends the prompt via `sendMessage`, returns a Promise that resolves when `pollLoop` calls `consumePermissionReply(hash, 'allow'|'deny')` or when the timeout fires (then `delete` entry and resolve `'timeout'`). Also port the 1-hour TTL sweep (`prunePendingPermissions`).

Test: call `askUser`, verify `sendMessage` was called; call `consumePermissionReply(hash, 'allow')`, verify promise resolves to `'allow'`; call without consume, advance fake timers, verify `'timeout'`.

Commit: `feat(daemon/glue): askUser + pending permissions with y/n reply parsing`.

- [ ] **Step 11.4d: Port pollLoop per-account long-poll**

Reference: `server.ts:2094-2166`.

Signature of `startLongPollLoops({accounts, onInbound})`:
```ts
export function startLongPollLoops(opts: {
  accounts: Account[]
  onInbound: (msg: InboundMsg) => Promise<void>
  parseUpdates: (raw: GetUpdatesResp, account: Account) => InboundMsg[]
}): () => Promise<void> {
  const stopped = { flag: false }
  const loops: Promise<void>[] = []
  for (const acct of opts.accounts) {
    loops.push((async () => {
      let buf = acct.syncBuf
      while (!stopped.flag) {
        try {
          const raw = await ilinkGetUpdates(acct.baseUrl, acct.token, buf)
          buf = raw.sync_buf ?? buf
          for (const m of opts.parseUpdates(raw, acct)) {
            if (stopped.flag) break
            await opts.onInbound(m).catch(e => console.error('[onInbound]', e))
          }
        } catch (err) {
          if (stopped.flag) break
          await backoff()
        }
      }
    })())
  }
  return async () => { stopped.flag = true; await Promise.all(loops) }
}
async function backoff() { await new Promise(r => setTimeout(r, 2_000)) }
```

Test: inject a fake `ilinkGetUpdates` that returns 2 messages; inject `parseUpdates` that returns them verbatim; run 50ms; assert `onInbound` called twice; call stop; assert loop ends.

Commit: `feat(daemon/glue): startLongPollLoops per-account with stop signal`.

- [ ] **Step 11.4e: Port inbound parsing — parseUpdates (handleInbound surface)**

Reference: `server.ts:1642-2087` is the monster function. Most of its body writes MCP notifications — **delete that path**. Keep only the normalization: raw ilink message → `InboundMsg`. Port media handling to a helper `materializeMedia(msg, accountStateDir) → attachments[]` that downloads CDN assets to `inbox/` (reuse `downloadCdnMedia` + `saveToInbox` from server.ts:232-273 — these are pure functions, copy verbatim into `src/daemon/media.ts`).

Test: given a fixture WeixinMessage of `msg_type='text'`, `parseUpdates` returns `[{text: '...', attachments: []}]`. Given `msg_type='image'` with an encrypted CDN ref, it returns attachments with a local inbox path.

Commit: `feat(daemon/glue): parseUpdates + media materialization`.

- [ ] **Step 11.4f: Wire it all — makeIlinkAdapter returns a fully-functional adapter**

Replace the `throw new Error('TODO')` in `makeIlinkAdapter` with the composition:
```ts
export function makeIlinkAdapter(opts: { stateDir: string; accounts: Account[] }): IlinkAdapter {
  const ctxStore = makeStateStore(opts.stateDir, 'context_tokens.json')
  const nameStore = makeStateStore(opts.stateDir, 'user_names.json')
  const acctStore = makeStateStore(opts.stateDir, 'user_account_ids.json')
  const pending = new PendingPermissions()
  // ... sendMessage, sendFile, ... (from 11.4b)
  // ... askUser (from 11.4c)
  // ... projects: registry* delegation
  // ... loadProjects: readFileSync(join(stateDir, 'projects.json'))
  // ... lastActiveChatId: scan ctxStore for most-recent entry
  // ... flush: Promise.all([ctxStore.flush(), nameStore.flush(), acctStore.flush()])
  return { /* wire all methods */ }
}
```

Test: integration-level — call `sendMessage`, `askUser`, verify behavior end-to-end against fake ilink HTTP.

Commit: `feat(daemon/glue): compose makeIlinkAdapter from sub-modules`.

- [ ] **Step 11.5: Run full suite — all tests pass**

```bash
bun run vitest run src/
```

- [ ] **Step 11.6: Final commit (if any tidying needed)**

```bash
git add -u && git commit -m "chore(daemon/glue): finalize ilink-glue" || echo "already clean"
```

---

## Task 12: Windows loopback fix in `docs.ts` (TDD)

From `E:\1\wechat-cc-deploy-notes.md` — `Bun.serve` currently binds 0.0.0.0; Windows firewall pops on first `share_page` call. 1-line fix.

**Files:**
- Modify: `docs.ts:320` (±3 lines depending on drift)
- Modify: `docs.test.ts`

- [ ] **Step 12.1: Add regression test**

In `docs.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

describe('docs.ts hardening', () => {
  it('Bun.serve binds to 127.0.0.1 (loopback only)', () => {
    const src = readFileSync(__dirname + '/docs.ts', 'utf8')
    const match = src.match(/Bun\.serve\(\s*\{[^}]*hostname:\s*['"]127\.0\.0\.1['"]/s)
    expect(match).not.toBeNull()
  })
})
```

- [ ] **Step 12.2: Run — fail**

```bash
bun run vitest run docs.test.ts
```
Expected: FAIL — no hostname set.

- [ ] **Step 12.3: Edit `docs.ts`**

Locate the `Bun.serve({ port: 0, ...` call (around line 320). Add `hostname: '127.0.0.1',` as the first key:
```ts
  const bunServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) { /* unchanged */ },
  })
```

- [ ] **Step 12.4: Run — pass**

```bash
bun run vitest run docs.test.ts
```

- [ ] **Step 12.5: Commit**

```bash
git add docs.ts docs.test.ts
git commit -m "fix(docs): bind Bun.serve to 127.0.0.1 to suppress Windows firewall prompt"
```

---

## Task 13: CLI rewrite — `wechat-cc run` just execs daemon

**Files:**
- Modify: `cli.ts` (heavily)
- Modify: `cli.test.ts` (rewrite)

- [ ] **Step 13.1: Write new CLI tests**

Replace `cli.test.ts` content:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseCliArgs } from './cli'

describe('cli.parseCliArgs', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('recognizes run subcommand', () => {
    expect(parseCliArgs(['run'])).toEqual({ cmd: 'run' })
  })
  it('recognizes setup subcommand', () => {
    expect(parseCliArgs(['setup'])).toEqual({ cmd: 'setup' })
  })
  it('recognizes install subcommand with --user', () => {
    expect(parseCliArgs(['install', '--user'])).toEqual({ cmd: 'install', userScope: true })
  })
  it('recognizes status/list/help', () => {
    expect(parseCliArgs(['status']).cmd).toBe('status')
    expect(parseCliArgs(['list']).cmd).toBe('list')
    expect(parseCliArgs(['--help']).cmd).toBe('help')
  })
  it('no longer accepts --fresh, --continue, --dangerously', () => {
    // Legacy flags: ignored silently (with deprecation warning written via opts.warn)
    const warn = vi.fn()
    const out = parseCliArgs(['run', '--fresh', '--dangerously'], { warn })
    expect(out).toEqual({ cmd: 'run' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('--fresh'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('--dangerously'))
  })
})
```

- [ ] **Step 13.2: Replace `cli.ts` implementation**

Reduce `cli.ts` to:
```ts
#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

export type CliArgs =
  | { cmd: 'run' }
  | { cmd: 'setup' }
  | { cmd: 'install'; userScope: boolean }
  | { cmd: 'status' }
  | { cmd: 'list' }
  | { cmd: 'help' }

export function parseCliArgs(argv: string[], opts?: { warn?: (m: string) => void }): CliArgs {
  const warn = opts?.warn ?? ((m: string) => console.warn(m))
  const [cmd, ...rest] = argv
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') return { cmd: 'help' }
  switch (cmd) {
    case 'run': {
      for (const a of rest) {
        if (a === '--fresh' || a === '--continue' || a === '--dangerously' ||
            a.startsWith('--mcp-config') || a === '--channels') {
          warn(`[wechat-cc] legacy flag ignored: ${a} (v1.0 daemon doesn't spawn claude)`)
        }
      }
      return { cmd: 'run' }
    }
    case 'setup': return { cmd: 'setup' }
    case 'install': return { cmd: 'install', userScope: rest.includes('--user') }
    case 'status': return { cmd: 'status' }
    case 'list': return { cmd: 'list' }
    default: return { cmd: 'help' }
  }
}

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2))
  const here = dirname(fileURLToPath(import.meta.url))
  const daemonPath = join(here, 'src', 'daemon', 'main.ts')
  switch (parsed.cmd) {
    case 'run': {
      const r = spawnSync(process.execPath, [daemonPath], { stdio: 'inherit' })
      process.exit(r.status ?? 1)
    }
    case 'setup': {
      const setupPath = join(here, 'setup.ts')
      const r = spawnSync(process.execPath, [setupPath], { stdio: 'inherit' })
      process.exit(r.status ?? 1)
    }
    case 'install': {
      const { install } = await import('./install-user-mcp')
      await install({ userScope: parsed.userScope })
      return
    }
    case 'status': case 'list': {
      // re-implement lightweight status / account list from state dir
      const { runStatus } = await import('./cli-status')
      await runStatus(parsed.cmd)
      return
    }
    case 'help': {
      console.log(HELP_TEXT)
      return
    }
  }
}

const HELP_TEXT = `wechat-cc — WeChat bridge for Claude Code (Agent SDK daemon)

Usage:
  wechat-cc setup       Scan QR + bind a WeChat bot
  wechat-cc run         Start the daemon (foreground)
  wechat-cc install [--user]   Register the MCP plugin entry for claude
  wechat-cc status      Show daemon status + accounts
  wechat-cc list        List bound accounts
`

if (import.meta.main) main().catch(e => { console.error(e); process.exit(1) })
```

Create `cli-status.ts` if it doesn't exist; factor status/list helpers out of the old cli.ts.

- [ ] **Step 13.3: Run CLI tests — pass**

```bash
bun run vitest run cli.test.ts
```

- [ ] **Step 13.4: Smoke-test in a shell (not executed automatically — record output)**

```bash
bun cli.ts --help
bun cli.ts status 2>&1 | head -20
```
Expected: help text prints; status succeeds even if no accounts.

- [ ] **Step 13.5: Commit**

```bash
git add cli.ts cli.test.ts cli-status.ts
git commit -m "refactor(cli): run subcommand execs daemon directly (no supervisor loop)"
```

---

## Task 14: Delete legacy code

Now `cli.ts` is a thin shim and `src/daemon/main.ts` owns the runtime. Delete the MCP-Channel server and all its support code.

**Files to delete:**
- `server.ts`
- `start-channel.sh`
- `.mcp.json` (root)

**Files to check and clean:**
- `.claude-plugin/` — if it only declares MCP Channel wiring, delete contents; if it exposes slash commands or skills, keep those and remove only MCP references
- `package.json` — update `scripts.start`; drop `bin` if needed (keep `wechat-cc`)

- [ ] **Step 14.1: Verify no imports from server.ts outside itself**

```bash
grep -n "from './server'" --include='*.ts' -r .
grep -n 'import.*server\.ts' --include='*.ts' -r .
```
Expected: no hits. (If any show, fix first.)

- [ ] **Step 14.2: Delete**

```bash
git rm server.ts start-channel.sh .mcp.json
```

- [ ] **Step 14.3: Update `package.json`**

```json
  "scripts": {
    "start": "bun install --no-summary && bun src/daemon/main.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
```

- [ ] **Step 14.4: Review `.claude-plugin/`**

```bash
ls .claude-plugin/
cat .claude-plugin/*.json 2>/dev/null | head -40
```

If it defines an MCP server entry for `wechat`, remove it. If it registers slash commands (e.g. `/wechat:share`), leave those but mark them deferred to Phase 2 (edit comment).

Commit:
```bash
git add .claude-plugin/ package.json
git commit -m "chore: drop server.ts + start-channel.sh + committed .mcp.json"
```

- [ ] **Step 14.5: Run full typecheck + test suite**

```bash
bun tsc --noEmit 2>&1 | tee /tmp/tsc.out | head -40
bun run vitest run
```
Expected: zero TS errors from project sources (vendor `skipLibCheck: true`); all tests green.

If TS errors remain, fix before moving on. Typical surviving references: old imports in `cli-status.ts` / `setup.ts` pointing at `server.ts` — replace with equivalents from `src/daemon/`.

---

## Task 15: Prune obsolete tests

Files that tested MCP-channel mechanics are now dead.

- [ ] **Step 15.1: Scan**

```bash
grep -l 'readRestartFlag\|hasClaudeSessionIn\|\.restart-flag\|dangerously-load-development-channels\|buildClaudeArgs' -r . --include='*.ts' 2>/dev/null
```

- [ ] **Step 15.2: For each hit**

- If it's a test file asserting those behaviors: delete the test cases or the whole file.
- If it's production code (shouldn't be after Task 14): remove or fix.

- [ ] **Step 15.3: Run `vitest run` — no dangling imports**

```bash
bun run vitest run
```
Expected: green.

- [ ] **Step 15.4: Commit**

```bash
git add -u
git commit -m "test: drop MCP-Channel-era test cases"
```

---

## Task 16: Windows end-to-end zero-dialog verification

**Goal**: prove the RFC's C2 constraint holds under the rebuild.

**Files:** none (runtime verification)

- [ ] **Step 16.1: Preflight cleanup**

```powershell
Get-Process bun -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item "$env:USERPROFILE\.claude\channels\wechat\.restart-flag" -Force -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\.claude\channels\wechat\.restart-ack" -Force -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\.claude\channels\wechat\server.pid" -Force -ErrorAction SilentlyContinue
```

- [ ] **Step 16.2: Run the daemon**

```powershell
cd $env:USERPROFILE\.claude\plugins\local\wechat
bun cli.ts run
```

Expected observable behavior:
- No Windows security popup (Bun firewall) — because `docs.ts` now binds loopback.
- No Claude Code `--dangerously-load-development-channels` confirmation dialog — daemon doesn't spawn claude at all until a message arrives; then it uses Agent SDK headless.
- No workspace-trust prompt when the first message arrives (Spike 1 PASS suggests SDK skips it; if this fails, record as a finding).

- [ ] **Step 16.3: Send a test message in WeChat**

From the bound WeChat account: send `hello`.

Expected logs in `channel.log`:
```
[DAEMON] started pid=... accounts=...
[ROUTER] route chat=... → project=... path=...
[SDK] spawn session alias=... pid=...
[SDK] assistant_text: "..."
```
Expected in WeChat: a reply from the bot. No dialog appeared.

- [ ] **Step 16.4: `/restart` check — verify the death loop is gone**

Send `/restart` from WeChat.

Expected:
- Daemon **ignores `/restart` at the Claude layer** (no more restart flag). If you want the user-level semantic "clear my session and start fresh" preserved, this maps to: daemon aborts current session, removes it from pool, next message re-spawns with `--continue=false` (or simply a new session). Confirm whether this maps to a tool (`restart_session`) or is removed. **RFC §7 Phase 1 says delete `.restart-flag` — accept that `/restart` stops working in v1.0; document in release notes.**

- [ ] **Step 16.5: `/project switch <alias>` check**

Send `/project switch other-alias`. Expected: Claude calls `switch_project` tool, daemon updates `projects.json` current, next message routes to the new project's session (lazy spawned).

- [ ] **Step 16.6: Record results in `docs/plans/2026-04-21-phase1-core-rebuild.md` appendix**

Add an **"E2E verification"** section with: OS/Bun/SDK versions, exact dialogs observed (should be zero), any findings.

- [ ] **Step 16.7: Commit verification notes**

```bash
git add docs/plans/2026-04-21-phase1-core-rebuild.md
git commit -m "docs(plan): record Windows E2E verification results"
```

---

## Task 17: README sync

From deploy notes 🔴 items:
- `%USERPROFILE%` → `$env:USERPROFILE` in PowerShell examples
- Prerequisites: add Git (and winget hint)
- Remove MCP-Channel / `--dangerously-load-development-channels` references
- Quick Start: update to `setup` → `run` (no install step needed for plugin-dir installs)
- Uninstall PowerShell: add `-Recurse -Force`
- `/help` listing: add `/project *` subcommands (if any `/help` is still rendered by the daemon; otherwise remove the section)

**Files:** `README.md`, `README.zh.md`

- [ ] **Step 17.1: Diff-by-section review** — load the current README, walk the numbered issues from deploy notes top-to-bottom, apply each. Keep one commit per issue group so they are easy to cherry-pick.

- [ ] **Step 17.2: Add a "What changed in v1.0" section** at the top:

```markdown
## v1.0 — Agent SDK rebuild

wechat-cc is now a single-process Bun daemon using `@anthropic-ai/claude-agent-sdk`.
It no longer registers as a Claude Code MCP Channel — no more `--dangerously-load-development-channels`
dialog, no `.restart-flag` death loops on Windows, and `/restart` from WeChat has been removed
in favor of `/project switch`.

Upgrade from 0.x: run `bun install` in the plugin dir, then `wechat-cc run`. No setup re-run needed.
```

- [ ] **Step 17.3: Commit**

```bash
git add README.md README.zh.md
git commit -m "docs: README update for v1.0 Agent SDK rebuild"
```

---

## Task 18: Version bump + release candidate

**Files:** `package.json`, `docs/releases/2026-04-21.md` (new entry)

- [ ] **Step 18.1: Update version**

```json
  "version": "1.0.0-rc.1",
```

- [ ] **Step 18.2: Write release notes**

Create `docs/releases/2026-04-21.md`:
```markdown
# v1.0.0-rc.1 (2026-04-21)

## Highlights

- **Architecture rebuild**: MCP Channel plugin → Bun daemon + Claude Agent SDK. See `docs/rfc/01-architecture.md`.
- **Zero-dialog on Windows**: no more dev-channel confirmation, no workspace-trust popup, no firewall popup from `share_page`.
- **Multi-project session pool**: each project is a long-lived Agent SDK session, LRU eviction when >6 concurrent.
- **Tools unchanged from the user's perspective**: `reply`, `share_page`, `/project *`, `broadcast`, `send_file`, etc.

## Breaking

- `/restart` from WeChat is removed (death-loop root cause). Use `/project switch` or restart the daemon process.
- `wechat-cc run --fresh/--continue/--dangerously` flags ignored (warning logged). Sessions resume per-project automatically.
- `.mcp.json` in repo deleted. Plugin-system users: Claude Code no longer auto-registers wechat as a channel; run `wechat-cc install --user` if you need the MCP entry for the plugin control-plane tools (Phase 2).

## Internal

- Deletes `server.ts` (2325 LOC), `start-channel.sh`, `.mcp.json`.
- New `src/` tree: `core/`, `features/`, `daemon/`.
- State files preserved: `accounts/`, `projects.json`, `context_tokens.json`, `user_names.json`, `user_account_ids.json`, `access.json`.

## Known

- Workspace-trust dialog may still appear on *first* claude spawn per new project dir. Verified: Agent SDK headless does not prompt on re-entries. Track in Phase 2 if it's a real Windows issue.
- `/wechat:*` slash commands (plugin control plane) deferred to Phase 2.
```

- [ ] **Step 18.3: Commit**

```bash
git add package.json docs/releases/2026-04-21.md
git commit -m "chore: bump 1.0.0-rc.1"
```

- [ ] **Step 18.4: Tag (do NOT push — user decides)**

```bash
git tag -a v1.0.0-rc.1 -m "v1.0.0-rc.1 — Agent SDK rebuild"
```

---

## Post-Plan: Phase 0 outstanding spikes

Spikes 2 (session pool overhead) and 3 (permission callback coverage) were absorbed into Phase 1 Tasks 1–3 and 7. Spike 4 (ilink voice outbound) remains for Phase 2 and is NOT in scope here.

---

## Appendix: Open questions flagged during planning

1. **Does Agent SDK's headless path trigger the Claude Code workspace-trust dialog on a *new* cwd?** Spike 1 ran in its own dir — inconclusive. Validate in Task 16; if yes, work around by pre-touching `~/.claude/settings/trustedWorkspaces.json` in the daemon startup.
2. **`McpSdkServerConfigWithInstance` instance lifecycle** — is one instance reused across all projects' `query()` calls, or does each `query()` need its own? Current plan reuses one instance (built once at bootstrap); verify during Task 10.
3. **`canUseTool` signal cancellation** — when a session is evicted, the `AbortController.signal` fires mid-permission-prompt. Ensure `permission-relay.ts` bails gracefully (return `{behavior:'deny'}` and log, don't throw).
4. **`setMcpServers` dynamic registration** — the SDK exposes `setMcpServers` on a running `Query` (sdk.d.ts:2053). We don't use it in Phase 1; call out if Phase 2 needs it for runtime project onboarding.

These become tasks/issues during execution, not blockers for plan approval.

---

## Appendix: E2E verification log (filled in during Task 16)

_To be written during execution._
