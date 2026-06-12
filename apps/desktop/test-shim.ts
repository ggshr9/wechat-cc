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

// Dialogue mock message shape (mirrors the CLI's Message type).
type DialogueMessage = {
  id: string
  chatId: string
  ts: string
  direction: 'in' | 'out'
  kind: string
  text: string
  provider?: string
  source: string
}

// Dialogue mock thread shape (mirrors the CLI's Thread type).
type DialogueThread = {
  id: string
  chatId: string
  title: string
  summary: string
  facets: string[]
  tags: string[]
  private: boolean
  status: 'active' | 'dormant' | 'done'
  episodes: Array<{ from_ts: string; to_ts: string }>
  createdTs: string
  lastActive: string
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
  sessions: Array<{ id: string; project: string; created_at: number; favorited: boolean; chat_id?: string }>
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
  // Reconnect-diagnose test support:
  //   doctorOverride: when set, doctor --json returns this verbatim instead
  //                   of the __mockState-derived shape. Lets tests inject
  //                   specific DoctorReport shapes to drive diagnose() codes.
  //   serviceInvokes: records ['service stop', 'service start', 'kill-residual']
  //                   calls so Playwright tests can assert restart chains fired.
  //   healthProbeResult: return value for wechat_health_ping invocations.
  //                      Defaults true (daemon healthy). Set to false via
  //                      `mock.health-probe` to simulate probe failure.
  doctorOverride: object | null
  //   doctorErrorOnce: when truthy, the NEXT doctor --json call returns an
  //                    error (causing invoke() to throw, setting lastError).
  //                    Cleared automatically after firing — one-shot.
  doctorErrorOnce: boolean
  serviceInvokes: string[]
  healthProbeResult: boolean
  //   logCalls: records every `wechat_cli_json` call with args[0]==='log'
  //             so Playwright tests can assert RECONNECT_DIAGNOSE telemetry fired.
  logCalls: Array<{ tag: string; msg: string; fields: Record<string, unknown> | null }>
  //   providerInvokes: records `provider set <name>` calls from the provider
  //                   dropdown so Playwright tests can assert switching fired.
  providerInvokes: Array<{ provider: string; ts: number }>
  // Dialogue mock state — seeded by demo.seed (always populated when chats
  // are seeded). Provides realistic timeline + facet-thread data so dialogue-page
  // specs don't need to hit the real SQLite DB.
  dialogueMessages: DialogueMessage[]
  dialogueThreads: DialogueThread[]
  // Privacy-unlock passphrase for dialogue unlock mock. When set, the
  // dialogue unlock intercept validates against this value.
  dialoguePassphrase: string
  dialogueUnlocked: boolean
} = { chats: [], observations: [], milestones: [], sessions: [], daemonAlive: true, installProgress: null, installSimulationStep: 0, conversations: null, a2aAgents: [], a2aEvents: [], doctorOverride: null, doctorErrorOnce: false, serviceInvokes: [], healthProbeResult: true, logCalls: [], providerInvokes: [], dialogueMessages: [], dialogueThreads: [], dialoguePassphrase: '1234', dialogueUnlocked: false }

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
}, window: {
  getCurrentWindow: () => ({ startDragging: async () => {} })
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
          __mockState.doctorOverride = null
          __mockState.doctorErrorOnce = false
          __mockState.serviceInvokes = []
          __mockState.healthProbeResult = true
          __mockState.logCalls = []
          __mockState.providerInvokes = []
          __mockState.dialogueMessages = []
          __mockState.dialogueThreads = []
          __mockState.dialogueUnlocked = false
          return Response.json({ result: { ok: true } })
        }

        // ── Reconnect-diagnose test-control commands ────────────────────────
        // mock.doctor: inject a verbatim DoctorReport that the next
        //   doctor --json poll returns. Lets reconnect-diagnose tests drive
        //   specific diagnosis codes (1, 4, 5, 0) without depending on
        //   the implicit __mockState.chats / daemonAlive shape.
        if (body.command === 'mock.doctor') {
          __mockState.doctorOverride = (body.args as { report?: object } | undefined)?.report ?? null
          return Response.json({ result: { ok: true } })
        }

        // mock.reset-service-invokes: clear the recorded service call log.
        // Call before triggering an action you want to observe, then read
        // back with mock.get-service-invokes.
        if (body.command === 'mock.reset-service-invokes') {
          __mockState.serviceInvokes = []
          return Response.json({ result: { ok: true } })
        }

        // mock.get-service-invokes: return the list of service calls recorded
        // since the last reset. Used to assert restart chains fired.
        if (body.command === 'mock.get-service-invokes') {
          return Response.json({ result: { invokes: __mockState.serviceInvokes } })
        }

        // mock.get-log-calls: return the list of `wechat_cli_json log` calls
        // recorded in DRY_RUN mode. Used by Playwright tests to assert
        // RECONNECT_DIAGNOSE telemetry fired after a reconnect click.
        if (body.command === 'mock.get-log-calls') {
          return Response.json({ result: { calls: __mockState.logCalls } })
        }

        // mock.get-provider-invokes: return the list of `provider set <name>`
        // calls recorded since the last demo.seed / demo.unseed. Used by
        // Playwright tests to assert the provider-switch dropdown fired.
        if (body.command === 'mock.get-provider-invokes') {
          return Response.json({ result: { invokes: __mockState.providerInvokes } })
        }

        // mock.health-probe: set the return value for wechat_health_ping.
        // Pass { result: true } to simulate a healthy daemon, { result: false }
        // to simulate probe failure (daemon not responding).
        if (body.command === 'mock.health-probe') {
          const r = body.args as { result?: boolean } | undefined
          __mockState.healthProbeResult = r?.result !== false
          return Response.json({ result: { ok: true } })
        }

        // mock.doctor-error: make the NEXT doctor --json call throw (one-shot).
        // This populates doctorPoller.lastError so restartDaemon sees a non-null
        // lastError when it calls refresh(). Used to drive code-7 tests.
        if (body.command === 'mock.doctor-error') {
          __mockState.doctorErrorOnce = true
          return Response.json({ result: { ok: true } })
        }

        if (body.command === 'demo.seed') {
          const args = body.args as {
            chat_id?: string
            daemonAlive?: boolean
            withSessions?: boolean
            oneContact?: boolean
          } | undefined
          const chatId = args?.chat_id ?? 'test_chat'
          __mockState.daemonAlive = args?.daemonAlive ?? true
          __mockState.chats = [{ id: chatId, name: 'Test User', last_active: Date.now() }]
          // Seeding = known state. The shim process outlives individual
          // playwright tests, so per-test mutations (dialogue.set-no-lock's
          // sentinel passphrase, a prior unlock) must not leak into the next
          // test's boot — restore the dialogue lock defaults here.
          __mockState.dialoguePassphrase = '1234'
          __mockState.dialogueUnlocked = false
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
          __mockState.sessions = args?.withSessions === false ? [] : (args?.oneContact ? [
            { id: 'sess_1', project: 'wechat-cc', created_at: Date.now(),           favorited: false, chat_id: 'chatA@im.wechat' },
            { id: 'sess_2', project: 'compass',   created_at: Date.now() - 3600000, favorited: false, chat_id: 'chatA@im.wechat' },
          ] : [
            { id: 'sess_1', project: 'wechat-cc', created_at: Date.now(),           favorited: false, chat_id: 'chatA@im.wechat' },
            { id: 'sess_2', project: 'compass',   created_at: Date.now() - 3600000, favorited: false, chat_id: 'chatA@im.wechat' },
            { id: 'sess_3', project: 'blog',      created_at: Date.now() - 7200000, favorited: false, chat_id: 'chatB@im.wechat' },
          ])
          // Seed dialogue mock data — used by dialogue-page specs. These mirror
          // the real daemon's `dialogue timeline` / `dialogue threads` output so
          // dialogue-page.js has something to render in DRY_RUN without a real
          // SQLite DB. Seeded unconditionally when chats are present so all
          // "open 对话 pane" tests see a populated timeline by default.
          // (chatId is already declared above as `args?.chat_id ?? 'test_chat'`)
          __mockState.dialogueMessages = [
            { id: 'msg_1', chatId, ts: new Date(Date.now() - 3_600_000).toISOString(), direction: 'in',  kind: 'text', text: '介绍一下 AI FDE 这个岗位', source: 'wechat' },
            { id: 'msg_2', chatId, ts: new Date(Date.now() - 3_500_000).toISOString(), direction: 'out', kind: 'text', text: 'AI FDE（AI Field Detection Engineer）是…', source: 'daemon', provider: 'claude' },
            { id: 'msg_3', chatId, ts: new Date(Date.now() - 3_400_000).toISOString(), direction: 'in',  kind: 'text', text: '有什么技能要求？', source: 'wechat' },
            { id: 'msg_4', chatId, ts: new Date(Date.now() - 3_300_000).toISOString(), direction: 'out', kind: 'text', text: '主要需要 Python、SQL、机器学习基础…', source: 'daemon', provider: 'claude' },
            { id: 'msg_5', chatId, ts: new Date(Date.now() - 600_000).toISOString(), direction: 'in',  kind: 'text', text: '今天天气怎么样？', source: 'wechat' },
            { id: 'msg_6', chatId, ts: new Date(Date.now() - 580_000).toISOString(), direction: 'out', kind: 'text', text: '今天是晴天，温度 25°C。', source: 'daemon', provider: 'claude' },
          ]
          // Threads for facet views (knowledge/task/life). Private threads
          // (stories/emotions) test the privacy-lock affordance.
          __mockState.dialogueThreads = [
            {
              id: 'thread_career', chatId, title: 'AI FDE 岗位研究', summary: '了解 AI FDE 岗位要求',
              facets: ['knowledge'], tags: ['figma插件skill', 'UI设计', '设计规范'], private: false,
              status: 'done', episodes: [{ from_ts: new Date(Date.now() - 3_600_000).toISOString(), to_ts: new Date(Date.now() - 3_300_000).toISOString() }],
              createdTs: new Date(Date.now() - 3_600_000).toISOString(), lastActive: new Date(Date.now() - 3_300_000).toISOString(),
            },
            {
              id: 'thread_design', chatId, title: '设计规范讨论', summary: '关于 UI 设计规范的讨论',
              facets: ['knowledge'], tags: ['UI设计'], private: false,
              status: 'active', episodes: [], createdTs: new Date(Date.now() - 7_200_000).toISOString(),
              lastActive: new Date(Date.now() - 7_000_000).toISOString(),
            },
            {
              id: 'thread_figma', chatId, title: 'Figma 插件开发', summary: 'Figma 插件技能学习',
              facets: ['knowledge'], tags: [], private: false,
              status: 'dormant', episodes: [], createdTs: new Date(Date.now() - 14_400_000).toISOString(),
              lastActive: new Date(Date.now() - 14_000_000).toISOString(),
            },
            {
              id: 'thread_weather', chatId, title: '今日天气', summary: '今天天气相关对话',
              facets: ['life'], tags: [], private: false,
              status: 'done', episodes: [{ from_ts: new Date(Date.now() - 600_000).toISOString(), to_ts: new Date(Date.now() - 580_000).toISOString() }],
              createdTs: new Date(Date.now() - 600_000).toISOString(), lastActive: new Date(Date.now() - 580_000).toISOString(),
            },
            {
              id: 'thread_stories', chatId, title: '和花艺师闺蜜的周末', summary: '私密周末故事',
              facets: ['life'], tags: [], private: true,
              status: 'done', episodes: [], createdTs: new Date(Date.now() - 86_400_000).toISOString(),
              lastActive: new Date(Date.now() - 86_000_000).toISOString(),
            },
            {
              id: 'thread_emotions', chatId, title: '糟糕的心情', summary: '私密情绪记录',
              facets: ['life'], tags: [], private: true,
              status: 'done', episodes: [], createdTs: new Date(Date.now() - 172_800_000).toISOString(),
              lastActive: new Date(Date.now() - 172_000_000).toISOString(),
            },
          ]
          __mockState.dialogueUnlocked = false
          // Reset QR + env-check state when re-seeding
          __mockState.qrScanComplete = false
          __mockState.qrScanFails = false
          __mockState.envCheck = undefined
          // Reset reconnect-diagnose test state so prior test runs don't
          // contaminate subsequent ones (doctorOverride / error flags / invokes).
          __mockState.doctorOverride = null
          __mockState.doctorErrorOnce = false
          __mockState.serviceInvokes = []
          __mockState.logCalls = []
          __mockState.providerInvokes = []
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

        // ── Dialogue test-control commands ─────────────────────────────────
        // dialogue.seed-messages: replace __mockState.dialogueMessages with a
        // synthetic set of `count` messages. Used by dialogue-timeline.spec.ts
        // to test upward paging (needs >100 messages so hasMore=true).
        if (body.command === 'dialogue.seed-messages') {
          const a = body.args as { count?: number; chat_id?: string } | undefined
          const count = a?.count ?? 100
          const cid = a?.chat_id ?? (__mockState.chats[0]?.id ?? 'test_chat')
          const msgs: typeof __mockState.dialogueMessages = []
          for (let i = 0; i < count; i++) {
            const ts = new Date(Date.now() - (count - i) * 60_000).toISOString()
            msgs.push({
              id: `page_msg_${i}`,
              chatId: cid,
              ts,
              direction: i % 2 === 0 ? 'in' : 'out',
              kind: 'text',
              text: i % 2 === 0 ? `用户消息 ${i + 1}` : `AI 回复 ${i + 1}`,
              source: i % 2 === 0 ? 'wechat' : 'daemon',
              provider: i % 2 === 0 ? undefined : 'claude',
            })
          }
          __mockState.dialogueMessages = msgs
          return Response.json({ result: { ok: true, count } })
        }

        // dialogue.set-no-lock: configure the unlock mock to return
        // no_lock_configured on the next unlock call, regardless of passphrase.
        // Used by dialogue-timeline.spec.ts to test the "no lock configured"
        // path where the lock affordance should be hidden after any attempt.
        if (body.command === 'dialogue.set-no-lock') {
          __mockState.dialoguePassphrase = '\x00no_lock'  // sentinel: never matches any real passphrase
          return Response.json({ result: { ok: true } })
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

          // Record service stop / service start / kill-residual calls.
          // Used by reconnect-diagnose Playwright tests to assert that the
          // restart chain fired after clicking the card's primary button.
          if (
            dryRun &&
            body.command === 'wechat_cli_json' &&
            cliArgs[0] === 'service' &&
            (cliArgs[1] === 'stop' || cliArgs[1] === 'start')
          ) {
            __mockState.serviceInvokes.push(`service ${cliArgs[1]}`)
            return Response.json({ result: { ok: true } })
          }
          if (
            dryRun &&
            body.command === 'wechat_cli_json' &&
            cliArgs[0] === 'daemon' &&
            cliArgs[1] === 'kill-residual'
          ) {
            __mockState.serviceInvokes.push('kill-residual')
            return Response.json({ result: { ok: true } })
          }

          // Intercept `log` calls in DRY_RUN — record in __mockState.logCalls
          // so Playwright tests can assert RECONNECT_DIAGNOSE telemetry fired.
          // Frontend calls: ["log", <tag>, <msg>, "--fields", <json>, "--json"]
          if (
            dryRun &&
            body.command === 'wechat_cli_json' &&
            cliArgs[0] === 'log'
          ) {
            const tag = cliArgs[1] ?? ''
            const msg = cliArgs[2] ?? ''
            // --fields is the arg after the "--fields" flag
            const flagIdx = cliArgs.indexOf('--fields')
            let fields: Record<string, unknown> | null = null
            const fieldsRaw = flagIdx !== -1 ? cliArgs[flagIdx + 1] : undefined
            if (fieldsRaw) {
              try { fields = JSON.parse(fieldsRaw) } catch {}
            }
            __mockState.logCalls.push({ tag, msg, fields })
            return Response.json({ result: { ok: true } })
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
            // doctorErrorOnce: one-shot error injection so lastError gets set.
            // Cleared immediately after firing; next poll returns normally.
            if (__mockState.doctorErrorOnce) {
              __mockState.doctorErrorOnce = false
              return Response.json({ error: 'simulated doctor poll error' })
            }
            // If a doctorOverride is set (by mock.doctor test-control),
            // return it verbatim so reconnect-diagnose tests can inject
            // specific DoctorReport shapes to drive diagnosis codes.
            if (__mockState.doctorOverride !== null) {
              return Response.json({ result: __mockState.doctorOverride })
            }
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
                  daemon: {
                    alive: daemonAlive,
                    pid: daemonAlive ? 12345 : null,
                    // Fake internal_api so health-probe tests can call
                    // wechat_health_ping (shim ignores the actual values).
                    ...(daemonAlive ? { internal_api: { port: 9999, token_file_path: '/tmp/fake-shim-token' } } : {}),
                  },
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
            const chatIdx = cliArgs.indexOf('--chat')
            const chatFilter = chatIdx >= 0 ? cliArgs[chatIdx + 1] : null
            const projects = __mockState.sessions
              .filter(s => !chatFilter || (s.chat_id || '_legacy') === chatFilter)
              .map(s => ({
                alias: s.project,
                session_id: `sess-${s.id}`,
                last_used_at: new Date(s.created_at).toISOString(),
                summary: null,
                summary_updated_at: null,
              }))
            return Response.json({ result: { projects } })
          }

          // sessions delete <alias> [--chat C] --json — used by the settings
          // drawer 项目管理 list. Drop the matching session(s) from mock state.
          if (
            dryRun &&
            body.command === 'wechat_cli_json' &&
            cliArgs[0] === 'sessions' &&
            cliArgs[1] === 'delete'
          ) {
            const alias = cliArgs[2]
            const before = __mockState.sessions.length
            __mockState.sessions = __mockState.sessions.filter(s => s.project !== alias)
            return Response.json({ result: { ok: true, deleted: before - __mockState.sessions.length } })
          }

          if (
            dryRun &&
            body.command === 'wechat_cli_json' &&
            cliArgs[0] === 'sessions' &&
            cliArgs[1] === 'list-chats'
          ) {
            const names: Record<string, string> = { 'chatA@im.wechat': '小白', 'chatB@im.wechat': '小明' }
            const byChat = new Map<string, { aliases: Set<string>; last: number }>()
            for (const s of __mockState.sessions) {
              const id = s.chat_id || '_legacy'
              const g = byChat.get(id) ?? { aliases: new Set<string>(), last: 0 }
              g.aliases.add(s.project)
              if (s.created_at > g.last) g.last = s.created_at
              byChat.set(id, g)
            }
            // When no sessions were seeded (e.g. dialogue-page tests that
            // call demo.seed with chat_id but not withSessions), fall back to
            // building the chat list from __mockState.chats so the dialogue
            // chat-switcher still has something to show.
            if (byChat.size === 0 && __mockState.chats.length > 0) {
              for (const c of __mockState.chats) {
                byChat.set(c.id, { aliases: new Set(['_default']), last: c.last_active })
                names[c.id] = c.name
              }
            }
            const chats = [...byChat.entries()]
              .map(([chat_id, g]) => ({ chat_id, user_name: names[chat_id] ?? null, account_id: 'bot1', session_count: g.aliases.size, last_used_at: new Date(g.last).toISOString() }))
              .sort((a, b) => Date.parse(b.last_used_at) - Date.parse(a.last_used_at))
            return Response.json({ result: { ok: true, chats } })
          }

          // ── Dialogue namespace interceptors (DRY_RUN) ─────────────────────
          // dialogue-page.js calls these to populate the 对话 pane without a
          // real SQLite DB. All intercepts are unconditional in DRY_RUN so the
          // page never falls through to the actual CLI (which would fail or leak
          // real data in CI).
          //
          // dialogue timeline --chat-id X --limit N [--before T] --json
          if (
            dryRun &&
            body.command === 'wechat_cli_json' &&
            cliArgs[0] === 'dialogue' &&
            cliArgs[1] === 'timeline'
          ) {
            const PAGE = 100
            const beforeTs = cliArgs.includes('--before') ? cliArgs[cliArgs.indexOf('--before') + 1] : null
            let msgs = __mockState.dialogueMessages
            if (beforeTs) {
              msgs = msgs.filter(m => m.ts < beforeTs)
            }
            const limitIdx = cliArgs.indexOf('--limit')
            const limit = limitIdx >= 0 ? Number.parseInt(cliArgs[limitIdx + 1] ?? String(PAGE), 10) : PAGE
            const slice = msgs.slice(-limit)
            const hasMore = msgs.length > limit
            return Response.json({ result: { messages: slice, hasMore } })
          }

          // dialogue threads --chat-id X --facet F [--include-private] --json
          if (
            dryRun &&
            body.command === 'wechat_cli_json' &&
            cliArgs[0] === 'dialogue' &&
            cliArgs[1] === 'threads'
          ) {
            const facetIdx = cliArgs.indexOf('--facet')
            const facet = facetIdx >= 0 ? cliArgs[facetIdx + 1] : null
            // The CLIENT flag is authoritative — dialogue-page.js only sends
            // --include-private while it considers the session unlocked, and
            // drops it again on re-lock. (Don't OR in __mockState.dialogueUnlocked:
            // that would leak private threads after the user re-locks.)
            const includePrivate = cliArgs.includes('--include-private')
            let threads = __mockState.dialogueThreads
            if (facet) threads = threads.filter(t => t.facets.includes(facet))
            if (!includePrivate) threads = threads.filter(t => !t.private)
            return Response.json({ result: { threads } })
          }

          // dialogue thread-detail <id> --json
          if (
            dryRun &&
            body.command === 'wechat_cli_json' &&
            cliArgs[0] === 'dialogue' &&
            cliArgs[1] === 'thread-detail'
          ) {
            const threadId = cliArgs[2]
            const thread = __mockState.dialogueThreads.find(t => t.id === threadId)
            if (!thread) return Response.json({ result: { ok: false, error: 'not_found' } })
            // Build episodes from the thread's episode ranges + matching msgs.
            const episodes = thread.episodes.map((ep, i) => ({
              from_ts: ep.from_ts,
              to_ts: ep.to_ts,
              messages: __mockState.dialogueMessages.filter(m => m.ts >= ep.from_ts && m.ts <= ep.to_ts),
            }))
            return Response.json({ result: { thread, episodes } })
          }

          // dialogue search --chat-id X <query> --json
          if (
            dryRun &&
            body.command === 'wechat_cli_json' &&
            cliArgs[0] === 'dialogue' &&
            cliArgs[1] === 'search'
          ) {
            // query is the 3rd positional arg (after --chat-id X which is flags)
            const chatIdIdx = cliArgs.indexOf('--chat-id')
            // collect remaining non-flag tokens as the query
            const flags = new Set(['--chat-id', '--json', cliArgs[chatIdIdx + 1] ?? ''])
            const query = cliArgs.filter(a => !a.startsWith('--') && !flags.has(a) && a !== 'dialogue' && a !== 'search').join(' ').toLowerCase().trim()
            const hits = query.length >= 2
              ? __mockState.dialogueMessages.filter(m => m.text.toLowerCase().includes(query))
              : []
            return Response.json({ result: { hits } })
          }

          // dialogue unlock --passphrase P --json
          if (
            dryRun &&
            body.command === 'wechat_cli_json' &&
            cliArgs[0] === 'dialogue' &&
            cliArgs[1] === 'unlock'
          ) {
            const ppIdx = cliArgs.indexOf('--passphrase')
            const passphrase = ppIdx >= 0 ? cliArgs[ppIdx + 1] : ''
            // Sentinel '\x00no_lock' means the lock is not configured — return
            // no_lock_configured so dialogue-page hides the lock affordance.
            if (__mockState.dialoguePassphrase === '\x00no_lock') {
              return Response.json({ result: { ok: false, error: 'no_lock_configured' } })
            }
            if (passphrase === __mockState.dialoguePassphrase) {
              __mockState.dialogueUnlocked = true
              return Response.json({ result: { ok: true } })
            }
            return Response.json({ result: { ok: false, error: 'wrong_passphrase' } })
          }

          // avatar info <key> --json — used by dialogue-page.js to resolve
          // custom avatars. Return not-found for all keys in DRY_RUN so the
          // page falls back to letter bubbles without making real file reads.
          if (
            dryRun &&
            body.command === 'wechat_cli_json' &&
            cliArgs[0] === 'avatar' &&
            cliArgs[1] === 'info'
          ) {
            return Response.json({ result: { ok: true, exists: false, path: '' } })
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

          // Intercept provider set in DRY_RUN — record the call in
          // __mockState.providerInvokes so Playwright tests can assert
          // that the provider-switch dropdown fired the right command.
          // Provider set uses wechat_cli_text (no JSON output).
          // Frontend calls: ["provider", "set", <name>]
          if (
            dryRun &&
            (body.command === 'wechat_cli_text' || body.command === 'wechat_cli_json') &&
            cliArgs[0] === 'provider' &&
            cliArgs[1] === 'set'
          ) {
            const provider = cliArgs[2] ?? ''
            __mockState.providerInvokes.push({ provider, ts: Date.now() })
            return Response.json({ result: `provider set: ${provider}` })
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

          if (dryRun && cliArgs[0] === 'sessions' && cliArgs[1] === 'read-jsonl') {
            const alias = cliArgs[2]
            const exists = __mockState.sessions.some(s => s.project === alias)
            if (!exists) return Response.json({ result: { ok: false, error: 'no such alias' } })
            return Response.json({ result: { ok: true, alias, session_id: `sess-${alias}`, turns: [] } })
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

        // wechat_health_ping — returns __mockState.healthProbeResult.
        // In dry-run the shim can't read a 0o600 token or hit a real daemon;
        // the mock is the source of truth for health-probe tests.
        if (body.command === 'wechat_health_ping') {
          return Response.json({ result: __mockState.healthProbeResult })
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
