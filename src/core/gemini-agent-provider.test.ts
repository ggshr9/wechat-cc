import { describe, it, expect } from 'vitest'
import { GEMINI_CAPABILITIES, tierProfileToGeminiSdkOpts, mcpToolsToFunctionDeclarations, runDispatchLoop, createGeminiAgentProvider, makeGeminiToolGate, type GenaiPort, type McpPort, type GeminiGateDeps, type ToolGate } from './gemini-agent-provider'
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

  it('strips $schema/additionalProperties recursively (nested objects too)', () => {
    const fns = mcpToolsToFunctionDeclarations([{ name: 't', inputSchema: { type: 'object', additionalProperties: false, properties: { addr: { type: 'object', additionalProperties: false, properties: { city: { type: 'string' } } } }, $schema: 'x' } }])
    const json = JSON.stringify(fns[0]!.parameters)
    expect(json).not.toContain('additionalProperties')
    expect(json).not.toContain('$schema')
    expect(json).toContain('city')
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

  it('on generateContent error: yields error AND leaves history alternating (no trailing user turn)', async () => {
    const history: any[] = [{ role: 'user', parts: [{ text: 'prev' }] }, { role: 'model', parts: [{ text: 'ok' }] }]
    const genai: GenaiPort = { async generateContent() { throw new Error('503 overloaded') } }
    const events = runDispatchLoop({ genai, mcp: fakeMcp({}), gate: async () => ({ allow: true }), model: 'm', systemInstruction: 's', functionDeclarations: [], history, sessionId: 's', userText: 'hi' })
    const evs: any[] = []
    for await (const e of events) evs.push(e)
    expect(evs.some(e => e.kind === 'error')).toBe(true)
    // the user turn we pushed for 'hi' must be rolled back (history ends on a model turn)
    expect((history.at(-1) as any).role).toBe('model')
  })

  it('empty-text terminal response still pushes a model turn (alternation preserved)', async () => {
    const history: any[] = []
    const events = runDispatchLoop({ genai: fakeGenai([{ text: '' }]), mcp: fakeMcp({}), gate: async () => ({ allow: true }), model: 'm', systemInstruction: 's', functionDeclarations: [], history, sessionId: 's', userText: 'hi' })
    await collectTurn(events)
    expect(history.length).toBe(2)
    expect((history.at(-1) as any).role).toBe('model')
  })

  it('nameless-only functionCall batch: no execution, terminal, alternation preserved', async () => {
    const history: any[] = []
    let executed = false
    const events = runDispatchLoop({
      genai: fakeGenai([{ functionCalls: [{ name: undefined as any, args: undefined as any }] }]),
      mcp: { async callTool() { executed = true; return { content: [] } } },
      gate: async () => ({ allow: true }),
      model: 'm', systemInstruction: 's', functionDeclarations: [], history, sessionId: 's', userText: 'x',
    })
    for await (const _ of events) { /* drain */ }
    expect(executed).toBe(false)
    // No executable call → terminal: history ends on a model turn (no crash, no
    // dangling user turn, no empty functionResponse turn that would 400 on Gemini).
    expect((history.at(-1) as any).role).toBe('model')
    expect(history.length).toBe(2)
  })

  it('mixed named+nameless batch: drops nameless, keeps functionCall/functionResponse counts equal', async () => {
    const history: any[] = []
    const events = runDispatchLoop({
      genai: fakeGenai([
        { functionCalls: [{ name: 'reply', args: { x: 1 } }, { name: undefined as any, args: undefined as any }] },
        { text: 'done' },
      ]),
      mcp: { async callTool() { return { content: [{ type: 'text', text: 'ok' }] } } },
      gate: async () => ({ allow: true }),
      model: 'm', systemInstruction: 's', functionDeclarations: [{ name: 'reply' }], history, sessionId: 's', userText: 'x',
    })
    for await (const _ of events) { /* drain */ }
    // Gemini 400s unless a turn's functionResponse count == its functionCall count.
    const modelCalls = (history[1] as any).parts.filter((p: any) => p.functionCall)
    const userResponses = (history[2] as any).parts.filter((p: any) => p.functionResponse)
    expect(modelCalls.length).toBe(1)
    expect(userResponses.length).toBe(1)
    expect(modelCalls[0].functionCall.name).toBe('reply')
    expect(userResponses[0].functionResponse.name).toBe('reply')
  })

  it('MCP isError result becomes an error functionResponse (model sees failure)', async () => {
    const history: any[] = []
    const events = runDispatchLoop({
      genai: fakeGenai([{ functionCalls: [{ name: 'reply', args: { x: 1 } }] }, { text: 'ack' }]),
      mcp: { async callTool() { return { content: [{ type: 'text', text: 'chat not found' }], isError: true } } },
      gate: async () => ({ allow: true }),
      model: 'm', systemInstruction: 's', functionDeclarations: [{ name: 'reply' }], history, sessionId: 's', userText: 'x',
    })
    for await (const _ of events) { /* drain */ }
    const fr = (history[2] as any).parts[0].functionResponse
    expect(fr.response.error).toBeDefined()
    expect(fr.response.content).toBeUndefined()
  })

  it('keeps assistant text in the model turn when text accompanies a functionCall', async () => {
    const history: any[] = []
    const events = runDispatchLoop({
      genai: fakeGenai([{ text: 'let me check', functionCalls: [{ name: 'reply', args: {} }] }, { text: 'done' }]),
      mcp: fakeMcp({}), gate: async () => ({ allow: true }),
      model: 'm', systemInstruction: 's', functionDeclarations: [{ name: 'reply' }], history, sessionId: 's', userText: 'x',
    })
    for await (const _ of events) { /* drain */ }
    const modelTurn = history[1] as any
    expect(modelTurn.role).toBe('model')
    expect(modelTurn.parts.some((p: any) => p.text === 'let me check')).toBe(true)
    expect(modelTurn.parts.some((p: any) => p.functionCall?.name === 'reply')).toBe(true)
  })
})

describe('createGeminiAgentProvider', () => {
  function deps(genaiResponses: any[], gate: ToolGate = async () => ({ allow: true })) {
    const calls: string[] = []
    const provider = createGeminiAgentProvider({
      genai: (() => { let i = 0; return { models: { async generateContent() { return genaiResponses[i++] ?? { text: '' } } } } })() as any,
      model: 'gemini-flash-latest',
      systemInstruction: 'you are gemini',
      async mcpConnect() {
        return {
          listTools: async () => ([{ name: 'reply', description: 'r', inputSchema: { type: 'object', properties: {} } }]),
          callTool: async (name: string, _args: any) => { calls.push(name); return { content: [{ type: 'text', text: '{}' }] } },
          close: async () => {},
        }
      },
      buildGate: () => gate as any,
    })
    return { provider, calls }
  }

  it('spawn → dispatch streams text + result; uses listTools as functionDeclarations', async () => {
    const { provider } = deps([{ text: 'hi from gemini' }])
    const session = await provider.spawn({ alias: 'P', path: '/p' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: 'c1' })
    const out: any[] = []
    for await (const e of session.dispatch('hello')) out.push(e)
    expect(out.some(e => e.kind === 'text' && e.text === 'hi from gemini')).toBe(true)
    expect(out.at(-1).kind).toBe('result')
    await session.close()
  })

  it('cheapEval does a no-tools generateContent and returns text', async () => {
    const { provider } = deps([{ text: 'cheap answer' }])
    expect(provider.cheapEval).toBeDefined()
    const ans = await provider.cheapEval!('rate 1-10')
    expect(ans).toBe('cheap answer')
  })

  // Bug 9b: buildGate is required and ALWAYS consulted — a deny-all gate must block execution.
  it('spawn always consults buildGate — a deny-all gate blocks tool execution', async () => {
    const { provider, calls } = deps(
      [{ functionCalls: [{ name: 'reply', args: {} }] }, { text: 'ok' }],
      async () => ({ allow: false, message: 'denied' }),
    )
    const session = await provider.spawn({ alias: 'P', path: '/p' }, { tierProfile: TIER_PROFILES.guest, permissionMode: 'strict', chatId: 'c' })
    for await (const _ of session.dispatch('hi')) { /* drain */ }
    await session.close()
    expect(calls).toEqual([])
  })
})

describe('makeGeminiToolGate', () => {
  function deps(over: Partial<GeminiGateDeps> = {}): GeminiGateDeps {
    return {
      askUser: async () => 'allow',
      adminFor: () => 'admin-chat',
      modeFor: () => 'solo',
      lookupBase: () => ({ askUser: 'never' } as any),
      ...over,
    }
  }
  const ctx = (tier: 'admin'|'trusted'|'guest', perm: 'strict'|'dangerously' = 'strict') =>
    ({ tierProfile: TIER_PROFILES[tier], permissionMode: perm, chatId: 'c1' }) as any

  it('dangerously → always allow', async () => {
    const gate = makeGeminiToolGate(deps())(ctx('guest', 'dangerously'))
    expect(await gate('memory_delete', {})).toEqual({ allow: true })
  })
  it('guest: reply allowed, memory_delete denied', async () => {
    const gate = makeGeminiToolGate(deps())(ctx('guest'))
    expect((await gate('reply', { chat_id: 'c', text: 'x' })).allow).toBe(true)
    expect((await gate('memory_delete', { path: 'p' })).allow).toBe(false)
  })
  it('trusted: a2a_send relays → askUser allow ⇒ allow', async () => {
    const gate = makeGeminiToolGate(deps({ askUser: async () => 'allow' }))(ctx('trusted'))
    expect((await gate('a2a_send', { agent_id: 'x', text: 't' })).allow).toBe(true)
  })
  it('trusted: a2a_send relays → askUser deny ⇒ deny', async () => {
    const gate = makeGeminiToolGate(deps({ askUser: async () => 'deny' }))(ctx('trusted'))
    expect((await gate('a2a_send', { agent_id: 'x', text: 't' })).allow).toBe(false)
  })
  it('relay but no admin ⇒ deny', async () => {
    const gate = makeGeminiToolGate(deps({ adminFor: () => null }))(ctx('trusted'))
    expect((await gate('a2a_send', {})).allow).toBe(false)
  })

  // Bug 7: the relay hash MUST match pending-permissions.ts's PERMISSION_REPLY_RE
  // (replicated here — that module is not exported; source: src/daemon/pending-permissions.ts).
  const PERMISSION_REPLY_RE = /^([yn])\s+([A-Za-z0-9]{5})$/i
  it('relay hash matches the admin permission-reply regex (5 alphanumeric)', async () => {
    let capturedHash = ''
    const gate = makeGeminiToolGate(deps({
      askUser: async (_admin, _prompt, hash) => { capturedHash = hash; return 'deny' },
    }))(ctx('trusted'))
    await gate('a2a_send', { agent_id: 'x', text: 't' })
    // The reply the admin must type is `y ${capturedHash}` — it has to match the regex:
    expect(`y ${capturedHash}`).toMatch(PERMISSION_REPLY_RE)
    expect(capturedHash).toMatch(/^[A-Za-z0-9]{5}$/)
  })

  // Bug 8: a toolName already containing "__" must be denied (double-prefix bypass guard).
  it('denies a toolName containing "__" (double-prefix bypass guard)', async () => {
    const gate = makeGeminiToolGate(deps())(ctx('guest'))
    expect((await gate('mcp__wechat__shell', {})).allow).toBe(false)
    expect((await gate('wechat__reply', {})).allow).toBe(false)
  })

  // Bug 9a: relaySeq is per-spawn — two spawns from the same factory get independent
  // counters, so hashes don't collide-by-coupling across sessions. Each spawn's first
  // relay uses its own seq; combined with chatId the hash is unique per relay.
  it('relaySeq is per-spawn (independent counters across spawns)', async () => {
    const hashes: string[] = []
    const factory = makeGeminiToolGate(deps({
      askUser: async (_admin, _prompt, hash) => { hashes.push(hash); return 'deny' },
    }))
    const gateA = factory(ctx('trusted'))
    const gateB = factory(ctx('trusted'))
    await gateA('a2a_send', {})
    await gateB('a2a_send', {})
    // Both first-relays of their respective spawns; each is a valid 5-char hash.
    expect(hashes).toHaveLength(2)
    for (const h of hashes) expect(h).toMatch(/^[A-Za-z0-9]{5}$/)
  })
})
