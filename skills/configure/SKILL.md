---
name: configure
description: Set up the WeChat channel — trigger QR login and review connection status. Use when the user asks to configure WeChat, wants to check channel status, or needs to re-login.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
---

# /wechat:configure — WeChat Channel Setup

Check status and guide login. Arguments passed: `$ARGUMENTS`

State lives under `~/.claude/channels/wechat/`, with one sub-directory per bound account at `accounts/<bot_id>/` containing `token` (bot bearer token, 0600) and `account.json` (`botId`, `userId`, `baseUrl`).

---

## Status check (no args)

Read state files and show status:

1. **Accounts** — list `~/.claude/channels/wechat/accounts/`. For each `<bot_id>/` sub-directory:
   - Check that both `token` and `account.json` exist
   - Read `account.json` and show `botId`, `userId`, `baseUrl`
   - If `token` exists, show its first 10 chars masked (e.g. `abcdef1234…`)

2. **Access** — read `~/.claude/channels/wechat/access.json` (missing = defaults: `allowlist`, empty). Show:
   - DM policy (`allowlist` or `disabled`)
   - Allowed senders: count and list

3. **What next** based on state:
   - No accounts → *"No accounts bound yet. Run `wechat-cc setup` in a terminal to scan the QR code."*
   - Accounts bound, nobody allowed → *"Accounts are bound but the allowlist is empty. The scanner is normally auto-added on login; if not, add manually: `/wechat:access allow <user_id>`"*
   - Accounts bound, allowlist populated → *"Ready. Messages from allowed users will reach this session. Start with `wechat-cc run`."*

## Re-login / add another account

Tell the user to run `wechat-cc setup` in a terminal. Each successful scan creates a new `accounts/<bot_id>/` directory — running setup again does **not** overwrite existing accounts, it appends. To remove a stale account, delete its `accounts/<bot_id>/` directory.
