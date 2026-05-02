# RFC 03 · 多 Agent 协作架构（Claude + Codex 对等）

**Status**: Draft · 2026-05-02
**Phase**: 0（提案 + spike）
**Extends**: RFC 01 §3（5 层架构）、§6（"不做的事"修订）
**Updates**: RFC 02 §1（在"个人 Claude Code 伴侣"之上补一个新维度）
**Branch**: `claude/multi-ai-chat-switching-pRXrU`

---

## TL;DR

引入 Codex 作为 Claude 的**对等 peer**（不是 cc-connect 式的 "N agent 路由"），让单条微信对话支持四种模式。**首发只 ship Claude + Codex 两个 provider；架构通过 `AgentProvider` 抽象保持开放——后续若有人想接入第三个 agent（自己提 PR），实现接口即可，不需要改架构。** 本 RFC 不主动调研、不主动维护其他 agent，但也不立围墙。

| 模式 | 触发 | 语义 |
|---|---|---|
| `solo` | `/cc` 或 `/codex`（默认 `/cc`） | 当前行为，单 agent 应答 |
| `primary+tool` | `/cc + codex` 或 `/codex + cc` | 一方主导，另一方作为 `mcp__delegate__*` 工具被一次性咨询 |
| `parallel` | `/both` | 两个 agent 并发应答，前缀 `[Claude]` `[Codex]` |
| `chatroom` | `/chat` | 两个 agent 持久轮流，靠 `@addressing` 自然终止 |

架构上有两个根本变化：

1. **MCP 工具集独立成 stdio server**（`wechat-mcp` + `delegate-mcp`）— 工具实现单一来源，两个 provider 通过同样的 stdio 入口连接，daemon 暴露 localhost HTTP 内部 API 做 IPC 回调。
2. **`Conversation` 上升为头等数据模型** — 替代当前隐含的 "1 项目 = 1 session" 假设。一个 conversation 持有 1+ 个 participant（每个是 (provider, threadId) 对），coordinator 编排 dispatch。

**与 RFC 01 §6 不冲突**：那条禁的是"广度 N agent 路由"——和 cc-connect 同质化必输的赛道。本 RFC 走的是"深度 2 agent 协作"——cc-connect 不做、也不打算做的方向（§1.1 详述）。差异化不削弱、反而加强。

---

## 1. 定位再校准

### 1.1 RFC 01 §6 "不做多 agent" 的修订

**RFC 01 原文**：
> ❌ 多 agent 支持（Codex/Cursor/Gemini）—— 偏离 "Claude Code 深度" 定位

**RFC 03 修订**：
> ❌ 通用 N agent 路由（cc-connect 式 ACP 广度适配）—— 仍然偏离"深度"，同质化必输
>
> ✅ **Claude + Codex 对等协作（首发组合）** —— Anthropic Sonnet 和 OpenAI GPT-5-Codex 是当下两个最强代码助手，在同一对话里让它们互问、辩论、互相 review，是 cc-connect 不会做的差异化
>
> 🔓 **抽象开放** —— `AgentProvider` 接口对所有能提供持久 thread + 可选 MCP 的 agent SDK 开放。后续若用户/贡献者想接 Cursor / Gemini / 其他，实现接口 + 注册到 provider registry 即可，不需要改架构。本 RFC 不主动适配，但不立围墙。

**原条款的本意是反对什么？** 反对"做成一个能对接 N 个 agent 的路由器"——即 cc-connect 的形态：广度兼容、ACP 通用层、最大公约数协议。原因写的是"偏离 Claude Code 深度"，更精准的表述是"和 cc-connect 在通用 bridge 维度同质化竞争必输"。

**本 RFC 做的不是那个事**：
- cc-connect 模型：N agent，**同时刻一个 chat 用一个 agent**，agent 是可插拔的"后端"，靠 ACP 兼容层屏蔽差异。
- 本 RFC 模型：每个 provider **用各自的原生 SDK**（保留全部独有能力），对话内 1+ 个 provider 可同时驻留协作。

形态完全不同。一个是"路由器"，一个是"圆桌"。**两边都是开放生态，差别在哲学**：cc-connect 通过通用层换广度；我们通过抽象接口让深度集成可重复——你想接新 agent，需要写一份针对那个 SDK 的 native provider，不会比我们写 Claude/Codex 时少做事。

### 1.2 为什么 cc-connect 不会做圆桌

他们的产品哲学是"广度兼容"——所有 agent 走 ACP 通用接口或近似的最大公约数协议。**对深度集成是负担**：每个 agent 的独有能力（Claude 的 MCP / canUseTool、Codex 的 sandbox + approval policy）都要通过通用层屏蔽，最后只剩下"发 prompt → 收 text"。两个 agent 在那种抽象上没法真协作。

我们走另一条路：Claude 用 `claude-agent-sdk`、Codex 用 `@openai/codex-sdk`，**各自保留全部 SDK 能力**（包括 MCP 工具、resume、streaming events、approval policy）。两个 SDK 形状几乎对称（见 §3.5 对照表），共同的工具面通过独立 stdio MCP server 提供。这是一个 cc-connect 在它们的架构上做不到的事。

### 1.3 为什么首发只 ship Claude + Codex

**首发 ship 的 provider 是 Claude + Codex 两个**。原因不是"硬边界禁止其他"，而是"先把两个做透，验证抽象通用，再让别的进来不费劲"。

| Agent | 首发 ship | 理由 |
|---|---|---|
| **Claude (claude-agent-sdk)** | ✅ | 现有架构基础，差异化定位的核心 |
| **Codex (GPT-5/GPT-5-Codex)** | ✅ | 官方 TS SDK 形状对称、原生支持 MCP、定位与 Claude Code 对齐（编码 agent）；**同时是验证抽象层最严格的 case**——如果 Claude+Codex 这两个内部架构差异最大的 SDK 都能在同一抽象下工作，其他 agent 大概率也行 |
| Cursor / Cline / Windsurf | 待 | IDE-bound，daemon-friendly SDK 待社区出现 |
| Gemini CLI | 待 | SDK 形状未对照过；如果有人需要，自己实现 `AgentProvider` 接入 |
| Anthropic 自有 sub-agent (Haiku) | 待 | 已能用 Claude SDK 内部启子任务，不需要本 RFC 的协作架构 |

**抽象层的设计原则**（决定是否"自然能扩"）：
- `AgentProvider` 接口与 SDK 无关——任何能 `spawn(project) → AgentSession` + `dispatch(text) → result` + `onAssistantText/onResult` 的 SDK 都能实现
- Provider 在 daemon 启动时**注册到一个 `Map<ProviderId, AgentProvider>`**，新加 provider = 加一行注册
- 工具（reply / memory / voice）通过 stdio MCP server 提供，**不绑 provider**——任何能加载 MCP 的 SDK 都能用
- Mode 类型里 `provider` 字段是 `ProviderId = string`，不是闭合 union——加新 provider 不破坏现有持久化 schema

**结论**：架构不锁死。但**本 RFC 只承诺 Claude + Codex 两个 provider 的 ship 与维护**；其他 agent 出现需求时再说，不预设、不预研、不预建。

### 1.4 Companion 维度不变

RFC 02 §4 的 "memory-first 自治" 仍然成立：两个 provider 共用 `memory/<chat_id>/` 目录。Claude 写的 profile.md，Codex 启动时也读得到。**Companion 不绑 agent**——它绑 chat。一致性自然达成。

---

## 2. 硬约束

| # | 约束 | 原因 |
|---|---|---|
| C1 | **工具实现单一来源** | reply / memory / voice / share_page 只写一份，两个 provider 共享，避免双份维护 drift |
| C2 | **Conversation 头等数据** | 一个 chat 可以有 1+ participant，每个 participant 持久 thread；不能再用 "alias = session" 的简化 |
| C3 | **单 provider 模式零回归** | 用户没切到 multi 时，latency / cost / UX 与 v1.2 完全一致 |
| C4 | **切换无须重启 daemon** | `/cc` `/codex` `/both` `/chat` 在聊天里实时生效 |
| C5 | **防递归无限调用** | delegate 工具的 depth 硬上限（默认 2） |
| C6 | **用户决定哪个是默认** | 不偏袒任一方，按 chat 持久化用户选择；首次默认 `solo+claude` 与现状一致 |

C3 是最容易被违反的——抽象化重构容易在单 provider 路径上加 overhead。Phase P0/P1 完成后必须做基线 benchmark：v1.2 vs P1 的 cold-start、warm-turn、resume 三个指标，差异 > 10% 视为回归。

---

## 3. 架构

### 3.1 与 RFC 01 五层的关系

| 层 | RFC 01 现状 | RFC 03 变化 |
|---|---|---|
| L0 Runtime | Bun + `@anthropic-ai/claude-agent-sdk` | **+** `@openai/codex-sdk` |
| L1 Session Pool | per-`alias` `ClaudeSDKClient` | key **加 provider 维度** → per-`(alias, provider)` |
| L2 Integration | ilink + Claude Code plugin | 不变 |
| L3 Feature | 22 工具内联在 Claude SDK | **工具迁出到 stdio MCP server**，两 provider 同源连接 |
| L4 Companion | Claude 单方读写 memory | memory 共享；两 provider 同读同写同一个目录 |
| L5 UX | log-viewer / setup wizard | **+** `/mode` 类命令；**+** dashboard 显示 conversation mode |

### 3.2 新增：Conversation Layer

在 L1（资源管理）和 L3（工具）之间加一层语义编排：

```
┌─ daemon ────────────────────────────────────────────────────────────────┐
│                                                                          │
│  inbound  ──▶ ModeRouter ──▶ ConversationCoordinator                     │
│                  │                  │                                    │
│         (per chat_id mode)          ▼                                    │
│                          {solo|primary+tool|parallel|chatroom}           │
│                                     │                                    │
│                                     ▼                                    │
│                    Participant[] (= AgentProvider session)               │
│                          │                  │                            │
│                  ClaudeProvider          CodexProvider                   │
│              (claude-agent-sdk)      (@openai/codex-sdk)                 │
│                          │                  │                            │
│                          └────── stdio ─────┘                            │
│                                     ▼                                    │
│                          ┌──────────────────────┐                        │
│                          │  wechat-mcp (stdio)  │ ◀── 工具单一来源         │
│                          │  delegate-mcp (stdio)│ ◀── peer-as-tool       │
│                          └──────────┬───────────┘                        │
│                                     │ localhost HTTP (token-auth)        │
│                                     ▼                                    │
│                          DaemonInternalAPI                               │
│                  (ilink send, memory, projects, voice, ...)              │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

`ConversationCoordinator` 是 mode 编排的所有 dispatch 入口。`SessionManager` 退化为纯资源管理（LRU、idle evict、in-flight 去重），不再决定路由。

### 3.3 数据模型

```ts
// src/core/conversation.ts

// ProviderId 是开放 string brand，不是闭合 union。首发注册的是 'claude' / 'codex'，
// 其他 provider 通过 ProviderRegistry.register(id, provider) 接入；Mode 与 Participant
// 不需要为新 provider 改 schema。
export type ProviderId = string

export type Mode =
  | { kind: 'solo'; provider: ProviderId }
  | { kind: 'primary_tool'; primary: ProviderId }   // peer 作为 mcp__delegate__* 工具临时起
  | { kind: 'parallel' }                            // 两个并发各回各的
  | { kind: 'chatroom' }                            // 两个轮流 + @addressing

export interface Conversation {
  chatId: string
  projectAlias: string
  mode: Mode
  participants: Participant[]    // solo/primary_tool=1, parallel/chatroom=2
}

export interface Participant {
  provider: ProviderId
  threadId: string | null        // 持久化 session/thread id（resume 用）
  handle: AgentSession           // 运行时 SDK 句柄
}

// src/core/provider-registry.ts
export interface ProviderRegistry {
  register(id: ProviderId, provider: AgentProvider, opts: ProviderRegistration): void
  get(id: ProviderId): { provider: AgentProvider; opts: ProviderRegistration } | null
  list(): ProviderId[]
}
export interface ProviderRegistration {
  displayName: string             // "Claude" / "Codex" — 用于前缀拼接、prompt 提名
  canResume: (cwd: string, threadId: string) => boolean
  // 加新 provider 时，只动 daemon/bootstrap.ts 里 register 一行；其余文件无感。
}
```

### 3.4 持久化文件

| 文件 | 作用 | 替代什么 |
|---|---|---|
| `~/.local/share/wechat-cc/conversations.json` | `chatId → { mode, primary? }` | 新增 |
| `~/.local/share/wechat-cc/threads.json` | `(chatId, provider) → threadId` | 替代 `sessions.json`（加 provider 维度） |
| `~/.local/share/wechat-cc/internal-token` | daemon ↔ MCP 子进程鉴权 token，mode 0600 | 新增 |
| `memory/<chat_id>/*.md` | Companion 共享 memory | 不变（已在 v1.2） |

`sessions.json` → `threads.json` 迁移：daemon 启动时若发现旧文件，整体读取后写入新格式（默认全部归到 `claude` provider），写完后 rename 旧文件为 `.migrated`。

### 3.5 Provider SDK 能力对照（设计依据）

| 能力 | Claude Agent SDK | Codex SDK | RFC 03 处理 |
|---|---|---|---|
| 持久会话 | `query({ prompt, options })` 长存迭代器 | `codex.startThread()` → `Thread`，多次 `thread.run()` | 各自直接用，统一封装在 `AgentProvider.spawn()` |
| 流式事件 | `for await (msg of q)` SDKMessage union | `runStreamed()` 异步 generator (`item.completed` / `turn.completed`) | 各自适配到 `onAssistantText` / `onResult` |
| Resume | jsonl @ `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` | `~/.codex/sessions/<thread_id>` + `codex.resumeThread(id)` | 各自的 `canResume` 探测函数 |
| Cwd | `options.cwd` | `startThread({ workingDirectory, skipGitRepoCheck })` | 统一在 `AgentProject.path` |
| MCP server | `mcpServers: { name: <inline\|stdio> }` | `~/.codex/config.toml` 或 `Codex({ config: { mcp_servers: {...} } })` | 两边都用 stdio 入口 |
| Per-tool callback | `canUseTool(tool, input)` | ❌（仅 `approval_policy` 粗粒度） | Claude 保留 permission-relay；Codex 降级到 approval_policy（见 §6 风险） |
| 沙盒 | 进程级（OS） | `sandbox_mode: read-only / workspace-write / danger-full-access` | 各自配置，Conversation 级覆盖 |

---

## 4. 四种 mode 的执行流（精确）

### 4.1 Solo（默认）

```
inbound → ModeRouter.lookup(chatId)         // mode = solo, provider = claude
        → Coordinator.dispatchSolo(conv, msg)
        → conv.participants[0].handle.dispatch(formatted)
        → Claude 调 mcp__wechat__reply
        → wechat-mcp → daemon HTTP → ilink.sendMessage
```

零回归路径。和 v1.2 行为完全一致（C3）。

### 4.2 Primary + Tool

例：`/cc + codex`（Claude 主，Codex 一次性工具）

```
inbound → Coordinator.dispatchSolo(conv, msg)    // 实际仍是 solo dispatch
        → Claude 决定调 mcp__delegate__codex({prompt, context_summary})
            ↓
            delegate-mcp 启动 codex.startThread({skipGitRepoCheck: true}).run(prompt)
            （新 thread，不持久化，不 resume；纯一次性"咨询专家"）
            ↓
            返回 turn.finalResponse 给 Claude
        → Claude 拿到结果继续推理 → 调 reply
```

**反向同理**（`/codex + cc`：Codex 主，Claude 工具）。

**防递归**：delegate-mcp 启动子进程时注入 `WECHAT_DELEGATE_DEPTH=N+1` env var；当被调一方又想调对方时，工具实现读 env，>= 2 直接拒绝并返回 `error: max_depth_reached`。daemon 日志告警。

### 4.3 Parallel（`/both`）

```
inbound → Coordinator.dispatchParallel(conv, msg)
        → Promise.allSettled([
            participants[0].handle.dispatch(formatted),    // claude
            participants[1].handle.dispatch(formatted),    // codex
          ])
        → 两边各自调 mcp__wechat__reply
        → wechat-mcp 在 reply 调用时自动注入 participantTag (claude / codex)
        → daemon 在 internal-api 端拼前缀 [Claude] / [Codex] 后送 ilink
```

**关键点**：参与者标签注入是通过 stdio MCP server 启动时的 env var (`WECHAT_PARTICIPANT_TAG=claude`)，工具调用时由 server 自动塞进 reply payload。两个 SDK 看到的工具签名完全一致——不知道自己被打了 tag。

### 4.4 Chatroom（`/chat`）

最复杂。turn-protocol 算法：

```
state = { speaker: pickFirstSpeaker(conv), pending: [user_msg], rounds: 0 }

while state.pending.length > 0:
  if state.rounds >= MAX_ROUNDS: break    // 默认 4，仅作兜底
  msg = state.pending.shift()
  result = await state.speaker.dispatch(msg)

  for each reply_text in result.replies:
    parsed = parseAddressing(reply_text)
    if parsed.addressee == 'user' or parsed.addressee == null:
      → daemon HTTP /v1/reply  (送出，前缀 [Claude] / [Codex])
    elif parsed.addressee == peer(state.speaker):
      state.pending.push({ from: state.speaker, text: parsed.body })
      state.rounds += 1

  state.speaker = peer(state.speaker)    // 轮换发言权
```

**`@addressing` 协议**：

```
@user 这是给用户的回复（默认，不带 @ 也算）
@codex 你看一下 src/foo.ts:42 的边界条件，是不是有个 off-by-one？
@claude 同意，应该把 i <= n 改成 i < n
```

system prompt 里讲清楚：
- 不带 `@` → 默认是给用户的
- `@user` → 显式给用户
- `@<peer-name>` → 与对方 agent 对话

终止是 emergent 的：没人 `@peer` 对方时，pending 队列空，自然结束。MAX_ROUNDS 只是防失控保险。

**特殊命令**：
- 用户在 chatroom 进行中发 `/stop` → 立即清空 pending、强制结束。
- 用户发普通消息 → 加到 pending 队首作为新一轮起点。

---

## 5. MCP 工具的去耦

### 5.1 当前问题

`bootstrap.ts:128` 把 `buildWechatMcpServer(toolDeps)` 内联进 Claude SDK 的 `mcpServers` 选项。这是 **Claude SDK 独有的 in-process MCP** 形态——直接给 SDK 一个 JS 对象作为 server 实现。Codex SDK 不支持这个形态（它只能加载 stdio / HTTP MCP server）。

### 5.2 设计：独立 stdio entry

```
src/mcp-servers/
├── wechat/
│   ├── main.ts            # stdio entry, exports tools via @modelcontextprotocol/sdk
│   ├── tools.ts           # reply / memory_* / voice_* / projects_* 实现
│   └── client.ts          # 调 daemon internal-api 的 fetch wrapper
└── delegate/
    └── main.ts            # mcp__delegate__claude / mcp__delegate__codex
```

- **Claude 那侧**：`mcpServers: { wechat: { type: 'stdio', command: 'node', args: [<path>/wechat-mcp.js] } }`
- **Codex 那侧**：通过 SDK `Codex({ config: { mcp_servers: { wechat: {...} } } })` 注入（spike 1 验证），或 fallback 到写 `~/.codex/config.toml`

**同一个二进制，同一份代码，两个 provider 都能加载。**

### 5.3 daemon ↔ MCP 子进程 IPC

工具执行需要回调 daemon 状态：
- `reply` 需要调 ilink
- `memory_*` 需要写 `<stateDir>/memory/`
- `share_page` 需要 cloudflared tunnel + URL gen
- `voice_*` 需要 voice-config.json + TTS HTTP

让 MCP 子进程直接读 daemon 的 JS 闭包不可能（独立进程）。三种 IPC 候选：

| 方案 | 优点 | 缺点 |
|---|---|---|
| **localhost HTTP** | 简单、跨平台、易 debug | TCP 端口选择 + 防冲突 |
| Unix socket / Named pipe | 无端口冲突、权限控好 | Windows 实现差异、调试麻烦 |
| stdin/stdout 双向 RPC | 零网络栈 | 协议设计复杂、与 MCP 自身的 stdio 抢通道 |

**选 localhost HTTP**。daemon 启动时：
1. 绑 `127.0.0.1:0` 拿一个随机端口
2. 生成 32 字节 token，写 `<stateDir>/internal-token`（mode 0600）
3. MCP 子进程通过环境变量 `WECHAT_INTERNAL_API=http://127.0.0.1:<port>` + 读 token 文件，所有调用带 `Authorization: Bearer <token>`

**信任边界**：daemon 和 MCP 进程都在同一用户下跑，token 防的是同机其他用户访问。够了。

### 5.4 internal-api 接口面

```
POST /v1/reply              { chatId, text, participantTag? }
POST /v1/reply_voice        { chatId, audioPath, transcript? }
POST /v1/send_file          { chatId, path }
POST /v1/edit_message       { chatId, msgId, text }
POST /v1/broadcast          { text, accountId? }
POST /v1/share_page         { title, content, opts? }
POST /v1/resurface_page     { slug? | titleFragment? }
POST /v1/set_user_name      { chatId, name }

GET  /v1/projects           
POST /v1/projects/switch    { alias }
POST /v1/projects/add       { alias, path }
POST /v1/projects/remove    { alias }

POST /v1/memory/read        { path }
POST /v1/memory/write       { path, content }
GET  /v1/memory/list        ?dir=...

POST /v1/voice/status       
POST /v1/voice/save_config  { ... }

POST /v1/companion/status   
POST /v1/companion/enable   
POST /v1/companion/disable  
POST /v1/companion/snooze   { hours? }
```

直接镜像现有 `ToolDeps` 接口，没有新功能。重构而非扩张。

---

## 6. 文件结构（重构后）

```
src/
├── core/
│   ├── agent-provider.ts              ← 接口扩展（threadId 字段）
│   ├── claude-agent-provider.ts       ← 保留，删掉 in-process MCP 内联
│   ├── codex-agent-provider.ts        ← 新建，封装 @openai/codex-sdk
│   ├── conversation.ts                ← 新建：Mode + Conversation + Participant 类型
│   ├── conversation-coordinator.ts    ← 新建：四种 mode dispatch 编排
│   ├── conversation-store.ts          ← 新建：conversations.json 持久化
│   ├── turn-protocol.ts               ← 新建：@addressing 解析、终止判断
│   ├── prompt-builder.ts              ← 新建：(provider, mode, peer?) → system prompt
│   ├── thread-store.ts                ← 替代 session-store.ts（加 provider 维度）
│   ├── session-manager.ts             ← key 改 (provider, alias)，去掉 mode 判断
│   ├── permission-relay.ts            ← 不变（仅 Claude 用）
│   ├── prompt-format.ts               ← 不变
│   └── project-resolver.ts            ← 不变
├── mcp-servers/                       ← 新增目录
│   ├── wechat/
│   │   ├── main.ts                    ← stdio entry
│   │   ├── tools.ts                   ← 从 src/features/tools.ts 移过来
│   │   └── client.ts                  ← internal-api fetch wrapper
│   └── delegate/
│       ├── main.ts                    ← stdio entry
│       └── tools.ts                   ← delegate_claude / delegate_codex 实现
├── daemon/
│   ├── internal-api.ts                ← 新建：localhost HTTP 服务
│   ├── mode-commands.ts               ← 新建：/cc /codex /both /chat /solo /stop 拦截
│   ├── bootstrap.ts                   ← 大瘦身（不再持有工具实现，只组装 stdio path）
│   ├── main.ts                        ← 调 ConversationCoordinator 替代直 routeInbound
│   ├── ...                            ← 其他不变
└── features/
    └── (整个目录删除，迁到 mcp-servers/wechat/)
```

被删除的代码：
- `src/core/codex-cli-provider.ts` （93 行，`exec` 一次性版本）
- `src/features/tools.ts` （工具实现迁移）
- `src/features/tools.test.ts` （随之迁移）

被替代的代码：
- `src/core/session-store.ts` → `src/core/thread-store.ts`（加迁移路径）
- `src/core/message-router.ts` → 大部分逻辑搬到 `conversation-coordinator.ts`，文件可能整个删除

---

## 7. 关键决策 + 理由

| 决策 | 理由 | 不这么做的代价 |
|---|---|---|
| **MCP 工具集独立 stdio server** | Codex SDK 只支持 stdio MCP；维持两份实现必然 drift | in-process Claude + 二份 Codex stdio：双倍维护，schema 偶然不一致就出 bug |
| **localhost HTTP 做 IPC** | 跨平台、易调试、简单 | unix socket：Windows 实现差；stdio RPC：和 MCP 自身 stdio 抢通道 |
| **Conversation 是头等数据** | switching/parallel/chatroom 全部基于"1 chat 多 participant" | 继续用 alias=session：每加一个 mode 都是 hack |
| **`@addressing` 而非 round-robin** | 让 LLM 自己决定要不要继续，emergent 终止 | round-robin：终止条件难调，对话节奏死板 |
| **delegate 限 depth=2** | 防 Claude→Codex→Claude→... 死循环 | 不限：一次失控调用就是几美元 |
| **threads.json 加 provider 维度** | 同 chat 同 alias 下两个 provider 各有 thread，互不污染 | 共用 thread id：resume 不可能（两边 SDK 互不识别） |
| **wechat-mcp 注入 participantTag** | 让 reply 工具自动带身份，prompt 里不用提 | 让 LLM 自己加前缀：会忘、会胡乱加 |
| **首发只 ship Claude + Codex** | 把两个差异最大的 SDK 做透，验证抽象通用；其他 agent 走 `AgentProvider` 自助接入，不预研、不预建 | 主动适配 N agent：滑向 cc-connect 广度同质化（见 RFC 02 §1） |
| **`ProviderId` 是 open string brand，不是闭合 union** | 加新 provider = 加一行 `registry.register(...)`；持久化 schema 不变 | 用闭合 union：每加一个 provider 都改 Mode/Conversation 类型与迁移代码 |
| **memory 共享 across providers** | 单一画像 = Companion 一致性 | 两份 memory：用户感觉是两个不同人 |
| **chatroom MAX_ROUNDS=4 兜底** | 防失控；emergent 终止才是主控制流 | 不设上限：失控调用爆账单 |
| **单 provider 路径零 overhead** | C3 硬约束，C 端用户没付费切多 | 重构夹带 latency：v1.2 用户感知变慢 |

---

## 8. Phase 计划

| Phase | 内容 | 工期 | 价值 | 可独立上线？ |
|---|---|---|---|---|
| **P0** | Codex SDK provider 替换 cli-provider；threads.json 加 provider 维度；migration 路径 | 2 天 | Codex 拿到持久会话 + resume；环境变量 `WECHAT_AGENT_PROVIDER=codex` 直接受益 | ✅ |
| **P1** | wechat-mcp 抽出 stdio server；daemon internal-api；Claude 那侧也走 stdio（一致性） | 4 天 | 工具单一来源；老 features/tools.ts 删除；为 Codex 接 MCP 铺路 | ✅ |
| **P2** | Conversation + Coordinator + ModeRouter + `/cc` `/codex` `/solo` 命令 | 2 天 | 单人切换上线；UX 第一个可感知改动 | ✅ |
| **P3** | `/both` parallel 模式 + participantTag 注入 + 前缀拼接 | 1 天 | 双答 | ✅ |
| **P4** | delegate-mcp + `/cc + codex` `/codex + cc` + depth 限制 | 2 天 | 主从模式（最实用的协作形态） | ✅ |
| **P5** | turn-protocol + chatroom + `/chat` `/stop` + dashboard 显示 mode | 3-4 天 | 圆桌讨论 | ✅ |

合计 **14-16 天**（约 3 周）。每个 Phase 独立 PR，独立上线，独立可回滚。

P0/P1 是其余全部的前置。建议合并为一个 PR（~一周）一起 review，因为 P1 需要 P0 已经引入的 Codex provider 来验证 stdio MCP 在 Codex 那侧能工作。

---

## 9. Spike 验证清单（Phase 0 必做）

P0 开工前要写小 spike 程序确认三件事：

### Spike 1 · Codex SDK 是否自动加载 stdio MCP server

**目标**：验证 `Codex({ config: { mcp_servers: { wechat: {...} } } })` 启动时把 wechat-mcp 子进程拉起，并在 `thread.run()` 期间能调用 wechat-mcp 暴露的工具。

**Pass 标准**：写一个 echo MCP server，让 Codex 调用它的 tool 并把结果返回到 `turn.finalResponse`。

**Fail 兜底**：写 `~/.codex/config.toml` 取代程序化注入；P1 改为依赖文件配置。

**位置**：`docs/spike/phase0-rfc03/01-codex-mcp/spike.ts`

### Spike 2 · Codex `runStreamed` 事件 schema

**目标**：摸清 `item.completed` 事件中 tool call、assistant text、file change 的具体字段名。文档只列出名字，没列字段。

**Pass 标准**：能从事件流中可靠地提取：assistant text 增量、tool 调用名 + 输入、turn 总耗时 + token 使用量。

**Fail 兜底**：如某些字段不暴露，降级到 `run()` buffered 模式（不影响功能，仅丢失 typing 指示器灵敏度）。

**位置**：`docs/spike/phase0-rfc03/02-codex-events/spike.ts`

### Spike 3 · Codex 权限粒度

**目标**：搞清 `approval_policy` (untrusted/on-failure/on-request/never) + `sandbox_mode` (read-only/workspace-write/danger-full-access) 是不是唯一的权限旋钮，有没有 per-tool callback。

**Pass 标准**：能写出与 `permission-relay.ts` 等价的 Codex 配置（即使粗粒度），让 Codex 在 `bypassPermissions` 等价场景下不阻塞。

**Fail 兜底**：Codex 那侧权限是粗粒度。文档化降级规则：solo+codex / chatroom / parallel 模式下 daemon 启动时如果 `dangerouslySkipPermissions=true` 就把 Codex 配 `approval_policy=never sandbox_mode=workspace-write`，否则配 `untrusted` + 用户必须用其他方式确认。

**位置**：`docs/spike/phase0-rfc03/03-codex-perms/spike.ts`

三个 spike 总工期 ~1 天。如果都 PASS 就直接 P0 开工；任一 FAIL 在本 RFC 加 Appendix 记录降级方案后再开工。

---

## 10. 风险 + 兜底

| 风险 | 概率 | 影响 | 兜底 |
|---|---|---|---|
| Codex SDK 不能加载程序化 MCP 配置 | 低 | 中 | 写 `~/.codex/config.toml`（spike 1 兜底） |
| Codex 权限只有粗粒度 | 中 | 中 | permission-relay 在 Codex 那侧降级到 approval_policy（spike 3 兜底）；UI 文档里说明差异 |
| `runStreamed` 事件 schema 不稳 | 低 | 低 | 加版本探测，schema 变化时 fallback 到 `run()` buffered |
| chatroom 失控对话烧钱 | 中 | 高 | MAX_ROUNDS=4 兜底；内部计数器达 10 turns 时 daemon 自动 `/stop` 并告警 |
| stdio MCP 启动 overhead 拖慢 cold-start | 中 | 中 | wechat-mcp 进程在 daemon 启动时一次拉起、长存（不是每个 conversation 拉一次）；C3 基线 benchmark 卡死 |
| internal-api token 泄漏 | 低 | 高 | mode 0600 文件权限 + token 每次 daemon 启动重新生成；用户登出后失效 |
| 用户在 chatroom 误发 prompt 转义字符 | 中 | 低 | turn-protocol 的 @addressing 解析容错：未知 `@xxx` 当作普通文本 |
| 单 provider 路径回归 | 中 | 高 | C3 benchmark；P1 完成后跑 v1.2 vs P1 对比；> 10% 视为阻塞回归 |
| Codex 不会用 `mcp__wechat__reply` 而是吐文本 | 中 | 中 | 已有 fallback 路径（`message-router.ts` 在 replyToolCalled=false 时转发 stdout）；prompt 里强调"必须用 reply 工具" |
| delegate 工具被 LLM 滥用 | 中 | 中 | depth 上限 + 调用计数器（每个 conversation 单条消息内 ≤ 3 次 delegate） |

---

## 11. 不主动做的事

继承 RFC 01 §6 + RFC 02 §1：

- 🚫 **不主动适配/维护 N agent 广度**（cc-connect 红海赛道）—— 但 `AgentProvider` 接口对外开放，PR 欢迎；接入方自己负责实现+维护
- 🚫 **不预研、不预建 Cursor / Gemini / 其他 agent 的接入**—— 等真有用户场景或贡献者出现再说，不靠想象规划
- ❌ **N>2 agent 的圆桌**—— 先证明 2 agent 协作有用户价值；3 agent 的 turn-taking 比 2 agent 复杂一个数量级
- ❌ **工作 IM**（企业微信 / 钉钉 / 飞书 / Slack / Discord for work）
- ❌ **跨 chat 的 multi-agent**（每个 chat 独立选 mode；不做"全局某种模式"）
- ❌ **chatroom 的复杂 moderator**—— 靠 LLM 自己 `@addressing` emergent 终止，不写 voting / consensus / quorum 这种笼子
- ❌ **同一 chat 跑多个 conversation**—— 一个 chat = 一个 conversation = 一个 mode
- ❌ **保留 cli-provider.ts 作为 fallback**—— v1.0 干净切换的精神（RFC 01 §6 末条），P0 删干净

---

## Appendix A · 系统 prompt 示例（Chatroom 模式）

`prompt-builder.ts` 在 chatroom 模式下，给 Claude 拼出来的 prompt 大致：

```
你是 claude，正在 wechat-cc 的协作对话里。
另一位参与者是 codex（OpenAI GPT-5-Codex）。
对话场景在用户的微信里，由用户主导。

@addressing 协议:
- 不带 @ → 默认是给用户的回复
- @user → 显式给用户
- @codex → 与 codex 对话（用户也能看见，但不算最终答复）

你看到的每条 inbound 都会标明来源:
  <wechat ...>...</wechat>           ← 用户消息
  <peer name="codex">...</peer>      ← codex 上一轮 @claude 你的话

终止由你和 codex 协商: 当双方都不再 @ 对方时，对话自然结束。
不必每轮都 @ 对方; 如果你认为已经讨论充分了，直接 @user 给最终答复即可。

工具: reply / memory_* / voice_* / share_page 等正常工具仍可用。
注意: chatroom 模式下使用 reply 也会自动带上你的 [Claude] 前缀。
```

Codex 那侧是镜像版（"你是 codex...另一位是 claude..."）。

---

## Appendix B · `~/.codex/config.toml` 兜底配置

如果 Spike 1 FAIL（Codex SDK 不接受程序化 MCP 注入），P1 改用文件配置：

```toml
# ~/.codex/config.toml （wechat-cc 安装时自动写入）

sandbox_mode = "workspace-write"
approval_policy = "never"

[mcp_servers.wechat]
command = "node"
args = ["<install-prefix>/share/wechat-cc/mcp-servers/wechat-mcp.js"]

[mcp_servers.wechat.env]
WECHAT_INTERNAL_API = "http://127.0.0.1:<port>"  # daemon 启动时填
WECHAT_INTERNAL_TOKEN_FILE = "<stateDir>/internal-token"
```

`<port>` 在 daemon 启动 → 选端口 → 改写 toml → 通知 Codex SDK 重启已有 thread（或在新 thread 上生效）这条链路上有些细节，spike 兜底实现里再敲。

---

## Appendix C · `AgentProvider` 接口扩展

为了支持 thread id 透出（resume 需要）和 cancel（chatroom 用户 `/stop` 用），`agent-provider.ts` 需要一处微改：

```diff
 export interface AgentSession {
   dispatch(text: string): Promise<{ assistantText?: string[]; replyToolCalled?: boolean } | void>
+  cancel(): Promise<void>                              // 新增：中断当前 turn
   close(): Promise<void>
   onAssistantText(cb: (text: string) => void): () => void
   onResult(cb: (result: AgentResult) => void): () => void
+  threadId(): string | null                            // 新增：当前 thread id
 }
```

Claude 那侧 `cancel()` 调 `q.interrupt()`；Codex 那侧调 `thread.cancel()` 或子进程 SIGINT（待 spike 2 确认 SDK 暴露什么 API）。

---

---

## Appendix D · 接入新 Provider 的步骤（前瞻）

本 RFC 不主动做这件事，但记录下"如果未来有人要加"的具体路径，以**反向验证抽象设计是否真的开放**。如果以下步骤里出现"必须改 X 模块的核心逻辑"——抽象就漏了。

设想：有人想接 Gemini CLI（假设 Google 出了 daemon-friendly TS SDK）。需要做的事：

1. **写 `src/core/gemini-agent-provider.ts`**——实现 `AgentProvider` 接口
   - `spawn(project, opts?) → AgentSession`
   - `dispatch(text) → { assistantText, replyToolCalled }`
   - `onAssistantText / onResult / cancel / close / threadId`
   - 内部包装 Gemini SDK 的 streaming events

2. **在 `daemon/bootstrap.ts` 注册一行**：
   ```ts
   registry.register('gemini', createGeminiAgentProvider({...}), {
     displayName: 'Gemini',
     canResume: (cwd, threadId) => existsSync(`<gemini-session-path>/${threadId}`),
   })
   ```

3. **配 stdio MCP**——和 Claude/Codex 一样，让 Gemini SDK 加载 wechat-mcp（程序化或 config 文件，看那个 SDK 支持什么）

4. **加 prompt 模板**——`src/core/prompt-builder.ts` 加 `'gemini'` 分支（仅措辞调整，结构复用）

5. **加 mode-commands**——`/gemini` 切到 solo+gemini，`/cc + gemini` 启用 primary+tool 等。Mode 类型不需要改（`ProviderId = string`），只新增命令路由

**不需要做的事**（验证抽象不漏）：
- ❌ 改 `Conversation` / `Participant` 类型
- ❌ 改 `SessionManager` LRU 逻辑
- ❌ 改 `ConversationCoordinator` 的四种 mode dispatch
- ❌ 改 `wechat-mcp` 工具实现
- ❌ 改 `internal-api` 接口面
- ❌ 改 `threads.json` schema

如果 P0-P5 完成后这条路径成立，抽象就是真的开放。如果有任一项 ❌ 实际需要改，说明设计回退到"伪开放"——RFC 03 的设计目标失败，回炉。

这条 Appendix 也是后续做"接入贡献指南"`docs/contributing/add-a-provider.md` 的雏形。

---

## 修订历史

| 日期 | 变更 |
|---|---|
| 2026-05-02 | 初版 draft，待 review + spike 验证后转 Accepted |
| 2026-05-02 | 用户反馈：抽象应对其他 agent 开放（"先解决 codex/claude，让他们无缝接入；其他自然也能"）。修订 §1.1 / §1.3 / §3.3 / §7 决策表 / §11 措辞；新增 Appendix D 接入指南雏形 |
