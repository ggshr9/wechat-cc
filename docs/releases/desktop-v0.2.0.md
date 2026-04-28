# Desktop v0.2.0 — self-contained installer

> **Replaces v0.1.0, which was withdrawn.** v0.1.0 shelled out to a
> system-installed `bun` and a separately-cloned `wechat-cc` source tree —
> i.e. installing the .app gave the user nothing on its own. v0.2.0 fixes
> that by bundling a compiled-native `wechat-cc-cli` sidecar into every
> platform's bundle.

## What's actually different

- **The CLI is now inside the app.** `bun build --compile cli.ts` produces
  a self-contained `wechat-cc-cli` binary (~63 MB) per platform. Tauri
  bundles it via `externalBin`; the Rust shim spawns it through
  `tauri-plugin-shell`. No system Bun. No cloned source. Drag → run → works.
- **The daemon is the same binary.** When the wizard installs the service
  (LaunchAgent / systemd / Scheduled Task), the unit's ExecStart points at
  the bundled `wechat-cc-cli run --dangerously` — the daemon entry imports
  through cli.ts's compiled bundle instead of spawning a child Bun process.
- **Update card auto-hides for desktop bundles.** A new
  `not_a_git_repo` reject reason short-circuits `wechat-cc update --check`
  when the binary lives inside an .app (no `.git` next to it). The GUI
  treats this as a signal to suppress the card entirely — desktop users
  get new versions from GitHub Releases, not from in-place git pull.

## Install

| Platform | Bundle | Notes |
|:---|:---|:---|
| **macOS** (Apple Silicon) | `wechat-cc_0.2.0_aarch64.dmg` | First launch: right-click → Open → confirm. Or `xattr -cr /Applications/wechat-cc.app`. |
| **Windows** (x64) | `.exe` (NSIS) · `.msi` | SmartScreen "更多信息" → "仍要运行" |
| **Linux** (x64) | `.deb` · `.AppImage` · `.rpm` | No warning |

Bundles are still unsigned (Apple Developer ID + Windows EV cert pending).
The first-run flow above is unchanged from v0.1.0.

## No source tree required

If you previously cloned `wechat-cc` to `~/.local/share/wechat-cc/` for v0.1.0,
that directory is no longer needed by the desktop bundle. The CLI side of
wechat-cc still works fine from a clone — both modes coexist.

## Internals

- `cli.ts` `run` and `setup` cases: `await import('./src/daemon/main.ts')` /
  `await import('./setup.ts')` — daemon and setup-flow run in-process inside
  the compiled binary instead of spawning a child Bun. The compiled binary
  is one entry point that fans out to all subcommands.
- `service-manager.ts` accepts `binaryPath`; when set, plist/unit/task
  ExecStart uses it directly instead of `bun + cli.ts`.
- `cli.ts` detects compiled mode via `process.argv[1].startsWith('/$bunfs/')`
  (Bun's virtual fs prefix in compiled binaries) and feeds `process.execPath`
  into `buildServicePlan` and `defaultUpdateDeps`.
- `apps/desktop/src-tauri/src/lib.rs` rewritten: `tauri-plugin-shell` +
  `app.shell().sidecar("wechat-cc-cli")` replaces the prior `Command::new(bun)`
  + `wechat_root()` discovery dance. No more PATH lookup, no more
  filesystem-scan fallbacks.
- `apps/desktop/src-tauri/capabilities/default.json` grants
  `shell:allow-execute` scoped to the bundled sidecar.

## CI

`.github/workflows/desktop.yml` adds three platform-conditional steps that
run `bun build --compile` for the host's target before `tauri build` so
the sidecar exists at `binaries/wechat-cc-cli-<rust-target-triple>` when
the bundler picks it up. macOS gets the xattr-clear + ad-hoc codesign
treatment that bun-compiled binaries need to pass Gatekeeper at runtime.

## Known limitations

- **macOS Intel** still not in the matrix — `macos-latest` is M-series. Add
  `macos-13` to follow.
- **Bundle size** is up ~63 MB per platform vs v0.1.0 (the embedded Bun
  runtime). Total .dmg/.deb/.exe ~80–100 MB.
- **Update card** is hidden in compiled mode — there's no in-GUI way to
  pick up a newer desktop bundle today. A Tauri auto-updater is on the
  v0.3.0 list.

## Verification

- `bun x vitest run` — 466 tests pass (added 1 view test for the
  `not_a_git_repo` hide tone)
- Local install of the macOS bundle into `/Applications/wechat-cc.app`,
  launched via `open` → dashboard renders, daemon detected, accounts
  table populated, Update card hidden as designed.

## Withdrawn

The `desktop-v0.1.0` tag and GitHub Release were removed. If you
downloaded v0.1.0 and saw an empty wizard, v0.2.0 is the fix — the
empty wizard was a symptom of the missing-sidecar architecture, not a
data-format issue. No state migration is needed.
