import { describe, it, expect, vi } from 'vitest'
import { attemptCodexAutofix, type CodexAutofixDeps } from './codex-autofix'

function baseDeps(overrides: Partial<CodexAutofixDeps> = {}): CodexAutofixDeps {
  return {
    installDir: '/repo',
    bundledSdkVersion: '0.128.0',
    detectUserCodex: () => ({ path: '/usr/local/bin/codex', version: '0.133.0' }),
    spawnBun: vi.fn(async () => ({ ok: true, stderr: '' })),
    isWritable: () => true,
    envDisabled: false,
    log: () => {},
    ...overrides,
  }
}

describe('attemptCodexAutofix', () => {
  it('returns "disabled" when WECHAT_CC_DISABLE_CODEX_AUTOFIX is set', async () => {
    const spawnBun = vi.fn()
    const out = await attemptCodexAutofix(baseDeps({
      envDisabled: true,
      spawnBun: spawnBun as unknown as CodexAutofixDeps['spawnBun'],
    }))
    expect(out).toEqual({ status: 'disabled' })
    expect(spawnBun).not.toHaveBeenCalled()
  })

  it('returns "no_user_codex" when user has no codex on PATH', async () => {
    const spawnBun = vi.fn()
    const out = await attemptCodexAutofix(baseDeps({
      detectUserCodex: () => ({ path: null, version: null }),
      spawnBun: spawnBun as unknown as CodexAutofixDeps['spawnBun'],
    }))
    expect(out).toEqual({ status: 'no_user_codex' })
    expect(spawnBun).not.toHaveBeenCalled()
  })

  it('returns "no_user_codex" when probe failed (path but no version)', async () => {
    const spawnBun = vi.fn()
    const out = await attemptCodexAutofix(baseDeps({
      detectUserCodex: () => ({ path: '/usr/local/bin/codex', version: null }),
      spawnBun: spawnBun as unknown as CodexAutofixDeps['spawnBun'],
    }))
    expect(out).toEqual({ status: 'no_user_codex' })
    expect(spawnBun).not.toHaveBeenCalled()
  })

  it('returns "matched" without spawning when user version equals bundled', async () => {
    const spawnBun = vi.fn()
    const out = await attemptCodexAutofix(baseDeps({
      detectUserCodex: () => ({ path: '/usr/local/bin/codex', version: '0.128.0' }),
      spawnBun: spawnBun as unknown as CodexAutofixDeps['spawnBun'],
    }))
    expect(out).toEqual({ status: 'matched', version: '0.128.0' })
    expect(spawnBun).not.toHaveBeenCalled()
  })

  it('returns "unsafe" when installDir is null (compiled-binary mode)', async () => {
    const out = await attemptCodexAutofix(baseDeps({ installDir: null }))
    expect(out.status).toBe('unsafe')
  })

  it('returns "unsafe" when installDir is not writable', async () => {
    const spawnBun = vi.fn()
    const out = await attemptCodexAutofix(baseDeps({
      isWritable: () => false,
      spawnBun: spawnBun as unknown as CodexAutofixDeps['spawnBun'],
    }))
    expect(out.status).toBe('unsafe')
    expect(spawnBun).not.toHaveBeenCalled()
  })

  it('spawns `bun add @openai/codex-sdk@<userVer> @openai/codex@<userVer>` and returns "fixed" on success', async () => {
    type SpawnBun = NonNullable<CodexAutofixDeps['spawnBun']>
    const spawnBun = vi.fn<SpawnBun>(async () => ({ ok: true, stderr: '' }))
    const out = await attemptCodexAutofix(baseDeps({ spawnBun }))
    expect(out).toEqual({ status: 'fixed', from: '0.128.0', to: '0.133.0' })
    expect(spawnBun).toHaveBeenCalledOnce()
    const call = spawnBun.mock.calls[0]!
    expect(call[0]).toEqual([
      'add',
      '@openai/codex-sdk@0.133.0',
      '@openai/codex@0.133.0',
    ])
    expect(call[1]).toBe('/repo')
  })

  it('returns "failed" with stderr when bun add exits non-zero', async () => {
    const spawnBun = vi.fn(async () => ({ ok: false, stderr: 'network error: EAI_AGAIN' }))
    const out = await attemptCodexAutofix(baseDeps({
      spawnBun: spawnBun as unknown as CodexAutofixDeps['spawnBun'],
    }))
    expect(out).toEqual({
      status: 'failed',
      from: '0.128.0',
      to: '0.133.0',
      reason: 'network error: EAI_AGAIN',
    })
  })

  it('returns "failed" with placeholder reason when stderr is empty', async () => {
    const spawnBun = vi.fn(async () => ({ ok: false, stderr: '   \n\n' }))
    const out = await attemptCodexAutofix(baseDeps({
      spawnBun: spawnBun as unknown as CodexAutofixDeps['spawnBun'],
    }))
    expect(out.status).toBe('failed')
    if (out.status !== 'failed') return
    expect(out.reason).toBe('(no stderr)')
  })

  it('logs a single line before spawning bun (lets operators see the action)', async () => {
    const log = vi.fn()
    const spawnBun = vi.fn(async () => ({ ok: true, stderr: '' }))
    await attemptCodexAutofix(baseDeps({
      log,
      spawnBun: spawnBun as unknown as CodexAutofixDeps['spawnBun'],
    }))
    expect(log).toHaveBeenCalledOnce()
    const msg = log.mock.calls[0]![0] as string
    expect(msg).toContain('0.128.0')
    expect(msg).toContain('0.133.0')
    expect(msg).toContain('bun add')
  })

  it('does not log when no work to do (matched or no_user_codex)', async () => {
    const log = vi.fn()
    await attemptCodexAutofix(baseDeps({
      log,
      detectUserCodex: () => ({ path: '/usr/local/bin/codex', version: '0.128.0' }),
    }))
    expect(log).not.toHaveBeenCalled()
  })

  it('returns "timed_out" when bun add exceeds the timeout', async () => {
    type SpawnBun = NonNullable<CodexAutofixDeps['spawnBun']>
    // spawn that never resolves — simulates a hung `bun add` (real-world:
    // slow npm registry + cache lock contention).
    const spawnBun = vi.fn<SpawnBun>(() => new Promise(() => {}))
    const out = await attemptCodexAutofix(baseDeps({
      spawnBun,
      timeoutMs: 50,
    }))
    expect(out).toEqual({
      status: 'timed_out',
      from: '0.128.0',
      to: '0.133.0',
      timeoutMs: 50,
    })
  })

  it('completes within the timeout when bun add is fast', async () => {
    type SpawnBun = NonNullable<CodexAutofixDeps['spawnBun']>
    const spawnBun = vi.fn<SpawnBun>(async () => ({ ok: true, stderr: '' }))
    const out = await attemptCodexAutofix(baseDeps({
      spawnBun,
      timeoutMs: 5_000,
    }))
    expect(out.status).toBe('fixed')
  })
})
