/**
 * Per-dimension rubric. Each entry describes what 1-5 means for that
 * dimension. The judge prompt asks the judge model to return one
 * { dimension, score, rationale } object per requested dimension.
 *
 * Source: docs/spike/2026-05-09-companion-eval-harness.md §LLM-as-Judge.
 * If that file moves or is rewritten, update the comment + verify the
 * rubric text still matches.
 */
export const RUBRIC: Record<'recall' | 'inference' | 'calibration' | 'initiative' | 'restraint', string> = {
  recall: '5 = surfaces the right prior fact at the right moment; 1 = ignores or contradicts established memory.',
  inference: '5 = sound, charitable interpretation of user state; 1 = jumps to wrong conclusion or projects feelings.',
  calibration: '5 = tone and length match the user\'s current bandwidth; 1 = tone mismatched (cheerful while user is stressed, etc).',
  initiative: '5 = proactive at exactly the right moment; 1 = pings when user wants silence, or stays silent when a check-in is wanted.',
  restraint: '5 = says only what\'s needed, no over-explaining or moralizing; 1 = lectures, adds disclaimers, prescribes solutions unprompted.',
}

export function buildJudgePrompt(opts: {
  trajectoryHistoryToProbe: string
  expectedSummary: string
  expectedMustRecall: string[]
  expectedToneHints: string[]
  actualText: string | undefined
  actualDecision: 'send' | 'silent' | undefined
  dimensions: ReadonlyArray<keyof typeof RUBRIC>
}): string {
  const rubricLines = opts.dimensions.map(d => `- ${d}: ${RUBRIC[d]}`).join('\n')
  return `You are evaluating an AI companion's response in a multi-turn conversation. Score ONLY these dimensions: ${opts.dimensions.join(', ')}.

# Conversation history (everything up to and including the probe point)
${opts.trajectoryHistoryToProbe}

# What was expected
- Summary: ${opts.expectedSummary}
- Must recall: ${opts.expectedMustRecall.join(', ') || '(none)'}
- Tone hints: ${opts.expectedToneHints.join(', ') || '(none)'}

# What actually happened
- Decision: ${opts.actualDecision ?? 'n/a'}
- Reply text: ${opts.actualText ?? '(silent / no reply)'}

# Rubric
${rubricLines}

# Output format
Return a JSON array, one object per dimension you scored. No prose outside the array.
[
  {"dimension": "recall", "score": 4, "rationale": "..."},
  ...
]`
}
