/**
 * docs.ts — share_page backend
 *
 * Turns a markdown document into a publicly reachable URL that the WeChat
 * user can tap to read a rendered view. Also exposes an optional approve /
 * reject UI embedded in the rendered page so non-Claude reviewers (e.g. a
 * supervisor the URL was forwarded to) can sign off without any tooling.
 *
 * Stack:
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
 * on the first sharePage() call and stay alive for the session, reusing the
 * same tunnel URL for subsequent docs. `shutdown()` is wired into server.ts
 * teardown so they close cleanly.
 *
 * Retention: .md and .decision.json files older than 7 days are auto-deleted.
 * If users need a permanent archive they are expected to copy the file
 * somewhere else themselves — wechat-cc is a transport, not an archive store.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process'
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'fs'
import { homedir, platform, arch } from 'os'
import { join } from 'path'
import { marked } from 'marked'

const STATE_DIR = process.env.WECHAT_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'wechat')
const DOCS_DIR = join(STATE_DIR, 'docs')
const BIN_DIR = join(STATE_DIR, 'bin')
const CLOUDFLARED_BIN = join(BIN_DIR, 'cloudflared')

const DOCS_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

mkdirSync(DOCS_DIR, { recursive: true, mode: 0o700 })
mkdirSync(BIN_DIR, { recursive: true, mode: 0o700 })

// ── TTL cleanup ─────────────────────────────────────────────────────────────

/**
 * Delete .md and matching .decision.json files whose mtime is older than
 * DOCS_TTL_MS. Cheap (O(files), files are always a small count in practice),
 * safe (individual unlink errors are logged but don't abort), and runs at
 * module load + before every sharePage call.
 */
function cleanupOldDocs(): number {
  let removed = 0
  let entries: string[]
  try {
    entries = readdirSync(DOCS_DIR)
  } catch {
    return 0
  }
  const now = Date.now()
  for (const name of entries) {
    if (!name.endsWith('.md') && !name.endsWith('.decision.json')) continue
    const full = join(DOCS_DIR, name)
    try {
      const st = statSync(full)
      if (now - st.mtimeMs > DOCS_TTL_MS) {
        unlinkSync(full)
        removed++
      }
    } catch (err) {
      process.stderr.write(`wechat channel: cleanup failed for ${name}: ${err}\n`)
    }
  }
  if (removed > 0) {
    process.stderr.write(`wechat channel: cleaned up ${removed} doc file(s) older than 7 days\n`)
  }
  return removed
}

cleanupOldDocs()

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
  const os = platform()
  const a = arch()
  let asset: string
  if (os === 'linux') {
    asset = a === 'arm64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64'
  } else if (os === 'darwin') {
    // Cloudflare ships a universal tarball for darwin: cloudflared-darwin-amd64.tgz
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
    const tarGzPath = join(BIN_DIR, 'cloudflared.tgz')
    writeFileSync(tarGzPath, buf, { mode: 0o600 })
    const extract = spawnSync('tar', ['-xzf', tarGzPath, '-C', BIN_DIR], { stdio: 'pipe' })
    if (extract.status !== 0) {
      throw new Error(`cloudflared tgz extract failed: ${extract.stderr?.toString() ?? 'unknown'}`)
    }
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

// ── Decision storage ──────────────────────────────────────────────────────

export interface Decision {
  decision: 'approve' | 'reject'
  comment?: string
  timestamp: number
}

function decisionPath(slug: string): string {
  return join(DOCS_DIR, `${slug}.decision.json`)
}

function readDecision(slug: string): Decision | null {
  try {
    const raw = readFileSync(decisionPath(slug), 'utf8')
    return JSON.parse(raw) as Decision
  } catch {
    return null
  }
}

function writeDecision(slug: string, d: Decision): void {
  writeFileSync(decisionPath(slug), JSON.stringify(d, null, 2) + '\n', { mode: 0o600 })
}

// Callback that server.ts registers to receive review decisions and turn
// them into MCP channel notifications. docs.ts stays agnostic about MCP.
export type DecisionCallback = (params: {
  slug: string
  title: string
  decision: Decision
}) => void

let decisionCallback: DecisionCallback | null = null
export function onDecision(cb: DecisionCallback): void {
  decisionCallback = cb
}

// ── Local Bun doc server ───────────────────────────────────────────────────

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

  .decision-zone { margin-top: 3em; padding: 1.5em; background: #fafafa; border: 1px solid #eee; border-radius: 8px; }
  .decision-zone h3 { margin-top: 0; }
  .decision-zone textarea { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font: inherit; margin-bottom: 8px; box-sizing: border-box; }
  .decision-zone .btn-row { display: flex; gap: 10px; }
  .decision-zone button { flex: 1; padding: 12px 20px; border: none; border-radius: 6px; cursor: pointer; font-size: 15px; font-weight: 600; }
  .decision-zone button[data-decide="approve"] { background: #4caf50; color: white; }
  .decision-zone button[data-decide="reject"] { background: #f44336; color: white; }
  .decision-zone button:hover { opacity: 0.9; }
  .decision-banner { padding: 1em; border-radius: 6px; font-weight: 600; text-align: center; margin-top: 3em; }
  .decision-banner.approve { background: #e8f5e9; color: #2e7d32; border: 1px solid #4caf50; }
  .decision-banner.reject { background: #ffebee; color: #c62828; border: 1px solid #f44336; }
  .decision-banner .comment { margin-top: 8px; font-weight: 400; color: #555; font-size: 0.9em; }
  .decision-banner .ts { margin-top: 4px; font-weight: 400; color: #999; font-size: 0.8em; }
`

function titleFromMarkdown(raw: string, fallback: string): string {
  const m = raw.match(/^#\s+(.+)$/m)
  return m?.[1]?.trim() ?? fallback
}

function decisionSection(slug: string): string {
  const existing = readDecision(slug)
  if (existing) {
    const ts = new Date(existing.timestamp).toLocaleString('zh-CN')
    const label = existing.decision === 'approve' ? 'Approved ✓' : 'Rejected ✗'
    return `
<div class="decision-banner ${existing.decision}">
  ${label}
  ${existing.comment ? `<div class="comment">「${escapeHtml(existing.comment)}」</div>` : ''}
  <div class="ts">${escapeHtml(ts)}</div>
</div>`
  }
  return `
<div id="decision-zone" class="decision-zone">
  <h3>审阅 / Review</h3>
  <p style="color:#666; font-size:0.9em; margin-top:-0.5em;">这份文档需要你的反馈。可选：留一句备注。</p>
  <textarea id="comment" placeholder="（可选）备注 …" rows="2"></textarea>
  <div class="btn-row">
    <button type="button" data-decide="approve">✓ Approve</button>
    <button type="button" data-decide="reject">✗ Reject</button>
  </div>
</div>
<script>
(function () {
  var zone = document.getElementById('decision-zone');
  function submit(decision) {
    var comment = document.getElementById('comment').value;
    var btns = zone.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) btns[i].disabled = true;
    zone.querySelector('p').textContent = '发送中 …';
    fetch(window.location.pathname.replace(/\\/$/, '') + '/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: decision, comment: comment }),
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var label = decision === 'approve' ? 'Approved ✓' : 'Rejected ✗';
      zone.outerHTML =
        '<div class="decision-banner ' + decision + '">' + label +
        (comment ? '<div class="comment">「' + comment.replace(/[<>&]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]; }) + '」</div>' : '') +
        '</div>';
    }).catch(function (e) {
      zone.querySelector('p').textContent = '提交失败: ' + e.message;
      for (var i = 0; i < btns.length; i++) btns[i].disabled = false;
    });
  }
  document.querySelectorAll('[data-decide]').forEach(function (b) {
    b.addEventListener('click', function () { submit(b.dataset.decide); });
  });
})();
</script>`
}

function renderDoc(slug: string): { body: string; status: number } {
  const path = join(DOCS_DIR, `${slug}.md`)
  if (!existsSync(path)) {
    return { body: '<h1>Not found</h1>', status: 404 }
  }
  let raw: string
  try { raw = readFileSync(path, 'utf8') }
  catch { return { body: '<h1>Read error</h1>', status: 500 } }
  const title = titleFromMarkdown(raw, slug)
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
${decisionSection(slug)}
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
let tunnelPromise: Promise<string> | null = null

function startHttpServer(): Server {
  if (httpServer) return httpServer
  const bunServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)

      // POST /docs/<slug>/decide — anonymous review submission
      const decideMatch = url.pathname.match(/^\/docs\/([a-zA-Z0-9_-]+)\/decide\/?$/)
      if (decideMatch && req.method === 'POST') {
        const slug = decideMatch[1]!
        const mdPath = join(DOCS_DIR, `${slug}.md`)
        if (!existsSync(mdPath)) {
          return new Response('slug not found', { status: 404 })
        }
        // Reject if already decided — decisions are one-shot
        if (readDecision(slug)) {
          return new Response('already decided', { status: 409 })
        }
        let payload: { decision?: string; comment?: string }
        try { payload = await req.json() as typeof payload }
        catch { return new Response('bad json', { status: 400 }) }

        const decision = payload.decision === 'approve' || payload.decision === 'reject'
          ? payload.decision
          : null
        if (!decision) return new Response('bad decision', { status: 400 })

        const comment = typeof payload.comment === 'string'
          ? payload.comment.trim().slice(0, 2000) || undefined
          : undefined

        const record: Decision = { decision, comment, timestamp: Date.now() }
        try {
          writeDecision(slug, record)
        } catch (err) {
          return new Response(`write failed: ${err}`, { status: 500 })
        }

        // Fire callback (server.ts converts to MCP notification)
        if (decisionCallback) {
          try {
            const title = titleFromMarkdown(readFileSync(mdPath, 'utf8'), slug)
            decisionCallback({ slug, title, decision: record })
          } catch (err) {
            process.stderr.write(`wechat channel: decisionCallback threw: ${err}\n`)
          }
        }

        return new Response(JSON.stringify({ ok: true, slug, decision }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      // GET /docs/<slug>
      const viewMatch = url.pathname.match(/^\/docs\/([a-zA-Z0-9_-]+)\/?$/)
      if (viewMatch && req.method === 'GET') {
        const { body, status } = renderDoc(viewMatch[1]!)
        return new Response(body, {
          status,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'X-Robots-Tag': 'noindex, nofollow',
          },
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
    proc.stderr.on('data', onChunk)

    proc.on('exit', (code) => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        reject(new Error(`cloudflared exited early with code ${code}`))
      }
      tunnelUrl = null
      tunnelProc = null
      tunnelPromise = null
      process.stderr.write(`wechat channel: tunnel process exited (code ${code})\n`)
    })
  })
}

/**
 * Ensure both the HTTP server and the cloudflared tunnel are running.
 * Returns the current tunnel base URL. Concurrent callers share the same
 * in-flight promise so we never spawn two tunnels.
 */
async function ensureServing(): Promise<string> {
  const server = startHttpServer()
  if (!tunnelPromise) {
    tunnelPromise = startTunnel(server.port).catch(err => {
      tunnelPromise = null
      throw err
    })
  }
  return tunnelPromise
}

// ── Public API ────────────────────────────────────────────────────────────

export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  if (base.length >= 3) return `${base}-${Date.now().toString(36)}`
  return `doc-${Date.now().toString(36)}`
}

export interface SharePageResult {
  url: string
  slug: string
  path: string
}

/**
 * Publish a new markdown document to a cloudflared quick-tunnel URL.
 * Old .md files beyond the 7-day TTL are cleaned up before writing.
 */
export async function sharePage(title: string, content: string): Promise<SharePageResult> {
  cleanupOldDocs()

  const slug = slugify(title)
  const path = join(DOCS_DIR, `${slug}.md`)
  const body = /^#\s+/m.test(content) ? content : `# ${title}\n\n${content}`
  writeFileSync(path, body, { mode: 0o600 })

  const base = await ensureServing()
  return { url: `${base}/docs/${slug}`, slug, path }
}

/**
 * Find a previously shared .md file and hand back a URL on the *current*
 * tunnel so the user can reopen it even though the tunnel URL they got
 * originally has since died (tunnel URLs live only for one wechat-cc run).
 *
 * Matching rules:
 *   1. If `slug` is given, match that exact .md filename stem
 *   2. Otherwise, if `title_fragment` is given, match against the first
 *      H1 of each .md file (case-insensitive substring)
 *   3. Among matches, pick the one with the most recent mtime
 *
 * Returns null if nothing matches.
 */
export async function resurfacePage(params: {
  slug?: string
  title_fragment?: string
}): Promise<SharePageResult | null> {
  let entries: string[]
  try {
    entries = readdirSync(DOCS_DIR).filter(n => n.endsWith('.md'))
  } catch {
    return null
  }

  // Exact slug path: O(1)
  if (params.slug) {
    const candidate = `${params.slug}.md`
    if (!entries.includes(candidate)) return null
    const base = await ensureServing()
    return {
      url: `${base}/docs/${params.slug}`,
      slug: params.slug,
      path: join(DOCS_DIR, candidate),
    }
  }

  // Title fragment path: scan, score by mtime
  if (params.title_fragment) {
    const needle = params.title_fragment.toLowerCase()
    let best: { slug: string; path: string; mtime: number } | null = null
    for (const name of entries) {
      const full = join(DOCS_DIR, name)
      try {
        const raw = readFileSync(full, 'utf8')
        const title = titleFromMarkdown(raw, name)
        if (!title.toLowerCase().includes(needle)) continue
        const st = statSync(full)
        if (!best || st.mtimeMs > best.mtime) {
          best = { slug: name.slice(0, -3), path: full, mtime: st.mtimeMs }
        }
      } catch {
        continue
      }
    }
    if (!best) return null
    const base = await ensureServing()
    return { url: `${base}/docs/${best.slug}`, slug: best.slug, path: best.path }
  }

  return null
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
