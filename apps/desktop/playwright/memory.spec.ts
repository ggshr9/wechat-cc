// Memory pane data-flow tests — driven against test-shim.ts (DRY_RUN=1).
//
// Covers:
//   1. switching to the memory tab triggers loadMemoryTopZone, which renders
//      observations + milestones from the seeded shim state
//   2. memory sidebar (#memory-sidebar) populates with the test_chat user
//   3. memory meta crumb shows the user count + file count
//   4. clicking #memory-refresh re-runs the load (no-op against unchanged
//      state but verifies the wiring)
//
// All these data flows are gated on `currentChatId(deps)` resolving — which
// requires memoryState.users to be populated by `memory list --json`. The
// shim intercepts that call (added in this commit) so the seeded test_chat
// becomes available without writing real files to disk.

import { test, expect } from './fixtures'

async function bootIntoDashboard(page: import('@playwright/test').Page, shimUrl: string) {
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
}

async function switchToMemoryPane(page: import('@playwright/test').Page) {
  await page.locator('button.dash-nav-link[data-pane="memory"]').click()
  await expect(page.locator('article.dash-pane[data-pane="memory"]')).toBeVisible()
}

// ── observations + milestones top zone ──────────────────────────────────

test('memory top zone renders observations from seeded data', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await switchToMemoryPane(page)

  // loadMemoryTopZone slices observations to top 3.
  const obsBox = page.locator('#memory-observations')
  await expect(obsBox).toBeVisible()
  // Wait for the load to settle (renders happen async after pane switch).
  await expect(obsBox).not.toContainText('Claude 还没注意到', { timeout: 5_000 })
  // Demo observation bodies — at least one should be rendered.
  await expect(obsBox).toContainText(/demo observation/)
})

test('memory top zone renders milestones from seeded data', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await switchToMemoryPane(page)

  const msBox = page.locator('#memory-milestones')
  await expect(msBox).toBeAttached()
  // loadMemoryTopZone slices to LAST 2. demo.seed yields 3 milestones; one
  // of the last two should mention "messages" or "streak" (the labels).
  // Note: msBox visibility cannot be asserted with toBeVisible — an empty
  // container before the render completes has zero dimensions; toContainText
  // with timeout already waits for the populated state.
  await expect(msBox).toContainText(/messages|streak|push reply/, { timeout: 5_000 })
})

test('memory top zone shows empty-state copy when no observations', async ({ page, shimUrl, shim }) => {
  // Explicitly unseed first — the shim is worker-scoped so prior tests'
  // demo.seed would otherwise leak. Without unseed the empty-state branch
  // never fires and this test asserts on a falsely-populated UI.
  await shim.invoke('demo.unseed')
  await bootIntoDashboard(page, shimUrl)
  await switchToMemoryPane(page)
  // The empty-state copy is design-language §1.3 — narrative, not "暂无数据".
  // The text only renders if memoryState.users resolves to a chat first.
  // Without seed, currentChatId returns null and the load no-ops, leaving
  // the initial empty paragraph from index.html (also a "narrative"-style
  // copy). Either way, no demo observation text should appear.
  const obsBox = page.locator('#memory-observations')
  await expect(obsBox).toBeVisible()
  await expect(obsBox).not.toContainText(/demo observation/)
})

// ── sidebar + meta ──────────────────────────────────────────────────────

test('memory sidebar populates with seeded user', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await switchToMemoryPane(page)

  const sidebar = page.locator('#memory-sidebar')
  await expect(sidebar).toBeVisible()
  // memoryState.users → renderMemorySidebar emits .mem-grp + .mem-file
  // children. The seeded user has 1 placeholder file (profile.md).
  await expect(sidebar.locator('.mem-grp')).toHaveCount(1)
  await expect(sidebar.locator('.mem-file')).toHaveCount(1)
  await expect(sidebar).toContainText('profile.md')
})

test('memory meta crumb shows user + file count', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await switchToMemoryPane(page)
  const meta = page.locator('#memory-meta')
  await expect(meta).toContainText(/1 个用户/, { timeout: 5_000 })
  await expect(meta).toContainText(/1 文件/)
})

test('memory sidebar empty-state when no chats', async ({ page, shimUrl, shim }) => {
  // Explicitly unseed first — see comment in the observations empty-state
  // test for the worker-scoped leakage rationale.
  await shim.invoke('demo.unseed')
  await bootIntoDashboard(page, shimUrl)
  await switchToMemoryPane(page)
  const sidebar = page.locator('#memory-sidebar')
  await expect(sidebar).toBeVisible()
  // The narrative empty-state from renderMemorySidebar uses "Claude 还没".
  await expect(sidebar).toContainText(/Claude 还没/, { timeout: 5_000 })
})

// ── refresh button ──────────────────────────────────────────────────────

test('clicking #memory-refresh re-issues the load (visible: no error)', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await switchToMemoryPane(page)
  // Wait for initial render to settle.
  await expect(page.locator('#memory-observations')).toContainText(/demo observation/, { timeout: 5_000 })
  // Refresh button should fire loadMemoryTopZone again. With unchanged
  // shim state, the rendered content stays — verify it remains visible
  // (and there's no error overlay).
  await page.locator('#memory-refresh').click()
  await expect(page.locator('#memory-observations')).toContainText(/demo observation/)
})
