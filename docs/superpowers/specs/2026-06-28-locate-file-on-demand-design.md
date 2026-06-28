# On-demand file location (`locate_file`) + learned locations

**Date:** 2026-06-28
**Status:** approved
**Related:** [[positioning-and-differentiation]] (memory is the spine; work+life
not split), [[architecture-conventions]] (new capability = capability/tool +
tier gate, daemon↛cli layering, god-file split), [[ai-native-self-healing]]
(the admin-only MCP tool + internal-api route + tier-gate pattern this copies),
`src/lib/memory-synthesis.ts` (the `_overview` synthesis this complements).

## What this is (and is not)

The admin should be able to ask, in WeChat, "看下我那个预算文档" / "桌面上那个
合同放哪了" and have the agent **find the file on the admin's own computer, read
it, answer, and remember where it lives** — so next time it's an instant hit.

This is **sub-project 1 of 2**. The user chose "both, on-demand first":

- **Sub-project 1 (this spec): on-demand retrieval + location learning.** The
  agent calls a tool to locate a specific file (or browse what's around), reads
  the chosen one with its existing `Read`, and records the mapping in memory.
- **Sub-project 2 (separate, later spec): ambient understanding.** Fold a cheap
  directory/filename survey into the `_overview` synthesis so the bot passively
  "knows roughly what's on your computer." NOT in scope here.

### Explicit non-goals (YAGNI — decided with the user)

- **No embeddings / vector store.** Filenames + folder structure already carry
  most of the semantic signal for personal files; the LLM agent is the free
  semantic layer (it reformulates "预算"→budget/financials and can fall back to a
  bounded content grep). Embeddings would require reading+embedding all content
  (slow, a stored-content privacy surface, model+store lifecycle) for marginal
  gain on one user's few-thousand personal docs. Revisit only if proven
  insufficient (huge corpus + filename-useless content + cheap path validated as
  inadequate).
- **No background index / crawl.** Retrieval is a **stateless live bounded
  walk** each call. The only persisted state is `locations.md` — a tiny,
  human-readable file the LLM maintains. (This is the user's "别后台爬全盘" /
  低负担 principle.)
- **No file organizing / moving / renaming / writing.** Locate + read only.
  "Organizing files" is not the moat.
- **Admin-only.** Only the owner's own chat can search the owner's computer.

## Mechanism: how `locate_file` actually finds things

Each call runs `locateFiles({ roots, query, mode, limits })` over the resolved
roots — **no stored index, no embeddings**:

- **Roots** = default life dirs (`~/Desktop`, `~/Documents`, `~/Downloads`) **+**
  any absolute roots harvested from the admin's `locations.md`. Learned roots are
  searched first (cheap, and usually where the answer is).
- **Bounded walk:** max depth, skip `node_modules` / `.git` / dotdirs /
  `Library`, cap total entries scanned, wall-clock timeout. Returns partial +
  a `truncated` flag rather than ever running unbounded.
- **`mode: 'name'` (default):** fuzzy substring match on filename + relative
  path. Fast, never opens file contents.
- **`mode: 'content'` (fallback):** bounded grep inside files — the agent only
  reaches for this when name-matching returns thin. Cap files grepped + bytes
  per file.
- **`mode: 'browse'`:** empty/absent query under a given root → list what's
  there (directory map + filenames), covering "看有哪些文件 / 大致在哪".
- **Returns metadata only** — ranked `[{ path, name, dir, bytes, mtime, score }]`,
  capped (~10). **Never returns file contents.** Content reaches the agent only
  when it deliberately `Read`s a path the user has effectively pointed at.

## Components (4, single-purpose)

### a) `locateFiles()` — pure core (`src/lib/locate-files.ts`)

Pure function, no daemon/cli imports (layering rule). Signature roughly:

```
locateFiles(opts: {
  roots: string[]; query?: string; mode: 'name'|'content'|'browse';
  limits: { maxDepth; maxEntries; maxResults; timeoutMs;
            grepMaxFiles?; grepMaxBytesPerFile? };
}): { candidates: Candidate[]; scannedEntries: number; truncated: boolean }
```

Fully unit-testable against a temp-dir fixture. This is the isolated unit — name
ranking, content fallback, depth/cap/skip rules, missing-root tolerance,
learned-roots-first ordering all live here. Reuses the `CONTAINER_SEGMENTS` idea
from `memory-synthesis.ts` only if helpful (not required).

### b) `GET /v1/locate` — internal-api route (`routes-files.ts`)

Thin route, inline-validated (no schema-table entry → existing route-count tests
unchanged, same trick `tools-daemon` routes used). It:

1. Resolves roots = default life dirs + roots parsed from the admin's
   `locations.md` (best-effort: missing file → just defaults).
2. Calls `locateFiles`.
3. Returns `{ candidates, truncated }`, metadata only.

Tier: **admin**. `route-tiers.ts` already defaults unlisted routes to `admin`
(fail-closed), so listing it explicitly as `'GET /v1/locate': 'admin'` is
belt-and-suspenders. Default life dirs resolved via `os.homedir()`; the route is
the only place the default-dir list lives (one source of truth, easy to change).

### c) `locate_file` MCP tool (`src/mcp-servers/wechat/tools-files.ts`)

New sibling following the god-file split, registered like the other tool groups.
Thin wrapper over `GET /v1/locate` — same shape as `diagnostic_health`
(`tools-daemon.ts:57`). Args: `query?: string`, `mode?: 'name'|'content'|'browse'`
(default derived: query present → `name`, absent → `browse`).

Gating, mirroring the daemon tools exactly:

- New `ToolKind 'file_locate'` in `user-tier.ts` (added to the `ToolKind` union
  ~:20 and to `ADMIN_ONLY` :83). `classifyToolUse` (:199) maps `locate_file`
  (prefix `locate_`) → `file_locate`, **fail-closed** into admin-only like the
  daemon family.
- Registered **only** for admin sessions — same `WECHAT_SESSION_TIER==='admin'`
  gate the daemon tools use (so it doesn't even LIST for non-admin, and the
  route 403s as a second layer).
- Add `file_locate: []` to every provider's `TOOL_KIND_TO_*_BUILTINS`
  (claude + codex) — the exhaustive `Record<ToolKind>` needs the key (MCP-only).

### d) `locations.md` convention + prompt nudge (no new storage code)

`locations.md` is just a memory file under the admin's memory dir, sibling to
`profile.md` / `agenda.md`, written via the **existing** `memory_write`. Format:
one human-readable line per known thing,

```
- 预算文档 → /Users/me/Documents/工作/Q3预算.xlsx
- 合同（根目录） → /Users/me/Documents/合同/
```

Behavior lives in a prompt section, gated + delivered through the **existing**
`appendInstructions` seam (`prompt-builder.ts`, same predicate/seam as
`daemonSelfHealSection`, gated on `tierProfile.allow.has('file_locate')`):

> when the admin refers to a file/document → call `locate_file`; if name-match is
> thin, retry with reworded query or `mode:'content'`; on a confirmed hit, `Read`
> it and append the mapping to `locations.md` via `memory_write`; if nothing is
> found, **ask once** in WeChat ("X 一般放哪？") and record the answer's root in
> `locations.md`. Range is learned by use, not configured.

The tool stays pure-read; **writing memory is the agent's job** (consistent with
how all memory works today). The route (b) reads `locations.md` to seed roots, so
the loop closes: ask once → recorded → searched-first forever after.

## Data flow (one full loop)

```
WeChat: "看下我那个预算文档"
  → agent: locate_file("预算")
  → MCP → GET /v1/locate?q=预算&mode=name
  → locateFiles(roots = [..learned from locations.md.., ~/Desktop, ~/Documents, ~/Downloads])
  → candidates (metadata only)
  → agent picks / asks user to confirm the right one
  → agent: Read(/Users/.../Q3预算.xlsx)        # existing tool
  → answers in WeChat
  → agent: memory_write(locations.md, append "- 预算文档 → /Users/.../Q3预算.xlsx")
Next time: locations.md root searched first → instant hit.
Not found: agent asks "预算文档一般放哪？" → records that root → learned.
```

## Error / edge handling

- Missing default dir / unreadable subdir → skip, continue (best-effort, like
  `gatherLifeContext`).
- Too many matches → capped at `maxResults` + `truncated:true`; agent says "还有
  N 个，缩小关键词".
- Huge dir / slow disk → bounded walk returns partial + `truncated`.
- Non-admin caller → tool absent (not registered) AND route 403 (double gate).
- Content never enters context except via the agent's explicit `Read` of a path
  the user effectively pointed at.

## Testing (TDD)

1. `locate-files.test.ts` (temp-dir fixtures): name-match ranking; content
   fallback finds by body; depth/maxEntries/timeout bounds + `truncated`; skip
   rules (node_modules/.git/dotdirs); missing-root tolerance; learned-roots
   searched first; browse mode lists a dir.
2. route test: admin 200 / trusted 403 / guest 403; param validation; roots
   include parsed `locations.md` entries; route-count tests unchanged.
3. tool-registration / integration test: `locate_file` LISTs only for admin
   (extend `mcp-servers/wechat/integration.test.ts:92` style).
4. `user-tier.test.ts`: `classifyToolUse('locate_file', …) === 'file_locate'`;
   `file_locate ∈ ADMIN_ONLY` (trusted denies, admin allows); unknown
   `locate_*` sibling fails closed to `file_locate`.
5. `prompt-builder.test.ts`: section present iff `file_locate` allowed
   (markers like `locate_file`, `locations.md`); absent otherwise.

## Out of scope (restated)

- Ambient `_overview` filesystem survey → sub-project 2, separate spec.
- Embeddings / vector store / background index → not now (rationale above).
- File write/move/rename/organize.
- Non-admin / multi-user file access.
- cursor prompt wiring (injects nothing today; the seam is ready).
