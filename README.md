<h1 align="center">wechat-cc</h1>

<p align="center">
  <b>A WeChat channel plugin for Claude Code — bridge WeChat messages in and out of your Claude Code session via the ilink bot API.</b>
</p>

<p align="center">
  <img alt="version"  src="https://img.shields.io/badge/version-0.2.0-blue">
  <img alt="platform" src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey">
  <img alt="runtime"  src="https://img.shields.io/badge/runtime-Bun-black">
  <img alt="license"  src="https://img.shields.io/badge/license-MIT-green">
  <a href="https://github.com/ggshr9/wechat-cc/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ggshr9/wechat-cc/actions/workflows/ci.yml/badge.svg"></a>
</p>

<p align="center">
  English | <a href="./README.zh.md">中文</a>
</p>

> Unofficial. Built on the ilink bot protocol (`https://ilinkai.weixin.qq.com`). Each QR scan binds one 1:1 bot — this is an ilink limitation; group chat is not supported.

## Features

- QR-code login, multi-account (each scanner = one independent bot, one `accounts/<bot_id>/` dir)
- MCP server exposing channel tools: `reply`, `edit_message`, `broadcast`, `send_file`, `set_user_name`, `share_page`, `resurface_page`
- `share_page` publishes long markdown (plans, specs, review docs) to a public cloudflared quick-tunnel URL so the WeChat user can tap and read rendered content on their phone. Rendered pages include a single one-tap Approve button at the bottom for non-Claude stakeholders to acknowledge ("read it, looks good, don't wait on me") — clicks arrive back as MCP notifications
- `resurface_page` re-opens a previously shared document on the current tunnel when its original URL has died (tunnel URLs are per-run)
- Text, image, file and video delivery (CDN upload/download + AES-128-ECB encryption)
- Inbox directory for incoming media (paths surfaced in message metadata)
- Allowlist-based access control (persisted to `~/.claude/channels/wechat/access.json`)
- Live log monitor at `http://localhost:3456` (`wechat-cc logs`)
- Built-in WeChat slash commands: `/help`, `/status`, `/ping`, `/users`, `/restart`, `@all`, `@<name>`
- Auto-prompts Claude to ask for a name when a new sender appears; stored via `set_user_name`

## Install

Requirements:

- [Bun](https://bun.sh) (tested with 1.1+)
- [Claude Code CLI](https://github.com/anthropics/claude-code)

Optional:

- `expect(1)` — lets WeChat-triggered `/restart` auto-confirm Claude Code's
  `--dangerously-load-development-channels` dialog so nobody has to sit at the
  terminal and press Enter. Without it, `/restart` will relaunch `claude`
  normally but the session will stall on the dialog until a human intervenes.
  Install with `apt install expect` / `brew install expect`.
- `cloudflared` — used by the `share_page` tool to expose rendered markdown
  pages through a public quick tunnel (`*.trycloudflare.com`). **You don't
  need to install this yourself** — wechat-cc auto-downloads the matching
  static binary into `~/.claude/channels/wechat/bin/cloudflared` on first
  use. No Cloudflare account, no domain, no config. If you already have
  cloudflared on your `PATH` (e.g. `brew install cloudflared`), wechat-cc
  will reuse it instead of downloading.

**Windows note:** wechat-cc works on Windows (Bun 1.1+ supports it
natively). The `share_page` auto-download of `cloudflared.exe` and all
MCP tools function cross-platform. The only degradation is `/restart`
auto-confirmation of the dev-channel dialog — Windows has no `expect(1)`
equivalent, so you'll press Enter once in the terminal on restart. All
other functionality is identical to Linux/macOS.

Clone the repo and install deps:

```bash
git clone https://github.com/ggshr9/wechat-cc.git
cd wechat-cc
bun install
```

Link the plugin into Claude Code. The plugin lives at `~/.claude/plugins/local/wechat/`; either clone directly there or symlink:

```bash
mkdir -p ~/.claude/plugins/local
ln -s "$(pwd)" ~/.claude/plugins/local/wechat
```

Optional: add the CLI to your `$PATH`:

```bash
ln -s "$(pwd)/cli.ts" ~/.local/bin/wechat-cc
chmod +x ~/.local/bin/wechat-cc
```

## First-run setup

Each person who wants Claude to see their WeChat runs this **once**:

```bash
wechat-cc setup
```

A QR code prints in your terminal. Scan it with WeChat. On success, account state is written to `~/.claude/channels/wechat/accounts/<bot_id>/`. Repeat `wechat-cc setup` to bind additional accounts — each scan creates a separate directory and each is polled independently.

## Run

```bash
# Start Claude Code with the WeChat channel loaded, resuming the last session
wechat-cc run --dangerously

# Fresh session instead
wechat-cc run --fresh

# List already bound accounts
wechat-cc list

# Open the live log viewer in your browser
wechat-cc logs          # http://localhost:3456
wechat-cc logs 4567     # override port

# Pull latest code + reinstall deps if bun.lock changed.
# Running server keeps using old code until you /restart in WeChat
# (or Ctrl+C + wechat-cc run).
wechat-cc update
```

The WeChat `/status` command shows the current build SHA + commit subject and
whether you're behind `origin/master`. If you see "落后 N 个 commit", run
`wechat-cc update` in the terminal and then send `/restart` from WeChat.

Behind the scenes `run` invokes `claude --dangerously-load-development-channels server:wechat` (or equivalent) so the MCP server is loaded at startup.

## Access control

The channel is **allowlist-only by default** — WeChat messages from users not on the allowlist are dropped silently.

Inside Claude Code:

```
/wechat:access                        # show policy + allowlist
/wechat:access allow <user_id>        # add a sender (user IDs look like xxx@im.wechat)
/wechat:access remove <user_id>       # remove
/wechat:access policy disabled        # kill the channel entirely
```

Access mutations **must only come from requests typed in the terminal**. The `access` skill refuses to modify the allowlist if the request arrived via an inbound WeChat message (prompt-injection surface).

## Channel commands (from WeChat)

| Command                 | Effect                                                          |
|-------------------------|-----------------------------------------------------------------|
| `/help`                 | Show available commands                                         |
| `/status`               | Connection + account health                                     |
| `/ping`                 | Connectivity test                                               |
| `/users`                | List online (bound) users                                       |
| `/restart`              | Restart wechat-cc inheriting current flags (admin-only)         |
| `/restart --dangerously`| Restart and enable `--dangerously-skip-permissions`             |
| `/restart --fresh`      | Restart with a brand-new Claude session (no `--continue`)       |
| `@all msg`              | Broadcast to every connected user                               |
| `@名字 msg`             | Forward to a specific user (name from `set_user_name`)          |

**How `/restart` works:** `wechat-cc run` runs a supervisor loop. When an
admin sends `/restart` (optionally with flags), the server:

1. Writes `.restart-flag` (raw flag string) so `cli.ts` knows how to respawn.
2. Writes `.restart-ack` with `{chat_id, account_id, flags, requested_at}`
   so the *next* server boot knows to greet the requester.
3. Sends "正在重启…约 5 秒后重连" through the same bot.
4. SIGTERMs the `claude` ancestor.

The CLI supervisor catches `claude`'s exit, re-reads `.restart-flag`, and
respawns. On the relaunch path, `claude` is wrapped in `expect(1)` which
sprays `\r` via three `after` timers (800ms / 2000ms / 4000ms) to
auto-confirm the `--dangerously-load-development-channels` dialog — no
human needs to be at the terminal. If `expect` is not installed the
respawn still works but will stall on that dialog until someone presses
Enter (a soft warning is printed at `wechat-cc run` startup).

Once the new server's poll loops are up, it reads `.restart-ack`, finds
the account that originally handled the `/restart`, and sends
"已重连（flags）用时约 Ns" back to the requester, then deletes the
marker. The Claude session itself resumes via `--continue` unless
`--fresh` was passed.

## Sharing long docs (`share_page` / `resurface_page`)

WeChat text messages can't render markdown — code blocks, tables, and
nested lists collapse into a wall of text that's unusable on a phone.
The `share_page` MCP tool solves this by publishing a markdown document
to a short-lived URL that renders properly in the user's phone browser.

**How it works:**

1. Claude calls `share_page({ title, content, chat_id? })`.
2. The content is written to `~/.claude/channels/wechat/docs/<slug>.md`.
3. wechat-cc spawns a local `Bun.serve` on an ephemeral port that
   renders `/docs/<slug>` via `marked` with a clean desktop+mobile
   stylesheet plus a **single one-tap Approve button** at the bottom
   of every page.
4. On the first call, `cloudflared` is started as a subprocess with
   `tunnel --url http://localhost:<port>` — no Cloudflare account or
   domain needed. wechat-cc parses the assigned
   `https://<words>.trycloudflare.com` URL from its log and caches it
   for the session. If `cloudflared` isn't on `PATH`, wechat-cc
   auto-downloads the matching static binary to
   `~/.claude/channels/wechat/bin/cloudflared` (30 MB, one-time).
5. `share_page` returns `https://<tunnel>.trycloudflare.com/docs/<slug>`.
   If `chat_id` is provided it auto-sends a WeChat message with
   title + preview + URL. If omitted, defaults to the first admin
   from `access.json` so "share this with me" from a terminal context
   just works.

**Approve:** The embedded button is aimed at stakeholders *outside*
the Claude session. Workflow: Claude generates a plan, shares it, you
forward the URL to your supervisor via WeChat/email/whatever. The
supervisor taps the URL, reads the plan, and clicks Approve. The click
POSTs back through the same tunnel to wechat-cc's local server, which
writes a per-slug `.decision.json` and fires an MCP notification so
Claude sees the acknowledgement as inbound channel feedback (tagged
`share_page:<slug>`). The page then shows a persistent "Approved ✓"
banner on subsequent visits. No authentication beyond the random URL —
adequate for personal / small-team sign-off, not for access-controlled
workflows.

There is deliberately no reject or comment UI. If a reviewer needs to
push back or explain, they can message the URL owner directly — a
WeChat thread carries context much better than a form field, and
wechat-cc is already the transport. Keeping the page approve-only also
avoids a misleading "I explained in the form but nothing happens" UX
for the reviewer.

**`share_page` is a publishing step, not an approval gate.** It doesn't
block Claude's execution. If you need an explicit y/n gate, that still
goes through the normal permission-request flow (🔐 prompts in WeChat).
The two mechanisms are deliberately separate.

**Resurface:** cloudflared quick-tunnel URLs only live for one
wechat-cc run. When you reference a plan from yesterday whose URL no
longer resolves, ask Claude to reopen it — Claude calls
`resurface_page({ slug? , title_fragment? })` and gets a fresh working
URL on the current tunnel for the same underlying `.md` file.

**Retention:** shared `.md` files (and their `.decision.json` siblings)
are auto-deleted after 7 days. If you need to archive a plan
long-term, copy it somewhere else yourself — wechat-cc is a transport,
not an archive store.

**Caveats:**

- The URL is publicly reachable by anyone who gets it. Do **not** put
  secrets (credentials, API keys, internal strategy) in a shared page.
  The slug is random enough (4-word subdomain + timestamp suffix) to
  resist brute force but is not an authorization control.
- Anyone with the URL can also submit Approve — that's by design
  (external-reviewer use case) but means the URL itself is your trust
  boundary. Treat it as a bearer credential.
- URLs are ephemeral: when `wechat-cc run` exits, cloudflared dies and
  the URL stops resolving. Use `resurface_page` to re-expose old pages
  on a new tunnel.
- Cloudflare's quick tunnels are officially labeled non-production —
  fine for personal/small-team use, not suitable for high traffic.
- Content does transit through Cloudflare's edge. If that's a problem
  you can either (a) only use `share_page` for non-sensitive content,
  which is the intended model, or (b) opt out by removing the tool
  from `server.ts`.

## State layout

```
~/.claude/channels/wechat/
├── access.json            # allowlist
├── context_tokens.json    # ilink context tokens (needed to initiate outbound messages)
├── user_names.json        # chat_id → display name
├── channel.log            # rolling log (auto-rotated to .1 at 10 MB)
├── server.pid             # single-instance lock
├── .restart-flag          # transient: raw flags for cli.ts on /restart
├── .restart-ack           # transient: next-boot greeting marker
├── docs/                  # share_page .md bodies + .decision.json siblings (7-day TTL)
├── bin/
│   └── cloudflared        # auto-downloaded on first share_page call (.exe on Windows)
├── inbox/                 # downloaded media (30-day TTL, auto-cleaned on startup)
└── accounts/
    └── <bot_id>/
        ├── account.json
        └── token          # bot bearer token, mode 0600
```

None of this is committed — it's all under `~/.claude/`, outside the repo.

## Architecture notes

- **Receive**: long-polling `POST /ilink/bot/getupdates` per account
- **Send**: `POST /ilink/bot/sendmessage` — outbound to a user requires a `context_token`; ilink won't deliver to anyone who hasn't sent at least one "hi" first
- **Typing indicator**: `/ilink/bot/sendtyping` fired on inbound, ticket cached ~60 s
- **Dedup**: `from_user_id:create_time_ms` key guards against at-least-once delivery
- **Media**: CDN upload/download with AES-128-ECB encryption
- **Retry**: outbound send retries 3× on timeout or 5xx, 1 s spacing

## Known limitations

- `context_token` bootstrap: you can't message a user who has never messaged the bot first
- Channel currently resets message history on server restart (no SQLite persistence)
- Session expiry / unauthorized sender flows silently drop messages today
- `cdn.ilinkai.weixin.qq.com` base URL is hardcoded — may need to be derived from account in the future

## Uninstall

```bash
# 1. Remove the Claude Code plugin symlink
rm ~/.claude/plugins/local/wechat

# 2. Remove the CLI symlink (if you added one)
rm ~/.local/bin/wechat-cc

# 3. Wipe all bound accounts, tokens, logs and inbox
rm -rf ~/.claude/channels/wechat

# 4. Drop the wechat entry from any project's .mcp.json
#    (edit the file and delete the "wechat" key under mcpServers)
```

## Disclaimer

Unofficial plugin. Not affiliated with, endorsed by, or sponsored by Tencent or WeChat. The ilink bot protocol is a third-party interface — automated WeChat access may violate the WeChat Terms of Service and can result in account suspension. Use at your own risk.

## License

MIT — see [LICENSE](./LICENSE).
