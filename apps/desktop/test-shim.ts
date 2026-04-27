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

    if (url.pathname === '/__invoke' && req.method === 'POST') {
      const body = (await req.json()) as { command: string; args?: { args?: string[]; text?: string } }
      try {
        if (body.command === 'wechat_cli_json' || body.command === 'wechat_cli_text') {
          const cliArgs = body.args?.args ?? []
          const r = await runCli(cliArgs)
          if (r.code !== 0) return Response.json({ error: r.stderr.trim() || `cli exit ${r.code}` })
          const stdout = r.stdout.trim()
          const result = body.command === 'wechat_cli_json' ? JSON.parse(stdout) : stdout
          return Response.json({ result })
        }
        if (body.command === 'render_qr_svg') {
          return Response.json({ result: placeholderQr(body.args?.text ?? '') })
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
