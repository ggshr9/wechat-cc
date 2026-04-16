<h1 align="center">wechat-cc</h1>

<p align="center">
  <b>用手机微信跟你电脑上的 Claude Code 对话。</b>
</p>

<p align="center">
  <img alt="version"  src="https://img.shields.io/badge/version-0.2.0-blue">
  <img alt="platform" src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey">
  <img alt="runtime"  src="https://img.shields.io/badge/runtime-Bun-black">
  <img alt="license"  src="https://img.shields.io/badge/license-MIT-green">
  <a href="https://github.com/ggshr9/wechat-cc/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ggshr9/wechat-cc/actions/workflows/ci.yml/badge.svg"></a>
</p>

<p align="center">
  <a href="./README.md">English</a> | 中文
</p>

<!-- TODO: 加一张 4 格截图或 30 秒演示视频 -->

## 为什么需要这个？

- **出门在外也能干活** —— 在电脑上跑一个 Claude 长任务，锁屏出门，用手机微信继续交互
- **把方案分享给非技术人** —— Claude 生成了一份 plan，你转发一个渲染好的链接给上司，他在手机上看完点 Approve
- **多人协作** —— 允许同事通过各自的微信给你的 Claude 发消息，白名单控制访问

---

## 目录

- [快速开始](#快速开始)
- [功能](#功能)
- [使用](#使用)
- [访问控制](#访问控制)
- [运行时目录](#运行时目录)
- [已知限制](#已知限制)
- [卸载](#卸载)
- [参与贡献](#参与贡献)
- [免责声明](#免责声明)

---

## 快速开始

**前置条件：**[Bun](https://bun.sh) 1.1+ 和 [Claude Code CLI](https://github.com/anthropics/claude-code)。

Linux、macOS、Windows（PowerShell / Git Bash）通用：

```bash
git clone https://github.com/ggshr9/wechat-cc.git ~/.claude/plugins/local/wechat
cd ~/.claude/plugins/local/wechat && bun install && bun link
wechat-cc setup              # 微信扫码绑定
wechat-cc run --fresh        # 启动 Claude Code + 微信频道
```

搞定。在微信里发一条消息，Claude 就能收到。

> 每次扫码绑定一个 1:1 bot（ilink 限制，不支持群聊）。扫码的人自动加入白名单。

<details>
<summary><b>详细安装说明（分平台 / 可选依赖）</b></summary>

### 分步安装

<details>
<summary>Linux / macOS</summary>

```bash
# 直接 clone 到 Claude Code 插件目录
git clone https://github.com/ggshr9/wechat-cc.git ~/.claude/plugins/local/wechat
cd ~/.claude/plugins/local/wechat
bun install

# 把 wechat-cc 命令加到 PATH
bun link

# 扫码绑定微信
wechat-cc setup

# 启动
wechat-cc run --fresh
```

可选：安装 `expect` 让微信端 `/restart` 自动通过对话框：
```bash
sudo apt install expect   # Ubuntu/Debian
brew install expect       # macOS
```
</details>

<details>
<summary>Windows</summary>

```powershell
# 直接 clone 到 Claude Code 插件目录
git clone https://github.com/ggshr9/wechat-cc.git "%USERPROFILE%\.claude\plugins\local\wechat"
cd "%USERPROFILE%\.claude\plugins\local\wechat"
bun install

# 把 wechat-cc 命令加到 PATH（自动创建 wechat-cc.cmd）
bun link

# 扫码绑定微信
wechat-cc setup

# 启动
wechat-cc run --fresh
```

Windows 上所有功能正常。唯一区别：微信端 `/restart` 需要在终端手动按一次回车（Windows 没有 `expect` 替代品）。
</details>

### 可选依赖

| 依赖 | 作用 | 自动安装？ |
|:---|:---|:---:|
| `expect` | 微信 `/restart` 时自动通过开发通道对话框 | 否 —— `apt install expect` / `brew install expect` |
| `cloudflared` | `share_page` 把 markdown 发布成公网 URL | **是** —— 首次调用时自动下载 |

### 更新

```bash
wechat-cc update    # git pull + 按需 bun install
```

然后在微信发 `/restart`（或在终端 Ctrl+C 后重新 `wechat-cc run`）生效。微信端 `/status` 显示当前版本和是否有更新。

</details>

---

## 功能

- **微信当 Claude 遥控器** —— 从手机发文本、图片、文件、语音，Claude 全都能看到并回复
- **share_page** —— 长 markdown（plan / spec / 审阅文档）发布成手机浏览器可直接点开的网页，底部有 Approve 按钮给外部审阅人用
- **微信端 `/restart`** —— 不用走到电脑前就能重启 Claude session，Linux/macOS 自动通过对话框
- **白名单访问控制** —— 只有被允许的微信用户才能联系你的 Claude
- **`wechat-cc update`** —— 一条命令升级，`/status` 查看版本

<details>
<summary><b>全部功能</b></summary>

- 扫码登录，支持多账号（每次扫码 = 一个独立 bot）
- MCP server 暴露频道工具：`reply`、`edit_message`、`broadcast`、`send_file`、`set_user_name`、`share_page`、`resurface_page`
- `resurface_page` 让过期的旧文档在新 tunnel 上重新可访问
- 文本 / 图片 / 文件 / 视频收发（CDN 上传下载 + AES-128-ECB 加密）
- 收到的媒体自动保存到 inbox（路径写进消息元数据）
- 小文本类文件（csv / json / md / 代码）入站时自动附带前 5 行预览
- 实时日志查看器 `http://localhost:3456`（`wechat-cc logs`）
- 微信端命令：`/help`、`/status`、`/ping`、`/users`、`/restart`、`@all`、`@名字`
- 新用户首次发消息自动提示 Claude 问名字，由 `set_user_name` 持久化
- ilink 转写的语音消息内联显示；未转写的音频保存到 inbox
- 共享文件 7 天 TTL、inbox 30 天 TTL、channel.log 10MB 自动 rotate
- 跨平台：Linux / macOS / Windows —— 重启路径零平台特定代码
</details>

---

## 使用

```bash
wechat-cc setup              # 扫码绑定
wechat-cc run                # 启动（恢复上次会话）
wechat-cc run --fresh        # 全新会话
wechat-cc run --dangerously  # 跳过所有权限确认
wechat-cc list               # 列出已绑定账号
wechat-cc logs               # 打开日志查看器
wechat-cc update             # 拉最新代码 + 重装依赖
```

### 微信端命令

| 命令 | 效果 |
|:---|:---|
| `/help` | 显示帮助 |
| `/status` | 连接状态 + 版本 + 更新检查 |
| `/ping` | 连通性测试 |
| `/users` | 在线用户 |
| `/restart` | 重启 session（仅管理员）|
| `/restart --fresh` | 重启并开全新会话 |
| `@all 消息` | 群发 |
| `@名字 消息` | 转发给指定人 |

<details>
<summary><b>/restart 原理</b></summary>

`wechat-cc run` 跑一个 supervisor loop。管理员在微信发 `/restart` 后：

1. Server 写入 `.restart-flag` + `.restart-ack` 标记文件
2. 发送"正在重启…"微信确认
3. `cli.ts` 通过 500ms 轮询检测到 flag，`child.kill()` 杀掉 claude 子进程
4. Supervisor 重新 spawn claude（Linux/macOS 用 expect 自动通过开发通道对话框）
5. 新 server 启动后读 `.restart-ack`，发送"已重连（flags）用时约 Ns"

Kill 走向下方向（cli.ts → claude → server），通过 `child.kill()` 直接操作，零平台特定代码。
</details>

<details>
<summary><b>share_page 原理</b></summary>

微信文本消息不能渲染 markdown。`share_page` 把内容发布成一个短期公网 URL：

1. Claude 调 `share_page({ title, content, chat_id? })`
2. 正文写到 `~/.claude/channels/wechat/docs/<slug>.md`
3. 本地 `Bun.serve` 用 `marked` 渲染，配手机友好的 CSS
4. `cloudflared tunnel` 暴露到 `*.trycloudflare.com`（首次自动下载，无需账号）
5. URL 通过微信发送

每个页面底部有一个 **Approve** 按钮给外部审阅人用。故意没有 reject / 评论框 —— 反对意见走微信聊天更自然。

`resurface_page` 让过期文档在新 tunnel 上重新可访问。共享文件 7 天后自动删除。
</details>

---

## 访问控制

默认白名单制。在终端管理（不在微信端，防 prompt injection）：

```
/wechat:access                        # 查看策略 + 白名单
/wechat:access allow <user_id>        # 添加
/wechat:access remove <user_id>       # 移除
```

`wechat-cc setup` 扫码时自动把扫码人加入白名单。

---

## 运行时目录

```
~/.claude/channels/wechat/
├── access.json            # 白名单
├── context_tokens.json    # ilink context tokens
├── user_names.json        # chat_id → 显示名
├── channel.log            # 滚动日志（10MB 自动 rotate）
├── server.pid             # 单实例锁
├── docs/                  # share_page 内容（7 天 TTL）
├── bin/cloudflared        # 自动下载（Windows 上是 .exe）
├── inbox/                 # 收到的媒体（30 天 TTL）
└── accounts/<bot_id>/     # 每个账号的凭据
```

所有状态在 `~/.claude/` 下，不进 repo。

<details>
<summary><b>架构要点</b></summary>

- **接收**：每个账号独立 long-poll `POST /ilink/bot/getupdates`
- **发送**：`POST /ilink/bot/sendmessage` —— 需要 `context_token`（对方要先发过消息）
- **Typing**：`/ilink/bot/sendtyping`，ticket 缓存 60s
- **去重**：`from_user_id:create_time_ms` 防 at-least-once 重复
- **媒体**：CDN 上传下载 + AES-128-ECB 加密
- **重试**：发送超时或 5xx 自动重试 3 次
</details>

---

## 已知限制

- **首次联系** —— 对方必须先给 bot 发过至少一条消息，你才能主动联系（ilink 需要对方的 `context_token`）
- **重启后 Claude 忘记微信上下文** —— 你的微信聊天记录一直在手机上，但 Claude 重启后从新上下文开始 —— 除非用 `--continue` 恢复 Claude 自己的会话（但不会回放微信消息）

---

## 卸载

<details>
<summary>Linux / macOS</summary>

```bash
rm ~/.claude/plugins/local/wechat     # 删除插件
rm -rf ~/.claude/channels/wechat      # 清空所有状态
```
</details>

<details>
<summary>Windows (PowerShell)</summary>

```powershell
Remove-Item "$env:USERPROFILE\.claude\plugins\local\wechat"              # 删除插件
Remove-Item "$env:USERPROFILE\.claude\channels\wechat" -Recurse -Force   # 清空所有状态
```
</details>

---

## 参与贡献

欢迎提 Issue 和 PR：[github.com/ggshr9/wechat-cc](https://github.com/ggshr9/wechat-cc/issues)。项目用 Bun 运行，vitest 测试：

```bash
bun install
npx vitest run      # 32 tests, ~200ms
```

---

## 免责声明

本插件是**非官方的社区项目**，与腾讯、微信无任何关联。

ilink 是微信提供的合作伙伴通信接口，用于对接 OpenClaw 等平台。wechat-cc 将其用于 Claude Code 集成，**并非其设计初衷**。这种用法可能不被微信允许，相关账号有被限制的风险。

**后果自负。**

---

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。
