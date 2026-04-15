# `/restart` Command via WeChat — Design Spec

**Date:** 2026-04-15
**Status:** Draft — pending user review
**Affects:** `~/.claude/plugins/local/wechat/{cli.ts,server.ts}`

## Goal

Let an allowlisted admin trigger a full wechat-cc restart by sending
`/restart` on WeChat, optionally with the same flags that `wechat-cc run`
accepts (`--dangerously`, `--fresh`). Session context is preserved across
restarts via `claude --continue`.

## Motivation

Right now, the only way to restart wechat-cc is to Ctrl+C in the terminal
and rerun `wechat-cc run --dangerously`. Every time a plugin change lands
(and for a dev loop that happens several times a day), the user has to
physically touch the terminal. An in-band `/restart` from WeChat removes
that friction and matches how the rest of the plugin works — you never
leave the chat app.

The Telegram Claude Code channel plugin doesn't have this; neither do the
community `wechat-cc` forks (they're either standalone AI bots or client
libraries, not Claude Code channels). We're designing a new primitive.

## Scope

Two file changes:
- **cli.ts**: extract arg-transformation into a pure function, wrap the
  `spawnSync('claude', ...)` call in a supervisor loop that reads a flag
  file to decide whether to respawn, with args pulled from the flag file.
  Crash-loop protection.
- **server.ts**: add a `/restart [args]` command handler in `handleInbound`.
  Admin-only. Writes the flag file, replies with an ack, finds the claude
  ancestor in the process tree, sends it `SIGTERM`, and self-exits.

## Out of scope

- Re-installing the plugin from disk (no hot plugin swap, code changes still
  require git pull + restart)
- Starting a brand-new wechat-cc when none is running (chicken-and-egg)
- Restarting individual accounts without touching others
- Cross-platform process walking — Linux `/proc` only. macOS users fall
  back to manual Ctrl+C (the channel plugin is Linux-first anyway)

## User model

| WeChat input | Equivalent terminal command | Behavior |
|---|---|---|
| `/restart` | *same as current run flags, session resumed* | "just restart, keep everything" — most common case |
| `/restart --dangerously` | `wechat-cc run --dangerously` | Restart, enable skip-permissions |
| `/restart --fresh` | `wechat-cc run --fresh` | Restart, start a new Claude session |
| `/restart --dangerously --fresh` | both | Combined |
| `/restart --help` | *(no restart)* | Reply with usage text; nothing is killed |

**Empty `/restart` inherits current flags** (spec choice B from the design
discussion). Rationale: the most common case is "reload the plugin code,
don't change mode." Switching modes is explicit with flags.

## Architecture

### State

- **`$STATE_DIR/.restart-flag`**: file whose existence signals "respawn
  requested." Its *content* is the raw wechat-cc-level argv to use on the
  next spawn (whitespace-separated). Empty content = inherit previous args.
- **`$STATE_DIR/wechat-cc.pid`** (existing `server.pid` stays; this is
  for the CLI wrapper): PID of the cli.ts supervisor. Not used in the
  current design but useful for future "external restart" scripting.
  *(Optional, may skip.)*

### cli.ts supervisor loop

```ts
function run() {
  let currentExtraArgs = parseRunArgs(process.argv.slice(3))
  let lastSpawnAt = 0
  let fastExits = 0

  while (true) {
    lastSpawnAt = Date.now()
    const claudeArgs = buildClaudeArgs(currentExtraArgs)
    const result = spawnSync('claude', claudeArgs, { stdio: 'inherit' })

    // Normal exit path: no restart requested
    const flag = readRestartFlag()
    if (!flag) process.exit(result.status ?? 1)

    // Crash-loop protection: two consecutive <5s exits = bail
    const elapsed = Date.now() - lastSpawnAt
    if (elapsed < 5_000) {
      fastExits++
      if (fastExits >= 2) {
        console.error('[wechat-cc] claude exited twice in <5s; aborting restart loop')
        process.exit(1)
      }
    } else {
      fastExits = 0
    }

    // Parse the flag content into new extraArgs. Empty = inherit.
    currentExtraArgs = flag.args.length > 0 ? flag.args : currentExtraArgs
    console.error(`[wechat-cc] restart requested, relaunching with: ${currentExtraArgs.join(' ') || '(none)'}`)
  }
}
```

`parseRunArgs` / `buildClaudeArgs` are extracted from the current inline
logic — no behavior change, just factoring so the loop can reuse them.

### server.ts `/restart` handler

Added to `handleInbound` before the `/help`, `/status`, etc. command fan-out:

```ts
if (text.startsWith('/restart')) {
  if (!isAdmin(fromUserId)) {
    await replyBack('仅管理员可用 /restart')
    return
  }
  const rest = text.slice('/restart'.length).trim()
  if (rest === '--help' || rest === '-h') {
    await replyBack(USAGE_TEXT)
    return
  }
  // Write the flag file *before* killing claude (sync so it's on disk)
  const restartArgs = rest  // raw, including --dangerously / --fresh
  writeFileSync(RESTART_FLAG_PATH, restartArgs, 'utf8')

  await replyBack(`正在重启…${rest ? '（' + rest + '）' : ''}约 5 秒后重连`)

  const claudePid = findClaudeAncestor()
  if (!claudePid) {
    // Couldn't find the ancestor — still try to die ourselves
    log('RESTART', 'warning: could not find claude ancestor, exiting self')
    setTimeout(() => process.exit(0), 500)
    return
  }
  log('RESTART', `sending SIGTERM to claude pid ${claudePid} (requested by ${fromUserId})`)
  try { process.kill(claudePid, 'SIGTERM') } catch {}
  // Safety net: if killing claude doesn't tear us down within 3s, self-exit
  setTimeout(() => process.exit(0), 3000)
  return
}
```

### Finding claude in the process tree

```ts
function findClaudeAncestor(): number | null {
  let pid = process.ppid
  for (let hop = 0; hop < 10; hop++) {
    if (pid <= 1) return null
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      const argv0 = cmdline.split('\0')[0] ?? ''
      const basename = argv0.split('/').pop() ?? ''
      if (basename === 'claude') return pid
      // Walk up: parse /proc/<pid>/stat to get ppid
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const afterParen = stat.substring(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
      pid = parseInt(afterParen[1] ?? '0', 10)  // 2nd field after ')' is ppid
    } catch {
      return null
    }
  }
  return null
}
```

Linux-only. Works off `/proc`, no shell-out. Max 10 hops as a safety bound
(the real chain is 4 deep).

### Admin check

`isAdmin(userId)` returns true if `userId ∈ access.admins ?? access.allowFrom`.
Same targeting rule as the existing permission-relay, reused.

## Message flow

1. User on WeChat: `/restart --dangerously`
2. `bun server.ts` inbound handler catches the `/restart` prefix
3. Writes `.restart-flag` with content `--dangerously` (sync)
4. Replies "正在重启…（--dangerously）约 5 秒后重连"
5. Walks process tree, finds `claude` at pid N
6. `process.kill(N, 'SIGTERM')` + sets 3s self-exit safety net
7. claude exits; bun server.ts dies; cli.ts `spawnSync` returns
8. cli.ts loop reads `.restart-flag`, parses `--dangerously` as new extraArgs,
   rebuilds claude command line, `continue`s the loop
9. New claude spawns with `--dangerously-skip-permissions --continue`
10. Claude Code boots, re-spawns bun server.ts as MCP transport, this
    conversation resumes where it left off (via `--continue`)
11. User sees WeChat tools reconnect, next outbound reply works

Elapsed time: ~3-5 seconds typical.

## Edge cases & mitigations

| Risk | Mitigation |
|---|---|
| Non-admin user sends `/restart` | `isAdmin` check; silently logs + replies "仅管理员可用" |
| Claude crashes instantly on startup (bad flags) | Crash-loop protection: 2 fast exits (<5s each) → break loop, exit with status 1 |
| `.restart-flag` lingers from an old invocation | cli.ts reads flag, then immediately `rmSync`. If loop body never reached, next manual run starts clean |
| SIGTERM doesn't propagate cleanly | 3s self-exit safety net in server.ts ensures bun dies even if claude hangs |
| `/proc` walker doesn't find claude (e.g., unusual process chain) | Reply with warning, still self-exit after 500ms (user falls back to Ctrl+C manually) |
| Race: flag write loses to kill | `writeFileSync` is synchronous + flushes before the kill call |
| Malicious `/restart <evil>` injection | Flag content is passed to `buildClaudeArgs` as whitespace-split tokens; never to a shell. `buildClaudeArgs` only understands `--dangerously`, `--fresh`, `--continue`; unknown tokens fall through to `--` as extra claude args (`spawnSync` doesn't shell-interpret) |
| Ctrl+C in terminal after /restart expected | Ctrl+C sends SIGINT to the process group including cli.ts; spawnSync returns, flag may or may not be set — if set, loop continues (user can Ctrl+C again); if not, clean exit |

## Backward compatibility

- `wechat-cc run` / `wechat-cc run --dangerously` / `wechat-cc run --fresh`
  all keep working exactly as before. The supervisor loop is invisible
  when no restart is ever requested.
- Existing terminal Ctrl+C path is unchanged.
- `.mcp.json` files generated by `wechat-cc install` are untouched.
- No state file schema changes; `.restart-flag` is ephemeral.

## Testing

End-to-end test requires exiting the current session, which defeats the
test. Manual matrix (Task 4 in the plan) catches most failure modes:
format check on the flag, crash-loop guard, admin gate, non-existing flag
cleanup. Code paths that are unit-testable in isolation (`parseRunArgs`,
`buildClaudeArgs`, flag parsing) can get bun test coverage.
