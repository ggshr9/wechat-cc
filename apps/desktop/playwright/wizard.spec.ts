// Setup-page smoke tests — driven against test-shim.ts (DRY_RUN=1).
//
// Single-page DOM structure (from index.html as of feat/setup-single-page):
//   <main class="wizard">                            wizard mode wrapper
//     <section id="wizard" class="wizard-single">
//       <div class="setup-page">
//         <div class="agent-cards">
//           <div id="agent-card-claude" class="agent-card">
//             <div id="agent-state-claude">✓ 已安装 | ✗ 未安装
//             <div id="claude-meta">/path/to/claude
//           <div id="agent-card-codex" class="agent-card">…
//         <button id="scan-bind">扫码绑定微信 →</button>
//         <div id="install-strip" hidden>
//         <div id="setup-error" hidden>
//   <dialog id="qr-modal">              sibling: QR <dialog>
//   <aside id="settings-drawer">        sibling: settings drawer (slide-in)
//
// On startup, boot() calls doctorPoller.refresh() then initialMode(report).
// With DRY_RUN CLI: depending on agent installs, mode goes wizard / dashboard.
// Wizard mode means: setup-page is visible, scan-bind exists.

import { test, expect } from './fixtures'

test('setup page renders agent cards', async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  // Wait for boot to finish: data-mode set to wizard or dashboard.
  await page.waitForFunction(
    () => ['wizard', 'dashboard'].includes(document.documentElement.dataset.mode ?? ''),
    { timeout: 15_000 }
  )
  // Both agent cards exist (regardless of installed state).
  await expect(page.locator('#agent-card-claude')).toBeAttached()
  await expect(page.locator('#agent-card-codex')).toBeAttached()
})

test('scan-bind button exists with the new id (single-page contract)', async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  await page.waitForFunction(
    () => ['wizard', 'dashboard'].includes(document.documentElement.dataset.mode ?? ''),
    { timeout: 15_000 }
  )
  // The CTA button replaces the old continue-* / service-install / enter-dashboard
  // chain. Its presence is the load-bearing test that the new wiring is in place.
  await expect(page.locator('#scan-bind')).toBeAttached()
  // Label text — Chinese copy from the spec
  await expect(page.locator('#scan-bind .label')).toHaveText(/扫码绑定微信/)
})

test('install-strip and setup-error start hidden', async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  await page.waitForFunction(
    () => ['wizard', 'dashboard'].includes(document.documentElement.dataset.mode ?? ''),
    { timeout: 15_000 }
  )
  // The transient state UIs (install progress + error strip) must start hidden.
  // They only appear during/after a scan-bind click. Asserting their initial
  // hidden state proves the page isn't showing stale state on first paint.
  await expect(page.locator('#install-strip')).toBeHidden()
  await expect(page.locator('#setup-error')).toBeHidden()
})

test('QR modal exists as a <dialog> sibling of the wizard', async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  await page.waitForFunction(
    () => ['wizard', 'dashboard'].includes(document.documentElement.dataset.mode ?? ''),
    { timeout: 15_000 }
  )
  // <dialog id="qr-modal"> must be in the DOM and start closed.
  const dialog = page.locator('dialog#qr-modal')
  await expect(dialog).toBeAttached()
  const isOpen = await dialog.evaluate((el) => (el as HTMLDialogElement).open)
  expect(isOpen).toBe(false)
})

test('settings drawer exists and starts closed (no .is-open class)', async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  await page.waitForFunction(
    () => ['wizard', 'dashboard'].includes(document.documentElement.dataset.mode ?? ''),
    { timeout: 15_000 }
  )
  const drawer = page.locator('#settings-drawer')
  await expect(drawer).toBeAttached()
  // Drawer uses .is-open class for slide-in (not hidden attribute) — verify
  // initial state has no .is-open class. Off-screen via transform.
  await expect(drawer).not.toHaveClass(/is-open/)
})

test('old step-nav DOM is gone (regression guard)', async ({ page, shimUrl }) => {
  // Catches accidental re-introduction of removed wizard steps.
  await page.goto(shimUrl)
  await page.waitForFunction(
    () => ['wizard', 'dashboard'].includes(document.documentElement.dataset.mode ?? ''),
    { timeout: 15_000 }
  )
  await expect(page.locator('button[data-step="doctor"]')).toHaveCount(0)
  await expect(page.locator('#screen-doctor')).toHaveCount(0)
  await expect(page.locator('#continue-service')).toHaveCount(0)
  await expect(page.locator('#service-install')).toHaveCount(0)
  await expect(page.locator('#enter-dashboard')).toHaveCount(0)
})

test('add-account-btn opens QR modal in-place without switching mode', async ({ page, shimUrl }) => {
  await page.goto(shimUrl)
  await page.waitForFunction(
    () => ['wizard', 'dashboard'].includes(document.documentElement.dataset.mode ?? ''),
    { timeout: 15_000 }
  )
  await expect(page.locator('#add-account-btn')).toBeAttached()
  await expect(page.locator('#add-account-btn')).toHaveText(/绑定新账号/)
  // Capture mode before click — should not change after click.
  const beforeMode = await page.evaluate(() => document.documentElement.dataset.mode)
  await page.locator('#add-account-btn').click()
  // Mode must be unchanged — no setMode("wizard") call.
  const afterMode = await page.evaluate(() => document.documentElement.dataset.mode)
  expect(afterMode).toBe(beforeMode)
  // QR <dialog> should be open.
  const dialogOpen = await page.locator('dialog#qr-modal').evaluate((el) => (el as HTMLDialogElement).open)
  expect(dialogOpen).toBe(true)
})

test('wizard QR step: setup-poll returns confirmed after auto-complete', async ({ shim }) => {
  // Direct shim API test — verifies the DRY_RUN QR auto-pass mock (P-T12).
  // This is preserved from the previous wizard.spec.ts since the underlying
  // shim/CLI flow is unchanged by the wizard refactor.
  await shim.invoke('demo.seed')
  const initial = await shim.invoke('wechat_cli_json', { args: ['setup-poll', '--qrcode', 'fake-token', '--json'] }) as { result?: { status?: string } }
  expect(initial.result?.status).toBe('wait')

  await shim.invoke('wechat_cli_json', { args: ['setup', '--qr-json'] })
  await new Promise(r => setTimeout(r, 1200))

  const confirmed = await shim.invoke('wechat_cli_json', { args: ['setup-poll', '--qrcode', 'mock-qr-token', '--json'] }) as { result?: { status?: string; accountId?: string } }
  expect(confirmed.result?.status).toBe('confirmed')
  expect(confirmed.result?.accountId).toBe('mock-bot')
})
