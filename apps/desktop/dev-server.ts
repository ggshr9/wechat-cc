/**
 * Static dev server for `apps/desktop/src/` with SSE-driven live reload.
 *
 * Replaces the python3 -m http.server preview script. Watches src/
 * recursively; on any change broadcasts a "reload" event over SSE; the
 * injected client script reloads the page.
 *
 * - Listens on 127.0.0.1:4173 by default (PORT env override).
 * - CSP-friendly: injects a `<script src="/__dev_reload.js">` tag
 *   instead of inline JS, so tauri's `script-src 'self'` policy passes.
 * - Tauri config wires this in via `beforeDevCommand` + `devUrl`.
 */
import { watch, existsSync, statSync, readFileSync } from 'node:fs'
import { join, resolve, relative, isAbsolute, extname } from 'node:path'

const ROOT = resolve(import.meta.dir, 'src')
const PORT = Number(process.env.PORT ?? 4173)

const RELOAD_CLIENT_JS = `// dev-server live-reload client
(function () {
  let reconnectDelay = 250
  function connect() {
    const es = new EventSource('/__dev_reload')
    es.addEventListener('reload', () => {
      console.log('[dev-server] reload')
      location.reload()
    })
    es.onopen = () => { reconnectDelay = 250 }
    es.onerror = () => {
      es.close()
      // backoff so a dev-server restart triggers exactly one reload
      // when it comes back up, not a tight loop.
      setTimeout(connect, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, 3000)
    }
  }
  connect()
})()
`

const RELOAD_SCRIPT_TAG = '<script src="/__dev_reload.js"></script>'

type Send = (msg: string) => void
const reloadClients = new Set<Send>()

function broadcastReload() {
  const payload = `event: reload\ndata: ${Date.now()}\n\n`
  for (const send of reloadClients) {
    try { send(payload) } catch { reloadClients.delete(send) }
  }
}

// Debounce: file save events fire in bursts (editor temp files, multi-file
// formatters). Coalesce within a 50ms window so the browser reloads once.
let pending: ReturnType<typeof setTimeout> | null = null
function scheduleReload(filename: string | null) {
  if (pending) clearTimeout(pending)
  pending = setTimeout(() => {
    pending = null
    if (filename) console.error(`[dev-server] reload (${filename})`)
    broadcastReload()
  }, 50)
}

watch(ROOT, { recursive: true }, (_event, filename) => {
  if (!filename) return
  // Ignore editor swap files, etc.
  if (/(^|\/)\..+\.sw[a-z]$|~$/.test(filename)) return
  scheduleReload(filename)
})

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.map':  'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
}

Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)

    // SSE stream for reload signal
    if (url.pathname === '/__dev_reload') {
      let send!: Send
      const stream = new ReadableStream({
        start(controller) {
          send = (msg: string) => {
            try { controller.enqueue(new TextEncoder().encode(msg)) }
            catch { reloadClients.delete(send) }
          }
          reloadClients.add(send)
          // Initial comment line keeps the connection alive in proxies.
          send(': connected\n\n')
        },
        cancel() { reloadClients.delete(send) },
      })
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      })
    }

    // Reload client script — served as a same-origin .js file so it
    // passes tauri's `script-src 'self'` CSP without `unsafe-inline`.
    if (url.pathname === '/__dev_reload.js') {
      return new Response(RELOAD_CLIENT_JS, {
        headers: { 'Content-Type': MIME['.js']!, 'Cache-Control': 'no-store' },
      })
    }

    // Static file serving
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname
    const filePath = join(ROOT, pathname)

    // Path traversal guard. Uses path.relative so the check works on
    // Windows (path.join produces '\\', not '/').
    const rel = relative(ROOT, filePath)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return new Response('Forbidden', { status: 403 })
    }

    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      return new Response('Not Found', { status: 404 })
    }

    const ext = extname(filePath).toLowerCase()
    const mime = MIME[ext] ?? 'application/octet-stream'

    // Inject reload script into HTML responses. Match only the last
    // </body> via a greedy lookahead, so <body> mentioned inside string
    // literals or comments doesn't grab the injection. Falls back to
    // appending if no closing tag is found.
    if (ext === '.html') {
      let html = readFileSync(filePath, 'utf8')
      const bodyClose = /<\/body\s*>(?![\s\S]*<\/body\s*>)/i
      if (bodyClose.test(html)) {
        html = html.replace(bodyClose, (m) => `  ${RELOAD_SCRIPT_TAG}\n  ${m}`)
      } else {
        html += `\n${RELOAD_SCRIPT_TAG}\n`
      }
      return new Response(html, {
        headers: { 'Content-Type': mime, 'Cache-Control': 'no-store' },
      })
    }

    return new Response(Bun.file(filePath), {
      headers: { 'Content-Type': mime, 'Cache-Control': 'no-store' },
    })
  },
})

// Banner on stderr so tauri's beforeDevCommand stdout-parsers don't see it.
console.error(`[dev-server] serving ${ROOT}`)
console.error(`[dev-server] listening on http://127.0.0.1:${PORT}`)
console.error(`[dev-server] watching for file changes; browser reloads on save`)

// Clean exit when tauri's beforeDevCommand parent goes away, or on ctrl-C.
// Without this, the port can stay bound for a few seconds on the next dev run.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => process.exit(0))
}
