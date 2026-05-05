# wechat-cc desktop v0.5.3

**Date**: 2026-05-05
**Tag**: `desktop-v0.5.3`
**Scope**: Win console-popup hotfix (PE-flip workaround for Bun upstream bug) + sidecar rebuild against CLI v0.5.3.

> If your `desktop-v0.5.0` / `0.5.1` / `0.5.2` install pops a CMD window when the daemon starts — this bundle is the fix. Bun 1.3.x's `--windows-hide-console` flag is a no-op (documented + accepted but doesn't flip the PE subsystem byte). desktop-v0.5.3's CI workflow flips the byte by hand after `bun build --compile`.

## What's in this bundle

The compiled sidecar is built from CLI v0.5.3 (containing v0.5.2's AllowHardTerminate fix + v0.5.3's mw-typing keepalive + `[FALLBACK_REPLY_SENT/FAIL]` diagnostic logs). On Windows, the sidecar's PE subsystem byte is post-processed from 3 (CONSOLE) to 2 (GUI/hidden) so `Start-ScheduledTask wechat-cc` no longer allocates a console window.

Filenames:
- Win NSIS: `wechat-cc_0.5.3_x64-setup.exe`
- Win MSI:  `wechat-cc_0.5.3_x64_en-US.msi`
- macOS DMG (Apple Silicon): `wechat-cc_0.5.3_aarch64.dmg`
- Linux DEB: `wechat-cc_0.5.3_amd64.deb`
- Linux RPM: `wechat-cc-0.5.3-1.x86_64.rpm`

(The `0.5.1` filename collision in earlier drafts is gone — the desktop project's own version was bumped 0.5.1 → 0.5.3 to keep filenames in lockstep with the tag.)

## Migration

Upgrade path from any older bundle:
```pwsh
# 1. Stop + uninstall existing service
wechat-cc service stop
wechat-cc service uninstall
# 2. Close the dashboard window
# 3. Delete the existing install dir (whatever path you chose)
Remove-Item -Recurse -Force <your install dir>
# 4. Run the new setup .exe
# 5. Open the new dashboard from Start Menu → wizard step 4 "安装并启动"
```

State directory (`~/.claude/channels/wechat/`) is untouched — no need to re-scan QR.

## Full release notes

[`docs/releases/2026-05-05-v0.5.3.md`](2026-05-05-v0.5.3.md)
