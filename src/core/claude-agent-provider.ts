import { query, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentProject, AgentProvider, AgentResult, AgentSession } from './agent-provider'

export interface ClaudeAgentProviderOptions {
  sdkOptionsForProject: (alias: string, path: string) => Options
}

export function createClaudeAgentProvider(opts: ClaudeAgentProviderOptions): AgentProvider {
  return {
    async spawn(project: AgentProject, spawnOpts?: { resumeSessionId?: string }): Promise<AgentSession> {
      const queue = new AsyncQueue<SDKUserMessage>()
      const options = opts.sdkOptionsForProject(project.alias, project.path)
      if (spawnOpts?.resumeSessionId) {
        ;(options as Options & { resume?: string }).resume = spawnOpts.resumeSessionId
      }

      const q = query({ prompt: queue.iterable(), options })
      const assistantListeners = new Set<(text: string) => void>()
      const resultListeners = new Set<(result: AgentResult) => void>()
      let drainResolve: (() => void) | undefined
      const drainPromise = new Promise<void>(resolve => { drainResolve = resolve })

      // Per-turn awaitable: every dispatch() creates a Turn entry and pushes
      // a user message onto the SDK queue. The SDK iterator below collects
      // assistant text into the in-flight turn (head of pendingTurns) and
      // resolves it when a `result` event fires. This is what gives
      // dispatch() its awaitable return value — without it, dispatch would
      // resolve the moment the user message hit the queue and the message-
      // router would see `result?.assistantText ?? []` = empty, dropping
      // every reply on the floor (the v1.2 regression that made WeChat
      // silently stop responding even though the daemon, Claude subprocess,
      // and ilink session were all healthy).
      type Turn = { texts: string[]; resolve: (v: { assistantText: string[] }) => void; reject: (e: unknown) => void }
      const pendingTurns: Turn[] = []

      ;(async () => {
        try {
          for await (const msg of q as AsyncGenerator<SDKMessage>) {
            const t = (msg as { type: string }).type
            if (t === 'assistant') {
              const content = (msg as any).message?.content
              const text = extractText(content)
              if (text) {
                if (pendingTurns[0]) pendingTurns[0].texts.push(text)
                for (const cb of assistantListeners) cb(text)
              }
            } else if (t === 'result') {
              const r = msg as any
              const result = {
                session_id: r.session_id,
                num_turns: r.num_turns,
                duration_ms: r.duration_ms,
              }
              const head = pendingTurns.shift()
              if (head) head.resolve({ assistantText: head.texts })
              for (const cb of resultListeners) cb(result)
              if (r.subtype && r.subtype !== 'success') {
                console.error(`wechat channel: [SESSION_RESULT] alias=${project.alias} subtype=${r.subtype} result=${typeof r.result === 'string' ? r.result.slice(0, 400) : JSON.stringify(r).slice(0, 400)}`)
              }
            } else if (t === 'system') {
              const sub = (msg as any).subtype
              if (sub === 'init') {
                console.error(`wechat channel: [SESSION_INIT] alias=${project.alias} session_id=${(msg as any).session_id}`)
              }
            }
          }
        } catch (e) {
          console.error(`wechat channel: [SESSION_ERROR] alias=${project.alias} ${e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : String(e)}`)
          // Reject any still-pending turns so the router doesn't hang forever
          // when the SDK iterator dies mid-stream.
          while (pendingTurns.length) pendingTurns.shift()!.reject(e)
        } finally {
          drainResolve?.()
        }
      })()

      return {
        async dispatch(text: string): Promise<{ assistantText: string[] }> {
          return new Promise<{ assistantText: string[] }>((resolve, reject) => {
            pendingTurns.push({ texts: [], resolve, reject })
            queue.push({
              type: 'user',
              parent_tool_use_id: null,
              message: { role: 'user', content: [{ type: 'text', text }] },
            } as SDKUserMessage)
          })
        },
        async close() {
          queue.end()
          ;(q as unknown as { close?: () => void }).close?.()
          ;(q as unknown as { interrupt?: () => void }).interrupt?.()
          drainResolve?.()
          // Resolve any still-pending turns with empty text rather than
          // hanging — close() during shutdown shouldn't deadlock callers
          // that are mid-await.
          while (pendingTurns.length) pendingTurns.shift()!.resolve({ assistantText: [] })
          await drainPromise
        },
        onAssistantText(cb) { assistantListeners.add(cb); return () => { assistantListeners.delete(cb) } },
        onResult(cb) { resultListeners.add(cb); return () => { resultListeners.delete(cb) } },
      }
    },
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
