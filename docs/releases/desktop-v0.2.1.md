# Desktop v0.2.1 — first-launch UX fixes

Patch release on top of v0.2.0. No new features; six bug fixes that
came out of dogfooding the v0.2.0 bundle on a machine that already had
a working CLI install. If you got `Failed to start wechat-cc.service:
Unit not found` clicking 重启 daemon, this is the fix.

## What's fixed

### Restart-daemon button respects whether a service is registered

v0.2.0's overview-page restart button shelled out to `service stop` +
`service start` blindly. If you hadn't walked through the wizard's
service step yet (e.g. fresh GUI install on top of an existing CLI
checkout), the systemctl/launchctl call would fail with `Unit not
found` and bubble that error up as if it were a daemon problem.

v0.2.1's button now reads the new `service.installed` field from
`wechat-cc doctor --json`:

| state | button label | click action |
|:---|:---|:---|
| service installed (any daemon state) | `重启 daemon` | stop + start, as before |
| service missing, daemon down | `去设置向导` | route to wizard step "service" |
| service missing, daemon alive (foreground source-mode) | `去安装服务` | route to wizard, with PID-aware tooltip |

### Wizard pre-install foreign-daemon detection

If you had `bun src/daemon/main.ts` running from a previous CLI
install, clicking "安装并启动" in v0.2.0 would write a fresh systemd
unit, the unit would spawn a second daemon, the second daemon would
lose the `server.pid` lock fight against the existing one, exit,
`Restart=always` would loop, and you'd be stuck in install-failed
limbo.

The wizard now pre-checks `service status --json` before touching any
unit files. If `installed=false && alive=true`, it reuses the existing
post-stop alert UI with pre-install copy:

> 先停掉前台 daemon (pid X) — 否则装上的 service 会立刻被 PID 锁挤掉

with the existing 强制 kill 进程 button wired up.

### Update flow restores the daemon on failure

`wechat-cc update --json` (apply mode) stops the service before
running `git pull` + `bun install`. The early-return failure paths
— `pull_conflict`, `bun_missing`, `install_failed` — exited without
calling `service.start()`, leaving the daemon down indefinitely. WeChat
would go silently dark until you noticed and `wechat-cc service start`'d
manually.

Each failure path now wraps a best-effort `service.start()` before
returning the original error. The error surface is unchanged — you
still see the real failure reason — but the daemon comes back up.

### Bundled fonts (no Google CDN at runtime)

v0.2.0 shipped `@import url("https://fonts.googleapis.com/...")` in
its CSS. On networks without Google access (corporate firewalls, China
mainland, plane wifi, Tor) the request would time out, fall back to
system fonts, and break visual fidelity. The "self-contained bundle"
promise was technically a lie.

v0.2.1 ships Geist + Geist Mono variable woff2 (latin subset, ~60KB
combined) inside `apps/desktop/src/fonts/` and uses local `@font-face`
declarations. CJK rendering keeps using the OS-level fallback chain
(PingFang SC on macOS, Microsoft YaHei via system-ui on Windows,
distro-installed Noto on Linux); shipping Noto Sans SC would balloon
the app by several MB to no benefit on systems that already have a CJK
font installed.

Verified offline by blocking `fonts.gstatic.com` and `fonts.googleapis.com`
at the DNS resolver — fonts still render.

### Window-size mismatch

Default window jumped from 980×680 to 1100×860, and the wizard /
dashboard padding tightened from 28/64 to 24/24. The previous defaults
left a ~88px grey gutter around the content card on small windows; the
new defaults let the content card fill the window edge-to-edge with
just a 24px breathing margin.

### Misc cleanup

- `wechat-cc install [--user]` now exits 2 with a deprecation message
  pointing at `wechat-cc service install`. The MCP-channel mode it
  served was retired in v1.0; the `~/.claude.json` entry it wrote
  (`['run', '--cwd', here, '--silent', 'start']`) wasn't even valid
  for the v1.2 parser anymore.
- `serviceStatus()` returns a real 4-state machine (`missing` /
  `stopped` / `running` / `stale`) instead of conflating
  `installed = daemon.alive`.
- `doctor --json` exposes a new `checks.service: { installed, kind }`
  field.

## Verification

- vitest: 478 passed (was 466 in v0.2.0; added 12 cases covering the
  new state machine + restart-button view-model + applyUpdate
  daemon-restoration paths)
- Sidecar binary recompiled (`bun build --compile cli.ts`, ~101MB on
  Linux x64) — verified `service status --json` returns the new shape
  in compiled mode (`/$bunfs/` argv detection still works)
- End-to-end via `apps/desktop/test-shim.ts` driven by Playwright:
  reproduced and confirmed fixed the user-reported "Unit not found"
  flow on first GUI launch with existing CLI accounts; reproduced the
  foreign-daemon pre-install scenario by writing a sleep PID into
  `server.pid` and confirmed the alert fires.

## Install

Same routes as v0.2.0:

| Platform | Bundle |
|:---|:---|
| macOS (Apple Silicon) | `wechat-cc_0.2.1_aarch64.dmg` |
| Windows (x64) | `.exe` (NSIS) · `.msi` |
| Linux (x64) | `.deb` · `.rpm` |

(AppImage is still skipped on Linux — `linuxdeploy` keeps failing on
ubuntu-latest. `.deb` and `.rpm` are the supported Linux paths.)

## Upgrading from v0.2.0

The in-GUI updater is still hidden in compiled mode (the
`not_a_git_repo` short-circuit), so download the new bundle from this
release. State at `~/.claude/channels/wechat/` is shared and forward-
compatible — accounts, allowlist, context tokens carry over without
migration.
