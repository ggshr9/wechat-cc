# RFC 04 · Inbound Pipeline + Lifecycle + Capability Matrix

**Status**: Accepted · 2026-05-03
**Phase**: 内部重构（无用户可见 feature 变化）
**Spec**: [`docs/specs/2026-05-03-inbound-pipeline-architecture.md`](../specs/2026-05-03-inbound-pipeline-architecture.md)
**Related**: 完成 [RFC 01 §L0](./01-architecture.md) Runtime Layer 的最后一块；不影响 [RFC 03](./03-multi-agent-architecture.md) 的多 agent 形态

---

## TL;DR

`src/daemon/main.ts` 涨到 627 行已经变成"上帝模块"，混合 lifecycle ceremony / inbound dispatch chain / fire-and-forget 副作用。同期 RFC 03 引入 mode×provider×permissionMode 16 个组合后，语义散在 4 处文件，没有单一来源。

本 RFC 决定**一次性骨骼重构**，三件事一起做：

1. **Inbound Pipeline**（koa 风格洋葱，13 个中间件）
2. **Lifecycle 子系统拆分**（每个 feature 自带 `lifecycle.ts`，`Lifecycle` 接口契约）
3. **Capability Matrix**（16 行常量 + load-time 完整性断言 + 4 个集成点）

骨骼一次性立起来，肉可以慢慢长 —— 接受短期较大 PR 换长期可拓展性。

---

## 1. 起因

### 1.1 main.ts 现状（v0.4.5）

627 行，承担：
- bootstrap 编排（实际 50 行）
- companion push scheduler 注册
- companion introspect scheduler 注册（含 `runIntrospectOnce` 闭包 ~40 行）
- guard scheduler 注册
- onboarding handler 装配
- admin commands 装配
- mode commands 装配
- pollHandle 组装 + onInbound 闭包（~60 行 if-return 链）
- 8 个 mw 等价的串行调用（admin / mode / onboarding / permission / guard / attachments / coordinator / 3 个 fire-and-forget）
- 3 个 fire-and-forget 的内联 helper（`maybeWriteWelcomeObservation` / `recordActivity` / `fireMilestonesFor`）
- shutdown 链（手写 7 步顺序）
- SIGUSR1 reconcile
- startup notification
- inbox cleanup
- 其他启动 sweeps

### 1.2 真问题

**不是文件长**，是**职责混合**：
- 改 inbound 链顺序要动 main.ts
- 加新 scheduler 要动 main.ts
- 改 shutdown 顺序要动 main.ts
- 任何 mw 内部 bug fix 都得在 main.ts 找

而 main.ts **没有任何单测覆盖**（vitest cov 黑洞）。每改一行，唯一的保护网是手动 `bun test` 跑全套。

### 1.3 RFC 03 引入的隐式矩阵

README §"Permission modes" 第 383-401 行那张表（16 个组合 × askUser / replyPrefix / approvalPolicy / delegate）目前是**纯文档**。运行时这套语义：
- coordinator dispatch switch 的 mode 路由
- permission-relay makeCanUseTool 总走 askUser
- bootstrap 装配 codex 时硬编码 `approvalPolicy: 'never'`
- internal-api routes 的 maybePrefix 硬编码 `if (mode==='parallel'||'chatroom')`

四处真相，README 是第五份。加第三个 provider（Cursor / Gemini）要四处改 + 同步 README。漂移迟早发生。

---

## 2. 候选 + 撤回

最初提出 5 项候选：
1. main.ts 拆分
2. inbound pipeline 抽象
3. SQLite migration → drizzle / kysely
4. capability matrix
5. 结构化日志 → pino

### 2.1 撤回 #3（drizzle / kysely）

**论证**：
- 现 `migrations[]` 数组 + `PRAGMA user_version` 是 bulletproof append-only，每次 schema 变化强制人眼审 SQL
- drizzle 的 auto-gen migration 在 append-only schema 上反而是 anti-pattern（不想要工具帮你猜 ALTER TABLE）
- drizzle 唯一真价值是 type-safe query —— 但 7 个 store 全是 `SELECT * WHERE pk = ?` 级别，无 JOIN 无复杂谓词

**结论**：维持现状。如果想要 type 安全，写 50 行 `db.queryTyped<T>(sql, params)` helper 即可。

### 2.2 撤回 #5（pino）

**论证**：
- 当前 `log(tag, line, fields?)` 第三参数 `fields` 已经是结构化字段，已经写 JSONL sidecar
- pino interface 上不会更好；只是一次 runtime 替换
- 真 gap 是"没 metric primitive + 没 ship 出去"，但都没有具体下游消费者前**先不要做**（YAGNI）

**结论**：维持 `log()` 不动。未来若要 ship，加 transport 接口几十行。

### 2.3 保留 + 重定义 #1+#2+#4

按用户的"骨骼一次性建好、肉慢慢长"标准：
- #1 不只是"拆 main.ts"，是 **lifecycle ceremony 与 inbound dispatch 物理分离**
- #2 (pipeline) 与 #1 合并，由 koa 风格中间件 + 工厂闭包模式承载
- #4 升级为"runtime 单一来源 + load-time 完整性断言"，不止做测试 fixture

---

## 3. 决策矩阵

| 决策 | 选项 | 决定 | 理由 |
|---|---|---|---|
| Pipeline 形态 | (a) Express 链式 / (b) Koa 洋葱 / (c) 显式 Decision | **b** | wrap 语义自然容纳 fire-and-forget 副作用；现状 (a) 表达不了 |
| Lifecycle 编排 | (a) 单 lifecycle.ts / (b) 每子系统自带 / (c) LifecycleRegistry | **b** | 与现有 `bootstrap/` 拆分习惯一致；cohesion 高 |
| 副作用放法 | (a) 单 mwAfterDispatch / (b) 各自独立 mw / (c) coordinator hook | **b** | 加新副作用不动老文件；测试粒度对齐业务原子 |
| PR 节奏 | (a) 单大 PR / (b) 5 PR 分阶段 / (c) 并行 worktree | **a** | 用户决定：分阶段 PR 让骨架被局部需求定型，骨骼一次性立起来 |
| Capability Matrix | (a) 测试 fixture only / (b) runtime + 测试 / (c) +dashboard | **b** | "骨骼明确"标准下，运行时单一来源比"少一个模块"更重要 |
| 短路标记 | string / union | **union** | 加新短路点强制审；类型安全 |
| compose 实现 | 自写 / koa-compose 包 | **自写 30 行** | 零依赖、行为透明、纯 TS |
| forbidden 字段 | sentinel string / boolean | **boolean** | 显式、可 type-narrow |
| stop 顺序 | 并发 allSettled / 严格 LIFO | **严格 LIFO** | polling 必须先停才能停 ilink；并发会撞依赖 |
| stop 超时 | 无 / 5s per-handle | **5s** | 卡死的子系统不能拖死 daemon |
| 二次信号 | 等 / force exit | **force exit (130)** | Ctrl-C 二次按下应当立即生效 |

---

## 4. 与 RFC 01 / 03 的关系

### 4.1 完成 RFC 01 §L0 的最后一块

RFC 01 提出 L0-L5 五层，但 L0 (Runtime) 的"daemon 编排"一直停留在 main.ts 单文件状态。本 RFC 把 L0 拆成：
- main.ts（编排入口）
- LifecycleSet（生命周期协调器）
- 各子系统 lifecycle.ts（自管自）

不动 L1（Session Pool）/ L2（Integration）/ L3（Feature）/ L4（Companion）/ L5（UX）的接口契约。

### 4.2 巩固 RFC 03 的多 agent 形态

RFC 03 引入了 mode × provider 矩阵但没有 enforce 机制。本 RFC 的 capability-matrix 把 RFC 03 §3 的"哪种 mode 在哪种 provider 下做什么"从 README 文档升级为运行时单一来源。

将来 RFC 03 §10 提到的"加第三个 provider"，本 RFC 提供的 enforce 路径（扩 union → assertMatrixComplete 报缺行 → 强制填表）使其成为局部操作。

### 4.3 不影响 PR4（citty CLI）/ PR5（depcruise）/ PR7（SQLite）

- citty 在 cli/ 目录，本 RFC 不动 cli/
- depcruise 现有规则保留，本 RFC 增 2 条
- SQLite migrations[] 不动，本 RFC 不动 store

---

## 5. 接受的代价

### 5.1 单 PR 体量大
~48 新文件（26 实现 + 22 测试）+ 10 修改文件 + ~2500 LOC 净增 + ~100 新测试用例。Review 难度 ↑。

**缓解**：
- spec 完整描述每个文件的契约，review 可参照 spec 而非纯 diff
- 行为等价是硬约束，~700 既有测试是回归保护网
- pipeline / lifecycle / matrix 三块在物理上隔离（不同目录），可分块 review

### 5.2 main-wiring.ts 是新的"胶水文件"
~150 LOC，集中所有 deps 装配工厂。spec 明确边界："只组装 deps，不持有业务状态"。但人为约束仍可能膨胀。

**缓解**：未来 `main-wiring.ts` 涨到 300+ LOC 时按子系统再拆（`wiring-companion.ts` 等）。本次不预拆。

### 5.3 koa 嵌套 wrap 的认知成本
新人第一次读 `await next(); doSideEffect()` 容易迷路。

**缓解**：spec §4.3 / §4.4 / §4.7 + RFC 04 §3 都有解释；mw 文件每个 ≤30 LOC，单读单测都 OK。

---

## 6. 显式不做（避免 scope 蔓延）

- ❌ 不替换 SQLite 层（drizzle / kysely）
- ❌ 不替换日志层（pino / OTLP）
- ❌ 不重写 ilink / store / mcp-servers / cli
- ❌ 不实现 dashboard 渲染 capability matrix
- ❌ 不动 RFC 03 多 agent 的 mode 形态本身
- ❌ 不引入 koa / hono / h3 框架（自写 30 行 compose）
- ❌ 不引入 LifecycleRegistry 通用注册（杀鸡用牛刀）
- ❌ 不动 main.ts 之外文件的现有公共接口（行为等价硬约束）

---

## 7. 验收准则

PR 合并条件：
1. `bun --bun vitest run` 全绿（既有 ~700 + 新增 ~100 ≈ 800 测试）
2. `bun x tsc --noEmit` 无错
3. `bun run depcheck` 无新违例（含本 RFC 加的 2 条新规则）
4. `apps/desktop/shim.e2e.test.ts` daemon 启停 e2e 通过
5. main.ts ≤ 100 LOC（hard cap，超出要么再拆 wiring，要么写理由）
6. 手动 smoke：strict + dangerously 模式各发 1 条普通消息 / 1 条 admin 命令 / 1 条 /cc 切换 → 行为与 v0.4.5 一致

---

## 8. 修订历史

| 日期 | 变更 |
|---|---|
| 2026-05-03 | 初版定稿。撤回 drizzle / pino 候选；接受 koa pipeline + 严格 LIFO + capability matrix 三件套 |
