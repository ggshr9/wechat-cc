# `/restart` Command — Implementation Plan

**Date:** 2026-04-15
**Spec:** `docs/specs/2026-04-15-wechat-restart-command.md`
**Target files:** `~/.claude/plugins/local/wechat/{cli.ts,server.ts}`

**Goal:** Add a WeChat `/restart [args]` command that respawns the whole
wechat-cc chain (cli.ts → claude → bun server.ts) while preserving session
context via `--continue`.

**Tech stack:** Bun, TypeScript, `/proc`-based process walking (Linux only).

---

## Task 1 — cli.ts: extract arg builders + supervisor loop

**Files:**
- Modify: `~/.claude/plugins/local/wechat/cli.ts` (the `run()` function
  and surrounding imports)

**Step 1: Add imports + state path constants**

Existing imports already have `readFileSync, writeFileSync, readdirSync`.
Add `rmSync`:

```ts
import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'fs'
```

And define the flag path near the existing `ACCOUNTS_DIR` line:

```ts
const RESTART_FLAG_PATH = join(STATE_DIR, '.restart-flag')
```

**Step 2: Extract `parseRunArgs` and `buildClaudeArgs`**

Before the `run()` function, add:

```ts
interface RunFlags {
  skipPermissions: boolean
  freshSession: boolean
  extraArgs: string[]  // pass-through to claude, e.g. custom flags
}

function parseRunArgs(raw: string[]): RunFlags {
  const extra = [...raw]
  const take = (flag: string): boolean => {
    const idx = extra.indexOf(flag)
    if (idx === -1) return false
    extra.splice(idx, 1)
    return true
  }
  const skipPermissions = take('--dangerously')
  const freshSession = take('--fresh')
  take('--continue')  // noop: --continue is default unless --fresh
  return { skipPermissions, freshSession, extraArgs: extra }
}

function buildClaudeArgs(flags: RunFlags, bun: string): string[] {
  const mcpConfig = JSON.stringify({
    mcpServers: {
      wechat: {
        command: bun,
        args: ['run', '--cwd', PLUGIN_DIR, '--silent', 'start'],
      },
    },
  })
  return [
    '--mcp-config', mcpConfig,
    '--dangerously-load-development-channels', 'server:wechat',
    ...(flags.skipPermissions ? ['--dangerously-skip-permissions'] : []),
    ...(flags.freshSession ? [] : ['--continue']),
    ...flags.extraArgs,
  ]
}

interface RestartFlag {
  args: string[]  // empty = inherit current
}

function readRestartFlag(): RestartFlag | null {
  if (!existsSync(RESTART_FLAG_PATH)) return null
  let content = ''
  try { content = readFileSync(RESTART_FLAG_PATH, 'utf8').trim() } catch {}
  try { rmSync(RESTART_FLAG_PATH) } catch {}
  return { args: content ? content.split(/\s+/) : [] }
}
```

**Step 3: Rewrite `run()` as a supervisor loop**

Replace the existing `run()` body:

```ts
function run() {
  if (!existsSync(ACCOUNTS_DIR) || readdirSync(ACCOUNTS_DIR).length === 0) {
    if (!existsSync(join(STATE_DIR, '.env'))) {
      console.log('没有已绑定的账号。先运行: wechat-cc setup')
      process.exit(1)
    }
  }

  const bun = getBunPath()
  // Clear any stale flag from a previous crashed run
  if (existsSync(RESTART_FLAG_PATH)) {
    try { rmSync(RESTART_FLAG_PATH) } catch {}
  }

  let currentFlags = parseRunArgs(process.argv.slice(3))
  let fastExits = 0

  while (true) {
    const claudeArgs = buildClaudeArgs(currentFlags, bun)
    const startedAt = Date.now()
    const result = spawnSync('claude', claudeArgs, { stdio: 'inherit' })

    const flag = readRestartFlag()
    if (!flag) {
      process.exit(result.status ?? 1)
    }

    // Crash-loop guard: two consecutive <5s exits → bail
    const elapsed = Date.now() - startedAt
    if (elapsed < 5_000) {
      fastExits++
      if (fastExits >= 2) {
        console.error('[wechat-cc] claude exited twice in <5s; aborting restart loop')
        process.exit(1)
      }
    } else {
      fastExits = 0
    }

    // Empty flag content = inherit; non-empty = replace
    if (flag.args.length > 0) {
      currentFlags = parseRunArgs(flag.args)
    }
    const human = [
      currentFlags.skipPermissions ? '--dangerously' : '',
      currentFlags.freshSession ? '--fresh' : '--continue',
      ...currentFlags.extraArgs,
    ].filter(Boolean).join(' ')
    console.error(`[wechat-cc] restart requested, relaunching with: ${human}`)
  }
}
```

**Step 4: Syntax check**

```bash
cd ~/.claude/plugins/local/wechat && bun build cli.ts --target=bun --outfile=/tmp/cli-check.js
```
Expected: `Bundled N modules` with no errors.

**Step 5: Commit**

```bash
git add cli.ts
git commit -m "refactor(cli): extract arg builders + add supervisor restart loop"
```

---

## Task 2 — server.ts: `/restart` command + process walker

**Files:**
- Modify: `~/.claude/plugins/local/wechat/server.ts`

**Step 1: Add restart flag path constant + process walker**

Near the top of the file, after the existing `STATE_DIR` / `ACCESS_FILE`
block:

```ts
const RESTART_FLAG_PATH = join(STATE_DIR, '.restart-flag')
```

Below the `parseAesKey` / `encryptAesEcb` helpers (before the MCP server
setup), add:

```ts
function findClaudeAncestor(): number | null {
  let pid = process.ppid
  for (let hop = 0; hop < 10; hop++) {
    if (pid <= 1) return null
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      const argv0 = cmdline.split('\0')[0] ?? ''
      const base = argv0.split('/').pop() ?? ''
      if (base === 'claude') return pid
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      // stat: "pid (comm) state ppid ..." — ppid is the 2nd field after ')'
      const after = stat.substring(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
      pid = parseInt(after[1] ?? '0', 10)
    } catch {
      return null
    }
  }
  return null
}

function isAdmin(userId: string): boolean {
  const access = loadAccess()
  const admins = (access as any).admins as string[] | undefined
  if (admins?.length) return admins.includes(userId)
  return access.allowFrom.includes(userId)
}
```

**Step 2: Wire `/restart` into `handleInbound`**

Find the existing command fan-out block in `handleInbound` where `/help`,
`/status`, `/ping`, `/users` are handled. Add this case BEFORE them (so
`/restart` takes priority and can't be shadowed):

```ts
  if (text.startsWith('/restart')) {
    if (!isAdmin(fromUserId)) {
      log('CMD', `[${displayName}] /restart (denied: not admin)`)
      ilinkSendMessage(entry.account.baseUrl, entry.token,
        botTextMessage(fromUserId, '仅管理员可用 /restart', contextTokens.get(fromUserId)),
      ).catch(() => {})
      return
    }
    const rest = text.slice('/restart'.length).trim()
    if (rest === '--help' || rest === '-h') {
      const usage = [
        '/restart              — 用当前 flags 重启',
        '/restart --dangerously — 重启并跳过权限',
        '/restart --fresh      — 重启并开始全新会话',
      ].join('\n')
      ilinkSendMessage(entry.account.baseUrl, entry.token,
        botTextMessage(fromUserId, usage, contextTokens.get(fromUserId)),
      ).catch(() => {})
      return
    }

    log('CMD', `[${displayName}] /restart ${rest}`)

    // Sync-write the flag before killing anything
    try {
      writeFileSync(RESTART_FLAG_PATH, rest, 'utf8')
    } catch (err) {
      ilinkSendMessage(entry.account.baseUrl, entry.token,
        botTextMessage(fromUserId, `重启失败: 无法写 flag (${err})`, contextTokens.get(fromUserId)),
      ).catch(() => {})
      return
    }

    // Acknowledge before we tear anything down
    const ackText = `正在重启…${rest ? `（${rest}）` : ''}约 5 秒后重连`
    try {
      await ilinkSendMessage(entry.account.baseUrl, entry.token,
        botTextMessage(fromUserId, ackText, contextTokens.get(fromUserId)))
    } catch (err) {
      log('RESTART', `ack send failed: ${err}`)
    }

    const claudePid = findClaudeAncestor()
    if (claudePid == null) {
      log('RESTART', 'warning: could not find claude ancestor; self-exiting only')
      setTimeout(() => process.exit(0), 500)
      return
    }
    log('RESTART', `sending SIGTERM to claude pid ${claudePid} (requested by ${fromUserId})`)
    try { process.kill(claudePid, 'SIGTERM') } catch (err) {
      log('RESTART', `kill failed: ${err}`)
    }
    // Safety net: die ourselves within 3s even if SIGTERM hangs
    setTimeout(() => process.exit(0), 3000)
    return
  }
```

**Note:** `handleInbound` is already `async`, and its command handlers are
already in an `async` context (they use `await` for most ilinkSendMessage
calls). Confirm before editing — if any branch is sync-only, wrap the ack
in `Promise.resolve()`.

**Step 3: Syntax check + commit**

```bash
bun build server.ts --target=bun --outfile=/tmp/server-check.js
git add server.ts
git commit -m "feat(restart): add /restart command for in-band wechat-cc respawn"
```

---

## Task 3 — Documentation

**Files:**
- Modify: `~/.claude/plugins/local/wechat/README.md`
- Modify: `~/.claude/plugins/local/wechat/README.zh.md` (if it matches the
  English content structure; otherwise skip)

**Step 1:** Add a section under "微信端命令" / "Commands":

```
- `/restart` — 重启 wechat-cc（保留当前 flags，会话通过 --continue 恢复）
- `/restart --dangerously` — 重启并启用跳过权限模式
- `/restart --fresh` — 重启并开始全新会话
```

**Step 2:** Mention the supervisor loop briefly in the architecture section:

> The `wechat-cc run` CLI wrapper runs a supervisor loop — if `/restart`
> is received in a WeChat message, the server writes a flag file, sends
> SIGTERM to the Claude Code parent, and the CLI respawns it automatically
> with the requested flags.

**Step 3:** Commit

```bash
git add README*.md
git commit -m "docs(restart): document /restart WeChat command"
```

---

## Task 4 — Manual test matrix

End-to-end testing requires killing the current session, which kills the
tester. These tests need to be run outside the current Claude Code
conversation, by the user with a fresh terminal.

| # | Steps | Expected |
|---|---|---|
| 1 | From terminal: `wechat-cc run --dangerously`. In WeChat: `/restart` | Ack message. cli.ts prints "restart requested". New claude spawns. WeChat tools reconnect within ~5s. Current claude session is resumed via `--continue`. |
| 2 | From WeChat: `/restart --fresh` | Ack. New claude session with fresh context. |
| 3 | From WeChat: `/restart --help` | Usage text reply. No restart. |
| 4 | Non-admin DM: `/restart` (requires a non-admin user on the allowlist) | Reply: "仅管理员可用 /restart". No restart. |
| 5 | Edit cli.ts to introduce a syntax error. From WeChat: `/restart` | cli.ts sees two fast exits, prints "claude exited twice in <5s; aborting", process exits with status 1. User Ctrl+C and fixes. |
| 6 | With no `/restart` received: Ctrl+C in terminal | Process exits cleanly (flag absent, normal exit path). |
| 7 | After a successful `/restart`: check `$STATE_DIR/.restart-flag` | File absent (cli.ts removed it on read). |
| 8 | From WeChat: send junk `/restart abcd --weird` | Raw string passed through `parseRunArgs`; unknown tokens become `extraArgs` which go to claude. If claude rejects, fast-exit counter kicks in. |

---

## Task 5 — Push

```bash
git push origin master
```

Commits:
- cli.ts supervisor loop (Task 1)
- server.ts /restart handler + process walker (Task 2)
- README update (Task 3)

Three atomic commits, each independently revertable.

---

## Self-review

- [x] Spec coverage: cli.ts supervisor → Task 1; /restart command → Task 2;
      documentation → Task 3; manual testing → Task 4.
- [x] No placeholders: every code block is complete and drop-in ready.
- [x] Type consistency: `RunFlags`, `RestartFlag`, `findClaudeAncestor`,
      `isAdmin`, `RESTART_FLAG_PATH` referenced consistently across tasks.
- [x] Edge cases: crash-loop, non-admin, missing process, stale flag,
      malformed `/restart` input — all covered.
- [x] Security: admin gate, no shell interpolation of user-supplied
      `rest` string (passed through arg array).
- [ ] Cannot verify end-to-end in current session (this session would die
      when `/restart` kills claude). Spec is reviewed for correctness;
      actual runtime verification deferred to Task 4 manual.
