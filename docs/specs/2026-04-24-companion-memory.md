# Spec · v2.0 Companion Soul Layer (Relationship Memory)

**Status**: Draft · 2026-04-24
**Parent**: RFC 01 §3.L4 · RFC 02 §4
**Depends on**: v1.2 shipped (session persistence + MCP split are prereqs)
**Expected effort**: 3-4 weeks

---

## Motivation

v1.1 的 Companion 层做了**脚手架**（`src/daemon/companion/`：persona / scheduler / eval-session / logs / config），但 Claude 在里面没有"记忆"：每次 tick 只看**当下**的 `cfg` + `profile.md` + persona，不知道昨天 push 过什么、user 回了没、这个时段对方是否愿意被打扰。

这是 cc-connect 生态位里**永远不会出现**的一层（cc-connect 哲学是 bridge，不是陪伴）。做扎实，就是 wechat-cc 的护城河。

---

## 目标（v2.0 验收）

1. Claude 每条 proactive push 后，观察 user 反应并记录为"效果信号"（reply / ignore / 表示反感 / snooze）
2. Claude 下次判断是否 push 时能引用过去 N 条 push 的效果平均值
3. user 的 active_hours 从观察中**自动学习**，不用手配
4. user 的 preferred_tone 由 Claude 感知并存下来，persona 选择时作为输入
5. 所有上述状态 user 在 web UI 可读、可手动修正

---

## 数据模型

### `~/.claude/channels/wechat/relationship.json`

```typescript
interface RelationshipStore {
  version: 1
  chats: Record<ChatId, RelationshipRecord>
}

interface RelationshipRecord {
  chat_id: string
  // 身份 —— 基础识别
  display_name?: string           // 用户告诉的昵称 or ilink 返回的 user_name
  user_id: string                 // ilink user_id (o9cq8...@im.wechat)
  first_interaction_at: string    // ISO timestamp
  last_interaction_at: string     // ISO timestamp

  // 观察学习 —— Claude 自己维护
  profile: {
    active_hours?: Array<{ start: string; end: string; confidence: number }>  // "09:00-11:30", "22:00-00:30"
    preferred_tone?: 'formal' | 'casual' | 'cute' | 'pro'
    projects_importance?: Record<ProjectAlias, number>  // 0-1 normalized
    observed_topics?: string[]                           // ["rust", "数据库优化", "工厂排产"] — free-form
  }

  // 互动历史 —— 只保留近 90 天
  interaction_history: {
    recent_messages_count_24h: number       // 被动算出
    reactive_reply_latency_ms_avg?: number  // user 平均响应时长 — "心流状态" 指标
    push_events: PushEvent[]                // append-only, 90-day rolling window
    topics_discussed: Array<{ topic: string; last_at: string; mentions: number }>
  }

  // 状态 —— 短期信号，Claude 每次互动后更新
  state: {
    mood_signal?: 'stressed' | 'excited' | 'neutral' | 'tired' | 'curious'
    mood_inferred_at: string
    last_completed_task?: string            // "写完了 v1.1 的 release notes"
    open_loops?: string[]                   // "上次说要看 Rust async 文章还没反馈", "问了周末计划没回"
    do_not_disturb_until?: string           // ISO — 显式 snooze 或 Claude 推断
  }
}

interface PushEvent {
  id: string
  pushed_at: string
  message_summary: string                   // 前 100 字预览
  reason: string                            // Claude 当时的 push 理由
  outcome: 'replied_positive' | 'replied_neutral' | 'replied_negative' | 'ignored' | 'snoozed' | 'pending'
  user_reply_summary?: string               // 若回复，前 100 字
  outcome_finalized_at?: string             // 24h cutoff
}
```

### 存储策略

- 单文件（非 per-chat 分文件）。个人场景最多几个 chat_id，总大小 <100KB。
- 写入走 `state-store` pattern（500ms debounce + atomic rename，跟 context_tokens / acctStore 一致）
- 读是 sync（memory cache + disk on miss），跟 access.ts 同风格

---

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│  src/daemon/memory/  (新增模块)                              │
│  ├── store.ts         — RelationshipStore load/save          │
│  ├── observer.ts      — observeInbound(msg) 更新 history     │
│  ├── updater.ts       — updateRecord(chat_id, patch) 给 MCP  │
│  └── query.ts         — getRecord / activeChats / getRecent  │
├─────────────────────────────────────────────────────────────┤
│  src/daemon/companion/ (扩展)                                 │
│  ├── eval-session.ts  — 传 relationship context 进 eval      │
│  ├── scheduler.ts     — 不再 cron-only；支持 "tick with jitter" │
│  └── outcome-tracker.ts (新增) — 监听 inbound 判定 push outcome │
├─────────────────────────────────────────────────────────────┤
│  src/features/companion-tools.ts (扩展 — Task 3 拆包后)       │
│  ├── companion_memory_get    — Claude 读自己的记忆              │
│  ├── companion_memory_update — Claude 写进度、偏好、心情        │
│  └── companion_memory_debug  — admin 查完整状态              │
└─────────────────────────────────────────────────────────────┘
```

---

## 三个新能力

### 能力 1 · Outcome Feedback Loop

**流程**：
1. eval-session 决定 push → `scheduler` 发送 → 写 `PushEvent{ outcome: 'pending' }` 到 relationship.interaction_history
2. `outcome-tracker` 订阅 inbound message bus（挂在 `onInbound`）：
   - 24h 内 inbound from 同 chat_id → 让 Claude 单独做一次极轻的 eval："这条回复相对上次 push 是 positive/neutral/negative?"（低成本，只用 haiku，<500ms）
   - 24h 内无 inbound → 自动标 `ignored`
   - user 说 "/snooze" 类 → `snoozed`
3. `PushEvent.outcome` 终态化写盘

**接口**：
```typescript
// src/daemon/companion/outcome-tracker.ts
export function makeOutcomeTracker(deps: {
  memory: MemoryStore
  quickEval: (pushSummary: string, userReply: string) => Promise<Outcome>
  log: (tag: string, msg: string) => void
}): {
  onInbound(msg: InboundMsg): void    // 调于 main.ts onInbound
  sweep(): void                        // 24h cutoff 检查；scheduler 每小时调
}
```

### 能力 2 · Smart Tick（不是 cron）

当前 scheduler 是 cron 驱动（`* */15 * * *` 每 15 分钟一次）。升级后：

```typescript
// src/daemon/companion/scheduler.ts (扩展)
interface TickConfig {
  base_interval_ms: number           // 15min = 900_000
  jitter_ratio: number                // 0.3 → next tick ± 30%
  quiet_hours?: Array<TimeRange>     // 从 relationship.profile.active_hours 反推
}

// 每 tick:
async function tick() {
  for (const chatId of activeChats()) {
    const rel = memory.get(chatId)

    // 硬规则先过滤
    if (inQuietHours(rel.profile.active_hours)) continue
    if (rel.state.do_not_disturb_until && now < rel.state.do_not_disturb_until) continue
    if (recentPushThrottled(rel)) continue   // 默认 2h 一次 cap

    // 交给 eval-session（用 full context）
    const decision = await evalTrigger({
      relationship: rel,
      recent_pushes: rel.interaction_history.push_events.slice(-10),
      current_time: now,
    })

    if (decision.should_push) {
      await send(chatId, decision.message)
      memory.appendPushEvent(chatId, { ...decision, outcome: 'pending' })
    } else {
      // 不 push 也记，便于 web UI 展示"Claude 决定不 push，理由：xxx"
      memory.appendSkipDecision(chatId, decision.reason)
    }
  }
}
```

### 能力 3 · Active Hours Auto-Learning

**观察**：`observer.ts` 在每条 inbound 上更新 `hourly_message_count`（ring buffer 28 天）。每天 0 点做一次 aggregate → fit 出 peak hours。

```typescript
function inferActiveHours(hourlyBuckets: number[]): TimeRange[] {
  // 简单实现：找 top 3 连续时段（count > mean + 0.5*std）
  // v2.0 够用；v2.1 如需精准可 upgrade 到 Gaussian Mixture
}
```

结果写进 `profile.active_hours`，置信度随样本量增长。Claude 在 persona prompt 里看到这段作为"what this user is usually doing right now"。

---

## 与 v1.1 现有代码的 merge 策略

- `src/daemon/companion/scheduler.ts` 现在是 croner-based；v2.0 保留 cron 模式作为 "固定时段" 触发选项（比如"每晚 22:30 问候"），新增 smart tick 作为默认。两种 trigger 类型并存。
- `src/daemon/companion/eval-session.ts` 保持现有 `makeEvalTrigger` 接口；内部实现改为"把 relationship 切片作为 context 注入"。MCP 工具层不动。
- `persona.ts` 不变；persona 选择改成 `persona = chooser(rel.profile.preferred_tone)`。
- `profile.md` 模板保留（用户可手写偏好），优先级高于自动学习。

---

## 新增 MCP 工具

| 名称 | 说明 | 谁调用 |
|---|---|---|
| `companion_memory_get` | 读 chat_id 的 profile + state（不暴露 interaction_history raw） | Claude 自己在回复时参考 |
| `companion_memory_update` | 写 profile / state 字段；不支持写 interaction_history（仅 outcome-tracker 能写） | Claude 每次回复后可调用 |
| `companion_memory_debug` | 读完整记录包括所有历史 | admin 手动排查 |

（这 3 个工具进 `wechat-companion` MCP server — 依赖 v1.2 Task 3 的拆包）

---

## 隐私 & 安全考量

- Relationship memory 是**敏感数据**（用户习惯 / 情绪 / 话题）。
  - `~/.claude/channels/wechat/relationship.json` mode 0600（跟其它 state 一致）
  - Web UI 不展示 mood_signal raw，只展示 aggregated（"今天主要 neutral"）
  - 用户明示 "清空我的记忆" → `companion_memory_update({clear:true})` 归零 record
- `outcome-tracker` 的 quickEval 用 haiku 就够，**不要**把完整 user reply 喂给云 API — 截断到 100 字摘要
- relationship.json 永远不进 git（已在 `.gitignore` 的 `~/.claude/` 层级 implicit）

---

## 验收标准

- [ ] 连续 7 天真实使用后，`relationship.profile.active_hours` 能合理反映实际活跃时段（人工看一眼）
- [ ] Claude push 后 24h，`outcome` 字段一定终态化（positive/neutral/negative/ignored/snoozed）
- [ ] 连续 push 3 次都被 `ignored` → Claude 下次自动延长 base_interval × 2（learning kicks in）
- [ ] user 发"别烦我" 类措辞 → mood/do_not_disturb 被捕捉，2h 内不再 push
- [ ] Web UI dashboard 能查到某条 push 的"decision reason"

---

## Not in scope (v2.0)

- ❌ 跨 chat_id relationship graph（"旺仔跟顾时瑞是同事"）— 可能 v3
- ❌ 图片 / 语音历史作为记忆输入 — 暂只文本
- ❌ 跨机器 relationship.json 同步 — 单机使用
- ❌ Claude 主动语音 push（voice 退役，等 Tencent）

---

## Open questions

1. quickEval 用 haiku 估每月成本？需要先算 push/day × outcome-eval 成本 × haiku 单价。
2. Relationship memory 是否共享给**主 session**（即 user 主动对话时 Claude 能否 context 进来）？倾向 yes，但得控 tokens 预算。
3. Active hours 推断的 sample 阈值多少天够？初判 7-14 天，需实验。
4. 当 user 删对话 / 清空微信记录 → 我们的 memory 要不要跟着清？策略题，暂保留（用户可通过 web UI 手删）。

---

## 依赖

- **v1.2 Task 3** MCP 拆包（companion 工具独立 server）— 必须先做
- **v1.2 Task 4** session 持久化（memory 写入需要跨重启）— 模式可复用
