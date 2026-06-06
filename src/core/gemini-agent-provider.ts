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
import type { AgentEvent, AgentProject, AgentProvider, AgentSession, PermissionMode, ProviderCapabilities, SpawnContext } from './agent-provider'
import type { TierProfile } from './user-tier'
import { classifyToolUse } from './user-tier'

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

export interface McpToolDef {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}
export interface GeminiFunctionDeclaration {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

/** Recursively drop JSON-Schema meta keys Gemini rejects ($schema,
 *  additionalProperties) from a schema node and all nested objects/arrays. */
function stripSchemaMeta(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripSchemaMeta)
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === '$schema' || k === 'additionalProperties') continue
      out[k] = stripSchemaMeta(v)
    }
    return out
  }
  return node
}

/** Strip JSON-Schema meta keys Gemini rejects ($schema, additionalProperties)
 *  and reshape an MCP tool's inputSchema into a Gemini FunctionDeclaration. */
export function mcpToolsToFunctionDeclarations(tools: McpToolDef[]): GeminiFunctionDeclaration[] {
  return tools.map(t => {
    const fn: GeminiFunctionDeclaration = { name: t.name }
    if (t.description) fn.description = t.description
    if (t.inputSchema) fn.parameters = stripSchemaMeta(t.inputSchema) as Record<string, unknown>
    return fn
  })
}

/** Minimal genai surface the loop needs (real: ai.models). */
export interface GenaiPort {
  generateContent(req: {
    model: string
    contents: unknown[]
    config?: { systemInstruction?: string; tools?: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }> }
  }): Promise<{ text?: string; functionCalls?: Array<{ name?: string; args?: Record<string, unknown> }> }>
}
/** Minimal MCP surface the loop needs (real: @modelcontextprotocol/sdk Client). */
export interface McpPort {
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: unknown[]; isError?: boolean }>
}

export interface DispatchLoopArgs {
  genai: GenaiPort
  mcp: McpPort
  gate: ToolGate
  model: string
  systemInstruction: string
  functionDeclarations: GeminiFunctionDeclaration[]
  /** Mutated in place — the running conversation history (persists across dispatches). */
  history: unknown[]
  sessionId: string
  userText: string
  /** Safety cap on tool rounds per dispatch (default 12). */
  maxRounds?: number
}

/** The tool-use loop. Yields AgentEvents; mutates `history`. */
export async function* runDispatchLoop(args: DispatchLoopArgs): AsyncIterable<AgentEvent> {
  const startMs = Date.now()
  const cap = args.maxRounds ?? 12
  args.history.push({ role: 'user', parts: [{ text: args.userText }] })
  const config = {
    systemInstruction: args.systemInstruction,
    ...(args.functionDeclarations.length > 0 ? { tools: [{ functionDeclarations: args.functionDeclarations }] } : {}),
  }
  let rounds = 0
  try {
    while (true) {
      rounds++
      const resp = await args.genai.generateContent({ model: args.model, contents: args.history, config })
      const text = resp.text ?? ''
      const calls = resp.functionCalls ?? []

      if (text) yield { kind: 'text', text }

      // Drop any nameless functionCall (genai's FunctionCall.name is optional) — it
      // has no executable target. validCalls drives BOTH the model turn's functionCall
      // parts AND the functionResponse parts below, keeping the two counts equal:
      // Gemini 400s if a turn's functionResponse count != its functionCall count.
      const validCalls = calls.filter(c => c.name)

      if (validCalls.length === 0) {
        // No executable calls (none at all, or only nameless/malformed ones).
        // ALWAYS push a model turn (even on empty text) to preserve user/model
        // alternation — Flash routinely returns empty text after a tool chain.
        args.history.push({ role: 'model', parts: text ? [{ text }] : [{ text: '' }] })
        yield { kind: 'result', sessionId: args.sessionId, numTurns: rounds, durationMs: Date.now() - startMs }
        return
      }

      // Model turn: keep the assistant's reasoning text alongside the named calls.
      args.history.push({ role: 'model', parts: [
        ...(text ? [{ text }] : []),
        ...validCalls.map(c => ({ functionCall: { name: c.name, args: c.args ?? {} } })),
      ] })

      const responseParts: unknown[] = []
      for (const call of validCalls) {
        const name = call.name!
        const callArgs = call.args ?? {}
        yield { kind: 'tool_call', server: 'wechat', tool: name }
        const decision = await args.gate(name, callArgs)
        if (!decision.allow) {
          responseParts.push({ functionResponse: { name, response: { error: decision.message } } })
          continue
        }
        try {
          const result = await args.mcp.callTool(name, callArgs)
          if (result.isError) {
            const msg = result.content.map((c: any) => c?.text ?? '').join(' ') || 'tool reported an error'
            responseParts.push({ functionResponse: { name, response: { error: msg } } })
          } else {
            responseParts.push({ functionResponse: { name, response: { content: result.content } } })
          }
        } catch (err) {
          responseParts.push({ functionResponse: { name, response: { error: err instanceof Error ? err.message : String(err) } } })
        }
      }
      args.history.push({ role: 'user', parts: responseParts })

      if (rounds >= cap) {
        // Cap hit mid-tool-loop: history currently ends on a user(functionResponse)
        // turn. Append a synthetic model turn so the NEXT dispatch (this session
        // reuses `history`) doesn't produce two consecutive user turns.
        args.history.push({ role: 'model', parts: [{ text: '[max tool rounds reached]' }] })
        yield { kind: 'result', sessionId: args.sessionId, numTurns: rounds, durationMs: Date.now() - startMs }
        return
      }
    }
  } catch (err) {
    // Preserve alternation: if we error out with the loop's user turn still
    // trailing (e.g. generateContent threw), roll it back so the next dispatch
    // doesn't push a second consecutive user turn → API 400.
    if ((args.history.at(-1) as any)?.role === 'user') args.history.pop()
    yield { kind: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}

/** The real genai client shape we use (ai.models.generateContent). */
export interface GenaiClient {
  models: GenaiPort
}
/** A connected MCP session: list tools + call them + close. The factory's
 *  mcpConnect builds this (real: @modelcontextprotocol/sdk Client over stdio). */
export interface McpConnection {
  listTools(): Promise<McpToolDef[]>
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: unknown[]; isError?: boolean }>
  close(): Promise<void>
}

/** Minimal capability shape the gate needs from the matrix lookup.
 *  Avoids importing capability-matrix (which imports THIS module → cycle). */
export interface GateBaseCapability {
  askUser: 'per-tool' | 'never'
}

/** Injected deps for the gate — bootstrap supplies the real ones; tests fake them.
 *  Kept abstract so the provider module doesn't import bootstrap. */
export interface GeminiGateDeps {
  askUser: (adminChatId: string, prompt: string, hash: string, timeoutMs: number) => Promise<'allow' | 'deny' | 'timeout'>
  adminFor: (chatId: string) => string | null
  modeFor: (chatId: string) => string
  lookupBase: (mode: string, permissionMode: PermissionMode) => GateBaseCapability
}

/** Inline of effectivePolicy (permission-relay.ts) to avoid the
 *  gemini-agent-provider → permission-relay → capability-matrix → gemini-agent-provider cycle. */
function gateEffectivePolicy(
  base: GateBaseCapability,
  tp: TierProfile,
  kind: ReturnType<typeof classifyToolUse>,
): 'allow' | 'relay' | 'deny' {
  if (tp.deny.has(kind)) return 'deny'
  if (tp.relay.has(kind)) return 'relay'
  if (tp.allow.has(kind)) return 'allow'
  return base.askUser === 'per-tool' ? 'relay' : 'allow'
}

const GEMINI_RELAY_TIMEOUT_MS = 120_000

/** Inlined (NOT imported from permission-relay.ts, which would recreate the
 *  gemini→permission-relay→capability-matrix→gemini import cycle) djb2-ish hash →
 *  5-char base36. The relay hash MUST be exactly 5 alphanumeric chars so the admin's
 *  WeChat reply matches pending-permissions.ts's PERMISSION_REPLY_RE
 *  (/^([yn])\s+([A-Za-z0-9]{5})$/i) — anything else can NEVER be approved. A base36
 *  uint32 is 1–7 chars, so padStart guarantees the low end and slice(-5) the high end:
 *  the result is ALWAYS exactly 5 alphanumeric chars. */
function shortHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36).padStart(5, '0').slice(-5)
}

/** Build the per-spawn tool gate. Replicates makeCanUseTool's allow/relay/deny
 *  but returns ToolGateDecision and normalizes the wechat MCP server's BARE tool
 *  names (`reply`) into the `mcp__wechat__reply` form classifyToolUse expects. */
export function makeGeminiToolGate(deps: GeminiGateDeps): (ctx: SpawnContext) => ToolGate {
  return (ctx: SpawnContext): ToolGate => {
    // Per-spawn relay counter — each session owns its own, so hashes don't couple
    // across chats. Combined with chatId in the hash input → unique per relay.
    let relaySeq = 0
    return async (toolName, input) => {
      if (ctx.permissionMode === 'dangerously') return { allow: true }
      // Reject any bare name already containing '__': prefixing `mcp__wechat__`
      // onto it (e.g. `mcp__wechat__shell` → `mcp__wechat__mcp__wechat__shell`)
      // yields a malformed name classifyToolUse may misclassify as unknown→allow,
      // letting a gated tool slip through. Deny outright.
      if (toolName.includes('__')) return { allow: false, message: `invalid tool name '${toolName}'` }
      const kind = classifyToolUse(`mcp__wechat__${toolName}`, input)
      const base = deps.lookupBase(deps.modeFor(ctx.chatId), ctx.permissionMode)
      const decision = gateEffectivePolicy(base, ctx.tierProfile, kind)
      if (decision === 'allow') return { allow: true }
      if (decision === 'deny') return { allow: false, message: `tool '${toolName}' (${kind}) not allowed for this tier` }
      const admin = deps.adminFor(ctx.chatId)
      if (!admin) return { allow: false, message: 'no admin configured to approve permission requests' }
      const seq = ++relaySeq
      const hash = shortHash(`${ctx.chatId}:${toolName}:${seq}`)
      const answer = await deps.askUser(admin, `Gemini wants to run ${toolName}`, hash, GEMINI_RELAY_TIMEOUT_MS)
      if (answer === 'allow') return { allow: true }
      return { allow: false, message: answer === 'timeout' ? 'no reply in time; denied' : 'denied by operator' }
    }
  }
}

export interface GeminiAgentProviderOptions {
  genai: GenaiClient
  model: string
  systemInstruction: string
  /** Connect an MCP client to the daemon's wechat server (per spawn). */
  mcpConnect: () => Promise<McpConnection>
  /** Build the per-spawn tool gate from the SpawnContext. REQUIRED — a missing
   *  gate would silently allow every tool (security footgun). Bootstrap supplies
   *  the real one (effectivePolicy + askUser); tests inject a fake. */
  buildGate: (ctx: SpawnContext) => ToolGate
  /** cheapEval model (default = the dispatch model). */
  cheapModel?: string
}

/** Stdio launch spec for an MCP server (matches bootstrap's McpStdioSpec). */
export interface GeminiMcpStdioSpec {
  command: string
  args: string[]
  env: Record<string, string>
}

/** Connect an MCP client over stdio to a server (the daemon's wechat server) and
 *  adapt it to the McpConnection the provider consumes. Dynamic-imports the MCP
 *  SDK so this module stays import-light. */
export async function connectWechatMcp(spec: GeminiMcpStdioSpec): Promise<McpConnection> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  const transport = new StdioClientTransport({ command: spec.command, args: spec.args, env: spec.env })
  const client = new Client({ name: 'wechat-cc-gemini', version: '0.0.0' }, { capabilities: {} })
  await client.connect(transport)
  return {
    async listTools() {
      const res = await client.listTools()
      return res.tools as McpToolDef[]
    },
    async callTool(name, args) {
      const res = await client.callTool({ name, arguments: args })
      return { content: (res.content as unknown[]) ?? [], isError: res.isError as boolean | undefined }
    },
    async close() {
      try { await client.close() } catch { /* swallow */ }
    },
  }
}

export function createGeminiAgentProvider(opts: GeminiAgentProviderOptions): AgentProvider {
  let uuidCounter = 0
  const newSessionId = () => `gemini-${Date.now()}-${++uuidCounter}`

  return {
    async spawn(_project: AgentProject, ctx: SpawnContext): Promise<AgentSession> {
      const conn = await opts.mcpConnect()
      let functionDeclarations: GeminiFunctionDeclaration[]
      let gate: ToolGate
      try {
        const mcpTools = await conn.listTools()
        functionDeclarations = mcpToolsToFunctionDeclarations(mcpTools)
        gate = opts.buildGate(ctx)
      } catch (err) {
        // Setup failed after the MCP client connected — close it so we don't
        // orphan the stdio subprocess, then propagate.
        await conn.close().catch(() => {})
        throw err
      }
      const sessionId = ctx.resumeSessionId ?? newSessionId()
      // Fresh history each spawn — resumeSessionId is reused only as an event
      // label since GEMINI_CAPABILITIES.supportsResume = false (no history
      // serialisation yet).
      const history: unknown[] = []

      return {
        dispatch(text: string) {
          return runDispatchLoop({
            genai: opts.genai.models,
            mcp: { callTool: (n, a) => conn.callTool(n, a) },
            gate,
            model: opts.model,
            systemInstruction: opts.systemInstruction,
            functionDeclarations,
            history,
            sessionId,
            userText: text,
          })
        },
        async close() {
          try { await conn.close() } catch { /* swallow */ }
        },
      }
    },
    async cheapEval(prompt: string): Promise<string> {
      const resp = await opts.genai.models.generateContent({
        model: opts.cheapModel ?? opts.model,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      })
      return resp.text ?? ''
    },
  }
}
