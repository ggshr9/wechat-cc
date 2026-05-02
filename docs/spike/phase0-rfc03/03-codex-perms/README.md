# Spike 3: Codex SDK 权限粒度

**Phase**: 0-RFC03 · Spike
**Tracks**: [RFC 03 §9 Spike 3](../../../rfc/03-multi-agent-architecture.md#9-spike-验证清单phase-0-必做)
**Goal**: 实测 (sandboxMode × approvalPolicy) 矩阵的真实行为，确认 Codex 那侧没有 per-tool callback，记录 daemon 模式的安全 ship default。

## 为什么重要

Claude SDK 那侧通过 `canUseTool(tool, input) → 'allow' | 'deny'` 实现 per-tool 用户审批（`src/core/permission-relay.ts`）。RFC 03 §3.5 已经从 SDK 类型层确认 Codex SDK 没有等价 callback —— 只有粗粒度的 `sandboxMode` + `approvalPolicy` + `networkAccessEnabled` + `additionalDirectories` 几个旋钮。

但**类型层确认是"没有 API"，不等于"没有 runtime 行为"**：`approvalPolicy='on-request'` 在 daemon 模式下到底是 (a) auto-deny / (b) hang / (c) auto-approve / (d) 写到 stderr 求人？这个差异决定 daemon ship default 怎么选。

## 已知（来自 SDK 源码）

```ts
// dist/index.d.ts:234-249
type ApprovalMode = 'never' | 'on-request' | 'on-failure' | 'untrusted'
type SandboxMode  = 'read-only' | 'workspace-write' | 'danger-full-access'

type ThreadOptions = {
  model?: string
  sandboxMode?: SandboxMode
  workingDirectory?: string
  skipGitRepoCheck?: boolean
  modelReasoningEffort?: ModelReasoningEffort
  networkAccessEnabled?: boolean
  webSearchMode?: WebSearchMode
  webSearchEnabled?: boolean
  approvalPolicy?: ApprovalMode
  additionalDirectories?: string[]
}
```

整个 surface 就是这 9 个 ThreadOption。**没有 callback、没有 hook、没有事件流上的 approval request**——这是这次 spike 不需要 runtime 就能确认的。

runtime 要确认的是：在没有 per-tool callback 的前提下，daemon ship default 怎么选最安全？

## 测试矩阵

| Trial | sandboxMode | approvalPolicy | 操作 | 期望 |
|---|---|---|---|---|
| **A** | `read-only` | `never` | 写 cwd 内一个文件 | 拒绝 / 失败 |
| **B** | `workspace-write` | `never` | 写 cwd 内一个文件 | 成功 |
| **C** | `workspace-write` | `on-request` | 写 cwd **外**一个文件（system tmp，加在 `additionalDirectories`） | **未知** —— 这是这次 spike 真正要回答的 |

### Trial C 三种可能结果（决定 daemon default 怎么选）

| C 实际行为 | 含义 | daemon ship default |
|---|---|---|
| 写成功（`additionalDirectories` 扩展了写权限） | on-request 不会 block | 可以选 `on-request` 配 `additionalDirectories` 做白名单，相当于"目录级权限" |
| auto-deny（CLI 静默拒绝） | on-request 在无人模式下等于 deny | 应该选 `never`，避免静默 deny 让 Codex 走奇怪 fallback |
| **timeout / hang**（CLI 等用户输入） | on-request **不能用于 daemon** | **必须** `never`；on-request 只能用于 TUI 交互模式 |

如果落在第三种（最可能），RFC 03 §10 要加风险条目"Codex daemon 模式下 approvalPolicy 必须是 `never`，无法做细粒度审批"。

## 运行

```bash
cd docs/spike/phase0-rfc03/03-codex-perms
bun install
export OPENAI_API_KEY=sk-...
bun spike.ts
```

约 1-3 分钟（三个 trial，Trial C 可能 hang 到 90s timeout），约 $0.05-0.15。

## Pass 条件

- 三个 trial 都跑到 `turn.completed` / `turn.failed` / `timeout`（不抛异常）
- A 的 file 不存在
- B 的 file 存在
- C 的行为被记录到 `matrix.json`（不论是哪一种）

## 输出

- `matrix.json` — 三个 trial 的完整结果，含每个 trial 的 command_executions / file_changes / errors / agent_message_preview / side_effect_check / 总结 conclusions
- `scratch/` — Trial A/B 期望写入的临时文件目录（每次 trial 启动前清空）

## Daemon ship default（spike 跑完后据 matrix.json 填）

```ts
// src/core/codex-agent-provider.ts (proposed)
const codexThreadOptions = {
  workingDirectory: project.path,
  skipGitRepoCheck: true,
  sandboxMode: dangerouslySkipPermissions ? 'workspace-write' : ???,  // 待 spike 结果确认
  approvalPolicy: 'never',  // 几乎确定是这个 —— daemon 模式下唯一安全
  additionalDirectories: [],  // 默认不扩展
}
```

Claude 那侧（`src/daemon/bootstrap.ts:158-162`）有 `permissionMode: 'bypassPermissions' | 'default'` + `canUseTool` 二档；Codex 那侧目前看只能"全允或重度沙盒"，不能 per-tool。RFC 03 §10 要把这个非对称写清楚，让用户知道"切到 Codex 时 permission relay 不可用"。

## 记录结果

| 日期 | Codex SDK | Trial A | Trial B | Trial C 行为 | 结论 |
|---|---|---|---|---|---|
| TODO | 0.128.0 | pending | pending | pending | 等本地 OPENAI_API_KEY 跑一次 |

## 下一步

- 三 trial 都跑完，无论结果如何，spike 都是 PASS（这是 mapping spike，不是 binary check）
- matrix.json 的 conclusions 字段直接喂回 RFC 03：
  - §3.5 表格那行的"Codex per-tool callback"补充实证脚注
  - §10 风险表加一行"Codex daemon 模式下无 per-tool 审批"
  - §6 文件清单里 `codex-agent-provider.ts` 的 ThreadOption 默认值据此确定
