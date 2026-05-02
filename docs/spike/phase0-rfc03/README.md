# Phase 0 Spikes for RFC 03 (multi-agent architecture)

**Tracks**: [RFC 03 §9 Spike 验证清单](../../rfc/03-multi-agent-architecture.md#9-spike-验证清单phase-0-必做)
**Goal**: 在 P0/P1 开工前把三个关于 `@openai/codex-sdk@0.128.0` 的未知项落地为可执行验证。

| # | 主题 | 状态 | 关键问题 |
|---|---|---|---|
| [01-codex-mcp](./01-codex-mcp/) | 程序化 MCP 注入 | spike scaffold ready · runtime pending | `Codex({ config: { mcp_servers: { ... } } })` 启的 thread 能不能真的加载并调用 stdio MCP server？|
| [02-codex-events](./02-codex-events/) | runStreamed 事件 schema | spike scaffold ready · runtime pending | Runtime 事件结构和 `dist/index.d.ts` 类型声明是否一致？有没有 undocumented event/item type？|
| [03-codex-perms](./03-codex-perms/) | 权限粒度 | spike scaffold ready · runtime pending | 没有 per-tool callback 已确认；daemon 模式下 (sandboxMode × approvalPolicy) 的安全 default 该怎么选？|

## 类型层已确认（无须运行）

读 `node_modules/@openai/codex-sdk/dist/index.d.ts`（v0.128.0，275 行）：

| 维度 | 结论 | 详细位置 |
|---|---|---|
| Thread 持久化 | ✅ `startThread()` / `resumeThread(id)` 都返回 `Thread`；threads 存于 `~/.codex/sessions` | spike-01-codex-mcp README |
| streaming events | ✅ `runStreamed()` 返回 `{ events: AsyncGenerator<ThreadEvent> }`；8 种 event type、8 种 item type | spike-02-codex-events README |
| MCP tool calls 在事件流里 | ✅ `item.completed` + `item.type === 'mcp_tool_call'`，含 server / tool / arguments / result / error | spike-02-codex-events README "翻译表" |
| 程序化 MCP 配置接口存在 | ✅ `Codex({ config: { mcp_servers: { wechat: { command, args } } } })` 接受任意嵌套 plain object | spike-01-codex-mcp README |
| 程序化 MCP 配置序列化 | ✅ SDK 内部 `flattenConfigOverrides` 递归走对象树，每个叶子 emit 一条 `--config dotted.path=tomlvalue`；走的是标准 TOML 表语法 | dist/index.js:292-328 |
| Per-tool 审批 callback | ❌ 不存在；ThreadOptions 只暴露 9 个粗粒度旋钮（sandboxMode / approvalPolicy / networkAccessEnabled / additionalDirectories / webSearchMode / webSearchEnabled / model / modelReasoningEffort / workingDirectory + skipGitRepoCheck） | spike-03-codex-perms README |
| Cancel / interrupt | ✅ `TurnOptions.signal: AbortSignal` —— 调 `controller.abort()` 中断当前 turn | dist/index.d.ts:166-171 |
| Resume thread by id | ✅ `codex.resumeThread(id, options?)` —— 与 Claude SDK 的 `options.resume` 等价 | dist/index.d.ts:268-272 |

→ **直接喂回 RFC 03 §3.5 的 SDK 能力对照表**。

## 运行所有 spike

每个 spike 独立：

```bash
cd docs/spike/phase0-rfc03/01-codex-mcp && bun install && bun spike.ts
cd docs/spike/phase0-rfc03/02-codex-events && bun install && bun spike.ts
cd docs/spike/phase0-rfc03/03-codex-perms && bun install && bun spike.ts
```

要求：
- `bun` 1.1+（每个 spike 文件夹有自己的 `package.json` + `bun install`）
- `OPENAI_API_KEY=sk-...` 在环境变量
- 网络能到 OpenAI

总成本 ≈ $0.10-0.30，总耗时 ≈ 3-5 分钟（Trial 3-C 可能 hang 到 90s timeout）。

`@openai/codex` CLI 通过 npm 依赖锁版本到 `@openai/codex@0.128.0`，每个 spike 包安装时拉本地副本（不依赖系统全局 `codex`）。

## 决策 fork（spike 跑完后）

```
Spike 1 PASS  → RFC 03 §5.2 程序化注入直接落地
Spike 1 FAIL  → RFC 03 Appendix B 兜底，安装时改写 ~/.codex/config.toml

Spike 2 PASS  → 翻译表（在 02-codex-events/README.md）成为 codex-agent-provider.ts 实现指引
Spike 2 任何 undocumented → 在 RFC 03 §3.5 加 addendum，provider 实现里加 default branch

Spike 3 永远 mapping，不会失败 → 把 matrix.json 的 conclusions 喂到 RFC 03 §10 风险表
                                + §6 codex-agent-provider.ts ThreadOption 默认值
```

## Phase 0 完成后开 P0/P1

按 RFC 03 §8：

| Phase | 内容 | 工期 |
|---|---|---|
| **P0** | Codex SDK provider 替换现有 cli-provider；threads.json 加 provider 维度；migration 路径 | 2 天 |
| **P1** | wechat-mcp 抽出 stdio server；daemon internal-api；Claude 也走 stdio | 4 天 |

P0/P1 合并 PR（一周）作为 RFC 03 第一份代码 deliverable。
