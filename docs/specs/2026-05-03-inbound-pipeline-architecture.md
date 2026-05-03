# Spec · Inbound Pipeline + Lifecycle Refactor + Capability Matrix

**Status**: Draft · 2026-05-03
**Scope**: 单 PR cutover，骨骼一次性建好
**RFC**: [`docs/rfc/04-inbound-pipeline-and-capability-matrix.md`](../rfc/04-inbound-pipeline-and-capability-matrix.md)
**Plan**: `docs/plans/2026-05-03-pipeline-cutover.md`（writing-plans skill 产出）

---

## TL;DR

`src/daemon/main.ts` 当前 627 行，把 daemon lifecycle / inbound dispatch 链 / fire-and-forget 副作用混在一处。同时 `mode × provider × permissionMode` 的 16 个组合的语义散在 coordinator / permission-relay / codex provider / internal-api 四处，无单一来源。

本 spec 定义一次性骨骼重构：

1. **Inbound Pipeline**（koa 风格洋葱）—— `src/daemon/inbound/` 新目录，13 个中间件 + compose + InboundCtx 类型
2. **Lifecycle 子系统**（每个 feature 自带 `lifecycle.ts`）—— `Lifecycle` 接口 + `LifecycleSet` 严格顺序停止
3. **Capability Matrix**（单一真相）—— `src/core/capability-matrix.ts` 16 行常量 + load-time 完整性断言 + 4 个集成点

main.ts 缩到 ~80 行，只做 lock / accounts / db / lc / signals。

---

## 1. 目标 + 非目标

### 目标（必须）
- main.ts ≤ 100 LOC
- inbound 链路每一步独立可测，加新 mw / 新 lifecycle / 新 mode 是局部操作
- mode×provider×permissionMode 的 16 个组合在一处声明，TS 编译器强制完整性
- 现有 ~700 个测试**全部继续通过**（行为等价是硬约束）
- shutdown 顺序在类型层有契约（不是注释）

### 非目标（明确不做）
- 不引入第三方 pipeline 框架（koa / hono / h3）—— 自写 30 行 compose
- 不替换日志层（pino / OTLP）—— `log(tag, line, fields?)` 接口已足够
- 不替换 SQLite 层（drizzle / kysely）—— 当前 PRAGMA user_version + migrations[] 已足够
- 不重写 ilink / store / mcp-servers / cli —— 只动 daemon 编排
- 不实现 dashboard 渲染 capability matrix —— 接口预留，v1.0 不实现

---

## 2. 三层架构

```
┌──────────────────────────────────────────────────────────────────┐
│  main.ts  (~80 LOC)                                               │
│    1. acquire instance lock                                       │
│    2. load accounts / open db / build ilink                       │
│    3. for each subsystem: const handle = register*(deps);         │
│                            lc.register(handle)                    │
│    4. install signal handlers (SIGINT/SIGTERM/SIGUSR1)            │
│    5. runStartupSweeps(deps)  // fire-and-forget                  │
└────────────────────────────┬─────────────────────────────────────┘
                             │ wires
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  Lifecycle Layer  (per-subsystem `register*` returning Lifecycle) │
│                                                                   │
│   internal-api/lifecycle.ts   registerInternalApi(deps)           │
│   companion/lifecycle.ts      registerCompanionPush(deps)         │
│                               registerCompanionIntrospect(deps)   │
│   guard/lifecycle.ts          registerGuard(deps)                 │
│   sessions-lifecycle.ts       registerSessions(deps)              │
│   ilink-lifecycle.ts          registerIlink(deps)                 │
│   polling-lifecycle.ts        registerPolling(deps, runPipeline)  │
└────────────────────────────┬─────────────────────────────────────┘
                             │ polling subsystem feeds inbound msgs into ↓
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  Inbound Pipeline  (koa-style onion, src/daemon/inbound/)         │
│                                                                   │
│    pipeline = compose([                                           │
│      mwTrace, mwCaptureCtx, mwTyping,                             │
│      mwAdmin, mwMode, mwOnboarding, mwPermissionReply, mwGuard,   │
│      mwAttachments,                                               │
│      mwActivity, mwMilestone, mwWelcome,                          │
│      mwDispatch,                                                  │
│    ])                                                             │
└────────────────────────────┬─────────────────────────────────────┘
                             │ dispatch 入口先 assert
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  Capability Matrix  (src/core/capability-matrix.ts)               │
│                                                                   │
│   16 行 (mode × provider × permissionMode) 常量 + lookup +        │
│   assertSupported + assertMatrixComplete (load-time)              │
│                                                                   │
│   消费者：coordinator / permission-relay / codex provider /        │
│           internal-api routes / 测试 fixture                      │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. Lifecycle 契约

### 3.1 类型

```ts
// src/lib/lifecycle.ts

/**
 * Standard shape every register*(deps) function returns.
 * stop MUST be idempotent — main.ts shutdown may call it multiple times
 * if a SIGTERM lands during graceful SIGINT handling.
 */
export interface Lifecycle {
  readonly name: string
  stop(): Promise<void>
}

export class LifecycleSet {
  constructor(private readonly log: (tag: string, line: string) => void) {}
  private readonly handles: Lifecycle[] = []

  register(handle: Lifecycle): void { this.handles.push(handle) }

  /**
   * STRICT REVERSE-REGISTRATION ORDER (LIFO). Sequential, not concurrent.
   * Per-handle 5s timeout. One failure does NOT abort subsequent stops.
   * Throws LifecycleStopError after all handles attempted, if any failed.
   */
  async stopAll(): Promise<void> {
    const ordered = [...this.handles].reverse()
    const failures: Array<{ name: string; err: unknown }> = []
    for (const h of ordered) {
      const t0 = Date.now()
      try {
        await Promise.race([
          h.stop(),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error('stop timeout (5000ms)')), 5000),
          ),
        ])
        this.log('LIFECYCLE', `stopped ${h.name} (${Date.now() - t0}ms)`)
      } catch (err) {
        this.log('LIFECYCLE', `stop ${h.name} failed (${Date.now() - t0}ms): ${
          err instanceof Error ? err.message : err
        }`)
        failures.push({ name: h.name, err })
      }
    }
    if (failures.length > 0) {
      throw new LifecycleStopError(failures.length, this.handles.length, failures)
    }
  }
}

export class LifecycleStopError extends Error {
  constructor(
    public readonly failed: number,
    public readonly total: number,
    public readonly details: Array<{ name: string; err: unknown }>,
  ) {
    super(`${failed}/${total} lifecycle handles failed to stop cleanly`)
    this.name = 'LifecycleStopError'
  }
}
```

### 3.2 注册顺序 = LIFO 停止顺序

| 注册序 | 子系统 | 停止序 |
|---|---|---|
| 1 | internal-api | 7（最后停 — in-flight MCP 调用需要 HTTP 还活着）|
| 2 | companion-push | 6 |
| 3 | companion-introspect | 5 |
| 4 | guard | 4 |
| 5 | sessions | 3 |
| 6 | ilink | 2 |
| 7 | polling | 1（最先停 — 切断新入站源头）|

**bootstrap 不算 lifecycle**（同步组装，无 stop 概念）。**db 不算 lifecycle**（main.ts 在 stopAll 完成后显式 close）。

### 3.3 子系统契约（硬约束）

> **Lifecycle 内部不能反向调下游。**
>
> stop() 时下游已经停了。例如：sessions.stop 不能 await ilink 的 reply 投递（ilink 已停）。最后几条 reply 要么放弃 + 写日志，要么在 stop 前主动 await。

### 3.4 子系统 lifecycle 文件分布

| 子系统 | 文件 | 依赖来源 |
|---|---|---|
| internal-api | `daemon/internal-api/lifecycle.ts` | 包薄当前 `index.ts` 的 start/stop |
| companion-push | `daemon/companion/lifecycle.ts` | 包 `companion/scheduler.ts` |
| companion-introspect | 同上文件，第二个 export | 同上 + introspect-runtime |
| guard | `daemon/guard/lifecycle.ts` | 包 `guard/scheduler.ts` |
| polling | `daemon/polling-lifecycle.ts` | 包 `daemon/poll-loop.ts`；额外 export `reconcile()` 给 SIGUSR1 |
| sessions | `daemon/sessions-lifecycle.ts` | sessionManager.shutdown + sessionStore.flush + conversationStore.flush |
| ilink | `daemon/ilink-lifecycle.ts` | 包 `ilink-glue.ts` 的 `flush()` |

底层 `scheduler.ts` / `poll-loop.ts` / `ilink-glue.ts` 等 **不动**。

### 3.5 子系统 register* 签名分类

绝大多数 `register*(deps)` 是**同步**的，返回 `Lifecycle` 或其子接口：

```ts
export function registerCompanionPush(deps: ...): Lifecycle
export function registerGuard(deps: ...): Lifecycle
export function registerSessions(deps: ...): Lifecycle
export function registerIlink(deps: ...): Lifecycle

// polling 加 extra reconcile() 给 SIGUSR1
export interface PollingLifecycle extends Lifecycle {
  reconcile(): Promise<void>
}
export function registerPolling(deps: ...): PollingLifecycle
```

**唯一例外**：`registerInternalApi` 是 `async`，因为 HTTP server 必须 bind 完才知道实际 port，bootstrap 后续要拿 baseUrl：

```ts
export interface InternalApiLifecycle extends Lifecycle {
  readonly baseUrl: string
  readonly tokenFilePath: string
  setDelegate(d: InternalApiDelegateDep): void
}
export async function registerInternalApi(deps: ...): Promise<InternalApiLifecycle>
```

main.ts 的 await：
```ts
const internalApi = await registerInternalApi({ stateDir, ilink, db, log })
lc.register(internalApi)
// internalApi.baseUrl / .tokenFilePath / .setDelegate available now
```

`Lifecycle` 基础接口保最小；扩展能力靠子系统自带额外方法（PollingLifecycle.reconcile / InternalApiLifecycle.{baseUrl,tokenFilePath,setDelegate}）。

---

## 4. Inbound Pipeline 契约

### 4.1 类型

```ts
// src/daemon/inbound/types.ts

import type { InboundMsg } from '../../core/prompt-format'

export type ConsumedBy = 'admin' | 'mode' | 'onboarding' | 'permission-reply' | 'guard'

export interface InboundCtx {
  /** Parsed wechat inbound. Immutable across the pipeline. */
  readonly msg: InboundMsg
  /** Wallclock when daemon parsed it — used for timing + activity store. */
  readonly receivedAtMs: number
  /** Short hex (8 chars), for log correlation. */
  readonly requestId: string

  /**
   * Set by short-circuiting middleware. Soft contract — chain stops because
   * mw didn't call next(); this field is the breadcrumb for trace + W mw.
   */
  consumedBy?: ConsumedBy

  /** mwAttachments → mwDispatch hand-off. */
  attachmentsMaterialized?: boolean
}

export type Middleware = (ctx: InboundCtx, next: () => Promise<void>) => Promise<void>
export type PipelineRun = (ctx: InboundCtx) => Promise<void>
```

新增 short-circuit mw 必须先扩 `ConsumedBy` union → 编译器逼审"新短路点"。

### 4.2 compose 实现

```ts
// src/daemon/inbound/compose.ts
import type { Middleware, PipelineRun, InboundCtx } from './types'

export function compose(mws: ReadonlyArray<Middleware>): PipelineRun {
  return function run(ctx: InboundCtx): Promise<void> {
    let lastIndex = -1
    function dispatch(i: number): Promise<void> {
      if (i <= lastIndex) {
        return Promise.reject(new Error('next() called multiple times in same middleware'))
      }
      lastIndex = i
      const fn = mws[i]
      if (!fn) return Promise.resolve()
      try {
        return Promise.resolve(fn(ctx, () => dispatch(i + 1)))
      } catch (err) {
        return Promise.reject(err)
      }
    }
    return dispatch(0)
  }
}
```

### 4.3 13 个 mw 完整列表

| # | mw | 文件 | 类型 | 职责 | 短路条件 |
|---|---|---|---|---|---|
| 1 | mwTrace | `mw-trace.ts` | T | requestId + 起止 + 总耗时 + try/catch 兜底 | 否 |
| 2 | mwCaptureCtx | `mw-capture-ctx.ts` | T | markChatActive + captureContextToken | 否 |
| 3 | mwTyping | `mw-typing.ts` | T | `void ilink.sendTyping(...)` | 否 |
| 4 | mwAdmin | `mw-admin.ts` | S | /health, 清理 <bot> | handler 返回 true |
| 5 | mwMode | `mw-mode.ts` | S | /cc /codex /solo /mode /both /chat /stop | handler 返回 true |
| 6 | mwOnboarding | `mw-onboarding.ts` | S | 未知用户昵称抓取 | handler 返回 true |
| 7 | mwPermissionReply | `mw-permission-reply.ts` | S | y/n abc12 permission 答复 | handler 返回 true |
| 8 | mwGuard | `mw-guard.ts` | S | 网络探测红时拒绝并提示 | guardCfg.enabled && !reachable |
| 9 | mwAttachments | `mw-attachments.ts` | E | materializeAttachments → inbox/ | 否（设 attachmentsMaterialized=true）|
| 10 | mwActivity | `mw-activity.ts` | W | next() 后 recordInbound | consumedBy 已设 → 跳过 |
| 11 | mwMilestone | `mw-milestone.ts` | W | next() 后 fireMilestonesFor | consumedBy 已设 → 跳过 |
| 12 | mwWelcome | `mw-welcome.ts` | W | next() 后 maybeWriteWelcomeObservation | consumedBy 已设 → 跳过 |
| 13 | mwDispatch | `mw-dispatch.ts` | D | coordinator.dispatch(ctx.msg) | terminal — 不调 next |

类型：T=trace/setup、S=short-circuit、W=wrap (after-effect)、E=enrichment、D=dispatch terminal。

### 4.4 顺序设计 5 条规则

1. **Trace 永远最外**（mw#1）—— 任何抛出被 try/finally 兜底，日志不丢。
2. **Setup-no-side-effect 在前**（mw#2-3）—— markChatActive / captureContextToken / typing 必须无论后面短不短路都跑。
3. **短路 mw 集中段**（mw#4-8）—— 顺序 admin > mode > onboarding > permission-reply > guard。理由：
   - admin 第一：`/health` 哪怕没起昵称也要能用
   - mode 第二：切 mode 不需要昵称
   - onboarding 在 permission-reply 前：新用户的"y abc12"不该被歧义为答案
   - guard 末位：admin/mode/命令类不需要外网就能完成
4. **Enrichment 在 wrap 之前**（mw#9）—— 媒体必须在 coordinator 见到 msg 之前在 inbox/ 里就位。
5. **Wrap 在 dispatch 紧外层**（mw#10-12）—— 顺序 activity → milestone → welcome（业务无依赖，只是显式排序）。

### 4.5 mw 工厂模式（依赖闭包，不入 ctx）

```ts
// src/daemon/inbound/mw-admin.ts
import type { Middleware } from './types'
import { makeAdminCommands, type AdminCommandsDeps } from '../admin-commands'

export function makeMwAdmin(deps: AdminCommandsDeps): Middleware {
  const handler = makeAdminCommands(deps)
  return async (ctx, next) => {
    if (await handler.handle(ctx.msg)) {
      ctx.consumedBy = 'admin'
      return
    }
    await next()
  }
}
```

```ts
// src/daemon/inbound/mw-activity.ts (W mw 模板)
import type { Middleware } from './types'

export interface ActivityMwDeps {
  recordInbound(chatId: string, when: Date): Promise<void>
  log: (tag: string, line: string) => void
}

export function makeMwActivity(deps: ActivityMwDeps): Middleware {
  return async (ctx, next) => {
    await next()
    if (ctx.consumedBy) return  // 短路消费不计 activity
    const when = new Date(ctx.msg.createTimeMs ?? ctx.receivedAtMs)
    deps.recordInbound(ctx.msg.chatId, when).catch(err =>
      deps.log('ACTIVITY', `record failed for ${ctx.msg.chatId}: ${
        err instanceof Error ? err.message : err
      }`),
    )
  }
}
```

### 4.6 装配入口

```ts
// src/daemon/inbound/build.ts
export interface InboundPipelineDeps {
  trace: TraceMwDeps
  capture: CaptureCtxMwDeps
  typing: TypingMwDeps
  admin: AdminCommandsDeps
  mode: ModeMwDeps
  onboarding: OnboardingMwDeps
  permissionReply: PermissionReplyMwDeps
  guard: GuardMwDeps
  attachments: AttachmentsMwDeps
  activity: ActivityMwDeps
  milestone: MilestoneMwDeps
  welcome: WelcomeMwDeps
  dispatch: DispatchMwDeps
}

export function buildInboundPipeline(d: InboundPipelineDeps): PipelineRun {
  return compose([
    makeMwTrace(d.trace),
    makeMwCaptureCtx(d.capture),
    makeMwTyping(d.typing),
    makeMwAdmin(d.admin),
    makeMwMode(d.mode),
    makeMwOnboarding(d.onboarding),
    makeMwPermissionReply(d.permissionReply),
    makeMwGuard(d.guard),
    makeMwAttachments(d.attachments),
    makeMwActivity(d.activity),
    makeMwMilestone(d.milestone),
    makeMwWelcome(d.welcome),
    makeMwDispatch(d.dispatch),
  ])
}
```

### 4.7 mwTrace 异常兜底

```ts
async (ctx, next) => {
  const start = Date.now()
  try {
    await next()
  } catch (err) {
    log('INBOUND_ERROR', `req=${ctx.requestId} chat=${ctx.msg.chatId} threw: ${errMsg(err)}`, {
      event: 'inbound_uncaught',
      request_id: ctx.requestId,
      chat_id: ctx.msg.chatId,
      error: errMsg(err),
    })
    // 不 rethrow —— pipeline 不向 polling loop 冒泡
  } finally {
    log('INBOUND', `req=${ctx.requestId} chat=${ctx.msg.chatId} consumed=${ctx.consumedBy ?? 'dispatched'} ms=${Date.now() - start}`)
  }
}
```

`mwTrace` 不 rethrow 是契约：保 polling 永不挂。pipeline 里所有未预期异常**统一进 channel.log**，永不冒泡到 polling loop。

---

## 5. Capability Matrix

### 5.1 类型

```ts
// src/core/capability-matrix.ts

import type { Mode, ProviderId } from './conversation'

export type PermissionMode = 'strict' | 'dangerously'

export interface Capability {
  /** 'per-tool' = Claude canUseTool 回调；'never' = 无 per-tool 提示。 */
  askUser: 'per-tool' | 'never'

  /** 'always'=parallel/chatroom；'never'=solo；'on-fallback-only'=primary_tool */
  replyPrefix: 'always' | 'never' | 'on-fallback-only'

  /** Codex SDK approval_policy；non-codex 行为 null。 */
  approvalPolicy: 'untrusted' | 'on-request' | 'never' | null

  /** delegate_<peer> MCP tool 是否加载到本 provider session。 */
  delegate: 'loaded' | 'unloaded'

  /** 显式禁用标志。v1.0 全 false；将来按策略收紧。 */
  forbidden: boolean

  /** 错误消息 + 文档辅助。 */
  notes: string
}

export interface MatrixRow extends Capability {
  mode: Mode['kind']
  provider: ProviderId
  permissionMode: PermissionMode
}
```

### 5.2 16 行 MATRIX 数据

```ts
export const CAPABILITY_MATRIX: ReadonlyArray<MatrixRow> = [
  // ─── solo · claude ──────────────────────────────────────────────
  { mode: 'solo', provider: 'claude', permissionMode: 'strict',
    askUser: 'per-tool', replyPrefix: 'never', approvalPolicy: null,
    delegate: 'unloaded', forbidden: false,
    notes: 'baseline single-voice; per-tool relay via canUseTool' },
  { mode: 'solo', provider: 'claude', permissionMode: 'dangerously',
    askUser: 'never', replyPrefix: 'never', approvalPolicy: null,
    delegate: 'unloaded', forbidden: false,
    notes: 'bypassPermissions; agent self-confirms destructive ops in chat' },

  // ─── solo · codex ───────────────────────────────────────────────
  { mode: 'solo', provider: 'codex', permissionMode: 'strict',
    askUser: 'never', replyPrefix: 'never', approvalPolicy: 'untrusted',
    delegate: 'unloaded', forbidden: false,
    notes: 'codex SDK no per-tool callback; approval_policy gates; not surfaced to WeChat' },
  { mode: 'solo', provider: 'codex', permissionMode: 'dangerously',
    askUser: 'never', replyPrefix: 'never', approvalPolicy: 'never',
    delegate: 'unloaded', forbidden: false,
    notes: 'codex sandbox=workspace-write + approval=never' },

  // ─── parallel ───────────────────────────────────────────────────
  { mode: 'parallel', provider: 'claude', permissionMode: 'strict',
    askUser: 'per-tool', replyPrefix: 'always', approvalPolicy: null,
    delegate: 'unloaded', forbidden: false,
    notes: 'parallel: prefix [Claude] / [Codex] required to disambiguate' },
  { mode: 'parallel', provider: 'claude', permissionMode: 'dangerously',
    askUser: 'never', replyPrefix: 'always', approvalPolicy: null,
    delegate: 'unloaded', forbidden: false, notes: '' },
  { mode: 'parallel', provider: 'codex', permissionMode: 'strict',
    askUser: 'never', replyPrefix: 'always', approvalPolicy: 'untrusted',
    delegate: 'unloaded', forbidden: false, notes: '' },
  { mode: 'parallel', provider: 'codex', permissionMode: 'dangerously',
    askUser: 'never', replyPrefix: 'always', approvalPolicy: 'never',
    delegate: 'unloaded', forbidden: false, notes: '' },

  // ─── primary_tool ───────────────────────────────────────────────
  { mode: 'primary_tool', provider: 'claude', permissionMode: 'strict',
    askUser: 'per-tool', replyPrefix: 'on-fallback-only', approvalPolicy: null,
    delegate: 'loaded', forbidden: false,
    notes: 'primary=claude; codex callable via delegate_codex (always approval=never per RFC03 §4.2)' },
  { mode: 'primary_tool', provider: 'claude', permissionMode: 'dangerously',
    askUser: 'never', replyPrefix: 'on-fallback-only', approvalPolicy: null,
    delegate: 'loaded', forbidden: false, notes: '' },
  { mode: 'primary_tool', provider: 'codex', permissionMode: 'strict',
    askUser: 'never', replyPrefix: 'on-fallback-only', approvalPolicy: 'untrusted',
    delegate: 'loaded', forbidden: false,
    notes: 'primary=codex; claude callable via delegate_claude' },
  { mode: 'primary_tool', provider: 'codex', permissionMode: 'dangerously',
    askUser: 'never', replyPrefix: 'on-fallback-only', approvalPolicy: 'never',
    delegate: 'loaded', forbidden: false, notes: '' },

  // ─── chatroom ───────────────────────────────────────────────────
  { mode: 'chatroom', provider: 'claude', permissionMode: 'strict',
    askUser: 'per-tool', replyPrefix: 'always', approvalPolicy: null,
    delegate: 'unloaded', forbidden: false,
    notes: 'chatroom: agents address each other via @-tag; reply tool discouraged but not blocked' },
  { mode: 'chatroom', provider: 'claude', permissionMode: 'dangerously',
    askUser: 'never', replyPrefix: 'always', approvalPolicy: null,
    delegate: 'unloaded', forbidden: false, notes: '' },
  { mode: 'chatroom', provider: 'codex', permissionMode: 'strict',
    askUser: 'never', replyPrefix: 'always', approvalPolicy: 'untrusted',
    delegate: 'unloaded', forbidden: false, notes: '' },
  { mode: 'chatroom', provider: 'codex', permissionMode: 'dangerously',
    askUser: 'never', replyPrefix: 'always', approvalPolicy: 'never',
    delegate: 'unloaded', forbidden: false, notes: '' },
]
// 4 modes × 2 providers × 2 permissionModes = 16 rows ✓
```

### 5.3 lookup + assertSupported + 完整性

```ts
export function lookup(
  mode: Mode['kind'],
  provider: ProviderId,
  permissionMode: PermissionMode,
): Capability {
  const row = CAPABILITY_MATRIX.find(r =>
    r.mode === mode && r.provider === provider && r.permissionMode === permissionMode
  )
  if (!row) {
    throw new Error(`capability-matrix: no row for mode=${mode} provider=${provider} perm=${permissionMode}`)
  }
  return row
}

export class UnsupportedCombinationError extends Error {
  constructor(
    public readonly mode: Mode['kind'],
    public readonly provider: ProviderId,
    public readonly permissionMode: PermissionMode,
    public readonly notes: string,
  ) {
    super(`combination not supported: mode=${mode} provider=${provider} perm=${permissionMode}${
      notes ? ` — ${notes}` : ''
    }`)
    this.name = 'UnsupportedCombinationError'
  }
}

export function assertSupported(
  mode: Mode['kind'],
  provider: ProviderId,
  permissionMode: PermissionMode,
): void {
  const cap = lookup(mode, provider, permissionMode)
  if (cap.forbidden) {
    throw new UnsupportedCombinationError(mode, provider, permissionMode, cap.notes)
  }
}

function assertMatrixComplete(): void {
  const modes: Mode['kind'][] = ['solo', 'parallel', 'primary_tool', 'chatroom']
  const providers: ProviderId[] = ['claude', 'codex']
  const perms: PermissionMode[] = ['strict', 'dangerously']
  const expected = modes.length * providers.length * perms.length
  if (CAPABILITY_MATRIX.length !== expected) {
    throw new Error(`capability-matrix incomplete: have ${CAPABILITY_MATRIX.length} rows, expected ${expected}`)
  }
  for (const m of modes) for (const p of providers) for (const pm of perms) {
    const found = CAPABILITY_MATRIX.find(r => r.mode === m && r.provider === p && r.permissionMode === pm)
    if (!found) throw new Error(`capability-matrix missing row: mode=${m} provider=${p} perm=${pm}`)
  }
}
assertMatrixComplete()  // module-load
```

### 5.4 4 个集成点

| 文件 | 改动 |
|---|---|
| `core/conversation-coordinator.ts` | dispatch 入口对每个参与的 provider 调 `assertSupported(mode.kind, p, deps.permissionMode)` |
| `core/permission-relay.ts` | `makeCanUseTool` 内查 `lookup(...).askUser`，'never' 直接 allow；deps 加 mode+provider+permissionMode |
| `core/codex-agent-provider.ts` | `approvalPolicy` 从调用方传入，bootstrap 处由 `lookup('solo','codex',perm).approvalPolicy` 算出 |
| `daemon/internal-api/routes.ts` | `maybePrefix` 三态判断 `lookup(mode,provider,perm).replyPrefix` |

### 5.5 长期扩展（v1.0 不做）

1. **第三个 provider**：扩 `ProviderId` union → `assertMatrixComplete` boot 时报缺行 → 强制填 8 个新组合
2. **forbidden 行**：业务策略上有禁用组合时，set `forbidden: true` → coordinator 自动拒绝
3. **dashboard 渲染**：`internal-api` 加 `/v1/capabilities` route 返回 `CAPABILITY_MATRIX`

---

## 6. main.ts 形态（~80 LOC）

```ts
#!/usr/bin/env bun
if (!process.env.CLAUDE_CODE_ENTRYPOINT) {
  process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts'
}

import { join } from 'node:path'
import { homedir } from 'node:os'
import { acquireInstanceLock, releaseInstanceLock } from './single-instance'
import { openDb } from '../lib/db'
import { LifecycleSet } from '../lib/lifecycle'
import { log } from '../lib/log'
import { buildBootstrap } from './bootstrap'
import { loadAllAccounts, makeIlinkAdapter } from './ilink-glue'
import { registerInternalApi } from './internal-api/lifecycle'
import { registerCompanionPush, registerCompanionIntrospect } from './companion/lifecycle'
import { registerGuard } from './guard/lifecycle'
import { registerPolling } from './polling-lifecycle'
import { registerSessions } from './sessions-lifecycle'
import { registerIlink } from './ilink-lifecycle'
import { buildInboundPipeline } from './inbound/build'
import { runStartupSweeps } from './startup-sweeps'
import { wireMain } from './main-wiring'

const STATE_DIR = join(homedir(), '.claude', 'channels', 'wechat')
const PID_PATH = join(STATE_DIR, 'server.pid')
const DANGEROUSLY = process.argv.includes('--dangerously')

let shuttingDown = false

async function main() {
  const lock = acquireInstanceLock(PID_PATH)
  if (!lock.ok) {
    console.error(`[wechat-cc] ${lock.reason} (pid=${lock.pid}). Exiting.`)
    process.exit(1)
  }

  const accounts = await loadAllAccounts(STATE_DIR)
  if (accounts.length === 0) {
    console.error('[wechat-cc] no accounts bound. Run `wechat-cc setup` first.')
    releaseInstanceLock(PID_PATH); process.exit(1)
  }

  const db = openDb({ path: join(STATE_DIR, 'wechat-cc.db') })
  const ilink = makeIlinkAdapter({ stateDir: STATE_DIR, accounts, db })
  const lc = new LifecycleSet((tag, line) => log(tag, line))

  try {
    const internalApi = await registerInternalApi({ stateDir: STATE_DIR, ilink, db, log })
    lc.register(internalApi)

    const boot = buildBootstrap({
      stateDir: STATE_DIR, db, ilink,
      loadProjects: ilink.loadProjects, lastActiveChatId: ilink.lastActiveChatId,
      log: (t, l) => log(t, l),
      fallbackProject: () => ({ alias: '_default', path: process.cwd() }),
      dangerouslySkipPermissions: DANGEROUSLY,
      internalApi: { baseUrl: internalApi.baseUrl, tokenFilePath: internalApi.tokenFilePath },
    })
    internalApi.setDelegate({
      dispatchOneShot: boot.dispatchDelegate,
      knownPeers: () => boot.registry.list(),
    })

    const wired = wireMain({ stateDir: STATE_DIR, db, ilink, boot, dangerously: DANGEROUSLY })
    const pipeline = buildInboundPipeline(wired.pipelineDeps)

    lc.register(registerCompanionPush(wired.companionPushDeps))
    lc.register(registerCompanionIntrospect(wired.companionIntrospectDeps))
    lc.register(registerGuard(wired.guardDeps))
    lc.register(registerSessions(wired.sessionsDeps))
    lc.register(registerIlink(wired.ilinkDeps))

    const pollingLc = registerPolling({ ...wired.pollingDeps, runPipeline: pipeline })
    lc.register(pollingLc)

    runStartupSweeps(wired.startupDeps)

    const shutdown = async (sig: string) => {
      if (shuttingDown) {
        log('DAEMON', `${sig} during shutdown — forcing exit`)
        process.exit(130)
      }
      shuttingDown = true
      log('DAEMON', `${sig} received, shutting down`)
      try { await lc.stopAll() } catch { /* logged */ }
      try { db.close() } catch (err) { console.error('db close failed:', err) }
      releaseInstanceLock(PID_PATH)
      process.exit(0)
    }
    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGUSR1', () => pollingLc.reconcile().catch(err =>
      log('RECONCILE', `SIGUSR1 reconcile failed: ${err instanceof Error ? err.message : String(err)}`)
    ))

    log('DAEMON', `started pid=${process.pid} accounts=${accounts.length} mode=${
      DANGEROUSLY ? 'dangerouslySkipPermissions' : 'strict'
    }`)
  } catch (err) {
    log('DAEMON', `startup failed mid-init: ${err instanceof Error ? err.message : String(err)}`)
    try { await lc.stopAll() } catch {}
    db.close()
    releaseInstanceLock(PID_PATH)
    throw err
  }
}

main().catch((err) => {
  console.error('[wechat-cc] fatal:', err)
  process.exit(1)
})
```

`main-wiring.ts`（独立文件，~150 LOC）持有所有 deps 装配工厂；不持有业务状态，只是闭包构造器集合。

---

## 7. 测试策略

### 7.1 新增 ~100 测试

| 文件 | 用例数 |
|---|---|
| `lib/lifecycle.test.ts` | ~10 |
| `core/capability-matrix.test.ts` | ~22 |
| `daemon/inbound/compose.test.ts` | ~6 |
| `daemon/inbound/mw-*.test.ts` × 13 | ~3 each = ~39 |
| `daemon/inbound/pipeline.integration.test.ts` | ~7 |
| 6 个 `*-lifecycle.test.ts` | ~3 each = ~18 |
| **合计** | **~102** |

### 7.2 改造 3 个测试文件

- `core/permission-relay.test.ts` —— `it.each(CAPABILITY_MATRIX)` 笛卡儿积
- `core/conversation-coordinator.test.ts` —— 加用例：dispatch 入口 assertSupported 被调
- `daemon/internal-api.test.ts` —— 加用例：reply 路由前缀决策走 capability lookup

### 7.3 测试硬约束

- 既有 ~700 测试 **全部继续通过**（行为等价）
- 新增 mw 测试只测**包装层**（短路 / next 调用 / consumedBy 设置），不重复测 handler 内部业务
- pipeline.integration 用 fake deps，不接 sqlite / 真 ilink

### 7.4 main.ts 不写单测

main.ts 是纯组装、无逻辑分支。装配错误由：
- TS 编译器（`InboundPipelineDeps` 强类型）
- 各 `*-lifecycle.test.ts`
- 现有 `bootstrap.test.ts`
- `apps/desktop/shim.e2e.test.ts` 风格的 daemon 启停 e2e

共同覆盖。

---

## 8. 文件树 diff 总览

### 新增（48 = 26 实现 + 22 测试）

```
src/lib/
  + lifecycle.ts + lifecycle.test.ts

src/core/
  + capability-matrix.ts + capability-matrix.test.ts

src/daemon/inbound/                      # 新目录
  + types.ts
  + compose.ts + compose.test.ts
  + build.ts
  + mw-{trace,capture-ctx,typing,admin,mode,onboarding,permission-reply,
        guard,attachments,activity,milestone,welcome,dispatch}.ts (×13)
  + 同名 .test.ts (×13)
  + pipeline.integration.test.ts

src/daemon/
  + main-wiring.ts
  + startup-sweeps.ts
  + polling-lifecycle.ts + polling-lifecycle.test.ts
  + sessions-lifecycle.ts + sessions-lifecycle.test.ts
  + ilink-lifecycle.ts + ilink-lifecycle.test.ts

src/daemon/companion/  + lifecycle.ts + lifecycle.test.ts
src/daemon/guard/      + lifecycle.ts + lifecycle.test.ts
src/daemon/internal-api/ + lifecycle.ts
```

### 修改（10）

```
M src/daemon/main.ts                              # 627 → ~80 LOC
M src/core/conversation-coordinator.ts            # assertSupported on entry; deps + permissionMode
M src/core/permission-relay.ts                    # lookup().askUser; deps + mode/provider/permissionMode
M src/core/codex-agent-provider.ts                # accept approvalPolicy from caller
M src/daemon/bootstrap/index.ts                   # codex approvalPolicy from matrix; thread permissionMode
M src/daemon/internal-api/routes.ts               # maybePrefix → lookup().replyPrefix 三态
M .dependency-cruiser.cjs                         # +2 rules: inbound/* boundary
M src/core/permission-relay.test.ts               # cartesian via CAPABILITY_MATRIX
M src/core/conversation-coordinator.test.ts       # +1 case
M src/daemon/internal-api.test.ts                 # +1 case
```

### 删除（0）

无 hard delete。所有 main.ts 内联闭包搬到对应 mw / lifecycle。

---

## 9. depcruise 新规则

```js
// 加到 .dependency-cruiser.cjs forbidden:
{
  name: 'inbound-must-not-link-main',
  severity: 'error',
  comment: 'inbound mw 通过工厂注入 deps，不能 import main.ts',
  from: { path: '^src/daemon/inbound/', pathNot: '\\.test\\.ts$' },
  to: { path: '^src/daemon/main\\.ts$' },
},
{
  name: 'inbound-must-not-link-other-lifecycle',
  severity: 'error',
  comment: 'inbound mw 不能 import 其他子系统的 lifecycle 文件',
  from: { path: '^src/daemon/inbound/', pathNot: '\\.test\\.ts$' },
  to: { path: '(lifecycle\\.ts$|-lifecycle\\.ts$)' },
},
```

`lib/lifecycle.ts` 受现有 `lib-must-not-depend-on-anything-internal` 规则覆盖，无需新增。

---

## 10. 文档与 RFC 关系

- **RFC 04** —— 高层背景 + 决策记录。包括撤回 #3（drizzle）/ #5（pino）的论证。
- **本 spec** —— 契约级实现细节。
- **Plan**（writing-plans skill 产出）—— 单 PR cutover 的步骤序列 + 验收标准。

后续若加第三个 provider（Cursor / Gemini），应当：
- 不开新 RFC
- 在本 spec §5.5 落实"扩 ProviderId union → MATRIX 加 8 行"
- 其他骨骼不动

---

## 修订历史

| 日期 | 变更 |
|---|---|
| 2026-05-03 | 初版定稿 |
