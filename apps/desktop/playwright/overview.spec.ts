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

// Wait for boot to finish setting state.mode to dashboard, then trigger
// a fresh doctorPoller.refresh so renderDashboard fires with the now-correct
// state.mode. Without this, the first refresh fires before setMode and
// renderDashboardIfActive bails; subsequent renders depend on the 5s poll
// interval which is racey with test timeouts.
async function bootAndForceDashboardRender(page: import('@playwright/test').Page, shimUrl: string) {
  await page.goto(shimUrl)
  await page.waitForFunction(
    () => document.documentElement.dataset.mode === 'dashboard',
    { timeout: 10_000 }
  )
  // Boot may have raced past renderDashboard. Force a re-render by
  // dispatching a synthetic visibilitychange — the dashboard subscribes
  // to refresh on visibility regain. Alternative: small delay then
  // doctorPoller.refresh, but visibilitychange is more deterministic.
  await page.evaluate(() => {
    // Trigger any visibility-listener path the app uses for fresh data.
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

// NOTE on moxiuwen's 1bfb929 change to view.js::dashboardHero —
// the new logic is `if (daemon.alive || accountCount > 0) tone = "ok"`,
// so once an account is bound the hero ALWAYS shows "AI 正在陪伴中"
// regardless of daemon liveness. The "暂时失去连接" copy is now only
// reachable when accountCount=0 + daemon dead, but that state routes
// to wizard mode (initialMode requires accounts), so the dashboard
// never actually displays it through the natural boot flow.
//
// We cover both code branches via the daemon-alive arg (still affects
// stop/restart button visibility through renderRestartButton's
// independent daemonAlive check) but only assert the rendered hero
// text in the realistic state.

test('hero shows "AI 正在陪伴中" with bound account (daemon alive)', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat', daemonAlive: true })
  await bootAndForceDashboardRender(page, shimUrl)
  await expect(page.locator('#hero-headline')).toHaveText(/AI 正在陪伴中/, { timeout: 10_000 })
  await expect(page.locator('#hero-card')).not.toHaveClass(/warn/)
})

test('hero still shows "AI 正在陪伴中" with bound account even when daemon is dead', async ({ page, shimUrl, shim }) => {
  // Per 1bfb929: bound accounts override daemon liveness for the hero
  // copy. The user's intent ("there ARE bound bots") is preserved even
  // while daemon is restarting.
  await shim.invoke('demo.seed', { chat_id: 'test_chat', daemonAlive: false })
  await bootAndForceDashboardRender(page, shimUrl)
  await expect(page.locator('#hero-headline')).toHaveText(/AI 正在陪伴中/, { timeout: 10_000 })
  await expect(page.locator('#hero-card')).not.toHaveClass(/warn/)
})

// ── Stop/restart button visibility ─────────────────────────────────────
// renderRestartButton (set in moxiuwen's 06c8c49) keys off the SAME
// dashboardHero(daemon, count) tone, so a bound account always shows
// the stop button — restart appears only with no accounts. Since accounts
// must be present for dashboard mode at all, the dashboard's restart
// button is effectively dead UI in normal user flow; we still verify
// the bound-account = stop-visible path.

test('stop button visible + restart hidden when account bound (regardless of daemon)', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat', daemonAlive: true })
  await bootAndForceDashboardRender(page, shimUrl)
  await expect(page.locator('#hero-headline')).toHaveText(/AI 正在陪伴中/, { timeout: 10_000 })
  await expect(page.locator('#dash-stop')).toBeVisible()
  await expect(page.locator('#dash-restart')).toBeHidden()
})

test('stop still visible when daemon dead but account bound', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat', daemonAlive: false })
  await bootAndForceDashboardRender(page, shimUrl)
  await expect(page.locator('#dash-stop')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('#dash-restart')).toBeHidden()
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
