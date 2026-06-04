import { test, expect } from './fixtures'

async function bootAndOpenDialogue(page: import('@playwright/test').Page, shimUrl: string, shim: { invoke(cmd: string, args?: unknown): Promise<unknown> }) {
  await shim.invoke('demo.seed', { chat_id: 'dialogue_preview', daemonAlive: true })
  await page.goto(shimUrl)
  await page.locator('button.dash-nav-link[data-pane="sessions"]').click()
  await expect(page.locator('#dialogue-root')).toBeVisible()
}

test('dialogue page reuses the existing dashboard navigation and document layout', async ({ page, shimUrl, shim }) => {
  await bootAndOpenDialogue(page, shimUrl, shim)
  await expect(page.locator('button.dash-nav-link[data-pane="sessions"]')).toHaveClass(/active/)
  await expect(page.locator('.dialogue-sidebar')).toBeVisible()
  await expect(page.locator('.dialogue-document')).toContainText('介绍一下 AI FDE 这个岗位')
})

test('knowledge topics show key-content tags for quick scanning', async ({ page, shimUrl, shim }) => {
  await bootAndOpenDialogue(page, shimUrl, shim)

  const knowledge = page.locator('.dialogue-group').filter({ hasText: '知识' })
  await expect(knowledge.locator('.dialogue-topic.has-tags')).toHaveCount(3)
  await expect(knowledge.locator('.dialogue-topic-tags')).toContainText(['figma插件skill', 'UI设计', '设计规范'])
})

test('stories and emotions stay hidden until the shared privacy password is entered', async ({ page, shimUrl, shim }) => {
  await bootAndOpenDialogue(page, shimUrl, shim)
  await expect(page.locator('.dialogue-locked-row')).toHaveCount(2)
  await expect(page.locator('.dialogue-sidebar')).not.toContainText('和花艺师闺蜜的周末')

  await page.locator('.dialogue-locked-row').first().click()
  await page.locator('#privacy-password').fill('1234')
  await page.locator('.privacy-submit').click()

  await expect(page.locator('#privacy-dialog')).toBeHidden()
  await expect(page.locator('.dialogue-sidebar')).toContainText('和花艺师闺蜜的周末')
  await expect(page.locator('.dialogue-sidebar')).toContainText('糟糕的心情')
})

test('private groups can be manually locked again', async ({ page, shimUrl, shim }) => {
  await bootAndOpenDialogue(page, shimUrl, shim)
  await page.locator('.dialogue-locked-row').first().click()
  await page.locator('#privacy-password').fill('1234')
  await page.locator('.privacy-submit').click()
  await page.locator('[data-lock="stories"]').click()

  await expect(page.locator('.dialogue-locked-row')).toHaveCount(2)
  await expect(page.locator('.dialogue-sidebar')).not.toContainText('糟糕的心情')
})
