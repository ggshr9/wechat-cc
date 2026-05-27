// Dashboard smoke tests — driven against test-shim.ts (DRY_RUN=1).
//
// Dashboard DOM structure (post moxiuwen merge — adopted 4-step wizard +
// moment-redesign dashboard from commit 2712bfb):
//   <main class="dashboard">  — shown when [data-mode="dashboard"]
//     <header class="dash-rail">
//       <nav class="dash-nav">
//         <button class="dash-nav-link active" data-pane="overview">    此刻
//         <button class="dash-nav-link"        data-pane="memory">      记忆
//         <button class="dash-nav-link"        data-pane="sessions">    对话
//         <button class="dash-nav-link"        data-pane="logs">        日志
//         <button class="dash-nav-link"        data-pane="a2a-agents">  Agents
//     <section class="dash-main">
//       <article class="dash-pane" data-pane="overview">                 (visible)
//       <article class="dash-pane" data-pane="memory"     hidden>
//       <article class="dash-pane" data-pane="sessions"   hidden>
//       <article class="dash-pane" data-pane="logs"       hidden>
//       <article class="dash-pane" data-pane="a2a-agents" hidden>
//
// NOTE: In DRY_RUN the doctor --json returns accounts.count=0 so the page
// boots into wizard mode by default. The dashboard <main> is always in the
// DOM (CSS shows/hides via data-mode); tests that need the dashboard
// visible switch data-mode via page.evaluate.

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

// ── Pane registry + skeleton presence ───────────────────────────────────

const PANES = ['overview', 'memory', 'sessions', 'logs', 'a2a-agents'] as const

test('dashboard renders nav + 5 panes (all attached)', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)

  for (const pane of PANES) {
    await expect(page.locator(`button.dash-nav-link[data-pane="${pane}"]`)).toBeAttached()
    await expect(page.locator(`article.dash-pane[data-pane="${pane}"]`)).toBeAttached()
  }
  // Settings gear (opens drawer, not wizard — moxiuwen's gear was repurposed
  // when master's wizard refactor landed; #settings-open is the live id).
  await expect(page.locator('#settings-open')).toBeAttached()
})

test('overview is the default-active pane on first paint', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await expect(page.locator('button.dash-nav-link.active[data-pane="overview"]')).toBeAttached()
  // Other panes' nav links must NOT have .active.
  for (const pane of ['memory', 'sessions', 'logs', 'a2a-agents'] as const) {
    await expect(page.locator(`button.dash-nav-link.active[data-pane="${pane}"]`)).toHaveCount(0)
  }
})

// ── Tab switching ───────────────────────────────────────────────────────

test('clicking a pane button switches active pane', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)

  // Click memory tab — should switch active class + un-hide memory pane.
  await page.locator('button.dash-nav-link[data-pane="memory"]').click()
  await expect(page.locator('button.dash-nav-link.active[data-pane="memory"]')).toBeAttached()
  await expect(page.locator('button.dash-nav-link.active[data-pane="overview"]')).toHaveCount(0)
  // The memory pane should no longer be hidden (active panes drop the
  // hidden attribute).
  const memoryHidden = await page.locator('article.dash-pane[data-pane="memory"]').getAttribute('hidden')
  expect(memoryHidden).toBeNull()
})

test('round-trip: overview → memory → overview restores initial state', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await page.locator('button.dash-nav-link[data-pane="memory"]').click()
  await page.locator('button.dash-nav-link[data-pane="overview"]').click()
  await expect(page.locator('button.dash-nav-link.active[data-pane="overview"]')).toBeAttached()
  // memory should be hidden again
  await expect(page.locator('article.dash-pane[data-pane="memory"][hidden]')).toBeAttached()
})

// ── Per-pane DOM contract ───────────────────────────────────────────────

test('overview pane has hero + current-user + sub-user grid', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  const pane = page.locator('article.dash-pane[data-pane="overview"]')
  // moxiuwen's redesign — hero card + current user + sub-user grid
  await expect(pane.locator('#hero-card')).toBeAttached()
  await expect(pane.locator('#hero-headline')).toBeAttached()
  await expect(pane.locator('#accounts-current')).toBeAttached()
  await expect(pane.locator('#accounts-body')).toBeAttached()
  await expect(pane.locator('#dash-restart')).toBeAttached()
  await expect(pane.locator('#dash-stop')).toBeAttached()
})

test('memory pane has sidebar + observations + milestones + content viewer', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await page.locator('button.dash-nav-link[data-pane="memory"]').click()
  const pane = page.locator('article.dash-pane[data-pane="memory"]')
  await expect(pane).toBeVisible()
  // Real IDs from index.html — the memory pane has a 3-column layout:
  // top zone with observations + milestones, then sidebar (file list)
  // + main content (markdown view + editor) + decisions panel.
  await expect(pane.locator('#memory-observations')).toBeAttached()
  await expect(pane.locator('#memory-milestones')).toBeAttached()
  await expect(pane.locator('#memory-sidebar')).toBeAttached()
  await expect(pane.locator('#memory-refresh')).toBeAttached()
  await expect(pane.locator('#memory-meta')).toBeAttached()
})

test('sessions pane has detail-mode toggle + meta crumb', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await page.locator('button.dash-nav-link[data-pane="sessions"]').click()
  const pane = page.locator('article.dash-pane[data-pane="sessions"]')
  await expect(pane).toBeVisible()
  // Real DOM from index.html — meta crumb + 精简/详细 mode toggle.
  await expect(pane.locator('#sessions-meta')).toBeAttached()
  await expect(pane.locator('#sessions-mode-compact')).toBeAttached()
})

test('logs pane has meta crumb + content container', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await page.locator('button.dash-nav-link[data-pane="logs"]').click()
  const pane = page.locator('article.dash-pane[data-pane="logs"]')
  await expect(pane).toBeVisible()
  await expect(pane.locator('#logs-meta')).toBeAttached()
})

test('a2a-agents pane has server banner + agent list + Add Agent button', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await page.locator('button.dash-nav-link[data-pane="a2a-agents"]').click()
  const pane = page.locator('article.dash-pane[data-pane="a2a-agents"]')
  await expect(pane).toBeVisible()
  await expect(pane.locator('#a2a-server-banner')).toBeAttached()
  await expect(pane.locator('#a2a-agents-list')).toBeAttached()
  await expect(pane.locator('#a2a-add-btn')).toBeAttached()
})

test('a2a add modal opens + closes via ✕ button (regression for fix 5ddeb72)', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  await page.locator('button.dash-nav-link[data-pane="a2a-agents"]').click()
  // Open the modal
  await page.locator('#a2a-add-btn').click()
  await expect(page.locator('dialog#a2a-add-modal[open]')).toBeVisible()
  // Close via the ✕ — this was missing pre-5ddeb72 and the modal had no escape hatch
  await page.locator('#a2a-add-modal-close').click()
  await expect(page.locator('dialog#a2a-add-modal[open]')).toHaveCount(0)
})

// ── Data flow regression — shim seeding propagates through the CLI ──────

test('observations list reflects seeded data', async ({ shim }) => {
  // Direct shim API test — no UI needed; verifies the data layer works
  // end-to-end. Seed 5 observations for test_chat.
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  const result = await shim.invoke('wechat_cli_json', {
    args: ['observations', 'list', 'test_chat', '--json'],
  }) as { result?: { observations?: unknown[] } }
  const observations = result.result?.observations ?? []
  expect(observations.length).toBe(5)
})

// ── Reconnect-diagnose card ───────────────────────────────────────────────
//
// Pattern:
//  1. Boot into dashboard mode (accounts + service seeded so initialMode
//     returns 'dashboard').
//  2. Inject a doctorOverride via mock.doctor so the NEXT doctor --json
//     poll returns the desired DoctorReport shape.
//  3. Click #dash-restart to trigger restartDaemon().
//  4. Assert #reconnect-diagnose-card becomes visible with expected title.
//
// For "all-green" (code 0): assert card stays hidden (or a brief toast
// appears on #dash-pending) instead of the card being shown.
//
// For "dead-daemon triggers restart chain": after clicking the card's
// primary button, assert the shim recorded service stop + service start.

// Helper: build a minimal DoctorReport that produces a given diagnosis code.
// These shapes must match what diagnose() in view.js expects.
const REPORTS = {
  // code-1: daemon dead + pid≠null + service installed → "后台服务挂了"
  deadDaemon: {
    ready: true,
    stateDir: '/tmp/wechat-cc-shim',
    runtime: 'source',
    wslDetected: false,
    checks: {
      bun:      { ok: true, path: '/usr/local/bin/bun' },
      git:      { ok: true, path: '/usr/bin/git' },
      claude:   { ok: true, path: '/usr/local/bin/claude' },
      codex:    { ok: true, path: '/usr/local/bin/codex' },
      cursor:   { ok: false, apiKeySet: false, sdkInstalled: true },
      accounts: { ok: true, count: 1, items: [{ id: 'bot1-im-bot', botId: 'bot1', userId: 'u1', baseUrl: '' }] },
      access:   { ok: true, dmPolicy: 'allowlist', allowFromCount: 1 },
      provider: { ok: true, provider: 'claude', binaryPath: '/usr/local/bin/claude' },
      daemon:   { alive: false, pid: 9999 },
      service:  { installed: true, kind: 'launchagent' },
    },
    userNames: { u1: 'Test User' },
    expiredBots: [],
    nextActions: [],
  },
  // code-5 (expired): daemon alive + expiredBots non-empty → "微信账号已过期"
  accountExpired: {
    ready: true,
    stateDir: '/tmp/wechat-cc-shim',
    runtime: 'source',
    wslDetected: false,
    checks: {
      bun:      { ok: true, path: '/usr/local/bin/bun' },
      git:      { ok: true, path: '/usr/bin/git' },
      claude:   { ok: true, path: '/usr/local/bin/claude' },
      codex:    { ok: true, path: '/usr/local/bin/codex' },
      cursor:   { ok: false, apiKeySet: false, sdkInstalled: true },
      accounts: { ok: true, count: 1, items: [{ id: 'bot1-im-bot', botId: 'bot1', userId: 'u1', baseUrl: '' }] },
      access:   { ok: true, dmPolicy: 'allowlist', allowFromCount: 1 },
      provider: { ok: true, provider: 'claude', binaryPath: '/usr/local/bin/claude' },
      daemon:   { alive: true, pid: 12345 },
      service:  { installed: true, kind: 'launchagent' },
    },
    userNames: { u1: 'Test User' },
    expiredBots: [{ botId: 'bot1', firstSeenExpiredAt: Date.now() - 3600000 }],
    nextActions: [],
  },
  // code-4: daemon alive + claude.severity='hard' → "AI 工具缺失"
  providerMissing: {
    ready: true,
    stateDir: '/tmp/wechat-cc-shim',
    runtime: 'source',
    wslDetected: false,
    checks: {
      bun:      { ok: true, path: '/usr/local/bin/bun' },
      git:      { ok: true, path: '/usr/bin/git' },
      claude:   { severity: 'hard', fix: { command: 'npm install -g @anthropic-ai/claude-code' } },
      codex:    { ok: true, path: '/usr/local/bin/codex' },
      cursor:   { ok: false, apiKeySet: false, sdkInstalled: true },
      accounts: { ok: true, count: 1, items: [{ id: 'bot1-im-bot', botId: 'bot1', userId: 'u1', baseUrl: '' }] },
      access:   { ok: true, dmPolicy: 'allowlist', allowFromCount: 1 },
      provider: { ok: false, provider: 'claude' },
      daemon:   { alive: true, pid: 12345 },
      service:  { installed: true, kind: 'launchagent' },
    },
    userNames: { u1: 'Test User' },
    expiredBots: [],
    nextActions: [],
  },
  // code-0: all green → no card, toast "一切正常，无需操作"
  allGreen: {
    ready: true,
    stateDir: '/tmp/wechat-cc-shim',
    runtime: 'source',
    wslDetected: false,
    checks: {
      bun:      { ok: true, path: '/usr/local/bin/bun' },
      git:      { ok: true, path: '/usr/bin/git' },
      claude:   { ok: true, path: '/usr/local/bin/claude' },
      codex:    { ok: true, path: '/usr/local/bin/codex' },
      cursor:   { ok: false, apiKeySet: false, sdkInstalled: true },
      accounts: { ok: true, count: 1, items: [{ id: 'bot1-im-bot', botId: 'bot1', userId: 'u1', baseUrl: '' }] },
      access:   { ok: true, dmPolicy: 'allowlist', allowFromCount: 1 },
      provider: { ok: true, provider: 'claude', binaryPath: '/usr/local/bin/claude' },
      daemon:   { alive: true, pid: 12345 },
      service:  { installed: true, kind: 'launchagent' },
    },
    userNames: { u1: 'Test User' },
    expiredBots: [],
    nextActions: [],
  },
}

test.describe('reconnect-diagnose card', () => {
  test('dead-daemon click shows code-1 card and triggers restart on primary', async ({ page, shimUrl, shim }) => {
    // Seed so dashboard mode is reached
    await shim.invoke('demo.seed', { chat_id: 'test_chat' })
    await bootIntoDashboard(page, shimUrl)

    // Inject the dead-daemon doctor shape BEFORE clicking restart
    await shim.invoke('mock.doctor', { report: REPORTS.deadDaemon })
    await shim.invoke('mock.reset-service-invokes')

    // The restart button is visible only when hero.tone !== "ok".
    // Our shim initially seeds daemon.alive=true (demo.seed default),
    // so the restart button is hidden and the stop button is shown.
    // Force-show the restart button for this test via evaluate.
    await page.evaluate(() => {
      const btn = document.getElementById('dash-restart')
      if (btn) btn.hidden = false
    })

    // Click "重新连接" — triggers restartDaemon() → diagnose() → card shown
    await page.locator('#dash-restart').click()

    // Card should now be visible with the correct title
    await expect(page.locator('#reconnect-diagnose-card')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('#rdc-title')).toHaveText('后台服务挂了')

    // Click the primary button ("一键重启后台") to trigger the restart chain.
    // The dead-daemon report makes daemon.alive false, so waitForCondition
    // in runRestartSequence will time out and fall back to the non-alive branch.
    // We just need to confirm the service stop/start calls were recorded.
    // Inject an alive report so waitForCondition resolves.
    await shim.invoke('mock.doctor', { report: REPORTS.allGreen })
    await page.locator('#rdc-primary').click()

    // Poll until both stop + start have been recorded (max 5s) rather than
    // sleeping a fixed 2s — faster on a fast machine, reliable on a slow one.
    await expect.poll(
      async () => {
        const r = await shim.invoke('mock.get-service-invokes') as { result: { invokes: string[] } }
        return r.result.invokes
      },
      { timeout: 5000 },
    ).toEqual(expect.arrayContaining(['service stop', 'service start']))

    // Final verification (invokes already polled above, re-read for the assertion log)
    const invokes = await shim.invoke('mock.get-service-invokes') as { result: { invokes: string[] } }
    expect(invokes.result.invokes).toContain('service stop')
    expect(invokes.result.invokes).toContain('service start')
  })

  test('account-expired click shows code-5 card', async ({ page, shimUrl, shim }) => {
    await shim.invoke('demo.seed', { chat_id: 'test_chat' })
    await bootIntoDashboard(page, shimUrl)

    await shim.invoke('mock.doctor', { report: REPORTS.accountExpired })

    await page.evaluate(() => {
      const btn = document.getElementById('dash-restart')
      if (btn) btn.hidden = false
    })
    await page.locator('#dash-restart').click()

    await expect(page.locator('#reconnect-diagnose-card')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('#rdc-title')).toHaveText('微信账号已过期')
    // Primary action is "重新扫码" for expired accounts
    await expect(page.locator('#rdc-primary')).toHaveText('重新扫码')
  })

  test('provider-missing click shows code-4 card with copy button', async ({ page, shimUrl, shim }) => {
    await shim.invoke('demo.seed', { chat_id: 'test_chat' })
    await bootIntoDashboard(page, shimUrl)

    await shim.invoke('mock.doctor', { report: REPORTS.providerMissing })

    await page.evaluate(() => {
      const btn = document.getElementById('dash-restart')
      if (btn) btn.hidden = false
    })
    await page.locator('#dash-restart').click()

    await expect(page.locator('#reconnect-diagnose-card')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('#rdc-title')).toHaveText('AI 工具缺失')
    // The fix section with the install command should be visible
    await expect(page.locator('#rdc-fix')).toBeVisible()
    // A "复制" button should appear inside the fix section
    await expect(page.locator('#rdc-fix button')).toHaveText('复制')
    // Secondary action "切换 provider" should be shown
    await expect(page.locator('#rdc-secondary')).toBeVisible()
    await expect(page.locator('#rdc-secondary')).toHaveText('切换 provider')
  })

  test('all-green click shows nothing (card stays hidden, pending shows 一切正常)', async ({ page, shimUrl, shim }) => {
    await shim.invoke('demo.seed', { chat_id: 'test_chat' })
    await bootIntoDashboard(page, shimUrl)

    await shim.invoke('mock.doctor', { report: REPORTS.allGreen })

    await page.evaluate(() => {
      const btn = document.getElementById('dash-restart')
      if (btn) btn.hidden = false
    })
    await page.locator('#dash-restart').click()

    // Card should NOT become visible for code 0
    // Give it a moment in case the async path completes quickly
    await page.waitForTimeout(300)
    const cardVisible = await page.locator('#reconnect-diagnose-card').isVisible()
    expect(cardVisible).toBe(false)

    // Pending text shows the "all green" message
    await expect(page.locator('#dash-pending')).toHaveText('一切正常，无需操作', { timeout: 3000 })
  })

  test('frontend-stuck click shows code-7 card (lastError non-null + healthOk=true)', async ({ page, shimUrl, shim }) => {
    // Seed so dashboard mode is reached with daemonAlive=true (generates a
    // report with internal_api in daemon.checks so healthProbe can fire).
    await shim.invoke('demo.seed', { chat_id: 'test_chat' })
    await bootIntoDashboard(page, shimUrl)

    // Ensure health probe returns true (default, but be explicit).
    await shim.invoke('mock.health-probe', { result: true })

    // Make the NEXT doctor --json call fail so doctorPoller.lastError gets set.
    // The poller's .current still holds the last good report (from boot poll).
    await shim.invoke('mock.doctor-error')

    // Force-show the restart button (daemon was alive at boot → stop btn shown).
    await page.evaluate(() => {
      const btn = document.getElementById('dash-restart')
      if (btn) btn.hidden = false
    })

    // Click "重新连接" — restartDaemon:
    //   1. refresh() fails → lastError set, returns null
    //   2. current report has daemon.internal_api → healthProbe fires → true
    //   3. diagnose({ report, healthOk: true, lastError: non-null }) → code 7
    await page.locator('#dash-restart').click()

    await expect(page.locator('#reconnect-diagnose-card')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('#rdc-title')).toContainText(/Dashboard 自己卡了|前端|本地轮询/i)
    // Primary action is "重启 Dashboard"
    await expect(page.locator('#rdc-primary')).toHaveText('重启 Dashboard')
  })
})
