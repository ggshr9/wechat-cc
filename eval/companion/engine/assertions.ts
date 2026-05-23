import type { TrajectoryExpected, StatePredicate } from './trajectory'
import type { ProbeActual, AssertionResult } from './replay'
import type { StateSnapshot } from './snapshot'

export interface AssertionInput {
  expected: TrajectoryExpected
  actual: ProbeActual
  snapshot: StateSnapshot
}

export function runAssertions(input: AssertionInput): AssertionResult[] {
  const results: AssertionResult[] = []

  if (input.expected.decision !== 'n/a') {
    const got = decisionFromActual(input.actual)
    results.push({
      label: 'decision',
      passed: got === input.expected.decision,
      detail: `expected=${input.expected.decision} actual=${got}`,
    })
  }

  const text = (input.actual.text ?? '').toLowerCase()
  for (const needle of input.expected.must_recall) {
    results.push({
      label: `must_recall:${needle}`,
      passed: text.includes(needle.toLowerCase()),
    })
  }
  for (const needle of input.expected.must_not_recall) {
    results.push({
      label: `must_not_recall:${needle}`,
      passed: !text.includes(needle.toLowerCase()),
    })
  }

  for (const pred of input.expected.state_predicates) {
    results.push(evalPredicate(pred, input.snapshot))
  }

  return results
}

function decisionFromActual(actual: ProbeActual): 'send' | 'silent' | 'unknown' {
  if (actual.kind === 'tick_outcome' && actual.decision !== undefined) return actual.decision
  if (actual.kind === 'reply') {
    if (actual.error !== undefined) return 'silent'
    return (actual.text ?? '').length > 0 ? 'send' : 'silent'
  }
  return 'unknown'
}

function evalPredicate(pred: StatePredicate, snap: StateSnapshot): AssertionResult {
  switch (pred.kind) {
    case 'observation_body_matches': {
      const needle = pred.pattern.toLowerCase()
      const hit = snap.observations.active.some(o => o.body.toLowerCase().includes(needle))
        || snap.observations.archived.some(o => o.body.toLowerCase().includes(needle))
      return {
        label: `state:observation_body_matches:${pred.pattern}`,
        passed: hit,
      }
    }
    case 'memory_file_exists':
      return {
        label: `state:memory_file_exists:${pred.path}`,
        passed: pred.path in snap.memory.files,
      }
    case 'memory_file_matches': {
      const content = snap.memory.files[pred.path]
      return {
        label: `state:memory_file_matches:${pred.path}:${pred.pattern}`,
        passed: content !== undefined && content.toLowerCase().includes(pred.pattern.toLowerCase()),
      }
    }
    case 'outbox_count_at_chat':
      return {
        label: `state:outbox_count_at_chat:${pred.eq}`,
        passed: snap.outbox.length === pred.eq,
        detail: `actual=${snap.outbox.length}`,
      }
  }
}
