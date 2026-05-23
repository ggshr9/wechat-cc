import { describe, it, expect, vi } from 'vitest'
import {
  createCursorAgentProvider,
  mapCursorMessage,
  mapCursorToolName,
  tierProfileToCursorSdkOpts,
} from './cursor-agent-provider'
import { TIER_PROFILES } from './user-tier'

describe('tierProfileToCursorSdkOpts', () => {
  it('admin → sandbox disabled', () => {
    const out = tierProfileToCursorSdkOpts(TIER_PROFILES.admin)
    expect(out.sandboxOptions.enabled).toBe(false)
  })

  it('trusted → sandbox enabled', () => {
    const out = tierProfileToCursorSdkOpts(TIER_PROFILES.trusted)
    expect(out.sandboxOptions.enabled).toBe(true)
  })

  it('guest → sandbox enabled (lossier than codex read-only; documented)', () => {
    const out = tierProfileToCursorSdkOpts(TIER_PROFILES.guest)
    expect(out.sandboxOptions.enabled).toBe(true)
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
  it('spawn calls Agent.create with apiKey + model + mcpServers + tier-derived sandbox', async () => {
    const agent = makeFakeAgent([{ type: 'status', status: 'FINISHED' }])
    const sdk = makeFakeSdk(agent)
    const provider = createCursorAgentProvider({
      sdk,
      apiKey: 'test-key',
      model: 'composer-2',
      mcpServers: { wechat: { command: 'node', args: ['mcp.js'] } },
    })
    const session = await provider.spawn(
      { alias: 'P', path: '/tmp/proj' },
      { tierProfile: TIER_PROFILES.admin, chatId: 'admin-chat' },
    )
    expect(sdk.Agent.create).toHaveBeenCalledTimes(1)
    const createArgs = sdk.Agent.create.mock.calls[0]![0] as Record<string, unknown>
    expect(createArgs.apiKey).toBe('test-key')
    expect(createArgs.model).toEqual({ id: 'composer-2' })
    expect(createArgs.mcpServers).toEqual({ wechat: { command: 'node', args: ['mcp.js'] } })
    expect((createArgs.local as Record<string, unknown>).cwd).toBe('/tmp/proj')
    expect((createArgs.local as { sandboxOptions: { enabled: boolean } }).sandboxOptions.enabled).toBe(false)
    expect(session).toBeDefined()
  })

  it('guest tier results in sandboxOptions.enabled=true', async () => {
    const agent = makeFakeAgent([{ type: 'status', status: 'FINISHED' }])
    const sdk = makeFakeSdk(agent)
    const provider = createCursorAgentProvider({ sdk, apiKey: 'test-key' })
    await provider.spawn(
      { alias: 'P', path: '/tmp/proj' },
      { tierProfile: TIER_PROFILES.guest, chatId: 'guest-chat' },
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
      { tierProfile: TIER_PROFILES.admin, chatId: 'c' },
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
      { tierProfile: TIER_PROFILES.admin, chatId: 'c' },
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
      { tierProfile: TIER_PROFILES.admin, chatId: 'c' },
    )
    const events: any[] = []
    for await (const ev of session.dispatch('hi')) events.push(ev)
    expect(events).toContainEqual({ kind: 'error', message: 'auth_failed' })
  })
})
