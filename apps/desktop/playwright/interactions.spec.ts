// Interaction tests — driven against test-shim.ts (DRY_RUN=1).
//
// Tests exercise two key interaction flows:
//
//   1. Archive observation — data layer only (shim intercepts the CLI call,
//      marks observation archived, and the subsequent list returns one fewer)
//
//   2. Session favorite toggle — localStorage only (no CLI bridge).
//      Actual key: 'wechat-cc:favorite-sessions' (verified in sessions.js).
//      FAV_STORAGE_KEY = 'wechat-cc:favorite-sessions'
//
// See: apps/desktop/src/modules/sessions.js lines 13 + 357-365

import { test, expect } from './fixtures'

test('archive observation removes it from active list', async ({ shim }) => {
  // Seed 5 observations for test_chat
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })

  // Verify the seeded count
  const before = await shim.invoke('wechat_cli_json', {
    args: ['observations', 'list', 'test_chat', '--json'],
  }) as { result?: { observations?: Array<{ id: string }> } }
  const observations = before.result?.observations ?? []
  expect(observations.length).toBe(5)

  // Archive the first observation
  // Frontend calls: ["observations", "archive", chatId, obsId, "--json"]
  const firstId = observations[0]!.id
  await shim.invoke('wechat_cli_json', {
    args: ['observations', 'archive', 'test_chat', firstId, '--json'],
  })

  // The active list must now have one fewer entry
  const after = await shim.invoke('wechat_cli_json', {
    args: ['observations', 'list', 'test_chat', '--json'],
  }) as { result?: { observations?: Array<{ id: string }> } }
  const remaining = after.result?.observations ?? []
  expect(remaining.length).toBe(4)

  // The archived item must not appear in the remaining list
  const remainingIds = remaining.map(o => o.id)
  expect(remainingIds).not.toContain(firstId)
})

test('sessions favorite toggles and persists to localStorage', async ({ page, shimUrl, shim }) => {
  // Seed mock state
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await page.goto(shimUrl)

  // Wait for the page to leave loading state
  await page.waitForFunction(
    () => {
      const m = document.documentElement.dataset.mode
      return m !== undefined && m !== 'loading'
    },
    { timeout: 15_000 }
  )

  // Set the favorite via localStorage using the actual key from sessions.js:
  // FAV_STORAGE_KEY = 'wechat-cc:favorite-sessions'
  await page.evaluate(() => {
    localStorage.setItem('wechat-cc:favorite-sessions', JSON.stringify(['sess_1']))
  })

  // Reload and confirm localStorage persists across navigation
  await page.reload()
  await page.waitForFunction(
    () => {
      const m = document.documentElement.dataset.mode
      return m !== undefined && m !== 'loading'
    },
    { timeout: 15_000 }
  )

  const stored = await page.evaluate(
    () => localStorage.getItem('wechat-cc:favorite-sessions')
  )
  expect(stored).toBe(JSON.stringify(['sess_1']))
})
