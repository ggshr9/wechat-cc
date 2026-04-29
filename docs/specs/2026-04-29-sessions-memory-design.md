# 会话 / 记忆 设计 · v2.1 dashboard

**Status**: design · 2026-04-29
**Tracks**: RFC 02 §5（v2.1 UX & 分发）
**Supersedes**: 「会话 pane (placeholder · soon)」当前占位实现
**Owner**: ggshr9

---

## 1 · 立柱（Philosophy）

`wechat-cc` 同时承载两种不同 DNA 的产品形态：

- **小助手 (Assistant)**：开发者用，写代码 / 改 bug / 跨项目，要 transcripts 可搜索、plan 不丢、点子能复盘——**他们要的是一个知识库**。
- **陪伴 (Companion)**：任何人用，要角色感、记忆、回馈、Claude 怎么看自己——**他们要的是一段关系画像**。

这两种心智不能用一个 UI 调和。但它们也**不是两个产品**——陪你 debug 的 Claude 和深夜问你累不累的 Claude 是同一位。

### 1.1 三条不动的原则

1. **记忆 / 会话 是并列概念，不嵌套**——左 nav 一直保留两个独立项。它们回答**不同问题**，强行合并会让两边都失望。
2. **两个 pane 都装着陪伴**——是两面镜子（Claude 的视角 vs 共同的记录），不是两个模式。用户不选 cohort，选当下要回答哪种问题。
3. **动态观察是 Claude 给你的礼物，不是推送**——核心机制是「打开记忆才发现的小惊喜」。绝不弹窗 push，等用户主动来取。这是与 Pi/Replika 那种「主动找你」最大的差异。

### 1.2 双面镜子

| | **记忆** | **会话** |
|---|---|---|
| 性质 | 主观、curated、有损 | 客观、append-only、无损 |
| 视角 | Claude 看你 | 你和 Claude 看自己 |
| 时间方向 | 朝向未来（指导以后行为） | 朝向过去（历史记录） |
| 可编辑 | 是（用户能纠正 Claude 的误解） | 否（只能浏览、搜索、收藏、删除） |
| 一句话 | "Claude 认为我是谁" | "我们一起做过什么" |
| 主用户 | Companion 一面（但 Assistant 也用） | Assistant 一面（但 Companion 也偶尔用） |

诚实声明：会话是**事实诚实**（不能改），记忆是**评论诚实**（Claude 必须坦白怎么想，但你能纠正）。

### 1.3 交互原则（design language）

延续项目现有视觉方向（clean-light、单一深绿点缀、1px hairline），本 feature 承诺：

1. **克制 over 热情**——观察 / 决策默认呈现，不用红点 / "新" 标 / 角标计数器吸引注意。Surprise 来自内容本身，不来自 UI 噪音。
2. **留白不密集**——每个 section 都呼吸。内容块内边距 14–22px 起。
3. **Typography 有层次**——主体 13px regular；元数据 11.5px light；LLM 摘要 italic gray。永不同时叠加 bold + 大写 + 彩色。
4. **微动而非动画**——enter / exit 用 12–15px translation + 180ms ease-out。没有 bounce，没有花哨过渡。
5. **空状态有叙事**——"Claude 还没注意到什么——这是它的安静日子"，**不是**"暂无数据"。
6. **时间不前置**——timestamp 永远在 hover / tooltip 里，不跟内容争视觉权重。
7. **可读 over 可点**——信息式 row 优于按钮式 row。Click affordance 用 subtle hover lift（背景轻变），不用色阶变化。
8. **绝不弹窗**——整个 feature 不出现 modal。drill-down 用 in-place transition（jsonl 详情从右侧滑入覆盖项目列表）。
9. **emoji 节制使用**——✨ 🎉 🤔 💬 仅用于决策日志的事件类型 hint，每条最多一个；档案区不用 emoji。
10. **微信原话引号化**——观察文本若引用用户原话，用「」包裹，跟 Claude 自己的判断区分开。

---

## 2 · 记忆 pane（Companion 主场，扩展现状）

```
┌───────────────────────────────────────────────┐
│  ✨ Claude 最近的观察                          │
│   · 「你这周提了 12 次 compass，上周才 4 次…」 │
│   · 「你说过想学吉他，最近还在弹吗？」          │
│   · 🎉 我们聊了第 100 条 — 2026-04-12         │
│  ─────────────────────────────────────────     │
│  📄 静态档案                                   │
│   · profile.md  (可编辑)                       │
│   · preferences.md                             │
│   · _handoff.md (跨项目 pointer)               │
│   · ... (用户/Claude 写的其他 markdown)        │
│  ─────────────────────────────────────────     │
│  🤔 Claude 的最近决策             [▾ 展开]     │ ← 默认折叠
│   (push / skip / observation 时间轴)           │
└───────────────────────────────────────────────┘
```

### 2.1 顶部 · 动态观察区（新加）

Claude 主动写下的"近期观察"和"里程碑卡片"。

- **默认显示** 最近 3 条观察 + 0–2 张活跃里程碑卡片，多余折叠"查看全部"
- **TTL** 观察 30 天后自动归档（移到 `observations/archive.jsonl`，不删，不再首屏）；里程碑永久保留
- **时间戳** 写在 hover tooltip 里，不强出现——避免"监控感"
- **用户可"忽略"任一条**：打 `archived: true`，不真删——避免破坏 Claude 的事实基础。Claude 下次写观察时能读到 archive，不会重复说同一件事。

#### 观察的语气（基调）

**克制**，像老朋友的随手观察，不像监控报告：

- ✅ 「我注意到你最近 3 次都在 23:30 后才发消息——会不会让你休息一下？」
- ✅ 「你说过想学吉他，最近还在弹吗？也许我看错了。」
- ❌ 「检测到用户连续 3 晚熬夜，建议干预。」
- ❌ 「用户上次提到吉他是 2026-04-15 22:14:32。」

每条尽量带"也许我看错了 / 你回我一下"那种留白。差一字味就变了。

#### 里程碑清单（v1）

- 我们聊了第 **100** / **1000** 条
- 首次成功 push 后用户回复
- 首次跨项目 handoff（`_handoff.md` 写入）
- 连续 7 天交互
- 用户生日（仅当 memory 里有记录）
- 一起跨年（12-31 → 01-01）

将来可加：首次让 Claude 写代码 / 首次让 Claude 推送 / 第一次 reject 了 push 等。**所有里程碑只用现成数据触发，不依赖外部信号**。

### 2.2 中部 · 静态档案区（保留现状）

`memory/<chat_id>/*.md` 文件浏览器 + inline 编辑。维持当前实现。

### 2.3 底部 · Claude 的最近决策（折叠区）

events.jsonl 倒序渲染，给好奇用户翻。绝大多数用户不展开。

```
🤔 06:30 · 决定不打扰
   触发：daily-checkin · 理由：「user 在 focus 中，最近 30 min 在改代码」

✨ 09:42 · 写下新观察「你这周提了 12 次 compass…」
   触发：weekly-introspect · 上次内省：6 天前

💬 08:15 · 主动找你「今天提了 2 次 deadline，要不要先吃饭？」
   触发：urgent-care · 已读 ✓ · 用户 5 分钟后回复
```

每条可点开看完整 reasoning。

### 2.4 数据模型

新增两个文件，per chat：

```text
~/.claude/channels/wechat/memory/<chat_id>/
├── profile.md          ← 现有
├── preferences.md      ← 现有
├── observations.jsonl  ← 新加 · 动态观察
├── milestones.jsonl    ← 新加 · 里程碑
└── archive/            ← 新加 · 过期观察归档
    └── observations.jsonl
```

`observations.jsonl` schema:
```jsonl
{"id":"obs_abc123","ts":"2026-04-29T09:42:00Z","body":"你这周提了 12 次 compass…","tone":"concern","archived":false,"event_id":"evt_xyz"}
```

`milestones.jsonl` schema:
```jsonl
{"id":"ms_100msg","ts":"2026-04-12T22:30:00Z","kind":"100_messages","body":"我们聊了第 100 条","event_id":"evt_..."}
```

字段说明：
- `tone`: 可选枚举 `concern | curious | proud | playful | quiet`，UI 上仅作 emoji/颜色 hint，不强制
- `event_id`: 反向指向写入此条的事件（在 events.jsonl 里），便于"这是 Claude 什么时候、为什么写下的"溯源
- `archived`: 用户"忽略"后置 true，FE 不再首屏显示

---

## 3 · 会话 pane（Assistant 主场，重塑）

```
┌───────────────────────────────────────────────┐
│  [🔍 跨所有 session 搜索 "ilink"...]            │
│  ─────────────────────────────────────────     │
│  Filter: [全部] [收藏] [本周]                  │
│  ─────────────────────────────────────────     │
│  [今天]                                        │
│   ⭐ compass    · 12 turns · 修了 ilink-glue  │
│      sidecar    · 4 turns  · 讨论了 onboarding │
│  [7 天内]                                      │
│      _default   · 8 turns  · ...               │
│  [更早]                                        │
│      crosscast  · 2 turns  · ...               │
└───────────────────────────────────────────────┘
```

### 3.1 项目卡片（v1 必做）

每张卡片显示：
- `alias`（左对齐）
- `turn 数 · last_used_at 相对时间`（中部 metadata）
- **1 行 LLM 摘要**（右对齐，斜体灰）——后台流程定期读 jsonl 末尾 N 条 turn，请 Claude 用一句话总结，缓存在 `sessions.json` 的 `summary` 字段，TTL 较长

时间分组：今天 / 7 天内 / 之前。如果项目数 < 5，跳过分组直接列。

### 3.2 跨 session 全文搜索（v1 必做）

顶部搜索框，对所有 jsonl 做朴素 grep（先不引索引引擎，等量大再加 SQLite FTS）。结果跳到匹配那条 turn 的高亮位置。

### 3.3 Drill-down · 全屏 jsonl 视图（v1 必做）

点项目卡片 → 进入全屏会话回看：
- 顶部一行可复制 metadata：`alias · cwd · session_id · last_used_at`
- 主体：jsonl 渲染成消息流，user / assistant / tool_use / tool_result 区分样式
- 操作：**收藏**、**导出 markdown**、**删除**（删 sessions.json 条目 + 移走 jsonl，不真删源文件，移到 archive/）

### 3.4 「未完成的点子提取」（future · v0.5+）

LLM 后处理 jsonl，提取"提过但没结论"的内容，悬挂在 project 卡片下作为"未完成"标签。需要新的后处理 pipeline，本期不做，**spec 标 future**。

### 3.5 严格不做的事（基调）

- ❌ 在会话 pane 显示 cron 决策、observations
- ❌ 把 push 事件作为独立 row 单独列（它们已经是 jsonl 里的 turn）
- ❌ 加感性 / 关系类内容（你的人格、Claude 怎么看你）——Assistant 用户来这儿是干活的

---

## 4 · Cron 事件的归属（boundary 问题精确解）

按"留下的痕迹"分配，每个事件类型有清晰唯一去处：

| 事件 | 留下的痕迹 | 出现在哪儿 |
|---|---|---|
| Cron eval → push 了 | 一条对话 turn 写进 jsonl | 会话 pane 该 project 的 transcript（天然） |
| Cron eval → push 的 reasoning | events.jsonl 一行 | 记忆 pane 底部"Claude 的最近决策" |
| Cron eval → skip 了 | 仅 reasoning | 记忆 pane 底部 |
| Cron eval → 写下 observation | observations.jsonl + events.jsonl | 记忆 pane 顶部（内容）+ 底部（写入事件） |
| Milestone 触发 | milestones.jsonl + events.jsonl | 记忆 pane 顶部（卡片）+ 底部（事件） |

**不变量**：
- 凡是用户能感知到的（push 进了微信）→ 在会话 jsonl 里能复看
- 凡是 Claude 内省的（skip / observation / milestone reasoning）→ 在记忆 pane 里能溯源
- 没有事件需要双重展示

---

## 5 · 基础设施（infrastructure）

### 5.1 events.jsonl（新加，per chat）

```text
~/.claude/channels/wechat/memory/<chat_id>/events.jsonl
```

Append-only。schema:

```jsonl
{"id":"evt_001","ts":"2026-04-29T08:15:00Z","kind":"cron_eval_pushed","trigger":"daily-checkin","reasoning":"…","push_text":"今天提了 2 次 deadline…","jsonl_session_id":"a349…"}
{"id":"evt_002","ts":"2026-04-29T06:30:00Z","kind":"cron_eval_skipped","trigger":"hourly-watch","reasoning":"user 在 focus 中…"}
{"id":"evt_003","ts":"2026-04-29T09:42:00Z","kind":"observation_written","trigger":"weekly-introspect","observation_id":"obs_abc123","reasoning":"…"}
{"id":"evt_004","ts":"2026-04-12T22:30:00Z","kind":"milestone","milestone_id":"ms_100msg","reasoning":"jsonl line count crossed 100"}
```

`kind` 枚举：
- `cron_eval_pushed` / `cron_eval_skipped`
- `observation_written`
- `milestone`

### 5.2 内省 cron trigger（新一类）

现有 Companion cron 是"评估外向 push"。新增"评估内省"：

- **频率**: 24h ± 30% jitter（比 push 那条 cron 慢一档）
- **prompt**: 让 Claude 回顾近期消息 + 当前 memory + 最近 N 条已有 observations + 最近 push history，决定要不要写新观察、写什么
- **输出**: 写到 `observations.jsonl`，同时在 `events.jsonl` 留 `observation_written` 事件
- **关键**: 不 push 给用户——是"打开记忆才发现的小惊喜"

### 5.3 里程碑探测器（新加）

daemon 启动 + 每条入站消息后，检查触发条件：
- `turn_count == 100 / 1000`（统计 jsonl 行数）
- `first_push_replied`（用户首次回复主动 push，看 events.jsonl 历史）
- `first_cross_project_handoff`（首次写 `_handoff.md`）
- `7_day_streak`（连续 7 天有交互）
- `birthday`（用户在 profile.md 里写了 `birthday:` 字段）
- `new_year`（12-31 → 01-01）

触发后写入 `milestones.jsonl` + `events.jsonl`。每种里程碑只触发一次（用 `id` 去重）。

### 5.4 默认 nav 顺序

调整：

```
概览 / 会话 / 记忆 / 日志
```

理由：会话比记忆更日常（Assistant 用户开机第一眼），记忆是 Companion 用户的归宿但不是高频项。**默认 active pane 仍是概览**。

---

## 6 · 实施分期

### v0.4 · 本期（必做）

1. events.jsonl + observations.jsonl + milestones.jsonl 文件持久化基础设施
2. 内省 cron trigger
3. 里程碑探测器
4. 记忆 pane 顶部"动态观察"区（含 archive/ignore）
5. 记忆 pane 底部"决策日志"折叠区
6. 会话 pane 项目列表 + 时间分组 + 1 行 LLM 摘要
7. 会话 pane drill-down 全屏 jsonl 渲染
8. 会话 pane 收藏 / 导出 markdown / 删除（移到 archive）
9. 跨 session 全文搜索（朴素 grep）
10. nav 顺序调整

### v0.5+ · future

- 未完成点子提取（LLM pipeline）
- jsonl 量大时的 SQLite FTS 索引
- 多 chat 切换（当前默认绑定到主 chat）
- 记忆动态观察的"重新激活"机制（archive 后想看回来）

---

## 7 · 风险与兜底

| 风险 | 概率 | 兜底 |
|---|---|---|
| Claude 写出"创飞"的观察（错误推断、冒犯）| 中 | 用户可一键 archive；observations 写入前可先在 daemon 侧做关键词 / tone 自检 |
| 内省 cron 资源消耗（每天一次 SDK eval）| 低 | jitter + 跳过空 chat（30 天无消息）+ 失败不影响主链路 |
| jsonl 性能（个别项目 turn 数 >1000）| 低 | drill-down 时分页加载（首屏 100 条）；搜索时 streaming match |
| 用户对"决策日志"的隐私不安（Claude 在审视我）| 低-中 | 默认折叠 + 文案"Claude 的内心 OS"调侃化 + 可关闭整个 cron 内省 |
| LLM 摘要错误 / 过期 | 低 | 用户可手动刷新单个 project 的摘要；TTL 7 天自动重生成 |

---

## 8 · 开放问题（implementation 阶段决）

1. observations 写入前是否要 daemon 侧 tone 自检？倾向**否**（Claude 自律够，加规则反而僵化）。
2. LLM 摘要是用同一个 SDK session 还是单独 isolated eval？倾向 isolated（不污染主 session）。
3. 跨 session 搜索的 highlight 在前端还是 daemon 返回？倾向 daemon 返回（避免前端再读 jsonl 两遍）。
4. 用户 archive 一条观察后，多久才能再次出现同主题？倾向 90 天 cooldown，daemon 在内省 prompt 里把 archived 项喂进去。

---

## 9 · 验收

- 用户首次打开 wechat-cc，concept 能 30s 内自解释（"两面镜子"）
- 一周使用后，记忆 pane 至少有 3 条非用户写的观察 / 1 张里程碑
- Assistant 用户能用搜索框找回 30 天前的某次讨论
- Companion 用户能找到"Claude 上次为什么找我"
- 没有用户报告"我看到我自己的对话被两次列出"或类似 boundary bug

---

## 10 · 修订历史

| 日期 | 变更 |
|---|---|
| 2026-04-29 | 初稿。Forms 1–15 的 brainstorm 收敛到当前形态：两面镜子、记忆双区、会话 Assistant 化、cron 事件按"留下痕迹"分配。 |
