#!/usr/bin/env bun
/**
 * WeChat channel log viewer — simple web dashboard
 * Usage: bun log-viewer.ts [port]
 */

import { readFileSync, watchFile, existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const STATE_DIR = join(homedir(), '.claude', 'channels', 'wechat')
const LOG_FILE = join(STATE_DIR, 'channel.log')
const PORT = parseInt(process.argv[2] ?? '3456')

const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>WeChat Channel Monitor</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #1a1a2e; color: #e0e0e0; font-family: 'SF Mono', 'Cascadia Code', monospace; font-size: 13px; }
  #header { background: #16213e; padding: 12px 20px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #0f3460; position: sticky; top: 0; }
  #header h1 { font-size: 15px; color: #4ecca3; font-weight: 600; }
  #status { font-size: 12px; color: #888; }
  #stats { display: flex; gap: 20px; padding: 10px 20px; background: #16213e80; border-bottom: 1px solid #0f3460; font-size: 12px; }
  .stat { color: #4ecca3; }
  .stat span { color: #888; }
  #logs { padding: 10px; height: calc(100vh - 90px); overflow-y: auto; }
  .log-entry { padding: 4px 10px; border-radius: 3px; margin: 2px 0; white-space: pre-wrap; word-break: break-all; }
  .log-entry:hover { background: #ffffff08; }
  .ts { color: #666; }
  .tag-inbound { color: #4ecca3; }
  .tag-outbound { color: #e94560; }
  .tag-system { color: #f5a623; }
  .tag-error { color: #ff4444; background: #ff444410; }
  .tag-command { color: #a78bfa; }
  .user { color: #64b5f6; font-weight: 600; }
  #empty { color: #555; text-align: center; padding: 60px; }
  #auto { display: flex; align-items: center; gap: 6px; }
  #auto label { color: #888; font-size: 12px; cursor: pointer; }
</style>
</head>
<body>
<div id="header">
  <h1>WeChat Channel Monitor</h1>
  <div id="auto">
    <label><input type="checkbox" id="autoScroll" checked> 自动滚动</label>
    <label><input type="checkbox" id="autoRefresh" checked> 自动刷新</label>
    <span id="status">连接中...</span>
  </div>
</div>
<div id="stats"></div>
<div id="logs"><div id="empty">等待日志...</div></div>
<script>
const logsEl = document.getElementById('logs');
const statusEl = document.getElementById('status');
const statsEl = document.getElementById('stats');
let lastLen = 0;
let counts = { inbound: 0, outbound: 0, error: 0, command: 0 };

function classify(line) {
  if (line.includes('[INBOUND]')) return 'inbound';
  if (line.includes('[OUTBOUND]')) return 'outbound';
  if (line.includes('[ERROR]')) return 'error';
  if (line.includes('[CMD]')) return 'command';
  return 'system';
}

function formatLine(line) {
  return line
    .replace(/^(\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z?)/, '<span class="ts">$1</span>')
    .replace(/\\[(\\w+)]/, (m, tag) => '<span class="tag-' + classify(line) + '">[' + tag + ']</span>')
    .replace(/\\[([^\\]]+@im\\.wechat)]/, '<span class="user">[$1]</span>')
    .replace(/\\[([\\u4e00-\\u9fff]+)]/, '<span class="user">[$1]</span>');
}

function updateStats() {
  statsEl.innerHTML = [
    '<div class="stat"><span>收到</span> ' + counts.inbound + '</div>',
    '<div class="stat"><span>发出</span> ' + counts.outbound + '</div>',
    '<div class="stat"><span>命令</span> ' + counts.command + '</div>',
    counts.error > 0 ? '<div class="stat" style="color:#ff4444"><span>错误</span> ' + counts.error + '</div>' : '',
  ].join('');
}

async function poll() {
  if (!document.getElementById('autoRefresh').checked) {
    statusEl.textContent = '已暂停';
    return;
  }
  try {
    const res = await fetch('/api/logs?offset=' + lastLen);
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    if (data.lines.length > 0) {
      if (lastLen === 0) logsEl.innerHTML = '';
      for (const line of data.lines) {
        if (!line.trim()) continue;
        const tag = classify(line);
        counts[tag] = (counts[tag] || 0) + 1;
        const div = document.createElement('div');
        div.className = 'log-entry';
        div.innerHTML = formatLine(line);
        logsEl.appendChild(div);
      }
      updateStats();
      if (document.getElementById('autoScroll').checked) {
        logsEl.scrollTop = logsEl.scrollHeight;
      }
    }
    lastLen = data.offset;
    statusEl.textContent = '在线 · ' + new Date().toLocaleTimeString();
  } catch (e) {
    statusEl.textContent = '断开';
  }
}

setInterval(poll, 1000);
poll();
</script>
</body>
</html>`

// Simple HTTP server
Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === '/api/logs') {
      const offset = parseInt(url.searchParams.get('offset') ?? '0')
      try {
        const content = readFileSync(LOG_FILE, 'utf8')
        const newContent = content.slice(offset)
        const lines = newContent.split('\n').filter(l => l.trim())
        return Response.json({ lines, offset: content.length })
      } catch {
        return Response.json({ lines: [], offset: 0 })
      }
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    }

    return new Response('Not found', { status: 404 })
  },
})

console.log(`WeChat Channel Monitor: http://localhost:${PORT}`)
