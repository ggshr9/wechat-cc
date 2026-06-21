/**
 * `new Date(ms).toISOString()` throws `RangeError: Invalid time value` when ms
 * is outside Date's representable range (±8.64e15 ms). For timestamps that come
 * from untrusted input — e.g. an ilink poll payload's `create_time_ms` — that
 * throw can crash the caller (mw-messages records EVERY inbound; a malformed
 * timestamp there silently drops the user's message).
 *
 * isoFromMs guards the conversion: it falls back to `fallbackMs` (then to now)
 * on an invalid / out-of-range value, so a bad timestamp can never throw.
 */
export function isoFromMs(ms: number, fallbackMs: number): string {
  const d = new Date(ms)
  if (Number.isFinite(d.getTime())) return d.toISOString()
  const f = new Date(fallbackMs)
  return (Number.isFinite(f.getTime()) ? f : new Date()).toISOString()
}
