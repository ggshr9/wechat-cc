/**
 * Effective "dormant" interval for the companion scheduler. 1 billion ms
 * ≈ 11.5 days. The scheduler applies ±30% jitter so the actual setTimeout
 * delay is up to intervalMs * 1.3 — we must stay under int32 max
 * (~2.15B ms) or Node clamps the timer to ~1ms and the scheduler fires
 * immediately. Using 2**31-1 directly would overflow; 1B gives margin.
 * Eval runs in minutes, so 11.5 days is effectively infinite.
 */
export const SAFE_INFINITY_MS = 1_000_000_000

export function parseIso(s: string): Date {
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) {
    throw new Error(`parseIso: cannot parse "${s}" as ISO 8601`)
  }
  return d
}

export function toIsoUtc(d: Date): string {
  return d.toISOString()
}
