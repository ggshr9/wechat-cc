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

Next slices:

1. Add `wechat-cc update --json` for one-click GUI upgrades.
2. Build `apps/desktop` with Tauri after the CLI contracts above are stable.
3. Add signed release packaging: macOS `.dmg`, Windows `.exe`, Linux
   `.AppImage`/`.deb`.

GUI QR loop:

1. Call `wechat-cc setup --qr-json`.
2. Render `qrcode_img_content`.
3. Every 1s call `wechat-cc setup-poll --qrcode <qrcode> --base-url <currentBaseUrl> --json`.
4. If status is `scaned`, show "Confirm on phone".
5. If status is `scaned_but_redirect`, update `currentBaseUrl`.
6. If status is `confirmed`, move to service install/start.
7. If status is `expired`, request a new QR payload.
