// Sessions ("对话") pane data-flow tests — driven against test-shim.ts.
//
// Distinct from the existing sessions.spec.ts which focuses on the
// read-jsonl ENOENT regression. This file covers the full pane:
//
//   1. switching to sessions tab triggers loadSessionsList
//   2. project rows render from seeded shim state
//   3. empty-state copy when no projects
//   4. mode toggle (精简 / 详细) flips active class
//   5. detail bar (#sessions-back, #sessions-export, etc.) all in DOM
//   6. session-group headers group projects by recency
//
// The shim's sessions list-projects intercept returns demo.seed's 2
// projects ('wechat-cc' + 'compass') when seeded. demo.unseed empties
// the list.

import { test, expect } from './fixtures'

async function bootAndOpenSessions(page: import('@playwright/test').Page, shimUrl: string) {
  await page.goto(shimUrl)
  await page.waitForFunction(() => document.documentElement.dataset.mode === 'dashboard', { timeout: 10_000 })
  await page.locator('button.dash-nav-link[data-pane="sessions"]').click()
  await expect(page.locator('article.dash-pane[data-pane="sessions"]')).toBeVisible()
}

// ── projects list ───────────────────────────────────────────────────────

test('sessions tab renders projects from seeded shim state', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootAndOpenSessions(page, shimUrl)
  const body = page.locator('#sessions-body')
  await expect(body).toBeVisible()
  // demo.seed yields 2 sessions: 'wechat-cc' + 'compass'
  await expect(body).toContainText('wechat-cc', { timeout: 10_000 })
  await expect(body).toContainText('compass')
})

test('sessions meta crumb shows project count', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootAndOpenSessions(page, shimUrl)
  // loadSessionsList sets meta to "<N> 个项目"
  await expect(page.locator('#sessions-meta')).toContainText(/2 个项目/, { timeout: 10_000 })
})

test('sessions empty-state copy appears when no projects', async ({ page, shimUrl, shim }) => {
  // Seed accounts (so initialMode → dashboard) but with no sessions, so
  // sessions list-projects intercept returns []. Without withSessions:false
  // the default seed also creates 2 demo sessions which would hide the
  // empty-state element via display:none.
  await shim.invoke('demo.seed', { chat_id: 'test_chat', withSessions: false })
  await bootAndOpenSessions(page, shimUrl)
  await expect(page.locator('#sessions-empty')).toContainText(/还没有项目会话/, { timeout: 10_000 })
})

// ── mode toggle (精简 / 详细) ──────────────────────────────────────────

test('mode toggle: 精简 is default active', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootAndOpenSessions(page, shimUrl)
  await expect(page.locator('#sessions-mode-compact')).toHaveClass(/is-active/)
  await expect(page.locator('#sessions-mode-detailed')).not.toHaveClass(/is-active/)
})

test('mode toggle: clicking 详细 flips active class', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootAndOpenSessions(page, shimUrl)
  await page.locator('#sessions-mode-detailed').click()
  await expect(page.locator('#sessions-mode-detailed')).toHaveClass(/is-active/)
  await expect(page.locator('#sessions-mode-compact')).not.toHaveClass(/is-active/)
})

test('mode toggle: round-trip 精简 → 详细 → 精简', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootAndOpenSessions(page, shimUrl)
  await page.locator('#sessions-mode-detailed').click()
  await page.locator('#sessions-mode-compact').click()
  await expect(page.locator('#sessions-mode-compact')).toHaveClass(/is-active/)
  await expect(page.locator('#sessions-mode-detailed')).not.toHaveClass(/is-active/)
})

// ── detail bar skeleton ──────────────────────────────────────────────

test('detail bar DOM is in place (initially hidden)', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootAndOpenSessions(page, shimUrl)
  // #sessions-detail starts with .dismissed class so it's visually hidden
  // but still in DOM. Verify the child controls are present so the
  // openProjectDetail path can rely on them.
  const detail = page.locator('#sessions-detail')
  await expect(detail).toBeAttached()
  await expect(detail).toHaveClass(/dismissed/)
  await expect(detail.locator('#sessions-back')).toBeAttached()
  await expect(detail.locator('#sessions-detail-meta')).toBeAttached()
  await expect(detail.locator('#sessions-export')).toBeAttached()
  await expect(detail.locator('#sessions-jsonl')).toBeAttached()
})

// ── session-group headers ────────────────────────────────────────────

test('projects are grouped by recency with header bands', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootAndOpenSessions(page, shimUrl)
  // groupProjectsByRecency emits .session-group blocks with .session-group-h
  // headers (今天 / 这周 / 更早). With demo.seed's 2 sessions (one created
  // "now", one 1h ago), both should land under "今天".
  const groups = page.locator('#sessions-body .session-group')
  await expect(groups.first()).toBeAttached({ timeout: 10_000 })
  const firstGroupHeader = groups.first().locator('.session-group-h')
  await expect(firstGroupHeader).toContainText(/今天|这周|更早/)
})
