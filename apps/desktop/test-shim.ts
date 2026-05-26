#!/usr/bin/env bun
// Test/dev shim for the desktop installer's frontend (apps/desktop/src/*).
//
// Why this exists:
//   The bundled Tauri .app embeds frontend assets at compile time, so any
//   change to main.js/index.html/styles.css forces a 20s rebuild before it
//   shows up in the window. That's too slow for fast iteration and useless
//   in CI (which has no GUI to drive).
//
// What it does:
//   - Statically serves apps/desktop/src/*
//   - Injects a tiny <script> into index.html that polyfills
//     `window.__TAURI__.core.invoke` to POST /__invoke
//   - /__invoke spawns `bun cli.ts <args>` and returns the JSON result —
//     i.e. the same backend the real Tauri Rust shim calls
//   - render_qr_svg is stubbed (a placeholder div). Real QR rendering is
//     still verified via the bundled .app + Computer Use; the shim's job is
//     to exercise the frontend state machine cheaply.
//
// Recommended usage:
//   WECHAT_CC_DRY_RUN=1 WECHAT_CC_ROOT=/path/to/wechat-cc \
//     bun apps/desktop/test-shim.ts
//   open http://localhost:4174
//
// Pair with Playwright (WebKit channel) to drive the same flow we drive
// against the real .app, but in seconds and with DOM-aware selectors.

import { spawn } from 'bun'
import { join, resolve, relative, isAbsolute } from 'node:path'

const ROOT = process.env.WECHAT_CC_ROOT ?? join(import.meta.dir, '..', '..')
const SRC = join(import.meta.dir, 'src')
const PORT = Number(process.env.WECHAT_CC_SHIM_PORT ?? 4174)

const dryRun = process.env.WECHAT_CC_DRY_RUN === '1'

// ─── Playwright mock state ────────────────────────────────────────────────────
// Shared mutable bag for test-controlled data. Playwright tests seed this via
// POST /__invoke { command: "demo.seed" } before navigating to page features.
// Real-mode (dryRun=false) still hits the CLI — state is only consulted when
// DRY_RUN=1 AND the relevant field is non-empty (observations, milestones,
// sessions) or set (qrScanComplete, qrScanFails, envCheck).
type DaemonMode = { kind: string; provider?: string; primary?: string; secondary?: string; providers?: string[] }
type DaemonConversation = {
  chat_id: string
  user_id?: string | null
  account_id?: string | null
  user_name?: string | null
  mode: DaemonMode
}

// A2A agent shape stored in mock state.
type A2AAgent = {
  id: string
  name: string
  url: string
  paused: boolean
  counts: { inbound: number; outbound: number }
  inbound_api_key: string
}

// A2A activity event shape.
type A2AEvent = {
  agent_id: string
  direction: 'in' | 'out'
  text: string
  ts: string
  status: string
  http_status?: number
}

const __mockState: {
  chats: Array<{ id: string; name: string; last_active: number; mode?: { kind: string; provider?: string } }>
  // Mirrors src/cli/schema.ts::ObservationEntry / MilestoneEntry so the
  // dashboard renderer (observations.js) sees the same shape it would from
  // the real CLI. Earlier ad-hoc fields (triggered_at / label) silently
  // rendered nothing.
  observations: Array<{ id: string; ts: string; body: string; tone?: string; archived: boolean }>
  milestones: Array<{ id: string; ts: string; body: string; event_id?: string }>
  // Doctor-derived state — controllable via demo.seed args. Defaults
  // mirror the "everything healthy" path; tests that need to drive the
  // hero into "暂时失去连接" tone pass daemonAlive: false explicitly.
  daemonAlive: boolean
  sessions: Array<{ id: string; project: string; created_at: number; favorited: boolean }>
  qrScanComplete?: boolean
  qrScanFails?: boolean
  envCheck?: { binary_missing?: string }
  installProgress: { step: number; total: number; label: string; ts: number } | null
  installSimulationStep: number
  // dry-run mode keeps an in-memory mirror of the daemon's `conversations list`
  // shape so dropdown writes (mode set) stay consistent with subsequent
  // poller reads. Lazily seeded from the real CLI on first read.
  conversations: DaemonConversation[] | null
  // A2A mock state — seeded by `a2a.seed` test-control command.
  a2aAgents: A2AAgent[]
  a2aEvents: A2AEvent[]
} = { chats: [], observations: [], milestones: [], sessions: [], daemonAlive: true, installProgress: null, installSimulationStep: 0, conversations: null, a2aAgents: [], a2aEvents: [] }

// ─── A2A mock credentials ─────────────────────────────────────────────────────
// The A2A routes (/v1/a2a/*) are served by the SAME Bun.serve instance as the
// main shim (port 4174), avoiding cross-origin fetch restrictions in the
// Playwright browser. The daemon api-info intercept returns baseUrl pointing
// at the main shim, so api.js routes all fetch() calls through the same origin.
const A2A_TOKEN = 'fake-shim-token'
// A2A_BASE_URL is the main shim URL (resolved after PORT is known — used below
// in the daemon api-info intercept).

// Body served as /__tauri_polyfill.js so it works under CSP `script-src 'self'`
// (inline scripts are blocked when WECHAT_CC_INJECT_CSP=1). The injected
// reference in index.html toggles between inline <script>...</script> and
// <script src="/__tauri_polyfill.js"></script> depending on the env flag.
const POLYFILL_BODY = `
window.__TAURI__ = window.__TAURI__ ?? { core: {
  invoke: async (command, args) => {
    const r = await fetch("/__invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command, args })
    })
    const j = await r.json()
    if (j.error !== undefined) throw new Error(j.error)
    return j.result
  }
}}
window.__WECHAT_CC_SHIM__ = true
window.__WECHAT_CC_DRY_RUN__ = ${dryRun ? 'true' : 'false'}
`
const POLYFILL_INLINE = `<script>${POLYFILL_BODY}</script>`
const POLYFILL_EXTERNAL = `<script src="/__tauri_polyfill.js"></script>`

// When WECHAT_CC_INJECT_CSP=1, read the production CSP from tauri.conf.json
// and inject it as a <meta http-equiv> tag. Lets Playwright exercise the
// frontend under the same policy the bundled Tauri app enforces — without
// running Tauri itself. Inline scripts/styles that production allows via
// 'unsafe-inline' for styles still work; inline scripts fall back to the
// external polyfill above.
const injectCsp = process.env.WECHAT_CC_INJECT_CSP === '1'
let cspContent: string | null = null
if (injectCsp) {
  try {
    const conf = JSON.parse(
      require('node:fs').readFileSync(join(import.meta.dir, 'src-tauri', 'tauri.conf.json'), 'utf8'),
    ) as { app?: { security?: { csp?: string | null } } }
    cspContent = conf.app?.security?.csp ?? null
    if (!cspContent) console.warn('shim: WECHAT_CC_INJECT_CSP=1 but tauri.conf.json has csp: null')
  } catch (err) {
    console.warn('shim: failed to read CSP from tauri.conf.json:', err)
  }
}
const CSP_META = cspContent ? `<meta http-equiv="Content-Security-Policy" content="${cspContent}">` : ''

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = spawn(['bun', join(ROOT, 'cli.ts'), ...args], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  })
  const code = await proc.exited
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { stdout, stderr, code }
}

function placeholderQr(text: string): string {
  // Shim doesn't render real QR codes — that's verified via the bundled
  // .app where the Rust qrcode crate runs. Show the URL so the test can
  // still assert its presence.
  return `<div data-shim-qr-placeholder="true" style="padding:1em;border:1px dashed #999;font-family:ui-monospace,monospace;font-size:11px;word-break:break-all;background:#fafafa;">${text}</div>`
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  development: true,
  async fetch(req) {
    const url = new URL(req.url)

    // Local-file attachment endpoint — restricted to the wechat-cc
    // inbox tree so the dev shim doesn't double as an open file server.
    //
    // Path-guard rules: resolve the request to an absolute path first,
    // then verify it's a true descendant of an allowed root via
    // path.relative. Naive startsWith lets a sibling like `inbox-evil/`
    // bypass `inbox`, and `..` segments slip past entirely.
    if (url.pathname === '/attachment' && req.method === 'GET') {
      const requested = url.searchParams.get('path') || ''
      const inboxRoot = join(ROOT, 'apps', 'desktop')  // for tauri-localhost dev cache
      const stateInbox = (process.env.WECHAT_CC_STATE_DIR
        ?? join(process.env.HOME ?? '', '.claude', 'channels', 'wechat'))
      const allowedRoots = [
        join(stateInbox, 'inbox'),
        join(stateInbox, 'avatars'),  // custom avatars (Bundle E2.5)
        inboxRoot,
      ]
      const filePath = requested ? resolve(requested) : ''
      const insideRoot = (root: string) => {
        const rel = relative(root, filePath)
        return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
      }
      const ok = filePath && allowedRoots.some(insideRoot)
      if (!ok) return new Response('forbidden', { status: 403 })
      const file = Bun.file(filePath)
      if (!(await file.exists())) return new Response('not found', { status: 404 })
      return new Response(file)
    }

    if (url.pathname === '/__invoke' && req.method === 'POST') {
      const body = (await req.json()) as { command: string; args?: { args?: string[] } & Record<string, unknown> }
      try {
        // ── Playwright test-control commands ───────────────────────────────
        // These are shim-only commands that Playwright tests POST to seed mock
        // state or configure failure modes. They are NOT forwarded to the CLI.

        if (body.command === 'demo.unseed') {
          // Reset all mock state to "fresh install" — used by playwright
          // tests that need to assert the empty-state UI. Without an
          // explicit unseed the shim is worker-scoped, so any test that
          // ran `demo.seed` earlier in the worker leaves chats / obs /
          // milestones populated for subsequent tests (cross-test leak).
          __mockState.chats = []
          __mockState.observations = []
          __mockState.milestones = []
          __mockState.sessions = []
          __mockState.daemonAlive = true
          __mockState.qrScanComplete = undefined
          __mockState.qrScanFails = undefined
          __mockState.envCheck = undefined
          __mockState.installProgress = null
          __mockState.installSimulationStep = 0
          __mockState.conversations = null
          __mockState.a2aAgents = []
          __mockState.a2aEvents = []
          return Response.json({ result: { ok: true } })
        }

        if (body.command === 'demo.seed') {
          const args = body.args as {
            chat_id?: string
            daemonAlive?: boolean
            withSessions?: boolean
          } | undefined
          const chatId = args?.chat_id ?? 'test_chat'
          __mockState.daemonAlive = args?.daemonAlive ?? true
          __mockState.chats = [{ id: chatId, name: 'Test User', last_active: Date.now() }]
          // Shape matches src/cli/schema.ts::ObservationEntry — { id, ts,
          // body, tone?, archived }. Earlier shim used `triggered_at` /
          // `label` on milestones which didn't match the CLI schema or
          // the dashboard renderer (observationRow / milestoneCard read
          // .body + .ts); empty content rendered silently. Real schema
          // tested at the playwright level prevents that regression.
          const nowIso = new Date().toISOString()
          const yesterdayIso = new Date(Date.now() - 86_400_000).toISOString()
          const twoDaysAgoIso = new Date(Date.now() - 2 * 86_400_000).toISOString()
          const threeDaysAgoIso = new Date(Date.now() - 3 * 86_400_000).toISOString()
          __mockState.observations = [
            { id: 'obs_demo_1', ts: nowIso, body: 'demo observation 1', tone: 'playful', archived: false },
            { id: 'obs_demo_2', ts: nowIso, body: 'demo observation 2', tone: 'reflective', archived: false },
            { id: 'obs_demo_3', ts: nowIso, body: 'demo observation 3', tone: 'playful', archived: false },
            { id: 'obs_demo_4', ts: nowIso, body: 'demo observation 4', tone: 'reflective', archived: false },
            { id: 'obs_demo_5', ts: nowIso, body: 'demo observation 5', tone: 'playful', archived: false },
          ]
          // Shape matches src/cli/schema.ts::MilestoneEntry — { id, ts, body, event_id? }.
          __mockState.milestones = [
            { id: 'ms_demo_1', ts: yesterdayIso,    body: '100 messages' },
            { id: 'ms_demo_2', ts: twoDaysAgoIso,   body: '7-day streak' },
            { id: 'ms_demo_3', ts: threeDaysAgoIso, body: 'first push reply' },
          ]
          // Sessions are opt-in so playwright can exercise the empty-state
          // path while still having accounts bound (state.mode must reach
          // 'dashboard', which requires accounts).
          __mockState.sessions = args?.withSessions === false ? [] : [
            { id: 'sess_1', project: 'wechat-cc', created_at: Date.now(), favorited: false },
            { id: 'sess_2', project: 'compass', created_at: Date.now() - 3600000, favorited: false },
          ]
          // Reset QR + env-check state when re-seeding
          __mockState.qrScanComplete = false
          __mockState.qrScanFails = false
          __mockState.envCheck = undefined
          return Response.json({ ok: true, seeded: true })
        }

        if (body.command === 'test.set-env-check-state') {
          __mockState.envCheck = body.args as typeof __mockState.envCheck
          return Response.json({ ok: true })
        }

        if (body.command === 'test.fail-qr-scan') {
          __mockState.qrScanFails = true
          return Response.json({ ok: true })
        }

        // ── A2A test-control: seed agents + events ──────────────────────────
        // POST /__invoke { command: "a2a.seed", args: { agents: [...], events: [...] } }
        // Playwright A2A tests call this before navigating to the A2A pane.
        if (body.command === 'a2a.seed') {
          const args = body.args as {
            agents?: A2AAgent[]
            events?: A2AEvent[]
          } | undefined
          __mockState.a2aAgents = args?.agents ?? []
          __mockState.a2aEvents = args?.events ?? []
          return Response.json({ ok: true, seeded: true })
        }

        // ── A2A test-control: reset state ───────────────────────────────────
        if (body.command === 'a2a.reset') {
          __mockState.a2aAgents = []
          __mockState.a2aEvents = []
          return Response.json({ ok: true })
        }

        // ── Shim-native commands (not forwarded to CLI) ────────────────────
        if (body.command === 'wechat_cli_json' || body.command === 'wechat_cli_text') {
          const cliArgs = body.args?.args ?? []

          // Intercept daemon api-info in DRY_RUN — return fake credentials
          // pointing at the SAME shim origin so fetch() calls are same-origin
          // (avoids CORS issues in Playwright's Chromium context). The page
          // may be reached as either localhost:PORT or 127.0.0.1:PORT — echo
          // back the request's Host header so the baseUrl matches whichever
          // origin the browser actually loaded.
          // api.js calls this once to bootstrap all /v1/a2a/* fetch() calls.
          // Frontend calls: ["daemon", "api-info", "--json"]
          if (
            dryRun &&
            body.command === 'wechat_cli_json' &&
            cliArgs[0] === 'daemon' &&
            cliArgs[1] === 'api-info'
          ) {
            const host = req.headers.get('host') ?? `127.0.0.1:${PORT}`
            return Response.json({
              result: { ok: true, baseUrl: `http://${host}`, token: A2A_TOKEN },
            })
          }

          // Intercept observations list in DRY_RUN when demo data has been seeded.
          // Frontend calls: ["observations", "list", <chatId>, "--json"]
          if (
            dryRun &&
            body.command === 'wechat_cli_json' &&
            cliArgs[0] === 'observations' &&
            cliArgs[1] === 'list' &&
            __mockState.observations.length > 0
          ) {
            const visible = __mockState.observations.filter(o => !o.archived)
            return Response.json({ result: { observations: visible } })
          }

          // Intercept observations archive in DRY_RUN when demo data has been seeded.
          // Frontend calls: ["observations", "archive", <chatId>, <obsId>, "--json"]
          if (
            dryRun &&
            body.command === 'wechat_cli_json' &&
            cliArgs[0] === 'observations' &&
            cliArgs[1] === 'archive' &&
            __mockState.observations.length > 0
          ) {
            const obsId = cliArgs[3]  // ["observations", "archive", chatId, obsId, "--json"]
            if (obsId) {
              __mockState.observations = __mockState.observations.map(o =>
                o.id === obsId ? { ...o, archived: true } : o
              )
            }
            return Response.json({ result: { ok: true } })
          }

          // Intercept milestones list in DRY_RUN when demo data has been seeded.
          // Frontend calls: ["milestones", "list", <chatId>, "--json"]
          if (
            dryRun &&
            body.command === 'wechat_cli_json' &&
            cliArgs[0] === 'milestones' &&
            cliArgs[1] === 'list' &&
            __mockState.milestones.length > 0
          ) {
            return Response.json({ result: { milestones: __mockState.milestones } })
          }

          // Intercept doctor --json in DRY_RUN. Returns a minimal valid
          // DoctorOutput shape derived from __mockState.chats so playwright
          // tests can drive the dashboard's hero tone + accounts table
          // without depending on the dev machine's real CLI output. The
          // hero tone flips based on the chats length: seeded → daemon
          // "alive" + accounts.count=1 → "AI 正在陪伴中"; unseeded →
          // daemon dead + accounts.count=0 → "暂时失去连接".
          if (
            dryRun &&
            body.command === 'wechat_cli_json' &&
            cliArgs[0] === 'doctor'
          ) {
            const seeded = __mockState.chats.length > 0
            const chat = seeded ? __mockState.chats[0]! : null
            const userNames: Record<string, string> = chat ? { [chat.id]: chat.name } : {}
            const items = chat ? [{
              id: `${chat.id}-im-bot`,
              botId: chat.id,
              userId: chat.id,
              baseUrl: 'https://example.test',
            }] : []
            // daemon.alive is driven by __mockState.daemonAlive (default
            // true); separate from `seeded` so tests can drive the hero
            // into "暂时失去连接" tone while still booting into dashboard
            // mode (initialMode checks accounts + provider + service,
            // NOT daemon.alive).
            const daemonAlive = seeded && __mockState.daemonAlive
            return Response.json({
              result: {
                ready: seeded,
                stateDir: '/tmp/wechat-cc-shim',
                runtime: 'source',
                wslDetected: false,
                checks: {
                  bun: { ok: true, path: '/usr/local/bin/bun' },
                  git: { ok: true, path: '/usr/bin/git' },
                  claude: { ok: true, path: '/usr/local/bin/claude' },
                  codex: { ok: true, path: '/usr/local/bin/codex' },
                  cursor: { ok: false, apiKeySet: false, sdkInstalled: true },
                  accounts: { ok: true, count: items.length, items },
                  access: { ok: true, dmPolicy: 'allowlist', allowFromCount: items.length },
                  provider: {
                    ok: true,
                    provider: 'claude',
                    binaryPath: '/usr/local/bin/claude',
                  },
                  daemon: { alive: daemonAlive, pid: daemonAlive ? 12345 : null },
                  service: { installed: seeded, kind: 'launchagent' },
                },
                userNames,
                expiredBots: [],
                nextActions: [],
              },
            })
          }

          // Intercept memory list in DRY_RUN unconditionally — return seeded
          // shape when demo.seed has run, empty list otherwise. The
          // unconditional intercept is deliberate: without it the shim
          // falls through to the real CLI which reads the dev machine's
          // ~/.claude/channels/wechat/memory/ — leaking real user data into
          // playwright tests (a "no chats" assertion saw a real "GSR" user
          // and failed for environment-contaminated reasons, not real bugs).
          if (
            dryRun &&
            body.command === 'wechat_cli_json' &&
            cliArgs[0] === 'memory' &&
            cliArgs[1] === 'list'
          ) {
            if (__mockState.chats.length === 0) {
              return Response.json({ result: [] })
            }
            const chat = __mockState.chats[0]!
            return Response.json({
              result: [{
                userId: chat.id,
                fileCount: 1,
                files: [{ path: 'profile.md', size: 128, mtime: new Date().toISOString() }],
              }],
            })
          }

          // Intercept sessions list-projects in DRY_RUN unconditionally.
          // Frontend calls: ["sessions", "list-projects", "--json"].
          // Empty state when no sessions seeded (deliberately uncoupled
          // from chats to let playwright exercise the empty-state path
          // while still having accounts bound — without this the shim
          // would fall through to the real CLI and read the dev box's
          // ~/.claude/projects, leaking real project names into tests).
          if (
            dryRun &&
            body.command === 'wechat_cli_json' &&
            cliArgs[0] === 'sessions' &&
            cliArgs[1] === 'list-projects'
          ) {
            const projects = __mockState.sessions.map(s => ({
              alias: s.project,
              last_used_at: new Date(s.created_at).toISOString(),
              summary: null,
            }))
            return Response.json({ result: { projects } })
          }

          // Intercept setup --qr-json in DRY_RUN for QR auto-pass flow.
          // Frontend calls: ["setup", "--qr-json"]
          if (
            dryRun &&
            body.command === 'wechat_cli_json' &&
            cliArgs[0] === 'setup' &&
            cliArgs.includes('--qr-json')
          ) {
            if (__mockState.qrScanFails) {
              return Response.json({
                result: {
                  qrcode: 'mock-fail-qr',
                  qrcode_img_content: 'weixin://mock-fail-qr',
                  expires_in_ms: 480000,
                  error: '扫码失败',
                },
              })
            }
            // Success path: schedule auto-complete after 1s
            setTimeout(() => { __mockState.qrScanComplete = true }, 1000)
            return Response.json({
              result: {
                qrcode: 'mock-qr-token',
                qrcode_img_content: 'weixin://mock-qr',
                expires_in_ms: 480000,
              },
            })
          }

          // Intercept setup-poll in DRY_RUN for QR auto-pass flow.
          // Frontend calls: ["setup-poll", "--qrcode", <token>, "--json"]
          if (
            dryRun &&
            body.command === 'wechat_cli_json' &&
            cliArgs[0] === 'setup-poll'
          ) {
            if (__mockState.qrScanComplete) {
              return Response.json({ result: { status: 'confirmed', accountId: 'mock-bot', userId: 'mock-user', scenario: 'first' } })
            }
            return Response.json({ result: { status: 'wait' } })
          }

          // Intercept service install in DRY_RUN — kick off install-progress simulation.
          // Frontend calls: ["service", "install", "--json"]
          if (
            dryRun &&
            body.command === 'wechat_cli_json' &&
            cliArgs[0] === 'service' &&
            cliArgs[1] === 'install'
          ) {
            const progressSteps = [
              '写入服务定义文件',
              'systemctl daemon-reload',
              'systemctl enable',
              '启动 systemd 服务',
            ]
            __mockState.installSimulationStep = 0
            __mockState.installProgress = { step: 1, total: progressSteps.length, label: progressSteps[0]!, ts: Date.now() }
            // Clear progress after a grace period (service "finished")
            setTimeout(() => { __mockState.installProgress = null }, 3000)
            return Response.json({ result: { ok: true, action: 'install', dryRun: true } })
          }

          // Intercept install-progress in DRY_RUN — advance simulation on each poll.
          // Frontend calls: ["install-progress", "--json"]
          if (
            dryRun &&
            body.command === 'wechat_cli_json' &&
            cliArgs[0] === 'install-progress'
          ) {
            const progressSteps = [
              '写入服务定义文件',
              'systemctl daemon-reload',
              'systemctl enable',
              '启动 systemd 服务',
            ]
            if (!__mockState.installProgress) {
              return Response.json({ result: {} })
            }
            // Advance simulation step each poll
            __mockState.installSimulationStep += 1
            const nextStep = __mockState.installSimulationStep + 1  // steps are 1-indexed
            if (nextStep <= progressSteps.length) {
              __mockState.installProgress = {
                step: nextStep,
                total: progressSteps.length,
                label: progressSteps[nextStep - 1]!,
                ts: Date.now(),
              }
            }
            return Response.json({ result: { ...__mockState.installProgress } })
          }

          // Intercept conversations list in DRY_RUN. First call lazy-seeds
          // from the real daemon (so manual testers see real data); subsequent
          // calls return the in-memory mirror that mode set keeps updated.
          // Without this, dropdown clicks update __mockState but the next
          // 10s poll round-trips to the real daemon and renders stale data
          // — visible as "切了 codex 又切回 claude" revert.
          if (
            dryRun &&
            body.command === 'wechat_cli_json' &&
            cliArgs[0] === 'conversations' &&
            cliArgs[1] === 'list'
          ) {
            if (__mockState.conversations === null) {
              const r = await runCli(cliArgs)
              if (r.code !== 0) {
                __mockState.conversations = []
              } else {
                try {
                  const parsed = JSON.parse(r.stdout.trim()) as { conversations?: DaemonConversation[] }
                  __mockState.conversations = parsed.conversations ?? []
                } catch {
                  __mockState.conversations = []
                }
              }
            }
            return Response.json({ result: { ok: true, conversations: __mockState.conversations } })
          }

          // Intercept mode set in DRY_RUN — update the mirror so the next
          // conversations list read is consistent with this write.
          // Frontend calls: ["mode", "set", <chatId>, <mode>, "--json"]
          if (
            dryRun &&
            body.command === 'wechat_cli_json' &&
            cliArgs[0] === 'mode' &&
            cliArgs[1] === 'set'
          ) {
            const chatId = cliArgs[2]
            const modeArg = cliArgs[3]
            const SHORTHAND: Record<string, DaemonMode> = {
              cc:    { kind: 'solo', provider: 'claude' },
              codex: { kind: 'solo', provider: 'codex' },
              solo:  { kind: 'solo', provider: 'claude' },
              both:  { kind: 'parallel', providers: ['claude', 'codex'] },
              chat:  { kind: 'chatroom', providers: ['claude', 'codex'] },
            }
            const mode = modeArg ? (SHORTHAND[modeArg] ?? (() => { try { return JSON.parse(modeArg) as DaemonMode } catch { return null } })()) : null
            if (mode && chatId && __mockState.conversations) {
              __mockState.conversations = __mockState.conversations.map(c =>
                c.chat_id === chatId ? { ...c, mode } : c
              )
            }
            return Response.json({ result: { ok: true } })
          }

          const r = await runCli(cliArgs)
          if (r.code !== 0) return Response.json({ error: r.stderr.trim() || `cli exit ${r.code}` })
          const stdout = r.stdout.trim()
          const result = body.command === 'wechat_cli_json' ? JSON.parse(stdout) : stdout
          return Response.json({ result })
        }
        if (body.command === 'wechat_cli_json_via_file') {
          // Mirrors lib.rs's wechat_cli_json_via_file — appends --out-file <tmp>,
          // runs cli, reads + deletes the temp file, returns parsed JSON.
          // Without this branch the shim returns "unknown command" and any pane
          // that uses the via-file path (sessions detail, export markdown)
          // shows "读取失败：unknown command" instead of working.
          const cliArgs = body.args?.args ?? []

          // Intercept `logs --tail N --json` in DRY_RUN unconditionally —
          // the logs pane uses this via the via-file path. Without an
          // intercept the shim falls through to the real CLI which reads
          // the dev machine's actual channel.log, leaking real daemon
          // output into tests. Returns synthetic entries for the seeded
          // demo state; empty when unseeded.
          if (dryRun && cliArgs[0] === 'logs') {
            const tailIdx = cliArgs.indexOf('--tail')
            const tail = tailIdx >= 0 ? Number.parseInt(cliArgs[tailIdx + 1] ?? '50', 10) : 50
            const seeded = __mockState.chats.length > 0
            const baseEntries = seeded ? [
              { timestamp: new Date(Date.now() - 5_000).toISOString(), tag: 'BOOT', message: 'daemon started', raw: '[BOOT] daemon started' },
              { timestamp: new Date(Date.now() - 4_000).toISOString(), tag: 'INBOUND', message: 'received message from test_chat', raw: '[INBOUND] received message from test_chat' },
              { timestamp: new Date(Date.now() - 3_000).toISOString(), tag: 'SESSION_INIT', message: 'alias=_default provider=claude', raw: '[SESSION_INIT] alias=_default provider=claude' },
              { timestamp: new Date(Date.now() - 2_000).toISOString(), tag: 'TYPING', message: 'sent', raw: '[TYPING] sent' },
              { timestamp: new Date(Date.now() - 1_000).toISOString(), tag: 'REPLY', message: 'mocked reply dispatched', raw: '[REPLY] mocked reply dispatched' },
            ] : []
            const entries = baseEntries.slice(-tail)
            return Response.json({
              result: {
                ok: true,
                logFile: '/tmp/wechat-cc-shim/channel.log',
                totalLines: baseEntries.length,
                entries,
              },
            })
          }

          const tmp = join(process.env.TMPDIR ?? '/tmp', `wechat-cc-shim-${Date.now()}-${process.pid}.json`)
          const r = await runCli([...cliArgs, '--out-file', tmp])
          if (r.code !== 0) return Response.json({ error: r.stderr.trim() || `cli exit ${r.code}` })
          try {
            const body = await Bun.file(tmp).text()
            return Response.json({ result: JSON.parse(body) })
          } finally {
            try { await Bun.file(tmp).unlink?.() } catch {}
            try { (await import('node:fs')).unlinkSync(tmp) } catch {}
          }
        }
        if (body.command === 'save_text_file') {
          // Mirrors lib.rs's save_text_file — write to $HOME/Downloads/<basename>.
          const args = body.args as unknown as { filename?: string; content?: string }
          const filename = args?.filename ?? ''
          const content = args?.content ?? ''
          const home = process.env.HOME ?? ''
          if (!home) return Response.json({ error: 'HOME unset' })
          const fs = await import('node:fs')
          const downloads = join(home, 'Downloads')
          fs.mkdirSync(downloads, { recursive: true })
          const basename = filename.split(/[\\/]/).pop() || ''
          if (!basename || basename === '.' || basename === '..') {
            return Response.json({ error: `illegal filename: ${filename}` })
          }
          const target = join(downloads, basename)
          fs.writeFileSync(target, content)
          return Response.json({ result: target })
        }
        if (body.command === 'render_qr_svg') {
          const text = (body.args as { text?: string } | undefined)?.text ?? ''
          return Response.json({ result: placeholderQr(text) })
        }
        return Response.json({ error: `unknown command: ${body.command}` })
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) })
      }
    }

    // ── A2A internal-API routes (DRY_RUN) ─────────────────────────────────────
    // These routes mirror the daemon's /v1/a2a/* HTTP endpoints. They live on
    // the SAME origin as the main shim (port 4174) so api.js fetch() calls are
    // same-origin and never blocked by Chromium's CORS policy.
    // The `daemon api-info` intercept above returns baseUrl=http://127.0.0.1:PORT
    // and token=A2A_TOKEN, so api.js routes all fetch() here.
    if (dryRun && url.pathname.startsWith('/v1/a2a/')) {
      const authHeader = req.headers.get('authorization') ?? ''
      if (authHeader !== `Bearer ${A2A_TOKEN}`) {
        return Response.json({ error: 'unauthorized' }, { status: 401 })
      }

      // GET /v1/a2a/list
      if (url.pathname === '/v1/a2a/list' && req.method === 'GET') {
        return Response.json({ agents: __mockState.a2aAgents })
      }

      // GET /v1/a2a/info
      if (url.pathname === '/v1/a2a/info' && req.method === 'GET') {
        return Response.json({ base_url: `http://127.0.0.1:${PORT}`, token: A2A_TOKEN })
      }

      // POST /v1/a2a/preview — return synthetic agent card (no outbound network)
      if (url.pathname === '/v1/a2a/preview' && req.method === 'POST') {
        const body2 = (await req.json()) as { url?: string }
        return Response.json({
          name: 'Fake Agent',
          description: 'A fake agent for testing',
          capabilities: [{ name: 'chat', description: 'Basic chat' }],
          url: body2?.url ?? 'https://fake.example.com/a2a',
        })
      }

      // POST /v1/a2a/install
      if (url.pathname === '/v1/a2a/install' && req.method === 'POST') {
        const body2 = (await req.json()) as { id?: string; name?: string; url?: string; outbound_api_key?: string }
        const id = body2?.id ?? 'unknown'
        const name = body2?.name ?? id
        const agentUrl = body2?.url ?? ''
        const inbound_api_key = `wc_${id}_${Math.random().toString(36).slice(2, 10)}`
        const agent: A2AAgent = {
          id,
          name,
          url: agentUrl,
          paused: false,
          counts: { inbound: 0, outbound: 0 },
          inbound_api_key,
        }
        __mockState.a2aAgents = __mockState.a2aAgents.filter(a => a.id !== id)
        __mockState.a2aAgents.push(agent)
        return Response.json({ ok: true, inbound_api_key })
      }

      // POST /v1/a2a/pause
      if (url.pathname === '/v1/a2a/pause' && req.method === 'POST') {
        const body2 = (await req.json()) as { id?: string; paused?: boolean }
        const id = body2?.id
        const paused = body2?.paused ?? true
        __mockState.a2aAgents = __mockState.a2aAgents.map(a =>
          a.id === id ? { ...a, paused } : a
        )
        return Response.json({ ok: true })
      }

      // POST /v1/a2a/remove
      if (url.pathname === '/v1/a2a/remove' && req.method === 'POST') {
        const body2 = (await req.json()) as { id?: string }
        const id = body2?.id
        __mockState.a2aAgents = __mockState.a2aAgents.filter(a => a.id !== id)
        __mockState.a2aEvents = __mockState.a2aEvents.filter(e => e.agent_id !== id)
        return Response.json({ ok: true })
      }

      // GET /v1/a2a/activity?agent_id=...&limit=...
      if (url.pathname === '/v1/a2a/activity' && req.method === 'GET') {
        const agentId = url.searchParams.get('agent_id') ?? ''
        const limit = Number(url.searchParams.get('limit') ?? '50')
        const events = __mockState.a2aEvents
          .filter(e => e.agent_id === agentId)
          .slice(-limit)
        return Response.json({ events })
      }

      // POST /v1/a2a/test — synthetic smoke from dashboard. We don't actually
      // do network here; just return a deterministic happy-path response so
      // playwright can verify the UI flow + bump the counts.
      if (url.pathname === '/v1/a2a/test' && req.method === 'POST') {
        const body2 = (await req.json()) as { agent_id?: string; text?: string; outbound?: boolean }
        const id = body2?.agent_id ?? ''
        const text = body2?.text ?? ''
        const outbound = body2?.outbound === true
        const agent = __mockState.a2aAgents.find(a => a.id === id)
        if (!agent) {
          return Response.json({ ok: false, direction: outbound ? 'out' : 'in', error: 'unknown_agent' })
        }
        // Record a synthetic event + bump the count.
        __mockState.a2aEvents.push({
          ts: new Date().toISOString(),
          agent_id: id, text,
          direction: outbound ? 'out' : 'in',
          status: 'ok',
        })
        if (outbound) agent.counts.outbound += 1
        else agent.counts.inbound += 1
        return Response.json({ ok: true, direction: outbound ? 'out' : 'in', http_status: 200 })
      }

      return Response.json({ error: 'a2a route not found' }, { status: 404 })
    }

    const path = url.pathname === '/' ? '/index.html' : url.pathname

    if (path === '/__tauri_polyfill.js') {
      return new Response(POLYFILL_BODY, {
        headers: { 'content-type': 'text/javascript; charset=utf-8' },
      })
    }

    const file = Bun.file(join(SRC, path))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    if (path === '/index.html') {
      const html = await file.text()
      const polyfillTag = injectCsp ? POLYFILL_EXTERNAL : POLYFILL_INLINE
      const injection = `${CSP_META}\n${polyfillTag}\n</head>`
      return new Response(html.replace('</head>', injection), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
    const ext = path.slice(path.lastIndexOf('.'))
    const ct = CONTENT_TYPES[ext]
    return new Response(file, ct ? { headers: { 'content-type': ct } } : undefined)
  },
})

console.log(`shim: http://localhost:${PORT}  root=${ROOT}  dry-run=${dryRun ? 'on' : 'off'}`)
if (!dryRun) {
  console.log('  ⚠️  WECHAT_CC_DRY_RUN is off — service install/uninstall will hit launchctl.')
  console.log('     For safe e2e, prefix with `WECHAT_CC_DRY_RUN=1`.')
}
