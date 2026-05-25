// Interaction tests — driven against test-shim.ts (DRY_RUN=1).
//
// Coverage:
//   1. archive observation        — data layer (shim ↔ CLI ↔ mock state)
//   2. session favorite toggle    — localStorage persistence
//   3. settings drawer            — open / close (button / ESC / backdrop)
//                                   + toggle aria-pressed flip
//                                   + duplicate-ID regression (drawer
//                                     toggle is independent of wizard
//                                     step-4 toggle with the same name)

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

// ── Existing coverage (preserved) ─────────────────────────────────────

test('archive observation removes it from active list', async ({ shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  const before = await shim.invoke('wechat_cli_json', {
    args: ['observations', 'list', 'test_chat', '--json'],
  }) as { result?: { observations?: Array<{ id: string }> } }
  const observations = before.result?.observations ?? []
  expect(observations.length).toBe(5)

  const firstId = observations[0]!.id
  await shim.invoke('wechat_cli_json', {
    args: ['observations', 'archive', 'test_chat', firstId, '--json'],
  })

  const after = await shim.invoke('wechat_cli_json', {
    args: ['observations', 'list', 'test_chat', '--json'],
  }) as { result?: { observations?: Array<{ id: string }> } }
  const remaining = after.result?.observations ?? []
  expect(remaining.length).toBe(4)
  expect(remaining.map(o => o.id)).not.toContain(firstId)
})

test('sessions favorite toggles and persists to localStorage', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await page.goto(shimUrl)
  await page.waitForFunction(
    () => {
      const m = document.documentElement.dataset.mode
      return m !== undefined && m !== 'loading'
    },
    { timeout: 15_000 }
  )
  await page.evaluate(() => {
    localStorage.setItem('wechat-cc:favorite-sessions', JSON.stringify(['sess_1']))
  })
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

// ── Settings drawer ───────────────────────────────────────────────────

test('settings drawer is in DOM and starts closed (no .is-open)', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  const drawer = page.locator('#settings-drawer')
  await expect(drawer).toBeAttached()
  await expect(drawer).not.toHaveClass(/is-open/)
})

test('clicking #settings-open opens the drawer (.is-open class)', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await page.locator('#settings-open').click()
  await expect(page.locator('#settings-drawer')).toHaveClass(/is-open/)
})

test('clicking #settings-close closes the drawer', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await page.locator('#settings-open').click()
  await expect(page.locator('#settings-drawer')).toHaveClass(/is-open/)
  await page.locator('#settings-close').click()
  await expect(page.locator('#settings-drawer')).not.toHaveClass(/is-open/)
})

test('ESC key closes the drawer', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await page.locator('#settings-open').click()
  await expect(page.locator('#settings-drawer')).toHaveClass(/is-open/)
  await page.keyboard.press('Escape')
  await expect(page.locator('#settings-drawer')).not.toHaveClass(/is-open/)
})

test('clicking outside the drawer (on dashboard body) closes it', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await page.locator('#settings-open').click()
  await expect(page.locator('#settings-drawer')).toHaveClass(/is-open/)
  // Click somewhere clearly outside the drawer
  await page.locator('main.dashboard').click({ position: { x: 100, y: 100 } })
  await expect(page.locator('#settings-drawer')).not.toHaveClass(/is-open/)
})

// ── Toggle behavior + duplicate-ID isolation ──────────────────────────

test('drawer toggle: aria-pressed flips on click', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await page.locator('#settings-open').click()
  const toggle = page.locator('#autostart-toggle')
  const initial = await toggle.getAttribute('aria-pressed')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', initial === 'true' ? 'false' : 'true')
})

test('drawer toggle: .on class toggles on click', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await page.locator('#settings-open').click()
  // Use guard-toggle which starts off (.on absent).
  const toggle = page.locator('#guard-toggle')
  await expect(toggle).not.toHaveClass(/\bon\b/)
  await toggle.click()
  await expect(toggle).toHaveClass(/\bon\b/)
})

test('drawer and wizard step-4 toggles are independent (duplicate-ID fix regression guard)', async ({ page, shimUrl, shim }) => {
  // Pre-fix (commit before 2712bfb's follow-up rename), both #screen-service
  // and #settings-drawer used the same #autostart-toggle id. Toggling the
  // drawer copy would silently fail to update the wizard copy (and vice
  // versa) because getElementById returns only the first match. The fix
  // renamed the wizard copies to #screen-*. This test asserts that
  // clicking the drawer toggle leaves the wizard copy untouched.
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await page.locator('#settings-open').click()
  const drawerToggle = page.locator('#autostart-toggle')          // drawer's
  const wizardToggle = page.locator('#screen-autostart-toggle')   // wizard step-4's
  await expect(drawerToggle).toBeAttached()
  await expect(wizardToggle).toBeAttached()
  const drawerBefore = await drawerToggle.getAttribute('aria-pressed')
  const wizardBefore = await wizardToggle.getAttribute('aria-pressed')
  // Click drawer toggle — only that one should flip.
  await drawerToggle.click()
  const drawerAfter = await drawerToggle.getAttribute('aria-pressed')
  const wizardAfter = await wizardToggle.getAttribute('aria-pressed')
  expect(drawerAfter).not.toBe(drawerBefore)
  expect(wizardAfter).toBe(wizardBefore)  // unchanged
})
