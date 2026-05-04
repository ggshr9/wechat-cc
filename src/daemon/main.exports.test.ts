// Regression guard for the v0.5.0 silent-no-op bug:
// cli.ts's `run` command imports this module and calls `main()` explicitly.
// If we ever drop the named export, the compiled `wechat-cc-cli.exe run`
// command goes back to silently doing nothing (import.meta.main is false
// for imported modules, so a top-level `if (import.meta.main) main()` would
// never fire).
import { describe, expect, it } from 'vitest'
import * as mainModule from './main'

describe('src/daemon/main exports', () => {
  it('exports main() so cli.ts run command can invoke the daemon', () => {
    expect(typeof mainModule.main).toBe('function')
  })

  it('exports bootDaemon() so the e2e harness can boot programmatically', () => {
    expect(typeof mainModule.bootDaemon).toBe('function')
  })
})
