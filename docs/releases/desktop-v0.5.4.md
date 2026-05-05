# wechat-cc desktop v0.5.4

**Date**: 2026-05-05
**Tag**: `desktop-v0.5.4`
**Scope**: Sidecar rebuild against CLI v0.5.4 + Rust shim adds `CREATE_NO_WINDOW` flag for raw `std::process::Command` calls. No desktop UI changes.

> If your `desktop-v0.5.3` install pops a PowerShell window when you click "重启 daemon" in the dashboard — this bundle fixes it. The `wechat_daemon_pid` Tauri command was using raw Rust `std::process::Command` without `CREATE_NO_WINDOW`, so a console window flashed every time. v0.5.4 adds the flag.

## What changed

1. **Rust shim** (`apps/desktop/src-tauri/src/lib.rs`): `wechat_daemon_pid` Tauri command (the dashboard "重启 daemon" button calls this twice per click for pre/post pid verification) now sets `creation_flags(CREATE_NO_WINDOW)` on the spawned `powershell.exe`. Without it, every restart flashed two PowerShell windows.

2. **Sidecar TS** (`src/cli/...`, `src/lib/util.ts`, `src/daemon/...`): all 11 `spawnSync(...)` call sites now pass `{ windowsHide: true }`. **Note**: empirical testing on Win11 with bun 1.3.13 showed bun's compiled subsystem=2 binaries don't actually pop child console windows regardless of `windowsHide` — so this is defense-in-depth + a regression-guard test (`src/lib/spawn-windowshide.test.ts`) rather than a behavioural fix. See `docs/releases/2026-05-05-v0.5.4.md` for the full empirical breakdown.

3. **Filenames** now match the tag — `wechat-cc_0.5.4_x64-setup.exe` etc. (the desktop project's own version was bumped 0.5.3 → 0.5.4 to keep filenames in lockstep).

## Migration

Same as v0.5.3:

```pwsh
# 1. Stop + uninstall existing service
Get-ScheduledTask wechat-cc -EA SilentlyContinue | Stop-ScheduledTask -EA SilentlyContinue
Get-ScheduledTask wechat-cc -EA SilentlyContinue | Unregister-ScheduledTask -Confirm:$false
Get-Process | Where-Object { $_.Path -like '*wechat*' } | Stop-Process -Force -EA SilentlyContinue

# 2. Remove existing install dir (whatever path you chose)
Remove-Item -Recurse -Force <your install dir>

# 3. Run new wechat-cc_0.5.4_x64-setup.exe
# 4. Open new dashboard from Start Menu → wizard step 4 "安装并启动"
```

State directory (`~/.claude/channels/wechat/`) untouched — no need to re-scan QR.

## Full release notes

[`docs/releases/2026-05-05-v0.5.4.md`](2026-05-05-v0.5.4.md)
