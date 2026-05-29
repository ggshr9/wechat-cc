import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTrajectory, resolveEventChat } from './trajectory'

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

const MULTI_CONTACT_YAML = `
trajectory:
  id: multi_v1
  failure_mode: cross_chat_isolation
  description: two contacts
  contacts:
    - chat_id: chat_a
      user_name: 顾时瑞
      persona: companion
      profile_md: "# a"
      preferences_md: "# a-prefs"
      initial_observations: []
      initial_memory_files: {}
    - chat_id: chat_b
      user_name: 旺仔
      persona: companion
      profile_md: "# b"
      preferences_md: "# b-prefs"
      initial_observations: []
      initial_memory_files: {}
  companion_config:
    enabled: true
    default_chat_id: chat_a
    quiet_hours_local: null
  events:
    - at: 2026-05-13T09:30:00+08:00
      kind: user_message
      chat: chat_b
      text: hi from b
    - at: 2026-05-13T09:30:30+08:00
      kind: probe
      chat: chat_b
      probe_kind: reactive_response
      expected:
        decision: send
        summary: x
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

describe('multi-contact', () => {
  function load(yaml: string) {
    const dir = mkdtempSync(join(tmpdir(), 'traj-test-'))
    const path = join(dir, 't.yaml')
    writeFileSync(path, yaml)
    try { return loadTrajectory(path) } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  it('normalizes singular contact to a one-element contacts list', () => {
    const t = load(MINIMAL_YAML)
    expect(t.contacts).toHaveLength(1)
    expect(t.contacts[0]!.chat_id).toBe('chat_test_1')
    expect(t.primaryChatId).toBe('chat_test_1')
  })

  it('parses an explicit contacts list and sets primaryChatId to the first', () => {
    const t = load(MULTI_CONTACT_YAML)
    expect(t.contacts.map(c => c.chat_id)).toEqual(['chat_a', 'chat_b'])
    expect(t.primaryChatId).toBe('chat_a')
  })

  it('rejects a trajectory with neither contact nor contacts', () => {
    const yaml = MINIMAL_YAML.replace(/  contact:[\s\S]*?initial_memory_files: \{\}\n/, '')
    expect(() => load(yaml)).toThrow(/exactly one of/)
  })

  it('rejects a trajectory with both contact and contacts', () => {
    const both = MULTI_CONTACT_YAML.replace(
      '  contacts:',
      '  contact:\n    chat_id: dup\n    user_name: d\n    persona: companion\n    profile_md: "#"\n    preferences_md: "#"\n    initial_observations: []\n    initial_memory_files: {}\n  contacts:',
    )
    expect(() => load(both)).toThrow(/exactly one of/)
  })

  it('rejects an event referencing an unknown chat', () => {
    const bad = MULTI_CONTACT_YAML.replace('chat: chat_b\n      text: hi from b', 'chat: chat_zzz\n      text: hi from b')
    expect(() => load(bad)).toThrow(/unknown chat/)
  })

  it('resolveEventChat falls back to primary when chat omitted', () => {
    const t = load(MINIMAL_YAML)
    expect(resolveEventChat(t.events[0]!, t.primaryChatId)).toBe('chat_test_1')
  })

  it('resolveEventChat returns the event chat when present', () => {
    const t = load(MULTI_CONTACT_YAML)
    expect(resolveEventChat(t.events[0]!, t.primaryChatId)).toBe('chat_b')
  })
})
