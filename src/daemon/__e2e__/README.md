# `__e2e__/` — daemon end-to-end test infrastructure

Status: **12 functional tests passing in ~4s**. Covers 4 dispatch modes + media + RFC 03 + restart persistence. 7 of the 12 originally-planned short-circuit / W-tier / signal scenarios are still unwritten — see [Outstanding](#outstanding) below.

Run: `bun --bun vitest run -c vitest.e2e.config.ts`

## Infrastructure

- **`fake-ilink-server.ts`** — `Bun.serve` mock of ilink. Implements `getupdates` / `sendmessage` / `sendfile` / `typing`. Returns the real ilink wire format (`{ ret, msgs, get_updates_buf }`) so `transport.ts` extracts it correctly. **Does NOT implement** `getconfig` (typing ticket) or `upload` — see Gap 1.
- **`fake-sdk.ts`** — `vi.mock` factories for `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk`. Tests pass a `FakeSdkScript` whose `onDispatch(text)` returns the agent's tool calls + final text. When a script yields a `reply` tool_use, the harness bridges it to the daemon's internal-api so the outbound `sendmessage` lands in the fake-ilink outbox — see `reply-tool-bridge.e2e.test.ts`.
- **`fake-media.ts`** — materializes a 3-byte stub file at `<stateDir>/inbox/<chatId>/` for image RawUpdates; inbound pipeline rewrites `attachment.path` so `formatInbound` emits the `[image:/path]` marker.
- **`harness.ts`** — `startTestDaemon(opts)` boots the full daemon (via `bootDaemon` exported from `main.ts`) against a tmp `stateDir`, fake-ilink, and fake SDKs. Returns a `DaemonHandle` with `sendText` / `sendImage` / `waitForReplyTo` / `waitForOutbound` / `stop`. No SIGTERM-self — programmatic shutdown. Supports `stateDirOverride` for restart-persistence tests that boot the daemon twice against the same on-disk SQLite db.

## Current test coverage

12 `it()` blocks across 11 test files:

| Test file | What it verifies |
|---|---|
| `dispatch-solo-claude.e2e.test.ts` | Smoke: daemon boot/poll/shutdown |
| `inbound-reply.e2e.test.ts` | Solo-claude functional: user text → reply lands in outbox |
| `dispatch-solo-codex.e2e.test.ts` | `/codex` solo path → codex provider dispatched |
| `dispatch-parallel-both.e2e.test.ts` | `/both` → 2 outbounds with `[Claude]` / `[Codex]` prefixes |
| `dispatch-primary-tool.e2e.test.ts` | RFC 03 `/cc + codex` → only primary dispatched, secondary as delegate |
| `dispatch-chatroom-text.e2e.test.ts` | `/chat` → speaker prompt carries `[chat_id:…]` |
| `dispatch-chatroom-image.e2e.test.ts` | `/chat` + image → speaker prompt carries `[chat_id:…]` and `[image:/…]` |
| `dispatch-image-solo.e2e.test.ts` | Solo + image → `[image:/path]` envelope reaches speaker |
| `mode-switch.e2e.test.ts` | `/codex` slash flips mode for subsequent messages |
| `restart-mode-persistence.e2e.test.ts` | Chat mode survives daemon stop+start cycle (uses `stateDirOverride`) |
| `reply-tool-bridge.e2e.test.ts` (×2) | Reply tool → exactly one outbound, no double-fire; missing reply tool → fallback forwards assistant text |

Solid in: 4-mode dispatch (#1–4 from the v0.5 plan), image envelope, RFC 03 primary_tool mode, restart persistence, reply-tool bridging vs fallback.

## Outstanding

### Plan scenarios still unwritten (7 of 12)

| Plan # | Scenario | Notes |
|---|---|---|
| 5 | `admin-shortcircuit` (`/health`) | mwAdmin path — should assert outbound present + NO claudeScript invocation. Doable with current harness. |
| 6 | `mode-shortcircuit` (`/cc`) | `mode-switch.e2e.test.ts` covers the state flip but does NOT assert "no dispatch happens on the command turn itself". Strengthen or add new file. |
| 7 | `onboarding` | Unknown user → nickname prompt → user replies "Alice" → confirmation. Harness already supports back-to-back `sendText`. Needs `knownUsers: {}` opt-out (already exposed). |
| 8 | `permission-relay` | Strict-mode `canUseTool` → `[abc12]: y/n?` prompt → `y abc12` inbound resumes the call. Requires fake-sdk script that holds for response (current scripts are one-shot). |
| 9 | `guard-network-down` | Pre-set guard config + simulate unreachable → outbound is the "VPN dropped" refusal. Needs a way to seed guard state at boot. |
| 10 | `w-tier-fires-on-dispatch` | After a reply, assert `activity` store has 1 row for this chat. **Blocked on Gap 3** (db not exposed on `DaemonHandle`). |
| 11 | `w-tier-skips-on-shortcircuit` | After `/health`, assert NO new activity rows. **Blocked on Gap 3**. |
| 12 | `signal-shutdown` | Mid-flight reply + SIGTERM-equivalent → daemon completes send before exit. Needs a `daemon.shutdownNow()` distinct from `daemon.stop()`. |

### Infrastructure gaps

- **Gap 1 — fake-ilink missing `getconfig` and `upload`.** `mwTyping` logs `ilink/bot/getconfig 404` on every dispatch (harmless — typing is best-effort) but means no test can assert a typing POST in the outbox. Outbound `sendfile` works for images/files we already have on disk; the `upload` endpoint is needed only if a test agent CALLS the `share_page` or media-out tools. Not blocking any planned scenario today.
- **Gap 2 — fake-sdk reply bridging.** **CLOSED.** `reply-tool-bridge.e2e.test.ts` demonstrates the bridge works end-to-end (one outbound per reply call, no double-fire on fallback).
- **Gap 3 — `db` not exposed on `DaemonHandle`.** Blocks W-tier assertions (#10, #11). Fix is ~5 LOC in `bootDaemon` return shape + harness pass-through.
- **Gap 4 — `process.kill(SIGTERM)` was wrong.** **CLOSED** in v0.5 P-T11 via `bootDaemon`/`shutdown` direct call.

### Order of attack if you come back to this

1. Add Gap 3 (db on `DaemonHandle`) — unblocks #10 + #11.
2. Write #5, #6 (strengthen mode-switch), #7 — all doable with current harness, ~30 LOC each.
3. Write #10, #11 — once Gap 3 is in, they're trivial.
4. Write #8 (permission-relay) — needs fake-sdk to support a 2-step script (yield tool_use, wait for permission resume, then yield final text).
5. Write #12 (signal-shutdown) — needs `daemon.shutdownNow()` shape.
6. Write #9 (guard-network-down) — needs a guard-state seed hook.

## Debugging

To see fake-ilink request logs:

```bash
E2E_DEBUG_ILINK=1 bun --bun vitest run -c vitest.e2e.config.ts
```
