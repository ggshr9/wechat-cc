import { describe, it, expect } from 'vitest'
import { findCodexBinary } from './find-codex-binary'

const HOME = '/home/u'

describe('findCodexBinary', () => {
  // ── PATH lookup (the canonical case) ─────────────────────────────────────

  it('finds codex from a PATH entry (linux)', () => {
    const fs = new Set(['/usr/local/bin/codex'])
    const result = findCodexBinary({
      exists: (p) => fs.has(p),
      readdir: () => [],
      pathEnv: '/usr/local/bin:/usr/bin',
      homeDir: HOME,
      platform: 'linux',
    })
    expect(result).toBe('/usr/local/bin/codex')
  })

  it('returns first PATH match (left-to-right priority)', () => {
    const fs = new Set([
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
    ])
    const result = findCodexBinary({
      exists: (p) => fs.has(p),
      readdir: () => [],
      pathEnv: '/opt/homebrew/bin:/usr/local/bin',
      homeDir: HOME,
      platform: 'darwin',
    })
    expect(result).toBe('/opt/homebrew/bin/codex')
  })

  it('skips empty PATH entries (PATH="::/usr/bin:" produces "" segments)', () => {
    const fs = new Set(['/usr/bin/codex'])
    const result = findCodexBinary({
      exists: (p) => fs.has(p),
      readdir: () => [],
      pathEnv: '::/usr/bin:',
      homeDir: HOME,
      platform: 'linux',
    })
    expect(result).toBe('/usr/bin/codex')
  })

  it('uses codex.exe + ; separator on win32', () => {
    const fs = new Set(['C:\\bin\\codex.exe'])
    const result = findCodexBinary({
      exists: (p) => fs.has(p),
      readdir: () => [],
      pathEnv: 'C:\\bin;C:\\other',
      homeDir: 'C:\\Users\\u',
      platform: 'win32',
    })
    expect(result).toBe('C:\\bin\\codex.exe')
  })

  // ── nvm fallback (systemd-user / launchd paths without nvm-sourced shell)

  it('falls back to ~/.nvm/versions/node when PATH does not contain codex (newest-version wins)', () => {
    const fs = new Set([
      '/home/u/.nvm/versions/node',
      '/home/u/.nvm/versions/node/v20.0.0/bin/codex',
      '/home/u/.nvm/versions/node/v22.5.0/bin/codex',
    ])
    const result = findCodexBinary({
      exists: (p) => fs.has(p),
      readdir: () => ['v20.0.0', 'v22.5.0'],
      pathEnv: '/usr/bin',
      homeDir: HOME,
      platform: 'linux',
    })
    expect(result).toBe('/home/u/.nvm/versions/node/v22.5.0/bin/codex')
  })

  it('skips nvm fallback on win32', () => {
    let nvmReadCount = 0
    const result = findCodexBinary({
      exists: () => false,
      readdir: () => { nvmReadCount++; return [] },
      pathEnv: 'C:\\bin',
      homeDir: 'C:\\Users\\u',
      platform: 'win32',
    })
    expect(result).toBeNull()
    expect(nvmReadCount).toBe(0)
  })

  it('survives a readdir throw on the nvm root (e.g. permission denied) and just returns null', () => {
    const result = findCodexBinary({
      exists: (p) => p === '/home/u/.nvm/versions/node',
      readdir: () => { throw new Error('EACCES') },
      pathEnv: '/usr/bin',
      homeDir: HOME,
      platform: 'linux',
    })
    expect(result).toBeNull()
  })

  // ── Not-found path ───────────────────────────────────────────────────────

  it('returns null when codex is nowhere — caller surfaces the "install codex" error', () => {
    const result = findCodexBinary({
      exists: () => false,
      readdir: () => [],
      pathEnv: '/usr/bin:/usr/local/bin',
      homeDir: HOME,
      platform: 'linux',
    })
    expect(result).toBeNull()
  })

  // ── Regression: bundled probes must NOT win over user PATH ───────────────
  //
  // Earlier iterations (pre-Task #18) probed several `node_modules/@openai/codex/
  // bin/codex.js` paths before falling back to PATH. That meant a stale-bundled
  // wechat-cc would silently use a different version than the user's `codex`,
  // creating confusing "I upgraded codex, why isn't it in use?" reports. These
  // tests guard against accidentally re-introducing that behavior.

  it('does NOT probe any node_modules path — only PATH + nvm', () => {
    let probed: string[] = []
    const fs = new Set(['/usr/local/bin/codex'])
    const result = findCodexBinary({
      exists: (p) => { probed.push(p); return fs.has(p) },
      readdir: () => [],
      pathEnv: '/usr/local/bin',
      homeDir: HOME,
      platform: 'linux',
    })
    expect(result).toBe('/usr/local/bin/codex')
    // No probed path should mention `node_modules` — the old bundled-probe
    // step ALWAYS produced such paths before checking PATH.
    expect(probed.some(p => p.includes('node_modules'))).toBe(false)
  })

  it('does NOT probe ~/.claude/plugins/local/wechat (pre-Task-#18 wizards-probe-roots regression guard)', () => {
    let probed: string[] = []
    const fs = new Set<string>()
    findCodexBinary({
      exists: (p) => { probed.push(p); return fs.has(p) },
      readdir: () => [],
      pathEnv: '/usr/bin',
      homeDir: HOME,
      platform: 'linux',
    })
    expect(probed.some(p => p.includes('.claude/plugins/local/wechat'))).toBe(false)
    expect(probed.some(p => p.includes('.local/share/wechat-cc'))).toBe(false)
  })
})
