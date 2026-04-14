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
- MCP server 暴露频道工具：`reply`、`edit_message`、`broadcast`、`send_file`、`set_user_name`
- 支持文本 / 图片 / 文件 / 视频收发（CDN 上传下载 + AES-128-ECB 加密）
- 媒体自动下载到 inbox 目录，路径写进消息元数据
- 基于白名单的访问控制（持久化到 `~/.claude/channels/wechat/access.json`）
- 实时日志查看器 `http://localhost:3456`（`wechat-cc logs`）
- 内建微信端斜杠命令：`/help`、`/status`、`/ping`、`/users`、`@all`、`@<名字>`
- 新用户首次发消息时自动提示 Claude 询问昵称，由 `set_user_name` 持久化

## 安装

依赖：

- [Bun](https://bun.sh)（测试于 1.1+）
- [Claude Code CLI](https://github.com/anthropics/claude-code)

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
```

`run` 背后会执行 `claude --dangerously-load-development-channels server:wechat`（或等价命令）把 MCP server 装进启动流程。

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

| 命令        | 作用                                               |
|-------------|----------------------------------------------------|
| `/help`     | 显示可用命令                                        |
| `/status`   | 连接 + 账号状态                                     |
| `/ping`     | 连通性测试                                          |
| `/users`    | 列出已绑定的在线用户                                |
| `@all 消息` | 广播给所有已连接用户                                |
| `@名字 消息`| 转发给指定用户（名字来自 `set_user_name`）          |

## 运行时目录

```
~/.claude/channels/wechat/
├── access.json            # 白名单
├── context_tokens.json    # ilink context tokens（主动发消息时必需）
├── user_names.json        # chat_id → 显示名
├── channel.log            # 滚动日志
├── server.pid             # 单实例锁
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
