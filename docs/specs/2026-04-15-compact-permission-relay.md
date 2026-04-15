# Compact Permission Relay — Design Spec

**Date:** 2026-04-15
**Status:** Draft — pending user review
**Affects:** `~/.claude/plugins/local/wechat/server.ts`

## Goal

Replace the current wall-of-text `permission_request` relay with a compact,
per-tool formatted message, allow short reply syntax when only one permission
is pending, and provide a `/perm <code>` command to fetch full details on
demand.

## Motivation

When Claude Code asks for tool permission mid-session, the wechat plugin
forwards `tool_name + description + input_preview` to allowlisted admins
as a single raw message. For `Edit` / `Write` / `Read` the `input_preview`
is a JSON blob with escaped newlines — totally unreadable on a phone. Users
also have to type a 5-char random code (`yes ngjpu`) to approve, which is
error-prone on mobile.

The Telegram channel plugin solves the same problem with inline buttons
(`Allow` / `Deny` / `See more`). ilink bots don't support buttons, so we
solve the same problem with text: compact formatting + bare-verb shortcut
for unambiguous cases + a details-on-demand command.

## Scope

Three orthogonal changes. All in-memory, no schema or protocol changes.

### A. Per-tool compact formatters
Replace the `input_preview` raw dump with a tool-specific formatter that
extracts the signal and drops the noise. Unknown tools fall back to raw-
but-truncated output.

### B. Bare-verb reply when unambiguous
Extend the inbound permission-reply parser. If exactly **one** permission
is pending, `y` / `n` / `yes` / `no` / `允许` / `拒绝` (no code) is
accepted. Otherwise the strict `y <code>` form is still required.

### C. `/perm <code>` command
Send `/perm ngjpu` to get the full, untruncated `tool_name + description +
input_preview` of a pending request. Answers the user's need to see details
the compact formatter hid, matching Telegram's "See more" button pattern.

## Out of scope

- Inline buttons / rich UI (ilink doesn't support)
- Batching/grouping repeated requests from the same tool
- Non-admin delivery
- Schema changes to `access.json`

## Architecture

### State (in-memory, not persisted)

```ts
interface PendingPermission {
  tool_name: string
  description: string
  input_preview: string
  created_at: number  // epoch ms
}
const pendingPermissions = new Map<string, PendingPermission>()
```

Keyed by `request_id` (5-char code). Populated on `permission_request`
notification; deleted on answer (allow/deny) or on TTL prune (1h).

Used by:
- **Part B**: bare-verb shortcut needs `size === 1` check
- **Part C**: `/perm <code>` looks up full payload

No disk writes — permission approvals are ephemeral and don't need to
survive restart.

### Formatter registry

```ts
type ToolFormatter = (input: unknown) => string
const FORMATTERS: Record<string, ToolFormatter>
```

Each formatter takes the parsed `input_preview` object and returns a
multi-line compact string. If the tool name isn't in the registry OR if
`JSON.parse(input_preview)` throws, a default formatter is used that
truncates to 200 chars.

### Per-tool rules

| Tool | Output | Fields used |
|---|---|---|
| `Edit` | `Edit  <basename>` + `   - ~N 行` | `file_path`, lines-in-old_string |
| `Write` | `Write <basename>` + `   - N 字节` | `file_path`, `content` length |
| `Read` | `Read  <basename>` + optional `   - L+N 行` | `file_path`, `offset`, `limit` |
| `Bash` | `Bash` + `  <cmd>` (trunc 300) | `command` |
| `Glob` | `Glob: <pattern>` + optional `(in <path>)` | `pattern`, `path` |
| `Grep` | `Grep: <pattern>` + optional `(type=X, glob=Y)` | `pattern`, `type`, `glob`, `path` |
| `WebFetch` | `WebFetch: <url>` | `url` |
| `Task` | `Agent: <description>` (trunc 200) | `description` |
| *(default)* | `<tool_name>` + `  <trunc 200>` | raw |

## Reply syntax (Part B)

```ts
const PERMISSION_REPLY_STRICT_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
const PERMISSION_REPLY_BARE_RE   = /^\s*(y|yes|n|no|允许|拒绝)\s*$/i
const PERM_DETAILS_RE            = /^\s*\/perm\s+([a-km-z]{5})\s*$/i
```

Resolution order in `handleInbound`:

1. `/perm <code>` → details path (see Part C)
2. `y <code>` / `n <code>` (strict) → answer, delete from pending
3. Bare `y` / `n` / `yes` / `no` / `允许` / `拒绝` **AND** `pendingPermissions.size === 1` → answer the sole pending
4. Fall through to Claude (normal chat)

Ambiguity safety: with 2+ pending, bare verb falls through to Claude (user
must disambiguate with the code). Prevents misrouting.

## Details command (Part C)

```
User types: /perm ngjpu
Bot replies:
  🔐 Permission: Edit
  A tool for editing files
  {"file_path":"/home/...","old_string":"...","new_string":"..."}
  (full untruncated payload)
  Reply: y / n
```

If `pendingPermissions.get(code)` returns nothing:
```
  没有找到权限请求 ngjpu（可能已经处理或超时）
```

DM-only, admin-only (same gate as the original relay — `assertAllowedChat`
handles it upstream in `handleInbound`).

## Example transformations

**Before (Edit)**:
```
🔐 Permission: Edit
A tool for editing files
{"file_path":"/home/nategu/.claude/plugins/local/wechat/server.ts","old_string":"    {\n      name: 'reply',\n      description:\n        'Reply on WeChat. ...","new_string":"..."}

Reply: yes ngjpu / no ngjpu
```

**After (Edit)**:
```
🔐 Edit  server.ts
   - ~18 行
Reply: y / n  (详情: /perm ngjpu)
```

**After (Bash)**:
```
🔐 Bash
  cd ~/project && npm install
Reply: y / n  (详情: /perm abcde)
```

**After (unknown MCP tool)**:
```
🔐 mcp__linear__create_issue
  {"title":"Fix login bug","team_id":"TEAM-123"}
Reply: y / n  (详情: /perm xyzab)
```

## TTL and cleanup

Entries older than 1 hour are dropped. Pruning happens on-write (entry
added or looked up), not via a background timer. Map growth is bounded
by the admin's attention span.

When an answer arrives (via strict, bare, or the detail-then-reply flow),
`pendingPermissions.delete(request_id)` removes it immediately.

## Testing

Formatter functions are pure and unit-testable. The plan includes a manual
test matrix because the upstream `permission_request` notification comes
from Claude Code and can't easily be faked in isolation.

## Backward compatibility

- Existing `yes ngjpu` / `no ngjpu` form still works (strict path checked first)
- Unknown tools fall back to a raw (but truncated) dump
- No MCP schema changes, no `access.json` changes
- No disk state

## Risks

| Risk | Mitigation |
|---|---|
| Compact formatter hides info the user wanted | `/perm <code>` always gives full view |
| Bare `y` triggered by unrelated message | Only active when exactly 1 pending AND text is *exactly* a bare verb |
| Formatter crashes on malformed input | Try/catch around `JSON.parse`; fall through to default |
| Memory leak from un-answered permissions | 1h TTL prune on-write |
| Bare-verb shortcut in multi-admin setup confuses who approved | Same as today — any admin can approve; log already records it |
