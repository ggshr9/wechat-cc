# RFC 05 · Provider 扩展性 + Tier/Permission 解耦

**Status**: Accepted · 2026-05-26（决议项 §7 已 close，待实施）
**Phase**: 内部重构（无用户可见 feature 变化）
**Triggered by**: 2026-05-25 dev-branch review 发现的 C4 / C5 / sweep#6 三个 tier-policy regressions（commit `33f9398`、`5d5233a`、`957e4b8`、`ca0efb3`）
**Related**: [RFC 03 §3.6 / C7](./03-multi-agent-architecture.md) provider abstraction；[RFC 04 §4](./04-inbound-pipeline-and-capability-matrix.md) capability matrix
**Branch**: TBD — `dev` 上工作

---

## TL;DR

v0.6 引入 user-tier 体系后，每个 provider 在 `src/core/<provider>-agent-provider.ts` 各自暴露一个 `tierProfileToXxxSdkOpts(tp)` 翻译函数。daemon 在 `src/daemon/bootstrap/index.ts` 直接 import 这些函数、按位置传参。这个抽象有三处泄漏：

1. **`permissionMode` 信号丢了。** 每个翻译函数只看 `TierProfile` 的 relay/deny 集合大小判断"是不是 admin"——但 admin tier ≠ `--dangerously` flag。dev review 里 C4（admin strict 模式不再 prompt）和 C5（`--dangerously` 不再覆盖非 admin chat 的 codex sandbox）就是这个泄漏直接长出来的。
2. **加 provider = 改 N 处。** 新增 gemini 要：(a) 写 `gemini-agent-provider.ts`，(b) 写 `tierProfileToGeminiSdkOpts`，(c) bootstrap import 这个函数，(d) capability matrix 加 4 modes × 2 permissionModes = 8 行，(e) `assertMatrixComplete` 通过。任何一处忘了都是 silent regression。
3. **A2A peer 不是 `AgentProvider`，但 tier 模型应该共享。** 现状是 `a2a-registry` + `a2a-server` 跟主流程平行。"trusted 能否 a2a_send"是 `ToolKind.a2a_send` + tier profile 在管，但加新 A2A peer 时这条共享路径没文档化。

提出三件事：

1. **`SpawnContext`** — `AgentProvider.spawn` 收一个 uniform context（包含 `tierProfile` + `permissionMode` + `mode` + `chatId` + `runtime`），每个 provider 自己翻译为 SDK opts。**daemon 不再 import 任何 `tierProfileToXxxSdkOpts`**。
2. **`ProviderCapabilities`** — provider 声明自己的能力维度（perToolCallback / sandboxLevels / supportsDelegation / supportsResume）。`capability-matrix` 从 capabilities 派生而不是手写 24 行（gemini 加进来不再需要写 8 行 matrix）。
3. **A2A 不并入 `AgentProvider`，但显式声明共享 tier 模型**：`a2a_send` 走 ToolKind 通路、operator-curated `a2a_agents` 列表是数据而非"provider"。

骨骼立完，**C4 / C5 / sweep#6 的修复降级为policy change**（admin tier profile 加 `shell_destructive` 到 relay）而不再是跨 6 个文件的协同改动。

---

## 1. 起因

### 1.1 dev review 暴露的抽象泄漏

2026-05-25 对 master → dev 169 个 commit、31k+ 行 diff 跑了一遍五角度 code review，15 个 finding 里有 4 个直接指向 `tierProfileToXxxSdkOpts` 设计：

| Finding | 文件 | 现象 | 根因 |
|---|---|---|---|
| C4 | `claude-agent-provider.ts:43` | admin tier 永远 `bypassPermissions`，即使 daemon 是 strict 模式启动 | 翻译函数用 `relay+deny size === 0` 当 "admin → 等同 dangerously" 短路 |
| C5 | `codex-agent-provider.ts:32` | `--dangerously` 不再覆盖 guest chat 的 codex sandbox | 翻译函数完全没看 daemon-wide `permissionMode` |
| sweep#6 | `bootstrap/index.ts:293` | 多 admin 安装下 admin[1+] 收不到自己触发的 relay prompt | `resolveAdminChatId` 没看 `initiatingChatId` |
| sweep#3 | `internal-api/schema.ts:367` | dashboard 的 `participants:['claude','cursor']` 被 zod silently strip | 同样是"daemon 知识在多处复述" |

C4 + C5 共享一个反模式：**provider 的 SDK 翻译函数试图从 `TierProfile` 的结构推断 daemon-wide 状态**（`relay+deny 全空 → 这一定是 admin → 一定要 bypass`）。这条推断在 v0.5 里能成立是因为 admin tier profile 是写死的；任何后续的 tier policy 微调（C4 想做的"admin 也要 prompt destructive"）都会把这条推断打破。

### 1.2 加 gemini 的成本

设想 2026-Q3 接 `gemini-cli`。今天要做的事：

```
1. src/core/gemini-agent-provider.ts          [新]   ~200 行
   ├── tierProfileToGeminiSdkOpts(tp)
   └── createGeminiAgentProvider(opts)
2. src/daemon/bootstrap/index.ts             [改]
   ├── import { createGeminiAgentProvider, tierProfileToGeminiSdkOpts }
   ├── registry.register('gemini', ...)
   └── permission knobs 翻译再写一遍
3. src/core/capability-matrix.ts             [改]   8 行新行
   ├── solo · gemini · strict / dangerously
   ├── parallel · gemini · ...
   ├── primary_tool · gemini · ...
   └── chatroom · gemini · ...
4. src/core/user-tier.ts                     [可能改]
   └── 如果 gemini 有独有的 tool kind
5. src/daemon/bootstrap/delegate.ts          [改]
   └── delegate_gemini 入口
6. src/mcp-servers/delegate/main.ts          [改]
   └── delegate tool 注册
```

第 1 步是"实现一个 provider"——不可避免。**步骤 2-6 是 daemon "知道" 这个 provider 存在的代价**——本 RFC 要把这部分压缩到接近零。

### 1.3 A2A peer 的归属

A2A 引入了一个新的"agent"概念：operator-curated 的外部 agent（通过 `agent-config.json::a2a_agents` 注册）。它有 `id` / `name` / `url` / inbound + outbound 凭据，但**它不是 `AgentProvider`**——它没有本地 SDK、没有持久 thread、没有 `dispatch` 语义。它的交互形态是：

- **Outbound**：本地 agent 调 `mcp__wechat__a2a_send(agent_id, text)` → daemon HTTP POST 到 peer
- **Inbound**：peer HTTP POST 到 daemon `/a2a/notify` → daemon 路由到 operator 微信

但它**和 `AgentProvider` 共享 tier policy**：

- "trusted 能否 a2a_send" 是 `ToolKind.a2a_send` ∈ `TIER_PROFILES.trusted.relay`
- "guest 不能 a2a_send" 是 `ToolKind.a2a_send` ∈ `TIER_PROFILES.guest.deny`

这条共享路径今天能 work 是因为它走 ToolKind 通路。但加新 A2A peer 时**操作员 mental model 没有显式提示**："这个新 peer 的访问由 tier policy 控制，不是由 peer 自己配置"——而是散在 `permission-relay` 的 effectivePolicy 里。

---

## 2. 设计

### 2.1 SpawnContext

`AgentProvider.spawn` 的签名从

```ts
// 现状
spawn(
  project: AgentProject,
  opts: { resumeSessionId?: string; tierProfile: TierProfile; chatId: string },
): Promise<AgentSession>
```

改为

```ts
// 提案
spawn(project: AgentProject, ctx: SpawnContext): Promise<AgentSession>

interface SpawnContext {
  /** 本次 dispatch 的 chat 的 tier profile（已应用 `permissionMode` 影响）。 */
  tierProfile: TierProfile

  /** Daemon-wide 权限模式：strict | dangerously。 */
  permissionMode: PermissionMode

  /** 本 chat 当前的 mode kind（capability matrix lookup key）。 */
  mode: Mode['kind']

  /** 用于 per-tool callback 绑定 + log 关联。 */
  chatId: string

  /** Resume hook（claude/codex/cursor 各自的 jsonl/thread/agent id 字符串）。 */
  resumeSessionId?: string

  /** Provider runtime — daemon-owned 工具，按需注入。 */
  runtime: ProviderRuntime
}

interface ProviderRuntime {
  /**
   * 构建一个绑定到 chatId 的 canUseTool callback。
   * 只对 `capabilities.perToolCallback === true` 的 provider 调用一次。
   * Codex / Cursor 收到 undefined，自己忽略即可。
   */
  buildCanUseTool?: (chatId: string) => CanUseTool

  /** Sticky log。 */
  log: (tag: string, line: string) => void
}
```

**两个关键不变量**：

- `tierProfile` 由 daemon 解析（`resolveTier(chatId, access)` + `--dangerously` 提升），provider **不再**自己推断 `relay+deny size`。
- `permissionMode` 是显式入参。provider 必须看这个 flag 决定是否 bypass — 漏看 = TypeScript 报错（`tsc --noEmit` 即可）。

### 2.2 ProviderCapabilities

每个 provider 自带一个静态声明：

```ts
interface ProviderCapabilities {
  /**
   * SDK 支持 per-tool callback（Claude 的 canUseTool）。决定：
   *   - `runtime.buildCanUseTool` 会不会被调用
   *   - capability-matrix 里 `askUser='per-tool'` 是否可被实现
   */
  perToolCallback: boolean

  /**
   * 支持的 sandbox 级别。决定：
   *   - tier → sandbox 翻译可用的取值集合
   *   - guest tier 在 cursor 上的 fallback 行为（cursor 没有 read-only）
   */
  sandboxLevels: ReadonlySet<SandboxLevel>

  /** `delegate_<peer>` 工具是否可作为 peer。 */
  supportsDelegation: boolean

  /** Daemon 重启后能否 resume session（持久 thread id 是否有效）。 */
  supportsResume: boolean
}

type SandboxLevel = 'none' | 'read-only' | 'workspace-write' | 'full'
```

具体 provider 声明示例：

```ts
// claude
export const CLAUDE_CAPABILITIES: ProviderCapabilities = {
  perToolCallback: true,
  sandboxLevels: new Set(['none']),     // claude SDK 自己不分级，靠 canUseTool
  supportsDelegation: true,
  supportsResume: true,
}

// codex
export const CODEX_CAPABILITIES: ProviderCapabilities = {
  perToolCallback: false,
  sandboxLevels: new Set(['read-only', 'workspace-write', 'full']),
  supportsDelegation: true,
  supportsResume: true,
}

// cursor
export const CURSOR_CAPABILITIES: ProviderCapabilities = {
  perToolCallback: false,
  sandboxLevels: new Set(['workspace-write', 'full']),  // 注意：无 read-only
  supportsDelegation: false,                            // P1 不接 cursor 入 delegate
  supportsResume: true,
}

// gemini-cli (未来)
export const GEMINI_CAPABILITIES: ProviderCapabilities = {
  perToolCallback: ???,   // 看 gemini SDK
  sandboxLevels: ???,
  supportsDelegation: ???,
  supportsResume: ???,
}
```

加 gemini 只要填四个 boolean/Set 字段，capability-matrix 派生剩下的 8 行。

### 2.3 Per-provider self-translation

translation 函数**从 `src/core/` 移到 provider 内部**，不再 export。Provider 的 `spawn` 自己消化 `SpawnContext`：

```ts
// claude-agent-provider.ts 内部
function buildClaudeSdkOpts(ctx: SpawnContext, base: Options): Options {
  // dangerously 直接 SDK 级 bypass。
  if (ctx.permissionMode === 'dangerously') {
    return { ...base, permissionMode: 'bypassPermissions' }
  }
  // strict — 永远走 canUseTool。tier 的 allow/relay/deny 在 callback 里展开。
  const disallowed = collectDisallowedBuiltins(ctx.tierProfile.deny)
  return {
    ...base,
    permissionMode: 'default',
    canUseTool: ctx.runtime.buildCanUseTool?.(ctx.chatId),
    ...(disallowed.length > 0 ? { disallowedTools: disallowed } : {}),
  }
}

// codex-agent-provider.ts 内部
function buildCodexThreadOptions(ctx: SpawnContext): ThreadOptions {
  if (ctx.permissionMode === 'dangerously') {
    return { sandboxMode: 'danger-full-access', approvalPolicy: 'never' }
  }
  // strict — coarse sandbox。codex 没有 per-tool callback。
  if (ctx.tierProfile.deny.size === 0 && ctx.tierProfile.relay.size === 0) {
    return { sandboxMode: 'danger-full-access', approvalPolicy: 'never' }
  }
  if (ctx.tierProfile.deny.size === 0) {
    return { sandboxMode: 'workspace-write', approvalPolicy: 'never' }
  }
  return { sandboxMode: 'read-only', approvalPolicy: 'untrusted' }
}
```

Daemon 端 `sdkOptionsForProject` 这个 closure 消失。`bootstrap/index.ts` 缩短 ~80 行。

### 2.4 Capability matrix 派生

今天 `capability-matrix.ts` 是 24 行手写常量（4 modes × 3 providers × 2 permissionModes）。提议把它分成两层：

```ts
// 静态：mode + permissionMode 决定 replyPrefix + delegate（与 provider 无关）
const MODE_TRAITS: Record<Mode['kind'], Record<PermissionMode, ModeTrait>> = {
  solo:          { strict: {...}, dangerously: {...} },
  parallel:      { strict: {...}, dangerously: {...} },
  primary_tool:  { strict: {...}, dangerously: {...} },
  chatroom:      { strict: {...}, dangerously: {...} },
}

// 派生：provider × mode × permissionMode → 完整 Capability
function deriveCapability(
  cap: ProviderCapabilities,
  mode: Mode['kind'],
  pm: PermissionMode,
): Capability {
  const trait = MODE_TRAITS[mode][pm]
  return {
    askUser: cap.perToolCallback ? trait.askUser : 'never',
    replyPrefix: trait.replyPrefix,
    approvalPolicy: cap.perToolCallback ? null : trait.coarseApproval,
    delegate: mode === 'primary_tool' && cap.supportsDelegation ? 'loaded' : 'unloaded',
    forbidden: trait.forbidden,
    notes: '',
  }
}
```

加 gemini = 注册 `GEMINI_CAPABILITIES` + matrix 自动覆盖。`assertMatrixComplete` 仍然在 bootstrap 跑，但它现在校验 `deriveCapability(cap, m, pm)` 对每个注册的 provider 都不 throw。

### 2.5 A2A: 显式声明 "不是 provider，是数据"

A2A 不并入 `AgentProvider`。但本 RFC 把这个决定写下来，避免后续 PR 误把 a2a peer 塞进 registry：

- **A2A peer 是 operator-curated 数据**（`agent-config.json::a2a_agents` + `a2a-registry`），不是 spawn-able provider。
- **tier 模型通过 ToolKind 共享**：`a2a_send` ∈ `ToolKind`，每个 tier profile 已经声明对 `a2a_send` 的态度（admin: allow / trusted: relay / guest: deny）。
- **加新 A2A peer = 改数据，不改代码**。Bootstrap 不需要"知道"它存在。

A2A inbound (`/a2a/notify`) 路由到 operator 微信的逻辑也保持独立（`routeA2ANotify` in bootstrap）——它是 daemon-level routing，不归 provider 抽象管。

---

## 3. 迁移路径

§7 决议后定为 **2 个 PR**（一刀切，不走双轨过渡）：

### Phase 1 — SpawnContext + per-provider self-translation + C4（1 PR，~12 文件）

§7 决议 1 选了**一刀切**，所以原本"双轨过渡"的 Phase 1 和"删 export"的 Phase 2 合并为单个 PR：

- 新增 `SpawnContext` / `ProviderRuntime` / `ProviderCapabilities` interfaces（`src/core/agent-provider.ts`）。
- `spawn(project, ctx)` **直接换签名**——所有 caller / test 一次性改。无 ctxOrOpts 双轨。
- 每个 provider 实现内部 `buildXxxSdkOpts(ctx)`。**删除** `tierProfileToClaudeSdkOpts` / `tierProfileToCodexSdkOpts` / `tierProfileToCursorSdkOpts` 的 export 入口。
- Daemon 端 `sdkOptionsForProject` closure 删除（claude / delegate-claude 两处）。bootstrap 直接给 provider 传 `runtime.buildCanUseTool` 工厂。
- **C4 同步修**：`TIER_PROFILES.admin.relay` 加 `shell_destructive` + `memory_delete`；`effectivePolicy` 增加 `tp.allow.has(kind) → 'allow'` 短路。
- **C5 已在 commit `33f9398` 修了**——本 PR 顺手把 `resolveEffectiveTier` 的 dangerously promotion 撤掉，改由 provider 内的 `permissionMode === 'dangerously'` 短路负责。语义等价，但抽象更干净。
- **释放 note**（§7 决议 2 = 需要）：写到 `docs/releases/2026-05-XX-v0.5.6.md`，admin section 显式说明 strict 模式下 destructive Bash / `memory_delete` 现在会 prompt admin 自己；`--dangerously` 不受影响。

预期文件改动清单：

```
src/core/agent-provider.ts                       [新 types]
src/core/user-tier.ts                            [admin.relay + 测试]
src/core/permission-relay.ts                     [effectivePolicy 短路]
src/core/claude-agent-provider.ts                [internalize translation, 删 export]
src/core/codex-agent-provider.ts                 [同上 + permissionMode 入参]
src/core/cursor-agent-provider.ts                [同上 + sandboxOptions tie-break]
src/daemon/bootstrap/index.ts                    [sdkOptionsForProject closure 删除]
src/daemon/bootstrap/delegate.ts                 [delegate 端走新 ctx]
src/daemon/wiring/tick-bodies.ts                 [companion tick spawn(ctx)]
docs/CLAUDE.md                                   [permission 表更新]
docs/releases/2026-05-XX-v0.5.6.md               [新 release note]
+ 配套测试更新 ~5-7 个文件
```

### Phase 2 — ProviderCapabilities + matrix 派生（1 PR）

- 每个 provider 声明 `capabilities`。Cursor 写 `supportsDelegation: false` 但注释明确"P2 SDK 出 sub-agent 后再开"（§7 决议 3）。
- `capability-matrix.ts` 24 行常量 → `MODE_TRAITS` 8 行常量 + `deriveCapability`。
- `assertMatrixComplete` 改写为校验派生函数。
- 测试：matrix 表存在的 invariant test 改写为派生函数的 property test，加一个"ghost gemini" provider 单测验证 `lookup('solo', 'gemini', 'strict')` 不 throw。

Phase 1 即解锁 C4 / C5 / sweep#6 完整修复 + gemini 添加成本压缩。Phase 2 是"extensibility 的最后一公里"——让加 gemini 时 matrix 工作量从"写 8 行"压到"声明 4 个字段"。

### 不同步做的事

- **不改 A2A 路径**。`a2a-registry`、`a2a-server`、`routeA2ANotify` 不动。RFC 05 只声明 "A2A 不是 provider" 的边界。
- **不重写 capability-matrix 的 4 个集成点**（coordinator、permission-relay、codex provider、internal-api）——Phase 3 只换 matrix 的内部实现，外部 API `lookup(mode, provider, pm)` 不变。
- **不引入 ProviderRegistry 的 dynamic-load 机制**。本 RFC 不试图支持运行时加载 provider 包。Provider 仍在 bootstrap 静态注册。

---

## 4. C4 / C5 / sweep#6 在新模型下的解法

把 review 里 hold 住的 C4 翻译成 Phase 2-b 的内容：

**C4 — admin strict 模式不再 prompt**

```ts
// user-tier.ts
const ADMIN_RELAY = new Set<ToolKind>(['shell_destructive', 'memory_delete'])
export const TIER_PROFILES = {
  admin: {
    allow: difference(ALL_KINDS, ADMIN_RELAY),
    relay: ADMIN_RELAY,
    deny: new Set(),
  },
  trusted: { ... unchanged ... },
  guest:   { ... unchanged ... },
}

// permission-relay.ts effectivePolicy
function effectivePolicy(base: Capability, tp: TierProfile, kind: ToolKind) {
  if (tp.deny.has(kind))  return 'deny'
  if (tp.relay.has(kind)) return 'relay'
  if (tp.allow.has(kind)) return 'allow'   // NEW: 显式 allow 截断 matrix.askUser
  return base.askUser === 'per-tool' ? 'relay' : 'allow'
}
```

结合 Phase 2-a 的 `buildClaudeSdkOpts(ctx)`（strict 永远 canUseTool）：

| 场景 | strict 模式 | dangerously 模式 |
|---|---|---|
| admin Bash `ls` | tier.allow → auto-allow，不 prompt | SDK bypass，不 prompt |
| admin Bash `rm -rf /tmp/x` | tier.relay → prompt 到 admin 自己 | SDK bypass，不 prompt |
| trusted Bash `ls` | tier.allow → auto-allow | SDK bypass |
| trusted Bash `rm -rf` | tier.relay → prompt admin | SDK bypass |
| guest Bash 任何 | tier.deny shell → deny | SDK bypass |

**C5 — `--dangerously` 不覆盖非 admin 的 codex sandbox**

`buildCodexThreadOptions(ctx)` 第一行就是 `if (ctx.permissionMode === 'dangerously') return { sandboxMode: 'danger-full-access', approvalPolicy: 'never' }`。所有 chat 在 dangerously 模式下都 full-access，无关 tier。

**sweep#6 — 多 admin 的 relay routing**

跟 provider 抽象无关，已在 commit `33f9398` 修了。这里只是确认它在新模型下保持有效（`resolveAdminChatId(access, companion, initiatingChatId)` 不变）。

---

## 5. 不做（Out of Scope）

- ❌ **A2A peer 升格为 AgentProvider**。形态不同（HTTP push vs 本地 spawn）、生命周期不同（数据 vs 进程），共享 abstraction 弊大于利。
- ❌ **Dynamic provider plugin loading**。bootstrap 静态注册的简单 + 可审计仍然胜过运行时 plugin。
- ❌ **provider 自带 tier policy override**。tier 是 daemon-owned 策略；provider 只翻译，不策划。否则一个写得激进的 third-party provider 能给自己"提权"。
- ❌ **per-mode 自动 fallback**（"chatroom 模式 cursor 不支持 delegate → 自动降级 solo"）。当前 `assertSupported` 在 dispatch 入口 throw，操作员能看到。autodowngrade 是 bug magnet。
- ❌ **触动 `agent-config.json` schema**。`a2a_agents` 跟 `provider` 字段保持互相独立。

---

## 6. 验证

Phase 1 完成后：

- [ ] `bun --bun vitest run` — 既有 2080 单测全 pass
- [ ] 新增 SpawnContext typeof check：spawn 入参传错 shape → ts 报错
- [ ] `bun x tsc --noEmit` — clean

Phase 2 完成后：

- [ ] `tierProfileToClaudeSdkOpts` / `tierProfileToCodexSdkOpts` / `tierProfileToCursorSdkOpts` 全部不再从 `src/core/` export
- [ ] `bootstrap/index.ts` 行数下降 ≥ 60 行（删 sdkOptionsForProject closure）
- [ ] C4 / C5 行为测试：
  - admin strict 模式 + Bash `rm -rf` → relay prompt 到 admin chat
  - admin strict 模式 + Bash `ls` → 不 prompt
  - guest dangerously 模式 + Bash 任意 → SDK bypass，dispatch 成功

Phase 3 完成后：

- [ ] 加一个 "ghost gemini" provider 的 unit test：声明 `GEMINI_CAPABILITIES = { perToolCallback: true, ... }`，注册到一个 test-only registry，验证 `lookup('solo', 'gemini', 'strict')` 返回合理 Capability（而不是 throw "missing row"）
- [ ] capability-matrix.ts 行数下降 ≥ 100 行

---

## 7. 决议（2026-05-26 closed）

| # | 决议 | 结果 | 实施位置 |
|---|---|---|---|
| 1 | Phase 1 PR 兼容旧签名 | **一刀切**，无双轨过渡 — `spawn(project, ctx)` 直接换签名；Phase 1 和原 Phase 2 合并 | §3 Phase 1 |
| 2 | C4 行为变化是否写 release note | **需要** — 写到 `docs/releases/2026-05-XX-v0.5.6.md`，admin section 显式说明 strict 下会 prompt 自己 | §3 Phase 1 |
| 3 | Cursor `supportsDelegation = false` 定位 | **后续 P2 加** — 等 Cursor SDK 暴露 sub-agent / canUseTool 等价物再 flip；注释明确"非永久" | §2.2 |
| 4 | A2A 的 ToolKind 进不进 ProviderCapabilities | **不进** — a2a peer 是 operator-curated 数据，不是 provider 自我描述维度 | §2.5 + §5 |

---

## 附录 A · 与 RFC 03 的关系

RFC 03 §3.6 / C7 留下的开放问题之一是 "provider abstraction 对第三个 agent 友好吗"。当时回答是"接口已开放，欢迎 PR"；本 RFC 把这个回答从 "interface exists" 升级到 "interface + capability + matrix derivation 三者一起对加 provider 闭环"。

## 附录 B · 没改的地方

- `ProviderRegistry` 形态不变（`register(id, provider, meta)`）
- `SessionManager` 对 provider 无知，本 RFC 不动
- `ConversationCoordinator` dispatch 三模式（solo / parallel / chatroom）逻辑不动
- `delegate_<peer>` MCP 工具配置不动（虽然`supportsDelegation` 派生进了 capability matrix）
