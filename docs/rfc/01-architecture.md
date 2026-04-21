# RFC 01 · wechat-cc 架构（Agent SDK 重构）

**Status**: Accepted · 2026-04-21
**Phase**: 0（规划 + spike）
**Supersedes**: 当前基于 MCP Channel 的架构（0.2.x）
**Target**: v1.0 首个 Agent SDK 版本

---

## TL;DR

wechat-cc 从 Claude Code research-preview **MCP Channel plugin** 重构为基于 **Claude Agent SDK** 的**常驻 daemon + Claude Code plugin 入口**的双模架构，目标是：

1. **彻底消除**当前在 Windows 上不可接受的对话框和死循环问题
2. **清晰差异化**——不和 cc-connect 在"通用 bridge"维度竞争，开"个人 AI 伴侣 × Claude Code 深度"新维度
3. **面向未来**——顺着 Anthropic 的 Agent SDK / headless 主线走，远离会被收编的 research-preview 路径

核心架构假设在 Spike 1（Windows, 2026-04-21）已验证：Bun + `@anthropic-ai/claude-agent-sdk` headless 模式在 Windows 上**零对话框**工作（附录 A）。

---

## 1. 定位

**一句话定位**：

> **"个人 Claude Code 伴侣，深度 × 小白 × 专一"**

**展开**：
- **个人**：只做个人微信（不做企业微信/飞书/钉钉等工作 IM）
- **Claude Code**：只服务 Claude Code 用户（不做多 agent bridge）
- **深度**：在这个窄场景做到极致，而不是在多场景做及格
- **小白**：首次使用零配置，默认行为合理，错误信息人话化
- **伴侣**：不是被动响应的 bot，是主动感知用户状态的工作伙伴

**不做的定位**（见 §7）：
- ❌ 通用消息 bridge（那是 cc-connect）
- ❌ 工作 IM（企业微信/钉钉/飞书）
- ❌ 多 agent 适配（只绑 Claude Code）
- ❌ 多平台扩展（Telegram/Discord 等可考虑但非优先）

---

## 2. 硬约束（定位倒推出的 5 个不可协商项）

| # | 约束 | 原因 |
|---|---|---|
| C1 | **服务进程常驻**，不依赖 claude 窗口生死 | 远程场景核心（用户关机后出门，回来仍能用） |
| C2 | **启动路径零对话框** | Windows 上 MCP Channel 路径每次弹 dev-channel 对话框，远程不可用 |
| C3 | **多 project 完全隔离** | session 上下文互不污染，切换零按键 |
| C4 | **主动伴侣能力** | 差异化核心，架构层面支持（而非 feature 加法） |
| C5 | **小白友好默认** | 零配置、默认合理、错误可恢复 |

满足 C1-C5 的架构选择空间被锁死——只有**常驻 daemon + Claude Agent SDK headless + per-project session pool + companion layer** 一个组合能同时满足。

---

## 3. 架构（5 层）

```
┌───────────────────────────────────────────────────────────┐
│  L5  Observable UX Layer                                   │
│      web UI + onboarding flow + error guidance             │
├───────────────────────────────────────────────────────────┤
│  L4  Companion Layer（灵魂，独家）                         │
│      relationship memory + proactive trigger + tone        │
├───────────────────────────────────────────────────────────┤
│  L3  Feature Layer                                         │
│      share_page, permission relay, voice, /project, /cron  │
├───────────────────────────────────────────────────────────┤
│  L2  Integration Layer                                     │
│      ilink (WeChat)  |  Claude Code plugin interface       │
├───────────────────────────────────────────────────────────┤
│  L1  Session Pool Layer                                    │
│      N × headless ClaudeSDKClient, worktree-isolated       │
├───────────────────────────────────────────────────────────┤
│  L0  Runtime Layer                                         │
│      Bun daemon (常驻) + Claude Agent SDK (TypeScript)     │
└───────────────────────────────────────────────────────────┘
```

### L0 · Runtime

**技术选型**：
- **Bun 1.3+** 作为 daemon runtime（保留现有投资）
- **`@anthropic-ai/claude-agent-sdk`** TypeScript（官方 SDK，Bun 原生支持）
- 无 native addon 依赖（不用 node-pty / 不用 C++ 绑定）

**不是 Claude Code plugin 进程**：
plugin 生命周期绑定 claude 进程 → 违反 C1。wechat-cc 必须是独立 daemon。plugin 仅作为 claude 内的**控制面入口**（见 L2）。

**不换 Go / Python**：
- Go 重写的性能收益对 IM bot 不显著（几 QPS 级别）
- Bun 冷启动 + TS 生态 + 现有代码资产综合最优

### L1 · Session Pool

**核心**：每个 project 一个独立 `ClaudeSDKClient`，**lazy spawn**。

```ts
// 概念代码，实际实现见 Phase 1
type SessionPool = Map<ProjectAlias, ClaudeSDKClient>

async function routeInbound(msg: WeChatMessage) {
  const project = resolveProject(msg)
  let client = pool.get(project.alias)
  if (!client) {
    client = new ClaudeSDKClient({
      cwd: project.path,
      permissionMode: 'acceptEdits',
      // mcp_config / hooks / etc.
    })
    pool.set(project.alias, client)
  }
  client.query(msg.text)
}
```

**设计要点**：
- **Lazy spawn**：注册 10 个 project 不会预启动 10 个 claude
- **Keep-alive**：session 一旦启动就保持，`/project switch` = 换引用（μs 级）
- **worktree 隔离可选**：默认 same-dir（小白友好），高级用户 opt-in worktree
- **资源回收**：超时未使用的 session 可以 evict（LRU 简单策略）

**借鉴**：Claude Code Remote Control `--spawn worktree/session/same-dir` + `--capacity N` 成熟设计。

### L2 · Integration Layer（双入口）

#### 入口 A · ilink worker（主入口）
- 常驻 long-poll WeChat `/ilink/bot/getupdates`
- 独立于 claude 进程生死
- 现有 `ilink.ts` 逻辑保留，只改"消息最终发给谁"

#### 入口 B · Claude Code plugin（辅助入口）
- `.claude-plugin.json` + skills 注册
- 用户 `/plugin install wechat-cc@marketplace`
- plugin **不启动 daemon**，只是 daemon 的 RPC 客户端
- 暴露：
  - `/wechat:share <markdown>` 把当前 plan 发自己微信
  - `/wechat:notify <message>` 让 claude 主动发微信
  - `/wechat:status` 看 daemon / session / companion 状态
- 如 daemon 未运行，plugin 命令提示用户启动

**这是关键设计**：daemon + plugin 不是二选一，是**主从关系**。daemon 是服务（L1-L4 核心），plugin 是 claude 里的控制面。

### L3 · Feature Layer

| Feature | 来源 | 在新架构的实现 |
|---|---|---|
| `share_page` | 独家 | 保留现有 docs.ts 实现，绑 loopback + Approve button 不变 |
| `permission relay` | 独家 | 改用 Agent SDK `canUseTool` callback（Phase 0 Spike 3 验证） |
| 语音 in + out + TTS | 借鉴 cc-connect | Phase 2 补足，ilink 语音 outbound API（Spike 4 验证） |
| `/project add/list/switch` | 本项目 + 借鉴 | 底层改用 session pool，语义不变，**零对话框切换** |
| `/cron` 定时任务 | 借鉴 cc-connect | 底层对接 Companion layer（L4） |
| 多账号 multi-bot | 保留 | 不变 |

### L4 · Companion Layer（灵魂）

**这是和 cc-connect 根本拉开的一层**。第一版就做，不是 v2+ 的加法。

#### 4.1 Relationship Memory

文件：`~/.claude/channels/wechat/relationship.json`

```typescript
interface Relationship {
  user_profile: {
    chat_id: string
    name: string
    active_hours: TimeRange[]      // 观察学习
    preferred_tone: 'formal' | 'casual' | 'cute'
    projects_importance: Record<alias, score>
  }
  interaction_history: {
    last_message_at: timestamp
    push_history: PushEvent[]       // 含效果评估（回复了 vs ignore）
    topics_discussed: Topic[]
  }
  state: {
    mood_signal: 'stressed' | 'excited' | 'neutral' | ...
    last_completed_task: string
    open_loops: string[]            // 上次聊了但没闭环的话题
  }
}
```

**维护方式**：每次互动后 Claude 调用 `wechat_update_memory` tool 更新这个结构。不是硬编码规则，**让 Claude 自己维护关系记忆**。

#### 4.2 Proactive Trigger

```typescript
every 15-30 minutes (jitter):
  for each project in sessionPool:
    ask claude (via Agent SDK):
      """
      当前状态：
      - 用户最后互动：2h 前，讨论 XXX
      - 时间：周三下午 3 点，用户活跃时段
      - 开放话题：[XXX, YYY]
      - 最近推送历史：[...]
      - 已知用户偏好：[...]
      
      现在主动联系合适吗？如果合适，说什么？
      回 JSON: {should_push: bool, message: string, reason: string}
      """
    if should_push:
      record push event + reason
      send via ilink
```

**关键**：**Claude 自己判断**要不要主动发，不是硬编码规则。

对比 cc-connect 的 `/cron` 是**用户硬编码定时**，wechat-cc 的 Proactive Trigger 是**Claude 智能判断**。这是 L4 最核心的差异化。

#### 4.3 Opt-in Gating

默认 **关闭** Proactive Trigger。用户 `/wechat:companion enable` 开启。避免"未被期望的主动打扰"成为小白首次体验的负担。

### L5 · Observable UX

**小白友好的关键**：让用户看见系统在干什么。

- **Web UI**（现有 `log-viewer.ts` 升级）：
  - 当前活跃 sessions 列表 + pool 状态
  - 最近消息流（实时 SSE）
  - Companion decisions 日志（"3 分钟前 Claude 决定不 push，理由：用户在会议中"）
  - Relationship memory 可视化（画像 + 互动历史）
- **Onboarding**：
  - 扫码 → 自动 setup → 可选 demo → 完成
  - 不让小白接触 `.mcp.json` / CLAUDE.md
- **错误自愈**：
  - session expired → 自动引导重扫码
  - session jsonl 损坏 → 自动备份 + 新建
  - 所有错误中文自然语言说明

---

## 4. 关键决策 + 理由

| 决策 | 理由 | 不这么做的代价 |
|---|---|---|
| **daemon + plugin 双入口** | 独立进程解决 C1 远程可用性，plugin 解决深度集成 | 单 plugin：关了 claude 就没响应（违反 C1） |
| **Agent SDK headless 而非 MCP Channel** | 零对话框、跨平台一致、不依赖 Anthropic approved allowlist | MCP Channel：Windows 必弹对话框，research preview 路径风险 |
| **Session pool lazy spawn** | 资源经济 + 切换 μs 级 | 预启动所有 project：内存吃爆 |
| **Worktree 默认关闭** | 小白不懂 git worktree | 默认开：小白 git 状态乱 |
| **Companion layer 第一天就做** | 差异化核心，定位的灵魂 | 延后：产品是加法而非定位，品牌力差 |
| **Bun + TypeScript 不换语言** | 保留现有投资，性能够用 | 换 Go：重写 ROI 负 |
| **不做多 agent** | 偏离"Claude Code 深度"定位 | 做：和 cc-connect 同质化必输 |
| **不做多平台 bridge** | 偏离"个人微信专一"定位 | 做：竞品已做得更好 |

---

## 5. 业界对照

### 5.1 从谁借鉴什么

| 参照 | 学什么 | 在 wechat-cc 的体现 |
|---|---|---|
| **Claude Agent SDK** | headless stream-json 架构 | L0/L1 基础 |
| **Claude Remote Control** | `--spawn worktree/session`、多 session pool、capacity 设计 | L1 设计源头 |
| **Claude Telegram/Discord official** | `instructions` 字段写法、`<channel>` tag 格式 | L3 消息格式参考 |
| **cc-connect** | `/cron`、语音 in/out、session 命令、多语言 | L3 feature 参考 |
| **Dispatch**（Claude Desktop） | 手机 push 单线程对话模式 | L4 主动推送 UX |
| **Replika / Character AI** | 关系维护、情感 tone | L4 开发者版本 |

### 5.2 和 cc-connect 的定位对比

| 维度 | cc-connect | wechat-cc |
|---|---|---|
| 关键词 | 工具、广度、多 platform、多 agent | **深度、个人、陪伴** |
| 用户画像 | 团队、工作场景、多工具栈 | **个人开发者、生活-工作融合、Claude Code 主力** |
| 典型场景 | 同事在 Slack @claude 处理 PR | **我一个人在微信问 Claude "周末想重构这个模块，你觉得呢"** |
| UI 哲学 | 功能齐全，学习曲线中等 | **开箱即用，一步教会** |
| 成功度量 | 覆盖平台数量 × 活跃 org | **用户 retention × 每日互动** |

**目标用户几乎不重叠**。两产品平行发展。

### 5.3 长期生态演进判断

- **Anthropic 不会做个人微信 channel**（政治/监管原因）→ 这块是永久空白
- **cc-connect 受"Anthropic 收编 approved channels"威胁**（Telegram/Discord 已在 allowlist）→ 多平台赛道压力
- **wechat-cc 受到的威胁最小**：定位（"个人 AI 伴侣"）是 cc-connect 不做的、Anthropic 也不做的
- **10 年后**：通用 bridge 可能大部分被吞，"懂我的 AI 工作伙伴"这个维度会更重要

---

## 6. 绝对不做的事

- ❌ **工作 IM**（企业微信/钉钉/飞书/Slack/Discord for work）—— 偏离"个人"
- ❌ **多 agent 支持**（Codex/Cursor/Gemini）—— 偏离"Claude Code 深度"
- ❌ **视频通话、朋友圈、公众号订阅** —— API 做不到，也不是核心
- ❌ **和 cc-connect 比 feature 广度** —— 必输赛道
- ❌ **过度工程化**（K8s/分布式/多租户）—— 违背"小白友好"
- ❌ **保留老 MCP Channel 路径作为 fallback** —— 维护两套架构复杂度翻倍，**v1.0 干净切换**

---

## 7. Roadmap（Phase 分期）

```
Phase 0 · Spike                  5-7 天    验证关键技术假设
  ✅ Spike 1: Bun + Agent SDK stability   (2026-04-21 PASS on Windows)
  ⏳ Spike 2: Session pool overhead
  ⏳ Spike 3: Permission callback coverage
  ⏳ Spike 4: ilink voice outbound
  ✅ RFC 定稿（本文档）

Phase 1 · Core Rebuild           2-3 周    Agent SDK + Session Pool
  - src/core/session-manager.ts
  - src/core/message-router.ts
  - ilink worker 保留，改消息路由
  - 删除 .restart-flag / hasClaudeSessionIn / 其他 hack
  - 兼容现有 state 文件（accounts/ / allowlist / context_tokens）
  - Windows 零对话框验证通过
  - ✅ 发版 v1.0 — Windows 用户可用

Phase 2 · Feature Port           1-2 周    独家能力迁移
  - share_page 迁移到新架构
  - permission relay 改用 Agent SDK canUseTool callback
  - 语音 outbound + TTS 新增
  - ✅ 发版 v1.1 — feature parity + voice

Phase 3 · Companion              2-3 周    灵魂层
  - Relationship memory 模型 + storage
  - Scheduled companion tick（Claude 自判断）
  - 事件驱动 hook（PR 状态 / CI 结果 / 长任务完成）
  - 用户画像自动学习
  - Opt-in 开关（默认关闭）
  - ✅ 发版 v2.0 — AI 伴侣定位正式确立

Phase 4 · UX Polish              1-2 周    小白化
  - Web UI 升级（sessions / decisions / memory 可视化）
  - Onboarding flow（扫码即用）
  - 错误信息人话化
  - Plugin marketplace 上架
  - ✅ 发版 v2.1 — marketplace 可见

─────────────────────────────────────
总计                             8-11 周
```

每个 Phase 末发版独立验证，不等终局。

---

## 8. 风险 + 兜底

| 风险 | 概率 | 兜底 |
|---|---|---|
| Bun + Agent SDK 某平台不稳 | 低（Windows 已验证） | 备选：Node 替代 Bun |
| Session pool 内存吃爆 | 中 | LRU evict + `--capacity` 限制 |
| Agent SDK `canUseTool` 不支持细粒度审批 | 低 | 备选：fall back 到 per-mode（cc-connect 水平） |
| ilink 语音 API 文档不全 | 中 | 备选：读 wechat-clawbot SDK 源码 |
| Companion layer 过度打扰用户 | 中 | 默认 opt-in + 频率限制 + 用户可一键关闭 |
| Anthropic 未来出官方个人微信 channel | 极低（政治原因） | 即使出，wechat-cc 的 Companion layer 仍独有 |
| cc-connect 抄 Companion 思路 | 中 | 他们定位是 bridge，产品哲学不会真正做深 |

---

## Appendix A · Spike 1 结果（Windows, 2026-04-21）

**Setup**: Windows 11 Enterprise, Bun 1.3.13, Claude Code 2.1.116, `@anthropic-ai/claude-agent-sdk` latest

**Code**: `docs/spike/phase0/01-sdk-stability/spike.ts`

**Run**:
```
[spike] platform: win32 x64
[spike] runtime: bun 1.3.13
[spike] [11406ms] msg #1: type=system
[spike] [11408ms] msg #2: type=system
[spike] [11424ms] msg #3: type=system
[spike] [14498ms] msg #4: type=assistant
[spike] [14719ms] msg #5: type=rate_limit_event
[spike] [14721ms] msg #6: type=result
assistant txt : "SPIKE_OK"
result.session_id    : 3255d170-8b30-4449-9661-e78f200b4711
result.num_turns     : 1
result.total_cost_usd: 0.16112375
result.duration_ms   : 3304
[spike] PASS ✅
```

**Verdict**:
- ✅ 零对话框（no workspace-trust, no dev-channel, no permission）
- ✅ stream-json 双向通信稳定
- ✅ session_id 返回，可 resume
- ✅ Bun 1.3.13 + Agent SDK 在 Windows 原生工作

**Observations**:
- 启动 overhead ~11s（3 个 system messages 在 first assistant turn 前）—— session pool 需 lazy spawn + keep-alive
- 默认 model = Opus，$0.16/turn—— 后续 spike 用 `model: 'haiku'` 降本
- 三个 init system messages 值得后续分析（可能用于 Companion layer 的 session 初始化 hook）

---

## Appendix B · 未解决问题（跟踪列表）

1. `--worktree` 模式下 git commit 策略——切换 project 前是否 auto stash？
2. Companion Proactive Trigger 频率默认值调参（15 min 起步，观察用户反应）
3. Relationship Memory 多账户场景——每个 chat_id 一份，还是全局共享？
4. Plugin marketplace 上架时 daemon 安装方式——让用户手动 bun install，还是 plugin 内带 daemon 启动引导？
5. Anthropic 未来若开放 Agent SDK 的 webhook-style 注入（见 Issue #27441），wechat-cc 是否重构接入？

---

## 修订历史

| 日期 | 变更 |
|---|---|
| 2026-04-21 | 初版定稿，Spike 1 PASS 后确认架构方向 |
