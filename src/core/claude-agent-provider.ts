import { query, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, AgentProject, AgentProvider, AgentSession } from './agent-provider'

export interface ClaudeAgentProviderOptions {
  sdkOptionsForProject: (alias: string, path: string) => Options
}

// Local mirror of the SDK message variants this provider actually reads.
// The SDK's full union (`SDKMessage`) covers many more variants but our
// streaming loop only branches on these three. Defining a narrow local
// type means every reach into the message shape goes through one cast
// (`narrow` below) — when the SDK changes shape, that's the only place
// to update.
type AssistantContent = string | Array<{ type?: string; text?: string; name?: string }>
type AssistantMsg = { type: 'assistant'; message?: { content?: AssistantContent } }
type ResultMsg = {
  type: 'result'
  subtype?: string
  session_id?: string
  num_turns?: number
  duration_ms?: number
  result?: unknown
}
type SystemMsg = { type: 'system'; subtype?: string; session_id?: string }
type NarrowedMsg = AssistantMsg | ResultMsg | SystemMsg

// Returns null for SDK message types we don't branch on (rate_limit_event,
// stream_event, partial_assistant, etc.). The caller's for-await loop
// simply skips these.
function narrow(msg: SDKMessage): NarrowedMsg | null {
  const t = (msg as { type?: string }).type
  if (t === 'assistant' || t === 'result' || t === 'system') {
    return msg as unknown as NarrowedMsg
  }
  return null
}

function extractText(content: AssistantContent | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content.map(b => (b?.type === 'text' ? b.text ?? '' : '')).join('')
}

// The claude binary prints these literal phrases as assistant text when it
// has no usable credentials (verified by inspecting the binary's string
// table). Two distinct markers because the SDK can split a single message
// across multiple `assistant` events — matching only "/login" would leak
// the first chunk ("Not logged in") to the user before the second arrives.
// Without interception the phrase leaks to the user as if it were the AI's
// reply. We tag it with a structured error code so the coordinator can
// suppress the fallback path and respond with a controlled notification
// instead.
const AUTH_FAIL_RE = /(Please run \/login|Not logged in)/i

/**
 * Parse a Claude SDK tool_use block's `name` (e.g. 'mcp__wechat__reply')
 * into our normalised `{ server, tool }` shape. Built-in tools (Read,
 * Bash) lack the prefix — those return `{ tool: name }` with no server.
 */
function parseToolUseToEvent(block: { name?: string }): AgentEvent {
  const name = block.name ?? ''
  const m = /^mcp__([^_]+)__(.+)$/.exec(name)
  if (m) return { kind: 'tool_call', server: m[1], tool: m[2]! }
  return { kind: 'tool_call', tool: name }
}

export function createClaudeAgentProvider(opts: ClaudeAgentProviderOptions): AgentProvider {
  return {
    async spawn(project: AgentProject, spawnOpts?: { resumeSessionId?: string }): Promise<AgentSession> {
      const sdkQueue = new AsyncQueue<SDKUserMessage>()
      const options = opts.sdkOptionsForProject(project.alias, project.path)
      if (spawnOpts?.resumeSessionId) {
        ;(options as Options & { resume?: string }).resume = spawnOpts.resumeSessionId
      }

      const q = query({ prompt: sdkQueue.iterable(), options })

      let activeEventQueue: AsyncQueue<AgentEvent> | null = null
      let closed = false
      let droppedAssistantChunks = 0
      let drainResolve: (() => void) | undefined
      const drainPromise = new Promise<void>(resolve => { drainResolve = resolve })

      // Background SDK message consumer — runs for the lifetime of the
      // session, translating SDK messages to AgentEvents on the in-flight
      // dispatch's queue. When no dispatch is in flight, drops with a warn.
      ;(async () => {
        try {
          for await (const raw of q as AsyncGenerator<SDKMessage>) {
            const msg = narrow(raw)
            if (!msg) continue

            if (!activeEventQueue) {
              // No in-flight dispatch — preserves [STREAM_DROP] behavior.
              // Trailing chunks after a result, or assistant text from an SDK
              // quirk, get logged but not attributed to a future turn.
              if (msg.type === 'assistant') {
                const text = extractText(msg.message?.content)
                if (text) {
                  droppedAssistantChunks++
                  console.warn(`wechat channel: [STREAM_DROP] alias=${project.alias} count=${droppedAssistantChunks} preview=${JSON.stringify(text.slice(0, 80))}`)
                }
              }
              continue
            }

            // Use a type-cast reference to work around TS6's exhaustive-narrowing
            // of the discriminated-union if/else chain, which otherwise infers
            // 'never' for activeEventQueue within individual branches.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const aq = activeEventQueue as AsyncQueue<AgentEvent>

            if (msg.type === 'system' && msg.subtype === 'init') {
              console.error(`wechat channel: [SESSION_INIT] alias=${project.alias} session_id=${msg.session_id ?? ''}`)
              aq.push({ kind: 'init', sessionId: msg.session_id ?? '' })
            } else if (msg.type === 'assistant') {
              const content = msg.message?.content
              // Emit tool_call events for each tool_use block
              if (Array.isArray(content)) {
                for (const block of content as Array<{ type?: string; name?: string }>) {
                  if (block?.type === 'tool_use') {
                    aq.push(parseToolUseToEvent(block))
                  }
                }
              }
              // Emit text event for any text content — UNLESS the binary is
              // surfacing its "not logged in" sentinel as assistant text. In
              // that case route it as a structured error; coordinator drops
              // the fallback-reply and emits a controlled user-facing notice.
              const text = extractText(content)
              if (text) {
                if (AUTH_FAIL_RE.test(text)) {
                  aq.push({
                    kind: 'error',
                    code: 'auth_failed',
                    message: `claude reports not logged in: ${text.slice(0, 160)}`,
                  })
                } else {
                  aq.push({ kind: 'text', text })
                }
              }
            } else if (msg.type === 'result') {
              if (msg.subtype && msg.subtype !== 'success') {
                const summary = typeof msg.result === 'string'
                  ? msg.result.slice(0, 400)
                  : JSON.stringify(msg).slice(0, 400)
                console.error(`wechat channel: [SESSION_RESULT] alias=${project.alias} subtype=${msg.subtype} result=${summary}`)
                aq.push({ kind: 'error', message: `subtype=${msg.subtype}` })
              }
              aq.push({
                kind: 'result',
                sessionId: msg.session_id ?? '',
                numTurns: msg.num_turns ?? 0,
                durationMs: msg.duration_ms ?? 0,
              })
              aq.end()
              activeEventQueue = null
            }
          }
        } catch (e) {
          console.error(`wechat channel: [SESSION_ERROR] alias=${project.alias} ${e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : String(e)}`)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const catchQueue = activeEventQueue as AsyncQueue<AgentEvent> | null
          if (catchQueue) {
            const errMsg = e instanceof Error ? e.message : String(e)
            catchQueue.push({ kind: 'error', message: errMsg })
            catchQueue.end()
            activeEventQueue = null
          }
        } finally {
          drainResolve?.()
        }
      })()

      return {
        dispatch(text: string): AsyncIterable<AgentEvent> {
          if (closed) {
            // Already closed — return an iterable that yields nothing.
            return { async *[Symbol.asyncIterator]() {} }
          }
          if (activeEventQueue) {
            throw new Error(`claude provider: previous dispatch still in flight (alias=${project.alias})`)
          }
          const queue = new AsyncQueue<AgentEvent>()
          activeEventQueue = queue
          sdkQueue.push({
            type: 'user',
            parent_tool_use_id: null,
            message: { role: 'user', content: [{ type: 'text', text }] },
          } as SDKUserMessage)
          return queue.iterable()
        },
        async close() {
          closed = true
          sdkQueue.end()
          ;(q as unknown as { close?: () => void }).close?.()
          ;(q as unknown as { interrupt?: () => void }).interrupt?.()
          if (activeEventQueue) {
            activeEventQueue.end()
            activeEventQueue = null
          }
          drainResolve?.()
          await drainPromise
        },
      }
    },
  }
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
    while (this.resolvers.length > 0) {
      const r = this.resolvers.shift()!
      r({ value: undefined as unknown as T, done: true })
    }
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
