/**
 * docs.ts — share_page backend
 *
 * Turns a markdown document into a publicly reachable URL that the WeChat
 * user can tap to read a rendered view. Each page also has a single Approve
 * button — a one-tap "read it, don't wait on me" soft acknowledgement for
 * whoever the URL was forwarded to. (No reject/comment UI on purpose; see
 * the Decision type comment further down.)
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
import { findOnPath } from './util.ts'
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
// .exe suffix on Windows so `chmod +x` and cmd.exe both work correctly.
// On Linux/macOS the binary has no extension.
const CLOUDFLARED_BIN = join(BIN_DIR, platform() === 'win32' ? 'cloudflared.exe' : 'cloudflared')

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
    if (!name.endsWith('.md') && !name.endsWith('.decision.json') && !name.endsWith('.approval') && !name.endsWith('.chat.json') && !name.endsWith('.pdf')) continue
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
  const onPath = findOnPath('cloudflared')
  if (onPath) return onPath
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
  } else if (os === 'win32') {
    // Cloudflare ships a direct .exe for Windows; no archive extraction needed.
    asset = a === 'arm64' ? 'cloudflared-windows-arm64.exe' : 'cloudflared-windows-amd64.exe'
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
    // macOS path — extract the single binary from the universal tarball.
    const tarGzPath = join(BIN_DIR, 'cloudflared.tgz')
    writeFileSync(tarGzPath, buf, { mode: 0o600 })
    const extract = spawnSync('tar', ['-xzf', tarGzPath, '-C', BIN_DIR], { stdio: 'pipe' })
    if (extract.status !== 0) {
      throw new Error(`cloudflared tgz extract failed: ${extract.stderr?.toString() ?? 'unknown'}`)
    }
  } else {
    // Linux / Windows: direct binary, just write to disk.
    writeFileSync(CLOUDFLARED_BIN, buf, { mode: 0o755 })
  }
  // chmod is a no-op on Windows but still works for Linux tarball-extracted
  // binaries that may land without the exec bit. Wrap so Windows edge cases
  // don't blow up installation.
  if (platform() !== 'win32') {
    try { chmodSync(CLOUDFLARED_BIN, 0o755) } catch {}
  }
  process.stderr.write(`wechat channel: cloudflared installed at ${CLOUDFLARED_BIN}\n`)
  return CLOUDFLARED_BIN
}

async function ensureCloudflared(): Promise<string> {
  const found = whichCloudflared()
  if (found) return found
  return downloadCloudflared()
}

// ── Decision storage ──────────────────────────────────────────────────────

// Only "approve" exists — reject was dropped on purpose. Rationale: if a
// reviewer needs to push back, the natural channel is to message the URL
// owner in WeChat directly; there's no way to explain "why not" through a
// single HTML button anyway. Approve stays as a one-tap "looks good, don't
// wait on me" acknowledgement.
export interface Decision {
  decision: 'approve'
  timestamp: number
}

// Sidecar file present iff the page was published with needs_approval=true.
// Default behavior (no flag) is "no approve button" — most share_page calls
// are content-only summaries with nothing to OK.
function approvalFlagPath(slug: string): string {
  return join(DOCS_DIR, `${slug}.approval`)
}

function markNeedsApproval(slug: string): void {
  writeFileSync(approvalFlagPath(slug), '', { mode: 0o600 })
}

function slugNeedsApproval(slug: string): boolean {
  return existsSync(approvalFlagPath(slug))
}

// Sidecar mapping a slug → the chat that originally received the URL,
// so the "📄 发我 PDF" button on the rendered page can route delivery
// back to that chat (anyone with the URL can request, but the PDF only
// goes to the original recipient).
function chatLinkPath(slug: string): string {
  return join(DOCS_DIR, `${slug}.chat.json`)
}

function linkSlugToChat(slug: string, chatId: string, accountId?: string): void {
  writeFileSync(chatLinkPath(slug), JSON.stringify({ chatId, accountId: accountId ?? null }), { mode: 0o600 })
}

function getSlugChat(slug: string): { chatId: string; accountId: string | null } | null {
  try {
    const raw = readFileSync(chatLinkPath(slug), 'utf8')
    return JSON.parse(raw) as { chatId: string; accountId: string | null }
  } catch { return null }
}

function slugHasChatLink(slug: string): boolean {
  return existsSync(chatLinkPath(slug))
}

// Callback wired in by ilink-glue: receives a request to deliver the
// rendered PDF for a slug to the original chat. docs.ts stays agnostic
// about ilink — same pattern as decisionCallback.
export type PdfRequestCallback = (params: {
  slug: string
  title: string
  chatId: string
  accountId: string | null
  pdfPath: string
}) => Promise<void> | void

let pdfRequestCallback: PdfRequestCallback | null = null
export function onPdfRequest(cb: PdfRequestCallback): void {
  pdfRequestCallback = cb
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
  /* ── Theme tokens (light by default, dark via prefers-color-scheme) ────── */
  :root {
    --bg: #ffffff;
    --fg: #1f2328;
    --fg-soft: #4a5159;
    --muted: #8b939c;
    --border: #e6e8eb;
    --code-bg: #f4f5f7;
    --pre-bg: #f7f8f9;
    --pre-accent: #6cf;
    --link: #0366d6;
    --quote: #6a737d;
    --th-bg: #f4f5f7;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16181d;
      --fg: #e6edf3;
      --fg-soft: #c4ccd3;
      --muted: #8b929a;
      --border: #2a2f37;
      --code-bg: #22272e;
      --pre-bg: #1c2026;
      --pre-accent: #4ea3df;
      --link: #58a6ff;
      --quote: #9ea7b3;
      --th-bg: #22272e;
    }
  }

  html, body { background: var(--bg); color: var(--fg); }
  body {
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
    max-width: 720px; margin: 2em auto; padding: 0 1em; line-height: 1.65;
    font-size: 16px; -webkit-text-size-adjust: 100%;
  }
  @media (max-width: 600px) {
    body { font-size: 17px; padding: 0 1.2em; margin: 1.2em auto; }
  }
  h1 { border-bottom: 2px solid var(--border); padding-bottom: .3em; line-height: 1.25; }
  h2 { margin-top: 1.6em; color: var(--fg); line-height: 1.3; }
  h3 { margin-top: 1.4em; color: var(--fg-soft); }
  p, li { color: var(--fg); }
  code { background: var(--code-bg); padding: 2px 6px; border-radius: 4px; font-family: "JetBrains Mono", "SF Mono", "Menlo", Consolas, monospace; font-size: 0.88em; }
  pre { background: var(--pre-bg); padding: 1em 1.1em; border-radius: 8px; overflow-x: auto; border-left: 3px solid var(--pre-accent); }
  pre code { background: none; padding: 0; font-size: 0.9em; line-height: 1.55; }
  blockquote { border-left: 4px solid var(--border); padding-left: 1em; color: var(--quote); margin-left: 0; }
  ul, ol { padding-left: 1.5em; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid var(--border); padding: 8px; text-align: left; }
  th { background: var(--th-bg); }
  a { color: var(--link); }
  img { max-width: 100%; height: auto; }
  hr { border: none; border-top: 1px solid var(--border); margin: 2em 0; }
  .meta { color: var(--muted); font-size: 0.85em; margin-top: -0.5em; margin-bottom: 1em; }

  /* Mermaid containers — let SVG breathe + center */
  .mermaid { text-align: center; margin: 1.4em 0; }

  /* ── Decision (approve) UI ────────────────────────────────────────────── */
  .decision-zone { margin-top: 3em; padding: 1.5em; background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px; text-align: center; }
  .decision-zone p { color: var(--quote); font-size: 0.9em; margin: 0 0 1em 0; }
  .decision-zone button { padding: 14px 40px; border: none; border-radius: 6px; cursor: pointer; font-size: 16px; font-weight: 600; background: #4caf50; color: white; min-height: 48px; }
  .decision-zone button:hover { opacity: 0.9; }
  .decision-zone button:disabled { opacity: 0.6; cursor: default; }
  .decision-banner { padding: 1em; border-radius: 6px; font-weight: 600; text-align: center; margin-top: 3em; background: #e8f5e9; color: #2e7d32; border: 1px solid #4caf50; }
  .decision-banner .ts { margin-top: 4px; font-weight: 400; color: var(--muted); font-size: 0.8em; }

  /* ── Footer affordance ────────────────────────────────────────────────── */
  .page-foot { margin-top: 4em; padding-top: 1.5em; border-top: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; color: var(--muted); font-size: 0.85em; }
  .page-foot a, .foot-btn { display: inline-flex; align-items: center; gap: 6px; color: var(--fg-soft); text-decoration: none; padding: 8px 12px; border: 1px solid var(--border); border-radius: 7px; transition: color .15s, border-color .15s; background: transparent; cursor: pointer; font: inherit; min-height: 40px; }
  .page-foot a:hover, .foot-btn:hover { color: var(--fg); border-color: var(--muted); }
  .foot-btn:disabled { opacity: 0.5; cursor: default; }
  .page-foot a svg, .foot-btn svg { display: block; }
  .page-foot .pdf-hint { color: var(--muted); font-size: 0.85em; }

  /* ── Back-to-top floating button (visible after scroll, hidden in print) ── */
  .to-top { position: fixed; bottom: 22px; right: 22px; width: 44px; height: 44px; border-radius: 50%; background: var(--bg); border: 1px solid var(--border); color: var(--fg-soft); display: none; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.08); z-index: 50; transition: transform .15s, color .15s; }
  .to-top.visible { display: inline-flex; }
  .to-top:hover { color: var(--fg); transform: translateY(-2px); }

  /* ── Print / PDF — force light, neat margins, page numbers via @page ──── */
  @page {
    size: A4;
    margin: 18mm 16mm 22mm 16mm;
    @bottom-center {
      content: counter(page) " / " counter(pages);
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 9pt;
      color: #999;
    }
    @top-right {
      content: string(doc-title);
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 9pt;
      color: #999;
    }
  }
  h1 { string-set: doc-title content(); }

  @media print {
    /* Force light theme regardless of system pref — PDFs need to print on paper */
    :root {
      --bg: #ffffff; --fg: #1f2328; --fg-soft: #3a4047; --muted: #6a737d;
      --border: #d8dbde; --code-bg: #f4f5f7; --pre-bg: #f7f8f9; --pre-accent: #6cf;
      --link: #2a4f8d; --quote: #555; --th-bg: #f4f5f7;
    }
    body { max-width: none; margin: 0; padding: 0; font-size: 11pt; line-height: 1.5; }
    .page-foot, .decision-zone, .decision-banner, .to-top, button { display: none !important; }
    a { color: var(--fg); text-decoration: none; }
    pre, blockquote, table, img, .mermaid { page-break-inside: avoid; }
    h1, h2, h3 { page-break-after: avoid; }
    pre { border-left-width: 2px; }
  }
`

function titleFromMarkdown(raw: string, fallback: string): string {
  const m = raw.match(/^#\s+(.+)$/m)
  return m?.[1]?.trim() ?? fallback
}

function decisionSection(slug: string): string {
  const existing = readDecision(slug)
  if (existing) {
    const ts = new Date(existing.timestamp).toLocaleString('zh-CN')
    return `
<div class="decision-banner">
  Approved ✓
  <div class="ts">${escapeHtml(ts)}</div>
</div>`
  }
  // Approve-only UI. Reject / comment were removed on purpose — if a
  // reviewer wants to push back or explain, the owner of the URL can be
  // reached through WeChat directly, and that path carries context much
  // better than a cramped textarea on a web page.
  return `
<div id="decision-zone" class="decision-zone">
  <p>读完了？一键确认，原作者就不用等你了。</p>
  <button type="button" id="approve-btn">✓ Approve</button>
</div>
<script>
(function () {
  var zone = document.getElementById('decision-zone');
  var btn = document.getElementById('approve-btn');
  btn.addEventListener('click', function () {
    btn.disabled = true;
    zone.querySelector('p').textContent = '发送中 …';
    fetch(window.location.pathname.replace(/\\/$/, '') + '/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      zone.outerHTML = '<div class="decision-banner">Approved ✓</div>';
    }).catch(function (e) {
      zone.querySelector('p').textContent = '提交失败: ' + e.message;
      btn.disabled = false;
    });
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
<!-- highlight.js: code syntax highlighting (themes auto-switch via prefers-color-scheme) -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github.min.css" media="(prefers-color-scheme: light)">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github-dark.min.css" media="(prefers-color-scheme: dark)">
<script defer src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js"></script>
<!-- KaTeX: $inline$ and $$display$$ math -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script>
<!-- Mermaid: mermaid code blocks -> SVG diagrams -->
<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.esm.min.mjs';
  var dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: dark ? 'dark' : 'default' });

  function convertAndRun() {
    var nodes = document.querySelectorAll('pre code.language-mermaid');
    if (nodes.length === 0) return;
    nodes.forEach(function (el) {
      var div = document.createElement('div');
      div.className = 'mermaid';
      // textContent decodes HTML entities — so --&gt; comes back as -->.
      div.textContent = el.textContent;
      el.parentElement.replaceWith(div);
    });
    mermaid.run({ querySelector: '.mermaid' }).catch(function (e) { console.error('[mermaid]', e); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', convertAndRun);
  else convertAndRun();
</script>
</head>
<body>
<main>
${html}
</main>
${slugNeedsApproval(slug) ? decisionSection(slug) : ''}
<footer class="page-foot">
  <a href="/docs/${slug}/download" download title="下载 Markdown 原文">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v12"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/></svg>
    下载原文
  </a>
  ${slugHasChatLink(slug) ? `<button type="button" id="pdf-btn" class="foot-btn" title="生成 PDF 并发到你的微信">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3v6h6"/><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9l6 6v10a2 2 0 0 1-2 2z"/></svg>
    <span id="pdf-btn-label">发 PDF 到微信</span>
  </button>
  <script>
  (function () {
    var btn = document.getElementById('pdf-btn');
    var lbl = document.getElementById('pdf-btn-label');
    btn.addEventListener('click', function () {
      btn.disabled = true;
      lbl.textContent = '生成中…';
      var p = window.location.pathname;
      if (p.charAt(p.length - 1) === '/') p = p.substring(0, p.length - 1);
      fetch(p + '/send-pdf', { method: 'POST' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function () { lbl.textContent = '已发送到微信 ✓'; })
        .catch(function (e) { btn.disabled = false; lbl.textContent = '失败：' + e.message; });
    });
  })();
  </script>` : ''}
  <span class="pdf-hint">需要本地 PDF？用浏览器"分享 → 打印"存为 PDF</span>
</footer>
<button type="button" class="to-top" id="to-top" title="回到顶部" aria-label="回到顶部">
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>
</button>
<script>
(function () {
  function runHighlight() {
    if (!window.hljs) return;
    document.querySelectorAll('pre code').forEach(function (b) {
      if (b.classList && b.classList.contains('language-mermaid')) return;
      window.hljs.highlightElement(b);
    });
  }
  if (window.hljs) runHighlight();
  else window.addEventListener('load', runHighlight);

  function runKatex() {
    if (!window.renderMathInElement) return;
    window.renderMathInElement(document.body, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$',  right: '$',  display: false },
        { left: '\\(', right: '\\)', display: false },
        { left: '\\[', right: '\\]', display: true }
      ],
      throwOnError: false,
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code']
    });
  }
  if (window.renderMathInElement) runKatex();
  else window.addEventListener('load', runKatex);

  var top = document.getElementById('to-top');
  function onScroll() {
    if ((window.scrollY || document.documentElement.scrollTop) > 600) top.classList.add('visible');
    else top.classList.remove('visible');
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  top.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
})();
</script>
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

const PDF_TIMEOUT_MS = 30_000

function findChromeBinary(): string | null {
  for (const cand of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']) {
    const p = findOnPath(cand)
    if (p) return p
  }
  return null
}

/**
 * Render a local URL to PDF using headless Chrome's --print-to-pdf.
 * Uses --media-type=print so our @media print CSS kicks in (footer + decision UI hidden).
 */
async function renderPagePdf(pageUrl: string, outPath: string): Promise<void> {
  const bin = findChromeBinary()
  if (!bin) throw new Error('no chrome binary found on PATH (need google-chrome / chromium)')
  return new Promise<void>((resolve, reject) => {
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-pdf-header-footer',
      '--default-background-color=00000000',
      '--virtual-time-budget=10000',
      `--print-to-pdf=${outPath}`,
      pageUrl,
    ]
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (b) => { stderr += b.toString('utf8') })
    const timeout = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch {}
      reject(new Error(`chrome PDF timeout after ${PDF_TIMEOUT_MS}ms`))
    }, PDF_TIMEOUT_MS)
    proc.on('exit', (code) => {
      clearTimeout(timeout)
      if (code === 0 && existsSync(outPath)) resolve()
      else reject(new Error(`chrome exited ${code}: ${stderr.slice(-300)}`))
    })
    proc.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

function startHttpServer(): Server {
  if (httpServer) return httpServer
  const bunServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)

      // POST /docs/<slug>/decide — one-tap approve from the rendered page
      const decideMatch = url.pathname.match(/^\/docs\/([a-zA-Z0-9_-]+)\/decide\/?$/)
      if (decideMatch && req.method === 'POST') {
        const slug = decideMatch[1]!
        const mdPath = join(DOCS_DIR, `${slug}.md`)
        if (!existsSync(mdPath)) {
          return new Response('slug not found', { status: 404 })
        }
        // Approvals are one-shot — if there's already a record, don't fire
        // the callback a second time (would spam Claude with duplicates).
        if (readDecision(slug)) {
          return new Response('already approved', { status: 409 })
        }

        // We ignore the request body entirely. The page only POSTs
        // {decision: "approve"} but that's cosmetic; any POST to this path
        // is interpreted as "approve".

        const record: Decision = { decision: 'approve', timestamp: Date.now() }
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

        return new Response(JSON.stringify({ ok: true, slug, decision: 'approve' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      // POST /docs/<slug>/send-pdf — render the doc to PDF, deliver to original chat
      const pdfMatch = url.pathname.match(/^\/docs\/([a-zA-Z0-9_-]+)\/send-pdf\/?$/)
      if (pdfMatch && req.method === 'POST') {
        const slug = pdfMatch[1]!
        const mdPath = join(DOCS_DIR, `${slug}.md`)
        if (!existsSync(mdPath)) return new Response('slug not found', { status: 404 })
        const link = getSlugChat(slug)
        if (!link) return new Response('this page has no chat link', { status: 412 })
        const pdfPath = join(DOCS_DIR, `${slug}.pdf`)
        const pageUrl = `http://127.0.0.1:${httpServer?.port ?? ''}/docs/${slug}`
        try {
          await renderPagePdf(pageUrl, pdfPath)
        } catch (err) {
          process.stderr.write(`wechat channel: PDF render failed for ${slug}: ${err}\n`)
          return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } })
        }
        if (!pdfRequestCallback) {
          return new Response(JSON.stringify({ ok: false, error: 'no PDF delivery callback registered' }), { status: 503, headers: { 'Content-Type': 'application/json' } })
        }
        try {
          const title = titleFromMarkdown(readFileSync(mdPath, 'utf8'), slug)
          await pdfRequestCallback({ slug, title, chatId: link.chatId, accountId: link.accountId, pdfPath })
        } catch (err) {
          process.stderr.write(`wechat channel: PDF deliver failed for ${slug}: ${err}\n`)
          return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } })
        }
        return new Response(JSON.stringify({ ok: true, slug }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }

      // GET /docs/<slug>/download — serve the raw .md as an attachment
      const dlMatch = url.pathname.match(/^\/docs\/([a-zA-Z0-9_-]+)\/download\/?$/)
      if (dlMatch && req.method === 'GET') {
        const slug = dlMatch[1]!
        const mdPath = join(DOCS_DIR, `${slug}.md`)
        if (!existsSync(mdPath)) return new Response('Not found', { status: 404 })
        let raw: string
        try { raw = readFileSync(mdPath, 'utf8') }
        catch { return new Response('Read error', { status: 500 }) }
        return new Response(raw, {
          status: 200,
          headers: {
            'Content-Type': 'text/markdown; charset=utf-8',
            'Content-Disposition': `attachment; filename="${slug}.md"`,
            'X-Robots-Tag': 'noindex, nofollow',
          },
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
export interface ShareOpts {
  /**
   * Render the one-tap "✓ Approve" button on the page.
   * Default false — most pages are content-only summaries; the approve
   * button on those is misleading because there's nothing to ok.
   * Set true for pages that genuinely want a soft acknowledgement signal
   * back to Claude (the existing decision-callback path).
   */
  needs_approval?: boolean
  /**
   * Bind the page to a chat so the rendered footer can offer "📄 发我 PDF":
   * server-side renders the page to PDF and pushes it to this chat via
   * sendFile. Required for the PDF button to appear; without it the page
   * is anonymous and the button is hidden.
   */
  chat_id?: string
  account_id?: string
}

export async function sharePage(
  title: string,
  content: string,
  opts: ShareOpts = {},
): Promise<SharePageResult> {
  cleanupOldDocs()

  const slug = slugify(title)
  const path = join(DOCS_DIR, `${slug}.md`)
  const body = /^#\s+/m.test(content) ? content : `# ${title}\n\n${content}`
  writeFileSync(path, body, { mode: 0o600 })
  if (opts.needs_approval) markNeedsApproval(slug)
  if (opts.chat_id) linkSlugToChat(slug, opts.chat_id, opts.account_id)

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
