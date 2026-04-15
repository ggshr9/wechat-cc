/**
 * docs.ts — share_doc backend
 *
 * Turns a markdown document into a publicly reachable URL that the WeChat
 * user can tap to read a rendered view. Stack:
 *
 *   1. Persist the .md to ~/.claude/channels/wechat/docs/<slug>.md
 *   2. Spin up a local Bun.serve on an ephemeral port that renders
 *      /docs/<slug> via `marked`
 *   3. Spawn `cloudflared tunnel --url http://localhost:<port>` to get a
 *      public trycloudflare.com URL with zero Cloudflare account required
 *   4. Auto-download cloudflared on first use if it's not on PATH, caching
 *      the binary in ~/.claude/channels/wechat/bin/cloudflared
 *
 * Both the Bun server and the cloudflared subprocess are lazy — they start
 * on the first shareDoc() call and stay alive for the session, reusing the
 * same tunnel URL for subsequent docs. `shutdown()` is wired into server.ts
 * teardown so they close cleanly.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'fs'
import { homedir, platform, arch } from 'os'
import { join } from 'path'
import { marked } from 'marked'

const STATE_DIR = process.env.WECHAT_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'wechat')
const DOCS_DIR = join(STATE_DIR, 'docs')
const BIN_DIR = join(STATE_DIR, 'bin')
const CLOUDFLARED_BIN = join(BIN_DIR, 'cloudflared')

mkdirSync(DOCS_DIR, { recursive: true, mode: 0o700 })
mkdirSync(BIN_DIR, { recursive: true, mode: 0o700 })

// ── cloudflared binary discovery + auto-download ──────────────────────────

function whichCloudflared(): string | null {
  // Prefer a cloudflared already on PATH (e.g. brew install), fall back to
  // the plugin-local copy in ~/.claude/channels/wechat/bin/.
  const onPath = spawnSync('which', ['cloudflared'], { stdio: 'pipe' })
  if (onPath.status === 0) {
    const p = onPath.stdout.toString().trim()
    if (p) return p
  }
  if (existsSync(CLOUDFLARED_BIN)) return CLOUDFLARED_BIN
  return null
}

function cloudflaredAssetUrl(): string {
  // https://github.com/cloudflare/cloudflared/releases/latest/download/<asset>
  const os = platform()  // 'linux' | 'darwin' | 'win32' | ...
  const a = arch()       // 'x64' | 'arm64' | ...
  let asset: string
  if (os === 'linux') {
    asset = a === 'arm64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64'
  } else if (os === 'darwin') {
    // Cloudflare ships a universal tarball for darwin: cloudflared-darwin-amd64.tgz
    // We use the tgz for both arm64 and x64 because the binary in it is universal.
    asset = 'cloudflared-darwin-amd64.tgz'
  } else {
    throw new Error(`cloudflared auto-download not supported on ${os}; please install it manually (https://github.com/cloudflare/cloudflared/releases)`)
  }
  return `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`
}

async function downloadCloudflared(): Promise<string> {
  const url = cloudflaredAssetUrl()
  process.stderr.write(`wechat channel: downloading cloudflared from ${url} ...\n`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`cloudflared download failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())

  if (url.endsWith('.tgz')) {
    // macOS: extract the single binary from the tarball via `tar -xzO`
    const tarGzPath = join(BIN_DIR, 'cloudflared.tgz')
    writeFileSync(tarGzPath, buf, { mode: 0o600 })
    const extract = spawnSync('tar', ['-xzf', tarGzPath, '-C', BIN_DIR], { stdio: 'pipe' })
    if (extract.status !== 0) {
      throw new Error(`cloudflared tgz extract failed: ${extract.stderr?.toString() ?? 'unknown'}`)
    }
    // The tarball contains a `cloudflared` binary at the top level
  } else {
    writeFileSync(CLOUDFLARED_BIN, buf, { mode: 0o755 })
  }
  chmodSync(CLOUDFLARED_BIN, 0o755)
  process.stderr.write(`wechat channel: cloudflared installed at ${CLOUDFLARED_BIN}\n`)
  return CLOUDFLARED_BIN
}

async function ensureCloudflared(): Promise<string> {
  const found = whichCloudflared()
  if (found) return found
  return downloadCloudflared()
}

// ── Local Bun doc server ───────────────────────────────────────────────────

// Shared CSS — matches the test page styling the user already approved.
const DOC_CSS = `
  body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", Arial, sans-serif; max-width: 720px; margin: 2em auto; padding: 0 1em; color: #222; line-height: 1.6; }
  h1 { border-bottom: 2px solid #eee; padding-bottom: .3em; }
  h2 { margin-top: 1.6em; color: #333; }
  h3 { margin-top: 1.4em; color: #444; }
  code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-family: Menlo, Consolas, monospace; font-size: 0.9em; }
  pre { background: #f8f8f8; padding: 1em; border-radius: 6px; overflow-x: auto; border-left: 3px solid #6cf; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 4px solid #ddd; padding-left: 1em; color: #666; margin-left: 0; }
  ul, ol { padding-left: 1.5em; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
  th { background: #f4f4f4; }
  a { color: #0366d6; }
  img { max-width: 100%; height: auto; }
  hr { border: none; border-top: 1px solid #eee; margin: 2em 0; }
  .meta { color: #888; font-size: 0.85em; margin-top: -0.5em; margin-bottom: 1em; }
`

function renderDoc(slug: string): { body: string; status: number } {
  const path = join(DOCS_DIR, `${slug}.md`)
  if (!existsSync(path)) {
    return { body: '<h1>Not found</h1>', status: 404 }
  }
  let raw: string
  try { raw = readFileSync(path, 'utf8') }
  catch { return { body: '<h1>Read error</h1>', status: 500 } }
  // Extract title from frontmatter-like first H1 or first line
  const titleMatch = raw.match(/^#\s+(.+)$/m)
  const title = titleMatch?.[1] ?? slug
  const html = marked.parse(raw, { async: false }) as string
  const body = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>${DOC_CSS}</style>
</head>
<body>
${html}
</body>
</html>`
  return { body, status: 200 }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

// ── Session-global state (singletons for the life of this server.ts run) ──

interface Server {
  stop(): Promise<void>
  port: number
}

let httpServer: Server | null = null
let tunnelUrl: string | null = null
let tunnelProc: ChildProcessWithoutNullStreams | null = null
// In-flight promise so concurrent shareDoc() calls don't race to spawn
// multiple tunnels.
let tunnelPromise: Promise<string> | null = null

function startHttpServer(): Server {
  if (httpServer) return httpServer
  // Bun.serve with port: 0 asks the kernel for an ephemeral free port
  const bunServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      const m = url.pathname.match(/^\/docs\/([a-zA-Z0-9_-]+)\/?$/)
      if (m) {
        const { body, status } = renderDoc(m[1])
        return new Response(body, {
          status,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' },
        })
      }
      if (url.pathname === '/' || url.pathname === '/healthz') {
        return new Response('wechat-cc docs', { status: 200 })
      }
      return new Response('Not found', { status: 404 })
    },
  })
  httpServer = {
    port: bunServer.port,
    stop: async () => { bunServer.stop(true) },
  }
  process.stderr.write(`wechat channel: doc server on http://localhost:${httpServer.port}\n`)
  return httpServer
}

async function startTunnel(port: number): Promise<string> {
  const bin = await ensureCloudflared()
  return new Promise<string>((resolve, reject) => {
    const proc = spawn(bin, ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    tunnelProc = proc

    let settled = false
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        try { proc.kill('SIGTERM') } catch {}
        reject(new Error('cloudflared tunnel did not produce a URL within 20s'))
      }
    }, 20_000)

    const onChunk = (buf: Buffer) => {
      const txt = buf.toString('utf8')
      // cloudflared logs the URL in a big banner; match the line:
      //   "Your quick Tunnel has been created! Visit it at ... https://xxx.trycloudflare.com"
      const m = txt.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/)
      if (m && !settled) {
        settled = true
        clearTimeout(timeout)
        tunnelUrl = m[0]
        process.stderr.write(`wechat channel: tunnel live at ${tunnelUrl}\n`)
        resolve(tunnelUrl)
      }
    }
    proc.stdout.on('data', onChunk)
    proc.stderr.on('data', onChunk)  // cloudflared actually prints to stderr

    proc.on('exit', (code) => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        reject(new Error(`cloudflared exited early with code ${code}`))
      }
      // If the tunnel dies later, invalidate cached URL so next shareDoc
      // call tries to bring it back up.
      tunnelUrl = null
      tunnelProc = null
      tunnelPromise = null
      process.stderr.write(`wechat channel: tunnel process exited (code ${code})\n`)
    })
  })
}

// ── Public API ────────────────────────────────────────────────────────────

export function slugify(title: string): string {
  // ASCII-only slug for URL safety. Non-ASCII (e.g. Chinese) titles collapse
  // to a timestamp-based fallback.
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  if (base.length >= 3) return `${base}-${Date.now().toString(36)}`
  return `doc-${Date.now().toString(36)}`
}

export interface ShareDocResult {
  url: string
  slug: string
  path: string
}

export async function shareDoc(title: string, content: string): Promise<ShareDocResult> {
  const slug = slugify(title)
  const path = join(DOCS_DIR, `${slug}.md`)
  // Ensure the rendered page has a visible H1 even if the caller didn't
  // include one at the top of `content`.
  const body = /^#\s+/m.test(content) ? content : `# ${title}\n\n${content}`
  writeFileSync(path, body, { mode: 0o600 })

  const server = startHttpServer()
  if (!tunnelPromise) {
    tunnelPromise = startTunnel(server.port).catch(err => {
      tunnelPromise = null
      throw err
    })
  }
  const base = await tunnelPromise
  return { url: `${base}/docs/${slug}`, slug, path }
}

export async function shutdown(): Promise<void> {
  try { tunnelProc?.kill('SIGTERM') } catch {}
  tunnelProc = null
  tunnelPromise = null
  tunnelUrl = null
  try { await httpServer?.stop() } catch {}
  httpServer = null
}

export function cloudflaredBinaryPath(): string {
  return CLOUDFLARED_BIN
}

export function isCloudflaredAvailable(): boolean {
  return whichCloudflared() != null
}
