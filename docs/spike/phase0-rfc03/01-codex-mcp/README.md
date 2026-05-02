# Spike 1: Codex SDK 程序化 MCP 注入

**Phase**: 0-RFC03 · Spike
**Tracks**: [RFC 03 §9 Spike 1](../../../rfc/03-multi-agent-architecture.md#9-spike-验证清单phase-0-必做)
**Goal**: 验证 `Codex({ config: { mcp_servers: { ... } } })` 启动的 thread 能真的加载 + 调用一个 stdio MCP server。

## 为什么重要

RFC 03 的核心设计是把 wechat 工具集（reply / memory / voice）从 Claude SDK 内联 MCP 提到独立 stdio server，让 Claude 和 Codex 都从这一份连接。**Codex 那侧加载方式有两种**：

1. **程序化注入** — `new Codex({ config: { mcp_servers: { wechat: { command, args } } } })`，干净，每个 daemon 自带配置不污染用户的 `~/.codex/config.toml`
2. **文件配置** — 写 `~/.codex/config.toml`，全局生效，安装时改、卸载时清

(1) 是首选。如果 Spike 1 PASS，RFC 03 §5.2 直接落地；FAIL 就走 Appendix B 的 (2) 兜底。

## SDK 类型层已确认（无须运行）

读 `@openai/codex-sdk@0.128.0` 的 `dist/index.d.ts` + `dist/index.js`：

- `CodexOptions.config: CodexConfigObject` — 接受任意嵌套 plain object
- `serializeConfigOverrides()` 把对象扁平化成 `dotted.path=tomlvalue` 格式，对每个叶子节点 emit 一条 `--config <key>=<value>`
- `mcp_servers.wechat.command="node"` / `mcp_servers.wechat.args=["..."]` 这种 dotted-key 是 TOML 标准合法语法

**结论**：SDK 端 100% 支持程序化注入；spike 验证的是 **Codex CLI 在被传 `--config mcp_servers.<name>.<key>=<value>` 时是否真的加载该 MCP server 并暴露其工具**。

CLI 行为是黑盒，必须 runtime 验证。

## 运行

```bash
cd docs/spike/phase0-rfc03/01-codex-mcp
bun install
export OPENAI_API_KEY=sk-...   # 或 CODEX_API_KEY，spike.ts 用前者
bun spike.ts
```

约 10-30 秒，约 $0.01-0.05（GPT-5 默认）。

## Pass 条件

- thread.runStreamed 流出至少一个 `item.completed` 事件，item 是 `{ type: 'mcp_tool_call', server: 'echo', tool: 'echo', status: 'completed' }`
- 该 item 的 `result.content[0].text` 等于 SENTINEL（`SPIKE-MCP-OK-9b3e7f`）
- 最终 `agent_message.text` 包含 SENTINEL（证明 Codex 把工具结果 round-trip 回了用户面）
- `turn.completed` 事件正常发出

## Fail 模式

| 现象 | 含义 | 行动 |
|---|---|---|
| 无 mcp_tool_call item | Codex CLI 未加载 echo server | RFC 03 兜底走 Appendix B：`~/.codex/config.toml` 文件配置 |
| mcp_tool_call status=failed | server 启动失败或协议错配 | 看 stderr，可能是 echo-mcp-server.ts 的 protocolVersion / capability 协商问题，调整后重测 |
| tool result 不是 SENTINEL | echo server 实现 bug | 修 `echo-mcp-server.ts` |
| final agent message 不含 SENTINEL | Codex 调用了 tool 但没把结果转告用户 | 调整 prompt（可能需要更明确指令），不影响架构结论 |
| runStreamed 抛异常 | SDK / CLI 配置错误 | 看 err.message，常见 OPENAI_API_KEY 或 CLI 路径问题 |

## 文件清单

- `spike.ts` — 主 spike 脚本，启动 echo MCP server + Codex thread + 断言
- `echo-mcp-server.ts` — 50 行手写 stdio JSON-RPC MCP server，仅暴露 `echo` 工具，所有日志走 stderr 不污染 stdout transport
- `package.json` — 锁版本到 `@openai/codex@0.128.0` + `@openai/codex-sdk@0.128.0`

## 记录结果

PASS 后填这里：

| 日期 | Codex SDK | Codex CLI | OS | 结果 | 耗时 | tokens | 备注 |
|---|---|---|---|---|---|---|---|
| TODO | 0.128.0 | 0.128.0 | TODO | pending | — | — | 等本地 OPENAI_API_KEY 跑一次 |

## 下一步

- PASS → 不动 RFC 03，进入 Spike 2（事件 schema 验证）
- FAIL → 在 RFC 03 修订 §5.2，把"程序化注入"改为"安装时写 config.toml"；详细兜底方案已在 RFC 03 Appendix B
