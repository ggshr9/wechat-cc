<h1 align="center">wechat-cc</h1>

<p align="center">
  <b>Talk to your Claude Code session from WeChat on your phone.</b>
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

<!-- TODO: add a 4-panel screenshot or 30s demo video here -->

## Why?

- **Work away from your desk** — start a long Claude task on your computer, lock the screen, and keep interacting from WeChat on your phone
- **Share plans with non-technical people** — Claude generates a plan, you forward a rendered URL to your supervisor, they tap Approve on their phone
- **Multi-user access** — allow teammates to message your Claude session through their own WeChat, controlled by an allowlist

> Unofficial. Built on the ilink bot protocol. Each QR scan binds one 1:1 bot (ilink limitation; no group chat). Automated WeChat access may violate WeChat ToS — use at your own risk.

## Quick Start

Works on Linux, macOS, and Windows (PowerShell / Git Bash):

```bash
git clone https://github.com/ggshr9/wechat-cc.git ~/.claude/plugins/local/wechat
cd ~/.claude/plugins/local/wechat && bun install && bun link
wechat-cc setup              # scan QR with WeChat
wechat-cc run --fresh        # start Claude Code + WeChat channel
```

That's it. Send a message from WeChat and Claude will see it.

<details>
<summary><b>Detailed install instructions (Windows / manual steps / optional deps)</b></summary>

### Requirements

- [Bun](https://bun.sh) 1.1+ (`curl -fsSL https://bun.sh/install | bash`)
- [Claude Code CLI](https://github.com/anthropics/claude-code)

### Step-by-step

<details>
<summary>Linux / macOS</summary>

```bash
# Clone directly into the Claude Code plugin directory
git clone https://github.com/ggshr9/wechat-cc.git ~/.claude/plugins/local/wechat
cd ~/.claude/plugins/local/wechat
bun install

# Add `wechat-cc` command to your PATH
bun link

# Bind your WeChat (scan the QR code that appears)
wechat-cc setup

# Start
wechat-cc run --fresh
```

Optional: install `expect` for hands-free `/restart` from WeChat:
```bash
# Ubuntu/Debian
sudo apt install expect
# macOS
brew install expect
```
</details>

<details>
<summary>Windows</summary>

```powershell
# Clone directly into the Claude Code plugin directory
git clone https://github.com/ggshr9/wechat-cc.git "%USERPROFILE%\.claude\plugins\local\wechat"
cd "%USERPROFILE%\.claude\plugins\local\wechat"
bun install

# Add `wechat-cc` command to your PATH (creates wechat-cc.cmd)
bun link

# Bind your WeChat (scan the QR code that appears)
wechat-cc setup

# Start
wechat-cc run --fresh
```

Everything works on Windows. The only difference: `/restart` from WeChat requires you to press Enter once in the terminal (Windows has no `expect` equivalent for auto-confirmation).
</details>

### Optional dependencies

| Dependency | What it enables | Auto-installed? |
|:---|:---|:---:|
| `expect` | `/restart` from WeChat auto-confirms the dev-channel dialog | No — `apt install expect` / `brew install expect` |
| `cloudflared` | `share_page` publishes rendered markdown to a public URL | **Yes** — auto-downloaded on first use |

### Updating

```bash
wechat-cc update    # git pull + bun install if needed
```

Then send `/restart` from WeChat (or Ctrl+C + `wechat-cc run` in terminal) to pick up the new code.

WeChat's `/status` command shows your current version and whether you're behind `origin/master`.

</details>

## Features

- **WeChat as your Claude remote** — send text, images, files, and voice from your phone; Claude sees everything and replies in-chat
- **share_page** — long markdown (plans, specs, reviews) published as a phone-friendly rendered web page via cloudflared tunnel, with a one-tap Approve button for external reviewers
- **`/restart` from WeChat** — restart your Claude session without touching the terminal; auto-confirms the startup dialog on Linux/macOS
- **Allowlist access control** — only approved WeChat users can reach your Claude session
- **`wechat-cc update`** — one-command upgrade with version checking via `/status`

<details>
<summary><b>All features</b></summary>

- QR-code login, multi-account (each scanner = one independent bot)
- MCP server exposing channel tools: `reply`, `edit_message`, `broadcast`, `send_file`, `set_user_name`, `share_page`, `resurface_page`
- `resurface_page` re-opens old shared documents on the current tunnel when the original URL has expired
- Text, image, file and video delivery (CDN upload/download + AES-128-ECB encryption)
- Incoming media auto-downloaded to inbox (paths surfaced in message metadata)
- Small text files (csv, json, md, code) get an inline 5-line preview on arrival
- Live log monitor at `http://localhost:3456` (`wechat-cc logs`)
- Built-in WeChat slash commands: `/help`, `/status`, `/ping`, `/users`, `/restart`, `@all`, `@<name>`
- New users auto-prompted for their name; stored via `set_user_name`
- Voice messages with ilink transcription displayed inline; untranscribed audio saved to inbox with explicit "please retype" prompt
- Shared `.md` files auto-cleaned after 7 days; inbox media after 30 days; `channel.log` rotated at 10 MB
- `share_page` Approve button for out-of-band stakeholder sign-off (decision arrives back as MCP notification)
- Cross-platform: Linux, macOS, Windows — zero platform-specific code in the restart path
</details>

## Usage

```bash
wechat-cc setup              # scan QR to bind a WeChat account
wechat-cc run                # start (resumes last session)
wechat-cc run --fresh        # start a new session
wechat-cc run --dangerously  # skip all permission prompts
wechat-cc list               # show bound accounts
wechat-cc logs               # open live log viewer (http://localhost:3456)
wechat-cc update             # pull latest code + reinstall deps
```

### WeChat commands

| Command | Effect |
|:---|:---|
| `/help` | Show available commands |
| `/status` | Connection health + version + update check |
| `/ping` | Connectivity test |
| `/users` | List online users |
| `/restart` | Restart session (admin-only) |
| `/restart --fresh` | Restart with a brand-new session |
| `@all msg` | Broadcast to everyone |
| `@name msg` | Forward to a specific user |

## Access control

Allowlist-only by default. Manage from the terminal (never from WeChat, to prevent prompt injection):

```
/wechat:access                        # show policy + allowlist
/wechat:access allow <user_id>        # add a sender
/wechat:access remove <user_id>       # remove a sender
```

Users who scan the QR during `wechat-cc setup` are automatically added to the allowlist.

<details>
<summary><b>How /restart works</b></summary>

`wechat-cc run` runs a supervisor loop. When an admin sends `/restart`:

1. Server writes `.restart-flag` + `.restart-ack` marker files
2. Sends "正在重启…" acknowledgement via WeChat
3. `cli.ts` detects the flag via 500ms polling, kills the `claude` child process
4. Supervisor respawns claude (wrapped in `expect` on Linux/macOS to auto-confirm the dev-channel dialog)
5. New server boots, reads `.restart-ack`, sends "已重连（flags）用时约 Ns" back to the requester

The kill flows downward (cli.ts → claude → server) via `child.kill()`, requiring zero platform-specific process-tree walking. Works identically on Linux, macOS, and Windows.
</details>

<details>
<summary><b>How share_page works</b></summary>

WeChat can't render markdown. `share_page` solves this by publishing content to a short-lived public URL:

1. Claude calls `share_page({ title, content, chat_id? })`
2. Content written to `~/.claude/channels/wechat/docs/<slug>.md`
3. Local `Bun.serve` renders `/docs/<slug>` via `marked` with mobile-friendly CSS
4. `cloudflared tunnel` exposes the local server to `*.trycloudflare.com` (auto-downloaded on first use, no account needed)
5. URL sent to WeChat with title + preview

Each page has a single **Approve** button for external reviewers (e.g. a supervisor you forwarded the URL to). Clicks POST back through the tunnel and arrive as MCP notifications. No reject/comment UI by design — pushback goes through normal WeChat conversation.

`share_page` is a publishing tool, not an approval gate. For explicit y/n decisions, use Claude's built-in permission-request flow.

`resurface_page` re-opens old docs on a new tunnel when the original URL has died (URLs are per-session). Shared files auto-delete after 7 days.
</details>

## State layout

```
~/.claude/channels/wechat/
├── access.json            # allowlist
├── context_tokens.json    # ilink context tokens
├── user_names.json        # chat_id → display name
├── channel.log            # rolling log (10 MB rotation)
├── server.pid             # single-instance lock
├── .restart-flag          # transient: restart flags
├── .restart-ack           # transient: reconnect greeting marker
├── docs/                  # share_page .md + .decision.json (7-day TTL)
├── bin/cloudflared        # auto-downloaded (.exe on Windows)
├── inbox/                 # downloaded media (30-day TTL)
└── accounts/<bot_id>/     # per-account credentials
```

All state lives under `~/.claude/` — nothing is committed to the repo.

<details>
<summary><b>Architecture notes</b></summary>

- **Receive**: long-polling `POST /ilink/bot/getupdates` per account
- **Send**: `POST /ilink/bot/sendmessage` — requires a `context_token` (user must message the bot first)
- **Typing indicator**: `/ilink/bot/sendtyping`, ticket cached ~60s
- **Dedup**: `from_user_id:create_time_ms` guards against at-least-once redelivery
- **Media**: CDN upload/download with AES-128-ECB encryption
- **Retry**: outbound send retries 3× on timeout or 5xx
</details>

## Known limitations

- **First contact**: you can't message a WeChat user who hasn't sent at least one message to the bot first (ilink requires a `context_token` from their side)
- **Claude forgets WeChat context on restart**: your WeChat chat history stays on your phone, but Claude starts with a fresh context after `/restart` or `wechat-cc run` — it won't remember what was discussed in the previous session unless you use `--continue` (which resumes Claude's own session, not the WeChat thread)

## Uninstall

<details>
<summary>Linux / macOS</summary>

```bash
rm ~/.claude/plugins/local/wechat     # remove plugin symlink
rm -rf ~/.claude/channels/wechat      # wipe all state, accounts, logs
```
</details>

<details>
<summary>Windows (PowerShell)</summary>

```powershell
Remove-Item "$env:USERPROFILE\.claude\plugins\local\wechat"              # remove plugin
Remove-Item "$env:USERPROFILE\.claude\channels\wechat" -Recurse -Force   # wipe all state
```
</details>

## Disclaimer

Unofficial plugin. Not affiliated with, endorsed by, or sponsored by Tencent or WeChat. The ilink bot protocol is a third-party interface — automated WeChat access may violate the WeChat Terms of Service and can result in account suspension. **Use at your own risk.**

## License

MIT — see [LICENSE](./LICENSE).
