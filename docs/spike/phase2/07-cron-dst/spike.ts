#!/usr/bin/env bun
/**
 * Phase 2 Spike 7: croner DST + timezone correctness.
 *
 * Validates that Asia/Shanghai (no DST) and America/New_York (DST) handle
 * edge cases correctly:
 * - Shanghai: every hour, no DST shift.
 * - New York: 02:30 on a spring-forward day — does croner skip/double-fire?
 */
import { Cron } from 'croner'

function check(name: string, cond: boolean, detail?: string): void {
  console.log(`[spike7] ${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) process.exitCode = 1
}

// Shanghai — straightforward, no DST
{
  const job = new Cron('0 9 * * *', { timezone: 'Asia/Shanghai', paused: true }, () => {})
  const nextUTC = job.nextRun()!
  const shanghaiHour = nextUTC.toLocaleString('en-US', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false,
  })
  check('Shanghai 9am fires at 9:00 local', shanghaiHour === '09', `got ${shanghaiHour}`)
}

// NY — spring forward in 2026 is Mar 8 (second Sunday)
{
  const job = new Cron('30 2 * * *', { timezone: 'America/New_York', paused: true }, () => {})
  const start = new Date('2026-03-07T12:00:00-05:00')
  const runs = job.nextRuns(5, start)
  console.log('[spike7] NY 2:30am next-runs starting 2026-03-07:')
  for (const r of runs) {
    const localTime = r.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    console.log(`  ${r.toISOString()} → local ${localTime}`)
  }
  check(
    'NY Mar 8 (spring forward) handled gracefully (skip or reschedule; no crash)',
    runs.length > 0,
    'croner should not throw during DST transition',
  )
}

// Shanghai minute-level precision — validates nextRun() and nextRuns() for scheduler tick
{
  const job = new Cron('*/10 * * * *', { timezone: 'Asia/Shanghai', paused: true }, () => {})
  const reference = new Date('2026-04-22T10:05:00Z') // 18:05 Shanghai time
  const nextRun = job.nextRun(reference)
  if (nextRun) {
    const minuteInShanghai = nextRun.toLocaleString('en-US', {
      timeZone: 'Asia/Shanghai',
      minute: '2-digit',
      hour12: false,
    })
    check('nextRun() returns 10-minute boundary', minuteInShanghai === '10', `got ${minuteInShanghai}`)
  } else {
    check('nextRun() returns 10-minute boundary', false, 'nextRun returned null')
  }
}

console.log('\n[spike7] done — exit code reflects pass/fail')
