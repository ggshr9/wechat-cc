# Desktop v0.3.0 — editable memory, macOS Intel bundle, daemon log tail

Three user-visible features on top of the v0.2.x architecture cleanup.
The dashboard's three placeholder slots (memory was view-only, the
日志 sidebar entry said "soon", macOS Intel users had no bundle) all
turn into working tools in this release.

## What's new

### 1. Editable memory pane

`memory/<chat_id>/*.md` was read-only — you could see what Claude wrote
about you, but couldn't correct mistakes, prune outdated notes, or seed
your own context. v0.3.0 adds an **编辑 → 保存** flow:

- Open a memory file → 编辑 button reveals a textarea pre-filled with
  the raw markdown.
- Edit + 保存 → the GUI base64-encodes the body, calls
  `wechat-cc memory write <user> <path> --body-base64 <b64>`, the CLI
  validates against the same sandbox Claude's MCP write tool uses
  (`.md` only, ≤100KB, no path traversal, atomic rename via .tmp-<pid>),
  and the pane re-renders the new content.
- 取消 reverts unsaved changes. Switching files mid-edit prompts before
  discarding.

UTF-8 round-trips faithfully (Chinese + emoji `🍣` survive `btoa(unescape(
encodeURIComponent(body)))`). Tested across atomic writes, oversized
bodies, traversal attempts, missing parent dirs, and concurrent-edit
guards.

### 2. macOS Intel — deferred (capacity issues)

Originally planned for v0.3.0 but pulled at cut time: GitHub's free-tier
`macos-13` runners stayed queued indefinitely and never picked up the
job. The compile pipeline is already parameterized via matrix vars
(`bun_target`, `rust_triple`) so adding Intel back is one matrix row
plus one runner that actually starts. v0.3.x will re-attempt.

In the meantime, Intel Mac users can install via source mode
(`git clone … ~/.local/share/wechat-cc && bun install`) and use the
CLI directly.

### 3. Daemon log tail in the dashboard

The `日志` sidebar entry no longer says `soon` — it opens a real logs
pane. The pane:

- Calls `wechat-cc logs --tail N --json` (default 50, dropdown for
  100/200/500).
- Renders one row per entry with timestamp / tag / message in three
  columns. Tag tones color-code at a glance: ERROR/PANIC/CRASH red,
  SESSION_EXPIRED/TIMEOUT/STREAM_DROP amber, SESSION_INIT/POLL/READY
  green.
- Auto-refreshes every 10s while the pane is active; stops on
  switch.
- Continuation lines (stack traces, free-form `console.error`) render
  in muted gray so the well-formed ones still scan.

For terminal users: `wechat-cc logs --tail 30` works the same as
`tail -n 30 ~/.claude/channels/wechat/channel.log`.

## Internals + architecture pass

This release also sweeps in the Tier 1+2+3 architecture cleanup
landed across master since v0.2.2:

- `runtime-info.ts` centralizes Bun virtual-fs detection (was
  duplicated 3 times). Two-stage probe survives a future `/$bunfs/`
  prefix change.
- `apps/desktop/src/doctor-poller.js` replaces the stale-cache
  `state.doctor` foot-gun. Single in-flight promise + subscriber model
  + `waitForCondition` for "wait for daemon to come up" flows.
- `apps/desktop/src/main.js` split from 832-line god file into 8 named
  modules (boot/wiring stays in main.js at 230 lines).
- `apps/desktop/src/view.js` `UPDATE_REASON_COPY` drift table — adding
  a new `UpdateReason` is one row in one place.
- `claude-agent-provider.ts` typed message narrowing (was 8 places
  with `(msg as any)`); `[STREAM_DROP]` warning when assistant text
  arrives without a pending turn.
- `update.ts` `runMutatingSteps` extraction — daemon-restore on
  failure is one line in one branch instead of three explicit calls.
- `[hidden] { display: none !important }` global guard fixes the
  silent class-vs-attribute specificity bug that surfaced when the
  memory edit-mode buttons were initially all visible.

## Verification

- 551 vitest pass across 53 suites (was 482 in v0.2.2 — net +69 cases
  spread across runtime-info / doctor-poller / view drift sweeps /
  shim e2e / claude-agent-provider drop test / memory write / logs).
- `tsc --noEmit` clean for all touched files.
- Local install + manual round-trip of every feature on macOS aarch64.
- shim e2e end-to-end smoke covers HTML structural anchors + 8 CLI
  invoke contracts (doctor / provider / service / update / memory list /
  memory read / memory write reject / logs tail).

## Install

| Platform | Bundle | Notes |
|:---|:---|:---|
| **macOS (Apple Silicon)** | `wechat-cc_0.3.0_aarch64.dmg` | Right-click → Open on first launch (or `xattr -cr /Applications/wechat-cc.app`) |
| **Windows (x64)** | `.exe` (NSIS) · `.msi` | SmartScreen → 更多信息 → 仍要运行 |
| **Linux (x64)** | `.deb` · `.rpm` | No warning |

Bundles are still unsigned (Apple Developer ID + Windows EV cert
pending). The first-run flow is unchanged from v0.2.x.

## Upgrading from v0.2.x

State at `~/.claude/channels/wechat/` is shared and forward-compatible
— accounts, allowlist, context tokens, memory files all carry over
without migration. The compiled-bundle in-GUI updater stays hidden
(`not_a_git_repo` short-circuit); download the new bundle from this
release.
