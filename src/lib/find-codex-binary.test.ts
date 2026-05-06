import { describe, it, expect } from 'vitest'
import { findCodexBinary } from './find-codex-binary'

const HOME = '/home/u'

describe('findCodexBinary', () => {
  it('prefers wechat-cc-bundled JS shim over PATH/nvm (version-matched)', () => {
    const fs = new Set([
      '/home/u/.claude/plugins/local/wechat/node_modules/@openai/codex/bin/codex.js',
      '/usr/bin/codex',  // older system codex — should NOT win
    ])
    const result = findCodexBinary({
      exists: (p) => fs.has(p),
      readdir: () => [],
      pathEnv: '/usr/bin',
      homeDir: HOME,
      platform: 'linux',
    })
    expect(result).toBe('/home/u/.claude/plugins/local/wechat/node_modules/@openai/codex/bin/codex.js')
  })

  it('honours WECHAT_CC_ROOT when set (alternative source location)', () => {
    const fs = new Set(['/opt/wechat-cc/node_modules/@openai/codex/bin/codex.js'])
    const result = findCodexBinary({
      exists: (p) => fs.has(p),
      readdir: () => [],
      pathEnv: '/usr/bin',
      homeDir: HOME,
      platform: 'linux',
      wechatCcRoot: '/opt/wechat-cc',
    })
    expect(result).toBe('/opt/wechat-cc/node_modules/@openai/codex/bin/codex.js')
  })

  it('falls through to PATH when wechat-cc bundled shim is missing', () => {
    const fs = new Set(['/usr/bin/codex'])
    const result = findCodexBinary({
      exists: (p) => fs.has(p),
      readdir: () => [],
      pathEnv: '/usr/bin',
      homeDir: HOME,
      platform: 'linux',
    })
    expect(result).toBe('/usr/bin/codex')
  })

  it('returns the first PATH entry that has an executable named "codex"', () => {
    const fs = new Set([
      '/usr/local/bin/codex',
      '/home/u/.local/bin/codex',
    ])
    const result = findCodexBinary({
      exists: (p) => fs.has(p),
      readdir: () => [],
      pathEnv: '/usr/bin:/usr/local/bin:/home/u/.local/bin',
      homeDir: HOME,
      platform: 'linux',
    })
    expect(result).toBe('/usr/local/bin/codex')  // first hit wins, /usr/bin had no codex
  })

  it('returns null when nothing is found anywhere', () => {
    const result = findCodexBinary({
      exists: () => false,
      readdir: () => [],
      pathEnv: '/usr/bin:/usr/local/bin',
      homeDir: HOME,
      platform: 'linux',
    })
    expect(result).toBeNull()
  })

  it('falls back to nvm when PATH has no codex', () => {
    const fs = new Set([
      '/home/u/.nvm/versions/node',
      '/home/u/.nvm/versions/node/v22.22.2/bin/codex',
    ])
    const result = findCodexBinary({
      exists: (p) => fs.has(p),
      readdir: () => ['v22.22.2', 'v20.10.0'],
      pathEnv: '/usr/bin',
      homeDir: HOME,
      platform: 'linux',
    })
    expect(result).toBe('/home/u/.nvm/versions/node/v22.22.2/bin/codex')
  })

  it('walks nvm versions newest-first (string-desc) and stops at the first that has codex', () => {
    const fs = new Set([
      '/home/u/.nvm/versions/node',
      '/home/u/.nvm/versions/node/v18.0.0/bin/codex',  // older has codex
      // v22.x intentionally missing — expected to skip
    ])
    const result = findCodexBinary({
      exists: (p) => fs.has(p),
      readdir: () => ['v18.0.0', 'v22.22.2', 'v20.10.0'],
      pathEnv: '/usr/bin',
      homeDir: HOME,
      platform: 'linux',
    })
    expect(result).toBe('/home/u/.nvm/versions/node/v18.0.0/bin/codex')
  })

  it('on Windows: splits PATH on ; and looks for codex.exe (not codex)', () => {
    const probed: string[] = []
    findCodexBinary({
      // Probe-only: capture every existsSync candidate
      exists: (p) => { probed.push(p); return false },
      readdir: () => [],
      pathEnv: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
      homeDir: 'C:\\Users\\u',
      platform: 'win32',
    })
    // Both PATH segments probed (semicolon split) + binary suffix is codex.exe.
    // Path separator is host-OS-dependent (test runs on Linux), so we just
    // assert the basename is codex.exe and both PATH dirs were tried.
    expect(probed.some(p => /codex\.exe$/.test(p) && /System32/.test(p))).toBe(true)
    expect(probed.some(p => /codex\.exe$/.test(p) && /nodejs/.test(p))).toBe(true)
  })

  it('does not consult nvm on Windows', () => {
    let nvmReadCount = 0
    const result = findCodexBinary({
      exists: () => false,
      readdir: () => { nvmReadCount++; return [] },
      pathEnv: 'C:\\Windows\\System32',
      homeDir: 'C:\\Users\\u',
      platform: 'win32',
    })
    expect(result).toBeNull()
    expect(nvmReadCount).toBe(0)
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
})
