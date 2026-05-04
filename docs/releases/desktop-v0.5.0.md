# wechat-cc desktop v0.5.0

**Date**: 2026-05-03
**Tag**: `desktop-v0.5.0`
**Scope**: Version sync with CLI v0.5.0. **No functional UI changes.**

## What changed

Nothing user-visible. Bumped to keep CLI ↔ desktop versioning in lock-step
after the v0.5 architecture cleanup landed in `master`.

## What didn't change (everything)

The Tauri 2 shell, the wizard, the dashboard, the memory pane, the sessions
view, the doctor poller — all byte-for-byte equivalent to desktop-v0.4.5
behaviorally. The desktop app shells out to the same `wechat-cc` CLI; the
underlying CLI now carries the v0.5 architecture refactor (smaller `main.ts`,
`wiring/` split, `Ref<T>` helper, `bootDaemon()` export, daemon e2e infra,
Playwright tier-2 tests). None of those reach the bundle.

## What's new behind the scenes (test-only, not in bundle)

- **Playwright tier-2 specs** (`apps/desktop/playwright/{wizard,dashboard,interactions}.spec.ts`) — 7 tests covering wizard rendering, dashboard panel structure, observation archive, sessions favorite. Runs against `test-shim.ts` in CI via the new `e2e-browser` workflow job. Not bundled.
- **`test-shim.ts` mocks** for `demo.seed`, QR auto-pass, panel data injection — used by Playwright tests + manual `bun run shim`. Not bundled.

## Install

Same as before. Download from [latest release](https://github.com/ggshr9/wechat-cc/releases/latest):

| Platform | File |
|:---|:---|
| **macOS (Apple Silicon)** | `*.dmg` (right-click → Open on first launch) |
| **Windows (x64)** | `.exe` (NSIS) or `.msi` (SmartScreen → More info → Run anyway) |
| **Linux (x64)** | `.deb` / `.rpm` |

The desktop app shells out to the source-mode CLI; you also need:

```bash
git clone https://github.com/ggshr9/wechat-cc.git ~/.local/share/wechat-cc
cd ~/.local/share/wechat-cc && bun install
```

Or set `WECHAT_CC_ROOT=/some/path`.

## Upgrade from v0.4.x

Just install the new bundle. No state migration, no settings change. The
underlying CLI source you already have should be `git pull`'d to v0.5.0
(or run `wechat-cc update` from the dashboard).
