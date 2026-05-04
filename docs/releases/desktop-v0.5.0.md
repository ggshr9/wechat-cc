# wechat-cc desktop v0.5.0

**Date**: 2026-05-04
**Tag**: `desktop-v0.5.0`
**Scope**: Version sync with CLI v0.5.0 + 3 user-facing UI improvements bundled in.

## What's new (visible)

### 1. 安装向导显示真实步骤进度

之前 wizard 第 4 步"安装为后台服务"按钮永远显示"安装中…"，5-10 秒里完全没有信号告诉用户卡在哪儿。现在 button 实时显示当前步骤：
```
安装中… (1/4) 写入服务定义文件
安装中… (2/4) systemctl daemon-reload
安装中… (3/4) systemctl enable
安装中… (4/4) 启动 systemd 服务
```
步骤名 + (M/N) 都来自 CLI 实时写的 `install-progress.json`，UI 250ms 轮询读 —— 卡住时 button label 不动，能精准指认是哪一步挂了。Linux/macOS/Windows 三平台 step 数和 label 自动适配。

### 2. 控制台允许切换聊天模式

**会话** card 里每行原本是只读的 mode pill；现在改成下拉框，可以从 dashboard 直接切 `/cc /codex /solo /both /chat`。切换后 daemon 会向该 chat 发一条提示：
```
🎛 已切换到 X（来自控制台）
```
让手机上的人也能看到 mode 变了。和 WeChat 内的 `/cc` 等斜杠命令走完全同一条代码路径（`coordinator.setMode`），单一真相是 SQLite `conversations` 表，不会双向冲突。

### 3. WSL 提示语句更准确

WSL 检测提示之前说"当前版本只识别 Windows 端的 Claude / Codex"含义不清。改成：
> 当前版本只支持 Windows 端的 Claude / Codex。装在 WSL 里的 Claude Code 这个 GUI 客户端连不到 —— 需要在 Windows 端再装一份才能用。WSL 直连集成在路上。

## What's new behind the scenes (test-only, not in bundle)

- **Playwright tier-2 specs** (`apps/desktop/playwright/{wizard,dashboard,interactions}.spec.ts`) — 7 tests covering wizard rendering, dashboard panel structure, observation archive, sessions favorite. Runs against `test-shim.ts` in CI via the new `e2e-browser` workflow job. Not bundled.
- **`test-shim.ts` mocks** for `demo.seed`, QR auto-pass, panel data injection, install-progress simulation, mode set — used by Playwright tests + manual `bun run shim`. Not bundled.

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
