// sessions-pane.spec.ts — Playwright tests for the 対話 (dialogue) pane.
//
// Task 11: This file was rewritten from the Task-9/10 static-mockup version.
// The old spec tested hardcoded HTML content from a designer mockup (specific
// text like "介绍一下 AI FDE 这个岗位" embedded in static HTML, specific
// knowledge-topic counts, a `[data-lock="stories"]` button for re-locking).
// Task 10 replaced that mockup with a real-data dynamic page (dialogue-page.js)
// that loads everything via `dialogue timeline` / `dialogue threads` / etc.
//
// The new specs test the same user-visible behaviors against the dynamic DOM:
//   - Chat list renders in the sidebar (from list-chats mock)
//   - Timeline shows messages seeded via demo.seed (from dialogue timeline mock)
//   - View switcher buttons exist and are wired (task/knowledge/life)
//   - Privacy lock: locked state shows lock affordance; successful unlock
//     (mock passphrase "1234") re-queries and shows private threads
//
// What was deleted (no longer exists in the real page):
//   - `[data-lock="stories"]` per-group re-lock button — the new page has no
//     per-group manual-lock UI (only a full session unlock/re-lock is not
//     implemented in v0.6). The "private groups can be manually locked again"
//     test is removed.
//   - Hardcoded tag counts / specific tag text (brittle, mock-dependent)

import { test, expect } from './fixtures'

async function bootAndOpenDialogue(page: import('@playwright/test').Page, shimUrl: string, shim: { invoke(cmd: string, args?: unknown): Promise<unknown> }) {
  await shim.invoke('demo.seed', { chat_id: 'dialogue_preview', daemonAlive: true })
  await page.goto(shimUrl)
  // Wait until the page has left loading mode (could land in wizard OR dashboard
  // depending on shim state — we force dashboard after the mode resolves).
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

test('dialogue pane mounts inside the sessions nav slot and sidebar is visible', async ({ page, shimUrl, shim }) => {
  await bootAndOpenDialogue(page, shimUrl, shim)
  await expect(page.locator('button.dash-nav-link[data-pane="sessions"]')).toHaveClass(/active/)
  await expect(page.locator('.dialogue-sidebar')).toBeVisible()
  await expect(page.locator('.dialogue-document')).toBeVisible()
})

test('view switcher buttons are rendered for timeline/task/knowledge/life', async ({ page, shimUrl, shim }) => {
  await bootAndOpenDialogue(page, shimUrl, shim)
  const views = page.locator('#dialogue-views')
  await expect(views).toBeVisible()
  await expect(views.locator('[data-view="timeline"]')).toBeVisible()
  await expect(views.locator('[data-view="task"]')).toBeVisible()
  await expect(views.locator('[data-view="knowledge"]')).toBeVisible()
  await expect(views.locator('[data-view="life"]')).toBeVisible()
})

test('timeline loads seeded messages from dialogue timeline mock', async ({ page, shimUrl, shim }) => {
  await bootAndOpenDialogue(page, shimUrl, shim)
  // dialogue-page.js loads timeline on init; wait for the seeded messages.
  const timeline = page.locator('#dialogue-timeline')
  await expect(timeline).toBeVisible()
  // The shim seeds a message "介绍一下 AI FDE 这个岗位" as the first user turn.
  await expect(timeline).toContainText('介绍一下 AI FDE 这个岗位', { timeout: 10_000 })
  // And an AI reply.
  await expect(timeline).toContainText('AI FDE', { timeout: 5_000 })
})

test('search input is in the sidebar and typing triggers search via the dialogue search mock', async ({ page, shimUrl, shim }) => {
  await bootAndOpenDialogue(page, shimUrl, shim)
  const searchInput = page.locator('#dialogue-search')
  await expect(searchInput).toBeVisible()
  // Type a query that matches a seeded message.
  await searchInput.fill('FDE')
  // Wait for search debounce (250ms) + render.
  await expect(page.locator('#dialogue-timeline')).toContainText('介绍一下', { timeout: 5_000 })
})

test('switching to knowledge view shows thread cards from dialogue threads mock', async ({ page, shimUrl, shim }) => {
  await bootAndOpenDialogue(page, shimUrl, shim)
  await page.locator('#dialogue-views [data-view="knowledge"]').click()
  const groups = page.locator('#dialogue-groups')
  await expect(groups).toBeVisible({ timeout: 5_000 })
  // The shim seeds 3 knowledge threads (thread_career, thread_design, thread_figma).
  await expect(groups.locator('.dialogue-topic')).toHaveCount(3, { timeout: 5_000 })
  // The career thread has knowledge tags.
  await expect(groups).toContainText('figma插件skill')
})

test('privacy lock row shown in life view (unlocked=false); entering correct passphrase reveals private threads', async ({ page, shimUrl, shim }) => {
  await bootAndOpenDialogue(page, shimUrl, shim)
  await page.locator('#dialogue-views [data-view="life"]').click()
  // Before unlock: only non-private threads shown + lock affordance.
  const groups = page.locator('#dialogue-groups')
  await expect(groups).toBeVisible({ timeout: 5_000 })
  await expect(groups.locator('.dialogue-locked-row')).toBeVisible({ timeout: 5_000 })
  // Private thread titles must NOT appear yet.
  await expect(groups).not.toContainText('和花艺师闺蜜的周末')

  // Click the lock row to open the privacy dialog.
  await page.locator('.dialogue-locked-row').click()
  await expect(page.locator('#privacy-dialog')).toBeVisible()

  // Enter the correct passphrase (shim default is "1234").
  await page.locator('#privacy-password').fill('1234')
  await page.locator('.privacy-submit').click()

  // Dialog should close and private threads should now appear.
  await expect(page.locator('#privacy-dialog')).toBeHidden({ timeout: 5_000 })
  await expect(groups).toContainText('和花艺师闺蜜的周末', { timeout: 5_000 })
  await expect(groups).toContainText('糟糕的心情', { timeout: 5_000 })
})

test('wrong passphrase shows inline error without closing the dialog', async ({ page, shimUrl, shim }) => {
  await bootAndOpenDialogue(page, shimUrl, shim)
  await page.locator('#dialogue-views [data-view="life"]').click()
  await expect(page.locator('#dialogue-groups .dialogue-locked-row')).toBeVisible({ timeout: 5_000 })
  await page.locator('.dialogue-locked-row').click()
  await expect(page.locator('#privacy-dialog')).toBeVisible()
  await page.locator('#privacy-password').fill('wrong')
  await page.locator('.privacy-submit').click()
  // Dialog stays open and error message appears.
  await expect(page.locator('#privacy-dialog')).toBeVisible()
  await expect(page.locator('#privacy-dialog .privacy-error')).toBeVisible({ timeout: 3_000 })
})
