# Compact Permission Relay — Implementation Plan

**Date:** 2026-04-15
**Spec:** `docs/specs/2026-04-15-compact-permission-relay.md`
**Target file:** `~/.claude/plugins/local/wechat/server.ts`

**Goal:** Ship A (per-tool compact formatters), B (bare-verb reply shortcut),
and C (`/perm <code>` details command) as three reviewable commits.

**Architecture:** Single-file edit. All new state lives in-memory. No
schema/config changes. Existing `handleInbound` early-return pattern is
reused for the new intercepts.

**Tech stack:** Bun runtime, TypeScript, existing MCP SDK + ilink client.

---

## Task 1 — Formatter registry + pending cache

**Files:**
- Modify: `server.ts` around line 675 (just after `PERMISSION_REPLY_RE`
  definition, before `mcp.setNotificationHandler`)

**Step 1: Replace `PERMISSION_REPLY_RE` with the three new regexes + cache**

Remove:
```ts
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
```

Add:
```ts
const PERMISSION_REPLY_STRICT_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
const PERMISSION_REPLY_BARE_RE   = /^\s*(y|yes|n|no|允许|拒绝)\s*$/i
const PERM_DETAILS_RE            = /^\s*\/perm\s+([a-km-z]{5})\s*$/i

const PERMISSION_TTL_MS = 60 * 60 * 1000 // 1 hour

interface PendingPermission {
  tool_name: string
  description: string
  input_preview: string
  created_at: number
}
const pendingPermissions = new Map<string, PendingPermission>()

function prunePendingPermissions(): void {
  const cutoff = Date.now() - PERMISSION_TTL_MS
  for (const [id, p] of pendingPermissions) {
    if (p.created_at < cutoff) pendingPermissions.delete(id)
  }
}
```

**Step 2: Add formatter helpers**

Append below the cache:

```ts
type ToolFormatter = (input: Record<string, unknown>) => string

function permBasename(p: string): string {
  return p.split('/').pop() ?? p
}

function permTrunc(s: string, n = 300): string {
  return s.length > n ? s.slice(0, n - 3) + '...' : s
}

const PERMISSION_FORMATTERS: Record<string, ToolFormatter> = {
  Edit: (i) => {
    const file = permBasename(String(i.file_path ?? ''))
    const oldStr = String(i.old_string ?? '')
    const lines = oldStr ? oldStr.split('\n').length : 0
    return `Edit  ${file}\n   - ~${lines} 行`
  },
  Write: (i) => {
    const file = permBasename(String(i.file_path ?? ''))
    const bytes = Buffer.byteLength(String(i.content ?? ''), 'utf8')
    return `Write ${file}\n   - ${bytes} 字节`
  },
  Read: (i) => {
    const file = permBasename(String(i.file_path ?? ''))
    const range = i.offset != null
      ? `\n   - ${i.offset}+${i.limit ?? '?'} 行`
      : ''
    return `Read  ${file}${range}`
  },
  Bash: (i) => {
    const cmd = permTrunc(String(i.command ?? ''), 300)
    return `Bash\n  ${cmd}`
  },
  Glob: (i) => `Glob: ${String(i.pattern ?? '')}${i.path ? ` (in ${i.path})` : ''}`,
  Grep: (i) => {
    const extras: string[] = []
    if (i.type) extras.push(`type=${i.type}`)
    if (i.glob) extras.push(`glob=${i.glob}`)
    if (i.path) extras.push(`path=${i.path}`)
    return `Grep: ${String(i.pattern ?? '')}${extras.length ? ' (' + extras.join(', ') + ')' : ''}`
  },
  WebFetch: (i) => `WebFetch: ${String(i.url ?? '')}`,
  Task: (i) => `Agent: ${permTrunc(String(i.description ?? ''), 200)}`,
}

function formatPermissionCompact(tool_name: string, input_preview: string): string {
  let parsed: Record<string, unknown> | null = null
  try {
    const v = JSON.parse(input_preview)
    if (v && typeof v === 'object') parsed = v as Record<string, unknown>
  } catch { /* fall through to default */ }

  const formatter = PERMISSION_FORMATTERS[tool_name]
  if (formatter && parsed) return formatter(parsed)
  return `${tool_name}\n  ${permTrunc(input_preview, 200)}`
}
```

**Step 3: Update the existing permission-reply intercept to use the new names**

In `handleInbound` around line 1179, the existing code:
```ts
const permMatch = PERMISSION_REPLY_RE.exec(text)
if (permMatch) { ... }
```
Temporarily point it at the new `PERMISSION_REPLY_STRICT_RE` so Task 1
compiles in isolation (Task 3 will fully rewrite this block):

```ts
const permMatch = PERMISSION_REPLY_STRICT_RE.exec(text)
if (permMatch) {
  void mcp.notification({ ... })  // unchanged body
  return
}
```

**Step 4: Syntax check**

```bash
cd ~/.claude/plugins/local/wechat && bun build server.ts --target=bun --outfile=/tmp/wechat-build-check.js
```
Expected: `Bundled N modules` with no errors.

**Step 5: Commit**

```bash
git add server.ts
git commit -m "feat(perm): add pending cache + per-tool compact formatters"
```

---

## Task 2 — Wire formatter + cache into permission_request handler

**Files:**
- Modify: `server.ts:660-695` (the `mcp.setNotificationHandler` block
  that handles `notifications/claude/channel/permission_request`)

**Step 1: Replace the handler body**

Find:
```ts
    log('PERMISSION', `${tool_name}: ${description}\n${input_preview}`)
    const lines = [`🔐 Permission: ${tool_name}`]
    if (description) lines.push(description)
    if (input_preview) lines.push(input_preview)
    lines.push(`\nReply: yes ${request_id} / no ${request_id}`)
    const text = lines.join('\n')
```

Replace with:
```ts
    // Cache full details for /perm lookup and single-pending shortcut.
    prunePendingPermissions()
    pendingPermissions.set(request_id, {
      tool_name, description, input_preview, created_at: Date.now(),
    })

    log('PERMISSION', `${tool_name}: ${description}\n${input_preview}`)

    const compact = formatPermissionCompact(tool_name, input_preview)
    const text = `🔐 ${compact}\nReply: y / n  (详情: /perm ${request_id})`
```

The existing `for (const userId of targets)` loop stays unchanged.

**Step 2: Syntax check + commit**

```bash
bun build server.ts --target=bun --outfile=/tmp/wechat-build-check.js
git add server.ts
git commit -m "feat(perm): send compact formatted relay + cache request for lookup"
```

---

## Task 3 — Short-reply shortcut + `/perm <code>` intercept

**Files:**
- Modify: `server.ts` around line 1179 (permission-reply intercept in
  `handleInbound`)

**Step 1: Replace the intercept block**

Find the existing block (after the `@name` forward-to-user branch):
```ts
  // Permission-reply intercept
  const permMatch = PERMISSION_REPLY_STRICT_RE.exec(text)
  if (permMatch) {
    void mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: {
        request_id: permMatch[2]!.toLowerCase(),
        behavior: permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny',
      },
    })
    return
  }
```

Replace with:
```ts
  // /perm <code> — show full details for a pending permission request
  const permDetailsMatch = PERM_DETAILS_RE.exec(text)
  if (permDetailsMatch) {
    const code = permDetailsMatch[1]!.toLowerCase()
    prunePendingPermissions()
    const p = pendingPermissions.get(code)
    if (!p) {
      ilinkSendMessage(entry.account.baseUrl, entry.token,
        botTextMessage(fromUserId, `没有找到权限请求 ${code}（可能已经处理或超时）`, contextTokens.get(fromUserId)),
      ).catch(() => {})
      return
    }
    const lines = [`🔐 Permission: ${p.tool_name}`]
    if (p.description) lines.push(p.description)
    if (p.input_preview) lines.push(p.input_preview)
    lines.push(`\nReply: y / n`)
    ilinkSendMessage(entry.account.baseUrl, entry.token,
      botTextMessage(fromUserId, lines.join('\n'), contextTokens.get(fromUserId)),
    ).catch(() => {})
    return
  }

  // Permission reply — strict form (y|n <code>)
  const strictMatch = PERMISSION_REPLY_STRICT_RE.exec(text)
  if (strictMatch) {
    const request_id = strictMatch[2]!.toLowerCase()
    const behavior = strictMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny'
    pendingPermissions.delete(request_id)
    void mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id, behavior },
    })
    return
  }

  // Permission reply — bare form (only when exactly 1 pending)
  const bareMatch = PERMISSION_REPLY_BARE_RE.exec(text)
  if (bareMatch && pendingPermissions.size === 1) {
    const verb = bareMatch[1]!.toLowerCase()
    const behavior = (verb === 'y' || verb === 'yes' || verb === '允许') ? 'allow' : 'deny'
    const request_id = [...pendingPermissions.keys()][0]!
    pendingPermissions.delete(request_id)
    void mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id, behavior },
    })
    return
  }
```

**Step 2: Syntax check + commit**

```bash
bun build server.ts --target=bun --outfile=/tmp/wechat-build-check.js
git add server.ts
git commit -m "feat(perm): bare-verb shortcut + /perm <code> details command"
```

---

## Task 4 — Manual test matrix

**Prerequisites:** User restarts wechat-cc so the new code loads.

| # | Trigger | Expected |
|---|---|---|
| 1 | Ask Claude to Edit any file → receive permission relay | Compact: `🔐 Edit  <basename>\n   - ~N 行\nReply: y / n  (详情: /perm xxxxx)` |
| 2 | Reply `y` to (1) | Edit proceeds. `pendingPermissions.size === 0` |
| 3 | Trigger Edit → reply `/perm <code>` before answering | Bot sends full `tool_name + description + input_preview`. Pending still alive. |
| 4 | After (3), reply `y` | Edit proceeds. |
| 5 | Trigger Edit → wait 1 sec → trigger another Edit (2 pending) | Two compact relays, each with its own code |
| 6 | After (5), reply bare `y` | **No approval** — message falls through to Claude as regular chat (2 pending, ambiguous) |
| 7 | After (5), reply `y <code1>` | First Edit proceeds, second still pending |
| 8 | Trigger a non-registered MCP tool | Compact fallback: `🔐 <tool_name>\n  <trunc input>\nReply: ...` |
| 9 | Reply `/perm zzzzz` with unknown code | Bot: `没有找到权限请求 zzzzz（可能已经处理或超时）` |

Test results are captured by eye; no automated harness.

---

## Task 5 — Push

```bash
git push origin master
```

Commits land separately (3 functional + no squash) so each is independently
revertable.

---

## Self-review

- [x] Spec coverage: A (formatters) → Task 1; B (bare shortcut) → Task 3;
      C (`/perm`) → Task 3. All three covered.
- [x] No placeholders: every code block has complete replacement text.
- [x] Type consistency: `PendingPermission`, `ToolFormatter`,
      `pendingPermissions`, `prunePendingPermissions` referenced consistently
      across Task 1/2/3.
- [x] File paths/line numbers match current state (verified against
      server.ts at commit `c871b4b`).
- [x] No orphaned code: old `PERMISSION_REPLY_RE` is renamed, not left
      alongside the new one (Task 1 Step 1 removes it).
- [x] Every task ends with a syntax check + atomic commit.
- [x] Tests are manual but concrete (not "add tests for edge cases").
