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
import { join } from 'node:path'

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
const __mockState: {
  chats: Array<{ id: string; name: string; last_active: number; mode?: { kind: string; provider?: string } }>
  observations: Array<{ id: string; body: string; tone: string; archived: boolean }>
  milestones: Array<{ id: string; label: string; triggered_at: number }>
  sessions: Array<{ id: string; project: string; created_at: number; favorited: boolean }>
  qrScanComplete?: boolean
  qrScanFails?: boolean
  envCheck?: { binary_missing?: string }
  installProgress: { step: number; total: number; label: string; ts: number } | null
  installSimulationStep: number
} = { chats: [], observations: [], milestones: [], sessions: [], installProgress: null, installSimulationStep: 0 }

const POLYFILL = `<script>
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
</script>`

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
  port: PORT,
  development: true,
  async fetch(req) {
    const url = new URL(req.url)

    // Local-file attachment endpoint — restricted to the wechat-cc
    // inbox tree so the dev shim doesn't double as an open file server.
    if (url.pathname === '/attachment' && req.method === 'GET') {
      const filePath = url.searchParams.get('path') || ''
      const inboxRoot = join(ROOT, 'apps', 'desktop')  // for tauri-localhost dev cache
      const stateInbox = (process.env.WECHAT_CC_STATE_DIR
        ?? join(process.env.HOME ?? '', '.claude', 'channels', 'wechat'))
      const allowedRoots = [
        join(stateInbox, 'inbox'),
        join(stateInbox, 'avatars'),  // custom avatars (Bundle E2.5)
        inboxRoot,
      ]
      const ok = filePath && allowedRoots.some(root => filePath.startsWith(root))
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

        if (body.command === 'demo.seed') {
          const args = body.args as { chat_id?: string } | undefined
          const chatId = args?.chat_id ?? 'test_chat'
          __mockState.chats = [{ id: chatId, name: 'Test User', last_active: Date.now() }]
          __mockState.observations = [
            { id: 'obs_demo_1', body: 'demo observation 1', tone: 'playful', archived: false },
            { id: 'obs_demo_2', body: 'demo observation 2', tone: 'reflective', archived: false },
            { id: 'obs_demo_3', body: 'demo observation 3', tone: 'playful', archived: false },
            { id: 'obs_demo_4', body: 'demo observation 4', tone: 'reflective', archived: false },
            { id: 'obs_demo_5', body: 'demo observation 5', tone: 'playful', archived: false },
          ]
          __mockState.milestones = [
            { id: 'ms_demo_1', label: '100 messages', triggered_at: Date.now() - 86400000 },
            { id: 'ms_demo_2', label: '7-day streak', triggered_at: Date.now() - 172800000 },
            { id: 'ms_demo_3', label: 'first push reply', triggered_at: Date.now() - 259200000 },
          ]
          __mockState.sessions = [
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

        // ── Shim-native commands (not forwarded to CLI) ────────────────────
        if (body.command === 'wechat_cli_json' || body.command === 'wechat_cli_text') {
          const cliArgs = body.args?.args ?? []

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

          // Intercept sessions list-projects in DRY_RUN when demo data has been seeded.
          // Frontend calls: ["sessions", "list-projects", "--json"]
          if (
            dryRun &&
            body.command === 'wechat_cli_json' &&
            cliArgs[0] === 'sessions' &&
            cliArgs[1] === 'list-projects' &&
            __mockState.sessions.length > 0
          ) {
            // Map internal sessions to the shape the frontend expects
            // (alias, last_used_at, summary — matches sessions list-projects output)
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
              return Response.json({ result: { status: 'confirmed', accountId: 'mock-bot', userId: 'mock-user' } })
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

          // Intercept mode set in DRY_RUN — update mock chat mode + return ok.
          // Frontend calls: ["mode", "set", <chatId>, <mode>, "--json"]
          if (
            dryRun &&
            body.command === 'wechat_cli_json' &&
            cliArgs[0] === 'mode' &&
            cliArgs[1] === 'set'
          ) {
            const chatId = cliArgs[2]
            const modeArg = cliArgs[3]
            // Map shorthand to mode shape (mirrors cli.ts modeShorthand mapping)
            const SHORTHAND: Record<string, { kind: string; provider?: string }> = {
              cc:    { kind: 'solo', provider: 'claude' },
              codex: { kind: 'solo', provider: 'codex' },
              solo:  { kind: 'solo', provider: 'claude' },
              both:  { kind: 'parallel' },
              chat:  { kind: 'chatroom' },
            }
            const mode = modeArg ? (SHORTHAND[modeArg] ?? (() => { try { return JSON.parse(modeArg) } catch { return null } })()) : null
            if (mode && chatId) {
              __mockState.chats = __mockState.chats.map(c =>
                c.id === chatId ? { ...c, mode } : c
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

    const path = url.pathname === '/' ? '/index.html' : url.pathname
    const file = Bun.file(join(SRC, path))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    if (path === '/index.html') {
      const html = await file.text()
      return new Response(html.replace('</head>', `${POLYFILL}\n</head>`), {
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
