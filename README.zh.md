<h1 align="center">wechat-cc</h1>

<p align="center">
  <b>用微信找到电脑上的 Claude Code，让它也能找你回来。</b>
</p>

<p align="center">
  <img alt="version"  src="https://img.shields.io/badge/cli-v0.4.5-blue">
  <img alt="desktop"  src="https://img.shields.io/badge/desktop-v0.4.5-blue">
  <img alt="platform" src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey">
  <img alt="runtime"  src="https://img.shields.io/badge/runtime-Bun-black">
  <img alt="license"  src="https://img.shields.io/badge/license-MIT-green">
  <a href="https://github.com/ggshr9/wechat-cc/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ggshr9/wechat-cc/actions/workflows/ci.yml/badge.svg"></a>
</p>

<p align="center">
  <a href="./README.md">English</a> | 中文
</p>

---

## 这是什么

`wechat-cc` 是一个 Bun daemon，把你的**微信**账号和电脑上跑的 **Claude Code** 会话桥起来。装好之后：

- 手机微信发文字 / 图片 / 文件 / 语音——电脑上的 Claude 会收到、调工具、回到聊天里
- 离开电脑也能继续推进长任务——锁屏出门，从手机继续
- Claude **可以反过来找你**，不只是被动回复。Companion 层 + v0.4 dashboard 把它变成一个长期 AI 陪伴：会写观察、会触发里程碑、会决定什么时候该 push

定位故意挑窄：**个人 Claude Code 伴侣 × 深度 × 小白**——不追多 IM 多 agent 的广度赛道。要广度去看 [`cc-connect`](https://github.com/chenhg5/cc-connect)。要一段深度的、像关系的微信 × Claude Code 体验，这个对。

<p align="center">
  <img alt="dashboard sessions detail — WeChat-replica chat in iPhone 17 Pro frame, with file + image + quote-reply" src="docs/screenshots/chat-detail.png" width="380">
</p>
<p align="center"><sub>桌面 dashboard · 会话详情。每段微信 × Claude 对话回到 1:1 iPhone 复刻里看——文本、图片、文件、引用回复都在。<i>(示意图，非真实对话)</i></sub></p>

---

## 两条安装路径

| | **桌面安装器** (推荐) | **终端** (开发者) |
|---|---|---|
| 适合谁 | 任何人，包括非技术 | 你 OK 装 bun + git |
| 拿到什么 | 4 步向导（环境检查 → 选 agent → 扫码 → 装服务）+ dashboard：绑定账号 / 记忆 / 会话 / 日志 / 一键升级 | 同样的 daemon，没有 GUI |
| 怎么走 | 从 [最新 release](https://github.com/ggshr9/wechat-cc/releases/latest) 下 bundle | `git clone` + `bun install` + `wechat-cc setup` |
| 注意点 | bundle 没签名（Apple Dev ID + Windows EV 证书未配齐）—— 第一次开需要绕一次 OS 警告。Intel Mac 暂不支持（仅 Apple Silicon）。桌面 app 是个壳，调底层的 source-mode CLI，所以源码也得装一份（或设 `WECHAT_CC_ROOT`）| Bun 跑得起来的地方都行 |

大多数人：抓桌面 bundle。下面是终端路径。

![Wizard environment-check step — red rows show inline fix commands with copy buttons; hard-severity reds (Claude Code missing) get a left bar so the eye lands on the actually-blocking item first](docs/screenshots/wizard-doctor.png)

> 装时少了 Claude Code、微信账号没绑——每行都告诉你怎么修，复制即用。Hard 级（agent backend 缺）的红有左竖条，因为它会让 daemon 起来后空跑；soft 级（账号没绑）随后再补也不影响装服务。

---

## 快速开始（终端）

**前置：** [Git](https://git-scm.com)、[Bun](https://bun.sh) 1.1+、[Claude Code CLI](https://github.com/anthropics/claude-code)。

```bash
# Linux / macOS
curl -fsSL https://bun.sh/install | bash    # 没装 bun 时
git clone https://github.com/ggshr9/wechat-cc.git ~/.claude/plugins/local/wechat
cd ~/.claude/plugins/local/wechat && bun install && bun link
wechat-cc setup       # 手机微信扫码
wechat-cc run         # 启动 daemon
```

```powershell
# Windows
irm bun.sh/install.ps1 | iex                # 没装 bun 时
winget install Git.Git                       # 没装 git 时
# 装完 bun / git 必须重开终端，PATH 才生效。
git clone https://github.com/ggshr9/wechat-cc.git "$env:USERPROFILE\.claude\plugins\local\wechat"
cd "$env:USERPROFILE\.claude\plugins\local\wechat"
bun install ; bun link
wechat-cc setup ; wechat-cc run
```

搞定。手机微信发条消息——电脑上的 Claude 看到，回到聊天里。

> 一次扫码绑一个 1:1 bot。ilink 不支持群聊。扫码的人自动加白名单，其他人默认拒。

<details>
<summary><b>桌面 bundle 快速开始</b></summary>

从 [最新 release](https://github.com/ggshr9/wechat-cc/releases/latest) 下你平台的包：

| 平台 | 文件 | 第一次开 |
|:---|:---|:---|
| **macOS (Apple Silicon)** | `*.dmg` | 右键 → **打开**（Gatekeeper 提示一次）|
| **Windows (x64)** | `.exe` (NSIS) 或 `.msi` | SmartScreen → **更多信息** → **仍要运行** |
| **Linux (x64)** | `.deb` / `.rpm` | 没警告 |

桌面 app 调用底层 `wechat-cc` CLI，所以源码也得放一份：

```bash
git clone https://github.com/ggshr9/wechat-cc.git ~/.local/share/wechat-cc
cd ~/.local/share/wechat-cc && bun install
```

或环境变量 `WECHAT_CC_ROOT=/your/path`。

然后启动桌面 app——向导带你过环境检查 / 选 agent (Claude 或 Codex) / 扫码 / 装后台服务。完成后进 dashboard。

</details>

---

## 功能

### 1 · 双向聊——电脑上的 Claude 真听得见

手机发文本 / 图片 / 文件 / 语音；Claude 全收，能调工具（Edit / Bash 等），回话回到聊天里。媒体走 ilink CDN + AES-128-ECB 加密。语音 ilink 转写显示在消息里，没转写的录音存到 inbox。

### 2 · `share_page`——长内容也能在手机看

微信不渲染 markdown。Claude 有 plan / spec / 审稿要给你，调 `share_page({title, content})`：

1. 内容写本地 `~/.claude/channels/wechat/docs/<slug>.md`
2. 本地 Bun server 用 `marked` 渲染，配手机友好 CSS
3. `cloudflared tunnel` 暴露成 `*.trycloudflare.com`（首次自动下载，无需账号）
4. URL + 标题 + 预览发到微信

每个分享页底部一个 ✓ Approve 按钮——点一次 daemon 收到通知。故意没有 reject / 评论框；反对意见走聊天。文件 7 天 TTL；`resurface_page` 让过期的 URL 在新 tunnel 上复活。

### 3 · 多项目切换

注册项目一次，微信里自然语言或命令切：

```
/project add /home/u/Documents/compass compass
切到 sidecar              ← 自然语言；Claude 解析意图
/project switch sidecar   ← 显式命令
```

每个项目保持一个预热 Claude session 在 pool 里——切换大约 5 秒，切换窗口的消息 ilink 缓存重连后补发。提到之前的对话（「刚才聊的 xxx」），Claude 读 `<target>/memory/_handoff.md` 这个小指针，按需打开源 jsonl——项目间不复制对话内容。

### 4 · Companion——会反过来找你的 Claude

Opt-in 主动模式。`companion_enable` 之后，daemon 跑两个 scheduler：

- **推送 tick**（~20 min ± jitter）—— Claude 读 memory + 最近上下文，决定要不要 push 你。两个人格选：
  - **小助手 (assistant)** —— 干活导向，推送从严
  - **陪伴 (companion)** —— 温柔一些，下班轻问候
- **内省 tick**（24h ± jitter，**v0.4.1**）—— Claude (claude-haiku-4-5，隔离单次 eval) 看最近活动，决定要不要在 `memory/<chat>/observations.jsonl` 写新观察。**绝不 push**——惊喜来自你打开 dashboard 那一下

自然语言控制：
- `开启 companion` / `关闭 companion`
- `切到陪伴` / `换回小助手`
- `别烦我` / `snooze 3 小时`

### 5 · 双面镜子（v0.4 dashboard）

桌面 dashboard 把"陪伴"分两个视角：

**记忆 (Memory)** —— Claude 看你的镜子
- 顶部：Claude 最近的几条观察 + 里程碑卡片（"打开才发现的小惊喜"机制；不 push）
- 中部：可编辑的 per-chat markdown（`profile.md` / `preferences.md` / ...）
- 底部：可折叠的 "Claude 的最近决策" 时间轴（push / skip / observation / milestone / SDK 错误）。点一行看 reasoning

![Memory pane — observation card up top, file tree on left, preferences.md showing tool stack / PR habits / session-resume conventions, decisions timeline collapsed at the bottom](docs/screenshots/memory-pane.png)

<sub><i>示意图。Memory 层是个泛用 markdown 容器——这里展示的是项目记忆用法（工具偏好 / PR 习惯 / 会话续接）；同样的容器也能装 Companion 模式下的观察笔记，看 #4 节。</i></sub>

**会话 (Sessions)** —— 你和 Claude 共同的记录
- 跨 session 全文搜索
- 项目列表按时间分组（今天 / 7 天内 / 更早），每个项目一行 LLM 摘要（claude-haiku-4-5 lazy-refresh）
- 钻入任意项目的 jsonl 对话流；可收藏 / 导出 markdown / 删除

里程碑探测每条入站消息后跑：100 / 1000 turn、首次 handoff、首次回复 push、**7 天连续聊**（per-chat `activity.jsonl` UTC date 跟踪）。

> 设计立柱（双面镜子 / 老朋友的随手观察 / 克制 / 留白）见 [`docs/specs/2026-04-29-sessions-memory-design.md`](docs/specs/2026-04-29-sessions-memory-design.md)；SDK + 活动跟踪细节见 [`docs/specs/2026-04-29-v0.4.1.md`](docs/specs/2026-04-29-v0.4.1.md)。

### 6 · Hearth 集成——手机上做 vault 治理

文本捕到个人 markdown vault，生成 ChangePlan，看渲染好的 `share_page`，点 ✓ Approve——全程不离开微信。基于 [hearth](https://github.com/ggshr9/hearth)，agent-native vault 治理层。

```
/hearth ingest <text>      → 生成 ChangePlan，发审阅卡片
/hearth list               → 最近 10 条 pending
/hearth show <id>          → 预览 ops + 内容
/hearth apply <id>         → kernel apply（owner 直发，无 token）
```

仅 owner（admin 白名单）。vault 永远不被 channel 直写——所有写都过 hearth kernel + 人工审批。配置：

```bash
git clone https://github.com/ggshr9/hearth.git ~/Documents/hearth
cd ~/Documents/hearth && bun install
bun src/cli/index.ts setup              # 自动探 Obsidian vault
export HEARTH_VAULT=/path/to/your/vault
export HEARTH_AGENT=mock                # 配 Anthropic key 后改 "claude"
```

### 7 · 语音回复

说「念一下 X」/「speak it」，Claude 用语音回。主力 [VoxCPM2](https://huggingface.co/openbmb/VoxCPM2)，本地 `vllm serve --omni`（OpenAI 兼容 `/v1/audio/speech`）。云端备选 Qwen DashScope。两种 provider 都通过微信对话配置——第一次要求语音时 Claude 引导你填 API key / base URL。

### 8 · CLI 兜底

daemon 挂了，从任意终端也能发：

```bash
wechat-cc reply "10 分钟后回来"             # → 最近活跃的 chat
wechat-cc reply --to <chat_id> "specific"
echo "管道文本" | wechat-cc reply
```

CLI 读跟跑着的 daemon 一样的 `~/.claude/channels/wechat/` 状态，所以收件人解析 + session 续接完全一致。状态文件是真相源——daemon 重启不会丢线程。

---

## 它怎么工作

```
[你的手机]                       [你的电脑]
   微信 ──────────► ilink ──► wechat-cc daemon ──► Claude Agent SDK ──► Claude
       │            (long-poll)        │                                    │
       ▼                                ▼                                    │
   share_page ◄── cloudflared ◄── Bun.serve(本地) ◄────── reply 工具 ◄──────┘
```

- **接收**：每账号 long-poll `POST /ilink/bot/getupdates`
- **发送**：`POST /ilink/bot/sendmessage`，要用户的 `context_token`（对方必须先发过消息）
- **驱动**：`@anthropic-ai/claude-agent-sdk` 0.2.116 锁定。daemon 自己管 claude 子进程，不再注册成 Claude Code MCP channel
- **状态**：全部在 `~/.claude/channels/wechat/`（见 [运行时目录](#运行时目录)）
- **Companion**：两个 scheduler（push + introspect），不同节奏；introspect / 摘要走隔离 SDK eval，prompt 风格不污染项目对话

---

## 权限模式

**严格 (默认)** —— `wechat-cc run` —— 每次工具调用在微信问你（回 `y abc12` 放行 / `n abc12` 拒绝，10 分钟超时）。和权限中继设计一致。

**绕过** —— `wechat-cc run --dangerously` —— Claude 跑工具不再问。等于 `claude --dangerously-skip-permissions`。Claude 受过训练，真有破坏性的操作会用自然语言先和你确认。**只在你独占的 daemon 上用**。

> ⚠️ 通过 `access.json.allowFrom[]` 给别人共享 bot 时，**不要**开 `--dangerously`——任何被允许的 chat 都会拿到绕过。共享场景请用严格模式。

---

## 微信端命令

| 命令 | 效果 |
|:---|:---|
| `/help` | 帮助 |
| `/status` | 连接状态 + 版本 + 升级探测 |
| `/ping` | 连通性测试 |
| `/users` | 在线用户 |
| `/project add <路径> <别名>` | 注册项目 (admin) |
| `/project list` | 列项目 |
| `/project switch <别名>` | 切项目 (admin) |
| `/project status` | 当前项目 + cwd |
| `/project remove <别名>` | 取消注册 (admin) |
| `@all <消息>` | 群发 |
| `@<名字> <消息>` | 私发给指定人 |
| `/health` | bot 健康 (admin)——列过期 bot + 清理建议 |
| `/hearth ingest｜list｜show｜apply` | vault 治理 (admin，hearth 启用后) |

Companion + 记忆相关用自然语言配置（`开启 companion` / `切到陪伴` / `别烦我` 等），不是 slash 命令。

---

## 升级

```bash
wechat-cc update             # pull + 重装依赖 + 重启服务
wechat-cc update --check     # 仅探测，无副作用
```

桌面 GUI 启动时调 `--check` 决定要不要高亮「立即升级」。

如果 daemon 是服务跑的（LaunchAgent / systemd / 任务计划），`update` 自动 stop → pull → 必要时 `bun install` → 重启。如果你 `wechat-cc run` 在前台跑，命令拒绝（`daemon_running_not_service`）不会杀掉你的 shell——先 Ctrl+C 再升级。

---

## 运行时目录

```
~/.claude/channels/wechat/
├── access.json            # 白名单
├── context_tokens.json    # ilink context tokens (一 chat 一条)
├── user_names.json        # chat_id → 显示名
├── sessions.json          # 项目别名 → { session_id, last_used_at, summary? }
├── session-state.json     # bot 健康 (errcode 跟踪)
├── channel.log            # 滚动日志 (10MB rotate)
├── server.pid             # 单实例锁
├── docs/                  # share_page 内容 (7 天 TTL)
├── bin/cloudflared        # 自动下载 (Windows 是 .exe)
├── inbox/                 # 收到的媒体 (30 天 TTL)
├── accounts/<bot_id>/     # 每账号凭据
├── companion/
│   └── config.json        # enabled / snooze / default_chat_id / last_introspect_at
└── memory/<chat_id>/      # per-chat 内容
    ├── profile.md         # 用户面的 markdown，可编辑
    ├── observations.jsonl # Claude 最近观察 (TTL 30 天)
    ├── milestones.jsonl   # 100 条 / 连续聊 等 (永久 + id 去重)
    ├── events.jsonl       # cron 决策 (push/skip/failed/observation/milestone)
    └── activity.jsonl     # 每日 UTC date + 消息计数 (streak detector 用)
```

所有状态都在 `~/.claude/`，不进 repo。

---

## 访问控制

默认仅白名单。在**终端**管，不在微信端（防 prompt injection）：

```
/wechat:access                        # 查看策略 + 白名单
/wechat:access allow <user_id>        # 添加
/wechat:access remove <user_id>       # 移除
```

`wechat-cc setup` 扫码人自动加入白名单。

---

## Demo 数据（截图 / 第一印象用）

新装一片空——记忆 0 / 观察 0。要预览 dashboard 完整形态：

```bash
wechat-cc demo seed                   # 3 条观察 + 1 个里程碑 + 5 条事件
wechat-cc demo unseed                 # 撤销
wechat-cc demo seed --chat-id <id>    # 指定 chat 而非默认
```

稳定 id 前缀（`obs_demo_*` / `ms_demo_*`）保证 unseed 干净。

---

## 已知限制

- **首次联系** —— 对方没先发过消息，你联系不了（ilink 需要他的 `context_token`）
- **不支持群聊** —— ilink 1:1 only
- **macOS Intel 桌面 bundle** —— 暂不提供。走终端路径
- **桌面 bundle 未签名** —— 第一次开需要绕一次 Gatekeeper / SmartScreen
- **daemon 重启后对话不续** —— 微信记录在你手机上，但 Claude 不会重放它。per-project session resume 让**当前**会话保持温的，不会重建之前的

---

## 常见问题

**`bun` / `git` / `wechat-cc` 找不到**
重开终端。`bun link` 或新装 Bun / Git 后，PATH 在当前 shell 不会自动刷新。

**Windows 上读日志中文乱码**
PowerShell 默认 ANSI（GBK）读文件。用：
```powershell
Get-Content "$env:USERPROFILE\.claude\channels\wechat\channel.log" -Tail 60 -Encoding UTF8
```

**首次 `share_page` 弹防火墙**
v1.0 已修，`docs.ts` 绑 `127.0.0.1`。旧版本 `wechat-cc update` 升级后解决。

**`wechat-cc update` 报 "git not found"**
`update` 会 `git pull`，确认 Git 在 PATH。Windows: `winget install Git.Git`，重开终端。

**Bot 不回了 (errcode=-14)**
微信里跑 `/health` (admin)。过期 bot 列在那里，回 `清理 <bot-id>` 移除。重新扫码绑新 session。

---

## 卸载

```bash
# Linux / macOS
rm -rf ~/.claude/plugins/local/wechat   # 删插件源码
rm -rf ~/.claude/channels/wechat        # 清所有状态
```

```powershell
# Windows
Remove-Item "$env:USERPROFILE\.claude\plugins\local\wechat"
Remove-Item "$env:USERPROFILE\.claude\channels\wechat" -Recurse -Force
```

用了桌面 bundle 的话，记得把 app 拖废纸篓 / 系统包管理卸载。

---

## 用例

- **出门有长任务在跑** —— 电脑上启 deploy / 重构，锁屏出门，从手机继续推
- **把 Claude 写的 plan 转给老板** —— `share_page` 给的 URL + Approve 按钮，非技术人不用读对话
- **多人协作** —— `access.json.allowFrom[]` 共享 bot，每人的消息都路由到你这一个 Claude
- **会记得你的 Claude** —— Companion + 记忆 pane 慢慢长出一份关于你的小画像。你能读它，纠正它，archive 不想被记住的事

---

## 版本

- **CLI / daemon**: 1.2.0 —— 见 [`package.json`](./package.json)
- **桌面 bundle**: 最新签名 release 是
  [`desktop-v0.4.0`](https://github.com/ggshr9/wechat-cc/releases/tag/desktop-v0.4.0)。
  v0.4 / v0.4.1 功能（双面镜子 dashboard、真 introspect SDK、per-project 摘要、7-day-streak）已经在 `master`，下次桌面 bundle 出版时一起 ship
- **每个版本的 release notes**: [`docs/releases/`](./docs/releases/)
- **架构 / 设计 spec**: [`docs/specs/`](./docs/specs/)
- **路线图**: [`docs/rfc/02-post-v1.1-roadmap.md`](./docs/rfc/02-post-v1.1-roadmap.md)

---

## 参与贡献

Issues + PRs 欢迎： [github.com/ggshr9/wechat-cc](https://github.com/ggshr9/wechat-cc/issues)。

```bash
bun install
bun x vitest run        # 完整测试套件 (当前 684 测试)
bun x tsc --noEmit      # 类型检查
```

`apps/desktop/` 是 Tauri 2 GUI；快速迭代用 `bun run shim`（浏览器侧 mock）或 `bun run dev`（真 Tauri 壳）。dev harness 见 [`apps/desktop/test-shim.ts`](./apps/desktop/test-shim.ts)。

---

## 免责声明

本插件是**非官方的社区项目**，与腾讯、微信无任何关联。

---

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。
