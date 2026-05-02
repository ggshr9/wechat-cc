import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedDemo, unseedDemo } from './seed'
import { makeEventsStore } from '../events/store'
import { makeObservationsStore } from '../observations/store'
import { makeMilestonesStore } from '../milestones/store'
import { openTestDb, type Db } from '../../lib/db'

describe('seedDemo + unseedDemo', () => {
  let stateDir: string
  let db: Db
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'seed-'))
    db = openTestDb()
  })
  afterEach(() => {
    db.close()
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('seeds 3 observations + 1 milestone + 5 events', async () => {
    const result = await seedDemo({ stateDir, chatId: 'chat_x', db })
    expect(result).toEqual({ observations: 3, milestones: 1, events: 5 })
    const memoryRoot = join(stateDir, 'memory')
    expect((await makeObservationsStore(db, 'chat_x').listActive())).toHaveLength(3)
    expect((await makeMilestonesStore(db, 'chat_x').list())).toHaveLength(1)
    expect((await makeEventsStore(memoryRoot, 'chat_x').list())).toHaveLength(5)
  })

  it('unseed removes seeded entries by stable id prefix + back-pointer', async () => {
    await seedDemo({ stateDir, chatId: 'chat_x', db })
    // Add a non-demo observation that should survive unseed
    await makeObservationsStore(db, 'chat_x').append({ body: 'real observation', tone: 'curious' })
    const r = await unseedDemo({ stateDir, chatId: 'chat_x', db })
    expect(r.removed).toBeGreaterThan(0)
    const memoryRoot = join(stateDir, 'memory')
    expect((await makeObservationsStore(db, 'chat_x').listActive())).toHaveLength(1)  // only real one survives
    expect((await makeMilestonesStore(db, 'chat_x').list())).toHaveLength(0)
    expect((await makeEventsStore(memoryRoot, 'chat_x').list())).toHaveLength(0)  // all events were demo
  })

  it('unseed is idempotent (no-op on empty/already-clean state)', async () => {
    const r = await unseedDemo({ stateDir, chatId: 'chat_x', db })
    expect(r.removed).toBe(0)
  })
})
