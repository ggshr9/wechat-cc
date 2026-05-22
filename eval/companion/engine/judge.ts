import type { JudgeScore, ProbeActual } from './replay'
import type { TrajectoryExpected } from './trajectory'

export type JudgeDimension = JudgeScore['dimension']

export interface JudgeProbeInput {
  trajectoryHistoryToProbe: string
  expected: TrajectoryExpected
  actual: ProbeActual
  dimensions: ReadonlyArray<JudgeDimension>
}

export interface Judge {
  name: string
  score(input: JudgeProbeInput): Promise<JudgeScore[]>
}

export function makeCodexSdkJudge(_opts: { model?: string } = {}): Judge {
  return {
    name: 'codex-sdk:not-implemented',
    score: () => { throw new Error('codex-sdk judge: not implemented (MVP ships claude-sdk only)') },
  }
}

export function makeAnthropicApiJudge(_opts: { apiKey: string; model?: string }): Judge {
  return {
    name: 'anthropic-api:not-implemented',
    score: () => { throw new Error('anthropic-api judge: not implemented (MVP ships claude-sdk only)') },
  }
}

// makeClaudeSdkJudge is defined in judge-claude-sdk.ts to keep this file
// SDK-import-free for callers that only need the interface (e.g. reporters).
