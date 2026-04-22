# Permission Relay Polish (Phase 2 · Sub-spec 3)

**Status**: v0.1 · 2026-04-22
**Target**: v1.1

---

## Goal

Revive the `wechat-cc run --dangerously` flag from v0.x. When set, all reactive session tool-uses run in `bypassPermissions` mode — no WeChat permission prompts, Claude just acts (relying on the model's own judgment to confirm truly destructive operations via natural-language reply, same way Claude Code itself handles `--dangerously-skip-permissions`).

Without the flag, reactive sessions use the Phase 1 permission relay as-is: `permissionMode: 'default'` + `canUseTool` prompts the user on WeChat with a 5-char hash; user replies `y abc12` or `n abc12`.

Trigger isolated eval sessions (Companion spec) always bypass regardless of this flag — decided already; scheduler stalls on permission prompts defeat the purpose.

## Non-goals (v1.1)

- No natural-language replies (`好` / `yes` parity for the relay). v1.2 polish.
- No auto-approve allowlist for read-only tools. v1.2.
- No richer permission prompt content (full commands, diff previews). v1.2.
- No per-persona `permission_mode` override. v1.2.
- No runtime toggle (admin can't `/dangerous on` mid-session). Must set at daemon start via CLI flag; restart daemon to change.
- No per-tool-use admin gate within `--dangerously` mode (interpretation (2) in the brainstorm). Daemon-wide bypass; admin gating is by convention via `access.json.allowFrom[]`. Revisit in v1.2 if shared-bot scenarios emerge.

---

## Design

### CLI surface

`cli.ts` accepts `--dangerously` on the `run` subcommand. Output of `parseCliArgs`:

```ts
export type CliArgs =
  | { cmd: 'run'; dangerouslySkipPermissions: boolean }
  | { cmd: 'setup' }
  | { cmd: 'install'; userScope: boolean }
  | { cmd: 'status' }
  | { cmd: 'list' }
  | { cmd: 'help' }
```

`run` dispatcher forwards the flag to the daemon:

```ts
case 'run': {
  const daemonPath = join(here, 'src', 'daemon', 'main.ts')
  const args = parsed.dangerouslySkipPermissions ? [daemonPath, '--dangerously'] : [daemonPath]
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' })
  process.exit(r.status ?? 1)
}
```

Deprecated-flag warning list shrinks: `--dangerously` is no longer warned about. `--fresh` / `--continue` / `--mcp-config` / `--channels` still warn.

### Daemon surface

`src/daemon/main.ts` reads argv:

```ts
const dangerouslySkipPermissions = process.argv.includes('--dangerously')
```

Passes to bootstrap:

```ts
const { sessionManager, resolve, formatInbound } = buildBootstrap({
  // ... existing
  dangerouslySkipPermissions,
})
```

### Bootstrap surface

`BootstrapDeps` adds:

```ts
dangerouslySkipPermissions?: boolean  // default false
```

`sdkOptionsForProject` conditionally applies:

```ts
const sdkOptionsForProject = (_alias, path): Options => {
  if (deps.dangerouslySkipPermissions) {
    return {
      cwd: path,
      permissionMode: 'bypassPermissions',
      mcpServers: { wechat: mcp.config },
      systemPrompt: CHANNEL_SYSTEM_PROMPT,
      settingSources: ['user', 'project', 'local'],
      // no canUseTool — flag overrides
    }
  }
  return {
    cwd: path,
    permissionMode: 'default',
    canUseTool,
    mcpServers: { wechat: mcp.config },
    systemPrompt: CHANNEL_SYSTEM_PROMPT,
    settingSources: ['user', 'project', 'local'],
  }
}
```

When `dangerouslySkipPermissions === false`, behavior is identical to Phase 1 (no change).

### Admin gate (by convention)

Admins are defined in `~/.claude/channels/wechat/access.json`:

```json
{
  "admins": ["o9cq...@im.wechat"],
  "allowFrom": ["o9cq...@im.wechat"]
}
```

`--dangerously` effect applies to **all reactive sessions**, meaning any message from a chat in `allowFrom[]` reaches Claude with bypass mode active. The expectation:

- Admin runs the CLI (machine access → admin).
- Admin curates `allowFrom[]`.
- If admin adds a non-admin friend to `allowFrom[]` and daemon is in `--dangerously` mode, that friend also benefits from bypass. **Social tradeoff, not code-enforced.**

If you share the bot with less-trusted users, run the daemon WITHOUT `--dangerously`. The permission relay kicks back in; even admins get prompted (predictable for everyone).

### Trigger eval sessions: unchanged

Isolated eval sessions from the Companion spec always use `permissionMode: 'bypassPermissions'` regardless of the daemon's `--dangerously` state. Companion eval is programmatic / non-interactive by design — permission prompts there stall the scheduler.

### Documentation / startup banner

Daemon logs mode clearly on startup:

```
[DAEMON] started pid=… accounts=… mode=dangerouslySkipPermissions=true
  ⚠️  All reactive sessions run with bypassPermissions.
  ⚠️  Claude will still confirm destructive ops via natural-language reply,
  ⚠️  but no WeChat permission prompts will appear.
```

Without the flag:

```
[DAEMON] started pid=… accounts=… mode=strict (permission relay active)
```

README section updated to describe both modes and when to use each.

---

## Implementation touchpoints

Files:
- Modify: `cli.ts` — `parseCliArgs` accepts `--dangerously` on run; `run` dispatcher forwards.
- Modify: `cli.test.ts` — assert `parseCliArgs(['run', '--dangerously'])` → `{cmd:'run', dangerouslySkipPermissions:true}`.
- Modify: `src/daemon/main.ts` — argv read; pass to bootstrap; startup-banner log.
- Modify: `src/daemon/bootstrap.ts` — `BootstrapDeps.dangerouslySkipPermissions`; `sdkOptionsForProject` branches.
- Modify: `src/daemon/bootstrap.test.ts` — add case: flag true → `opts.permissionMode === 'bypassPermissions'`, `opts.canUseTool === undefined`; flag false → unchanged from Phase 1.
- Modify: `README.md` + `README.zh.md` — document both modes.

No deletions. No changes to `src/core/permission-relay.ts` or `src/daemon/pending-permissions.ts` — they remain active for the strict path.

---

## Acceptance criteria

- [ ] `wechat-cc run --dangerously` starts daemon with flag passed through; startup log says `mode=dangerouslySkipPermissions=true`.
- [ ] `wechat-cc run` (no flag) starts in strict mode; log says `mode=strict`.
- [ ] With flag: Claude in a reactive session can call `Bash`/`Edit`/`Write` without a WeChat prompt firing.
- [ ] Without flag: Phase 1 permission relay behavior is unchanged — prompt appears on WeChat with 5-char hash; user replies `y`/`n` + hash; tool resolves.
- [ ] Trigger isolated eval sessions: bypass regardless of flag (tested by running a trigger with `--dangerously` off and confirming the eval doesn't wait for a user prompt).
- [ ] `cli.test.ts` covers `--dangerously` parsing; `bootstrap.test.ts` covers both modes.
- [ ] README documents `wechat-cc run --dangerously` and the admin-by-convention model.

---

## v1.2+ roadmap (items deferred)

- **Natural-language permission replies**: accept `好` / `好的` / `可以` / `yes` / `allow` as allow; `不` / `否` / `no` / `deny` as deny. Only applies when exactly 1 pending (disambiguation).
- **Auto-approve read-only tools**: `Read`, `Grep`, `Glob`, `LS` skip canUseTool entirely. Saves ~70% of prompt exchanges in typical sessions.
- **Richer prompt content**: full Bash commands (not truncated), file+line range for Edit, body preview for Write.
- **Per-user admin gate** (interpretation (2)): canUseTool checks last-inbound chat_id against admins[]. Admins bypass in-place, non-admins prompted. Useful when daemon is shared with non-admin users.
- **Per-persona override**: assistant persona can set `permission_mode: "strict"` in front-matter to force canUseTool even when daemon is in `--dangerously`.
- **Runtime toggle**: `/dangerous on` admin-only command to flip mode mid-session without daemon restart.
- **Session-scoped "trust for N minutes"**: `y abc12 30m` → approve and remember for 30 min on same tool in same session.

---

## Cross-cutting implications

- **Behavior parity with Claude Code**: with `--dangerously`, wechat-cc's reactive session behaves exactly like a local `claude --dangerously-skip-permissions` invocation. Users familiar with Claude Code have zero surprise.
- **Phase 1 investment preserved**: `permission-relay.ts` + `pending-permissions.ts` remain active for the strict path. Nothing deleted.
- **Companion spec alignment**: trigger eval was already bypass. Reactive bypass (via flag) is symmetric. No dual-model weirdness.
- **Multi-user / shared-bot v1.2 clarity**: if sharing emerges, the per-user admin gate is the natural next step; documented in roadmap. Design leaves room.
- **Security note in README is load-bearing**: users picking `--dangerously` must understand the convention-based admin gate. Without that context, they might share the bot + flag and get surprised.
