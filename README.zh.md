<h1 align="center">wechat-cc</h1>

<p align="center">
  <b>用手机微信跟你电脑上的 Claude Code 对话。</b>
</p>

<p align="center">
  <img alt="version"  src="https://img.shields.io/badge/version-1.0.0-blue">
  <img alt="platform" src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey">
  <img alt="runtime"  src="https://img.shields.io/badge/runtime-Bun-black">
  <img alt="license"  src="https://img.shields.io/badge/license-MIT-green">
  <a href="https://github.com/ggshr9/wechat-cc/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ggshr9/wechat-cc/actions/workflows/ci.yml/badge.svg"></a>
</p>

<p align="center">
  <a href="./README.md">English</a> | 中文
</p>

<!-- TODO: 加一张 4 格截图或 30 秒演示视频 -->

## v1.2 —— Hearth 集成（手机上做 vault 治理）

捕获到个人 markdown vault — 并且审 / 批 / apply 变更 — 全程不离开微信。
基于 [hearth](https://github.com/ggshr9/hearth)，agent-native 的 vault
治理层。

```
/hearth ingest <text>      → 生成 ChangePlan，发一张 review 卡片
/hearth list               → 列最近 10 条 pending
/hearth show <change_id>   → 预览某条 plan 的 ops + 内容
/hearth apply <change_id>  → kernel apply（owner 直发即授权，无需 token）
/hearth                    → 帮助
```

每次 `/hearth ingest` 回复里带一条 `share_page` URL，点开就是渲染好的
ChangePlan，带一键 **✓ Approve** 按钮。vault 永远不被 channel 直写；
所有写入都过 hearth kernel + 人工审批。

**配置：**

```bash
# 1. 把 hearth clone 一份装好（一次性）
git clone https://github.com/ggshr9/hearth.git ~/Documents/hearth
cd ~/Documents/hearth && bun install
bun src/cli/index.ts setup    # 交互式：自动探 Obsidian vault，跑 adopt

# 2. 把 wechat-cc 指向你的 vault
export HEARTH_VAULT=/path/to/your/vault
export HEARTH_AGENT=mock        # 配 Anthropic key 后可改成 "claude"
```

仅限 owner：`/hearth` 一类命令跟 `/health` 共用 admin 白名单
（`access.ts::isAdmin`）。非 owner 静默丢弃。

也可以把 hearth 接到 Claude Code / Cursor / Codex / Continue.dev — 见
[hearth INTEGRATIONS 指南](https://github.com/ggshr9/hearth/blob/main/docs/INTEGRATIONS.md)。
wechat-cc 只是众多入口之一。

---

## v1.1 —— 语音 + Companion

在 v1.0 daemon 之上加了三个能力：

### 1. `--dangerously` CLI 开关

`wechat-cc run --dangerously` 恢复 v0.x 语义：反应式 session 用 `bypassPermissions` 模式（微信里不再逐条弹权限）。和 `claude --dangerously-skip-permissions` 一致。真正会造成破坏的操作，Claude 仍会用自然语言先和你确认。

严格模式（`wechat-cc run` 不带参数）保留 Phase 1 的权限中继。共享 bot 用严格模式；自己一个人用 `--dangerously` 省事。

### 2. 出站语音 (`reply_voice`)

你说 "念一下 X" 或 "speak it"，Claude 会用语音回复。主力方案是 **[VoxCPM2](https://huggingface.co/openbmb/VoxCPM2)**，通过 `vllm serve --omni` 本地部署（OpenAI 兼容的 `/v1/audio/speech` 接口）；Qwen DashScope 作为云端备选保留。两种 provider 都通过微信对话配置——第一次要求语音时 Claude 会引导你填入 `base_url` / `api_key`。

```
# 在任意一台 Mac 上（通过 Tailscale 连接）:
vllm serve openbmb/VoxCPM2 --omni --port 8000
```

然后在微信里说 "念一下 你好"；Claude 会问你 `base_url`（比如 `http://<mac>:8000/v1/audio/speech`）和 `model`（`openbmb/VoxCPM2`），测试合成，保存到 `voice-config.json`，然后发语音。

### 3. Companion 层（opt-in 主动推送）

把 wechat-cc 从被动 bridge 变成长期陪你的 AI。两个**人格**你可以切换：

- **小助手 (assistant)** —— 干活导向，推送从严（CI 炸了、PR 冲突、部署失败）。
- **陪伴 (companion)** —— 温柔一些，推送松一些，下班时段的轻量问候。

主动触发器是 Claude 任务（不是 shell 命令），按 cron 时间表跑。每次触发会开一个隔离的 Agent SDK session 让当前人格评估；Claude 决定推送就调 `reply` 工具（= 推送），决定不推就安静结束（= 不推）。所有状态放在可手改的 markdown 文件里：`~/.claude/channels/wechat/companion/`。

**快速上手：**

```
User: "开启 companion"
Claude: [创建 profile.md + personas/assistant.md + personas/companion.md，返回欢迎词]
User: "加个 CI 监控，每 10 分钟检查一次 main 分支"
Claude: [调 trigger_add，cron 是 */10 * * * *，task 是一句中文 prompt]
```

**自然语言控制：**
- `切到陪伴` / `换回小助手` —— 切换当前项目的人格
- `别烦我` / `snooze 3 小时` —— 暂停主动推送

默认关闭；必须手动 `companion_enable` 才会跑。完整设计见 `docs/specs/2026-04-22-companion.md`。

---

## v1.0 有什么变化

wechat-cc 从头重写为一个独立的 Bun 守护进程。

- **Agent SDK 守护进程** —— wechat-cc 现在通过 `@anthropic-ai/claude-agent-sdk`（锁定 v0.2.116）驱动 Claude，不再作为 Claude Code MCP Channel 运行。启动时不再弹 `--dangerously-load-development-channels` 确认对话框。
- **按项目的 Session Pool** —— 每个注册项目都保持一个预热的 Claude session。切换项目是即时的，不需要重启 Claude，而是在已运行的 session 之间切换。
- **微信端 `/restart` 已移除** —— 在 Windows 上是 ilink 消息重播和进程树语义导致死循环的根源。请用 `/project switch` 或手动重启守护进程（`Ctrl+C` + `wechat-cc run`）。
- **`--fresh` / `--continue` / `--dangerously` 命令行参数** —— 兼容旧版本保留接口，但传入后会打警告并忽略。Session 生命周期由守护进程管理；想要全新上下文请用 `/project switch` 切到另一个项目。
- **状态文件向下兼容** —— `accounts/`、`projects.json`、`context_tokens.json`、`user_names.json`、`user_account_ids.json` 全部保留。不需要重新扫码。

**从 v0.x 升级：**
```bash
cd ~/.claude/plugins/local/wechat
git pull && bun install
wechat-cc run
```

---

## 为什么需要这个？

- **出门在外也能干活** —— 在电脑上跑一个 Claude 长任务，锁屏出门，用手机微信继续交互
- **把方案分享给非技术人** —— Claude 生成了一份 plan，你转发一个渲染好的链接给上司，他在手机上看完点 Approve
- **多人协作** —— 允许同事通过各自的微信给你的 Claude 发消息，白名单控制访问

> 基于 [Claude Code](https://github.com/anthropics/claude-code)，也可通过 [cc-switch](https://github.com/farion1231/cc-switch) 图形化配置。

---

## 目录

- [v1.0 有什么变化](#v10-有什么变化)
- [快速开始](#快速开始)
- [功能](#功能)
- [使用](#使用)
- [访问控制](#访问控制)
- [运行时目录](#运行时目录)
- [已知限制](#已知限制)
- [卸载](#卸载)
- [常见问题](#常见问题)
- [参与贡献](#参与贡献)
- [免责声明](#免责声明)

---

## 快速开始

**前置条件：**[Git](https://git-scm.com)、[Bun](https://bun.sh) 1.1+ 和 [Claude Code CLI](https://github.com/anthropics/claude-code)。

- 安装 Bun（Linux/macOS）：`curl -fsSL https://bun.sh/install | bash`
- 安装 Bun（Windows PowerShell）：`irm bun.sh/install.ps1 | iex`
- 安装 Git（Windows）：`winget install Git.Git`

> Windows 上安装 Bun 或 Git 后需要**重开终端**才能用新命令，当前 shell 不会自动更新 PATH。

**Linux / macOS：**
```bash
git clone https://github.com/ggshr9/wechat-cc.git ~/.claude/plugins/local/wechat
cd ~/.claude/plugins/local/wechat && bun install && bun link
wechat-cc setup              # 微信扫码绑定
wechat-cc run                # 启动守护进程
```

**Windows（PowerShell）：**
```powershell
git clone https://github.com/ggshr9/wechat-cc.git "$env:USERPROFILE\.claude\plugins\local\wechat"
cd "$env:USERPROFILE\.claude\plugins\local\wechat"
bun install
bun link
wechat-cc setup              # 微信扫码绑定
wechat-cc run                # 启动守护进程
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
wechat-cc run
```

`bun link` 后找不到 `wechat-cc`？重开一个终端（PATH 刷新需要新 shell）。
</details>

<details>
<summary>Windows</summary>

```powershell
# 直接 clone 到 Claude Code 插件目录
git clone https://github.com/ggshr9/wechat-cc.git "$env:USERPROFILE\.claude\plugins\local\wechat"
cd "$env:USERPROFILE\.claude\plugins\local\wechat"
bun install

# 把 wechat-cc 命令加到 PATH（自动创建 wechat-cc.cmd）
bun link

# bun link 后找不到 wechat-cc？重开一个 PowerShell 窗口。

# 扫码绑定微信
wechat-cc setup

# 启动
wechat-cc run
```

Windows 上所有功能正常。微信端 `/restart` 在 v1.0 已移除；需要重启时在终端 `Ctrl+C` 后重新 `wechat-cc run` 即可。
</details>

### 可选依赖

| 依赖 | 作用 | 自动安装？ |
|:---|:---|:---:|
| `cloudflared` | `share_page` 把 markdown 发布成公网 URL | **是** —— 首次调用时自动下载 |

### 更新

```bash
wechat-cc update    # git pull + 按需 bun install
```

然后在终端 `Ctrl+C` 后重新 `wechat-cc run` 生效。微信端 `/status` 显示当前版本和是否有更新。

### 通过 cc-switch 配置

[cc-switch](https://github.com/farion1231/cc-switch) 是一个桌面应用，用图形界面管理 Claude Code 等 AI CLI 工具的 MCP server、API key 和插件。如果你用 cc-switch，可以在它的 MCP 管理页面注册 wechat-cc，不用手动编辑 `.mcp.json`：

| 字段 | 值 |
|:---|:---|
| Name | `wechat` |
| Transport | `stdio` |
| Command | `bun` |
| Args | `run`, `--cwd`, `~/.claude/plugins/local/wechat`, `--silent`, `start` |

cc-switch 会把这段写进 Claude 的 `mcpServers` 配置。效果和 `wechat-cc install` 完全一样 —— Claude Code 下次启动时自动加载。

你仍然需要自己 clone 仓库 + `bun install` + `wechat-cc setup`（扫码）。cc-switch 只负责 MCP 注册，不管插件安装。

</details>

---

## 功能

- **微信当 Claude 遥控器** —— 从手机发文本、图片、文件、语音，Claude 全都能看到并回复
- **share_page** —— 长 markdown（plan / spec / 审阅文档）发布成手机浏览器可直接点开的网页，底部有 Approve 按钮给外部审阅人用
- **多项目切换** —— 微信发 `切到 sidecar` 或 `/project switch sidecar`，按项目的 session pool 让所有项目保持预热，切换即时完成，handoff pointer 让对话上下文自然续上
- **白名单访问控制** —— 只有被允许的微信用户才能联系你的 Claude
- **`wechat-cc update`** —— 一条命令升级，`/status` 查看版本

<details>
<summary><b>全部功能</b></summary>

- 扫码登录，支持多账号（每次扫码 = 一个独立 bot）
- MCP server 暴露频道工具：`reply`、`edit_message`、`broadcast`、`send_file`、`set_user_name`、`share_page`、`resurface_page`、`list_projects`、`switch_project`、`add_project`、`remove_project`（项目管理类都有 admin 检查，和 `/project` 命令路径一致）
- `resurface_page` 让过期的旧文档在新 tunnel 上重新可访问
- 文本 / 图片 / 文件 / 视频收发（CDN 上传下载 + AES-128-ECB 加密）
- 收到的媒体自动保存到 inbox（路径写进消息元数据）
- 小文本类文件（csv / json / md / 代码）入站时自动附带前 5 行预览
- 实时日志查看器 `http://localhost:3456`（`wechat-cc logs`）
- 微信端命令：`/help`、`/status`、`/ping`、`/users`、`@all`、`@名字`
- 新用户首次发消息自动提示 Claude 问名字，由 `set_user_name` 持久化
- ilink 转写的语音消息内联显示；未转写的音频保存到 inbox
- 共享文件 7 天 TTL、inbox 30 天 TTL、channel.log 10MB 自动 rotate
- 跨平台：Linux / macOS / Windows
</details>

---

## 使用

```bash
wechat-cc setup              # 扫码绑定
wechat-cc run                # 启动守护进程（自动恢复所有项目 session）
wechat-cc list               # 列出已绑定账号
wechat-cc logs               # 打开日志查看器
wechat-cc update             # 拉最新代码 + 重装依赖
wechat-cc reply "消息内容"   # 守护进程挂了时从终端直接发消息
wechat-cc install --user     # 把 wechat 注册到用户级 MCP（多项目共用）
```

> `--fresh`、`--continue`、`--dangerously` 保留接口兼容，传入后会打警告并忽略。Session 生命周期由守护进程管理。

### 权限模式

**严格模式（默认）**：`wechat-cc run` — 每次工具调用都会在微信问你（回复 `y abc12` 放行 / `n abc12` 拒绝，10 分钟超时）。和 Phase 1 的权限中继一致。

**跳过权限** (`wechat-cc run --dangerously`)：不再在微信里问你；Claude 以 `bypassPermissions` 模式直接执行工具。等同于 `claude --dangerously-skip-permissions`。Claude 本身受过训练，真正会造成破坏的操作会用自然语言先和你确认。适合你自己一个人用、且自己管理 `access.json` 白名单时。

> ⚠️ 如果你通过 `access.json.allowFrom[]` 让其他人也能用这个 bot，**不要**开 `--dangerously`——任何被允许的 chat 都会直接放行。共享 bot 请用严格模式。

### 多项目切换

如果你同时维护多个项目，可以把它们注册到 wechat-cc 里，通过微信一条命令在项目之间切换。

**一次性安装**（把 MCP 装到用户级，所有项目共用）：

```bash
wechat-cc install --user    # 写入 ~/.claude.json，不再需要每个项目的 .mcp.json
```

**注册项目**（仅管理员，在微信里输入）：

```
/project add /home/u/Documents/compass compass
/project add /home/u/Documents/compass-wechat-sidecar sidecar
```

**切换**（自然语言或命令）：

```
切到 sidecar                 # 自然语言 —— Claude 会理解意图
/project switch sidecar      # 显式命令
/project list                # 列出所有注册项目
/project status              # 查看当前项目 + cwd
```

切换大约 5-10 秒。切换窗口内微信发的消息 ilink 会缓存，重连后一起补发，不会丢。切换成功后新 session 会主动发 "已切到 X（从 Y，用时 Ns）" 确认。

**Handoff context 怎么工作**：切换时 wechat-cc 在目标项目写一个小指针文件 `<target>/memory/_handoff.md`，里面指向源项目的 session jsonl。你后来提到之前的对话（"刚才聊的 xxx"），Claude 会按需读取源 jsonl。项目间不会复制对话内容。

完整设计见 `docs/specs/2026-04-18-project-switch-design.md`。

### 微信端命令

| 命令 | 效果 |
|:---|:---|
| `/help` | 显示帮助 |
| `/status` | 连接状态 + 版本 + 更新检查 |
| `/ping` | 连通性测试 |
| `/users` | 在线用户 |
| `/project add <路径> <别名>` | 注册项目（仅管理员） |
| `/project list` | 列出所有注册项目 |
| `/project switch <别名>` | 切换项目（仅管理员） |
| `/project status` | 查看当前项目别名 + cwd |
| `/project remove <别名>` | 取消注册（仅管理员） |
| `@all 消息` | 群发 |
| `@名字 消息` | 转发给指定人 |

<details>
<summary><b>重启守护进程</b></summary>

v1.0 不再支持微信端 `/restart`。需要重启时：

```bash
# Linux / macOS / Windows（任意终端）
Ctrl+C
wechat-cc run
```

所有注册项目的 session 自动恢复，不需要重新扫码。
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
- **守护进程重启后 Claude 忘记微信上下文** —— 你的微信聊天记录一直在手机上，但守护进程重启后 Claude 从新上下文开始，之前的微信消息不会自动回放到 Claude 的上下文里

---

## 卸载

<details>
<summary>Linux / macOS</summary>

```bash
rm -rf ~/.claude/plugins/local/wechat     # 删除插件
rm -rf ~/.claude/channels/wechat          # 清空所有状态
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

## 常见问题

**`bun`、`git` 或 `wechat-cc` 命令找不到**
重开终端。`bun link` 或刚装 Bun/Git 后，PATH 变更在当前 shell 会话里不生效。

**Windows 上读日志中文乱码**
PowerShell 默认 `Get-Content` 用系统 ANSI（GBK）读文件，而日志是 UTF-8。用这条命令：
```powershell
Get-Content "$env:USERPROFILE\.claude\channels\wechat\channel.log" -Tail 60 -Encoding UTF8
```

**首次 `share_page` 弹 Windows 防火墙**
v1.0 已修复 —— `docs.ts` 现在绑 `127.0.0.1` 而不是 `0.0.0.0`。旧版本有这个问题，`wechat-cc update` 升级后解决。

**`wechat-cc update` 报 "git not found"**
`wechat-cc update` 内部会执行 `git pull`。确认 Git 在 PATH 里。Windows 上：`winget install Git.Git`，然后重开终端。

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
