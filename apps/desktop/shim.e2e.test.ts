// End-to-end smoke that exercises the apps/desktop ↔ wechat-cc CLI seam
// the same way the real Tauri shell does. Spawns test-shim.ts (which is
// what `bun run shim` boots locally), fetches the served HTML to assert
// structural integrity, then POSTs to /__invoke for each CLI command the
// GUI calls during boot — proving the JSON shape the frontend reads
// against is the shape the backend currently emits.
//
// What this catches that pure unit tests don't:
//   - index.html missing/renamed structural anchors (#hero-card, #checks,
//     #update-card, #accounts-body) that main.js depends on
//   - cli.ts subcommand outputs that drift from view-model expectations
//     (e.g. doctor JSON missing `checks.service` after the 4-state refactor)
//   - test-shim.ts itself breaking — it's the same harness Playwright tests
//     would run against, so its health is a prerequisite for any
//     interaction-level e2e
//
// What it deliberately doesn't cover:
//   - interactive flows (click, type) — those need Playwright/happy-dom and
//     belong to a heavier test suite. Tier 1 scope is structural smoke.

import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'

let shim: ChildProcess
const PORT = 4179  // dedicated port to avoid collision with `bun run shim` (4174)
const BASE = `http://localhost:${PORT}`

beforeAll(async () => {
  shim = spawn(
    'bun',
    [join(__dirname, 'test-shim.ts')],
    {
      env: {
        ...process.env,
        WECHAT_CC_DRY_RUN: '1',
        WECHAT_CC_SHIM_PORT: String(PORT),
      },
      stdio: 'pipe',
      detached: false,
    },
  )
  // Wait for the shim's "shim: http://..." banner before letting tests run.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('shim did not boot within 5s')), 5000)
    shim.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('shim: http://')) {
        clearTimeout(timer)
        resolve()
      }
    })
    shim.on('error', err => { clearTimeout(timer); reject(err) })
    shim.on('exit', code => {
      if (code !== 0 && code !== null) {
        clearTimeout(timer)
        reject(new Error(`shim exited early with code ${code}`))
      }
    })
  })
}, 15_000)

afterAll(() => {
  if (shim && !shim.killed) shim.kill('SIGTERM')
})

async function invoke(command: string, args?: string[]): Promise<unknown> {
  const res = await fetch(`${BASE}/__invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command, args: { args: args ?? [] } }),
  })
  const body = await res.json() as { result?: unknown; error?: string }
  if (body.error) throw new Error(body.error)
  return body.result
}

describe('apps/desktop shim — HTML structure', () => {
  it('serves index.html with the structural anchors main.js depends on', async () => {
    const res = await fetch(`${BASE}/`)
    expect(res.status).toBe(200)
    const html = await res.text()

    // Each of these IDs is read in apps/desktop/src/main.js. If any one is
    // renamed or removed, the GUI silently breaks at boot. Asserting their
    // presence here means a structural HTML regression fails CI fast
    // instead of surfacing as an empty wizard a user reports later.
    const requiredIds = [
      'checks',                      // wizard env-check list
      'hero-card', 'hero-headline',  // dashboard hero
      'accounts-body',               // bound-accounts table
      'config-table',                // configuration table
      'update-card', 'update-headline', 'update-body',  // update card
      'update-check-btn', 'update-apply-btn',           // update buttons
      'memory-sidebar', 'memory-rendered',              // memory pane
      'memory-editor', 'memory-status',                 // memory edit mode
      'memory-edit-btn', 'memory-save-btn', 'memory-cancel-btn',
      'dash-restart', 'dash-refresh',                   // dashboard actions
      'qr-box', 'qr-refresh', 'qr-poll',                // setup QR
      'service-install', 'service-stop',                // service controls
      'unattended-toggle', 'autostart-toggle',          // wizard toggles
      'enter-dashboard', 'continue-provider', 'continue-wechat', 'continue-service',
      'post-stop-alert', 'post-stop-pid', 'post-stop-kill',
      'dev-banner',
    ]
    for (const id of requiredIds) {
      expect(html, `missing id="${id}"`).toContain(`id="${id}"`)
    }
  })

  it('injects the Tauri shim polyfill (window.__WECHAT_CC_SHIM__)', async () => {
    const res = await fetch(`${BASE}/`)
    const html = await res.text()
    expect(html).toContain('window.__TAURI__')
    expect(html).toContain('window.__WECHAT_CC_SHIM__ = true')
    expect(html).toContain('window.__WECHAT_CC_DRY_RUN__ = true')
  })

  it('serves main.js + view.js + styles.css', async () => {
    const checks: Array<[string, string]> = [
      ['/main.js', 'text/javascript'],
      ['/view.js', 'text/javascript'],
      ['/styles.css', 'text/css'],
    ]
    for (const [path, ct] of checks) {
      const r = await fetch(`${BASE}${path}`)
      expect(r.status, `failed to serve ${path}`).toBe(200)
      expect(r.headers.get('content-type'), `wrong content-type for ${path}`).toContain(ct)
    }
  })
})

describe('apps/desktop shim — CLI invoke contracts', () => {
  it('doctor --json returns the shape main.js expects', async () => {
    const r = await invoke('wechat_cli_json', ['doctor', '--json']) as Record<string, any>
    expect(r).toMatchObject({
      ready: expect.any(Boolean),
      stateDir: expect.any(String),
      checks: expect.objectContaining({
        bun: expect.objectContaining({ ok: expect.any(Boolean) }),
        git: expect.objectContaining({ ok: expect.any(Boolean) }),
        claude: expect.objectContaining({ ok: expect.any(Boolean) }),
        codex: expect.objectContaining({ ok: expect.any(Boolean) }),
        accounts: expect.objectContaining({ count: expect.any(Number), items: expect.any(Array) }),
        access: expect.objectContaining({ ok: expect.any(Boolean) }),
        provider: expect.objectContaining({ provider: expect.any(String) }),
        daemon: expect.objectContaining({ alive: expect.any(Boolean) }),
        // service field added in v0.2.1 — main.js depends on it for restart
        // button decisions (restartButtonState reads checks.service.installed).
        service: expect.objectContaining({
          installed: expect.any(Boolean),
          kind: expect.stringMatching(/launchagent|systemd-user|scheduled-task/),
        }),
      }),
    })
  })

  it('provider show --json returns provider + dangerouslySkipPermissions', async () => {
    const r = await invoke('wechat_cli_json', ['provider', 'show', '--json']) as Record<string, any>
    expect(r).toMatchObject({
      provider: expect.stringMatching(/claude|codex/),
      dangerouslySkipPermissions: expect.any(Boolean),
    })
  })

  it('service status --json returns 4-state machine', async () => {
    const r = await invoke('wechat_cli_json', ['service', 'status', '--json']) as Record<string, any>
    expect(r).toMatchObject({
      installed: expect.any(Boolean),
      alive: expect.any(Boolean),
      state: expect.stringMatching(/missing|running|stale|stopped/),
    })
  })

  it('update --check --json returns either an UpdateProbe or not_a_git_repo', async () => {
    const r = await invoke('wechat_cli_json', ['update', '--check', '--json']) as Record<string, any>
    expect(r).toMatchObject({ mode: 'check', ok: expect.any(Boolean) })
    if (r.ok) {
      expect(r).toMatchObject({
        currentCommit: expect.any(String),
        latestCommit: expect.any(String),
        updateAvailable: expect.any(Boolean),
        behind: expect.any(Number),
      })
    } else {
      expect(r.reason).toMatch(/not_a_git_repo|fetch_failed|detached_head/)
    }
    // Generous timeout: this command shells out to `git fetch origin` against
    // the live remote. Healthy network finishes in <1s; under contention
    // (CI parallel fetches, slow link, or other vitest workers) it can spike
    // to 10s+. We're testing that the JSON SHAPE is right, not network speed.
  }, 30_000)

  it('memory list --json returns an array', async () => {
    const r = await invoke('wechat_cli_json', ['memory', 'list', '--json'])
    expect(Array.isArray(r)).toBe(true)
  })

  it('memory write --json returns ok:false with structured error on sandbox reject', async () => {
    // We can't safely write to the user's real ~/.claude/channels/wechat
    // memory dir from a test (would clobber actual notes), but we CAN
    // assert the sandbox error path: a base64'd body for a non-.md
    // extension MUST reject with `ok:false, error:<msg>` JSON. This locks
    // the contract main.js's memory-edit save handler depends on.
    const bodyB64 = Buffer.from('hello').toString('base64')
    const r = await invoke('wechat_cli_json', ['memory', 'write', 'fake@example', 'note.txt', '--body-base64', bodyB64, '--json']) as Record<string, unknown>
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/only \.md files/) })
  })

  it('rejects an unknown command with a helpful error', async () => {
    await expect(invoke('this_command_does_not_exist'))
      .rejects.toThrow(/unknown command/)
  })
})
