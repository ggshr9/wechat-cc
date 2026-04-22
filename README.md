<h1 align="center">wechat-cc</h1>

<p align="center">
  <b>Talk to your Claude Code session from WeChat on your phone.</b>
</p>

<p align="center">
  <img alt="version"  src="https://img.shields.io/badge/version-1.0.0-blue">
  <img alt="platform" src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey">
  <img alt="runtime"  src="https://img.shields.io/badge/runtime-Bun-black">
  <img alt="license"  src="https://img.shields.io/badge/license-MIT-green">
  <a href="https://github.com/ggshr9/wechat-cc/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ggshr9/wechat-cc/actions/workflows/ci.yml/badge.svg"></a>
</p>

<p align="center">
  English | <a href="./README.zh.md">中文</a>
</p>

<!-- TODO: add a 4-panel screenshot or 30s demo video here -->

## What changed in v1.0

wechat-cc has been rebuilt from the ground up as a standalone Bun daemon.

- **Agent SDK daemon** — wechat-cc now drives Claude through `@anthropic-ai/claude-agent-sdk` (v0.2.116 pinned) instead of running as a Claude Code MCP Channel. There is no `--dangerously-load-development-channels` dialog on launch.
- **Per-project session pool** — each registered project keeps a warm Claude session. Switching projects is instant; you don't restart Claude, you switch between running sessions.
- **`/restart` removed from WeChat** — was a persistent source of death loops on Windows (ilink message replay + Windows process-tree semantics). Use `/project switch` or restart the daemon manually (`Ctrl+C` + `wechat-cc run`).
- **`--fresh` / `--continue` / `--dangerously` CLI flags** — accepted but ignored with a warning. Sessions are managed by the daemon; use `/project switch` to start a fresh context in a different project, or wipe `~/.claude/channels/wechat/sessions/` manually.
- **State files preserved** — `accounts/`, `projects.json`, `context_tokens.json`, `user_names.json`, `user_account_ids.json` are all backward compatible. No re-scan required.

**Upgrading from v0.x:**
```bash
cd ~/.claude/plugins/local/wechat
git pull && bun install
wechat-cc run
```

---

## Why?

- **Work away from your desk** — start a long Claude task on your computer, lock the screen, and keep interacting from WeChat on your phone
- **Share plans with non-technical people** — Claude generates a plan, you forward a rendered URL to your supervisor, they tap Approve on their phone
- **Multi-user access** — allow teammates to message your Claude session through their own WeChat, controlled by an allowlist

> Works with [Claude Code](https://github.com/anthropics/claude-code). Also configurable via [cc-switch](https://github.com/farion1231/cc-switch).

---

## Table of Contents

- [What changed in v1.0](#what-changed-in-v10)
- [Quick Start](#quick-start)
- [Features](#features)
- [Usage](#usage)
- [Access Control](#access-control)
- [State Layout](#state-layout)
- [Known Limitations](#known-limitations)
- [Uninstall](#uninstall)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [Disclaimer](#disclaimer)

---

## Quick Start

**Prerequisites:** [Git](https://git-scm.com), [Bun](https://bun.sh) 1.1+, and [Claude Code CLI](https://github.com/anthropics/claude-code).

- Install Bun (Linux/macOS): `curl -fsSL https://bun.sh/install | bash`
- Install Bun (Windows PowerShell): `irm bun.sh/install.ps1 | iex`
- Install Git (Windows): `winget install Git.Git`

> After installing Bun or Git on Windows, **reopen your terminal** before continuing — the PATH doesn't update in the current session.

**Linux / macOS:**
```bash
git clone https://github.com/ggshr9/wechat-cc.git ~/.claude/plugins/local/wechat
cd ~/.claude/plugins/local/wechat && bun install && bun link
wechat-cc setup              # scan QR with WeChat
wechat-cc run                # start the daemon
```

**Windows (PowerShell):**
```powershell
git clone https://github.com/ggshr9/wechat-cc.git "$env:USERPROFILE\.claude\plugins\local\wechat"
cd "$env:USERPROFILE\.claude\plugins\local\wechat"
bun install
bun link
wechat-cc setup              # scan QR with WeChat
wechat-cc run                # start the daemon
```

That's it. Send a message from WeChat and Claude will see it.

> Each QR scan binds one 1:1 bot (ilink limitation; group chat is not supported). Users who scan are automatically added to the allowlist.

<details>
<summary><b>Detailed install instructions (platform-specific / optional deps)</b></summary>

### Step-by-step

<details>
<summary>Linux / macOS</summary>

```bash
# Clone directly into the Claude Code plugin directory
git clone https://github.com/ggshr9/wechat-cc.git ~/.claude/plugins/local/wechat
cd ~/.claude/plugins/local/wechat
bun install

# Add the `wechat-cc` command to your PATH
bun link

# Bind your WeChat (scan the QR code that appears)
wechat-cc setup

# Start
wechat-cc run
```

After `bun link`, if `wechat-cc` is not found, open a new terminal (PATH refresh needed).
</details>

<details>
<summary>Windows</summary>

```powershell
# Clone directly into the Claude Code plugin directory
git clone https://github.com/ggshr9/wechat-cc.git "$env:USERPROFILE\.claude\plugins\local\wechat"
cd "$env:USERPROFILE\.claude\plugins\local\wechat"
bun install

# Add the `wechat-cc` command to your PATH (creates wechat-cc.cmd)
bun link

# If `wechat-cc` is not found after `bun link`, open a new PowerShell window.

# Bind your WeChat (scan the QR code that appears)
wechat-cc setup

# Start
wechat-cc run
```

Everything works on Windows. `/restart` from WeChat is not supported on Windows (removed in v1.0); restart the daemon manually with `Ctrl+C` + `wechat-cc run`.
</details>

### Optional dependencies

| Dependency | What it enables | Auto-installed? |
|:---|:---|:---:|
| `cloudflared` | `share_page` publishes rendered markdown to a public URL | **Yes** — auto-downloaded on first use |

### Updating

```bash
wechat-cc update    # git pull + bun install if needed
```

Then restart the daemon (`Ctrl+C` + `wechat-cc run`) to pick up the new code. `/status` in WeChat shows your current version and whether updates are available.

### Using with cc-switch

[cc-switch](https://github.com/farion1231/cc-switch) is a desktop app that manages MCP servers, API keys, and plugins for Claude Code and other AI CLI tools through a visual interface. If you use cc-switch, you can register wechat-cc from its MCP management page instead of editing `.mcp.json` by hand:

| Field | Value |
|:---|:---|
| Name | `wechat` |
| Transport | `stdio` |
| Command | `bun` |
| Args | `run`, `--cwd`, `~/.claude/plugins/local/wechat`, `--silent`, `start` |

cc-switch writes this into Claude's `mcpServers` config. The effect is identical to running `wechat-cc install` — Claude Code picks up the MCP server on next launch.

You still need to clone the repo + `bun install` + `wechat-cc setup` (QR scan) separately. cc-switch handles the MCP registration, not the plugin installation.

</details>

---

## Features

- **WeChat as your Claude remote** — send text, images, files, and voice from your phone; Claude sees everything and replies in-chat
- **share_page** — publish long markdown (plans, specs, reviews) as a rendered web page via cloudflared tunnel, with a one-tap Approve button for external reviewers
- **Multi-project switching** — send `切到 sidecar` or `/project switch sidecar`; the per-project session pool keeps all projects warm so switching is instant, and a handoff pointer lets conversations continue across projects
- **Allowlist access control** — only approved WeChat users can reach your Claude session
- **`wechat-cc update`** — one-command upgrade with version checking via `/status`
- **CLI fallback** — `wechat-cc reply "..."` sends from any terminal using the same routing/session state, so you can still reach WeChat when the daemon is down

<details>
<summary><b>All features</b></summary>

- QR-code login, multi-account (each scanner = one independent bot)
- MCP server exposing channel tools: `reply`, `edit_message`, `broadcast`, `send_file`, `set_user_name`, `share_page`, `resurface_page`, `list_projects`, `switch_project`, `add_project`, `remove_project` (project-management tools are admin-gated identically to the `/project` command path)
- `resurface_page` re-opens old shared documents on the current tunnel when the original URL has expired
- Text, image, file and video delivery (CDN upload/download + AES-128-ECB encryption)
- Incoming media auto-downloaded to inbox (paths surfaced in message metadata)
- Small text files (csv, json, md, code) get an inline 5-line preview on arrival
- Live log monitor at `http://localhost:3456` (`wechat-cc logs`)
- Built-in WeChat commands: `/help`, `/status`, `/ping`, `/users`, `@all`, `@<name>`
- New users auto-prompted for their name; stored via `set_user_name`
- Voice messages with ilink transcription displayed inline; untranscribed audio saved to inbox
- Shared `.md` files auto-cleaned after 7 days; inbox media after 30 days; `channel.log` rotated at 10 MB
- Cross-platform: Linux, macOS, Windows
</details>

---

## Usage

```bash
wechat-cc setup              # scan QR to bind a WeChat account
wechat-cc run                # start the daemon (resumes warm sessions)
wechat-cc list               # show bound accounts
wechat-cc logs               # open live log viewer (http://localhost:3456)
wechat-cc update             # pull latest code + reinstall deps
wechat-cc reply "message"    # send from terminal when daemon is down
wechat-cc install --user     # register wechat at user scope (works in every project)
```

> `--fresh`, `--continue`, and `--dangerously` are accepted for backward compatibility but ignored with a warning. Session lifecycle is managed by the daemon.

### CLI fallback: `wechat-cc reply`

If the MCP channel is unavailable (server crashed, or Claude Code not running) you can still reply from any terminal:

```bash
wechat-cc reply "I'll be back in 10 min"          # → most-recently-active chat
wechat-cc reply --to <chat_id> "specific user"    # → specific chat
echo "piped text" | wechat-cc reply               # → stdin pipe
```

The CLI reads the same `~/.claude/channels/wechat/` state (accounts, context tokens, user→account routing) as the running server, so recipient resolution and session continuity are identical. This makes the state files the single source of truth — you never lose a thread just because the MCP server restarted.

### Multi-project switching

If you maintain several projects, register them once and switch between them from WeChat.

**One-time setup (install MCP at user scope so it works across all projects):**

```bash
wechat-cc install --user    # writes ~/.claude.json, no per-project .mcp.json needed
```

**Register your projects** (admin-only, type in WeChat):

```
/project add /home/u/Documents/compass compass
/project add /home/u/Documents/compass-wechat-sidecar sidecar
```

**Switch** (natural language or command):

```
切到 sidecar                 # natural language — Claude parses intent
/project switch sidecar      # exact command form
/project list                # show all registered projects
/project status              # show current project
```

Switching takes ~5-10 seconds. WeChat messages sent during the window are buffered by ilink and delivered after reconnect — no messages lost. The new session sends a confirmation ("已切到 X (from Y, took Ns)") so you know the switch landed.

**How handoff context works:** On switch, wechat-cc writes a small pointer file `<target>/memory/_handoff.md` referencing the source project's session transcript. If you later reference the prior conversation ("刚才聊的 xxx"), Claude looks up the pointer and reads the source jsonl on demand. Nothing is eagerly copied across projects.

See `docs/specs/2026-04-18-project-switch-design.md` for the full design.

### WeChat commands

| Command | Effect |
|:---|:---|
| `/help` | Show available commands |
| `/status` | Connection health + version + update check |
| `/ping` | Connectivity test |
| `/users` | List online users |
| `/project add <path> <alias>` | Register a project (admin-only) |
| `/project list` | List all registered projects |
| `/project switch <alias>` | Switch to a registered project (admin-only) |
| `/project status` | Show current project alias + cwd |
| `/project remove <alias>` | Unregister a project (admin-only) |
| `@all msg` | Broadcast to everyone |
| `@name msg` | Forward to a specific user |

<details>
<summary><b>Restarting the daemon</b></summary>

In v1.0 there is no `/restart` WeChat command. To restart the daemon:

```bash
# Linux / macOS / Windows (any terminal)
Ctrl+C
wechat-cc run
```

All registered project sessions resume automatically. No re-scan required.
</details>

<details>
<summary><b>How share_page works</b></summary>

WeChat can't render markdown. `share_page` publishes content to a short-lived public URL:

1. Claude calls `share_page({ title, content, chat_id? })`
2. Content written to `~/.claude/channels/wechat/docs/<slug>.md`
3. Local `Bun.serve` renders `/docs/<slug>` via `marked` with mobile-friendly CSS
4. `cloudflared tunnel` exposes the local server to `*.trycloudflare.com` (auto-downloaded, no account needed)
5. URL sent to WeChat with title + preview

Each page has a single **Approve** button for external reviewers. No reject/comment UI — pushback goes through normal WeChat conversation.

`resurface_page` re-opens old docs on a new tunnel when the original URL has died. Shared files auto-delete after 7 days.
</details>

---

## Access control

Allowlist-only by default. Manage from the terminal (never from WeChat, to prevent prompt injection):

```
/wechat:access                        # show policy + allowlist
/wechat:access allow <user_id>        # add a sender
/wechat:access remove <user_id>       # remove a sender
```

Users who scan the QR during `wechat-cc setup` are automatically added to the allowlist.

---

## State layout

```
~/.claude/channels/wechat/
├── access.json            # allowlist
├── context_tokens.json    # ilink context tokens
├── user_names.json        # chat_id → display name
├── channel.log            # rolling log (10 MB rotation)
├── server.pid             # single-instance lock
├── docs/                  # share_page content (7-day TTL)
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
- **Retry**: outbound send retries 3x on timeout or 5xx
</details>

---

## Known limitations

- **First contact** — you can't message a WeChat user who hasn't sent at least one message to the bot first (ilink requires a `context_token` from their side)
- **Claude forgets WeChat context on daemon restart** — your WeChat chat history stays on your phone, but Claude starts with a fresh context after restarting the daemon — it won't remember what was discussed in the previous session (WeChat chat history is not replayed into Claude's context)

---

## Uninstall

<details>
<summary>Linux / macOS</summary>

```bash
rm -rf ~/.claude/plugins/local/wechat     # remove plugin
rm -rf ~/.claude/channels/wechat          # wipe all state, accounts, logs
```
</details>

<details>
<summary>Windows (PowerShell)</summary>

```powershell
Remove-Item "$env:USERPROFILE\.claude\plugins\local\wechat"              # remove plugin
Remove-Item "$env:USERPROFILE\.claude\channels\wechat" -Recurse -Force   # wipe all state
```
</details>

---

## Troubleshooting

**`bun`, `git`, or `wechat-cc` not found after install**
Reopen your terminal. PATH changes from `bun link` or a fresh Bun/Git install don't take effect in the current shell session.

**Reading logs on Windows — Chinese characters show as garbage**
PowerShell's default `Get-Content` reads files as ANSI (GBK). Use:
```powershell
Get-Content "$env:USERPROFILE\.claude\channels\wechat\channel.log" -Tail 60 -Encoding UTF8
```

**Windows Firewall popup on first `share_page`**
Fixed in v1.0 — `docs.ts` now binds `127.0.0.1` instead of `0.0.0.0`. If you see this popup on an older install, upgrade with `wechat-cc update`.

**`wechat-cc update` fails with "git not found"**
`wechat-cc update` runs `git pull`. Make sure Git is in your PATH. On Windows: `winget install Git.Git`, then reopen the terminal.

---

## Contributing

Issues and PRs welcome at [github.com/ggshr9/wechat-cc](https://github.com/ggshr9/wechat-cc/issues). The codebase runs on Bun and uses vitest for testing:

```bash
bun install
npx vitest run      # 32 tests, ~200ms
```

---

## Disclaimer

This is an **unofficial, community-built plugin** — not affiliated with, endorsed by, or sponsored by Tencent or WeChat.

ilink is a partner communication interface provided by WeChat for connecting with platforms like OpenClaw. wechat-cc repurposes it for Claude Code integration, which is **not its intended use case**. This usage may not be permitted by WeChat, and accounts involved could face restrictions.

**Use at your own risk.**

---

## License

MIT — see [LICENSE](./LICENSE).
