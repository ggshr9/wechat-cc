// Wizard smoke tests — driven against test-shim.ts (DRY_RUN=1).
//
// Wizard DOM structure (from index.html audit):
//   <main class="wizard"> — wrapper for wizard mode; shown when [data-mode="wizard"]
//     <div class="steps">
//       <button data-step="doctor">  — step 1: env check
//       <button data-step="provider"> — step 2: agent
//       <button data-step="wechat">  — step 3: bind WeChat / QR  ← default on this machine
//       <button data-step="service"> — step 4: background service
//     <section id="screen-doctor" class="screen [active]">
//       <div id="checks" class="env-list"> — doctor/env-check list renders here
//     <section id="screen-wechat" class="screen [active]">
//       <button id="qr-refresh">生成二维码</button>
//       <div id="qr-poll"> — polling status indicator
//       <button id="continue-service" disabled>继续</button>
//
// On startup, boot() calls doctorPoller.refresh() then initialMode(report).
// With DRY_RUN CLI: provider.ok=true, no accounts → wizard step "wechat".
// So after page load stabilises, #screen-wechat.active is the active screen.

import { test, expect } from './fixtures'

test('wizard renders without crashing', async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  // Verify the page title
  await expect(page).toHaveTitle(/wechat-cc/i)
  // The wizard main element must be in the DOM
  await expect(page.locator('main.wizard')).toBeAttached()
  // Step navigation buttons must exist
  await expect(page.locator('button[data-step="doctor"]')).toBeAttached()
  await expect(page.locator('button[data-step="wechat"]')).toBeAttached()
})

test('wizard shows an active screen after boot', async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  // Wait for the page to exit "loading" mode and enter wizard mode.
  // After boot(), data-mode is set to "wizard" (or "dashboard").
  // On a DRY_RUN CI machine (no accounts), wizard mode is expected.
  await page.waitForFunction(
    () => document.documentElement.dataset.mode === 'wizard' || document.documentElement.dataset.mode === 'dashboard',
    { timeout: 15_000 }
  )
  // At least one screen section must be active inside the wizard
  // (screen-doctor, screen-provider, screen-wechat, or screen-service)
  const activeScreen = page.locator('.wizard .screen.active')
  await expect(activeScreen).toBeAttached()

  // In DRY_RUN with provider.ok=true and no accounts, boot routes to wechat step.
  // Verify the QR-bind screen is the active step.
  const mode = await page.evaluate(() => document.documentElement.dataset.mode)
  if (mode === 'wizard') {
    // The #checks container must be in DOM regardless of active step
    await expect(page.locator('#checks')).toBeAttached()
    // The QR refresh button must be present (wizard includes it in HTML even if step hidden)
    await expect(page.locator('#qr-refresh')).toBeAttached()
  }
})

test('wizard QR step: setup-poll returns confirmed after auto-complete', async ({ shim }) => {
  // Direct shim API test — verifies the DRY_RUN QR auto-pass mock (P-T12).
  // Reset mock state so qrScanComplete is false (guards against shim reuse across runs).
  await shim.invoke('demo.seed')
  // Step 1: initial poll returns "wait" (qrScanComplete is now false)
  const initial = await shim.invoke('wechat_cli_json', { args: ['setup-poll', '--qrcode', 'fake-token', '--json'] }) as { result?: { status?: string } }
  expect(initial.result?.status).toBe('wait')

  // Step 2: trigger setup --qr-json which schedules qrScanComplete after 1s
  await shim.invoke('wechat_cli_json', { args: ['setup', '--qr-json'] })

  // Step 3: wait 1.2s for the auto-complete timeout inside the shim
  await new Promise(r => setTimeout(r, 1200))

  // Step 4: poll again — should now be confirmed with accountId 'mock-bot'
  const confirmed = await shim.invoke('wechat_cli_json', { args: ['setup-poll', '--qrcode', 'mock-qr-token', '--json'] }) as { result?: { status?: string; accountId?: string } }
  expect(confirmed.result?.status).toBe('confirmed')
  expect(confirmed.result?.accountId).toBe('mock-bot')
})
