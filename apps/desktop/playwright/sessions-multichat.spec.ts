import { test, expect } from './fixtures'

async function bootAndOpenSessions(page: import('@playwright/test').Page, shimUrl: string) {
  await page.goto(shimUrl)
  await page.waitForFunction(() => document.documentElement.dataset.mode === 'dashboard', { timeout: 10_000 })
  await page.locator('button.dash-nav-link[data-pane="sessions"]').click()
  await expect(page.locator('article.dash-pane[data-pane="sessions"]')).toBeVisible()
}

test('contact sidebar lists each seeded contact', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootAndOpenSessions(page, shimUrl)
  const sidebar = page.locator('#sessions-sidebar')
  await expect(sidebar).toBeVisible({ timeout: 10_000 })
  await expect(sidebar.locator('.contact-row')).toHaveCount(2)
  await expect(sidebar).toContainText('小白')
  await expect(sidebar).toContainText('小明')
})

test('selecting a contact filters the session list to that contact', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootAndOpenSessions(page, shimUrl)
  const body = page.locator('#sessions-body')
  // Default: most-recent contact (chatA = 小白) → wechat-cc + compass, not blog.
  await expect(body).toContainText('wechat-cc', { timeout: 10_000 })
  await expect(body).toContainText('compass')
  await expect(body).not.toContainText('blog')
  // Switch to 小明 (chatB) → only blog.
  await page.locator('#sessions-sidebar .contact-row', { hasText: '小明' }).click()
  await expect(body).toContainText('blog')
  await expect(body).not.toContainText('compass')
})

test('single contact hides the sidebar (no regression for single-chat)', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat', oneContact: true })
  await bootAndOpenSessions(page, shimUrl)
  await expect(page.locator('#sessions-sidebar')).toBeHidden()
  // The list still shows that single contact's projects.
  await expect(page.locator('#sessions-body')).toContainText('wechat-cc', { timeout: 10_000 })
})

test('zero contacts: sidebar hidden, empty-state shown', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat', withSessions: false })
  await bootAndOpenSessions(page, shimUrl)
  await expect(page.locator('#sessions-sidebar')).toBeHidden()
  await expect(page.locator('#sessions-empty')).toBeVisible()
})
