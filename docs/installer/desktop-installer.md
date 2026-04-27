# Desktop Installer Foundation

Goal: make the desktop installer a thin shell around stable `wechat-cc`
commands, so terminal, scripts, and GUI all use the same setup logic.

First slice implemented:

- `wechat-cc doctor [--json]`
  - Full install health report for installer dashboards and support.
- `wechat-cc setup-status [--json]`
  - Narrow setup-flow state: WeChat binding, access, provider, daemon.
- `wechat-cc setup --qr-json`
  - Fetch the WeChat QR payload for GUI rendering. The desktop app should
    render `qrcode_img_content`.
- `wechat-cc setup-poll --qrcode TOKEN [--base-url URL] [--json]`
  - Poll the QR login status. On `scaned_but_redirect`, the GUI should keep
    the same QR token and pass the returned `baseUrl` into the next poll. On
    `confirmed`, the CLI persists account/token/access state and returns the
    saved account id.
- `wechat-cc service <status|install|start|stop|uninstall> [--json]`
  - Cross-platform service control. Current backend plans:
    - macOS: LaunchAgent
    - Windows: Scheduled Task
    - Linux: systemd user service
- `wechat-cc provider show [--json]`
  - Current agent provider.
- `wechat-cc provider set <claude|codex> [--model MODEL]`
  - Persist provider choice to `agent-config.json`.

Desktop app rule: call these commands and render JSON. Do not reimplement
state inspection or provider selection inside the GUI.

Status:

1. ✅ `wechat-cc update [--check] [--json]` — shipped 2026-04-27 (commits
   bf94ee1 → 880d2bf). GUI surfaces an Update card with launch-time
   probe + manual check + apply, all reject reasons mapped to user
   copy. See `docs/specs/2026-04-27-wechat-cc-update.md`.
2. ✅ `apps/desktop` built with Tauri 2 — first public alpha
   `desktop-v0.1.0` published 2026-04-27 (Linux + macOS aarch64 + Windows
   bundles attached to GitHub Release).
3. ⏳ Signed release packaging — pending Apple Developer ID + Windows
   EV cert provisioning. Current builds use ad-hoc signing on macOS and
   are unsigned on Windows; first-run requires a one-time Gatekeeper /
   SmartScreen bypass documented in README.

Open follow-ups:

- macOS Intel (x86_64) bundle — current build is aarch64 only because
  `macos-latest` runner moved to Apple Silicon. Add `macos-13` to the
  matrix in a v0.1.1.
- Inline editing of `memory/*.md` in the desktop pane (currently
  read-only renders via vendored marked).
- `actions/checkout@v4` etc. on Node 20 — GitHub deprecation deadline
  2026-09-16; bump to @v5 (Node 24) before then.

GUI QR loop:

1. Call `wechat-cc setup --qr-json`.
2. Render `qrcode_img_content`.
3. Every 1s call `wechat-cc setup-poll --qrcode <qrcode> --base-url <currentBaseUrl> --json`.
4. If status is `scaned`, show "Confirm on phone".
5. If status is `scaned_but_redirect`, update `currentBaseUrl`.
6. If status is `confirmed`, move to service install/start.
7. If status is `expired`, request a new QR payload.
