import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runIntrospectTick, type IntrospectDeps, type IntrospectAgent } from './introspect'
import { makeEventsStore } from '../events/store'
import { makeObservationsStore } from '../observations/store'
import type { ObservationTone } from '../observations/store'

function makeFakeAgent(response: { write: boolean; body?: string; tone?: ObservationTone; reasoning: string }): IntrospectAgent {
  return {
    runIntrospect: vi.fn(async () => response),
  }
}

describe('introspect tick', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'intro-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes an observation when agent decides to', async () => {
    const events = makeEventsStore(dir, 'chat_x')
    const observations = makeObservationsStore(dir, 'chat_x')
    const agent = makeFakeAgent({ write: true, body: 'you mentioned compass 12 times', tone: 'curious', reasoning: 'pattern detected' })
    const deps: IntrospectDeps = { events, observations, agent, chatId: 'chat_x', log: vi.fn() }

    await runIntrospectTick(deps)

    const obs = await observations.listActive()
    expect(obs).toHaveLength(1)
    expect(obs[0]).toMatchObject({ body: 'you mentioned compass 12 times', tone: 'curious' })
    const evs = await events.list()
    expect(evs).toHaveLength(1)
    expect(evs[0]).toMatchObject({ kind: 'observation_written', trigger: 'introspect', reasoning: 'pattern detected' })
    expect(evs[0]!.observation_id).toBe(obs[0]!.id)
  })

  it('skips writing when agent decides not to', async () => {
    const events = makeEventsStore(dir, 'chat_x')
    const observations = makeObservationsStore(dir, 'chat_x')
    const agent = makeFakeAgent({ write: false, reasoning: 'nothing new since last week' })
    const deps: IntrospectDeps = { events, observations, agent, chatId: 'chat_x', log: vi.fn() }

    await runIntrospectTick(deps)

    expect(await observations.listActive()).toHaveLength(0)
    const evs = await events.list()
    expect(evs).toHaveLength(1)
    expect(evs[0]!.kind).toBe('cron_eval_skipped')
    expect(evs[0]!.trigger).toBe('introspect')
  })

  it('agent failure is swallowed and logged (does not throw)', async () => {
    const events = makeEventsStore(dir, 'chat_x')
    const observations = makeObservationsStore(dir, 'chat_x')
    const agent = { runIntrospect: vi.fn(async () => { throw new Error('SDK timeout') }) }
    const log = vi.fn()
    const deps: IntrospectDeps = { events, observations, agent, chatId: 'chat_x', log }

    await expect(runIntrospectTick(deps)).resolves.not.toThrow()
    expect(log).toHaveBeenCalledWith('INTROSPECT', expect.stringContaining('SDK timeout'))
    const evs = await events.list()
    expect(evs).toHaveLength(1)
    expect(evs[0]!.kind).toBe('cron_eval_failed')
    expect(evs[0]!.reasoning).toContain('SDK timeout')
  })

  it('routes SDK error reasoning to cron_eval_failed', async () => {
    const events = makeEventsStore(dir, 'chat_x')
    const observations = makeObservationsStore(dir, 'chat_x')
    const agent = { runIntrospect: vi.fn(async () => ({ write: false, reasoning: 'SDK error: timeout after 30s' })) }
    const deps: IntrospectDeps = { events, observations, agent, chatId: 'chat_x', log: vi.fn() }
    await runIntrospectTick(deps)
    const evs = await events.list()
    expect(evs).toHaveLength(1)
    expect(evs[0]!.kind).toBe('cron_eval_failed')
  })

  it('routes parse failure reasoning to cron_eval_failed', async () => {
    const events = makeEventsStore(dir, 'chat_x')
    const observations = makeObservationsStore(dir, 'chat_x')
    const agent = { runIntrospect: vi.fn(async () => ({ write: false, reasoning: 'parse failed; raw[:120]=garbage' })) }
    const deps: IntrospectDeps = { events, observations, agent, chatId: 'chat_x', log: vi.fn() }
    await runIntrospectTick(deps)
    const evs = await events.list()
    expect(evs).toHaveLength(1)
    expect(evs[0]!.kind).toBe('cron_eval_failed')
  })

  it('still routes legitimate skip reasoning to cron_eval_skipped', async () => {
    const events = makeEventsStore(dir, 'chat_x')
    const observations = makeObservationsStore(dir, 'chat_x')
    const agent = { runIntrospect: vi.fn(async () => ({ write: false, reasoning: 'nothing new since last week' })) }
    const deps: IntrospectDeps = { events, observations, agent, chatId: 'chat_x', log: vi.fn() }
    await runIntrospectTick(deps)
    const evs = await events.list()
    expect(evs).toHaveLength(1)
    expect(evs[0]!.kind).toBe('cron_eval_skipped')
  })
})
