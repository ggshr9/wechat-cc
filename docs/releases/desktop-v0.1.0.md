# Desktop v0.1.0 — first public alpha

The wechat-cc desktop installer's first tagged release. A Tauri 2 shell over the `wechat-cc` CLI: scan a QR, install the daemon as a system service, watch your bound bots, and now — one-click upgrades.

> Pairs with `wechat-cc` daemon **v1.2.0** or later.

## What's in the box

**Setup wizard.** A 4-step flow (Environment check → Agent picker → WeChat QR → Service install) that wraps `wechat-cc doctor` / `setup` / `setup-poll` / `provider set` / `service install` so you never type a CLI command for a fresh install. Picks Claude Code or Codex as the agent backend, persists `unattended` and `autoStart` preferences, and emits the right plist / systemd unit / Scheduled Task per OS.

**Dashboard.** Live daemon status (pid + account count), bound-account table with two-step delete, configuration summary, and a Memory pane that browses the Companion v2 `memory/<chat_id>/*.md` notes Claude writes about you (with markdown rendering — `marked` vendored locally so the pane works offline).

**Update card** — *new in this release*. On launch the GUI calls `wechat-cc update --check --json` once, displays current commit + whether new commits are on `origin`. **检查更新** runs the probe again on demand. **立即升级** (visible only when an update is actually applyable — clean tree, no diverged commits, daemon installed as a service) calls `wechat-cc update --json`, which stops the service, fast-forwards, reinstalls deps if `bun.lock` changed, restarts the service, and re-probes. All 9 reject reasons (`dirty_tree`, `diverged`, `bun_missing`, `daemon_running_not_service`, etc.) get user-actionable copy.

## Install

Bundles are produced by GitHub Actions and **unsigned for now** — Apple Developer ID + Windows EV cert haven't been provisioned yet. First-run warnings:

- **macOS** (`.dmg`): "无法验证开发者". Right-click the app → **Open** → confirm. After once, future launches are silent.
- **Windows** (`.exe` / `.msi`): SmartScreen "无法识别的应用". Click **More info** → **Run anyway**.
- **Linux** (`.AppImage` / `.deb` / `.rpm`): no warning.

The unsigned bundles are byte-identical to what GitHub Actions builds — only the certificate is missing. A future signed release will eliminate these prompts retroactively.

## Prerequisite: wechat-cc source

The desktop app shells out to the `wechat-cc` CLI (it does not embed the daemon). You need the source somewhere it can find:

1. `WECHAT_CC_ROOT` env var (highest priority), OR
2. `~/.local/share/wechat-cc/` (recommended), OR
3. `/opt/wechat-cc/` or `/usr/share/wechat-cc/` (system install)

```bash
git clone https://github.com/ggshr9/wechat-cc.git ~/.local/share/wechat-cc
cd ~/.local/share/wechat-cc && bun install
```

Then launch the desktop app — it'll auto-detect this location.

## Known limitations

- **Unsigned bundles** (see above). Functional, just noisy on first launch.
- **No auto-update for the GUI itself.** The Update card only updates the `wechat-cc` source, not the desktop bundle. To get a newer GUI, redownload from the next release.
- **Update card requires service-installed daemon.** If you run `wechat-cc run` in a foreground terminal, the upgrade button refuses with `daemon_running_not_service` (we don't want to kill your shell). Either install the service through the wizard or stop the foreground process before upgrading.
- **`memory/` editing is read-only.** The pane renders `.md` notes Claude writes; editing them inline isn't wired yet.

## What's next

Versioned independently from the daemon (`wechat-cc` v1.x), the desktop bundle's roadmap (RFC 02 §5 v2.1):

- Inline `memory/*.md` editing
- Companion decision visualization (when Claude considered a push, why it did or didn't)
- Code-signing once Apple/Windows certs are provisioned
- Eventual self-update via Tauri's updater

## Verification

```
$ bun x vitest run
Test Files  48 passed (48)
Tests       465 passed (465)
```

3-platform CI green: see [`fix(update e2e): persist autocrlf=false on local repo too`](https://github.com/ggshr9/wechat-cc/actions/runs/25005542980).
