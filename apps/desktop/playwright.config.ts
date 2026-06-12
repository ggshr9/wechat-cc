import { defineConfig, devices } from '@playwright/test'
import { existsSync } from 'node:fs'

// Default the production CSP ON for every run so the dashboard is always
// exercised under the same Content-Security-Policy the bundled Tauri webview
// enforces, and csp.spec.ts stops being skipped by default. The fixture
// spreads process.env into the shim it spawns, so setting it here (the runner
// process) reaches both the shim's CSP injection and the spec skip-gates.
// Cross-platform (no shell `VAR=… cmd` prefix). Override with
// WECHAT_CC_INJECT_CSP=0 to run without CSP injection.
process.env.WECHAT_CC_INJECT_CSP ??= '1'

// Use system Chrome when the Playwright-managed chromium binary is missing
// (e.g. Ubuntu 26.04 which Playwright does not yet officially support).
// PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH is read by the browser launch
// helper; alternatively we pick the first system binary we find and set the
// channel. The channel approach requires no per-project config.
const MANAGED_CHROMIUM = process.env.HOME
  ? `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell`
  : ''
const SYSTEM_CHROME_PATHS = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
]
const systemChrome = SYSTEM_CHROME_PATHS.find(p => existsSync(p))
const needsSystemChrome = MANAGED_CHROMIUM && !existsSync(MANAGED_CHROMIUM) && !!systemChrome

export default defineConfig({
  testDir: './playwright',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${process.env.PLAYWRIGHT_SHIM_PORT ?? '4176'}`,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    ...(needsSystemChrome ? { launchOptions: { executablePath: systemChrome } } : {}),
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(needsSystemChrome ? { launchOptions: { executablePath: systemChrome } } : {}),
      },
    },
  ],
})
