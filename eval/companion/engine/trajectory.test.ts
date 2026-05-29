import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTrajectory } from './trajectory'

const MINIMAL_YAML = `
trajectory:
  id: smoke_v1
  failure_mode: work_followup
  description: Smoke trajectory
  contact:
    chat_id: chat_test_1
    user_name: testuser
    persona: companion
    profile_md: |
      # profile
    preferences_md: |
      # prefs
    initial_observations: []
    initial_memory_files: {}
  companion_config:
    enabled: true
    default_chat_id: chat_test_1
    quiet_hours_local: null
  events:
    - at: 2026-05-13T09:30:00+08:00
      kind: user_message
      text: hi
    - at: 2026-05-13T09:30:30+08:00
      kind: probe
      probe_kind: reactive_response
      expected:
        decision: send
        summary: should greet back
        must_recall: []
        must_not_recall: []
        tone_hints: []
        state_predicates: []
      dimensions: [restraint]
`

describe('loadTrajectory', () => {
  it('parses a minimal valid trajectory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'traj-test-'))
    const path = join(dir, 'smoke.yaml')
    writeFileSync(path, MINIMAL_YAML)
    try {
      const t = loadTrajectory(path)
      expect(t.id).toBe('smoke_v1')
      expect(t.failure_mode).toBe('work_followup')
      expect(t.events).toHaveLength(2)
      expect(t.events[0]!.kind).toBe('user_message')
      expect(t.events[1]!.kind).toBe('probe')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('rejects an unknown failure_mode', () => {
    const bad = MINIMAL_YAML.replace('work_followup', 'not_a_mode')
    const dir = mkdtempSync(join(tmpdir(), 'traj-test-'))
    const path = join(dir, 'bad.yaml')
    writeFileSync(path, bad)
    try {
      expect(() => loadTrajectory(path)).toThrow(/failure_mode/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('rejects an event missing required fields for its kind', () => {
    const bad = MINIMAL_YAML.replace(/kind: user_message[\s\S]*?text: hi/, 'kind: user_message')
    const dir = mkdtempSync(join(tmpdir(), 'traj-test-'))
    const path = join(dir, 'bad.yaml')
    writeFileSync(path, bad)
    try {
      expect(() => loadTrajectory(path)).toThrow()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('accepts the renamed cross_chat_isolation failure mode', () => {
    const yaml = MINIMAL_YAML.replace('failure_mode: work_followup', 'failure_mode: cross_chat_isolation')
    const dir = mkdtempSync(join(tmpdir(), 'traj-test-'))
    const path = join(dir, 'rename.yaml')
    writeFileSync(path, yaml)
    try {
      const t = loadTrajectory(path)
      expect(t.failure_mode).toBe('cross_chat_isolation')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('rejects the old multi_persona_isolation name', () => {
    const yaml = MINIMAL_YAML.replace('failure_mode: work_followup', 'failure_mode: multi_persona_isolation')
    const dir = mkdtempSync(join(tmpdir(), 'traj-test-'))
    const path = join(dir, 'oldname.yaml')
    writeFileSync(path, yaml)
    try {
      expect(() => loadTrajectory(path)).toThrow(/failure_mode/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('parses state_predicates as a tagged union', () => {
    const withPredicates = MINIMAL_YAML.replace(
      'state_predicates: []',
      `state_predicates:
          - { kind: observation_body_matches, pattern: "504" }
          - { kind: memory_file_exists, path: "notes/migration.md" }`,
    )
    const dir = mkdtempSync(join(tmpdir(), 'traj-test-'))
    const path = join(dir, 'with-preds.yaml')
    writeFileSync(path, withPredicates)
    try {
      const t = loadTrajectory(path)
      const probe = t.events.find(e => e.kind === 'probe')!
      expect(probe.kind).toBe('probe')
      if (probe.kind !== 'probe') throw new Error('narrow')
      expect(probe.expected.state_predicates).toHaveLength(2)
      expect(probe.expected.state_predicates[0]!.kind).toBe('observation_body_matches')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
