/**
 * Bridges the daemon-owned observations / milestones stores to the
 * `LifeStoresReader` that `synthesizeOverview` consumes. Lives in the daemon
 * layer on purpose: it keeps `src/lib/memory-synthesis.ts` free of any
 * `src/daemon/**` import, honouring the cli-must-not-depend-on-daemon boundary
 * (the dependency now points daemon → cli, which is allowed).
 */
import { join } from 'node:path'
import type { Db } from '../lib/db'
import type { LifeStoresReader } from '../lib/memory-synthesis'
import { makeObservationsStore } from './observations/store'
import { makeMilestonesStore } from './milestones/store'

export function makeLifeStoresReader(db: Db, stateDir: string): LifeStoresReader {
  const memoryRoot = join(stateDir, 'memory')
  return {
    async listObservations(adminChatId) {
      const store = makeObservationsStore(db, adminChatId, { migrateFromFile: join(memoryRoot, adminChatId, 'observations.jsonl') })
      return (await store.listActive()).map(o => o.body)
    },
    async listMilestones(adminChatId) {
      const store = makeMilestonesStore(db, adminChatId, { migrateFromFile: join(memoryRoot, adminChatId, 'milestones.jsonl') })
      return (await store.list()).map(m => m.body)
    },
  }
}
