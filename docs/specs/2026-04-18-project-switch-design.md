# wechat-cc Multi-Project Switch — Design Spec

**Status:** Draft (brainstormed 2026-04-18)
**Target MVP:** A (minimal viable — registration + list + switch + lazy handoff pointer)
**Scope:** wechat-cc plugin only. No compass-side changes.

## Goal

Let a WeChat user seamlessly switch the active project their Claude Code session is operating in, without touching a terminal. This is the mobile/remote-work use case — the 20% edge case that decides tool quality.

## Non-Goals

- Multi-bot parallel project hosting (WeChat only allows one bot per account)
- Persistent daemon / multi-worker architecture (that's cc-connect's domain; we stay a plugin)
- Project-aware permissions per WeChat user (MVP is single-owner tool; admin-only for all project ops)
- Carrying over session transcripts eagerly (we use lazy pointer instead)
- Tab-completion / intelligent alias inference beyond fuzzy match in Claude
- Switching stack / `切回刚才` convenience (deferred to v2)
- Automatic handoff expiry / garbage collection (single overwriting file handles this)

## Design Constraints (inherited from discussion)

1. **WeChat allows exactly one bot per account.** All switching happens within that one bot's conversation window.
2. **MCP must install at user scope** (`~/.claude.json`), not per-project. This removes the "target project has no `.mcp.json`" failure mode.
3. **Handoff context is a lazy pointer, not an eager summary.** Fixed-size summary is always wrong; pointer + on-demand retrieval is always right-sized.
4. **Natural language is primary UX; `/project` commands are fallback.** Users on mobile can't remember exact command syntax or full paths.
5. **Alias-only identity.** Paths appear in registration; after that, only aliases are used in commands and NL. Aliases must be short, ASCII, and human-typable on a phone.

## Alternatives Considered (and rejected)

| Alternative | Why rejected |
|---|---|
| Multi-bot (one bot per project) | WeChat doesn't allow multiple bots simultaneously |
| Persistent daemon with worker pool (cc-connect-style) | Over-engineered for our plugin identity; would stop being a plugin |
| Eager context summary copied to target project | Always too short or too long; bloats context; violates lazy-load principle |
| Parsing NL intent inside the server | Duplicates what Claude does natively; brittle on edge cases |
| Project-level `.mcp.json` install (current) | Forces per-project install; any unregistered project loses wechat-cc bridge |
| Path-based switch (`/project switch /abs/path`) | Mobile users can't remember paths; injection surface (`/tmp/evil`) |

## Architecture

### New state files

**`~/.claude/channels/wechat/projects.json`** — project registry and current pointer.

```json
{
  "projects": {
    "compass": {
      "path": "/home/nategu/Documents/compass",
      "last_active": "2026-04-18T13:00:00.000Z"
    },
    "sidecar": {
      "path": "/home/nategu/Documents/compass-wechat-sidecar",
      "last_active": "2026-04-18T11:00:00.000Z"
    }
  },
  "current": "compass"
}
```

- Written atomically (tmp + rename) on every registration change and every switch.
- Corrupted / missing file → system degrades to "single-project mode" (current behavior). Never crashes.
- **`last_active` semantics:** set to `now` only when a project becomes current via `setCurrent`. When switching OUT of project X into Y, X's `last_active` is NOT bumped — it continues to reflect when X last became current. This matches "recency" display intent (the more recently you *started working on* a project, the higher it ranks).

**`<target-project>/memory/_handoff.md`** — single overwriting handoff pointer, created at target project's auto-memory dir during switch.

```markdown
---
name: Cross-project handoff
description: Switched to <alias> at <ISO ts>; previous chat in source jsonl
type: reference
---

来源项目: <source alias> (<source path>)
切换时间: <ISO timestamp>
上段会话 jsonl: <absolute path>
用户备注: <--note 值，或"无">

用户提到"刚才"/"之前"/"切过来之前"时，用 Read 工具读上面 jsonl 的尾部，
或 Grep 关键词按需检索。不主动引用。
```

**`<target-project>/memory/MEMORY.md`** — existing auto-memory index. Server adds/replaces one line:

```
- [Cross-project handoff](_handoff.md) — 从 <source> 切过来 (<ISO date>)
```

Idempotent: existing index line whose markdown link points at `_handoff.md` gets replaced, not duplicated. If MEMORY.md is missing, it's created with just this line (no frontmatter — MEMORY.md per auto-memory convention has no frontmatter).

**Reserved filename:** `_handoff.md` in `<target>/memory/` is reserved by wechat-cc. If an unrelated file with that name exists (e.g., user manually created one), it will be overwritten on switch. The leading underscore is a convention to mark it as auto-managed.

### Reused state

- `.restart-flag` file (existing `/restart` mechanism): extended with optional `cwd` field.
  - Old format: whitespace-separated claude flags (e.g., `--fresh --dangerously`)
  - New format: first line can be `cwd=<absolute path>` followed by whitespace-separated flags on subsequent lines, OR legacy format without `cwd=` prefix
- `access.ts:isAdmin()` — existing admin check; `/project` commands gate on this.

### New code modules

| File | Responsibility |
|---|---|
| `project-registry.ts` | CRUD on `projects.json`; alias validation; path validation via `fs.stat`; `setCurrent` |
| `handoff.ts` | Atomic write of `_handoff.md`; idempotent MEMORY.md index update; `mkdir -p` memory dir |
| `install-user-mcp.ts` | `wechat-cc install --user` implementation — merge `~/.claude.json.mcpServers.wechat` |

### Modified code modules

| File | Change |
|---|---|
| `config.ts` | `export const PROJECTS_FILE = join(STATE_DIR, 'projects.json')` |
| `server.ts` | New MCP tools `list_projects`, `switch_project`; new WeChat commands `/project add\|list\|switch\|status\|remove`; switch orchestration (registry update → handoff write → flag write) |
| `cli.ts` | Parse `cwd=` prefix in `.restart-flag`; call `process.chdir(cwd)` before spawning claude on respawn; add `--user` flag to `install` subcommand |
| `setup.ts` | After QR scan success, soft-suggest `wechat-cc install --user` (not forced) |
| `README.md` | New "Multi-project switching" section; document user-scope vs project-scope install |

## Data Flow: Project Switch

Trigger: WeChat admin sends "切到 sidecar" (NL) OR `/project switch sidecar` (command).

```
1. Claude (LLM) receives message via server → MCP reply tool dispatched
2. Claude interprets intent, calls list_projects() MCP tool
3. server returns current registry
4. Claude fuzzy-matches "sidecar" → unique match
5. Claude replies "好，切到 sidecar (~/Documents/compass-wechat-sidecar). 大约 10 秒..."
6. Claude calls switch_project({alias: "sidecar"}) MCP tool
7. server:
   (a) isAdmin(requester) — reject if not
   (b) fs.statSync(target.path) — reject if not a directory
   (c) handoff.writeHandoff(target.path, source={alias, path}, sessionJsonl, note):
       - mkdirSync(<target>/memory, {recursive:true}) if missing
       - writeAtomic(<target>/memory/_handoff.md, body)
       - updateIndex(<target>/memory/MEMORY.md, handoffLine)  # idempotent
   (d) registry.setCurrent("sidecar") — updates current + both projects' last_active
   (e) writeRestartFlag({cwd: target.path, args: []})
   (f) sendReplyOnce(chat_id, "切换中...")
8. supervisor (cli.ts) polling detects flag file
   (a) reads cwd= prefix
   (b) kills current claude child
   (c) process.chdir(cwd)
   (d) spawns new claude with --continue (falls back to --fresh on exit)
   (e) expect wrapper (Linux/macOS) auto-confirms dev-channel dialog
9. New claude starts in target cwd:
   (a) Claude Code reads ~/.claude/projects/<encoded-target-path>/memory/
   (b) Auto-memory loads MEMORY.md → sees _handoff.md index entry
   (c) Wechat MCP re-attaches via user-scope ~/.claude.json config
10. server (re-initialized in new session) reads .restart-ack:
    (a) WeChat push: "已切到 sidecar。上次聊过: <handoff note or "无">. 你现在想干啥？"
11. User continues conversation; if they reference prior context, Claude reads _handoff.md and the jsonl pointer on demand
```

Kill-to-respawn window: ~5-10s. WeChat messages during this window are buffered by ilink and flushed to new session on reconnect.

## Commands & Natural Language

### WeChat commands (admin only)

| Command | Effect |
|---|---|
| `/project add <path> <alias>` | Register. Validates path is absolute, exists, and is a directory (fs.stat); alias matches `^[a-z0-9][a-z0-9_-]{1,19}$`; no alias conflict. Relative paths are rejected (no silent resolve) |
| `/project list` | List all projects, current marked, sorted by last_active desc |
| `/project switch <alias>` | Switch (full flow above). Command form does NOT support `--note`; notes come only through NL (Claude extracts them) |
| `/project status` | Show current alias + absolute cwd + last switch timestamp |
| `/project remove <alias>` | Unregister. Rejects if alias == current. Does not touch the project's files — only removes the registry entry |

**Admin semantics:** `access.ts:isAdmin(userId)` returns true for any userId in the admins array of `access.json`. All `/project` commands accept any admin; there is no concept of "project owner" within admins. A bot with multiple admins → any of them can add/switch/remove.

### MCP tools (for Claude to orchestrate NL)

```typescript
// list_projects() → list all registered projects
interface ProjectEntry {
  alias: string
  path: string
  last_active: string  // ISO 8601
  is_current: boolean
}
function list_projects(): ProjectEntry[]

// switch_project({alias}) → trigger switch
// Returns after writing .restart-flag; the actual session restart is async
interface SwitchProjectArgs {
  alias: string
  note?: string  // optional user-provided handoff note
}
function switch_project(args: SwitchProjectArgs): { ok: true } | { ok: false, error: string }
```

**`note` extraction:** Claude decides when to pass a `note`. Rule of thumb: when the user's message contains context beyond the switch itself ("切到 sidecar 继续搞那个 MCP install"), Claude passes the trailing context as `note`. When the user just says "切到 sidecar", `note` is omitted. The note (if any) lands in `_handoff.md`'s body as `用户备注: <note>`.

### NL interaction patterns

Claude (the LLM) parses intent and routes to tools. Server does no NLP.

**Unambiguous:**
- User: "切到 sidecar"
- Claude: `list_projects()` → unique match → acknowledge + `switch_project({alias: "sidecar"})`

**Ambiguous (partial alias matches multiple):**
- User: "切到 compass"
- Claude: `list_projects()` → ["compass", "compass-browser"] both match → "你指 compass（主项目）还是 compass-browser？"

**Unspecified:**
- User: "切项目"
- Claude: list all with last_active + ask which

**Unknown target:**
- User: "切到 xyz"
- Claude: "没找到 xyz。已注册: compass, sidecar, browser. 你要哪个？"

## Error Handling

### User errors → explicit reject + WeChat message

| Scenario | Response |
|---|---|
| alias format invalid | "alias 必须匹配 ^[a-z0-9][a-z0-9_-]{1,19}$" |
| alias conflict on add | "alias 'sidecar' 已存在 (~/Documents/xxx)" |
| path doesn't exist / not a dir | "路径无效: /xxx" |
| switch to unregistered alias | "'foo' 未注册。已注册: compass, sidecar" |
| non-admin invokes /project | "需要 admin 权限" |
| switch to current project | "你已经在 compass 了" |
| remove current project | "不能 remove 当前活跃项目，先切到别处" |

### Runtime failures → safe degradation

| Scenario | Behavior |
|---|---|
| `projects.json` missing | Single-project mode; `/project list` → "还没注册任何项目" |
| `projects.json` corrupted | Read fails; reply with empty list + WeChat warning with file path |
| Target `memory/` write fails (perms) | Continue switch; WeChat: "handoff 写入失败, 切换仍在进行" (handoff is best-effort) |
| `.restart-flag` write fails | Abort switch; keep current session; WeChat reports error |
| supervisor chdir fails | Stay in original cwd; claude respawns there; WeChat: "切换失败 (chdir error), 仍在 <current>" |
| new claude `--continue` fails | supervisor falls back to `--fresh`; push: "<alias> 首次启动 (无旧 session)" |
| new claude crashes 2x <5s | Existing crash-loop guard exits supervisor; user must manually `wechat-cc run` |

### Concurrency

| Scenario | Behavior |
|---|---|
| User sends messages during the ~10s switch window | ilink buffers them; new session flushes on reconnect (existing `/restart` behavior) |
| Two `/project switch` in rapid succession | Second write overwrites `.restart-flag`; supervisor reads latest; MVP doesn't queue |
| External reader during handoff write | Atomic tmp+rename; reader sees old or new, never half-written |

### Security

- `/project add` stores absolute path; alias regex prevents `/`, `..`, whitespace
- Realpath/symlink check NOT done in MVP — admin-only is the trust boundary
- `switch_project` MCP tool accepts `alias` only (not `path`) — prevents Claude from being prompt-injected into switching to `/tmp/evil`
- Handoff filename `_handoff.md` is fixed; no alias substitution in file paths

## Testing Strategy

### Unit tests (vitest, existing framework)

**`project-registry.test.ts`** (~100 LOC):
- add: success / alias conflict / path not directory / alias format invalid
- remove: success / alias not found / current-project protected
- list: empty / sorted by last_active desc
- setCurrent: updates current + both last_actives
- JSON round-trip: write → read → equality
- Corrupted JSON: read fails → empty registry

**`handoff.test.ts`** (~70 LOC):
- writeHandoff to non-existent memory dir (auto mkdir)
- Overwrite existing _handoff.md (single-file policy)
- Create MEMORY.md when missing
- Idempotent index line insertion (no duplication on second write)
- Replace existing `_handoff.md` line in MEMORY.md (not append new line)
- YAML frontmatter format sanity check
- Atomic replace (tmp + rename — verify no half-written state)

**`install-user-mcp.test.ts`** (~60 LOC):
- `~/.claude.json` missing → create with `mcpServers.wechat`
- Has `mcpServers` but no `wechat` → merge, don't break others
- Has `wechat` entry → replace command/args
- Re-run idempotent (no duplicate writes if content unchanged)

### Integration test (deferred, not MVP)

`project-switch.integration.test.ts` (future): mock supervisor + server in-process, send mock WeChat message `/project switch sidecar`, assert flag + handoff + registry updated. Skip real claude spawn (too heavy).

### Manual E2E smoke test (part of release checklist)

1. `wechat-cc install --user` → verify `~/.claude.json.mcpServers.wechat`
2. Register 2 projects; `/project list` output correct
3. NL switch: "切到 sidecar" → <10s later handoff file exists, new session alive
4. New session, ask "刚才聊了啥" → Claude reads `_handoff.md` + jsonl pointer and responds with context
5. Switch back → handoff overwritten with new content (not accumulated)
6. Switch to unknown alias → rejected + shows registered list
7. Non-admin sends `/project switch` → rejected
8. Corrupt `projects.json` manually → WeChat warning + degraded mode
9. Send 3 messages during switch window → all delivered after reconnect, in order

### Regression protection

- Existing `/restart` flow: verify `.restart-flag` without `cwd=` prefix still works (backward compat)
- Existing reply/edit_message/share_page MCP tools: untouched by this feature

## Estimated Implementation

- Production code: ~350 LOC (3 new files + 5 modified)
- Test code: ~230 LOC (3 new test files)
- Documentation: ~80 lines (README update)
- Effort: 1-2 days for a focused implementation, plus review iterations

## Out of Scope for MVP (Deferred Features)

These are valid v2 improvements, explicitly NOT in MVP:

- `/back` / `切回` stack (LIFO of recent projects)
- `/project rename` (alias rename)
- Auto-expire of handoff after N hours
- Explicit rollback on switch failure
- Non-ASCII aliases (中文 aliases)
- Auto-detection of recently-used projects from `~/.claude/projects/`
- Project-scoped allowlists (per-project WeChat user lists)
- Cross-project broadcast ("发给所有注册项目")

Each deferred feature can be a separate small PR on top of the MVP once real need emerges.
