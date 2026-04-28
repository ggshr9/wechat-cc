# Desktop v0.3.1 — reply-path fixes, share-page hardening, UX cleanup

A bugfix-heavy release. v0.3.0 looked working — the daemon stayed up,
typing indicators fired, the GUI reported healthy — but every wechat
turn silently failed: the user typed, saw 「正在输入...」, and never got a
reply back. Two independent regressions stacked on top of each other.
Both fixed here, plus the share-page race some users hit during early
testing and a wizard/dashboard UX pass.

## Reply path — the "正在输入 but no reply" symptoms

### 1. ilink `context_token` was never being captured

The v1.0 phase-1 daemon rewrite (commit `d48648e`) dropped the line of
code that wrote each inbound message's `context_token` into
`context_tokens.json`. Outbound `sendmessage` requires that token; without
it, ilink returns `errcode=-14: session timeout` and the reply never
lands.

`parseUpdates` now extracts `context_token` from the raw update,
`InboundMsg` carries it through, and `transport.captureContextToken`
refreshes `ctxStore` on every inbound. Refresh-on-change keeps disk writes
out of the hot path.

### 2. claude binary stuck in interactive mode

The bundled `claude` binary requires `CLAUDE_CODE_ENTRYPOINT=sdk-ts` in
its env to honor `--input-format=stream-json`. Without it, claude
initializes (the SDK sees the `system init` event), then sits there
ignoring stream-json input forever. The Claude Agent SDK *intends* to set
this on the spawned child's env, but inside the `bun --compile` build of
wechat-cc the propagation was unreliable.

Fix: `process.env.CLAUDE_CODE_ENTRYPOINT ??= 'sdk-ts'` at the very top of
the daemon entry, so every SDK spawn inherits it deterministically.

### 3. Duplicate replies ("2" + "已回复 2。")

Once #1 + #2 were fixed, replies started landing — twice. The system
prompt tells Claude to use the `reply` MCP tool ("不要直接生成文本"), but
Claude also emits status-style plain text alongside its tool calls, and
`routeInbound` was relaying that plain text as a second wechat message.

Fix: drop plain-text relay. Tool calls are the only outbound path. If the
model leaks status text, it's silently dropped.

## Share-page / PDF

- **404 on first link click** — `cloudflared` prints
  `https://*.trycloudflare.com` the moment Cloudflare's API hands out the
  URL, but the edge needs 1–3s to actually route. We were resolving the
  URL the instant it appeared, so the link was sent to wechat before it
  worked. Now `startTunnel` polls `${url}/healthz` (8s budget, 400ms
  cadence) before resolving.
- **PDF send → HTTP 500 on macOS, no PDF arrives** —
  `findChromeBinary()` only checked `$PATH`, but Chrome on macOS lives in
  `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, never
  on `$PATH`. Added darwin fallback for Google Chrome / Chromium / Edge /
  Brave / Arc bundle paths.
- **PDF send → HTTP 502, but PDF arrives** — render + ilink upload takes
  5–15s combined, and `cloudflared` 502s the response round-trip even
  when origin completes successfully. Server now validates prerequisites
  synchronously then queues render + delivery as fire-and-forget,
  returning 202 immediately. Button copy: 「正在生成…」 → 「已派发，PDF 稍后到达
  对话 ✓」.
- **PDF button label** — 「发 PDF 到微信」 → 「发 pdf 到对话」.

## Installer / GUI

### 开机自启 + 守护进程 split into two toggles

A single `autoStart` field used to control both `RunAtLoad` and
`KeepAlive` on macOS — there was no way to opt out of "launch at login"
while keeping crash-recovery. Per user request: now two independent
toggles.

| Toggle | What it does |
|:---|:---|
| **开机自启** (`autoStart`) | macOS `RunAtLoad`, systemd `enable --now`, schtasks ONLOGON. Daemon launches at login. |
| **守护进程** (`keepAlive`, default 推荐打开) | macOS `KeepAlive`, systemd `Restart=always`. Daemon respawns on crash. |

Backwards-compat: pre-2026-04-28 configs with only `autoStart` get
`keepAlive ?? autoStart`, preserving existing behavior. CLI gains
`--keep-alive true|false`.

### Dashboard goes edge-to-edge

The dashboard was capped at `max-width: 1280px` inside a bordered card
with rounded corners and a shadow — fine on a laptop, cramped on a wider
monitor. Per user request ("最好感觉是无框的"): drop the frame, fill the
window. Wizard mode unchanged (focused setup flow benefits from the
narrow column).

### Wizard copy cleanup

- Drop redundant lines: 「扫码不会自动开始——点上方按钮再生成」, 「（Claude 见
  ~/.claude/settings.json，Codex 见自己的 config）」.
- Shorten primary CTAs: 「继续扫码」 / 「继续后台运行」 → 「继续」.
- Hide `#qr-raw-toggle` once binding succeeds — the right-column 「已绑定」
  badge is sufficient feedback.

## Verification

- 561 vitest pass across 53 suites (was 551 in v0.3.0; +10 covering
  context_token passthrough, transport.captureContextToken, agent-config
  keepAlive migration, service-manager toggle decoupling).
- `tsc --noEmit` clean.
- Round-tripped on macOS aarch64: send wechat message → reply lands once;
  share_page link → page reachable on first click; PDF button → 「已派发」
  + PDF actually arrives in the chat.

## Install

| Platform | Bundle | Notes |
|:---|:---|:---|
| **macOS (Apple Silicon)** | `wechat-cc_0.3.1_aarch64.dmg` | Right-click → Open on first launch (or `xattr -cr /Applications/wechat-cc.app`) |
| **Windows (x64)** | `.exe` (NSIS) · `.msi` | SmartScreen → 更多信息 → 仍要运行 |
| **Linux (x64)** | `.deb` · `.rpm` | No warning |

Bundles still unsigned. macOS Intel still deferred (capacity issues with
free-tier `macos-13` runners — see v0.3.0 notes).

## Upgrading from v0.3.0

State at `~/.claude/channels/wechat/` is forward-compatible:
`agent-config.json` picks up the new `keepAlive` field via migration on
first read, no manual edit needed. Existing `context_tokens.json` is
unaffected — the daemon will refresh tokens on the next inbound from each
chat.
