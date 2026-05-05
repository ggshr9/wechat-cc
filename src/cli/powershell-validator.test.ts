import { describe, expect, it } from 'vitest'
import { validatePowerShellScript } from './powershell-validator'

// Why this module exists at all:
//
// service-manager.ts generates PowerShell scripts for the Windows
// Scheduled-Task install/start/stop/uninstall commands. The previous
// test discipline ("decode the -EncodedCommand argv, grep for tokens")
// had a documented hole: it accepted ANY string-shape match, including
// scripts that crash at PowerShell parameter-binding time. v0.5.1 shipped
// `New-ScheduledTaskSettingsSet -AllowHardTerminate $true` because grep
// said the substring was there — but that param doesn't exist on the
// cmdlet, so every Win11 install path-failed. We've shipped >10 Win
// regressions over the past year that all pass grep then crash on
// real PowerShell. This validator closes that gap.
//
// Strategy: spawn powershell.exe, AST-parse the script, walk every
// CommandAst, look up each cmdlet via Get-Command, and assert each
// supplied parameter name resolves to a real (or unambiguously-prefixed)
// parameter on that cmdlet. Catches the AllowHardTerminate bug class.
describe('validatePowerShellScript', () => {
  it('returns unsupported-platform on non-Windows hosts', () => {
    if (process.platform === 'win32') return // platform-gated test of opposite kind
    const r = validatePowerShellScript(`Get-Process`)
    expect(r?.kind).toBe('unsupported-platform')
  })

  // Win-only — the validator spawns powershell.exe and inspects cmdlets that
  // only exist on Windows (e.g. New-ScheduledTaskSettingsSet). Skipped on
  // non-Windows hosts; CI windows-latest runs this.
  describe.runIf(process.platform === 'win32')('on Windows', () => {
    it('returns null for a script with only valid cmdlet parameters', () => {
      const r = validatePowerShellScript(`Get-Process -Name 'powershell'`)
      expect(r).toBeNull()
    })

    // The bug class this validator was built to catch. Without this sanity
    // test, a no-op validator (always returns null) would silently pass
    // every other test — and the AllowHardTerminate regression would ship
    // again. This test PINS the validator's behavior as real.
    it('flags a bogus parameter on a real cmdlet (the -AllowHardTerminate bug class)', () => {
      const r = validatePowerShellScript(`Get-Process -ThisParameterDoesNotExist 'foo'`)
      expect(r).not.toBeNull()
      expect(r?.kind).toBe('binding')
      expect(r?.message).toMatch(/Get-Process/)
      expect(r?.message).toMatch(/ThisParameterDoesNotExist/)
    })

    it('flags a true parse error (unclosed quote)', () => {
      const r = validatePowerShellScript(`Get-Process -Name 'unterminated`)
      expect(r).not.toBeNull()
      expect(r?.kind).toBe('parse')
    })

    // External executables can't be introspected via Get-Command's parameter
    // metadata (it returns CommandType=Application, not Cmdlet). Skipping
    // them is the right call — we'd produce false positives on every legit
    // schtasks.exe / git.exe / curl.exe call. Pin that behavior.
    it('skips external executables (no false positives on .exe calls)', () => {
      const r = validatePowerShellScript(`schtasks.exe /MadeUpFlag /AnotherOne`)
      expect(r).toBeNull()
    })

    // Property assignment on objects (the form we'll use to set
    // AllowHardTerminate after the cmdlet returns) is NOT a CommandAst —
    // it's an AssignmentStatementAst. The validator must not flag it.
    it('ignores property assignments on objects', () => {
      const r = validatePowerShellScript(
        `$o = New-Object PSObject -Property @{ Foo = 1 }
$o.Bar = 2`,
      )
      expect(r).toBeNull()
    })
  })
})
