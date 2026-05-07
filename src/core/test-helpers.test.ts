import { describe, it, expect } from 'vitest'
import { makeFakeSession } from './test-helpers'
import type { AgentEvent } from './agent-provider'

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of events) out.push(ev)
  return out
}

describe('makeFakeSession', () => {
  it('yields the provided events in order', async () => {
    const session = makeFakeSession({
      events: [
        { kind: 'text', text: 'hi' },
        { kind: 'result', sessionId: 's1', numTurns: 1, durationMs: 10 },
      ],
    })
    expect(await drain(session.dispatch('any'))).toEqual([
      { kind: 'text', text: 'hi' },
      { kind: 'result', sessionId: 's1', numTurns: 1, durationMs: 10 },
    ])
  })

  it('records the dispatched text', async () => {
    const dispatchSpy: string[] = []
    const session = makeFakeSession({ events: [], onDispatch: t => dispatchSpy.push(t) })
    await drain(session.dispatch('foo'))
    await drain(session.dispatch('bar'))
    expect(dispatchSpy).toEqual(['foo', 'bar'])
  })

  it('supports per-turn event lists via getEventsForTurn', async () => {
    let turn = 0
    const session = makeFakeSession({
      getEventsForTurn: () => {
        turn++
        return turn === 1
          ? [{ kind: 'text', text: 'first' } as AgentEvent]
          : [{ kind: 'text', text: 'second' } as AgentEvent]
      },
    })
    expect(await drain(session.dispatch('a'))).toEqual([{ kind: 'text', text: 'first' }])
    expect(await drain(session.dispatch('b'))).toEqual([{ kind: 'text', text: 'second' }])
  })

  it('close() resolves and subsequent dispatch yields nothing', async () => {
    const session = makeFakeSession({ events: [{ kind: 'text', text: 'x' }] })
    await session.close()
    expect(await drain(session.dispatch('after'))).toEqual([])
  })
})
