import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTickBodies, type TickDeps } from './tick-bodies'

// Minimal pushTick test — verifies the PR D guard that companion ticks
// skip when the same (alias, providerId) session has an in-flight user
// dispatch. We mock only the surface tick-bodies touches.

function makeStateDir(cfg: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tick-bodies-test-'))
  mkdirSync(join(dir, 'companion'), { recursive: true })
  writeFileSync(join(dir, 'companion', 'config.json'), JSON.stringify(cfg))
  return dir
}

interface Setup {
  stateDir: string
  acquire: ReturnType<typeof vi.fn>
  isInFlight: ReturnType<typeof vi.fn>
  dispatch: ReturnType<typeof vi.fn>
  logs: string[]
  deps: TickDeps
}

function setupDeps(opts: {
  defaultChatId: string | null
  inFlight: boolean
}): Setup {
  const stateDir = makeStateDir({
    enabled: true,
    ...(opts.defaultChatId ? { default_chat_id: opts.defaultChatId } : {}),
  })
  const logs: string[] = []
  const dispatch = vi.fn(async () => {})
  const acquire = vi.fn(async (_alias: string, _path: string, _providerId: string) => ({
    alias: 'a', path: '/p', providerId: 'claude', lastUsedAt: 0,
    dispatch, close: async () => {},
  }))
  const isInFlight = vi.fn(() => opts.inFlight)
  const deps: TickDeps = {
    stateDir,
    db: {} as never,
    ilink: {
      loadProjects: () => ({ projects: {}, current: null }),
    } as never,
    boot: {
      sessionManager: { acquire, isInFlight } as never,
      defaultProviderId: 'claude' as never,
    } as never,
    log: (tag, line) => { logs.push(`${tag}|${line}`) },
  }
  return { stateDir, acquire, isInFlight, dispatch, logs, deps }
}

describe('buildTickBodies / pushTick — companion isolation (PR D)', () => {
  let cleanup: string[]
  beforeEach(() => { cleanup = [] })
  afterEach(() => {
    for (const d of cleanup) {
      try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })

  it('skips the tick when the resolved session has an in-flight dispatch', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: true })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick()
    expect(s.isInFlight).toHaveBeenCalledWith('_default', 'claude')
    expect(s.acquire).not.toHaveBeenCalled()
    expect(s.dispatch).not.toHaveBeenCalled()
    expect(s.logs.some(l => l.includes('skipping push tick: user session in-flight'))).toBe(true)
  })

  it('proceeds when no in-flight dispatch on the session', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick()
    expect(s.isInFlight).toHaveBeenCalledWith('_default', 'claude')
    expect(s.acquire).toHaveBeenCalledOnce()
    expect(s.dispatch).toHaveBeenCalledOnce()
  })

  it('skips before checking in-flight when default_chat_id is unset', async () => {
    const s = setupDeps({ defaultChatId: null, inFlight: false })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick()
    expect(s.isInFlight).not.toHaveBeenCalled()
    expect(s.acquire).not.toHaveBeenCalled()
  })
})
