# wechat-cc desktop v0.4.1

A reliability-only patch on top of v0.4.0. Five real bugs that surfaced
once v0.4.0 hit users — sessions detail and markdown export were
broken for any session past ~64 KB, daemon wouldn't restart after a
kernel panic, and the post-install hook missed two distro families.
No new features, no UI changes; reinstall over v0.4.0 and the existing
window keeps your panes where you left them.

## What's fixed

### **Sessions detail + 导出 markdown ← the user-visible one**
Click into a session past the first ~64 KB of turns and v0.4.0 showed:
> 读取失败：invalid JSON from wechat-cc: EOF while parsing a string at line N column M

Same data path drove the markdown export, so clicking 导出 silently did
nothing. Root cause: `bun --compile` binaries lose bytes when emitting
MB-scale payloads through a Unix pipe — the kernel pipe buffer fills,
the Tauri-side line reader drains slowly, and writes start dropping on
EAGAIN. v0.4.1 routes large JSON through a temp file (`--out-file`) and
new `wechat_cli_json_via_file` Tauri command, sidestepping pipes
entirely. Verified: 8.1 MB / 2965-turn session round-trips cleanly.
Export errors now surface as a visible alert instead of a silent click.

### **Daemon won't restart after a hard kill**
After a kernel panic / OOM-kill / forced power-off, the stale
`server.pid` survived. On next boot the kernel reused that PID for some
unrelated process (login shell, browser tab) within ~15 s of fresh
boot, and the lock check via `kill(pid, 0)` returned "alive" — daemon
refused to start, permanently, until the user manually deleted the
pidfile. Now verified via `/proc/<pid>/comm` (Linux) and
`tasklist /FI "PID eq N"` (Windows) so the lock only refuses when a
current process is genuinely our daemon.

### **Upgrading the .deb leaves the old daemon running**
Linux lets dpkg replace `/usr/bin/wechat-cc-cli` while the running
daemon keeps the old (now-deleted) inode mapped. Users upgraded and
saw "nothing changed" until they manually `systemctl --user restart
wechat-cc`. v0.4.1 ships a `postinst` that walks `getent passwd`,
finds users with the systemd `--user` unit installed, and runs
`try-restart` as that user — best-effort, never blocks dpkg if a
session is stuck. RHEL 7 / Debian 9 LTS and rpm `%post` environments
that lack `runuser` fall back to `su -s /bin/sh`.

### **SessionManager double-spawned Claude subprocesses on the cold-start race**
Two messages on the same project arriving inside the ~8–15 s SDK
cold-start window both missed the cache and both forked a Claude
subprocess; the first session ended up orphaned the moment the second
overwrote `sessions.set()`. Patched with an in-flight Promise dedup +
regression test that overlaps two `acquire()` calls and asserts
exactly one spawn.

### **`inbox/` accumulated forever**
`cleanupOldInbox` was exported with a 30-day TTL but never invoked.
On constrained Linux laptops, `~/.claude/channels/wechat/inbox/`
filled the partition over weeks. Now swept once per daemon start.

## Cross-platform hardening

Same patch landed Windows-equivalents for the bugs above:
- **Filename sanitizer** in `saveToInbox` extended from `\x00 / \\` to
  the full NTFS-illegal set (`< > : " / \ | ? *` + C0 controls), so
  WeChat-supplied filenames containing `:` no longer crash attachment
  download on Windows.
- **`process.kill(pid, 'SIGUSR1')`** silently throws EINVAL on Windows.
  Setup told users "已通知 daemon 热加载" but the daemon never picked
  up the new account. Now branches: POSIX hot-reloads via signal,
  Windows prints the `schtasks /End && /Run` restart command.
- **`wechat-cc daemon kill <pid>`** used `ps` (POSIX-only) and a regex
  that didn't even match the compiled-binary cmdline on Linux. Now
  routes through `tasklist` on Windows and accepts `wechat-cc-cli` /
  `wechat-cc-cli.exe` as valid daemon images.

## Install / upgrade

Same channel as v0.4.0 — download the `.deb` / `.rpm` / `.exe` / `.msi`
/ `.dmg` from Releases and install over the previous version. The new
postinst restarts the daemon for you on Linux; macOS / Windows users
need to restart their wechat-cc service manually (or reboot).

## Verified

- 797 / 797 tests passing
- 8.1 MB session detail round-trip via the via-file path
- PID-reuse regression test (pid 1 alive but not us → lock steals)
- postinst runs cleanly with no service unit (no-op) and with one
  installed (try-restart fires for the owning user)
