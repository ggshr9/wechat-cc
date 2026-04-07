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

---

## Status check (no args)

Read state files and show status:

1. **Token** — check `~/.claude/channels/wechat/.env` for `WECHAT_BOT_TOKEN`. Show set/not-set; if set, show first 10 chars masked.

2. **Account** — read `~/.claude/channels/wechat/account.json`. Show botId, baseUrl, userId if present.

3. **Access** — read `~/.claude/channels/wechat/access.json` (missing = defaults: allowlist, empty). Show:
   - DM policy
   - Allowed senders: count and list

4. **What next** based on state:
   - No token → *"Restart Claude Code with the channel flag to trigger QR login: `claude --channels plugin:wechat@local`"*
   - Token set, nobody allowed → *"Token is set but no users in allowlist. The scanner should be auto-added on login. If not, add manually: `/wechat:access allow <user_id>`"*
   - Token set, someone allowed → *"Ready. Messages from allowed users will reach this session."*

## Re-login

If user wants to re-login or token is expired:

1. Delete `~/.claude/channels/wechat/.env`
2. Tell user to restart: `claude --channels plugin:wechat@local`
3. The server will trigger QR login on next start.
