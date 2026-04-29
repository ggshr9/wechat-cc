import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedDemo, unseedDemo } from './seed'
import { makeEventsStore } from '../events/store'
import { makeObservationsStore } from '../observations/store'
import { makeMilestonesStore } from '../milestones/store'

describe('seedDemo + unseedDemo', () => {
  let stateDir: string
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'seed-')) })
  afterEach(() => rmSync(stateDir, { recursive: true, force: true }))

  it('seeds 3 observations + 1 milestone + 5 events', async () => {
    const result = await seedDemo({ stateDir, chatId: 'chat_x' })
    expect(result).toEqual({ observations: 3, milestones: 1, events: 5 })
    const memoryRoot = join(stateDir, 'memory')
    expect((await makeObservationsStore(memoryRoot, 'chat_x').listActive())).toHaveLength(3)
    expect((await makeMilestonesStore(memoryRoot, 'chat_x').list())).toHaveLength(1)
    expect((await makeEventsStore(memoryRoot, 'chat_x').list())).toHaveLength(5)
  })

  it('unseed removes seeded entries by stable id prefix + back-pointer', async () => {
    await seedDemo({ stateDir, chatId: 'chat_x' })
    // Add a non-demo observation that should survive unseed
    await makeObservationsStore(join(stateDir, 'memory'), 'chat_x').append({ body: 'real observation', tone: 'curious' })
    const r = await unseedDemo({ stateDir, chatId: 'chat_x' })
    expect(r.removed).toBeGreaterThan(0)
    const memoryRoot = join(stateDir, 'memory')
    expect((await makeObservationsStore(memoryRoot, 'chat_x').listActive())).toHaveLength(1)  // only real one survives
    expect((await makeMilestonesStore(memoryRoot, 'chat_x').list())).toHaveLength(0)
    expect((await makeEventsStore(memoryRoot, 'chat_x').list())).toHaveLength(0)  // all events were demo
  })

  it('unseed is idempotent (no-op on empty/already-clean state)', async () => {
    const r = await unseedDemo({ stateDir, chatId: 'chat_x' })
    expect(r.removed).toBe(0)
  })
})
