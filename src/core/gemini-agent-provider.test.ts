import { describe, it, expect } from 'vitest'
import { GEMINI_CAPABILITIES, tierProfileToGeminiSdkOpts, mcpToolsToFunctionDeclarations, runDispatchLoop, type GenaiPort, type McpPort } from './gemini-agent-provider'
import { TIER_PROFILES } from './user-tier'
import { collectTurn } from './agent-provider'

describe('GEMINI_CAPABILITIES', () => {
  it('declares per-tool gating, no SDK sandbox, no delegation/resume in v1', () => {
    expect(GEMINI_CAPABILITIES.perToolCallback).toBe(true)
    expect([...GEMINI_CAPABILITIES.sandboxLevels]).toEqual([])
    expect(GEMINI_CAPABILITIES.supportsDelegation).toBe(false)
    expect(GEMINI_CAPABILITIES.supportsResume).toBe(false)
  })
})

describe('tierProfileToGeminiSdkOpts', () => {
  it('dangerously → gate disabled; strict → gate enabled (all tiers)', () => {
    expect(tierProfileToGeminiSdkOpts(TIER_PROFILES.admin, 'dangerously')).toEqual({ gateEnabled: false })
    expect(tierProfileToGeminiSdkOpts(TIER_PROFILES.admin, 'strict')).toEqual({ gateEnabled: true })
    expect(tierProfileToGeminiSdkOpts(TIER_PROFILES.guest, 'strict')).toEqual({ gateEnabled: true })
  })
})

describe('mcpToolsToFunctionDeclarations', () => {
  it('maps MCP tools to Gemini functionDeclarations, stripping JSON-Schema meta keys', () => {
    const mcpTools = [
      { name: 'reply', description: 'reply to the user', inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, text: { type: 'string' } }, required: ['chat_id', 'text'], $schema: 'http://json-schema.org/draft-07/schema#', additionalProperties: false } },
      { name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {}, $schema: 'http://json-schema.org/draft-07/schema#' } },
    ]
    const fns = mcpToolsToFunctionDeclarations(mcpTools)
    expect(fns).toEqual([
      { name: 'reply', description: 'reply to the user', parameters: { type: 'object', properties: { chat_id: { type: 'string' }, text: { type: 'string' } }, required: ['chat_id', 'text'] } },
      { name: 'ping', description: 'ping', parameters: { type: 'object', properties: {} } },
    ])
  })
})

function fakeGenai(responses: Array<{ text?: string; functionCalls?: Array<{ name: string; args: Record<string, unknown> }> }>): GenaiPort {
  let i = 0
  return {
    async generateContent() {
      const r = responses[i++] ?? { text: '' }
      return { text: r.text ?? '', functionCalls: r.functionCalls }
    },
  }
}
function fakeMcp(results: Record<string, unknown>): McpPort {
  return {
    async callTool(name) {
      return { content: [{ type: 'text', text: JSON.stringify(results[name] ?? { ok: true }) }] }
    },
  }
}

describe('runDispatchLoop', () => {
  it('emits text then result for a no-tool turn', async () => {
    const history: any[] = []
    const events = runDispatchLoop({
      genai: fakeGenai([{ text: 'hello there' }]),
      mcp: fakeMcp({}),
      gate: async () => ({ allow: true }),
      model: 'gemini-flash-latest', systemInstruction: 'sys', functionDeclarations: [],
      history, sessionId: 's1', userText: 'hi',
    })
    const summary = await collectTurn(events)
    expect(summary.assistantText.join('')).toBe('hello there')
    expect(summary.result?.sessionId).toBe('s1')
    expect(history.length).toBe(2)
    expect(history[0]).toEqual({ role: 'user', parts: [{ text: 'hi' }] })
  })

  it('runs a tool round: functionCall → tool_call event → execute → functionResponse → final text', async () => {
    const history: any[] = []
    const calls: string[] = []
    const events = runDispatchLoop({
      genai: fakeGenai([
        { functionCalls: [{ name: 'reply', args: { chat_id: 'c', text: 'hi user' } }] },
        { text: 'done' },
      ]),
      mcp: { async callTool(name, args) { calls.push(`${name}:${JSON.stringify(args)}`); return { content: [{ type: 'text', text: '{"ok":true}' }] } } },
      gate: async () => ({ allow: true }),
      model: 'm', systemInstruction: 'sys', functionDeclarations: [{ name: 'reply' }],
      history, sessionId: 's2', userText: 'say hi',
    })
    const evs: any[] = []
    for await (const e of events) evs.push(e)
    expect(evs.find(e => e.kind === 'tool_call')).toEqual({ kind: 'tool_call', server: 'wechat', tool: 'reply' })
    expect(calls).toEqual(['reply:{"chat_id":"c","text":"hi user"}'])
    expect(evs.some(e => e.kind === 'text' && e.text === 'done')).toBe(true)
    expect(evs.at(-1).kind).toBe('result')
    expect(history.length).toBe(4)
    expect(history[2]).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'reply', response: { content: [{ type: 'text', text: '{"ok":true}' }] } } }] })
  })

  it('denied tool: no callTool, synthesizes an error functionResponse, model continues', async () => {
    const history: any[] = []
    let executed = false
    const events = runDispatchLoop({
      genai: fakeGenai([
        { functionCalls: [{ name: 'memory_delete', args: { path: 'x' } }] },
        { text: 'ok, I will not delete' },
      ]),
      mcp: { async callTool() { executed = true; return { content: [] } } },
      gate: async (tool) => tool === 'memory_delete' ? { allow: false, message: 'denied by tier' } : { allow: true },
      model: 'm', systemInstruction: 's', functionDeclarations: [{ name: 'memory_delete' }],
      history, sessionId: 's3', userText: 'delete x',
    })
    const evs: any[] = []
    for await (const e of events) evs.push(e)
    expect(executed).toBe(false)
    expect(history[2]).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'memory_delete', response: { error: 'denied by tier' } } }] })
    expect(evs.some(e => e.kind === 'text' && e.text === 'ok, I will not delete')).toBe(true)
  })

  it('caps tool rounds to avoid infinite loops', async () => {
    const history: any[] = []
    const genai: GenaiPort = { async generateContent() { return { text: '', functionCalls: [{ name: 'ping', args: {} }] } } }
    const events = runDispatchLoop({
      genai, mcp: fakeMcp({}), gate: async () => ({ allow: true }),
      model: 'm', systemInstruction: 's', functionDeclarations: [{ name: 'ping' }],
      history, sessionId: 's4', userText: 'loop', maxRounds: 3,
    })
    const summary = await collectTurn(events)
    expect(summary.result || summary.error).toBeTruthy()
    // multi-dispatch safety: capped history must end on a model turn, not user
    expect((history.at(-1) as any).role).toBe('model')
  })
})
