<h1 align="center">wechat-cc</h1>

<p align="center">
  <b>Reach your Claude Code session from WeChat — and let it reach back.</b>
</p>

<p align="center">
  <img alt="version"  src="https://img.shields.io/badge/cli-v1.2.0-blue">
  <img alt="desktop"  src="https://img.shields.io/badge/desktop-v0.3.1-blue">
  <img alt="platform" src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey">
  <img alt="runtime"  src="https://img.shields.io/badge/runtime-Bun-black">
  <img alt="license"  src="https://img.shields.io/badge/license-MIT-green">
  <a href="https://github.com/ggshr9/wechat-cc/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ggshr9/wechat-cc/actions/workflows/ci.yml/badge.svg"></a>
</p>

<p align="center">
  English | <a href="./README.zh.md">中文</a>
</p>

---

## What is this?

`wechat-cc` is a Bun daemon that bridges your **WeChat (微信)** account to a
**Claude Code** session running on your computer. Once set up, you can:

- Send a text / image / file / voice message from your phone — Claude on your
  desktop receives it, runs tools, and replies back into the chat.
- Walk away from your desk and keep a long-running task moving via your phone.
- Let Claude **reach out to you**, not just respond. The Companion layer +
  the v0.4 dashboard turn it into a long-running AI presence that writes
  observations, fires milestones, and decides when to push.

It's positioned deliberately as a **personal Claude Code companion × depth ×
non-technical owner** — not a multi-IM, multi-agent broker. If you want
breadth, see [`cc-connect`](https://github.com/chenhg5/cc-connect). If you
want a single, deep WeChat × Claude Code experience that feels like a
relationship, this is it.

<!-- TODO: 4-panel screenshot or 30s demo video here -->

---

## Two ways to install

| | **Desktop installer** (recommended) | **Terminal** (developer) |
|---|---|---|
| Who | Anyone, including non-technical users | You're comfortable with bun + git |
| What you get | A 4-step wizard (env check → agent → QR → service install) + a dashboard with bound accounts, memory, sessions, logs, one-click upgrades | Same daemon, no GUI |
| Path | Download a bundle from the [latest release](https://github.com/ggshr9/wechat-cc/releases/latest) | `git clone` + `bun install` + `wechat-cc setup` |
| Caveats | Bundles are unsigned (Apple Dev ID + Windows EV cert not yet provisioned) — first launch needs a one-time OS-warning bypass. macOS Intel not supported (Apple Silicon only). The desktop app shells out to the source-mode CLI, so you also need the source somewhere (or set `WECHAT_CC_ROOT`). | Works everywhere bun runs. |

Most people: grab the desktop bundle. Read on for the terminal path.

---

## Quick start (terminal)

**Prerequisites:** [Git](https://git-scm.com), [Bun](https://bun.sh) 1.1+,
and [Claude Code CLI](https://github.com/anthropics/claude-code).

```bash
# Linux / macOS
curl -fsSL https://bun.sh/install | bash    # if needed
git clone https://github.com/ggshr9/wechat-cc.git ~/.claude/plugins/local/wechat
cd ~/.claude/plugins/local/wechat && bun install && bun link
wechat-cc setup       # scan the QR on your phone
wechat-cc run         # start the daemon
```

```powershell
# Windows
irm bun.sh/install.ps1 | iex                # if needed
winget install Git.Git                       # if needed
# Reopen the terminal so the new PATH takes effect.
git clone https://github.com/ggshr9/wechat-cc.git "$env:USERPROFILE\.claude\plugins\local\wechat"
cd "$env:USERPROFILE\.claude\plugins\local\wechat"
bun install ; bun link
wechat-cc setup ; wechat-cc run
```

That's it. Send a message from WeChat — Claude sees it on the desktop and
replies back into the chat.

> Each QR scan binds **one** 1:1 bot. ilink doesn't support group chat.
> Whoever scanned the QR is automatically added to the allowlist; everyone
> else is blocked by default.

<details>
<summary><b>Quick start (desktop bundle)</b></summary>

Download the bundle for your platform from the [latest release](https://github.com/ggshr9/wechat-cc/releases/latest):

| Platform | File | First-launch quirk |
|:---|:---|:---|
| **macOS (Apple Silicon)** | `*.dmg` | Right-click → **Open** (Gatekeeper warning, once). |
| **Windows (x64)** | `.exe` (NSIS) or `.msi` | SmartScreen → **More info** → **Run anyway**. |
| **Linux (x64)** | `.deb` / `.rpm` / `.AppImage` | No warning. |

The desktop app shells out to the `wechat-cc` CLI under the hood, so you
also need the source available somewhere:

```bash
git clone https://github.com/ggshr9/wechat-cc.git ~/.local/share/wechat-cc
cd ~/.local/share/wechat-cc && bun install
```

Or set `WECHAT_CC_ROOT=/some/path` in your environment.

Then launch the desktop app — the wizard walks you through environment
checks, agent picker (Claude or Codex), QR scan, and background service
install. After that you land in the dashboard.

</details>

---

## Features

### 1 · Two-way chat with Claude on your desk

Send text / images / files / voice from your phone; Claude sees everything,
runs tools (Edit, Bash, etc.), and replies back into the chat. ilink uploads
media via CDN with AES-128-ECB encryption. Voice transcription comes from
ilink (displayed inline) and untranscribed audio is saved to your inbox.

### 2 · `share_page` — long-form output you can read on your phone

WeChat can't render markdown. When Claude has a plan, spec, or review for
you, it calls `share_page({title, content})`:

1. Content written locally to `~/.claude/channels/wechat/docs/<slug>.md`
2. Local Bun server renders it via `marked` with mobile-friendly CSS
3. `cloudflared tunnel` exposes it at `*.trycloudflare.com` (auto-installed,
   no account needed)
4. URL sent to WeChat with title + preview

Each shared page has a single ✓ Approve button — tap once and the daemon
gets notified. No reject / comment fields; pushback goes through the chat.
Pages auto-clean after 7 days; `resurface_page` revives expired URLs on the
current tunnel.

### 3 · Multi-project switching

Register your projects once; switch between them from WeChat with natural
language or a slash command:

```
/project add /home/u/Documents/compass compass
切到 sidecar              ← natural language; Claude parses intent
/project switch sidecar   ← exact form
```

Each project keeps a warm Claude session in a per-project pool — switching
takes ~5 s and messages sent during the window are buffered by ilink, then
delivered after reconnect. When you reference an earlier conversation
(「刚才聊的 xxx」), Claude looks up `<target>/memory/_handoff.md` (a tiny
pointer file written on switch) and reads the source jsonl on demand —
nothing is eagerly copied across projects.

### 4 · Companion — the Claude that reaches out

Opt-in proactive mode. When `companion_enable` is set, the daemon runs two
schedulers:

- **Push tick** (~20 min ± jitter) — Claude reads memory + recent context,
  decides whether to push you something. Two pickable personas:
  - **小助手 (assistant)** — work-focused, strict push rules
  - **陪伴 (companion)** — warmer, lighter rules, evening check-ins
- **Introspect tick** (24 h ± jitter, **v0.4.1**) — Claude (claude-haiku-4-5,
  isolated single-shot) reviews recent activity and decides whether to write
  a new observation in `memory/<chat>/observations.jsonl`. Never pushes.
  Surface comes when you open the dashboard.

Natural-language controls:
- `开启 companion` / `关闭 companion`
- `切到陪伴` / `换回小助手`
- `别烦我` / `snooze 3 小时`

### 5 · Two mirrors of accompaniment (v0.4 dashboard)

The desktop dashboard reflects two perspectives on the same relationship:

**记忆 (Memory)** — Claude's lens
- Top: Claude's recent observations + milestone cards (the surprise mechanic
  — *打开才发现的小惊喜*; never pushed)
- Middle: editable per-chat markdown (profile.md / preferences.md / …)
- Bottom: collapsible "Claude's recent decisions" timeline (push / skip /
  observation / milestone / SDK error). Click a row to see the reasoning.

**会话 (Sessions)** — your shared record
- Cross-session full-text search
- Project list grouped by recency (今天 / 7 天内 / 更早) with one-line LLM
  summary per project (claude-haiku-4-5, lazy-refreshed)
- Drill into any project's jsonl conversation stream; favorite / export
  markdown / delete

Milestone detector fires on each inbound message: 100/1000 turns,
first_handoff, first_push_reply, **7day_streak** (UTC date tracking via
per-chat `activity.jsonl`).

> See [`docs/specs/2026-04-29-sessions-memory-design.md`](docs/specs/2026-04-29-sessions-memory-design.md)
> for the design pillars (双面镜子 / 老朋友的随手观察 / 克制 / 留白) and
> [`docs/specs/2026-04-29-v0.4.1.md`](docs/specs/2026-04-29-v0.4.1.md) for
> SDK + activity tracking specifics.

### 6 · Hearth integration — vault governance from your phone

Capture text into a personal markdown vault, propose a `ChangePlan`, review
the rendered `share_page`, tap ✓ Approve — all without leaving WeChat. Built
on [hearth](https://github.com/ggshr9/hearth), the agent-native vault
governance layer.

```
/hearth ingest <text>      → propose a ChangePlan, send a review card
/hearth list               → 10 most recent pending plans
/hearth show <id>          → preview ops + body
/hearth apply <id>         → kernel apply (owner-direct, no token needed)
```

Owner-only (admin-gated). vault is never written by the channel — all
writes go through hearth's kernel after human approval. Setup:

```bash
git clone https://github.com/ggshr9/hearth.git ~/Documents/hearth
cd ~/Documents/hearth && bun install
bun src/cli/index.ts setup              # auto-detects Obsidian vaults
export HEARTH_VAULT=/path/to/your/vault
export HEARTH_AGENT=mock                # or "claude" with an Anthropic key
```

### 7 · Voice replies

Say "念一下 X" / "speak it" and Claude voices the response. Primary provider
is [VoxCPM2](https://huggingface.co/openbmb/VoxCPM2) via `vllm serve --omni`
(OpenAI-compatible `/v1/audio/speech`). Qwen DashScope is the cloud fallback.
Configured entirely via WeChat conversation — Claude walks you through the
API-key / base-URL setup the first time you ask.

### 8 · CLI fallback

If the daemon crashes, you can still reply from any terminal:

```bash
wechat-cc reply "I'll be back in 10 min"          # → most-recent chat
wechat-cc reply --to <chat_id> "specific user"
echo "piped text" | wechat-cc reply
```

The CLI reads the same `~/.claude/channels/wechat/` state as the running
daemon, so recipient resolution + session continuity are identical. State
files are the source of truth; you never lose a thread because the daemon
restarted.

---

## How it works

```
[your phone]                    [your desktop]
   WeChat ──────────► ilink ──► wechat-cc daemon ──► Claude Agent SDK ──► Claude
       │              (long-poll)     │                                       │
       ▼                               ▼                                       │
   share_page ◄── cloudflared ◄── Bun.serve(local) ◄────── reply tool ◄───────┘
```

- **Receive**: per-account long-polling `POST /ilink/bot/getupdates`
- **Send**: `POST /ilink/bot/sendmessage` (requires the user's
  `context_token` — they must message the bot first)
- **Driver**: `@anthropic-ai/claude-agent-sdk` 0.2.116 pinned. The daemon
  manages claude subprocesses internally — no Claude Code MCP channel
  registration needed
- **State**: everything under `~/.claude/channels/wechat/` (see [State layout](#state-layout))
- **Companion**: two schedulers (push + introspect) with separate cadences;
  isolated SDK evals for introspect / summary so the prompt style doesn't
  leak into project sessions

---

## Permission modes

**Strict (default)** — `wechat-cc run` — every tool call prompts you on
WeChat (`y abc12` allow / `n abc12` deny, 10-min timeout). Matches the
permission relay design.

**Bypass** — `wechat-cc run --dangerously` — Claude runs tools without
WeChat prompts. Equivalent to `claude --dangerously-skip-permissions`.
Claude is trained to confirm destructive operations via natural-language
reply before acting. Use only on a personal daemon where you control the
allowlist.

> ⚠️ Don't run `--dangerously` on a bot you share with less-trusted users
> via `access.json.allowFrom[]` — any allowed chat gets bypass.

---

## WeChat commands

| Command | Effect |
|:---|:---|
| `/help` | Show available commands |
| `/status` | Connection health + version + update probe |
| `/ping` | Connectivity test |
| `/users` | Online users |
| `/project add <path> <alias>` | Register a project (admin) |
| `/project list` | List registered projects |
| `/project switch <alias>` | Switch (admin) |
| `/project status` | Current project + cwd |
| `/project remove <alias>` | Unregister (admin) |
| `@all <msg>` | Broadcast |
| `@<name> <msg>` | Forward to a specific user |
| `/health` | Bot health (admin) — surfaces expired bots, cleanup hints |
| `/hearth ingest|list|show|apply` | Vault governance (admin, hearth-enabled) |

The Companion + memory features are configured via natural language, not
slash commands (`开启 companion`, `切到陪伴`, `别烦我`, etc.).

---

## Updating

```bash
wechat-cc update             # pull + reinstall deps + restart service
wechat-cc update --check     # probe only, no side effects
```

The desktop GUI calls `--check` on launch to surface a **立即升级** button.

If the daemon is running as a service (LaunchAgent / systemd / Scheduled
Task), `update` automatically stops, pulls, reinstalls deps if `bun.lock`
changed, and restarts. If you're running `wechat-cc run` in a foreground
terminal, the command refuses with `daemon_running_not_service` so it
won't kill your shell — Ctrl+C the foreground process first.

---

## State layout

```
~/.claude/channels/wechat/
├── access.json            # allowlist
├── context_tokens.json    # ilink context tokens (one per chat)
├── user_names.json        # chat_id → display name
├── sessions.json          # project_alias → { session_id, last_used_at, summary? }
├── session-state.json     # bot health (errcode tracking)
├── channel.log            # rolling log (10 MB rotation)
├── server.pid             # single-instance lock
├── docs/                  # share_page content (7-day TTL)
├── bin/cloudflared        # auto-downloaded (.exe on Windows)
├── inbox/                 # downloaded media (30-day TTL)
├── accounts/<bot_id>/     # per-account credentials
├── companion/
│   └── config.json        # enabled / snooze / default_chat_id / last_introspect_at
└── memory/<chat_id>/      # per-chat content
    ├── profile.md         # editable user-facing notes
    ├── observations.jsonl # Claude's recent observations (TTL 30d)
    ├── milestones.jsonl   # 100msg / streak / etc. (permanent, id-deduped)
    ├── events.jsonl       # cron decisions (push/skip/failed/observation/milestone)
    └── activity.jsonl     # daily UTC date + msg count (for streak detector)
```

All state lives under `~/.claude/` — nothing is committed to the repo.

---

## Access control

Allowlist-only by default. Manage from the **terminal**, not WeChat (this
prevents prompt-injection from a chat you've allowed):

```
/wechat:access                        # show policy + allowlist
/wechat:access allow <user_id>        # add a sender
/wechat:access remove <user_id>       # remove a sender
```

Users who scan the QR during `wechat-cc setup` are automatically allowed.

---

## Demo data (for screenshots / first impressions)

A fresh install means empty memory and zero observations. To preview what a
populated dashboard looks like:

```bash
wechat-cc demo seed                   # 3 observations + 1 milestone + 5 events
wechat-cc demo unseed                 # remove them
wechat-cc demo seed --chat-id <id>    # specific chat instead of default
```

Stable `obs_demo_*` / `ms_demo_*` ids make `unseed` reliable.

---

## Known limitations

- **First contact** — you can't message a WeChat user who hasn't sent at
  least one message to the bot first (ilink requires their `context_token`).
- **No group chat** — ilink is 1:1 only.
- **macOS Intel desktop bundle** — not yet provided. Install via terminal.
- **Desktop bundle unsigned** — first launch needs a one-time
  Gatekeeper / SmartScreen bypass.
- **Conversation continuity across daemon restart** — the WeChat chat
  history stays on your phone, but Claude doesn't replay it on restart.
  Per-project session resume keeps the *current* working session warm; it
  doesn't reconstruct earlier ones.

---

## Troubleshooting

**`bun`, `git`, or `wechat-cc` not found after install**
Reopen your terminal. PATH changes from `bun link` or a fresh Bun/Git
install don't take effect in the current shell session.

**Reading logs on Windows — Chinese characters show as garbage**
PowerShell's default `Get-Content` reads files as ANSI (GBK). Use:
```powershell
Get-Content "$env:USERPROFILE\.claude\channels\wechat\channel.log" -Tail 60 -Encoding UTF8
```

**Windows Firewall popup on first `share_page`**
Fixed in v1.0 — `docs.ts` binds `127.0.0.1`. If you see this on an older
install, run `wechat-cc update`.

**`wechat-cc update` fails with "git not found"**
`update` runs `git pull`. Ensure Git is in PATH. Windows:
`winget install Git.Git`, then reopen the terminal.

**Bot stops responding (errcode=-14)**
Run `/health` from WeChat (admin-gated). Expired bots show up there;
respond with `清理 <bot-id>` to remove from active list. Re-scan the QR
to bind a fresh session.

---

## Uninstall

```bash
# Linux / macOS
rm -rf ~/.claude/plugins/local/wechat   # remove plugin source
rm -rf ~/.claude/channels/wechat        # wipe all state
```

```powershell
# Windows
Remove-Item "$env:USERPROFILE\.claude\plugins\local\wechat"
Remove-Item "$env:USERPROFILE\.claude\channels\wechat" -Recurse -Force
```

If you used the desktop bundle, also drag the app to Trash / uninstall via
the OS package manager.

---

## Use cases

- **Out and about with a long task running** — start a deploy / refactor on
  your computer, lock the screen, keep nudging it from your phone.
- **Forward a Claude-generated plan to your boss** — `share_page` produces
  a clean URL with an Approve button; non-technical reviewers don't have to
  read the chat.
- **Multi-user**: share the bot with teammates via `access.json.allowFrom[]`.
  Each person's messages route to your single Claude session.
- **A Claude that remembers you** — Companion + memory pane build a small,
  honest portrait over time. You can read it, correct it, archive things
  you don't want remembered.

---

## Versions

- **CLI / daemon**: 1.2.0 — see [`package.json`](./package.json)
- **Desktop bundle**: latest signed release is
  [`desktop-v0.3.1`](https://github.com/ggshr9/wechat-cc/releases/tag/desktop-v0.3.1).
  v0.4 / v0.4.1 features (双面镜子 dashboard, real introspect SDK,
  per-project summary, 7-day streak) are in `master` and will ship with the
  next desktop bundle cut.
- **Per-version release notes**: [`docs/releases/`](./docs/releases/)
- **Architecture / design specs**: [`docs/specs/`](./docs/specs/)
- **Roadmap**: [`docs/rfc/02-post-v1.1-roadmap.md`](./docs/rfc/02-post-v1.1-roadmap.md)

---

## Contributing

Issues + PRs welcome at [github.com/ggshr9/wechat-cc](https://github.com/ggshr9/wechat-cc/issues).

```bash
bun install
bun x vitest run        # full test suite (currently 684 tests)
bun x tsc --noEmit      # type check
```

The `apps/desktop/` directory has a Tauri 2 GUI; for fast iteration use
`bun run shim` (browser-side mock) or `bun run dev` (real Tauri shell). See
[`apps/desktop/test-shim.ts`](./apps/desktop/test-shim.ts) for the dev
harness.

---

## Disclaimer

This is an **unofficial, community-built plugin** — not affiliated with,
endorsed by, or sponsored by Tencent or WeChat.

---

## License

MIT — see [LICENSE](./LICENSE).
