import { describe, expect, it } from 'vitest'
import { checkCodexVersion } from './codex-version-check'

describe('checkCodexVersion', () => {
  it('passes when the CLI reports the exact expected version', () => {
    const result = checkCodexVersion({
      binary: '/usr/local/bin/codex',
      probe: () => '0.128.0',
      expectedVersion: '0.128.0',
    })
    expect(result.ok).toBe(true)
    expect(result.actualSemver).toBe('0.128.0')
  })

  it('extracts the semver from a prefixed --version string ("codex-cli 0.128.0")', () => {
    // The codex CLI's --version output is "codex-cli <semver>"; comparing
    // raw strings would falsely reject the matched case. The check must
    // pull the semver out before comparing.
    const result = checkCodexVersion({
      binary: '/usr/local/bin/codex',
      probe: () => 'codex-cli 0.128.0',
      expectedVersion: '0.128.0',
    })
    expect(result.ok).toBe(true)
    expect(result.actualSemver).toBe('0.128.0')
  })

  it('reports mismatch when CLI version differs from SDK expectation', () => {
    // The exact failure mode from find-codex-binary.ts:81-86 — CLI 0.125
    // paired with SDK 0.128 silently emits events the SDK can't decode
    // and every dispatch returns empty assistantText.
    const result = checkCodexVersion({
      binary: '/usr/local/bin/codex',
      probe: () => 'codex-cli 0.125.0',
      expectedVersion: '0.128.0',
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('version_mismatch')
    expect(result.actualSemver).toBe('0.125.0')
    expect(result.expectedVersion).toBe('0.128.0')
  })

  it('reports probe failure when --version returns null', () => {
    const result = checkCodexVersion({
      binary: '/usr/local/bin/codex',
      probe: () => null,
      expectedVersion: '0.128.0',
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('version_probe_failed')
    expect(result.actualSemver).toBeNull()
  })

  it('reports unparseable output as probe failure (no semver found)', () => {
    const result = checkCodexVersion({
      binary: '/usr/local/bin/codex',
      probe: () => 'unexpected output',
      expectedVersion: '0.128.0',
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('version_probe_failed')
  })
})
