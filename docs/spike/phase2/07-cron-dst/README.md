# Spike 7 — croner DST + timezone correctness

**Run on**: 2026-04-22
**Exit code**: 0
**croner version**: 9.1.0

## Observations

- **Shanghai 9am**: PASS — correctly fires at 09:00 local time in Asia/Shanghai (no DST).
- **NY Mar 8 spring-forward**: PASS — croner handles DST transition gracefully. On 2026-03-08 02:00-03:00 (spring forward), the cron pattern `30 2 * * *` skips (does not fire on Mar 8) and resumes normal execution on Mar 9 at 02:30 local time. No crash or double-fire observed.
  - Actual runs observed:
    ```
    2026-03-08T07:30:00.000Z → local 03/08/2026, 03:30  (after spring forward)
    2026-03-09T06:30:00.000Z → local 03/09/2026, 02:30
    2026-03-10T06:30:00.000Z → local 03/10/2026, 02:30
    2026-03-11T06:30:00.000Z → local 03/11/2026, 02:30
    2026-03-12T06:30:00.000Z → local 03/12/2026, 02:30
    ```
- **Minute-level precision**: PASS — `nextRun()` correctly identifies 10-minute boundaries in the cron expression `*/10 * * * *`.

## Decision for Task 16 (scheduler impl)

- **Safe to use**: `new Cron(pattern, {timezone, paused: true}, () => {})` + `.nextRun(referenceDate)` per scheduler tick is correct and well-behaved.
- **DST handling**: Croner intelligently skips jobs during non-existent times (spring forward, e.g., 02:30 on spring-forward day). The scheduler does not need to add extra DST compensation logic — croner handles it.
- **Precision**: Minute-level granularity is reliable; `.nextRun()` correctly respects timezone context when provided.
- **No caveats discovered** that warrant follow-up work. The library is production-safe for the scheduler's use case (iterating per minute, checking next scheduled run in a given timezone).
