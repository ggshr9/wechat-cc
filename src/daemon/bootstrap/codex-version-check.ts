/**
 * codex-version-check — boot-time guard against the silent
 * "no reply" trap documented in src/lib/find-codex-binary.ts:81-86.
 *
 * The codex SDK ↔ codex CLI wire protocol is version-locked: a
 * globally-installed CLI at version X paired with our bundled SDK at
 * version Y where X != Y emits events the SDK can't decode, so every
 * dispatch returns empty `assistantText`. The coordinator then takes
 * the FALLBACK_REPLY path with nothing to send and the user gets no
 * reply, no error, no signal anything is wrong.
 *
 * This helper compares the CLI's `--version` output against the SDK's
 * expected version and surfaces a structured pass/fail so the bootstrap
 * can refuse to register the codex provider entirely on mismatch (better
 * a loud "codex disabled" at boot than a silent dead chat).
 */

export interface CheckCodexVersionInput {
  binary: string
  /** Sync probe of `<binary> --version`. Returns the first non-empty
   *  stdout line, or null on timeout/error. */
  probe: (path: string) => string | null
  /** SDK-expected CLI semver — read from `@openai/codex/package.json`
   *  at bootstrap time, so a bump of the SDK dep automatically updates
   *  this and the check stays in sync. */
  expectedVersion: string
}

export interface CheckCodexVersionResult {
  ok: boolean
  binary: string
  expectedVersion: string
  /** Raw probe output (e.g. "codex-cli 0.128.0") — preserved for logs. */
  rawVersion: string | null
  /** Extracted semver (e.g. "0.128.0"). null when no semver pattern in
   *  the raw output. */
  actualSemver: string | null
  reason?: 'version_mismatch' | 'version_probe_failed'
}

const SEMVER_RE = /(\d+\.\d+\.\d+)/

export function checkCodexVersion(input: CheckCodexVersionInput): CheckCodexVersionResult {
  const raw = input.probe(input.binary)
  if (!raw) {
    return {
      ok: false,
      binary: input.binary,
      expectedVersion: input.expectedVersion,
      rawVersion: null,
      actualSemver: null,
      reason: 'version_probe_failed',
    }
  }
  const m = SEMVER_RE.exec(raw)
  const actualSemver = m?.[1] ?? null
  if (!actualSemver) {
    return {
      ok: false,
      binary: input.binary,
      expectedVersion: input.expectedVersion,
      rawVersion: raw,
      actualSemver: null,
      reason: 'version_probe_failed',
    }
  }
  if (actualSemver !== input.expectedVersion) {
    return {
      ok: false,
      binary: input.binary,
      expectedVersion: input.expectedVersion,
      rawVersion: raw,
      actualSemver,
      reason: 'version_mismatch',
    }
  }
  return {
    ok: true,
    binary: input.binary,
    expectedVersion: input.expectedVersion,
    rawVersion: raw,
    actualSemver,
  }
}
