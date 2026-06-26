import { describe, it, expect, vi } from 'vitest'
import {
  createCursorAgentProvider,
  mapCursorMessage,
  mapCursorToolName,
  tierProfileToCursorSdkOpts,
} from './cursor-agent-provider'
import { TIER_PROFILES } from './user-tier'

describe('tierProfileToCursorSdkOpts', () => {
  it('dangerously mode → sandbox disabled regardless of tier', () => {
    // Operator override: --dangerously short-circuits all tiers.
    for (const tier of [TIER_PROFILES.admin, TIER_PROFILES.trusted, TIER_PROFILES.guest]) {
      expect(tierProfileToCursorSdkOpts(tier, 'dangerously').sandboxOptions.enabled).toBe(false)
    }
  })

  it('strict mode → sandbox enabled regardless of tier (cursor has no per-tool gate)', () => {
    // Post-RFC-05: cursor strict mode always sandboxes. Cursor can't
    // enforce the relay portion of admin/trusted tier profiles, so the
    // safer default is "sandboxed unless operator explicitly bypassed".
    // Pre-C4 admin tier got sandbox-off via the relay+deny-empty
    // shortcut; that's now reserved for --dangerously.
    for (const tier of [TIER_PROFILES.admin, TIER_PROFILES.trusted, TIER_PROFILES.guest]) {
      expect(tierProfileToCursorSdkOpts(tier, 'strict').sandboxOptions.enabled).toBe(true)
    }
  })
})

describe('mapCursorToolName', () => {
  const mcpServers = new Set(['wechat', 'delegate'])

  it('parses Anthropic-style mcp__<server>__<tool>', () => {
    expect(mapCursorToolName('mcp__wechat__reply', mcpServers)).toEqual({
      server: 'wechat', tool: 'reply',
    })
  })

  it('parses double-underscore <server>__<tool>', () => {
    expect(mapCursorToolName('wechat__reply', mcpServers)).toEqual({
      server: 'wechat', tool: 'reply',
    })
  })

  it('parses colon-separated <server>:<tool>', () => {
    expect(mapCursorToolName('wechat:reply', mcpServers)).toEqual({
      server: 'wechat', tool: 'reply',
    })
  })

  it('parses slash-separated <server>/<tool>', () => {
    expect(mapCursorToolName('wechat/reply', mcpServers)).toEqual({
      server: 'wechat', tool: 'reply',
    })
  })

  it('unknown server falls back to no-server (built-in)', () => {
    expect(mapCursorToolName('Read', mcpServers)).toEqual({ tool: 'Read' })
  })

  it('mcp__-prefix with unknown server falls back', () => {
    expect(mapCursorToolName('mcp__unknown__foo', mcpServers)).toEqual({
      tool: 'mcp__unknown__foo',
    })
  })

  it('handles tool name with multiple separators (greedy split on first match)', () => {
    expect(mapCursorToolName('wechat__memory__read', mcpServers)).toEqual({
      server: 'wechat', tool: 'memory__read',
    })
  })

  it('accepts MCP server names that contain underscores', () => {
    // Pre-fix the regex `^mcp__([^_]+)__` rejected any underscore in
    // the server name; the fallback indexOf('__') then matched the
    // literal `mcp` prefix instead of the server, so the call
    // resolved to no server at all. Sort longest-first so
    // `compass_sidecar` matches before `compass`.
    const servers = new Set(['compass', 'compass_sidecar', 'delegate_v2'])
    expect(mapCursorToolName('mcp__compass_sidecar__call', servers)).toEqual({
      server: 'compass_sidecar', tool: 'call',
    })
    expect(mapCursorToolName('mcp__delegate_v2__lookup', servers)).toEqual({
      server: 'delegate_v2', tool: 'lookup',
    })
    expect(mapCursorToolName('compass_sidecar__call', servers)).toEqual({
      server: 'compass_sidecar', tool: 'call',
    })
  })

  it('longer server name wins over shorter prefix', () => {
    // `delegate_v2__x` must not be parsed as server `delegate` + tool
    // `v2__x`; longest-first sort ensures the v2 server is tried first.
    const servers = new Set(['delegate', 'delegate_v2'])
    expect(mapCursorToolName('delegate_v2__x', servers)).toEqual({
      server: 'delegate_v2', tool: 'x',
    })
  })
})

// mapCursorMessage uses the project's real AgentEvent shape (text /
// tool_call / result / error), which differs from the speculative
// `assistant_text` + `result.error` shape sketched in the spec table.
// Codex/Claude mappers established this pattern: errors flow as
// `{ kind: 'error', message }`, not as a field on a `result` event.
describe('mapCursorMessage', () => {
  const mcpServers = new Set(['wechat', 'delegate'])

  it('assistant text block → text event', () => {
    const msg = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    }
    const events = [...mapCursorMessage(msg as never, mcpServers, 'agent-1')]
    expect(events).toEqual([{ kind: 'text', text: 'hello' }])
  })

  it('assistant tool_use → tool_call event with server/tool', () => {
    const msg = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          name: 'mcp__wechat__reply',
          input: { text: 'hi' },
          id: 'call-1',
        }],
      },
    }
    const events = [...mapCursorMessage(msg as never, mcpServers, 'agent-1')]
    expect(events).toEqual([{ kind: 'tool_call', server: 'wechat', tool: 'reply' }])
  })

  it('assistant tool_use with unknown server → tool_call without server', () => {
    const msg = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Read', input: {}, id: 'call-2' }],
      },
    }
    const events = [...mapCursorMessage(msg as never, mcpServers, 'agent-1')]
    expect(events).toEqual([{ kind: 'tool_call', tool: 'Read' }])
  })

  it('assistant message with multiple blocks yields one event per block', () => {
    const msg = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'thinking...' },
          { type: 'tool_use', name: 'mcp__wechat__reply', input: {}, id: 'c' },
          { type: 'text', text: 'done' },
        ],
      },
    }
    const events = [...mapCursorMessage(msg as never, mcpServers, 'agent-1')]
    expect(events).toEqual([
      { kind: 'text', text: 'thinking...' },
      { kind: 'tool_call', server: 'wechat', tool: 'reply' },
      { kind: 'text', text: 'done' },
    ])
  })

  it('status: FINISHED → result event with agentId as sessionId', () => {
    const msg = { type: 'status', status: 'FINISHED' }
    const events = [...mapCursorMessage(msg as never, mcpServers, 'agent-1')]
    expect(events).toEqual([
      { kind: 'result', sessionId: 'agent-1', numTurns: 0, durationMs: 0 },
    ])
  })

  it('status: ERROR → error event with provider message', () => {
    const msg = { type: 'status', status: 'ERROR', error: { message: 'rate limited' } }
    const events = [...mapCursorMessage(msg as never, mcpServers, 'agent-1')]
    expect(events).toEqual([{ kind: 'error', message: 'rate limited' }])
  })

  it('status: ERROR without error.message → error event with fallback string', () => {
    const msg = { type: 'status', status: 'ERROR' }
    const events = [...mapCursorMessage(msg as never, mcpServers, 'agent-1')]
    expect(events).toEqual([{ kind: 'error', message: 'cursor agent error' }])
  })

  it('status: CANCELLED → error event with cancelled message', () => {
    const msg = { type: 'status', status: 'CANCELLED' }
    const events = [...mapCursorMessage(msg as never, mcpServers, 'agent-1')]
    expect(events).toEqual([{ kind: 'error', message: 'cancelled' }])
  })

  it('status: EXPIRED → error event with expired message', () => {
    const msg = { type: 'status', status: 'EXPIRED' }
    const events = [...mapCursorMessage(msg as never, mcpServers, 'agent-1')]
    expect(events).toEqual([{ kind: 'error', message: 'expired' }])
  })

  it('thinking / system / user / request / task / RUNNING / CREATING → dropped', () => {
    const cases: Array<Record<string, unknown>> = [
      { type: 'thinking', text: '...' },
      { type: 'system', subtype: 'init' },
      { type: 'user', message: { role: 'user', content: [] } },
      { type: 'request', request_id: 'r1' },
      { type: 'task', text: 'progress' },
      { type: 'status', status: 'RUNNING' },
      { type: 'status', status: 'CREATING' },
    ]
    for (const msg of cases) {
      const events = [...mapCursorMessage(msg as never, mcpServers, 'agent-1')]
      expect(events).toEqual([])
    }
  })

  it('empty text block is dropped (not a zero-length text event)', () => {
    const msg = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '' }] },
    }
    const events = [...mapCursorMessage(msg as never, mcpServers, 'agent-1')]
    expect(events).toEqual([])
  })
})

// Minimal fake of @cursor/sdk's Agent for unit testing
function makeFakeAgent(scriptedMessages: unknown[]) {
  return {
    agentId: 'agent-test-1',
    async send() {
      return {
        id: 'run-1',
        agentId: 'agent-test-1',
        status: 'RUNNING' as const,
        async *stream() {
          for (const m of scriptedMessages) yield m
        },
        async wait() { return { status: 'completed' } },
        async cancel() {},
      }
    },
    close() {},
    async reload() {},
  }
}

function makeFakeSdk(agent: ReturnType<typeof makeFakeAgent>) {
  return {
    Agent: {
      create: vi.fn(async (_opts: Record<string, unknown>) => agent),
      resume: vi.fn(async (_agentId: string, _opts?: Record<string, unknown>) => agent),
    },
  }
}

describe('createCursorAgentProvider', () => {
  it('per-spawn spawnOpts.model overrides the construction-time model (/model hot-reload)', async () => {
    const agent = makeFakeAgent([{ type: 'status', status: 'FINISHED' }])
    const sdk = makeFakeSdk(agent)
    const provider = createCursorAgentProvider({ sdk, apiKey: 'k', model: 'composer-2' })
    await provider.spawn(
      { alias: 'P', path: '/tmp/proj' },
      { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: 'c', model: 'composer-3' },
    )
    const createArgs = sdk.Agent.create.mock.calls[0]![0] as Record<string, unknown>
    expect(createArgs.model).toEqual({ id: 'composer-3' })
  })

  it('spawn calls Agent.create with apiKey + model + mcpServers + dangerously sandbox-off', async () => {
    const agent = makeFakeAgent([{ type: 'status', status: 'FINISHED' }])
    const sdk = makeFakeSdk(agent)
    const provider = createCursorAgentProvider({
      sdk,
      apiKey: 'test-key',
      model: 'composer-2',
      mcpServers: { wechat: { command: 'node', args: ['mcp.js'] } },
    })
    // RFC 05: cursor's sandbox-off only fires on `permissionMode='dangerously'`.
    // Strict mode (any tier) always sandboxes — cursor has no per-tool gate.
    const session = await provider.spawn(
      { alias: 'P', path: '/tmp/proj' },
      { tierProfile: TIER_PROFILES.admin, permissionMode: 'dangerously', chatId: 'admin-chat', mcpEnv: { WECHAT_SESSION_TIER: 'admin' } },
    )
    expect(sdk.Agent.create).toHaveBeenCalledTimes(1)
    const createArgs = sdk.Agent.create.mock.calls[0]![0] as Record<string, unknown>
    expect(createArgs.apiKey).toBe('test-key')
    expect(createArgs.model).toEqual({ id: 'composer-2' })
    // mcpServers carries the daemon-supplied mcpEnv overlay (tier only here).
    expect(createArgs.mcpServers).toEqual({ wechat: { command: 'node', args: ['mcp.js'], env: { WECHAT_SESSION_TIER: 'admin' } } })
    expect((createArgs.local as Record<string, unknown>).cwd).toBe('/tmp/proj')
    expect((createArgs.local as { sandboxOptions: { enabled: boolean } }).sandboxOptions.enabled).toBe(false)
    expect(session).toBeDefined()
  })

  it('merges WECHAT_SESSION_TOKEN/TIER into its MCP servers env on spawn', async () => {
    const agent = makeFakeAgent([{ type: 'status', status: 'FINISHED' }])
    const sdk = makeFakeSdk(agent)
    const provider = createCursorAgentProvider({
      sdk, apiKey: 'k', mcpServers: { wechat: { command: 'node', args: ['m.js'], env: { A: '1' } } },
    })
    await provider.spawn(
      { alias: 'P', path: '/tmp/p' },
      { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: 'c', mcpEnv: { WECHAT_SESSION_TOKEN: 'tok-1', WECHAT_SESSION_TIER: 'admin' } },
    )
    const createArgs = sdk.Agent.create.mock.calls[0]![0] as { mcpServers: Record<string, { env?: Record<string, string> }> }
    expect(createArgs.mcpServers.wechat!.env).toMatchObject({ A: '1', WECHAT_SESSION_TOKEN: 'tok-1', WECHAT_SESSION_TIER: 'admin' })
  })

  it('guest tier results in sandboxOptions.enabled=true', async () => {
    const agent = makeFakeAgent([{ type: 'status', status: 'FINISHED' }])
    const sdk = makeFakeSdk(agent)
    const provider = createCursorAgentProvider({ sdk, apiKey: 'test-key' })
    await provider.spawn(
      { alias: 'P', path: '/tmp/proj' },
      { tierProfile: TIER_PROFILES.guest, permissionMode: 'strict', chatId: 'guest-chat' },
    )
    const createArgs = sdk.Agent.create.mock.calls[0]![0] as Record<string, unknown>
    expect((createArgs.local as { sandboxOptions: { enabled: boolean } }).sandboxOptions.enabled).toBe(true)
  })

  it('dispatch yields text events from agent.send stream', async () => {
    const agent = makeFakeAgent([
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
      { type: 'status', status: 'FINISHED' },
    ])
    const sdk = makeFakeSdk(agent)
    const provider = createCursorAgentProvider({ sdk, apiKey: 'test-key' })
    const session = await provider.spawn(
      { alias: 'P', path: '/tmp/proj' },
      { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: 'c' },
    )
    const events: any[] = []
    for await (const ev of session.dispatch('hi')) events.push(ev)
    // Find at least one text event with 'hello', and one result event with sessionId
    expect(events).toContainEqual({ kind: 'text', text: 'hello' })
    const result = events.find(ev => ev.kind === 'result')
    expect(result).toBeDefined()
    expect(result.sessionId).toBe('agent-test-1')
  })

  it('close() calls agent.close', async () => {
    const agent = makeFakeAgent([{ type: 'status', status: 'FINISHED' }])
    const closeSpy = vi.spyOn(agent, 'close')
    const sdk = makeFakeSdk(agent)
    const provider = createCursorAgentProvider({ sdk, apiKey: 'test-key' })
    const session = await provider.spawn(
      { alias: 'P', path: '/tmp/proj' },
      { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: 'c' },
    )
    await session.close()
    expect(closeSpy).toHaveBeenCalled()
  })

  it('error during stream becomes error event', async () => {
    const agent = makeFakeAgent([
      { type: 'status', status: 'ERROR', error: { message: 'auth_failed' } },
    ])
    const sdk = makeFakeSdk(agent)
    const provider = createCursorAgentProvider({ sdk, apiKey: 'test-key' })
    const session = await provider.spawn(
      { alias: 'P', path: '/tmp/proj' },
      { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: 'c' },
    )
    const events: any[] = []
    for await (const ev of session.dispatch('hi')) events.push(ev)
    expect(events).toContainEqual({ kind: 'error', message: 'auth_failed' })
  })

  it('spawn with resumeSessionId calls Agent.resume instead of Agent.create', async () => {
    // Regression: pre-fix the provider always called Agent.create even
    // when spawnOpts.resumeSessionId was set, so Cursor sessions cold-
    // started on every daemon restart and the user's chat history was
    // silently lost.
    const agent = makeFakeAgent([{ type: 'status', status: 'FINISHED' }])
    const sdk = makeFakeSdk(agent)
    const provider = createCursorAgentProvider({ sdk, apiKey: 'test-key' })
    await provider.spawn(
      { alias: 'P', path: '/tmp/proj' },
      { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: 'c', resumeSessionId: 'agent-prior' },
    )
    expect(sdk.Agent.resume).toHaveBeenCalledTimes(1)
    expect(sdk.Agent.create).not.toHaveBeenCalled()
    expect(sdk.Agent.resume.mock.calls[0]![0]).toBe('agent-prior')
  })

  it('spawn falls back to Agent.create when Agent.resume throws', async () => {
    // Resume can fail legitimately (agent expired, sdk-side delete) — we
    // must fall through to a fresh agent so the user still gets a reply.
    const agent = makeFakeAgent([{ type: 'status', status: 'FINISHED' }])
    const sdk = {
      Agent: {
        create: vi.fn(async (_opts: Record<string, unknown>) => agent),
        resume: vi.fn(async (_agentId: string, _opts?: Record<string, unknown>) => {
          throw new Error('agent expired')
        }),
      },
    }
    const provider = createCursorAgentProvider({ sdk, apiKey: 'test-key' })
    await provider.spawn(
      { alias: 'P', path: '/tmp/proj' },
      { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: 'c', resumeSessionId: 'agent-stale' },
    )
    expect(sdk.Agent.resume).toHaveBeenCalledTimes(1)
    expect(sdk.Agent.create).toHaveBeenCalledTimes(1)
  })
})
