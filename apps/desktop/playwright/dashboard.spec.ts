// Dashboard smoke tests — driven against test-shim.ts (DRY_RUN=1).
//
// Dashboard DOM structure (from index.html audit):
//   <main class="dashboard">  — shown when [data-mode="dashboard"]
//     <aside class="dash-rail">
//       <nav class="dash-nav">
//         <button data-pane="overview">  — default active pane
//         <button data-pane="sessions">
//         <button data-pane="memory">
//         <button data-pane="logs">
//     <section class="dash-main">
//       <article class="dash-pane" data-pane="overview">
//         <div class="card">
//           <tbody id="accounts-body">  — bound accounts table
//           <tbody id="conversations-body">  — conversations table
//
// NOTE: In DRY_RUN the doctor --json always returns accounts.count=0 so the
// page boots into wizard mode, NOT dashboard mode. The dashboard <main> is
// always in the DOM (CSS shows/hides via data-mode); tests that need the
// dashboard visible use page.evaluate to switch data-mode directly.
// Shim-only tests (no page) bypass this entirely and test the data layer.

import { test, expect } from './fixtures'

test('dashboard panel is in DOM and becomes visible when mode is set', async ({ page, shimUrl, shim }) => {
  // Seed mock state so the shim has accounts/observations data
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await page.goto(shimUrl)

  // Wait for the page to exit loading mode (wizard or dashboard)
  await page.waitForFunction(
    () => {
      const m = document.documentElement.dataset.mode
      return m !== undefined && m !== 'loading'
    },
    { timeout: 15_000 }
  )

  // Force dashboard mode via dataset mutation — setMode() is module-scoped
  // so we patch the CSS anchor directly. The dashboard <main> is always in
  // the DOM; [data-mode="dashboard"] .dashboard { flex: 1 } makes it visible.
  await page.evaluate(() => {
    document.documentElement.dataset.mode = 'dashboard'
  })

  // The dashboard main element must now be visible
  const dashMain = page.locator('main.dashboard')
  await expect(dashMain).toBeVisible({ timeout: 5_000 })

  // Nav pane buttons must be present
  await expect(page.locator('button[data-pane="overview"]')).toBeAttached()
  await expect(page.locator('button[data-pane="sessions"]')).toBeAttached()
  await expect(page.locator('button[data-pane="memory"]')).toBeAttached()

  // Accounts table body must be in DOM (even if empty in DRY_RUN boot)
  await expect(page.locator('#accounts-body')).toBeAttached()
})

test('observations list reflects seeded data', async ({ shim }) => {
  // Direct shim API test — no UI needed; verify the data layer works end-to-end.
  // Seed 5 observations for test_chat.
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })

  // Frontend calls: wechat_cli_json { args: ["observations", "list", chatId, "--json"] }
  const result = await shim.invoke('wechat_cli_json', {
    args: ['observations', 'list', 'test_chat', '--json'],
  }) as { result?: { observations?: unknown[] } }

  // DRY_RUN shim intercepts and returns mock observations from __mockState
  const observations = result.result?.observations ?? []
  expect(observations.length).toBe(5)
})
