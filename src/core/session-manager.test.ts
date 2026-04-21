import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SessionManager } from './session-manager'
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

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
})
