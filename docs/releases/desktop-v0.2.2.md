# Desktop v0.2.2 — emergency fix: Claude replies were silently dropped

Critical bug found dogfooding v0.2.1: WeChat messages routed to Claude
correctly, daemon and Claude subprocess stayed healthy, but **no
replies ever made it back to WeChat**. The daemon would log
`[ROUTER] route → compass` then `[TYPING] sent`, then go silent. From
the user's side it looks like Claude is hung; from the system side
everything reports green.

If you sent a WeChat message after upgrading to v0.2.0/0.2.1 and never
got a reply, this is the fix.

## Root cause

`src/core/claude-agent-provider.ts` `dispatch(text)` was fire-and-forget:
push the user message onto the SDK queue, return `void` immediately.
But `src/core/message-router.ts` expects `dispatch()` to return
`{ assistantText: string[] }` so it can forward the reply via
`ilink.sendMessage()`:

```ts
const result = await handle.dispatch(text)
for (const assistantText of result?.assistantText ?? []) {
  await deps.sendAssistantText?.(msg.chatId, assistantText)
}
```

The Codex provider did this correctly — it shells out to `codex exec`,
awaits stdout, returns `{ assistantText: [stdout] }`. The Claude
provider didn't, so `result?.assistantText ?? []` was always `[]`, and
the `for` loop never iterated. **Every Claude reply went to /dev/null.**

This regressed in `1160b44` (the v1.2 desktop GUI + provider abstraction
landing). Codex installs were unaffected.

## Fix

Provider's dispatch now creates a per-turn awaitable. The SDK iterator
loop pushes assistant text into the in-flight turn (head of a
`pendingTurns` queue) and resolves the turn's promise when the
`result` event fires. So `dispatch()` blocks until Claude finishes its
turn, then returns the collected text — exactly what message-router
expects.

```ts
type Turn = { texts: string[]; resolve: (v: { assistantText: string[] }) => void; reject: (e: unknown) => void }
const pendingTurns: Turn[] = []
// ... in SDK iterator, on `result`: pendingTurns.shift()!.resolve({ assistantText: [...] })
async dispatch(text) {
  return new Promise(...) // queue.push + register pendingTurn
}
```

Concurrent dispatches FIFO via the array. Errors during the SDK stream
reject all pending turns. `close()` resolves any still-pending turns
with empty text rather than hanging callers mid-await.

## Other fixes shipped in this release

### `findOnPath` falls back to per-user binary roots

Doctor reported `Bun missing` and `Codex missing` in the GUI on Linux
even when both were installed. Root cause: GUI sessions inherit a
narrow PATH (`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`)
that doesn't include `~/.bun/bin` or `~/.nvm/versions/node/<v>/bin`.
`findOnPath` now scans common per-user roots when `which/where`
misses: `~/.bun/bin`, `~/.cargo/bin`, `~/.deno/bin`,
`~/.nvm/versions/node/<latest>/bin`, plus `/opt/homebrew/bin` and
`/usr/local/bin` on macOS.

### Wizard copy + QR cleanup

- `下方任何一项缺失` → `上方任何一项缺失` (the env-check list is
  above the text, not below).
- After `setup-poll` returns `confirmed`, the QR box is replaced with
  a checkmark + bound account ID. Leaving the now-invalid QR on screen
  was confusing.

### Service step button hierarchy

- "进入控制台" is now disabled until daemon.alive=true. The button
  used to be clickable even when no service was installed and no
  daemon was running, dropping the user into a "Daemon offline" dashboard
  with no clear next step. Helper title explains why.
- After 安装并启动, the wizard polls doctor every 500ms for up to 8s,
  waiting for `daemon.alive=true` before reporting success. Previously
  a single immediate `loadDoctor()` raced against systemd's 1-3s
  daemon spawn and the wizard always reported "未运行" even when the
  install worked. The summary now shows `服务已启动 · pid X` after
  the daemon comes up.

## Verification

- 482 tests passing (was 478; +4 new tests for the dispatch/result
  contract on `claude-agent-provider`)
- Local sidecar compiled (`bun build --compile cli.ts`) and verified
  with manual WeChat round-trip after deploying

## Install

Same routes as v0.2.1. State at `~/.claude/channels/wechat/` carries
over without migration.

| Platform | Bundle |
|:---|:---|
| macOS (Apple Silicon) | `wechat-cc_0.2.2_aarch64.dmg` |
| Windows (x64) | `.exe` (NSIS) · `.msi` |
| Linux (x64) | `.deb` · `.rpm` |
