# Spike 2: Codex SDK runStreamed 事件 schema 实证

**Phase**: 0-RFC03 · Spike
**Tracks**: [RFC 03 §9 Spike 2](../../../rfc/03-multi-agent-architecture.md#9-spike-验证清单phase-0-必做)
**Goal**: 把 `@openai/codex-sdk@0.128.0` 在 runtime 真实发出的 `ThreadEvent` / `ThreadItem` 与 `dist/index.d.ts` 类型声明对齐核验，记录任何漂移。

## 为什么重要

`codex-agent-provider.ts`（RFC 03 §6）会 dispatch 每条 user msg 到 `thread.runStreamed`，把事件流翻译成 `AgentSession.onAssistantText` / `onResult` / `replyToolCalled` 这套既有协议（`claude-agent-provider.ts:142-167`）。翻译表必须基于 **runtime 真实事件结构**，否则 provider 跑起来会丢消息或抛 cast 异常。

## 已知（来自 SDK 源码）

读 `@openai/codex-sdk@0.128.0/dist/index.d.ts:104-164`：

**ThreadEvent union (8 种)**:
```ts
| { type: 'thread.started';  thread_id: string }
| { type: 'turn.started' }
| { type: 'turn.completed';  usage: Usage }
| { type: 'turn.failed';     error: { message: string } }
| { type: 'item.started';    item: ThreadItem }
| { type: 'item.updated';    item: ThreadItem }
| { type: 'item.completed';  item: ThreadItem }
| { type: 'error';           message: string }
```

**ThreadItem union (8 种)**:
```ts
| AgentMessageItem      { type: 'agent_message';      text }
| ReasoningItem         { type: 'reasoning';          text }
| CommandExecutionItem  { type: 'command_execution';  command, aggregated_output, exit_code?, status }
| FileChangeItem        { type: 'file_change';        changes, status }
| McpToolCallItem       { type: 'mcp_tool_call';      server, tool, arguments, result?, error?, status }
| WebSearchItem         { type: 'web_search';         query }
| TodoListItem          { type: 'todo_list';          items: { text, completed }[] }
| ErrorItem             { type: 'error';              message }
```

**Usage**:
```ts
{ input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens }
```

## 翻译表（RFC 03 codex-agent-provider 实现指引）

| 现有 `AgentSession` 协议 | Codex SDK 来源 |
|---|---|
| `onAssistantText(text)` | `item.completed` && `item.type === 'agent_message'` → `cb(item.text)` |
| `replyToolCalled` (本轮调过 reply) | 该轮中遇到 `item.completed` && `item.type === 'mcp_tool_call'` && `item.server === 'wechat'` && `item.tool === 'reply'` (或 `reply_voice` / `send_file` / `edit_message` / `broadcast`) |
| `onResult({ session_id, num_turns, duration_ms })` | `turn.completed` 时拼 `{ session_id: thread.id, num_turns: ++counter, duration_ms: now - turnStartedAt, usage: ev.usage }` |
| spawn 时的 `resumeSessionId` | `codex.resumeThread(threadId)` 而非 `startThread()` |
| dispatch error path | `turn.failed` (logical) + `error` (fatal stream) |

## 运行

```bash
cd docs/spike/phase0-rfc03/02-codex-events
bun install
export OPENAI_API_KEY=sk-...
bun spike.ts
```

约 15-30 秒，约 $0.02-0.05。会做：
1. 启动新 thread
2. 让 Codex 跑 `pwd` + `ls -la` 然后总结一句（触发 reasoning + command_execution + agent_message）
3. 把所有 events 写到 `events.jsonl`
4. 把对照结果写到 `summary.json`

## Pass 条件

- 未观察到任何 `event.type` ∉ `KNOWN_EVENT_TYPES`
- 未观察到任何 `item.type` ∉ `KNOWN_ITEM_TYPES`
- 未观察到任何 `usage` 上未文档化的 key
- 至少观察到：`thread.started`、`turn.started`、`turn.completed`、`item.completed{type=agent_message}`
- `thread.id` getter 与 `thread.started.thread_id` 一致

## 输出文件（spike 跑完后填回 git）

- `events.jsonl` — 每行一个 `{ elapsed, ev }`，**不要 commit**（含 thread_id 等运行时数据，加到 .gitignore）
- `summary.json` — 聚合后的 schema 检查结果，可以 commit 作为 evidence

## Fail 模式

| 现象 | 含义 | 行动 |
|---|---|---|
| 出现 undocumented event type | SDK 比文档新，加了未声明事件 | 在 RFC 03 §3.5 加 addendum；codex-agent-provider 默认忽略未知事件 |
| 出现 undocumented item type | 同上但更可能（item types 比 event types 演进快） | 同上；翻译表加 default branch 把未知 item 当 `agent_message` 处理 |
| `usage` 字段不止 4 个 | 计费 schema 变了 | 不影响功能，但 `Usage` 类型拷贝时要透传整个对象 |
| `thread.id` getter 在 thread.started 之前是 null | 文档说"populated after first turn starts"——这是文档化的，不算 fail | 实现里在 first dispatch 起 await 直到 thread.started 出来再用 |
| runStreamed 抛异常 | SDK / CLI 错误 | 看 stderr，常见 OPENAI_API_KEY 或 CLI 路径 |

## 记录结果

| 日期 | Codex SDK | OS | event types | item types | undocumented | 备注 |
|---|---|---|---|---|---|---|
| TODO | 0.128.0 | TODO | pending | pending | pending | 等本地 OPENAI_API_KEY |

## 下一步

- PASS → 翻译表落到 RFC 03 实现里；进入 Spike 3
- 任何 undocumented → 在 RFC 03 §3.5 + Appendix C 加 addendum；不阻断架构，但需要文档化
