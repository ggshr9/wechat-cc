import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Trajectory } from './trajectory'
import type { EventResult } from './replay'

export interface ReportInput {
  judgeName: string
  startedAt: Date
  finishedAt: Date
  trajectories: Array<{ trajectory: Trajectory; results: EventResult[] }>
}

export function writeReport(runDir: string, input: ReportInput): void {
  mkdirSync(runDir, { recursive: true })

  for (const t of input.trajectories) {
    const path = join(runDir, `trajectory.${t.trajectory.id}.jsonl`)
    for (const r of t.results) {
      appendFileSync(path, JSON.stringify(r) + '\n')
    }
  }

  const md = renderMarkdown(input)
  writeFileSync(join(runDir, 'report.md'), md)
}

function renderMarkdown(input: ReportInput): string {
  const wallMs = input.finishedAt.getTime() - input.startedAt.getTime()
  const wallStr = `${Math.floor(wallMs / 60_000)}m${Math.floor((wallMs % 60_000) / 1000)}s`
  const errs = input.trajectories.reduce(
    (acc, t) => acc + t.results.filter(r => r.actual?.error !== undefined).length, 0,
  )
  const totalProbes = input.trajectories.reduce(
    (acc, t) => acc + t.results.filter(r => r.event.kind === 'probe').length, 0,
  )

  const lines: string[] = []
  lines.push(`# Companion eval run · ${input.startedAt.toISOString()}`)
  lines.push(`**Judge**: ${input.judgeName}  **Trajectories**: ${input.trajectories.length}  **Wall time**: ${wallStr}  **Errors**: ${errs}`)
  lines.push('')

  for (const t of input.trajectories) {
    const probes = t.results.filter(r => r.event.kind === 'probe')
    lines.push(`## ${t.trajectory.id} (${t.trajectory.failure_mode}) — ${probes.length} probes`)
    lines.push('')
    for (const p of probes) {
      if (p.event.kind !== 'probe') continue
      lines.push(`### Probe ${p.index} · ${p.event.probe_kind} @ ${p.event.at}`)
      lines.push(`- **Expected**: decision=${p.event.expected.decision} · summary="${p.event.expected.summary}"`)
      const actualSummary = p.actual?.error !== undefined
        ? `ERROR: ${p.actual.error}`
        : p.actual?.kind === 'tick_outcome'
          ? `decision=${p.actual.decision}${p.actual.text ? ` · text="${truncate(p.actual.text, 200)}"` : ''}`
          : p.actual?.kind === 'reply'
            ? `text="${truncate(p.actual.text ?? '', 200)}"`
            : 'state-only'
      lines.push(`- **Actual**: ${actualSummary}`)
      if (p.assertions && p.assertions.length > 0) {
        const checks = p.assertions.map(a => `${a.passed ? '✅' : '❌'} ${a.label}${a.detail ? ` (${a.detail})` : ''}`).join(' · ')
        lines.push(`- **Engine assertions**: ${checks}`)
      }
      if (p.judgeScores && p.judgeScores.length > 0) {
        lines.push(`- **Judge** (${input.judgeName}):`)
        for (const s of p.judgeScores) {
          lines.push(`  - ${s.dimension}: ${s.score} — ${s.rationale}`)
        }
      }
      lines.push('')
    }
  }

  lines.push('## Summary')
  lines.push(`- ${input.trajectories.length} trajectories · ${totalProbes} probes · ${errs} errors`)
  const dimAvgs = computeDimensionAverages(input.trajectories)
  if (Object.keys(dimAvgs).length > 0) {
    lines.push(`- Average dimension scores: ${Object.entries(dimAvgs).map(([d, v]) => `${d} ${v.toFixed(1)}`).join(' · ')}`)
  }

  return lines.join('\n') + '\n'
}

function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n) + '…' : s }

function computeDimensionAverages(
  trajs: ReadonlyArray<{ trajectory: Trajectory; results: EventResult[] }>,
): Record<string, number> {
  const sums: Record<string, { sum: number; count: number }> = {}
  for (const t of trajs) for (const r of t.results) for (const s of r.judgeScores ?? []) {
    const slot = sums[s.dimension] ?? (sums[s.dimension] = { sum: 0, count: 0 })
    slot.sum += s.score; slot.count += 1
  }
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(sums)) out[k] = v.sum / v.count
  return out
}
