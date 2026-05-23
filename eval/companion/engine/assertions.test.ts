import { describe, it, expect } from 'vitest'
import { runAssertions } from './assertions'
import type { TrajectoryExpected } from './trajectory'
import type { StateSnapshot } from './snapshot'

const baseExpected: TrajectoryExpected = {
  decision: 'send',
  summary: '',
  must_recall: [],
  must_not_recall: [],
  tone_hints: [],
  state_predicates: [],
}
const baseSnap: StateSnapshot = {
  observations: { active: [], archived: [] },
  memory: { files: {} },
  outbox: [],
}

describe('runAssertions', () => {
  it('decision: send matches outbox-non-empty', () => {
    const out = runAssertions({
      expected: { ...baseExpected, decision: 'send' },
      actual: { kind: 'reply', text: '昨天 504 那波睡好没' },
      snapshot: baseSnap,
    })
    expect(out.find(r => r.label === 'decision')!.passed).toBe(true)
  })

  it('must_recall: case-insensitive substring', () => {
    const out = runAssertions({
      expected: { ...baseExpected, must_recall: ['504', 'MIGRATION'] },
      actual: { kind: 'reply', text: '昨天 504 那波 migration 之后稳吗' },
      snapshot: baseSnap,
    })
    expect(out.find(r => r.label === 'must_recall:504')!.passed).toBe(true)
    expect(out.find(r => r.label === 'must_recall:MIGRATION')!.passed).toBe(true)
  })

  it('must_not_recall: presence fails', () => {
    const out = runAssertions({
      expected: { ...baseExpected, must_not_recall: ['抑郁'] },
      actual: { kind: 'reply', text: '看起来你最近有点抑郁' },
      snapshot: baseSnap,
    })
    expect(out.find(r => r.label === 'must_not_recall:抑郁')!.passed).toBe(false)
  })

  it('state_predicate observation_body_matches', () => {
    const snap: StateSnapshot = {
      ...baseSnap,
      observations: {
        active: [{ id: 'a', ts: '2026-05-13T00:00:00Z', body: 'user hit 504 again', archived: false }],
        archived: [],
      },
    }
    const out = runAssertions({
      expected: { ...baseExpected, state_predicates: [{ kind: 'observation_body_matches', pattern: '504' }] },
      actual: { kind: 'state' },
      snapshot: snap,
    })
    expect(out.find(r => r.label.startsWith('state:observation_body_matches'))!.passed).toBe(true)
  })

  it('state_predicate memory_file_exists', () => {
    const snap: StateSnapshot = {
      ...baseSnap,
      memory: { files: { 'notes/migration.md': '...' } },
    }
    const out = runAssertions({
      expected: { ...baseExpected, state_predicates: [{ kind: 'memory_file_exists', path: 'notes/migration.md' }] },
      actual: { kind: 'state' },
      snapshot: snap,
    })
    expect(out.find(r => r.label.startsWith('state:memory_file_exists'))!.passed).toBe(true)
  })

  it('state_predicate outbox_count_at_chat eq', () => {
    const out = runAssertions({
      expected: { ...baseExpected, state_predicates: [{ kind: 'outbox_count_at_chat', eq: 0 }] },
      actual: { kind: 'state' },
      snapshot: baseSnap,
    })
    expect(out.find(r => r.label.startsWith('state:outbox_count_at_chat'))!.passed).toBe(true)
  })
})
