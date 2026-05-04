# `__e2e__/` — daemon end-to-end test infrastructure

Status: **infrastructure landed in v0.5; functional test suite NOT yet implemented**.

## What's here

- **`fake-ilink-server.ts`** — `Bun.serve` mock of ilink with 4 endpoints (getupdates / sendmessage / sendfile / typing). Returns the real ilink wire format (`{ ret, msgs, get_updates_buf }`) so `transport.ts` extracts it correctly.
- **`fake-sdk.ts`** — `vi.mock` factories for `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk`. Tests pass a `FakeSdkScript` whose `onDispatch(text)` returns the agent's tool calls + final text.
- **`harness.ts`** — `startTestDaemon(opts)` boots the full daemon (via `bootDaemon` exported from `main.ts`) against a tmp `stateDir`, fake-ilink, and fake SDKs. Returns a `DaemonHandle` with `sendText` / `waitForReplyTo` / `stop`. No SIGTERM-self — uses programmatic shutdown.
- **`dispatch-solo-claude.e2e.test.ts`** — single boot/poll/shutdown smoke test verifying the infrastructure itself works.

## Why the 12 planned scenarios aren't implemented

The v0.5 plan listed 12 e2e tests (dispatch in 4 modes, admin/mode/onboarding/permission/guard short-circuits, W-tier fires/skips, signal-shutdown). Implementing them requires expanding the infrastructure beyond v0.5 scope:

### Gap 1 — fake-ilink only mocks 4 endpoints; production daemon needs more

- **Typing**: real `sendTyping` first calls `/ilink/bot/getconfig` to fetch a `typing_ticket`, then POSTs to `/ilink/bot/typing` with that ticket. Fake-ilink doesn't implement `getconfig`, so `mwTyping` fails silently and no typing POST appears in `outbox`.
- **Media upload**: `sendFile` for images/voice/files needs `/ilink/bot/upload` flow which fake-ilink doesn't cover.
- **Action**: extend fake-ilink with stubs for `getconfig`, `upload`, etc. as scenarios demand them.

### Gap 2 — fake-sdk doesn't bridge tool calls back to the daemon

When the real Claude SDK encounters a `tool_use` event for a tool from an MCP server (e.g. `wechat-mcp`'s `reply` tool), it spawns the MCP child process which POSTs to the daemon's internal-api which calls `ilink.sendMessage`. Our `fake-sdk.ts` only YIELDS the `tool_use` event — it doesn't trigger the MCP execution. Result: agent "calls" reply but no outbound sendmessage is captured.

Two fixes (pick one):
- **a.** Make fake-sdk smart: when it yields a `reply` tool_use, also POST directly to `daemon.baseUrl/v1/wechat/reply` with the internal-api token. This requires the harness to pass `baseUrl + tokenFilePath` into fake-sdk at install time.
- **b.** Skip tool tests; only assert state-store writes (e.g., `activity.jsonl` row, `milestones` table entry). These don't depend on MCP bridging since W-tier mw write directly via store handles.

Recommendation: do (a) for fidelity. ~30 LOC in fake-sdk + 5 LOC in harness.

### Gap 3 — store paths migrated to SQLite (PR7)

The plan's tests proposed assertions like `readFileSync(stateDir + '/memory/chat1/activity.jsonl')`. After PR7, activity / observations / events / milestones live in `wechat-cc.db` (SQLite). Test assertions should query the db via the same store factories, e.g.:

```ts
const store = makeActivityStore(daemon.db, 'chat1')  // need db handle exposed on DaemonHandle
const rows = await store.listRecent(7)
```

The harness needs to expose the daemon's `db` connection on `DaemonHandle` — small change in `main.ts` `bootDaemon` return shape.

### Gap 4 — `process.kill(SIGTERM)` was wrong (already fixed)

P-T9 originally used `process.kill(process.pid, 'SIGTERM')` to stop the daemon, which would kill the vitest worker. v0.5 P-T11 fixed this by exporting `bootDaemon(opts): DaemonHandle` from `main.ts` and having the harness call `daemonHandle.shutdown()` directly. ✅

## Running the smoke test

```bash
bun --bun vitest run -c vitest.e2e.config.ts
```

To see fake-ilink request logs:

```bash
E2E_DEBUG_ILINK=1 bun --bun vitest run -c vitest.e2e.config.ts
```

## Roadmap to the 12 scenarios

Estimated work to bridge gaps 1+2+3:
- ~50 LOC fake-ilink endpoint expansion
- ~40 LOC fake-sdk tool bridging
- ~10 LOC harness exposes db handle
- 12 test files × ~30 LOC each = ~360 LOC
- ~3-5 hours of debugging timing edge cases (waitForOutbound polling, mock activation order, SQLite write-then-read sequencing)

This is a v0.6 task, not v0.5 cleanup.
