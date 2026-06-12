// dialogue-timeline.spec.ts — New specs for the 対話 pane's timeline features.
//
// Task 11: Two new spec groups:
//   1. Upward paging: seed >100 mock messages via `dialogue.seed-messages`,
//      open the timeline, scroll to top, assert that older messages appear
//      without duplicates and scroll position is preserved.
//   2. Privacy lock: locked state shows lock affordance in facet view;
//      successful unlock (mock passphrase "1234") re-queries and shows private
//      threads; the `no_lock_configured` path hides the affordance entirely.

import { test, expect } from './fixtures'

// ── helpers ──────────────────────────────────────────────────────────────────

async function bootAndOpenDialogue(page: import('@playwright/test').Page, shimUrl: string, shim: { invoke(cmd: string, args?: unknown): Promise<unknown> }) {
  await shim.invoke('demo.seed', { chat_id: 'timeline_test', daemonAlive: true })
  await page.goto(shimUrl)
  await page.waitForFunction(
    () => {
      const m = document.documentElement.dataset.mode
      return m !== undefined && m !== 'loading'
    },
    { timeout: 15_000 }
  )
  await page.evaluate(() => {
    document.documentElement.dataset.mode = 'dashboard'
  })
  await expect(page.locator('main.dashboard')).toBeVisible({ timeout: 5_000 })
  await page.locator('button.dash-nav-link[data-pane="sessions"]').click()
  await expect(page.locator('#dialogue-root')).toBeVisible()
}

// ── 1. Timeline upward paging ─────────────────────────────────────────────────
//
// The shim intercepts `dialogue timeline` and returns `hasMore: true` when
// there are more than `limit` messages before the `--before` cursor. We seed
// >100 messages via a `dialogue.seed-messages` test-control command (handled
// below in the shim extension below). Then we:
//   a) open the timeline (gets the newest PAGE = 100 messages)
//   b) record the oldest visible message text
//   c) scroll the timeline to the top (scrollTop = 0)
//   d) wait for the older page to prepend (the 101st..200th messages appear)
//   e) assert the previously-oldest message is still in the DOM (no dupes)
//   f) assert one of the newly-prepended messages is now visible
//
// Because the shim mock returns hasMore based on the seeded messages array
// we don't need a real daemon — the mock handles the slice correctly.

test('upward paging: scroll-to-top prepends older messages and preserves position', async ({ page, shimUrl, shim }) => {
  // demo.seed first (sets up accounts + baseline dialogue messages), then
  // immediately override the dialogue messages with 150 so the first load
  // hits the 100-message page limit and hasMore=true. The override must
  // happen BEFORE page.goto so the timeline fetch gets the large dataset.
  await shim.invoke('demo.seed', { chat_id: 'timeline_test', daemonAlive: true })
  await shim.invoke('dialogue.seed-messages', { count: 150, chat_id: 'timeline_test' })
  await page.goto(shimUrl)
  await page.waitForFunction(
    () => {
      const m = document.documentElement.dataset.mode
      return m !== undefined && m !== 'loading'
    },
    { timeout: 15_000 }
  )
  await page.evaluate(() => { document.documentElement.dataset.mode = 'dashboard' })
  await page.locator('main.dashboard').waitFor({ state: 'visible', timeout: 5_000 })
  await page.locator('button.dash-nav-link[data-pane="sessions"]').click()
  await expect(page.locator('#dialogue-root')).toBeVisible()

  const timeline = page.locator('#dialogue-timeline')
  await expect(timeline).toBeVisible()

  // Wait for the initial load to complete (messages appear).
  await expect(timeline.locator('.dialogue-turn, .dialogue-cmd')).toHaveCount(100, { timeout: 10_000 })

  // Capture the text of the currently oldest (top-most) message on the page.
  // dialogue-page.js puts newest at bottom, so the first element is the oldest.
  const oldestBeforePaging = await timeline.locator('.dialogue-turn, .dialogue-cmd').first().textContent()

  // Scroll to the very top of the timeline container to trigger upward paging.
  await page.evaluate(() => {
    const el = document.getElementById('dialogue-timeline')
    if (el) el.scrollTop = 0
  })

  // Wait for the paging fetch to complete — more than 100 messages now.
  await expect(timeline.locator('.dialogue-turn, .dialogue-cmd')).toHaveCount(150, { timeout: 10_000 })

  // The previously-oldest message must still be present (no duplicates removed).
  if (oldestBeforePaging) {
    const afterCount = await timeline.locator('.dialogue-turn, .dialogue-cmd').evaluateAll(
      (els, txt) => els.filter(el => el.textContent?.includes(txt ?? '')).length,
      oldestBeforePaging.trim()
    )
    // Exactly 1 occurrence — it wasn't removed or duplicated.
    expect(afterCount).toBe(1)
  }

  // The prepended older messages should be in the DOM: message 1 (the very
  // oldest, index 0) should now be visible since we seeded 150 messages and
  // loaded them all.
  const firstMsg = timeline.locator('.dialogue-turn, .dialogue-cmd').first()
  await expect(firstMsg).toBeAttached()

  // Scroll position should NOT be at 0 (the page preserved position after
  // prepend so the user stays at roughly the same spot).
  const scrollTop = await page.evaluate(() => document.getElementById('dialogue-timeline')?.scrollTop ?? 0)
  expect(scrollTop).toBeGreaterThan(0)
})

test('upward paging does not fire when hasMore is false (no further pages)', async ({ page, shimUrl, shim }) => {
  // Only 30 messages — well under the 100-message page limit, so hasMore=false.
  // Same ordering: demo.seed first, then override dialogue messages.
  await shim.invoke('demo.seed', { chat_id: 'timeline_test', daemonAlive: true })
  await shim.invoke('dialogue.seed-messages', { count: 30, chat_id: 'timeline_test' })
  await page.goto(shimUrl)
  await page.waitForFunction(
    () => {
      const m = document.documentElement.dataset.mode
      return m !== undefined && m !== 'loading'
    },
    { timeout: 15_000 }
  )
  await page.evaluate(() => { document.documentElement.dataset.mode = 'dashboard' })
  await page.locator('main.dashboard').waitFor({ state: 'visible', timeout: 5_000 })
  await page.locator('button.dash-nav-link[data-pane="sessions"]').click()
  await expect(page.locator('#dialogue-root')).toBeVisible()

  const timeline = page.locator('#dialogue-timeline')
  await expect(timeline.locator('.dialogue-turn, .dialogue-cmd')).toHaveCount(30, { timeout: 10_000 })

  // Scroll to top — should not trigger a second fetch.
  await page.evaluate(() => {
    const el = document.getElementById('dialogue-timeline')
    if (el) el.scrollTop = 0
  })

  // Count stays at 30 after a small wait.
  await page.waitForTimeout(500)
  await expect(timeline.locator('.dialogue-turn, .dialogue-cmd')).toHaveCount(30)
})

// ── 2. Privacy lock ───────────────────────────────────────────────────────────

test('life facet: locked state shows lock row; unlock with correct passphrase reveals private threads', async ({ page, shimUrl, shim }) => {
  await bootAndOpenDialogue(page, shimUrl, shim)

  // Switch to life view.
  await page.locator('#dialogue-views [data-view="life"]').click()
  const groups = page.locator('#dialogue-groups')
  await expect(groups).toBeVisible({ timeout: 5_000 })

  // Before unlock: private thread titles must not appear.
  await expect(groups).not.toContainText('和花艺师闺蜜的周末')
  await expect(groups).not.toContainText('糟糕的心情')
  // Lock affordance is visible.
  await expect(groups.locator('.dialogue-locked-row')).toBeVisible()

  // Open the privacy dialog.
  await page.locator('.dialogue-locked-row').click()
  await expect(page.locator('#privacy-dialog')).toBeVisible()

  // Submit correct passphrase.
  await page.locator('#privacy-password').fill('1234')
  await page.locator('.privacy-submit').click()

  // Dialog closes; private threads appear.
  await expect(page.locator('#privacy-dialog')).toBeHidden({ timeout: 5_000 })
  await expect(groups).toContainText('和花艺师闺蜜的周末', { timeout: 5_000 })
  await expect(groups).toContainText('糟糕的心情', { timeout: 5_000 })
})

test('re-lock: after unlocking, 重新锁定 re-arms the session lock and hides private threads', async ({ page, shimUrl, shim }) => {
  await bootAndOpenDialogue(page, shimUrl, shim)

  await page.locator('#dialogue-views [data-view="life"]').click()
  const groups = page.locator('#dialogue-groups')
  await expect(groups).toBeVisible({ timeout: 5_000 })

  // Unlock first.
  await page.locator('.dialogue-locked-row').click()
  await expect(page.locator('#privacy-dialog')).toBeVisible()
  await page.locator('#privacy-password').fill('1234')
  await page.locator('.privacy-submit').click()
  await expect(page.locator('#privacy-dialog')).toBeHidden({ timeout: 5_000 })
  await expect(groups).toContainText('糟糕的心情', { timeout: 5_000 })

  // Now the lock row should read 重新锁定. Click it → private threads vanish.
  const relock = groups.locator('.dialogue-locked-row')
  await expect(relock).toContainText('重新锁定')
  await relock.click()
  await expect(groups).not.toContainText('糟糕的心情', { timeout: 5_000 })
  await expect(groups).not.toContainText('和花艺师闺蜜的周末')
  // The affordance reverts to the unlock prompt.
  await expect(groups.locator('.dialogue-locked-row')).toContainText('解锁私密话题')
})

test('refresh button: present in the stage header and reloads the timeline', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'timeline_test', daemonAlive: true })
  await shim.invoke('dialogue.seed-messages', { count: 5, chat_id: 'timeline_test' })
  await bootAndOpenDialogue(page, shimUrl, shim)

  const turns = page.locator('#dialogue-timeline .dialogue-turn, #dialogue-timeline .dialogue-cmd')
  await expect(turns.first()).toBeVisible({ timeout: 10_000 })
  const before = await turns.count()
  expect(before).toBeGreaterThan(0)

  const refreshBtn = page.locator('#dialogue-refresh')
  await expect(refreshBtn).toBeVisible()

  // Grow the dataset, then click refresh — the reloaded timeline picks up
  // the new messages (proves the button re-runs the loader).
  await shim.invoke('dialogue.seed-messages', { count: before + 10, chat_id: 'timeline_test' })
  await refreshBtn.click()
  await expect(turns).toHaveCount(before + 10, { timeout: 10_000 })
})

test('privacy lock: no_lock_configured response hides the lock affordance', async ({ page, shimUrl, shim }) => {
  // Set the passphrase to empty so the shim returns no_lock_configured when
  // the user submits (the shim interprets an empty or mismatched passphrase
  // with the mock `no_lock` flag). We use `dialogue.set-no-lock` test-control.
  // Must run AFTER boot: demo.seed (inside bootAndOpenDialogue) restores the
  // dialogue lock defaults so per-test state can't leak between specs.
  await bootAndOpenDialogue(page, shimUrl, shim)
  await shim.invoke('dialogue.set-no-lock', {})

  await page.locator('#dialogue-views [data-view="life"]').click()
  const groups = page.locator('#dialogue-groups')
  await expect(groups).toBeVisible({ timeout: 5_000 })

  // Open privacy dialog via the lock row (it starts visible since dialogueUnlocked=false).
  await expect(groups.locator('.dialogue-locked-row')).toBeVisible({ timeout: 5_000 })
  await page.locator('.dialogue-locked-row').click()
  await expect(page.locator('#privacy-dialog')).toBeVisible()

  // Submit any passphrase — shim returns no_lock_configured.
  await page.locator('#privacy-password').fill('anything')
  await page.locator('.privacy-submit').click()

  // Dialog closes AND lock affordance disappears (noLockConfigured=true in page).
  await expect(page.locator('#privacy-dialog')).toBeHidden({ timeout: 5_000 })
  await expect(groups.locator('.dialogue-locked-row')).toBeHidden({ timeout: 3_000 })
})
