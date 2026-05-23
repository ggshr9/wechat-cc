import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../../src/lib/db'
import { makeObservationsStore } from '../../../src/daemon/observations/store'
import { captureSnapshot } from './snapshot'
import type { FakeIlinkHandle } from '../../../src/daemon/__e2e__/fake-ilink-server'

describe('captureSnapshot', () => {
  let stateDir: string
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'snapshot-test-'))
    mkdirSync(join(stateDir, 'memory', 'chat_1'), { recursive: true })
  })
  afterEach(() => { try { rmSync(stateDir, { recursive: true, force: true }) } catch { /* ignore */ } })

  it('returns observations + memory files + outbox for the chat', async () => {
    const db = openDb({ path: join(stateDir, 'wechat-cc.db') })
    const obs = makeObservationsStore(db, 'chat_1')
    await obs.append({ body: 'user mentioned migration', tone: 'concern' })
    writeFileSync(join(stateDir, 'memory', 'chat_1', 'profile.md'), '# 顾时瑞\n后端工程师')
    writeFileSync(join(stateDir, 'memory', 'chat_1', 'notes.md'), '- 504 noted')

    const fakeIlink = {
      outbox: () => [
        { endpoint: 'sendmessage' as const, chatId: 'chat_1', text: 'hi', raw: {} },
        { endpoint: 'sendmessage' as const, chatId: 'chat_other', text: 'nope', raw: {} },
      ],
    } as unknown as FakeIlinkHandle

    const snap = await captureSnapshot({
      stateDir, db, chatId: 'chat_1', ilink: fakeIlink,
    })

    expect(snap.observations.active).toHaveLength(1)
    expect(snap.observations.active[0]!.body).toBe('user mentioned migration')
    expect(snap.observations.archived).toHaveLength(0)
    expect(snap.memory.files['profile.md']).toContain('顾时瑞')
    expect(snap.memory.files['notes.md']).toBe('- 504 noted')
    expect(snap.outbox).toHaveLength(1)
    expect(snap.outbox[0]!.text).toBe('hi')
    db.close()
  })
})
