import { describe, it, expect } from 'vitest'
import { findCodexBinary } from './find-codex-binary'

const HOME = '/home/u'

describe('findCodexBinary', () => {
  it('prefers the macOS .app bundle Resources shim (highest priority — version-matched + immune to global codex on PATH)', () => {
    // Desktop installer ships @openai/codex inside the .app at
    // Contents/Resources/codex. find-codex-binary derives that path from
    // process.execPath when the daemon was launched as a Tauri sidecar.
    const execPath = '/Applications/wechat-cc.app/Contents/MacOS/wechat-cc-cli'
    const fs = new Set([
      '/Applications/wechat-cc.app/Contents/Resources/codex/bin/codex.js',
      // Even when a plugin-style install ALSO has the shim, the .app
      // bundle wins — it's the source of truth for the installed daemon.
      '/home/u/.claude/plugins/local/wechat/node_modules/@openai/codex/bin/codex.js',
      '/usr/local/bin/codex',
    ])
    const result = findCodexBinary({
      exists: (p) => fs.has(p),
      readdir: () => [],
      pathEnv: '/usr/local/bin',
      homeDir: HOME,
      platform: 'darwin',
      execPath,
    })
    expect(result).toBe('/Applications/wechat-cc.app/Contents/Resources/codex/bin/codex.js')
  })

  it('skips the .app bundle probe when execPath is not a Tauri-style sidecar layout', () => {
    // Running from source (`bun src/daemon/main.ts`) — execPath points
    // somewhere like /opt/homebrew/bin/bun. The probe must not invent a
    // fake Resources path off such a parent.
    const fs = new Set(['/home/u/.claude/plugins/local/wechat/node_modules/@openai/codex/bin/codex.js'])
    const result = findCodexBinary({
      exists: (p) => fs.has(p),
      readdir: () => [],
      pathEnv: '/usr/local/bin',
      homeDir: HOME,
      platform: 'darwin',
      execPath: '/opt/homebrew/bin/bun',
    })
    expect(result).toBe('/home/u/.claude/plugins/local/wechat/node_modules/@openai/codex/bin/codex.js')
  })

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

  // ── moduleUrl probe (daemon-repo node_modules) ────────────────────────────
  // Covers the common dev / source-mode case (`bun src/daemon/main.ts` from
  // an arbitrary repo clone) AND `npm i -g wechat-cc` → `wechat-cc run`,
  // where the wizards-recommended probe roots don't match.

  it('prefers daemon-repo node_modules (derived from moduleUrl) over PATH', () => {
    const fs = new Set([
      '/Users/dev/wechat-cc/node_modules/@openai/codex/bin/codex.js',
      '/usr/local/bin/codex',
    ])
    const result = findCodexBinary({
      exists: (p) => fs.has(p),
      readdir: () => [],
      pathEnv: '/usr/local/bin',
      homeDir: HOME,
      platform: 'darwin',
      execPath: '/opt/homebrew/bin/bun',
      moduleUrl: 'file:///Users/dev/wechat-cc/src/lib/find-codex-binary.ts',
      wechatCcRoot: undefined,
    })
    expect(result).toBe('/Users/dev/wechat-cc/node_modules/@openai/codex/bin/codex.js')
  })

  it('moduleUrl probe loses to explicit WECHAT_CC_ROOT (the env var is operator intent)', () => {
    const fs = new Set([
      '/Users/dev/wechat-cc/node_modules/@openai/codex/bin/codex.js',
      '/opt/override/wechat-cc/node_modules/@openai/codex/bin/codex.js',
    ])
    const result = findCodexBinary({
      exists: (p) => fs.has(p),
      readdir: () => [],
      pathEnv: '/usr/local/bin',
      homeDir: HOME,
      platform: 'darwin',
      execPath: '/opt/homebrew/bin/bun',
      moduleUrl: 'file:///Users/dev/wechat-cc/src/lib/find-codex-binary.ts',
      wechatCcRoot: '/opt/override/wechat-cc',
    })
    expect(result).toBe('/opt/override/wechat-cc/node_modules/@openai/codex/bin/codex.js')
  })

  it('moduleUrl probe is a no-op when the URL is a Bun virtual-fs path (compiled-binary mode)', () => {
    // bun build --compile packs files into /$bunfs/... — fileURLToPath
    // returns a real-looking string but the on-disk node_modules check
    // must fail. Verify by giving a fake fs that contains a tempting
    // /$bunfs/.../node_modules entry — it must NOT be picked.
    const fs = new Set([
      '/$bunfs/root/wechat-cc/node_modules/@openai/codex/bin/codex.js',
      '/usr/local/bin/codex',
    ])
    const result = findCodexBinary({
      exists: (p) => fs.has(p),
      readdir: () => [],
      pathEnv: '/usr/local/bin',
      homeDir: HOME,
      platform: 'linux',
      execPath: '/$bunfs/root/wechat-cc-cli',
      moduleUrl: 'file:///$bunfs/root/wechat-cc/src/lib/find-codex-binary.ts',
      wechatCcRoot: undefined,
    })
    expect(result).toBe('/usr/local/bin/codex')
  })

  it('moduleUrl probe is skipped when no daemon-repo node_modules exists (falls through to PATH)', () => {
    const fs = new Set(['/usr/local/bin/codex'])
    const result = findCodexBinary({
      exists: (p) => fs.has(p),
      readdir: () => [],
      pathEnv: '/usr/local/bin',
      homeDir: HOME,
      platform: 'darwin',
      execPath: '/opt/homebrew/bin/bun',
      moduleUrl: 'file:///Users/dev/wechat-cc/src/lib/find-codex-binary.ts',
      wechatCcRoot: undefined,
    })
    expect(result).toBe('/usr/local/bin/codex')
  })
})
