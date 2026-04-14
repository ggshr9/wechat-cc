# wechat-cc

A Claude Code channel plugin that bridges **WeChat** into your Claude Code session via the WeChat ilink bot API. Reply, edit, broadcast, and send files to your WeChat contacts from inside Claude Code, and let them message Claude directly.

> Unofficial. Built on the ilink bot protocol (`https://ilinkai.weixin.qq.com`). Each QR scan binds one 1:1 bot — this is an ilink limitation; group chat is not supported.

## Features

- QR-code login, multi-account (each scanner = one independent bot, one `accounts/<bot_id>/` dir)
- MCP server exposing channel tools: `reply`, `edit_message`, `broadcast`, `send_file`, `set_user_name`
- Text, image, file and video delivery (CDN upload/download + AES-128-ECB encryption)
- Inbox directory for incoming media (paths surfaced in message metadata)
- Allowlist-based access control (persisted to `~/.claude/channels/wechat/access.json`)
- Live log monitor at `http://localhost:3456` (`wechat-cc logs`)
- Built-in WeChat slash commands: `/help`, `/status`, `/ping`, `/users`, `@all`, `@<name>`
- Auto-prompts Claude to ask for a name when a new sender appears; stored via `set_user_name`

## Install

Requirements:

- [Bun](https://bun.sh) (tested with 1.1+)
- [Claude Code CLI](https://github.com/anthropics/claude-code)

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
```

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

| Command    | Effect                                                          |
|------------|-----------------------------------------------------------------|
| `/help`    | Show available commands                                         |
| `/status`  | Connection + account health                                     |
| `/ping`    | Connectivity test                                               |
| `/users`   | List online (bound) users                                       |
| `@all msg` | Broadcast to every connected user                               |
| `@名字 msg`| Forward to a specific user (name from `set_user_name`)          |

## State layout

```
~/.claude/channels/wechat/
├── access.json            # allowlist
├── context_tokens.json    # ilink context tokens (needed to initiate outbound messages)
├── user_names.json        # chat_id → display name
├── channel.log            # rolling log
├── server.pid             # single-instance lock
├── inbox/                 # downloaded media
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
