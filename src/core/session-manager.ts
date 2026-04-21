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
    return Promise.resolve(this.spawn(alias, path))
  }

  private spawn(alias: string, path: string): SessionHandle {
    const queue = new AsyncQueue<SDKUserMessage>()
    const options = this.opts.sdkOptionsForProject(alias, path)
    const q = query({ prompt: queue.iterable(), options })
    const assistantListeners = new Set<(t: string) => void>()
    const resultListeners = new Set<(r: { session_id: string; num_turns: number; duration_ms: number }) => void>()
    let drainResolve: (() => void) | undefined
    const drainPromise = new Promise<void>(res => { drainResolve = res })

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
        ;(q as unknown as { interrupt?: () => void }).interrupt?.()
        drainResolve?.()
      },
      onAssistantText(cb) { assistantListeners.add(cb); return () => { assistantListeners.delete(cb) } },
      onResult(cb) { resultListeners.add(cb); return () => { resultListeners.delete(cb) } },
    }

    ;(async () => {
      try {
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
      } catch (e) {
        // iteration interrupted or failed
      } finally {
        drainResolve?.()
      }
    })()

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
