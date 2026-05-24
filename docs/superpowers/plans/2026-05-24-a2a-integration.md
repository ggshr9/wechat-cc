# A2A Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Always run `bun run test` (NOT `bun test`) — the latter is Bun's built-in runner and ignores vitest excludes.

**Goal:** Make wechat-cc an A2A-protocol-aware node — both an A2A server (registered external agents can notify the operator via WeChat) and an A2A client (claude/codex/cursor can call back to those agents via a new MCP tool `a2a_send`).

**Architecture:** Two surfaces, both stateless from a correlation perspective. Inbound `notify` lands as a `[A2A:<id>]`-prefixed message in operator's chat (using existing `sendAssistantText` infrastructure). Outbound replies are mediated by claude/codex via the MCP tool — no pending-state machine, no ID prefixes, no transient modes. Pre-registered agents only (`agent-config.json:a2a_agents`); operator installs via `wechat-cc agent add <url>` (CLI, Phase 1) or dashboard (Phase 2).

**Tech Stack:** TypeScript, Bun, Bun.serve for the HTTP listener, fetch for outbound, vitest. Builds on `docs/superpowers/specs/2026-05-24-a2a-integration-design.md`.

**Phase boundaries:**
- **Phase 1 (Tasks 1-7)**: plumbing — server, client, registry, MCP tool, CLI. Functional end-to-end via CLI.
- **Phase 2 (Tasks 8-10)**: dashboard — internal-api endpoints + UI + playwright. Operator-friendly install flow.

---

## Phase 1 — Plumbing

### Task 1: agent-config schema + DB migration v12

**Files:**
- Modify: `src/lib/agent-config.ts` (add zod schema fields)
- Modify: `src/lib/db.ts` (append v12 migration)
- Test: `src/lib/agent-config.test.ts`
- Test: `src/lib/db.test.ts`

- [ ] **Step 1: Write the failing config test**

Append to `src/lib/agent-config.test.ts`:

```ts
describe('agent-config — A2A fields', () => {
  it('accepts a config with a2a_listen and a2a_agents', () => {
    const cfg = parseAgentConfig({
      provider: 'claude',
      a2a_listen: { host: '127.0.0.1', port: 8717 },
      a2a_agents: [
        { id: 'deploy-bot', name: 'Deploy Bot', url: 'https://deploy.example.com/a2a',
          inbound_api_key: 'wc_abc', outbound_api_key: 'dpb_xyz',
          capabilities: ['notify'], paused: false },
      ],
    })
    expect(cfg.a2a_listen?.port).toBe(8717)
    expect(cfg.a2a_agents).toHaveLength(1)
    expect(cfg.a2a_agents?.[0]?.id).toBe('deploy-bot')
  })

  it('accepts config without A2A fields (backward compat)', () => {
    const cfg = parseAgentConfig({ provider: 'claude' })
    expect(cfg.a2a_listen).toBeUndefined()
    expect(cfg.a2a_agents).toBeUndefined()
  })

  it('rejects duplicate agent ids', () => {
    expect(() => parseAgentConfig({
      provider: 'claude',
      a2a_agents: [
        { id: 'x', name: 'X', url: 'https://a/a2a', inbound_api_key: 'k1', outbound_api_key: 'k2', capabilities: ['notify'], paused: false },
        { id: 'x', name: 'X2', url: 'https://b/a2a', inbound_api_key: 'k3', outbound_api_key: 'k4', capabilities: ['notify'], paused: false },
      ],
    })).toThrow(/duplicate a2a agent id/)
  })

  it('rejects invalid agent id (must be slug: lowercase alphanumeric + dash)', () => {
    expect(() => parseAgentConfig({
      provider: 'claude',
      a2a_agents: [{ id: 'Bad ID!', name: 'X', url: 'https://a/a2a',
        inbound_api_key: 'k', outbound_api_key: 'k', capabilities: ['notify'], paused: false }],
    })).toThrow(/agent id must match/)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test src/lib/agent-config.test.ts -t 'A2A fields'`
Expected: FAIL — schema doesn't have the new fields.

- [ ] **Step 3: Add schema fields**

In `src/lib/agent-config.ts`, near the existing `AgentConfigSchema` z.object definition, add a new `A2AAgentRecord` schema and the two top-level fields:

```ts
export const A2AAgentRecord = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'agent id must match ^[a-z0-9][a-z0-9-]{0,63}$ (lowercase slug)'),
  name: z.string().min(1).max(128),
  url: z.string().url(),
  inbound_api_key: z.string().min(16),
  outbound_api_key: z.string().min(1),
  capabilities: z.array(z.string()),
  paused: z.boolean().default(false),
})

export const A2AListen = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535),
})

// Extend the main config schema:
//   a2a_listen: A2AListen.optional(),
//   a2a_agents: z.array(A2AAgentRecord).optional()
//     .superRefine((arr, ctx) => {
//       const ids = new Set<string>()
//       for (const a of arr ?? []) {
//         if (ids.has(a.id)) ctx.addIssue({ code: 'custom', message: `duplicate a2a agent id: ${a.id}` })
//         ids.add(a.id)
//       }
//     }),

export type A2AAgentRecord = z.infer<typeof A2AAgentRecord>
export type A2AListen = z.infer<typeof A2AListen>
```

Add the two fields onto the existing top-level `AgentConfigSchema` z.object (locate it and merge). The `parseAgentConfig` helper that the tests use just needs the schema's `.parse()` to throw on bad input, which the regex + superRefine already arrange.

- [ ] **Step 4: Run config tests to pass**

Run: `bun run test src/lib/agent-config.test.ts`
Expected: PASS, all 4 new tests.

- [ ] **Step 5: Write the failing migration test**

Append to `src/lib/db.test.ts`:

```ts
describe('migration v12 — a2a_events table', () => {
  it('creates a2a_events table with expected columns', () => {
    const db = openDb({ path: ':memory:' })
    const cols = db.query<{ name: string }, []>(
      "SELECT name FROM pragma_table_info('a2a_events')"
    ).all()
    const names = cols.map(c => c.name).sort()
    expect(names).toEqual(['agent_id', 'direction', 'http_status', 'id', 'status', 'text', 'ts', 'urgency'])
  })

  it('PRAGMA user_version = 12 after v12', () => {
    const db = openDb({ path: ':memory:' })
    const v = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(v).toBe(12)
  })

  it('agent_ts index exists', () => {
    const db = openDb({ path: ':memory:' })
    const idx = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='a2a_events'"
    ).all()
    expect(idx.find(i => i.name === 'a2a_events_agent_ts')).toBeDefined()
  })
})
```

- [ ] **Step 6: Run to verify failure**

Run: `bun run test src/lib/db.test.ts -t 'migration v12'`
Expected: FAIL.

- [ ] **Step 7: Add migration v12**

Append after the v11 migration in `src/lib/db.ts`:

```ts
  // v12 — a2a_events: observability log for A2A inbound/outbound calls.
  // See docs/superpowers/specs/2026-05-24-a2a-integration-design.md.
  (db) => {
    db.exec(`
      CREATE TABLE a2a_events (
        id TEXT PRIMARY KEY NOT NULL,
        ts TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
        agent_id TEXT NOT NULL,
        text TEXT NOT NULL,
        urgency TEXT,
        status TEXT NOT NULL DEFAULT 'ok',
        http_status INTEGER
      ) STRICT;
      CREATE INDEX a2a_events_agent_ts ON a2a_events(agent_id, ts DESC);
    `)
  },
```

- [ ] **Step 8: Update state-migration assertion**

In `src/lib/state-migration.test.ts`, find the `PRAGMA user_version = 11` assertion (added in P3) and bump to 12 with table list updated:

```ts
  it('opens a fresh db with PRAGMA user_version = 12 and the 8 tables', () => {
    const v = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
    // v12 (A2A integration): a2a_events table added.
    expect(v).toBe(12)
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
    expect(tables.map(t => t.name)).toEqual([
      'a2a_events', 'activity', 'conversations', 'events', 'milestones', 'observations', 'session_state', 'sessions',
    ])
  })
```

- [ ] **Step 9: Run all affected tests**

Run: `bun run test src/lib/db.test.ts src/lib/state-migration.test.ts src/lib/agent-config.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/lib/agent-config.ts src/lib/agent-config.test.ts src/lib/db.ts src/lib/db.test.ts src/lib/state-migration.test.ts
git commit -m "feat(a2a): agent-config schema + DB migration v12 (a2a_events)"
```

---

### Task 2: a2a-registry module

**Files:**
- Create: `src/core/a2a-registry.ts`
- Create: `src/core/a2a-registry.test.ts`

The registry holds the in-memory copy of `agent-config.json:a2a_agents` plus operations to mutate that list and persist back. It's the source-of-truth surface that the server, client, and CLI all consume.

- [ ] **Step 1: Write the failing tests**

Create `src/core/a2a-registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { createA2ARegistry } from './a2a-registry'
import type { A2AAgentRecord } from '../lib/agent-config'

function makeTempStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'wechat-cc-a2a-test-'))
}

function writeConfig(stateDir: string, agents: A2AAgentRecord[]): void {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(
    join(stateDir, 'agent-config.json'),
    JSON.stringify({ provider: 'claude', a2a_agents: agents }, null, 2),
  )
}

function rec(id: string, overrides: Partial<A2AAgentRecord> = {}): A2AAgentRecord {
  return {
    id, name: id, url: `https://${id}.example.com/a2a`,
    inbound_api_key: `wc_${id}`, outbound_api_key: `out_${id}`,
    capabilities: ['notify'], paused: false, ...overrides,
  }
}

describe('a2a-registry', () => {
  it('loads existing agents from config file', () => {
    const stateDir = makeTempStateDir()
    writeConfig(stateDir, [rec('alpha'), rec('beta')])
    const reg = createA2ARegistry({ stateDir })
    expect(reg.list().map(a => a.id).sort()).toEqual(['alpha', 'beta'])
  })

  it('list() returns empty when config has no a2a_agents', () => {
    const stateDir = makeTempStateDir()
    writeConfig(stateDir, [])
    const reg = createA2ARegistry({ stateDir })
    expect(reg.list()).toEqual([])
  })

  it('get(id) returns the matching record', () => {
    const stateDir = makeTempStateDir()
    writeConfig(stateDir, [rec('alpha')])
    const reg = createA2ARegistry({ stateDir })
    expect(reg.get('alpha')?.url).toBe('https://alpha.example.com/a2a')
    expect(reg.get('missing')).toBeNull()
  })

  it('verifyBearer returns the agent on match, null on mismatch', () => {
    const stateDir = makeTempStateDir()
    writeConfig(stateDir, [rec('alpha')])
    const reg = createA2ARegistry({ stateDir })
    expect(reg.verifyBearer('alpha', 'wc_alpha')?.id).toBe('alpha')
    expect(reg.verifyBearer('alpha', 'wrong')).toBeNull()
    expect(reg.verifyBearer('missing', 'anything')).toBeNull()
  })

  it('add() persists a new agent and rejects duplicate id', () => {
    const stateDir = makeTempStateDir()
    writeConfig(stateDir, [])
    const reg = createA2ARegistry({ stateDir })
    reg.add(rec('alpha'))
    expect(reg.list().map(a => a.id)).toEqual(['alpha'])
    expect(() => reg.add(rec('alpha'))).toThrow(/already exists/)
    // Reload from disk to confirm persistence
    const reg2 = createA2ARegistry({ stateDir })
    expect(reg2.list().map(a => a.id)).toEqual(['alpha'])
  })

  it('remove() drops the agent and persists', () => {
    const stateDir = makeTempStateDir()
    writeConfig(stateDir, [rec('alpha'), rec('beta')])
    const reg = createA2ARegistry({ stateDir })
    reg.remove('alpha')
    expect(reg.list().map(a => a.id)).toEqual(['beta'])
    expect(() => reg.remove('missing')).toThrow(/not found/)
  })

  it('setPaused() flips the paused flag and persists', () => {
    const stateDir = makeTempStateDir()
    writeConfig(stateDir, [rec('alpha')])
    const reg = createA2ARegistry({ stateDir })
    reg.setPaused('alpha', true)
    expect(reg.get('alpha')?.paused).toBe(true)
    reg.setPaused('alpha', false)
    expect(reg.get('alpha')?.paused).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test src/core/a2a-registry.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the module**

Create `src/core/a2a-registry.ts`:

```ts
/**
 * A2A registry — source of truth for registered external A2A agents.
 *
 * Loads from agent-config.json:a2a_agents at construction; provides
 * read APIs (list/get/verifyBearer) for the server + client modules
 * and mutation APIs (add/remove/setPaused) for the CLI + dashboard.
 *
 * Mutations write back to agent-config.json synchronously (the file is
 * the source of truth — in-memory cache mirrors disk). Per-mutation
 * file rewrites are fine: a2a_agents changes are operator-driven, not
 * a hot path.
 *
 * See docs/superpowers/specs/2026-05-24-a2a-integration-design.md.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { A2AAgentRecord } from '../lib/agent-config'

export interface A2ARegistry {
  list(): readonly A2AAgentRecord[]
  get(id: string): A2AAgentRecord | null
  verifyBearer(agentId: string, bearer: string): A2AAgentRecord | null
  add(rec: A2AAgentRecord): void
  remove(id: string): void
  setPaused(id: string, paused: boolean): void
}

export interface A2ARegistryOpts {
  stateDir: string
}

export function createA2ARegistry(opts: A2ARegistryOpts): A2ARegistry {
  const configPath = join(opts.stateDir, 'agent-config.json')

  function loadAll(): A2AAgentRecord[] {
    if (!existsSync(configPath)) return []
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as { a2a_agents?: A2AAgentRecord[] }
      return raw.a2a_agents ?? []
    } catch {
      return []
    }
  }

  function persistAll(agents: A2AAgentRecord[]): void {
    // Read full config so we don't lose other top-level fields.
    let raw: Record<string, unknown> = {}
    if (existsSync(configPath)) {
      try {
        raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
      } catch {
        raw = {}
      }
    }
    raw.a2a_agents = agents
    writeFileSync(configPath, JSON.stringify(raw, null, 2))
  }

  let cache = loadAll()

  return {
    list: () => cache,
    get: (id) => cache.find(a => a.id === id) ?? null,
    verifyBearer: (agentId, bearer) => {
      const agent = cache.find(a => a.id === agentId)
      if (!agent) return null
      // Constant-time string compare to mitigate timing side-channels on key check.
      // For 16-byte hex keys the timing leak is theoretical but cheap to defend.
      if (!constantTimeEquals(agent.inbound_api_key, bearer)) return null
      return agent
    },
    add: (rec) => {
      if (cache.some(a => a.id === rec.id)) throw new Error(`a2a agent '${rec.id}' already exists`)
      cache = [...cache, rec]
      persistAll(cache)
    },
    remove: (id) => {
      if (!cache.some(a => a.id === id)) throw new Error(`a2a agent '${id}' not found`)
      cache = cache.filter(a => a.id !== id)
      persistAll(cache)
    },
    setPaused: (id, paused) => {
      const ix = cache.findIndex(a => a.id === id)
      if (ix < 0) throw new Error(`a2a agent '${id}' not found`)
      cache = cache.map((a, i) => i === ix ? { ...a, paused } : a)
      persistAll(cache)
    },
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
```

- [ ] **Step 4: Run tests to pass**

Run: `bun run test src/core/a2a-registry.test.ts`
Expected: PASS, all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/a2a-registry.ts src/core/a2a-registry.test.ts
git commit -m "feat(a2a): registry module — load/persist registered agents from agent-config.json"
```

---

### Task 3: a2a-client module — outbound HTTP

**Files:**
- Create: `src/core/a2a-client.ts`
- Create: `src/core/a2a-client.test.ts`

Pure HTTP client. Fetch Agent Card; POST notify (outbound from our side = "send a message to an external agent"). No knowledge of mode, MCP, or chat — just well-typed HTTP calls.

- [ ] **Step 1: Write failing tests**

Create `src/core/a2a-client.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { createA2AClient } from './a2a-client'

let fakeServer: ReturnType<typeof Bun.serve> | null = null
const requests: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = []

beforeAll(() => {
  fakeServer = Bun.serve({
    hostname: '127.0.0.1',  // memory: 'localhost' is IPv6-only on macOS
    port: 0,
    async fetch(req) {
      const body = req.method === 'POST' ? await req.text() : ''
      requests.push({
        url: req.url,
        method: req.method,
        headers: Object.fromEntries(req.headers.entries()),
        body,
      })
      const url = new URL(req.url)
      if (url.pathname === '/.well-known/agent.json') {
        return new Response(JSON.stringify({
          name: 'fake-agent', description: 'fake', version: '1',
          auth: { type: 'bearer', required: true },
          capabilities: [{ name: 'notify', endpoint: '/notify' }],
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.pathname === '/notify' || url.pathname === '/a2a/notify') {
        const auth = req.headers.get('authorization')
        if (!auth?.startsWith('Bearer ')) return new Response('unauthorized', { status: 401 })
        return new Response(JSON.stringify({ ok: true, received: true }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.pathname === '/error') return new Response('internal', { status: 500 })
      return new Response('not found', { status: 404 })
    },
  })
})

afterAll(() => {
  fakeServer?.stop()
})

function baseUrl(): string {
  return `http://127.0.0.1:${fakeServer!.port}`
}

describe('a2a-client', () => {
  it('fetchAgentCard returns the Agent Card metadata', async () => {
    const client = createA2AClient()
    const card = await client.fetchAgentCard(baseUrl())
    expect(card.name).toBe('fake-agent')
    expect(card.capabilities?.[0]?.name).toBe('notify')
  })

  it('fetchAgentCard rejects on 4xx/5xx', async () => {
    const client = createA2AClient()
    await expect(client.fetchAgentCard(`${baseUrl()}/error`)).rejects.toThrow()
  })

  it('send POSTs with Bearer auth and returns parsed result', async () => {
    requests.length = 0
    const client = createA2AClient()
    const r = await client.send({
      url: `${baseUrl()}/notify`,
      bearer: 'test-key',
      body: { text: 'hello', source: { agent_id: 'wechat-cc' } },
    })
    expect(r.ok).toBe(true)
    expect(r.http_status).toBe(200)
    const lastReq = requests[requests.length - 1]!
    expect(lastReq.headers.authorization).toBe('Bearer test-key')
    expect(JSON.parse(lastReq.body)).toEqual({ text: 'hello', source: { agent_id: 'wechat-cc' } })
  })

  it('send returns ok=false with http_status on 401', async () => {
    const client = createA2AClient()
    const r = await client.send({
      url: `${baseUrl()}/notify-not-real-endpoint-just-using-wrong-bearer`,
      bearer: '',  // no Bearer prefix → 401
      body: { text: 'x' },
    })
    expect(r.ok).toBe(false)
  })

  it('send returns ok=false on network error', async () => {
    const client = createA2AClient()
    const r = await client.send({
      url: 'http://127.0.0.1:1/never-listening',  // port 1 reserved → connection refused
      bearer: 'k',
      body: { text: 'x' },
    })
    expect(r.ok).toBe(false)
    expect(r.error).toBeDefined()
  })

  it('send applies timeout', async () => {
    // Set up a server that delays 200ms; client timeout 50ms.
    const slow = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      async fetch() {
        await new Promise(r => setTimeout(r, 200))
        return new Response('late')
      },
    })
    try {
      const client = createA2AClient({ timeoutMs: 50 })
      const r = await client.send({
        url: `http://127.0.0.1:${slow.port}/anything`,
        bearer: 'k',
        body: { text: 'x' },
      })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/timeout|aborted/i)
    } finally {
      slow.stop()
    }
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test src/core/a2a-client.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `src/core/a2a-client.ts`:

```ts
/**
 * A2A client — outbound HTTP calls to registered external A2A agents.
 *
 * Two operations:
 *   1. fetchAgentCard(baseUrl) → GET /.well-known/agent.json
 *      Used at install time to validate operator's input URL and let
 *      them see what the agent claims to expose.
 *   2. send({ url, bearer, body }) → POST any endpoint with Bearer auth
 *      Used by the a2a_send MCP tool to push messages out.
 *
 * Pure HTTP. No app logic, no registry awareness, no MCP knowledge.
 * Timeout-bounded (default 10s; configurable for tests).
 *
 * See docs/superpowers/specs/2026-05-24-a2a-integration-design.md.
 */

export interface AgentCard {
  name: string
  description?: string
  version?: string
  auth?: { type: string; required: boolean }
  capabilities?: Array<{
    name: string
    description?: string
    endpoint?: string
    method?: string
    request_schema?: unknown
  }>
}

export interface SendRequest {
  url: string
  bearer: string
  body: unknown
}

export interface SendResult {
  ok: boolean
  http_status?: number
  response?: unknown
  error?: string
}

export interface A2AClientOpts {
  timeoutMs?: number
}

export interface A2AClient {
  fetchAgentCard(baseUrl: string): Promise<AgentCard>
  send(req: SendRequest): Promise<SendResult>
}

export function createA2AClient(opts: A2AClientOpts = {}): A2AClient {
  const timeoutMs = opts.timeoutMs ?? 10_000

  async function withTimeout<T>(p: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs)
    try { return await p(ac.signal) }
    finally { clearTimeout(t) }
  }

  return {
    async fetchAgentCard(baseUrl) {
      // Try /.well-known/agent.json first; fall back to baseUrl itself if it
      // already ends in agent.json (operator may have pasted the full path).
      const cardUrl = baseUrl.endsWith('agent.json')
        ? baseUrl
        : `${baseUrl.replace(/\/+$/, '')}/.well-known/agent.json`
      return withTimeout(async (signal) => {
        const res = await fetch(cardUrl, { signal })
        if (!res.ok) throw new Error(`fetchAgentCard ${cardUrl} → ${res.status}`)
        const body = await res.json() as AgentCard
        if (!body.name) throw new Error(`fetchAgentCard ${cardUrl} → missing 'name'`)
        return body
      })
    },

    async send({ url, bearer, body }) {
      try {
        return await withTimeout(async (signal) => {
          const res = await fetch(url, {
            method: 'POST',
            signal,
            headers: {
              'authorization': `Bearer ${bearer}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(body),
          })
          let response: unknown = undefined
          const text = await res.text()
          if (text) {
            try { response = JSON.parse(text) }
            catch { response = text }
          }
          if (!res.ok) {
            return { ok: false, http_status: res.status, response, error: `http_${res.status}` }
          }
          return { ok: true, http_status: res.status, response }
        })
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
```

- [ ] **Step 4: Run tests to pass**

Run: `bun run test src/core/a2a-client.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/a2a-client.ts src/core/a2a-client.test.ts
git commit -m "feat(a2a): client — outbound fetchAgentCard + send with timeout"
```

---

### Task 4: a2a-server module — inbound HTTP

**Files:**
- Create: `src/core/a2a-server.ts`
- Create: `src/core/a2a-server.test.ts`

Bun.serve listener handling `GET /.well-known/agent.json` and `POST /a2a/notify`. Verifies Bearer against registry, calls into a routing callback supplied at construction time (the bootstrap will wire this to `sendAssistantText`).

- [ ] **Step 1: Write failing tests**

Create `src/core/a2a-server.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createA2AServer } from './a2a-server'
import type { A2ARegistry } from './a2a-registry'
import type { A2AAgentRecord } from '../lib/agent-config'

function rec(id: string, overrides: Partial<A2AAgentRecord> = {}): A2AAgentRecord {
  return {
    id, name: id, url: `https://${id}/a2a`,
    inbound_api_key: `wc_${id}`, outbound_api_key: `out_${id}`,
    capabilities: ['notify'], paused: false, ...overrides,
  }
}

function fakeRegistry(agents: A2AAgentRecord[]): A2ARegistry {
  return {
    list: () => agents,
    get: (id) => agents.find(a => a.id === id) ?? null,
    verifyBearer: (id, bearer) => {
      const a = agents.find(x => x.id === id)
      return a && a.inbound_api_key === bearer ? a : null
    },
    add: vi.fn(), remove: vi.fn(), setPaused: vi.fn(),
  }
}

async function startServer(opts: { agents?: A2AAgentRecord[]; onNotify?: ReturnType<typeof vi.fn> } = {}) {
  const onNotify = opts.onNotify ?? vi.fn(async () => {})
  const server = createA2AServer({
    host: '127.0.0.1', port: 0,
    registry: fakeRegistry(opts.agents ?? [rec('alpha')]),
    onNotify,
    daemonInfo: { name: 'wechat-cc', version: '0.6.x' },
  })
  await server.start()
  return { server, onNotify, baseUrl: server.baseUrl() }
}

describe('a2a-server', () => {
  it('GET /.well-known/agent.json returns the daemon Agent Card', async () => {
    const { server, baseUrl } = await startServer()
    try {
      const res = await fetch(`${baseUrl}/.well-known/agent.json`)
      expect(res.status).toBe(200)
      const card = await res.json() as { name: string; capabilities: Array<{ name: string }> }
      expect(card.name).toBe('wechat-cc')
      expect(card.capabilities.some(c => c.name === 'notify')).toBe(true)
    } finally {
      await server.stop()
    }
  })

  it('POST /a2a/notify with valid Bearer + matching agent_id calls onNotify and returns 200', async () => {
    const onNotify = vi.fn(async () => {})
    const { server, baseUrl } = await startServer({ onNotify })
    try {
      const res = await fetch(`${baseUrl}/a2a/notify`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer wc_alpha',
        },
        body: JSON.stringify({ agent_id: 'alpha', text: 'hello', urgency: 'normal' }),
      })
      expect(res.status).toBe(200)
      expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({
        agent: expect.objectContaining({ id: 'alpha' }),
        text: 'hello',
        urgency: 'normal',
      }))
    } finally {
      await server.stop()
    }
  })

  it('POST /a2a/notify without Authorization → 401', async () => {
    const { server, baseUrl } = await startServer()
    try {
      const res = await fetch(`${baseUrl}/a2a/notify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_id: 'alpha', text: 'x' }),
      })
      expect(res.status).toBe(401)
    } finally {
      await server.stop()
    }
  })

  it('POST /a2a/notify with wrong Bearer → 401', async () => {
    const { server, baseUrl } = await startServer()
    try {
      const res = await fetch(`${baseUrl}/a2a/notify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': 'Bearer wrong' },
        body: JSON.stringify({ agent_id: 'alpha', text: 'x' }),
      })
      expect(res.status).toBe(401)
    } finally {
      await server.stop()
    }
  })

  it('POST /a2a/notify with body.agent_id != bearer-owning agent → 403', async () => {
    const { server, baseUrl } = await startServer({ agents: [rec('alpha'), rec('beta')] })
    try {
      const res = await fetch(`${baseUrl}/a2a/notify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': 'Bearer wc_alpha' },
        body: JSON.stringify({ agent_id: 'beta', text: 'spoof' }),  // alpha's key, beta's id
      })
      expect(res.status).toBe(403)
    } finally {
      await server.stop()
    }
  })

  it('POST /a2a/notify with paused agent → 202 (silently drop)', async () => {
    const onNotify = vi.fn(async () => {})
    const { server, baseUrl } = await startServer({
      agents: [rec('alpha', { paused: true })],
      onNotify,
    })
    try {
      const res = await fetch(`${baseUrl}/a2a/notify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': 'Bearer wc_alpha' },
        body: JSON.stringify({ agent_id: 'alpha', text: 'x' }),
      })
      expect(res.status).toBe(202)
      expect(onNotify).not.toHaveBeenCalled()
    } finally {
      await server.stop()
    }
  })

  it('POST /a2a/notify with missing text → 400', async () => {
    const { server, baseUrl } = await startServer()
    try {
      const res = await fetch(`${baseUrl}/a2a/notify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': 'Bearer wc_alpha' },
        body: JSON.stringify({ agent_id: 'alpha' }),  // no text
      })
      expect(res.status).toBe(400)
    } finally {
      await server.stop()
    }
  })

  it('unknown path returns 404', async () => {
    const { server, baseUrl } = await startServer()
    try {
      const res = await fetch(`${baseUrl}/anything-else`)
      expect(res.status).toBe(404)
    } finally {
      await server.stop()
    }
  })

  it('GET on /a2a/notify (wrong method) returns 405', async () => {
    const { server, baseUrl } = await startServer()
    try {
      const res = await fetch(`${baseUrl}/a2a/notify`)
      expect(res.status).toBe(405)
    } finally {
      await server.stop()
    }
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test src/core/a2a-server.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/core/a2a-server.ts`:

```ts
/**
 * A2A server — inbound HTTP listener that lets registered external
 * A2A agents push notify(...) calls into wechat-cc.
 *
 * Two endpoints:
 *   GET  /.well-known/agent.json — daemon's Agent Card (unauthenticated)
 *   POST /a2a/notify — push a message to the operator
 *
 * The server itself is dumb: it verifies Bearer auth, validates the
 * body shape, and hands off to an injected `onNotify` callback. The
 * callback (wired in bootstrap) is what actually routes the message
 * to the operator's chat via sendAssistantText.
 *
 * Default-binds 127.0.0.1. Operator must explicitly opt into wider
 * binding via agent-config.a2a_listen.host. OFF by default — start()
 * is only called when a2a_listen is configured.
 *
 * See docs/superpowers/specs/2026-05-24-a2a-integration-design.md.
 */
import type { A2ARegistry } from './a2a-registry'
import type { A2AAgentRecord } from '../lib/agent-config'

export interface NotifyEvent {
  agent: A2AAgentRecord
  text: string
  urgency?: 'normal' | 'critical'
  metadata?: Record<string, unknown>
}

export interface A2AServerOpts {
  host: string
  port: number
  registry: A2ARegistry
  onNotify: (event: NotifyEvent) => Promise<void>
  daemonInfo: { name: string; version: string }
}

export interface A2AServer {
  start(): Promise<void>
  stop(): Promise<void>
  baseUrl(): string
  port(): number
}

export function createA2AServer(opts: A2AServerOpts): A2AServer {
  let server: ReturnType<typeof Bun.serve> | null = null

  const agentCard = {
    name: opts.daemonInfo.name,
    description: 'WeChat bridge for AI agents — notify the operator via WeChat chat.',
    version: opts.daemonInfo.version,
    auth: { type: 'bearer', required: true },
    capabilities: [
      {
        name: 'notify',
        description: 'Push a message to the operator\'s WeChat chat. Operator may reply via their claude/codex session, which can then call back via A2A.',
        endpoint: '/a2a/notify',
        method: 'POST',
        request_schema: {
          agent_id: 'string (your registered id with this wechat-cc)',
          text: 'string',
          urgency: 'string (optional, \'normal\'|\'critical\')',
          metadata: 'object (optional)',
        },
      },
    ],
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/.well-known/agent.json') {
      if (req.method !== 'GET') return new Response('method not allowed', { status: 405 })
      return new Response(JSON.stringify(agentCard), {
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.pathname === '/a2a/notify') {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
      const auth = req.headers.get('authorization')
      if (!auth?.startsWith('Bearer ')) return new Response(JSON.stringify({ error: 'missing_bearer' }), { status: 401 })
      const bearer = auth.slice('Bearer '.length).trim()

      let body: { agent_id?: unknown; text?: unknown; urgency?: unknown; metadata?: unknown }
      try {
        body = await req.json() as typeof body
      } catch {
        return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400 })
      }
      if (typeof body.agent_id !== 'string' || typeof body.text !== 'string' || body.text.length === 0) {
        return new Response(JSON.stringify({ error: 'invalid_body' }), { status: 400 })
      }

      const agent = opts.registry.verifyBearer(body.agent_id, bearer)
      if (!agent) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
      // Verify body.agent_id matches the Bearer's owning agent (already enforced by verifyBearer's lookup, but explicit).
      if (agent.id !== body.agent_id) return new Response(JSON.stringify({ error: 'agent_id_mismatch' }), { status: 403 })
      if (agent.paused) return new Response(JSON.stringify({ ok: true, paused: true }), { status: 202 })

      const urgency: 'normal' | 'critical' | undefined =
        body.urgency === 'critical' ? 'critical' : body.urgency === 'normal' ? 'normal' : undefined

      try {
        await opts.onNotify({
          agent, text: body.text, urgency,
          metadata: (body.metadata && typeof body.metadata === 'object') ? body.metadata as Record<string, unknown> : undefined,
        })
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return new Response(JSON.stringify({ error: 'notify_failed', detail: msg }), { status: 500 })
      }
    }
    return new Response('not found', { status: 404 })
  }

  return {
    async start() {
      if (server) return
      server = Bun.serve({
        hostname: opts.host,
        port: opts.port,
        fetch: handle,
      })
    },
    async stop() {
      server?.stop()
      server = null
    },
    baseUrl() {
      if (!server) throw new Error('a2a-server not started')
      return `http://${opts.host}:${server.port}`
    },
    port() {
      if (!server) throw new Error('a2a-server not started')
      return server.port
    },
  }
}
```

- [ ] **Step 4: Run tests to pass**

Run: `bun run test src/core/a2a-server.test.ts`
Expected: PASS, all 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/a2a-server.ts src/core/a2a-server.test.ts
git commit -m "feat(a2a): server — Bun.serve listener with bearer auth + notify routing"
```

---

### Task 5: a2a_send MCP tool + capability matrix row

**Files:**
- Modify: `src/daemon/wechat-mcp/` (find the existing tool registration file; it's likely `src/daemon/wechat-mcp/index.ts` or `tools.ts`)
- Modify: `src/core/capability-matrix.ts`
- Test: `src/core/capability-matrix.test.ts`
- Test: a new file `src/daemon/wechat-mcp/tools/a2a-send.test.ts` (or co-locate next to the tool implementation)

The MCP tool name is `a2a_send`. It takes `{ agent_id, text }`, looks up the agent in registry, calls `a2a-client.send(...)`, persists an event row, and returns a structured result for claude/codex/cursor to act on.

- [ ] **Step 1: Inspect existing wechat-mcp tool registration**

Run: `grep -n "name:\s*'reply'\|name:\s*'edit_message'\|registerTool\|tools.push\|export const tools" src/daemon/wechat-mcp/*.ts src/daemon/wechat-mcp/**/*.ts 2>/dev/null | head -20`

Read whichever file holds the existing tool definitions. The exact pattern (single array of tool objects? separate files per tool? factory function with deps?) determines where to add `a2a_send`.

- [ ] **Step 2: Write the failing tool test**

Create test file in the same directory as the wechat-mcp tools. Replace `<path>` with where the existing tools live. Test the tool execution end-to-end with a fake registry + fake client.

```ts
import { describe, expect, it, vi } from 'vitest'
import { makeA2ASendTool } from './a2a-send'  // adapt path to match implementation file
import type { A2ARegistry } from '../../../core/a2a-registry'
import type { A2AClient } from '../../../core/a2a-client'
import type { A2AAgentRecord } from '../../../lib/agent-config'

function rec(id: string, overrides: Partial<A2AAgentRecord> = {}): A2AAgentRecord {
  return {
    id, name: id, url: `https://${id}/a2a`,
    inbound_api_key: `wc_${id}`, outbound_api_key: `out_${id}`,
    capabilities: ['notify'], paused: false, ...overrides,
  }
}

function fakeRegistry(agents: A2AAgentRecord[]): A2ARegistry {
  return {
    list: () => agents,
    get: (id) => agents.find(a => a.id === id) ?? null,
    verifyBearer: () => null,
    add: vi.fn(), remove: vi.fn(), setPaused: vi.fn(),
  }
}

describe('a2a_send MCP tool', () => {
  it('returns ok=false unknown_agent for unregistered agent_id', async () => {
    const tool = makeA2ASendTool({
      registry: fakeRegistry([]),
      client: { fetchAgentCard: vi.fn(), send: vi.fn() } as unknown as A2AClient,
      recordEvent: vi.fn(),
    })
    const r = await tool.execute({ agent_id: 'missing', text: 'hi' })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('unknown_agent')
    expect(r.registered).toEqual([])
  })

  it('returns ok=false agent_paused for paused agent', async () => {
    const tool = makeA2ASendTool({
      registry: fakeRegistry([rec('alpha', { paused: true })]),
      client: { fetchAgentCard: vi.fn(), send: vi.fn() } as unknown as A2AClient,
      recordEvent: vi.fn(),
    })
    const r = await tool.execute({ agent_id: 'alpha', text: 'hi' })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('agent_paused')
  })

  it('POSTs to the agent URL with outbound_api_key and returns ok=true on 2xx', async () => {
    const send = vi.fn(async () => ({ ok: true, http_status: 200, response: { ack: true } }))
    const recordEvent = vi.fn()
    const tool = makeA2ASendTool({
      registry: fakeRegistry([rec('alpha')]),
      client: { fetchAgentCard: vi.fn(), send } as unknown as A2AClient,
      recordEvent,
    })
    const r = await tool.execute({ agent_id: 'alpha', text: 'reply: retry' })
    expect(r.ok).toBe(true)
    expect(send).toHaveBeenCalledWith({
      url: 'https://alpha/a2a',
      bearer: 'out_alpha',
      body: { text: 'reply: retry', source: { agent_id: 'wechat-cc' } },
    })
    expect(recordEvent).toHaveBeenCalledWith({
      direction: 'out', agent_id: 'alpha', text: 'reply: retry',
      status: 'ok', http_status: 200,
    })
  })

  it('records http_error event on non-2xx', async () => {
    const send = vi.fn(async () => ({ ok: false, http_status: 500, error: 'http_500' }))
    const recordEvent = vi.fn()
    const tool = makeA2ASendTool({
      registry: fakeRegistry([rec('alpha')]),
      client: { fetchAgentCard: vi.fn(), send } as unknown as A2AClient,
      recordEvent,
    })
    const r = await tool.execute({ agent_id: 'alpha', text: 'x' })
    expect(r.ok).toBe(false)
    expect(r.http_status).toBe(500)
    expect(recordEvent).toHaveBeenCalledWith({
      direction: 'out', agent_id: 'alpha', text: 'x',
      status: 'http_error', http_status: 500,
    })
  })

  it('records timeout/network_error event on transport failure', async () => {
    const send = vi.fn(async () => ({ ok: false, error: 'timeout' }))
    const recordEvent = vi.fn()
    const tool = makeA2ASendTool({
      registry: fakeRegistry([rec('alpha')]),
      client: { fetchAgentCard: vi.fn(), send } as unknown as A2AClient,
      recordEvent,
    })
    const r = await tool.execute({ agent_id: 'alpha', text: 'x' })
    expect(r.ok).toBe(false)
    expect(recordEvent).toHaveBeenCalledWith({
      direction: 'out', agent_id: 'alpha', text: 'x',
      status: 'timeout',
    })
  })
})
```

- [ ] **Step 3: Implement the tool**

Create `src/daemon/wechat-mcp/tools/a2a-send.ts` (or wherever matches existing pattern):

```ts
/**
 * a2a_send MCP tool — exposed to claude/codex/cursor sessions.
 *
 * Lets the agent communicate back to a registered external A2A agent
 * (the typical case: operator says "tell deploy-bot retry", claude
 * calls this tool with agent_id="deploy-bot", text="retry").
 *
 * Tier gating happens at the canUseTool / permission-relay layer, not
 * here. See capability-matrix.ts.
 *
 * See docs/superpowers/specs/2026-05-24-a2a-integration-design.md.
 */
import type { A2ARegistry } from '../../../core/a2a-registry'
import type { A2AClient } from '../../../core/a2a-client'

export type EventDirection = 'in' | 'out'
export type EventStatus = 'ok' | 'auth_failed' | 'http_error' | 'timeout' | 'unknown_agent' | 'agent_paused'

export interface RecordEvent {
  (event: {
    direction: EventDirection
    agent_id: string
    text: string
    urgency?: 'normal' | 'critical'
    status: EventStatus
    http_status?: number
  }): void
}

export interface A2ASendInput {
  agent_id: string
  text: string
}

export interface A2ASendOutput {
  ok: boolean
  http_status?: number
  error?: string
  registered?: string[]
}

export interface A2ASendToolDeps {
  registry: A2ARegistry
  client: A2AClient
  recordEvent: RecordEvent
}

export interface A2ASendTool {
  /** MCP tool metadata — what claude sees. */
  readonly definition: {
    name: 'a2a_send'
    description: string
    input_schema: object
  }
  execute(input: A2ASendInput): Promise<A2ASendOutput>
}

export function makeA2ASendTool(deps: A2ASendToolDeps): A2ASendTool {
  return {
    definition: {
      name: 'a2a_send',
      description: 'Send a message to a registered external A2A agent. Use this when the operator asks you to reply to or follow up with an A2A notification. The agent_id is the identifier from the [A2A:<id>] prefix in recent messages.',
      input_schema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The registered agent id, e.g. "deploy-bot".' },
          text: { type: 'string', description: 'The message text to send to that agent.' },
        },
        required: ['agent_id', 'text'],
      },
    },

    async execute({ agent_id, text }) {
      const agent = deps.registry.get(agent_id)
      if (!agent) {
        return { ok: false, error: 'unknown_agent', registered: deps.registry.list().map(a => a.id) }
      }
      if (agent.paused) {
        return { ok: false, error: 'agent_paused' }
      }
      const r = await deps.client.send({
        url: agent.url,
        bearer: agent.outbound_api_key,
        body: { text, source: { agent_id: 'wechat-cc' } },
      })
      const status: EventStatus = r.ok
        ? 'ok'
        : (r.http_status ? 'http_error' : (r.error?.match(/timeout|aborted/i) ? 'timeout' : 'http_error'))
      deps.recordEvent({
        direction: 'out', agent_id, text,
        status,
        ...(r.http_status !== undefined ? { http_status: r.http_status } : {}),
      })
      return {
        ok: r.ok,
        ...(r.http_status !== undefined ? { http_status: r.http_status } : {}),
        ...(r.error ? { error: r.error } : {}),
      }
    },
  }
}
```

- [ ] **Step 4: Wire the tool into wechat-mcp tool list**

In whichever file enumerates the wechat-mcp tools, add `a2a_send` alongside `reply` etc. The wiring depends on the existing structure. Likely pattern:

```ts
// in wechat-mcp/index.ts or wechat-mcp/tools.ts:
import { makeA2ASendTool } from './tools/a2a-send'

// ... inside the makeWechatMcp factory or equivalent:
const a2aSend = makeA2ASendTool({ registry: deps.a2aRegistry, client: deps.a2aClient, recordEvent: deps.recordA2AEvent })
// register in the tools array / handler map alongside reply, edit_message, etc.
```

Find and follow the existing pattern. If wechat-mcp uses a single tools array literal, add a new entry with `name: 'a2a_send'`, the `input_schema`, and a handler that calls `a2aSend.execute(args)`.

- [ ] **Step 5: Add capability-matrix row**

In `src/core/capability-matrix.ts`, locate where tools like `delegate_codex` are gated. Add rows for `a2a_send` × tier:

```ts
// Approximate shape — adapt to existing matrix format:
{ tool: 'a2a_send', tier: 'admin',   action: 'allow' },
{ tool: 'a2a_send', tier: 'trusted', action: 'relay' },
{ tool: 'a2a_send', tier: 'guest',   action: 'deny' },
```

If the matrix is structured by `(mode × provider × permissionMode)` rows (no per-tool dimension), the `a2a_send` tool's gating may live in a different module (search: `delegate_<peer>` to find the equivalent). Follow the existing pattern.

- [ ] **Step 6: Add capability-matrix tests**

Append to `src/core/capability-matrix.test.ts`:

```ts
describe('capability-matrix — a2a_send tool', () => {
  it('admin tier auto-allows a2a_send', () => {
    // Use whatever the file's actual API surface is — likely a `lookup`
    // or `gateToolCall` function. Adapt below to match.
    expect(gateToolCall('a2a_send', 'admin')).toBe('allow')
  })
  it('trusted tier relays a2a_send', () => {
    expect(gateToolCall('a2a_send', 'trusted')).toBe('relay')
  })
  it('guest tier denies a2a_send', () => {
    expect(gateToolCall('a2a_send', 'guest')).toBe('deny')
  })
})
```

If the matrix has a different shape, adapt the assertion accordingly.

- [ ] **Step 7: Run tests to pass**

Run: `bun run test src/daemon/wechat-mcp/tools/a2a-send.test.ts src/core/capability-matrix.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/daemon/wechat-mcp/tools/a2a-send.ts src/daemon/wechat-mcp/tools/a2a-send.test.ts src/core/capability-matrix.ts src/core/capability-matrix.test.ts <wechat-mcp wiring file>
git commit -m "feat(a2a): a2a_send MCP tool + tier gating in capability matrix"
```

---

### Task 6: Bootstrap wiring + a2a-events persistence helper

**Files:**
- Modify: `src/daemon/bootstrap/index.ts`
- Create: `src/core/a2a-events-store.ts` (small helper for the `a2a_events` table)
- Create: `src/core/a2a-events-store.test.ts`

Wire everything together at boot time: instantiate registry, client, server (only if `a2a_listen` is configured), tool. The `onNotify` callback from server passes through to `sendAssistantText` formatted as `[A2A:${agent.id}] ${text}` and records an inbound event.

- [ ] **Step 1: Write failing events-store tests**

Create `src/core/a2a-events-store.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { openDb } from '../lib/db'
import { makeA2AEventsStore } from './a2a-events-store'

describe('a2a-events-store', () => {
  it('append() inserts a row with id, ts, direction, agent_id, text, status', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeA2AEventsStore(db)
    store.append({ direction: 'in', agent_id: 'alpha', text: 'hello', status: 'ok' })
    const rows = db.query<{ direction: string; agent_id: string; text: string; status: string }, []>(
      'SELECT direction, agent_id, text, status FROM a2a_events'
    ).all()
    expect(rows).toEqual([{ direction: 'in', agent_id: 'alpha', text: 'hello', status: 'ok' }])
  })

  it('append() persists urgency and http_status when provided', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeA2AEventsStore(db)
    store.append({ direction: 'out', agent_id: 'beta', text: 'x', status: 'http_error', http_status: 502, urgency: 'critical' })
    const r = db.query<{ urgency: string | null; http_status: number | null }, []>(
      'SELECT urgency, http_status FROM a2a_events'
    ).get()
    expect(r?.urgency).toBe('critical')
    expect(r?.http_status).toBe(502)
  })

  it('truncates text to 8KB', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeA2AEventsStore(db)
    const long = 'x'.repeat(10_000)
    store.append({ direction: 'in', agent_id: 'alpha', text: long, status: 'ok' })
    const r = db.query<{ text: string }, []>('SELECT text FROM a2a_events').get()
    expect(r?.text.length).toBe(8192)
  })

  it('recentForAgent(id, limit) returns latest N for an agent, newest first', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeA2AEventsStore(db)
    for (let i = 0; i < 5; i++) {
      store.append({ direction: 'in', agent_id: 'alpha', text: `msg-${i}`, status: 'ok' })
    }
    store.append({ direction: 'in', agent_id: 'beta', text: 'unrelated', status: 'ok' })
    const recent = store.recentForAgent('alpha', 3)
    expect(recent).toHaveLength(3)
    expect(recent.map(r => r.text)).toEqual(['msg-4', 'msg-3', 'msg-2'])
  })

  it('counts() returns per-agent direction counts', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeA2AEventsStore(db)
    store.append({ direction: 'in', agent_id: 'alpha', text: 'x', status: 'ok' })
    store.append({ direction: 'in', agent_id: 'alpha', text: 'y', status: 'ok' })
    store.append({ direction: 'out', agent_id: 'alpha', text: 'z', status: 'ok' })
    expect(store.counts('alpha')).toEqual({ inbound: 2, outbound: 1 })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test src/core/a2a-events-store.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement events store**

Create `src/core/a2a-events-store.ts`:

```ts
/**
 * a2a_events store — append-only log of A2A inbound/outbound calls
 * for observability. Backed by the SQLite a2a_events table (migration v12).
 *
 * Pure persistence; no control-flow side effects. Dashboard reads from
 * recentForAgent / counts to render the activity feed.
 */
import type { Db } from '../lib/db'

const MAX_TEXT = 8192

export type EventDirection = 'in' | 'out'
export type EventStatus = 'ok' | 'auth_failed' | 'http_error' | 'timeout' | 'unknown_agent' | 'agent_paused'

export interface AppendInput {
  direction: EventDirection
  agent_id: string
  text: string
  urgency?: 'normal' | 'critical'
  status: EventStatus
  http_status?: number
}

export interface EventRow {
  id: string
  ts: string
  direction: EventDirection
  agent_id: string
  text: string
  urgency: 'normal' | 'critical' | null
  status: EventStatus
  http_status: number | null
}

export interface A2AEventsStore {
  append(input: AppendInput): void
  recentForAgent(agentId: string, limit: number): readonly EventRow[]
  counts(agentId: string): { inbound: number; outbound: number }
}

export function makeA2AEventsStore(db: Db): A2AEventsStore {
  const stmtAppend = db.query<unknown, [string, string, EventDirection, string, string, string | null, EventStatus, number | null]>(
    'INSERT INTO a2a_events(id, ts, direction, agent_id, text, urgency, status, http_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const stmtRecent = db.query<EventRow, [string, number]>(
    'SELECT id, ts, direction, agent_id, text, urgency, status, http_status FROM a2a_events WHERE agent_id = ? ORDER BY ts DESC LIMIT ?',
  )
  const stmtCount = db.query<{ direction: EventDirection; cnt: number }, [string]>(
    "SELECT direction, COUNT(*) AS cnt FROM a2a_events WHERE agent_id = ? GROUP BY direction",
  )

  return {
    append(input) {
      const id = crypto.randomUUID()
      const ts = new Date().toISOString()
      const text = input.text.length > MAX_TEXT ? input.text.slice(0, MAX_TEXT) : input.text
      stmtAppend.run(
        id, ts, input.direction, input.agent_id, text,
        input.urgency ?? null,
        input.status,
        input.http_status ?? null,
      )
    },
    recentForAgent(agentId, limit) {
      return stmtRecent.all(agentId, limit)
    },
    counts(agentId) {
      const rows = stmtCount.all(agentId)
      let inbound = 0, outbound = 0
      for (const r of rows) {
        if (r.direction === 'in') inbound = r.cnt
        else if (r.direction === 'out') outbound = r.cnt
      }
      return { inbound, outbound }
    },
  }
}
```

- [ ] **Step 4: Run events-store tests to pass**

Run: `bun run test src/core/a2a-events-store.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Wire bootstrap**

In `src/daemon/bootstrap/index.ts`, after the existing daemon-level deps are constructed (registry/sessionmanager/conversationStore/etc), add:

```ts
import { createA2ARegistry } from '../../core/a2a-registry'
import { createA2AClient } from '../../core/a2a-client'
import { createA2AServer } from '../../core/a2a-server'
import { makeA2AEventsStore } from '../../core/a2a-events-store'
// ... and the a2a_send tool wiring (Task 5 added the tool; here we instantiate the deps it needs)

const a2aRegistry = createA2ARegistry({ stateDir: deps.stateDir })
const a2aClient = createA2AClient()  // default 10s timeout
const a2aEventsStore = makeA2AEventsStore(db)

// onNotify: route inbound A2A notification → operator chat
async function routeA2ANotify(event: NotifyEvent): Promise<void> {
  const operatorChatId = resolveOperatorChatId()  // helper added below
  if (!operatorChatId) {
    log('A2A_NOTIFY_IN', `dropping notify from ${event.agent.id}: no operator chat bound yet`)
    return
  }
  const formatted = `[A2A:${event.agent.id}] ${event.text}`
  await sendAssistantText(operatorChatId, formatted)
  a2aEventsStore.append({
    direction: 'in', agent_id: event.agent.id, text: event.text,
    urgency: event.urgency, status: 'ok',
  })
}

// Server only starts if a2a_listen is configured.
let a2aServer: ReturnType<typeof createA2AServer> | null = null
if (configuredAgent.a2a_listen) {
  a2aServer = createA2AServer({
    host: configuredAgent.a2a_listen.host,
    port: configuredAgent.a2a_listen.port,
    registry: a2aRegistry,
    onNotify: routeA2ANotify,
    daemonInfo: { name: 'wechat-cc', version: packageVersion },
  })
  await a2aServer.start()
  log('A2A', `server listening on http://${configuredAgent.a2a_listen.host}:${a2aServer.port()}`)
}

// Helper: resolve operator chat. v1 = first-bound bot↔operator chat.
// The bot is 1:1 with the operator by definition (no groups), so any
// conversation row IS an operator chat. We take the earliest-updated_at
// row as "first bound" and cache it for the daemon's lifetime — operator's
// binding doesn't shift mid-session.
let cachedOperatorChatId: string | null = null
function resolveOperatorChatId(): string | null {
  if (cachedOperatorChatId) return cachedOperatorChatId
  const row = db.query<{ chat_id: string }, []>(
    'SELECT chat_id FROM conversations ORDER BY updated_at ASC LIMIT 1',
  ).get()
  if (row) {
    cachedOperatorChatId = row.chat_id
    return row.chat_id
  }
  return null
}
```

Add the tool registration into wechat-mcp's tool list (the registration shape was discovered in Task 5):

```ts
// In the wechat-mcp factory call:
//   tools: [
//     ...,
//     makeA2ASendTool({ registry: a2aRegistry, client: a2aClient, recordEvent: (e) => a2aEventsStore.append(e) }),
//   ]
```

(No new bootstrap deps needed for the chat-resolution helper itself — it queries `conversations` directly. The new wechat-mcp wiring needs `a2aRegistry`, `a2aClient`, and a `recordEvent` callback bound to `a2aEventsStore.append`.)

- [ ] **Step 6: Add a bootstrap test (or extend an existing one)**

In whichever bootstrap test file exists (likely `src/daemon/bootstrap.test.ts`), add an assertion that:
- With `a2a_listen` unset in config, no A2A server starts (no port bound)
- With `a2a_listen` set, server starts on the configured port and `/.well-known/agent.json` is reachable
- `routeA2ANotify` calls `sendAssistantText` with `[A2A:<id>] <text>` shape

If the bootstrap test infrastructure doesn't support exercising the HTTP server directly, write a smaller integration test in a new file `src/daemon/bootstrap.a2a.test.ts` that bootstraps a minimal daemon with `a2a_listen` set and verifies via HTTP request that the server is up.

- [ ] **Step 7: Run full suite**

Run: `bun run test && bun run typecheck`
Expected: PASS overall. Watch for any test fixtures that construct configs without `a2a_agents` / `a2a_listen` — those should still work (fields are optional).

- [ ] **Step 8: Commit**

```bash
git add src/daemon/bootstrap/index.ts src/core/a2a-events-store.ts src/core/a2a-events-store.test.ts <bootstrap test files>
git commit -m "feat(a2a): bootstrap wiring + events store; server starts when a2a_listen configured"
```

---

### Task 7: CLI commands — `wechat-cc agent {inspect,add,list,remove,pause,resume,activity}`

**Files:**
- Modify: `src/cli.ts` (or wherever the existing `wechat-cc` CLI dispatch lives — likely `src/cli/agent.ts` if there's already a subcommand pattern)
- Test: `src/cli/agent.test.ts` (or co-located test)

7 subcommands under `wechat-cc agent`. Pure CLI wrappers over the registry + client.

- [ ] **Step 1: Locate existing CLI structure**

Run: `find src -name 'cli*.ts' -not -name '*.test.*' | head -5 && grep -n 'subcommand\|switch\|case' src/cli.ts 2>/dev/null | head -10`

Adapt the implementation below to match the existing subcommand pattern (top-level switch in cli.ts? per-command files in src/cli/? a clap-style declarative router?).

- [ ] **Step 2: Write failing CLI tests**

For each subcommand, test the I/O behavior. Adapt this pattern to match existing CLI test conventions:

```ts
import { describe, expect, it, vi } from 'vitest'
// Adapt imports to match existing CLI testing harness.

describe('wechat-cc agent CLI', () => {
  it('inspect <url> fetches Agent Card and prints metadata', async () => {
    // Mock createA2AClient.fetchAgentCard to return { name: 'fake', ... }
    // Run `wechat-cc agent inspect https://example.com/a2a`
    // Assert stdout contains 'fake' and the capabilities list
  })

  it('add <url> generates inbound_api_key, prompts for outbound_api_key + id, persists', async () => {
    // Stub prompts; run cli; assert registry.add was called with expected record
  })

  it('list prints registered agents one per line', async () => {
    // Pre-populate registry; assert output rows
  })

  it('list with no agents prints "no agents registered" (exit 0)', async () => { ... })

  it('pause <id> flips paused=true', async () => { ... })

  it('resume <id> flips paused=false', async () => { ... })

  it('remove <id> drops from registry', async () => { ... })

  it('activity <id> prints recent events with timestamps', async () => { ... })

  it('add fails cleanly when Agent Card cannot be fetched', async () => { ... })

  it('remove fails cleanly when agent id not found', async () => { ... })
})
```

- [ ] **Step 3: Implement subcommands**

Sketch (adapt to existing patterns):

```ts
// src/cli/agent.ts (or whatever the existing pattern is)
import { createA2ARegistry } from '../core/a2a-registry'
import { createA2AClient } from '../core/a2a-client'
import { makeA2AEventsStore } from '../core/a2a-events-store'
import { openWechatDb } from '../lib/db'
import { resolveStateDir } from '../lib/state-dir'  // adapt to existing helper
import { randomBytes } from 'node:crypto'

export async function cmdAgentInspect(url: string): Promise<void> {
  const client = createA2AClient()
  const card = await client.fetchAgentCard(url)
  console.log(`Name: ${card.name}`)
  if (card.description) console.log(`Description: ${card.description}`)
  if (card.version) console.log(`Version: ${card.version}`)
  if (card.auth) console.log(`Auth: ${card.auth.type} (required: ${card.auth.required})`)
  if (card.capabilities) {
    console.log('Capabilities:')
    for (const c of card.capabilities) console.log(`  - ${c.name}${c.description ? ': ' + c.description : ''}`)
  }
}

export async function cmdAgentAdd(url: string, opts: { id?: string; outboundKey?: string; nameOverride?: string }): Promise<void> {
  const client = createA2AClient()
  const card = await client.fetchAgentCard(url)
  const id = opts.id ?? slugify(card.name)
  const name = opts.nameOverride ?? card.name
  const outboundKey = opts.outboundKey ?? '' // empty means agent doesn't require outbound auth (rare)
  const inboundKey = `wc_${randomBytes(16).toString('hex')}`
  const stateDir = resolveStateDir()
  const reg = createA2ARegistry({ stateDir })
  reg.add({
    id, name, url,
    inbound_api_key: inboundKey,
    outbound_api_key: outboundKey,
    capabilities: card.capabilities?.map(c => c.name) ?? [],
    paused: false,
  })
  console.log(`✅ added agent '${id}'`)
  console.log(`   inbound API key: ${inboundKey}`)
  console.log(`   provide this key to the agent so it can authenticate when calling wechat-cc.`)
  console.log(`   curl example:`)
  console.log(`     curl -X POST <wechat-cc-base-url>/a2a/notify \\`)
  console.log(`       -H "Authorization: Bearer ${inboundKey}" \\`)
  console.log(`       -H "Content-Type: application/json" \\`)
  console.log(`       -d '{"agent_id":"${id}","text":"hello"}'`)
}

export function cmdAgentList(): void {
  const stateDir = resolveStateDir()
  const reg = createA2ARegistry({ stateDir })
  const agents = reg.list()
  if (agents.length === 0) { console.log('no agents registered'); return }
  for (const a of agents) {
    const status = a.paused ? '(paused)' : ''
    console.log(`${a.id}  ${a.name}  ${a.url}  ${status}`)
  }
}

export function cmdAgentPause(id: string, paused: boolean): void {
  const stateDir = resolveStateDir()
  const reg = createA2ARegistry({ stateDir })
  reg.setPaused(id, paused)
  console.log(`${paused ? '⏸' : '▶'} agent '${id}' ${paused ? 'paused' : 'resumed'}`)
}

export function cmdAgentRemove(id: string): void {
  const stateDir = resolveStateDir()
  const reg = createA2ARegistry({ stateDir })
  reg.remove(id)
  console.log(`🗑 agent '${id}' removed`)
}

export function cmdAgentActivity(id: string, limit: number): void {
  const stateDir = resolveStateDir()
  const db = openWechatDb(stateDir)
  const store = makeA2AEventsStore(db)
  const rows = store.recentForAgent(id, limit)
  if (rows.length === 0) { console.log(`no activity for ${id}`); return }
  for (const r of rows) {
    const arrow = r.direction === 'in' ? '←' : '→'
    const status = r.status === 'ok' ? '' : ` [${r.status}${r.http_status ? ' ' + r.http_status : ''}]`
    console.log(`${r.ts} ${arrow} ${r.text.slice(0, 80)}${r.text.length > 80 ? '…' : ''}${status}`)
  }
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}
```

Wire these into the CLI dispatch — likely something like:

```ts
// in src/cli.ts switch/match:
case 'agent': {
  const sub = args[1]
  if (sub === 'inspect') return cmdAgentInspect(args[2])
  if (sub === 'add')     return cmdAgentAdd(args[2], parseAddOpts(args.slice(3)))
  if (sub === 'list')    return cmdAgentList()
  if (sub === 'pause')   return cmdAgentPause(args[2], true)
  if (sub === 'resume')  return cmdAgentPause(args[2], false)
  if (sub === 'remove')  return cmdAgentRemove(args[2])
  if (sub === 'activity') return cmdAgentActivity(args[2], Number(args[3] ?? '20'))
  console.error('usage: wechat-cc agent <inspect|add|list|pause|resume|remove|activity>'); process.exit(1)
}
```

- [ ] **Step 4: Run CLI tests + manual smoke**

Run: `bun run test <agent CLI test file>`
Expected: PASS.

Manual smoke (against an in-memory state dir):
```bash
WECHAT_STATE_DIR=/tmp/wechat-cc-test bun src/cli.ts agent list
```
Expected: "no agents registered" (or whatever the empty case prints).

- [ ] **Step 5: Commit**

```bash
git add src/cli/agent.ts src/cli/agent.test.ts src/cli.ts  # adjust to actual files
git commit -m "feat(a2a): CLI subcommands — wechat-cc agent {inspect,add,list,remove,pause,resume,activity}"
```

---

### Task 7.5: Phase 1 README + integration smoke

**Files:**
- Modify: `README.md`
- Test: A new e2e in `src/daemon/__e2e__/a2a.test.ts` (vitest excludes __e2e__ from the main suite by default, but it's worth having)

- [ ] **Step 1: README updates**

Find the "Slash commands" or "Features" section and add a new "**A2A integration**" block:

```markdown
### A2A integration (P3, opt-in)

wechat-cc is an A2A-protocol node, both client and server:

- **Receive notifications from external A2A agents.** Configure `agent-config.json:a2a_listen` to start the inbound HTTP server (defaults to `127.0.0.1`, OFF by default).
- **Register an external agent.** `wechat-cc agent add <url>` fetches the Agent Card and writes the registration to `agent-config.json`. The inbound API key (generated locally) is what the external agent will use when calling `POST /a2a/notify`.
- **Reply to a notification.** When the operator sees `[A2A:<agent-id>] ...` in chat and tells claude/codex/cursor "tell them X", the agent calls the new MCP tool `a2a_send(agent_id, text)` to push the reply back via A2A.
- **Tier gating.** `a2a_send` is admin auto-allow, trusted relays through permission prompts, guest forbidden — same shape as `delegate_<peer>` tools.

CLI:
```
wechat-cc agent inspect <url>   # fetch Agent Card, print metadata
wechat-cc agent add <url>       # register, generate inbound key
wechat-cc agent list            # registered agents
wechat-cc agent pause <id>      # mute inbound + outbound
wechat-cc agent resume <id>     # un-mute
wechat-cc agent remove <id>     # drop registration
wechat-cc agent activity <id>   # recent A2A events for this agent
```

**Threat model:** A2A server is off by default; when enabled, binds `127.0.0.1` unless `agent-config.a2a_listen.host` is changed. Each registered agent has its own inbound API key (verified on every notify); no shared secrets. Outbound calls carry the agent-provided `outbound_api_key`. HTTPS is the operator's responsibility (TLS termination via reverse proxy if exposed publicly).
```

- [ ] **Step 2: Write integration smoke test (optional, in __e2e__/)**

If e2e harness is convenient, add a test that spins up wechat-cc with `a2a_listen` set + 1 registered agent + a mock external A2A server, posts notify → asserts the operator's chat sees `[A2A:...]` line. Otherwise skip — the unit + bootstrap tests cover the path.

- [ ] **Step 3: Commit**

```bash
git add README.md src/daemon/__e2e__/a2a.test.ts  # if added
git commit -m "docs(a2a): README section + (optional) e2e smoke"
```

---

## Phase 2 — Dashboard install flow

### Task 8: Internal-api endpoints for A2A

**Files:**
- Modify: `src/daemon/internal-api/schema.ts` (add zod schemas)
- Modify: `src/daemon/internal-api/routes.ts` (add routes)
- Modify: `src/daemon/internal-api/index.ts` (wire deps if new)
- Test: `src/daemon/internal-api.test.ts`

Add 7 routes that the dashboard UI will call:

| Method + Path | Purpose |
|---|---|
| `GET /v1/a2a/list` | All registered agents (with counts) |
| `POST /v1/a2a/preview` | Body: `{ url }` → fetches Agent Card, returns metadata (no install yet) |
| `POST /v1/a2a/install` | Body: `{ id, name, url, outbound_api_key }` → generates inbound key, persists, returns full record |
| `POST /v1/a2a/remove` | Body: `{ id }` |
| `POST /v1/a2a/pause` | Body: `{ id, paused: boolean }` |
| `GET /v1/a2a/activity?agent_id=<id>&limit=N` | Recent activity rows |
| `GET /v1/a2a/info` | Daemon's own A2A info: whether server is running, base URL, listening port |

- [ ] **Step 1: Write failing tests**

In `src/daemon/internal-api.test.ts`, add tests that exercise the new routes end-to-end through the internal-api dispatch. Follow existing test patterns (look for `memory/read` route tests — they use a request-with-body helper).

```ts
// Sketch — adapt to existing helpers:
describe('internal-api A2A routes', () => {
  it('GET /v1/a2a/list returns registered agents', async () => { ... })
  it('POST /v1/a2a/preview returns Agent Card metadata', async () => { ... })
  it('POST /v1/a2a/install persists a new agent and returns the inbound key', async () => { ... })
  it('POST /v1/a2a/remove drops an agent', async () => { ... })
  it('POST /v1/a2a/pause flips the paused flag', async () => { ... })
  it('GET /v1/a2a/activity returns recent events', async () => { ... })
  it('GET /v1/a2a/info returns server status', async () => { ... })
})
```

- [ ] **Step 2: Add zod schemas**

In `src/daemon/internal-api/schema.ts`, add:

```ts
export const A2APreviewRequest = z.object({ url: z.string().url() })
export const A2APreviewResponse = z.object({
  name: z.string(),
  description: z.string().optional(),
  version: z.string().optional(),
  auth: z.object({ type: z.string(), required: z.boolean() }).optional(),
  capabilities: z.array(z.object({
    name: z.string(), description: z.string().optional(),
    endpoint: z.string().optional(), method: z.string().optional(),
  })).optional(),
})

export const A2AInstallRequest = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  name: z.string().min(1).max(128),
  url: z.string().url(),
  outbound_api_key: z.string().default(''),
})
export const A2AInstallResponse = z.object({
  ok: z.boolean(),
  inbound_api_key: z.string().optional(),
  error: z.string().optional(),
})

export const A2ARemoveRequest = z.object({ id: z.string() })
export const A2APauseRequest = z.object({ id: z.string(), paused: z.boolean() })
export const A2AActivityQuery = z.object({ agent_id: z.string(), limit: z.coerce.number().int().min(1).max(500).default(50) })

export type A2APreviewRequestT = z.infer<typeof A2APreviewRequest>
export type A2AInstallRequestT = z.infer<typeof A2AInstallRequest>
export type A2ARemoveRequestT = z.infer<typeof A2ARemoveRequest>
export type A2APauseRequestT = z.infer<typeof A2APauseRequest>
```

Wire these into `index.ts`'s body-validation switch (find where other request types are dispatched, add the new ones).

- [ ] **Step 3: Implement routes**

In `src/daemon/internal-api/routes.ts`, add the new routes (and a `deps.a2a` accessor if not already present):

```ts
'GET /v1/a2a/list': () => {
  if (!deps.a2a) return { status: 503, body: { error: 'a2a_not_wired' } }
  const agents = deps.a2a.registry.list().map(a => ({
    id: a.id, name: a.name, url: a.url, paused: a.paused,
    counts: deps.a2a!.eventsStore.counts(a.id),
  }))
  return { status: 200, body: { agents } }
},

'POST /v1/a2a/preview': async (_q, body) => {
  if (!deps.a2a) return { status: 503, body: { error: 'a2a_not_wired' } }
  const { url } = body as A2APreviewRequestT
  try {
    const card = await deps.a2a.client.fetchAgentCard(url)
    return { status: 200, body: card }
  } catch (err) {
    return { status: 200, body: { error: errMsg(err) } }
  }
},

'POST /v1/a2a/install': (_q, body) => {
  if (!deps.a2a) return { status: 503, body: { error: 'a2a_not_wired' } }
  const { id, name, url, outbound_api_key } = body as A2AInstallRequestT
  try {
    const inboundKey = `wc_${crypto.randomBytes(16).toString('hex')}`
    deps.a2a.registry.add({
      id, name, url,
      inbound_api_key: inboundKey,
      outbound_api_key,
      capabilities: [],  // dashboard fetched the card; could pass through if we want
      paused: false,
    })
    return { status: 200, body: { ok: true, inbound_api_key: inboundKey } }
  } catch (err) {
    return { status: 200, body: { ok: false, error: errMsg(err) } }
  }
},

'POST /v1/a2a/remove': (_q, body) => {
  if (!deps.a2a) return { status: 503, body: { error: 'a2a_not_wired' } }
  const { id } = body as A2ARemoveRequestT
  try { deps.a2a.registry.remove(id); return { status: 200, body: { ok: true } } }
  catch (err) { return { status: 200, body: { ok: false, error: errMsg(err) } } }
},

'POST /v1/a2a/pause': (_q, body) => {
  if (!deps.a2a) return { status: 503, body: { error: 'a2a_not_wired' } }
  const { id, paused } = body as A2APauseRequestT
  try { deps.a2a.registry.setPaused(id, paused); return { status: 200, body: { ok: true } } }
  catch (err) { return { status: 200, body: { ok: false, error: errMsg(err) } } }
},

'GET /v1/a2a/activity': (q) => {
  if (!deps.a2a) return { status: 503, body: { error: 'a2a_not_wired' } }
  const agentId = q.get('agent_id')
  const limit = Number(q.get('limit') ?? '50')
  if (!agentId) return { status: 400, body: { error: 'agent_id required' } }
  return { status: 200, body: { events: deps.a2a.eventsStore.recentForAgent(agentId, limit) } }
},

'GET /v1/a2a/info': () => {
  if (!deps.a2a) return { status: 503, body: { error: 'a2a_not_wired' } }
  return {
    status: 200,
    body: {
      enabled: deps.a2a.serverEnabled,
      base_url: deps.a2a.baseUrl ?? null,
    },
  }
},
```

Pass `deps.a2a` from bootstrap as a new bundle: `{ registry, client, eventsStore, serverEnabled, baseUrl }`.

- [ ] **Step 4: Run tests + typecheck**

Run: `bun run test src/daemon/internal-api.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/internal-api/schema.ts src/daemon/internal-api/routes.ts src/daemon/internal-api/index.ts src/daemon/internal-api.test.ts src/daemon/bootstrap/index.ts
git commit -m "feat(a2a): internal-api endpoints for dashboard install/manage flow"
```

---

### Task 9: Dashboard "Agents (A2A)" tab

**Files:**
- Modify: `apps/desktop/src/index.html` (add tab markup)
- Create: `apps/desktop/src/modules/a2a-agents.js` (UI module)
- Modify: `apps/desktop/src/main.js` (wire tab init)
- CSS: extend the relevant stylesheet for the new tab styling

UI elements:
- Tab "Agents (A2A)"
- List view: cards per registered agent (name, url, paused indicator, counts, action buttons)
- "+ Add Agent" button → modal (URL input → fetch card → confirm → key input → install → toast with the generated inbound key + cURL example)
- "View activity" → drawer with paginated list

- [ ] **Step 1: HTML scaffolding**

Add a new tab in `index.html`:

```html
<button class="dash-tab" data-tab="a2a-agents">Agents (A2A)</button>

<section id="tab-a2a-agents" class="dash-tab-content" hidden>
  <header class="tab-header">
    <h2>External A2A Agents</h2>
    <button id="a2a-add-btn">+ Add Agent</button>
  </header>
  <ul id="a2a-agents-list"></ul>
</section>

<dialog id="a2a-add-modal">
  <h3>Add A2A Agent</h3>
  <form id="a2a-add-form">
    <label>Agent URL <input type="url" name="url" required placeholder="https://example.com/a2a"></label>
    <button type="submit">Fetch Agent Card →</button>
  </form>
  <section id="a2a-add-preview" hidden>
    <h4 id="a2a-preview-name"></h4>
    <p id="a2a-preview-description"></p>
    <ul id="a2a-preview-capabilities"></ul>
    <label>Local id (slug)<input name="id" required></label>
    <label>Outbound API key<input name="outbound_key" placeholder="From the agent's docs (optional)"></label>
    <button id="a2a-install-confirm">Install</button>
  </section>
  <section id="a2a-add-success" hidden>
    <p>Installed.</p>
    <pre id="a2a-add-curl"></pre>
    <button id="a2a-add-close">Close</button>
  </section>
</dialog>

<aside id="a2a-activity-drawer" class="drawer" hidden>
  <header><h3 id="a2a-activity-title"></h3><button id="a2a-activity-close">×</button></header>
  <ul id="a2a-activity-list"></ul>
</aside>
```

- [ ] **Step 2: JS module**

Create `apps/desktop/src/modules/a2a-agents.js`:

```js
// @ts-check
/**
 * Dashboard module: "Agents (A2A)" tab.
 * Renders the registered-agents list, hooks up Add Agent modal flow,
 * pause/resume/remove/activity actions.
 */

import { invokeApi } from '../api.js'  // adapt to actual API helper

export async function initA2AAgentsTab() {
  const list = document.getElementById('a2a-agents-list')
  if (!list) return
  await refresh()
  document.getElementById('a2a-add-btn')?.addEventListener('click', openAddModal)
  document.getElementById('a2a-add-form')?.addEventListener('submit', onPreviewSubmit)
  document.getElementById('a2a-install-confirm')?.addEventListener('click', onInstallConfirm)
  document.getElementById('a2a-add-close')?.addEventListener('click', closeAddModal)
  document.getElementById('a2a-activity-close')?.addEventListener('click', () => {
    document.getElementById('a2a-activity-drawer').hidden = true
  })
}

async function refresh() {
  const list = document.getElementById('a2a-agents-list')
  list.innerHTML = ''
  const { agents } = await invokeApi('GET', '/v1/a2a/list')
  if (!agents || agents.length === 0) {
    list.innerHTML = '<li class="empty">No agents registered. Click "+ Add Agent" to install one.</li>'
    return
  }
  for (const a of agents) {
    const li = document.createElement('li')
    li.className = 'a2a-agent-card' + (a.paused ? ' paused' : '')
    li.innerHTML = `
      <header>
        <span class="dot ${a.paused ? 'off' : 'on'}"></span>
        <strong>${escapeHtml(a.id)}</strong> · ${escapeHtml(a.name)}
      </header>
      <div class="url">${escapeHtml(a.url)}</div>
      <div class="counts">↓ ${a.counts.inbound} · ↑ ${a.counts.outbound}</div>
      <div class="actions">
        <button data-action="pause" data-id="${a.id}">${a.paused ? 'Resume' : 'Pause'}</button>
        <button data-action="activity" data-id="${a.id}">Activity</button>
        <button data-action="remove" data-id="${a.id}">Remove</button>
      </div>
    `
    list.appendChild(li)
  }
  list.addEventListener('click', onCardAction, { once: true })
}

async function onCardAction(e) {
  const target = e.target
  if (!(target instanceof HTMLButtonElement)) return
  const action = target.dataset.action
  const id = target.dataset.id
  if (!action || !id) return
  if (action === 'pause') {
    const card = target.closest('.a2a-agent-card')
    const wasPaused = card?.classList.contains('paused')
    await invokeApi('POST', '/v1/a2a/pause', { id, paused: !wasPaused })
    await refresh()
  } else if (action === 'remove') {
    if (!confirm(`Remove agent '${id}'?`)) return
    await invokeApi('POST', '/v1/a2a/remove', { id })
    await refresh()
  } else if (action === 'activity') {
    await openActivityDrawer(id)
  }
}

function openAddModal() {
  const modal = document.getElementById('a2a-add-modal')
  modal.querySelector('#a2a-add-preview').hidden = true
  modal.querySelector('#a2a-add-success').hidden = true
  modal.querySelector('#a2a-add-form').reset()
  modal.querySelector('#a2a-add-form').hidden = false
  modal.showModal()
}

function closeAddModal() {
  document.getElementById('a2a-add-modal').close()
  refresh()
}

let previewedCard = null
let previewedUrl = null

async function onPreviewSubmit(e) {
  e.preventDefault()
  const form = e.target
  const url = form.elements.url.value
  const r = await invokeApi('POST', '/v1/a2a/preview', { url })
  if (r.error) { alert(r.error); return }
  previewedCard = r
  previewedUrl = url
  document.getElementById('a2a-preview-name').textContent = r.name
  document.getElementById('a2a-preview-description').textContent = r.description ?? ''
  const ul = document.getElementById('a2a-preview-capabilities')
  ul.innerHTML = ''
  for (const c of (r.capabilities ?? [])) {
    const li = document.createElement('li')
    li.textContent = `${c.name}${c.description ? ' — ' + c.description : ''}`
    ul.appendChild(li)
  }
  form.hidden = true
  document.getElementById('a2a-add-preview').hidden = false
  document.getElementById('a2a-add-preview').querySelector('input[name=id]').value = slugify(r.name)
}

async function onInstallConfirm() {
  const preview = document.getElementById('a2a-add-preview')
  const id = preview.querySelector('input[name=id]').value
  const outboundKey = preview.querySelector('input[name=outbound_key]').value
  const r = await invokeApi('POST', '/v1/a2a/install', {
    id, name: previewedCard.name, url: previewedUrl, outbound_api_key: outboundKey,
  })
  if (!r.ok) { alert(r.error); return }
  const info = await invokeApi('GET', '/v1/a2a/info')
  preview.hidden = true
  const success = document.getElementById('a2a-add-success')
  success.hidden = false
  const baseUrl = info.base_url ?? '<wechat-cc-base-url>'
  document.getElementById('a2a-add-curl').textContent =
    `curl -X POST ${baseUrl}/a2a/notify \\\n` +
    `  -H "Authorization: Bearer ${r.inbound_api_key}" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{"agent_id":"${id}","text":"hello"}'`
}

async function openActivityDrawer(id) {
  const drawer = document.getElementById('a2a-activity-drawer')
  document.getElementById('a2a-activity-title').textContent = id
  const r = await invokeApi('GET', `/v1/a2a/activity?agent_id=${encodeURIComponent(id)}&limit=50`)
  const ul = document.getElementById('a2a-activity-list')
  ul.innerHTML = ''
  if (!r.events || r.events.length === 0) {
    ul.innerHTML = '<li class="empty">No activity yet.</li>'
  } else {
    for (const e of r.events) {
      const li = document.createElement('li')
      li.className = `event ${e.direction}`
      const arrow = e.direction === 'in' ? '←' : '→'
      const status = e.status === 'ok' ? '' : ` [${e.status}${e.http_status ? ' ' + e.http_status : ''}]`
      li.innerHTML = `<time>${escapeHtml(e.ts)}</time> ${arrow} ${escapeHtml(e.text)}${status}`
      ul.appendChild(li)
    }
  }
  drawer.hidden = false
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[m]))
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}
```

- [ ] **Step 3: Wire tab init in main.js**

Add `initA2AAgentsTab()` call after other tab initializations in `apps/desktop/src/main.js`. Hook up tab-switching to call `refresh()` when tab becomes active.

- [ ] **Step 4: Add minimal CSS**

In the dashboard's stylesheet, add:

```css
.a2a-agent-card { padding: 12px; border: 1px solid #ddd; border-radius: 6px; margin-bottom: 8px; }
.a2a-agent-card.paused { opacity: 0.55; }
.a2a-agent-card .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
.a2a-agent-card .dot.on { background: #10b981; }
.a2a-agent-card .dot.off { background: #9ca3af; }
.a2a-agent-card .actions button { margin-right: 4px; }
#a2a-add-modal pre { background: #f3f4f6; padding: 8px; font-size: 12px; overflow-x: auto; }
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/index.html apps/desktop/src/modules/a2a-agents.js apps/desktop/src/main.js apps/desktop/src/style.css
git commit -m "feat(a2a): dashboard 'Agents (A2A)' tab — list + Add Agent flow + activity drawer"
```

---

### Task 10: Playwright tests for dashboard A2A flow

**Files:**
- Create: `apps/desktop/playwright/a2a.spec.ts`

Test the UI end-to-end against the test-shim (DRY_RUN=1). Mock the internal-api responses for `/v1/a2a/*` routes.

- [ ] **Step 1: Inspect existing playwright fixture / shim**

Run: `cat apps/desktop/playwright/fixtures.ts && head -50 apps/desktop/test-shim.ts 2>/dev/null`

Look at the existing wizard.spec.ts test file for the pattern of shim invocation + DOM assertions.

- [ ] **Step 2: Write the spec**

Create `apps/desktop/playwright/a2a.spec.ts`:

```ts
import { test, expect } from './fixtures'

test('A2A tab renders empty state when no agents registered', async ({ page, shimUrl, shim }) => {
  // Reset shim to no agents
  await shim.invoke('demo.seed')  // or whatever resets state
  await page.goto(shimUrl)
  await page.waitForFunction(
    () => ['wizard', 'dashboard'].includes(document.documentElement.dataset.mode ?? ''),
    { timeout: 15_000 }
  )
  // Switch to dashboard if needed
  // ...
  await page.click('[data-tab="a2a-agents"]')
  await expect(page.locator('#a2a-agents-list .empty')).toBeVisible()
})

test('Add Agent flow: paste URL → preview → install → see in list', async ({ page, shimUrl, shim }) => {
  // The shim should be configured to mock /v1/a2a/preview and /v1/a2a/install responses.
  // If the shim doesn't yet support those routes, add the mocks (see test-shim.ts).
  await page.goto(shimUrl)
  await page.waitForFunction(
    () => ['wizard', 'dashboard'].includes(document.documentElement.dataset.mode ?? ''),
    { timeout: 15_000 }
  )
  await page.click('[data-tab="a2a-agents"]')
  await page.click('#a2a-add-btn')
  await page.locator('#a2a-add-modal').waitFor({ state: 'visible' })
  await page.fill('#a2a-add-form input[name=url]', 'https://fake.example.com/a2a')
  await page.click('#a2a-add-form button[type=submit]')
  await expect(page.locator('#a2a-add-preview')).toBeVisible()
  await page.fill('#a2a-add-preview input[name=id]', 'fake-bot')
  await page.click('#a2a-install-confirm')
  await expect(page.locator('#a2a-add-success')).toBeVisible()
  await expect(page.locator('#a2a-add-curl')).toContainText('Authorization: Bearer wc_')
  await page.click('#a2a-add-close')
  // List should now show the agent
  await expect(page.locator('#a2a-agents-list .a2a-agent-card')).toHaveCount(1)
  await expect(page.locator('#a2a-agents-list')).toContainText('fake-bot')
})

test('Pause / Resume toggles the agent state', async ({ page, shimUrl, shim }) => {
  // Setup: 1 agent pre-registered via shim
  // Click pause → list shows paused class → click resume → unpaused
})

test('Activity drawer opens with recent events', async ({ page, shimUrl, shim }) => {
  // Setup: 1 agent + 2 inbound + 1 outbound event
  // Click Activity → drawer opens → 3 event rows visible
})
```

- [ ] **Step 3: Update test-shim to mock /v1/a2a/* if needed**

In `apps/desktop/test-shim.ts`, add mock handlers for the new internal-api routes. Follow the existing pattern for how other routes (e.g. `/v1/projects/list`) are mocked.

- [ ] **Step 4: Run playwright tests**

Run: `bun x playwright install chromium` (if not yet)
Run: `bun run test:e2e` (or whatever the playwright runner script is)
Expected: all new A2A tests pass + no regression on existing wizard tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/playwright/a2a.spec.ts apps/desktop/test-shim.ts
git commit -m "test(a2a): playwright coverage for dashboard install flow"
```

---

## Acceptance Gate

Done when:

- [ ] `wechat-cc agent add <url>` fetches the Agent Card, prompts for id/keys, persists to `agent-config.json`
- [ ] With `a2a_listen` configured, daemon's `/.well-known/agent.json` returns the Card; `POST /a2a/notify` with valid Bearer routes through to the operator's chat as `[A2A:<id>] ...` line
- [ ] Operator says "tell deploy-bot retry" → claude calls a2a_send → external endpoint receives the POST with `text: "retry"`
- [ ] Tier gating works: admin auto-allows a2a_send, trusted relays via permission prompt, guest forbids
- [ ] DB migration v12 applies cleanly; v11→v12 forward; existing migrations unaffected
- [ ] `a2a_events` table populated on each inbound/outbound; dashboard activity drawer lists rows
- [ ] Dashboard "Agents (A2A)" tab: list, add (paste URL → fetch card → confirm → install), pause/resume, remove, activity drawer
- [ ] Playwright covers the install flow end-to-end
- [ ] Threat-model defaults verified: A2A server OFF by default; when enabled, binds 127.0.0.1
- [ ] Full unit + integration suite passes; no regression in claude/codex/cursor/N-way paths
- [ ] README documents the new agent management commands + dashboard tab + threat-model defaults

If all green: invoke `superpowers:finishing-a-development-branch`.
