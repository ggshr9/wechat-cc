<h1 align="center">wechat-cc</h1>

<p align="center">
  <b>Claude Code 的微信频道插件 — 通过 ilink bot API 把微信消息桥接到你的 Claude Code 会话。</b>
</p>

<p align="center">
  <img alt="version"  src="https://img.shields.io/badge/version-0.1.0-blue">
  <img alt="platform" src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS-lightgrey">
  <img alt="runtime"  src="https://img.shields.io/badge/runtime-Bun-black">
  <img alt="license"  src="https://img.shields.io/badge/license-MIT-green">
</p>

<p align="center">
  <a href="./README.md">English</a> | 中文
</p>

> 非官方插件。基于 ilink bot 协议（`https://ilinkai.weixin.qq.com`）。每次扫码绑定的是一个 1:1 bot —— 这是 ilink 的限制，不支持群聊。

## 功能

- QR 扫码登录，支持多账号（每人扫码一次 = 一个独立 bot，目录 `accounts/<bot_id>/`）
- MCP server 暴露频道工具：`reply`、`edit_message`、`broadcast`、`send_file`、`set_user_name`、`share_page`、`resurface_page`
- `share_page` 把长 markdown（plan / spec / 审阅文档）发布成 cloudflared quick tunnel 的公网 URL，微信用户点开就能在手机浏览器里看到渲染好的内容。页面底部只有一个 Approve 按钮 —— 一键确认「读完了，别等我」，转发给非 Claude 用户（比如上司）用；点击后通过 MCP notification 回到 Claude
- `resurface_page` 让老文档在新 session 里重新可点开（tunnel URL 每次启动都会换，老链接失效）
- 支持文本 / 图片 / 文件 / 视频收发（CDN 上传下载 + AES-128-ECB 加密）
- 媒体自动下载到 inbox 目录，路径写进消息元数据
- 基于白名单的访问控制（持久化到 `~/.claude/channels/wechat/access.json`）
- 实时日志查看器 `http://localhost:3456`（`wechat-cc logs`）
- 内建微信端斜杠命令：`/help`、`/status`、`/ping`、`/users`、`/restart`、`@all`、`@<名字>`
- 新用户首次发消息时自动提示 Claude 询问昵称，由 `set_user_name` 持久化

## 安装

依赖：

- [Bun](https://bun.sh)（测试于 1.1+）
- [Claude Code CLI](https://github.com/anthropics/claude-code)

可选依赖：

- `expect(1)` —— 让微信端触发的 `/restart` 自动确认 Claude Code 的
  `--dangerously-load-development-channels` 对话框，不用你守在终端按回车。
  没装也能跑，但 `/restart` 重启后 claude 会卡在对话框等人按回车。
  安装：`apt install expect` / `brew install expect`。
- `cloudflared` —— `share_page` 工具用它把本地渲染的 markdown 页面透过
  quick tunnel 暴露到 `*.trycloudflare.com`。**你不需要自己装** —— 首次
  调用 share_page 时 wechat-cc 会自动下载对应架构的静态二进制到
  `~/.claude/channels/wechat/bin/cloudflared`，无需 Cloudflare 账号、
  无需域名、无需配置。如果你自己已经装过（比如 `brew install cloudflared`），
  wechat-cc 会直接复用 PATH 上的那个，不重复下载。

```bash
git clone https://github.com/ggshr9/wechat-cc.git
cd wechat-cc
bun install
```

把插件链接到 Claude Code 的本地插件目录（`~/.claude/plugins/local/wechat/`），可以直接 clone 到该目录，或者用 symlink：

```bash
mkdir -p ~/.claude/plugins/local
ln -s "$(pwd)" ~/.claude/plugins/local/wechat
```

可选：把 CLI 加进 `$PATH`：

```bash
ln -s "$(pwd)/cli.ts" ~/.local/bin/wechat-cc
chmod +x ~/.local/bin/wechat-cc
```

## 首次配置

每个希望 Claude 能读到自己微信的人**各自跑一次**：

```bash
wechat-cc setup
```

终端会打印二维码，用微信扫。扫码成功后账号状态写到 `~/.claude/channels/wechat/accounts/<bot_id>/`。再跑一次 `wechat-cc setup` 可以追加绑定新账号 —— 每次扫码创建一个独立目录，互不覆盖，独立轮询。

## 启动

```bash
# 启动 Claude Code + 微信频道，默认恢复上次会话
wechat-cc run --dangerously

# 全新会话
wechat-cc run --fresh

# 列出已绑定账号
wechat-cc list

# 打开实时日志查看器
wechat-cc logs          # http://localhost:3456
wechat-cc logs 4567     # 指定端口

# 拉最新代码 + 重装依赖（仅当 bun.lock 变化时）。
# 运行中的 server 仍是旧代码，需要在微信发 /restart 或
# Ctrl+C 后重跑 wechat-cc run 来生效。
wechat-cc update
```

`run` 背后会执行 `claude --dangerously-load-development-channels server:wechat`（或等价命令）把 MCP server 装进启动流程。

微信端的 `/status` 命令会显示当前构建的 SHA + commit subject，以及是否落后于 `origin/master`。如果看到「落后 N 个 commit」，在终端跑 `wechat-cc update` 然后在微信发 `/restart` 即可完成升级。

## 访问控制

频道**默认是 allowlist**：白名单外的用户发来的消息会被静默丢弃。

在 Claude Code 里：

```
/wechat:access                        # 显示策略 + 白名单
/wechat:access allow <user_id>        # 加人（user_id 形如 xxx@im.wechat）
/wechat:access remove <user_id>       # 移除
/wechat:access policy disabled        # 彻底关闭频道
```

访问控制的修改**只允许来自终端手输**。`access` 技能拒绝处理从微信消息触发的加白名单请求（防 prompt injection）。

## 微信端命令

| 命令                      | 作用                                               |
|---------------------------|----------------------------------------------------|
| `/help`                   | 显示可用命令                                        |
| `/status`                 | 连接 + 账号状态                                     |
| `/ping`                   | 连通性测试                                          |
| `/users`                  | 列出已绑定的在线用户                                |
| `/restart`                | 重启 wechat-cc，继承当前 flags（仅管理员）          |
| `/restart --dangerously`  | 重启并启用 `--dangerously-skip-permissions`         |
| `/restart --fresh`        | 重启并开启全新 Claude 会话（不带 `--continue`）     |
| `@all 消息`               | 广播给所有已连接用户                                |
| `@名字 消息`              | 转发给指定用户（名字来自 `set_user_name`）          |

**`/restart` 原理：** `wechat-cc run` 跑的是一个 supervisor loop。管理员在
微信发 `/restart`（可选带 flag）后，server 依次：

1. 写入 `.restart-flag`（裸 flag 字符串），让 `cli.ts` 知道要怎么重开
2. 写入 `.restart-ack`，内容 `{chat_id, account_id, flags, requested_at}`，
   让**下一次**启动的 server 知道该去通知谁"已重连"
3. 通过原来的 bot 发送"正在重启…约 5 秒后重连"
4. 向 `claude` 祖先发 SIGTERM

CLI supervisor 捕获 claude 退出 → 重新读 `.restart-flag` → 走 `expect(1)`
包装再次启动 claude；expect 用三个 `after` 定时器（800ms / 2000ms / 4000ms）
盲送回车，自动过 `--dangerously-load-development-channels` 的确认对话框，
无需人守在终端。没装 expect 也能跑，只是会卡在对话框等人按回车
（`wechat-cc run` 启动时会打印一行软提醒）。

新 server 的 pollLoop 起来之后，读 `.restart-ack`、定位到当初收到 `/restart`
的那个账号 entry，发"已重连（flags）用时约 Ns"回给请求人，然后删除标记。
Claude 会话本体除非带 `--fresh`，否则通过 `--continue` 恢复上下文。

## 长文档分享（`share_page` / `resurface_page`）

微信文本消息无法渲染 markdown —— 代码块、表格、嵌套列表都会糊成一团，在手机上没法读。`share_page` 这个 MCP tool 用来解决这个：把一篇 markdown 发布成一个短期 URL，微信用户点开直接在手机浏览器里看到渲染好的页面。

**工作流程：**

1. Claude 调用 `share_page({ title, content, chat_id? })`
2. 正文写到 `~/.claude/channels/wechat/docs/<slug>.md`
3. wechat-cc 在本地起一个 `Bun.serve`（随机端口），通过 `marked` 把 `/docs/<slug>` 渲染成带简洁样式的 HTML，页面底部自带一个 **一键 Approve 按钮**
4. 首次调用时 spawn `cloudflared tunnel --url http://localhost:<port>`，不需要 Cloudflare 账号、不需要域名。wechat-cc 从 cloudflared 日志里抓出分配的 `https://<单词>.trycloudflare.com` URL 并缓存到本次 session。如果 `cloudflared` 不在 PATH 上，wechat-cc 会自动下载对应架构的静态二进制到 `~/.claude/channels/wechat/bin/cloudflared`（30MB，只下一次）
5. `share_page` 返回 `https://<tunnel>.trycloudflare.com/docs/<slug>`；带了 `chat_id` 就顺手发一条微信消息（标题 + 预览 + URL）。不带 `chat_id` 时自动取 `access.json` 里第一个 admin，所以"把这个发给我看"在终端里直接就能触发

**Approve 按钮的用法：** 底部那个按钮不是给你自己按的（你在微信回文字就够），是给**不在 Claude 生态里的第三方**按的。典型场景：Claude 生成一份 plan → 你转发 URL 给老板 → 老板点开读完、点 Approve → POST 通过同一条 cloudflared tunnel 回到 wechat-cc 的本地 server → 写 `.decision.json` + 发 MCP notification → Claude 看到确认继续往下。决定通过 `share_page:<slug>` 作为 chat_id 送达，Claude 能识别这是"外部审阅者"而不是微信用户。页面再次打开时会显示持久化的 "Approved ✓" 横幅而不是按钮。不做额外鉴权 —— URL 本身是信任边界，当成 bearer credential 来看。

**故意没有 reject / 评论框**。理由：审阅人真要反对或解释，直接在微信里跟 URL 的主人说更好 —— 聊天窗口承载上下文远比一个页面上的小文本框好，而且 wechat-cc 本来就是那条沟通通道。留一个只能"模糊表达不满"的表单反而是坏 UX：审阅人填了但以为会有人处理，实际上只是个 rejected 信号，信息几乎为零。一按键的 Approve 作为"确认已读、不用等我"的软信号就够了。

**`share_page` 是发布动作，不是审批入口。** 它不会阻塞 Claude 往下执行。真正需要 y/n 卡住的关键操作走 Claude 现成的 permission request 流（🔐 提示框）。两套机制故意分开。

**Resurface：** cloudflared quick tunnel URL 只在一次 wechat-cc run 期间有效，下次重启就换新 URL，老链接死了。用户引用一份昨天的 plan 时让 Claude 调 `resurface_page({ slug?, title_fragment? })`，它会在磁盘上找到对应的 `.md` 并在**当前** tunnel 上发布一个新可用 URL。

**保留期：** `.md` 和配套的 `.decision.json` **7 天后自动删除**。想长期归档的话自己 copy 到别的地方 —— wechat-cc 是传输通道，不是归档库。

**注意事项：**

- URL 是公开可访问的，任何拿到 URL 的人都能读，也都能点 Approve。不要在 share_page 里放**密钥、凭据、内部战略**这种东西。slug 是 4 个随机单词 + 时间戳后缀，不容易被暴力猜到，但不是鉴权手段
- URL 是临时的：`wechat-cc run` 退出后 cloudflared 进程也会被一起带走，旧 URL 立刻失效。`.md` 文件保留 7 天，期间可以用 `resurface_page` 重新挂到新 tunnel 上
- Cloudflare 官方把 quick tunnel 定位为非生产用途，个人/小团队用没事，大流量场景不合适
- 内容会经过 Cloudflare 边缘节点。如果你介意这点，要么只用 share_page 发不敏感内容（这是设计初衷），要么从 server.ts 里把这个 tool 去掉

## 运行时目录

```
~/.claude/channels/wechat/
├── access.json            # 白名单
├── context_tokens.json    # ilink context tokens（主动发消息时必需）
├── user_names.json        # chat_id → 显示名
├── channel.log            # 滚动日志
├── server.pid             # 单实例锁
├── .restart-flag          # 临时：/restart 时传给 cli.ts 的裸 flag
├── .restart-ack           # 临时：下一次启动发"已重连"的标记
├── docs/                  # share_page 发布的 .md 正文 + .decision.json 配套（7 天 TTL）
├── bin/
│   └── cloudflared        # 首次 share_page 时自动下载
├── inbox/                 # 下载的媒体文件
└── accounts/
    └── <bot_id>/
        ├── account.json
        └── token          # bot token，权限 0600
```

这些内容都**不会**进 repo，全部在 `~/.claude/` 下。

## 架构要点

- **接收**：每个账号独立 long-poll `POST /ilink/bot/getupdates`
- **发送**：`POST /ilink/bot/sendmessage` —— 主动发消息需要目标用户的 `context_token`，没有的话 ilink 会拒绝投递（所以对方必须先主动发一条"hi"）
- **Typing**：收到消息后发 `/ilink/bot/sendtyping`，ticket 缓存约 60 秒
- **去重**：`from_user_id:create_time_ms` 防 ilink at-least-once 重复投递
- **媒体**：CDN 上传下载 + AES-128-ECB 加密
- **重试**：outbound send 超时或 5xx 自动重试 3 次，间隔 1 秒

## 已知限制

- `context_token` bootstrap：无法主动发消息给从未发过消息的用户
- 目前 server 重启会丢失消息历史上下文（没接 SQLite 持久化）
- Session 过期 / 未授权用户走静默 drop，没有告知通道
- `cdn.ilinkai.weixin.qq.com` 硬编码，未来可能要从 account 派生

## 卸载

```bash
# 1. 删除 Claude Code 插件 symlink
rm ~/.claude/plugins/local/wechat

# 2. 删除 CLI symlink（如果建过）
rm ~/.local/bin/wechat-cc

# 3. 清掉所有已绑定账号、token、日志和 inbox
rm -rf ~/.claude/channels/wechat

# 4. 从项目的 .mcp.json 里删掉 wechat 条目（编辑文件，删掉 mcpServers 下的 "wechat" 键）
```

## 免责声明

非官方插件，与 Tencent / WeChat 无任何关联、非其背书或赞助。ilink bot 协议属于第三方接口，自动化微信访问**可能违反微信服务条款，并导致账号封禁**。使用风险自担。

## 协议

MIT —— 详见 [LICENSE](./LICENSE)。
