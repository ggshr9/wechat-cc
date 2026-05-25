// Overview ("此刻") pane data-flow tests — driven against test-shim.ts.
//
// Covers moxiuwen's redesigned hero card + current-user card + sub-user
// grid (post merge 782268e):
//   1. hero tone — daemon alive ("AI 正在陪伴中") vs dead ("暂时失去连接")
//   2. current-user card — populated when an account is bound, empty
//      placeholder when not
//   3. sub-user grid — 6 demo cards when no real sub-users; sub-rows
//      from accounts.items.slice(1) when present
//   4. provider chip reads from doctor.checks.provider.provider
//
// Drives the dashboard via the shim's doctor intercept which produces
// daemon.alive + accounts based on demo.seed state.

import { test, expect } from './fixtures'

// These tests rely on initialMode() routing into dashboard mode based on
// the doctor mock (accounts + provider + service all present). No manual
// dataset.mode override needed — the boot path naturally lands on dashboard
// when demo.seed has populated chats. That also means renderDashboard
// actually runs (it bails when state.mode !== 'dashboard' even if the
// DOM data-mode attr says otherwise).

// ── Hero tone (daemon alive vs dead) ────────────────────────────────────
//
// To exercise the hero render path, the page must boot INTO dashboard mode
// (state.mode = "dashboard" — not just the data-mode attribute). initialMode
// requires accounts + provider + service to all be present. We always seed
// so that condition holds, then independently set daemonAlive to drive the
// hero tone.

test('hero shows "AI 正在陪伴中" when daemon is alive', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat', daemonAlive: true })
  await page.goto(shimUrl)
  await expect(page.locator('#hero-headline')).toHaveText(/AI 正在陪伴中/, { timeout: 10_000 })
  await expect(page.locator('#hero-card')).not.toHaveClass(/warn/)
})

test('hero shows "暂时失去连接" when daemon is dead but accounts bound', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat', daemonAlive: false })
  await page.goto(shimUrl)
  await expect(page.locator('#hero-headline')).toHaveText(/暂时失去连接/, { timeout: 10_000 })
  await expect(page.locator('#hero-card')).toHaveClass(/warn/)
})

// ── Stop/restart button visibility tied to hero tone ────────────────────

test('stop button visible + restart hidden when daemon alive', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat', daemonAlive: true })
  await page.goto(shimUrl)
  await expect(page.locator('#hero-headline')).toHaveText(/AI 正在陪伴中/, { timeout: 10_000 })
  await expect(page.locator('#dash-stop')).toBeVisible()
  await expect(page.locator('#dash-restart')).toBeHidden()
})

test('restart button visible + stop hidden when daemon dead', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat', daemonAlive: false })
  await page.goto(shimUrl)
  await expect(page.locator('#hero-headline')).toHaveText(/暂时失去连接/, { timeout: 10_000 })
  await expect(page.locator('#dash-restart')).toBeVisible()
  await expect(page.locator('#dash-stop')).toBeHidden()
})

// ── Current-user card ───────────────────────────────────────────────────

test('current-user card renders bound account name + 管理员 pill', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await page.goto(shimUrl)
  await expect(page.locator('main.dashboard')).toBeVisible({ timeout: 10_000 })
  const current = page.locator('#accounts-current')
  // Friendly name comes from userNames[userId] in the doctor response.
  // demo.seed seeds userNames = { test_chat: 'Test User' }.
  await expect(current).toContainText(/Test User/, { timeout: 10_000 })
  await expect(current.locator('.role-pill')).toContainText(/管理员/)
  await expect(current.locator('.provider-chip')).toContainText(/claude/)
})

// ── Sub-user grid ───────────────────────────────────────────────────────

test('sub-user grid shows 6 demo cards when no real sub-users', async ({ page, shimUrl, shim }) => {
  // demo.seed produces 1 real account → rows.slice(1) is empty → demo cards shown.
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await page.goto(shimUrl)
  await expect(page.locator('main.dashboard')).toBeVisible({ timeout: 10_000 })
  // demoSubUsers() returns 6 placeholder rows.
  await expect(page.locator('#accounts-body .sub-user-card')).toHaveCount(6, { timeout: 10_000 })
  // Each demo card has the data-bot-id attr set to demo-N.
  await expect(page.locator('#accounts-body .sub-user-card[data-bot-id^="demo-"]')).toHaveCount(6)
})

test('demo sub-user cards have no delete button (row.demo flag)', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await page.goto(shimUrl)
  await expect(page.locator('main.dashboard')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('#accounts-body .sub-user-card')).toHaveCount(6, { timeout: 10_000 })
  // Demo cards skip the delete affordance — non-demo non-expired rows
  // would have a .mini-action[data-action="ask-delete"] button.
  const deleteBtns = page.locator('#accounts-body .sub-user-card .mini-action[data-action="ask-delete"]')
  await expect(deleteBtns).toHaveCount(0)
})
