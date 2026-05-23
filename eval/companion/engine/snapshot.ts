import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../../../src/lib/db'
import { makeObservationsStore, type ObservationRecord } from '../../../src/daemon/observations/store'
import type { FakeIlinkHandle, OutboundMsg } from '../../../src/daemon/__e2e__/fake-ilink-server'

export interface StateSnapshot {
  observations: {
    active: ObservationRecord[]
    archived: ObservationRecord[]
  }
  memory: {
    files: Record<string, string>
  }
  outbox: OutboundMsg[]
}

export interface SnapshotOpts {
  stateDir: string
  db: Db
  chatId: string
  ilink: FakeIlinkHandle
}

export async function captureSnapshot(opts: SnapshotOpts): Promise<StateSnapshot> {
  const store = makeObservationsStore(opts.db, opts.chatId)
  const active = await store.listActive()
  const archived = await store.listArchived()

  const memDir = join(opts.stateDir, 'memory', opts.chatId)
  const files: Record<string, string> = {}
  if (existsSync(memDir)) {
    for (const ent of readdirSync(memDir, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith('.md')) continue
      try { files[ent.name] = readFileSync(join(memDir, ent.name), 'utf8') } catch { /* skip unreadable */ }
    }
  }

  const outbox = opts.ilink.outbox().filter(
    m => m.endpoint === 'sendmessage' && m.chatId === opts.chatId,
  )

  return {
    observations: { active, archived },
    memory: { files },
    outbox: [...outbox],
  }
}
