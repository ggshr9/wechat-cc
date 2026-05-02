import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchAcrossSessions } from './searcher'

describe('searchAcrossSessions', () => {
  let stateDir: string
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'searcher-'))
  })
  afterEach(() => rmSync(stateDir, { recursive: true, force: true }))

  it('returns empty for empty query', async () => {
    expect(await searchAcrossSessions('', { stateDir })).toEqual([])
    expect(await searchAcrossSessions('   ', { stateDir })).toEqual([])
  })

  it('returns empty when sessions.json has no aliases', async () => {
    writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({ version: 1, sessions: {} }))
    expect(await searchAcrossSessions('anything', { stateDir })).toEqual([])
  })

  it('returns empty when alias maps to a missing jsonl', async () => {
    writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: { compass: { session_id: 's_nonexistent', last_used_at: '2026-01-01T00:00:00Z' } },
    }))
    expect(await searchAcrossSessions('foo', { stateDir })).toEqual([])
  })

  // Set up a fake $HOME so the path resolver finds our test jsonl.
  // The searcher uses os.homedir() through path-resolver — we can't pass a
  // home override directly, but setting HOME env works for both macOS/linux.
  function withFakeHome(setup: (projects: string) => void, run: (home: string) => Promise<void>) {
    const fakeHome = mkdtempSync(join(tmpdir(), 'searcher-home-'))
    const projects = join(fakeHome, '.claude', 'projects', 'test-cwd')
    mkdirSync(projects, { recursive: true })
    setup(projects)
    return run(fakeHome).finally(() => rmSync(fakeHome, { recursive: true, force: true }))
  }

  it('returns parsed turn + session_has_reply_tool=true when reply tool is used', async () => {
    await withFakeHome(
      (projects) => {
        const userTurn = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<wechat>我是谁</wechat>' }] } })
        const replyTurn = JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [
            { type: 'tool_use', name: 'mcp__wechat__reply', input: { text: '你是 GSR' } },
          ]},
        })
        writeFileSync(join(projects, 'sid-A.jsonl'), userTurn + '\n' + replyTurn + '\n')
        writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({
          version: 1, sessions: { _default: { session_id: 'sid-A', last_used_at: '2026-04-29T00:00:00Z' } },
        }))
      },
      async (home) => {
        const hits = await searchAcrossSessions('我是谁', { stateDir, home })
        expect(hits).toHaveLength(1)
        expect(hits[0]!.alias).toBe('_default')
        expect(hits[0]!.turn).toBeTruthy()
        expect((hits[0]!.turn as any).type).toBe('user')
        expect(hits[0]!.session_has_reply_tool).toBe(true)
      },
    )
  })

  it('returns session_has_reply_tool=false when no reply tool is used', async () => {
    await withFakeHome(
      (projects) => {
        const turn = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'plain' }] } })
        writeFileSync(join(projects, 'sid-B.jsonl'), turn + '\n')
        writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({
          version: 1, sessions: { plain: { session_id: 'sid-B', last_used_at: '2026-04-29T00:00:00Z' } },
        }))
      },
      async (home) => {
        const hits = await searchAcrossSessions('plain', { stateDir, home })
        expect(hits).toHaveLength(1)
        expect(hits[0]!.session_has_reply_tool).toBe(false)
      },
    )
  })

  it('survives malformed lines — turn is null, but hit still returned', async () => {
    await withFakeHome(
      (projects) => {
        // Hit "needle" inside a malformed (non-JSON) line. The searcher
        // shouldn't drop the match; it should set turn=null and let the
        // client decide to hide it in compact mode.
        writeFileSync(join(projects, 'sid-C.jsonl'), 'not-json-but-contains needle\n')
        writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({
          version: 1, sessions: { x: { session_id: 'sid-C', last_used_at: '2026-04-29T00:00:00Z' } },
        }))
      },
      async (home) => {
        const hits = await searchAcrossSessions('needle', { stateDir, home })
        expect(hits).toHaveLength(1)
        expect(hits[0]!.turn).toBeNull()
      },
    )
  })
})
