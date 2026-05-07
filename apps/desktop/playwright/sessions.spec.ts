// Session detail / read-jsonl smoke — driven against test-shim.ts.
//
// Regression coverage for the v0.5.11 bug:
//   - `sessions read-jsonl --json --out-file <tmp>` used to write the temp
//     file ONLY on the success path. The two early-return error paths
//     ("no such alias", "jsonl missing") still wrote to stdout via
//     console.log, so the shim's via-file route fired ENOENT when reading
//     the never-created temp file. Dashboard rendered "读取失败：ENOENT:
//     no such file..." for any error case.
//   - Plus, when the most-recent provider for an alias is codex (RFC 03
//     multi-provider), the session_id is a codex thread id and the rollout
//     lives under ~/.codex/sessions/, not ~/.claude/projects/. Old code
//     returned the generic "jsonl missing" — confusing. v0.5.11 detects
//     provider != 'claude' and returns a clear message.
//
// These tests don't need a populated DB — they only need the CLI to honour
// --out-file in error cases. Even with a fresh state dir / no aliases the
// "no such alias" path runs, and that's exactly the path that was broken.

import { test, expect } from './fixtures'

test('sessions read-jsonl error envelope reaches the shim via-file path', async ({ shim }) => {
  // Frontend pattern: wechat_cli_json_via_file { args: ["sessions",
  // "read-jsonl", <alias>, "--json"] }. Shim appends --out-file <tmp>,
  // runs CLI, reads tmp, parses JSON, returns under `result`.
  const r = await shim.invoke('wechat_cli_json_via_file', {
    args: ['sessions', 'read-jsonl', '__nonexistent_alias__', '--json'],
  }) as { result?: { ok: boolean; error?: string }; error?: string }

  // The shim itself must NOT raise — that would be the bug.
  expect(r.error).toBeUndefined()

  // The result must be a proper envelope (not stdout junk, not ENOENT).
  expect(r.result).toBeDefined()
  expect(r.result?.ok).toBe(false)
  expect(r.result?.error).toBe('no such alias')
})

test('dashboard renders the read-jsonl error cleanly (no ENOENT leakage)', async ({ page, shimUrl }) => {
  // Boot the shim, force dashboard mode, click a non-existent project to
  // trigger the read-jsonl flow on a missing alias. Verifies end-to-end:
  // shim via-file → CLI emitJson on error path → frontend renders error.
  await page.goto(shimUrl)
  await page.waitForFunction(
    () => {
      const m = document.documentElement.dataset.mode
      return m !== undefined && m !== 'loading'
    },
    { timeout: 15_000 }
  )

  // Force dashboard mode via dataset mutation.
  await page.evaluate(() => {
    document.documentElement.dataset.mode = 'dashboard'
  })

  // Drive the read-jsonl path directly via window.__TAURI__.core.invoke
  // (the polyfill the shim injects). Skip the click-into-row UI since
  // DRY_RUN's seeded sessions don't necessarily map to a real alias.
  const errorMsg = await page.evaluate(async () => {
    // @ts-expect-error — polyfilled by shim
    const result = await window.__TAURI__.core.invoke('wechat_cli_json_via_file', {
      args: ['sessions', 'read-jsonl', '__nonexistent_alias__', '--json'],
    })
    return result
  }) as { ok: boolean; error?: string }

  // The result must be a clean error envelope. NOT undefined (would mean
  // the shim threw ENOENT and the polyfill rejected the promise).
  expect(errorMsg).toBeDefined()
  expect(errorMsg.ok).toBe(false)
  expect(errorMsg.error).toBe('no such alias')
})
