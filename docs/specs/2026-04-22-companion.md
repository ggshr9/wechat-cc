# Companion Spec (Phase 2 → 3 · Sub-spec 2)

**Status**: Draft · 2026-04-22
**Target**: v1.1 foundation · v1.2 recall · v1.3 archival
**Supersedes**: the originally-scoped `/cron` sub-spec (Companion fully subsumes it)

---

## Goal

Turn wechat-cc from reactive bridge into a long-running AI presence that can:
- Hold a sense of *who the user is* and *what they care about* (Core Profile + later Recall/Archive).
- Proactively reach out — but only with the user's opt-in, within rate limits, and with clear rationale.
- Present as distinct user-pickable **人格 / Personas** (the user facet of the Companion Layer).

RFC §4 defined this as the "灵魂，独家" layer. This spec takes it from concept to implementation, sliced across v1.1 → v1.3.

---

## Non-goals (v1.1)

- No automatic persona switching (explicit-only; daemon never infers).
- No memory retrieval beyond `profile.md` being injected into systemPrompt.
- No archival summaries. No vector search. No embeddings.
- No custom-persona creation tool — users who want a third persona drop a markdown file.
- No multi-user / multi-chat-simultaneous support — single primary chat.
- No dashboard / web UI.
- No calendar / webhook / MCP-external triggers — `exec` (shell command with diff) is the only trigger type.

---

## Personas (人格)

### Data model

Each persona is one markdown file at `<stateDir>/companion/personas/<name>.md`. Files are *hand-editable* — the entire configuration of a persona is visible in that single file.

File format:

```markdown
---
name: assistant
display_name_zh: 小助手
display_name_en: Assistant
max_pushes_per_day: 3
push_propensity: strict
quiet_hours_local: "00:00-08:00"
---

# 系统提示（System Prompt）

你现在的人格是"小助手"。你在 wechat-cc 的消息通道里帮助作者完成工作。

规则：
- 回复简短、具体、可执行。不寒暄，不铺垫。
- 代码块用 fenced code blocks，引用具体文件:行号。
- 主动推送（来自 trigger 决策时）：只在真的需要行动时推送。"CI 挂了"算；"项目看起来挺稳"不算。
- 如果工具返回 error，直接说失败原因，不修饰。

---

# 推送规则（Push Rules）

**要推送的情况：**
- 需要用户本人做决定（审批、冲突、确认）
- 有阻塞（CI 红、部署失败、merge conflict）
- 时间敏感（今天要交、周末要合）

**不要推送的情况：**
- 信息性更新（build 绿了、PR 被 review 了）
- 周期性检查的无变化结果
- 社交 / 问候
```

Front-matter fields (YAML, parsed at load):
- `name` (string, matches filename slug)
- `display_name_zh`, `display_name_en` (string)
- `max_pushes_per_day` (number)
- `push_propensity` (enum: `'strict' | 'lenient'`) — tuning knob for trigger evaluation prompt
- `quiet_hours_local` (string, `HH:MM-HH:MM`, empty = always quiet) — suppresses proactive pushes in window

Below front-matter: two markdown sections, `# 系统提示（System Prompt）` and `# 推送规则（Push Rules）`. The full file content (including the push-rules section) is embedded in the Claude systemPrompt when a session uses this persona — push rules *are* instructions, not DSL.

### Built-in personas shipped in v1.1

- `assistant.md` — 小助手. Strict push propensity, 3 pushes/day, work-tone.
- `companion.md` — 陪伴. Lenient push propensity, 5 pushes/day, warmer tone, slower rhythm.

Both as real files on disk (written by `wechat-cc setup` or lazy-created by the daemon on first Companion use). Users freely edit; we re-read on each session spawn (no persistent in-memory copy).

### Profile.md — the global user facts + per-project persona defaults

`<stateDir>/companion/profile.md`:

```markdown
# User Profile

## Identity
- name: nate
- timezone: Asia/Shanghai
- active_hours: 09:00-23:30 (weekday) / 11:00-01:00 (weekend)
- preferred_language: zh-CN

## Per-project persona defaults
| alias        | path                              | default_persona |
|--------------|-----------------------------------|-----------------|
| wechat-cc    | ~/.claude/plugins/local/wechat    | assistant       |
| notes        | ~/notes                           | companion       |
| _default     | (daemon launch cwd)               | assistant       |

## Long-term goals / ongoing threads
(Claude writes here over time; user edits freely)
```

Loaded at session-spawn time, merged into systemPrompt *before* the persona's own system-prompt text:

```
[profile.md content]
---
[personas/<current-persona>.md content]
---
[existing channel-tag rules from Phase 1]
```

Persona markdown wins on tone / push rules; profile markdown wins on identity facts.

---

## Trigger architecture (per-project proactive)

Each project has zero or more triggers. A trigger is stored in `config.json`:

```json
{
  "enabled": true,
  "per_project_persona": { "wechat-cc": "assistant", "notes": "companion" },
  "triggers": [
    {
      "id": "ci-monitor",
      "project": "wechat-cc",
      "command": "gh run list --limit 5 --json status,conclusion,name,event,headBranch,createdAt",
      "interval_minutes": 10,
      "on_change": true,
      "chat_id": "o9cq800sObd3lbrHBgiItB1pooDQ@im.wechat",
      "personas": ["assistant"]
    }
  ]
}
```

### Scheduler

Single interval (default 1 minute) iterates `triggers[]`:
1. If `trigger.personas` doesn't contain the project's *currently active* persona → skip.
2. If `interval_minutes` since last eval hasn't elapsed → skip.
3. Run `trigger.command` in the project cwd. Capture stdout+stderr+exit.
4. If `on_change` and stdout+stderr is byte-identical to last run → skip; just update `last_eval_at`.
5. If quiet-hours is active for the persona AND the trigger isn't marked critical → skip.
6. Check global rate limit for persona+day → if exceeded, skip + log `rate_limited`.
7. Otherwise: dispatch to **isolated Agent SDK session** (see below) for evaluation.

Scheduler state persisted to `companion/scheduler-state.json`:
```json
{
  "ci-monitor": {
    "last_eval_at": "2026-04-22T10:20:00Z",
    "last_stdout_hash": "sha256:...",
    "last_push_at": "2026-04-22T10:20:04Z",
    "pushes_today": 2
  }
}
```

### Isolated evaluation session

For each trigger that passes the gate, daemon spawns a fresh Agent SDK `query()`:

```ts
const result = await query({
  prompt: buildEvalPrompt(trigger, stdout, stderr, profile, persona),
  options: {
    cwd: project.path,
    systemPrompt: profile.content + '\n---\n' + persona.content,
    mcpServers: { wechat: mcp.config },  // same MCP as user sessions
    canUseTool: evalCanUseTool,           // restrictive: only recall_search (v1.2+) and emit_decision
    permissionMode: 'acceptEdits',        // non-interactive; no user to ask
  },
})
// consume messages until we see a 'result' message with emit_decision's JSON
```

`buildEvalPrompt` yields:

```
<trigger name="ci-monitor" run_at="2026-04-22T10:20:00Z">
  <command>gh run list --limit 5 --json ...</command>
  <stdout>
    [... actual output ...]
  </stdout>
  <stderr></stderr>
  <diff_from_last>
    + new entry: run #1234 status=completed conclusion=failure name="ci"
    - removed: (none)
  </diff_from_last>
</trigger>

现在评估：是否要推送？
你必须用 emit_decision 工具以 JSON 格式回答，不要用 reply。
JSON 格式：
  {
    "should_push": boolean,
    "message": string (if should_push=true; 中文; <=300 chars),
    "reason": string (always; <=200 chars),
    "cooldown_minutes": number (default 0 means no cooldown)
  }
```

New tool `emit_decision` (only registered in isolated sessions, not in user sessions):
```ts
tool(
  'emit_decision',
  '在 trigger 评估时返回决定。push 决定必须经此工具。',
  {
    should_push: z.boolean(),
    message: z.string().max(300).optional(),
    reason: z.string().max(200),
    cooldown_minutes: z.number().min(0).optional(),
  },
  async (decision) => { /* daemon captures; returns ok */ },
)
```

If Claude uses `reply` or any tool other than `emit_decision` inside an isolated eval session, daemon treats that as an error (log + skip push).

### Push execution

If `should_push === true`:
1. Log to `push-log.jsonl`:
   ```json
   {"ts":"...","trigger_id":"ci-monitor","persona":"assistant","message":"...","reason":"...","cooldown_minutes":0}
   ```
2. Call `ilink.sendMessage(trigger.chat_id, message)` (existing infra).
3. Bump `pushes_today` for this persona.
4. Track outcome (v1.2+): if user replies within N minutes, mark entry `outcome: 'replied'`.

### Opt-in, throttling, quiet hours

- `config.json.enabled` defaults to `false`. User invokes `companion_enable` tool to flip.
- Global rate limit: per-persona `max_pushes_per_day` from front-matter.
- Per-trigger cooldown: honor `cooldown_minutes` returned by `emit_decision`.
- Quiet hours: per-persona, from front-matter.
- Emergency halt: user sends natural-language "停" / "snooze 3h" / "别烦我" → daemon pattern-match (a small regex set in Phase 1 style) → pauses all triggers + sends acknowledgment via `reply`. Stored in `config.json.snooze_until`.
- Manual disable: `companion_disable` tool → flips `enabled=false`, scheduler halts next tick.

---

## Tool surface (new in v1.1)

All follow the Phase 1 configure-by-conversation pattern (no terminal). Added via `buildWechatMcpServer`.

| Tool | Purpose | Scope |
|---|---|---|
| `companion_enable()` | Flip `enabled` to true. First call scaffolds `profile.md` + `personas/assistant.md` + `personas/companion.md` from embedded templates if absent. | User session |
| `companion_disable()` | Flip `enabled` to false. Scheduler halts next tick. | User session |
| `companion_status()` | Return `{enabled, per_project_persona, trigger_count, pushes_today, next_eval_at}` for CLI + diagnostic. | User session |
| `persona_switch({project?, persona})` | Set `per_project_persona[project]=persona`. If `project` omitted, use current project. | User session |
| `persona_list()` | List installed personas: `[{name, display_name_zh, display_name_en}]` — reads `personas/` directory. | User session |
| `trigger_add({id, project, command, interval_minutes, on_change, chat_id, personas})` | Append to `config.json.triggers`. Validates: id unique, command non-empty, interval ≥ 1min. | User session |
| `trigger_list({project?})` | List triggers (optional project filter). | User session |
| `trigger_remove({id})` | Remove by id. | User session |
| `trigger_pause({id, minutes?})` | Temporarily disable. If `minutes` omitted, pause indefinitely. | User session |
| `emit_decision({should_push, message?, reason, cooldown_minutes?})` | Only registered in isolated eval sessions. Captures the decision. | Isolated session |

Tool count: Phase 1 shipped 11; voice spec adds 3 (total 14); this spec adds 9 user-session tools + 1 isolated-only = **23 user-session tools + 1 internal** in v1.1.

If tool-count concerns arise (model gets confused with >20 tools), we group: `companion_*` prefix on 3 + `persona_*` on 2 + `trigger_*` on 4 suggests a natural refactor into MCP sub-servers, but that's v1.2 territory. 14→23 is a jump; worth a spike.

---

## File layout for v1.1

```
~/.claude/channels/wechat/
├── [existing Phase 1 files]
└── companion/
    ├── profile.md              ← scaffolded on companion_enable
    ├── personas/
    │   ├── assistant.md        ← scaffolded on companion_enable
    │   └── companion.md        ← scaffolded on companion_enable
    ├── config.json             ← {enabled, per_project_persona, triggers[], snooze_until?}
    ├── scheduler-state.json    ← per-trigger last-eval state
    └── push-log.jsonl          ← append-only audit
```

All under `<stateDir>/companion/` — a clean boundary from Phase 1 state files. Easy to `rm -rf ~/.claude/channels/wechat/companion/` to reset.

---

## User flows (v1.1)

### Flow 1: First-time setup (5 minutes)

```
User: /wechat:companion enable  (or just: "开启 companion")
Claude: companion_enable() → scaffolds files → returns {ok, profile_path, personas_installed:[...]}
Claude: "开好了。两个人格已经装好：小助手（干活）、陪伴（陪聊）。默认按项目配：
         wechat-cc 这类工作仓库走小助手，其他走小助手。要改人格就说"切到陪伴"。
         现在你有推送触发器要加吗？例如 CI 监控、git 未提交提醒等。"
User: 加个 CI 监控
Claude: trigger_add({id:'ci', project:'wechat-cc', command:'gh run list --json ...', interval_minutes:10, on_change:true, chat_id:<current>, personas:['assistant']})
        "加好了。10 分钟轮询一次，只在状态变化时考虑推送。今日推送上限 3 条。"
```

### Flow 2: Persona switch

```
User: 切到陪伴
Claude: persona_switch({persona:'companion'}) → {ok, project:'wechat-cc', persona:'companion'}
        "切成陪伴了。"
```

(Future messages in this project use companion persona's system prompt + rules.)

### Flow 3: Proactive push

```
[10:15:00] scheduler ticks for 'ci' trigger
[10:15:01] runs gh run list → stdout hash differs from last
[10:15:02] spawns isolated eval session with assistant persona + trigger context
[10:15:09] Claude emits: {should_push:true, message:"CI 炸了：run 1234 failed on main。tests/session-manager.test.ts:12 超时。", reason:"status changed to failure", cooldown_minutes:30}
[10:15:10] daemon sendMessage → WeChat
[10:15:10] push-log.jsonl += {...}
```

### Flow 4: Emergency halt

```
User: 别烦我
Claude (reactive, user session): detects halt intent → calls companion_disable() or sets snooze_until
        "好，停 3 小时。之后恢复。"
```

---

## Spike items (Phase 2 Task 0-group)

Before or during v1.1 implementation:

**Spike 5 — isolated eval session stability**
- Cold-spawn latency: Spike 1 showed ~11s. How much of that is Agent SDK init vs. model time? Target: <5s per eval so a 10-eval/hour trigger scheduler doesn't stack up.
- Does Agent SDK's prompt-cache cover isolated sessions? If not, ~$0.02/eval × 100 evals/day = $2/day — affordable but not ideal.
- Does the isolated session honor `canUseTool` restrictions cleanly, or does Claude sometimes try `reply` anyway?

**Spike 6 — tool count impact on model decision quality**
- Phase 1 has 11 tools + 3 voice + 9 companion + 1 isolated = 14 user tools in voice; 23 in companion.
- Is there noticeable regression in tool-selection quality as we grow this? If yes, MCP sub-server split (`wechat`, `wechat_voice`, `wechat_companion`) is warranted for v1.2.

**Spike 7 — emergency-halt pattern matching**
- Which regex set is robust enough? Initial: `/别烦我|停|snooze|shut up|stop/i` + Claude consults `companion_disable` tool when it sees one.
- Risk: Claude over-interprets casual "别烦我" in a joke.

---

## Testing (v1.1)

- Unit tests for persona front-matter parser, trigger validation, scheduler-state diff.
- Integration test: spawn isolated session with a known trigger stdout → assert `emit_decision` called with expected JSON shape (mock provider).
- E2E (Task 16-style): enable Companion via real WeChat, add a trigger that always changes (e.g. `date`), wait for a push, verify log entry.

---

## Roadmap beyond v1.1

- **v1.2**: `recall.md` daily logs + `recall_search` tool; weekly compaction → `archive/YYYY-WW.md`; effect tracking (outcome column in push-log); built-in trigger templates for `git-uncommitted-eod`, `pr-review-request`.
- **v1.3**: archival summarization automation; richer persona tools (`persona_create`, `persona_edit_via_tool`); multi-chat (broadcast-persona), multi-language profile.
- **v2.0+**: dashboard, embedding-free semantic retrieval via periodic Claude-driven re-indexing, auto-suggest triggers based on user patterns.

---

## Acceptance criteria for v1.1 Companion slice

- [ ] `companion_enable` scaffolds the 4 files + directory structure correctly on a fresh install.
- [ ] `persona_switch` → next user session (or the in-flight one, if re-spawned) loads the new persona's systemPrompt.
- [ ] `trigger_add` + 1-minute scheduler tick → isolated eval session fires → push delivered in WeChat.
- [ ] Rate limit enforced: after `max_pushes_per_day`, further triggers log `rate_limited` without pushing.
- [ ] Quiet hours enforced: trigger during 23:00-08:00 (or whatever persona specifies) logs `quiet_hours` without pushing.
- [ ] `companion_disable` halts the scheduler before the next tick; no rogue evaluations.
- [ ] "别烦我" via WeChat → daemon pauses triggers for 3 hours; user gets acknowledgment.
- [ ] All markdown files are hand-editable; edits are picked up at next session spawn.
- [ ] Zero impact on reactive (non-Companion) user sessions if `enabled=false`.

---

## Cross-cutting implications

- **State dir footprint**: +1 directory tree under `companion/`; typical user after 1 month ≈ 50 KB (profile + 2 personas + config + 30 daily push-log entries).
- **New dependencies**: none external. YAML front-matter can use a tiny parser (~20 lines) or bring in `gray-matter` (small, zero-dep).
- **RFC alignment**: §4.1 Relationship Memory — profile.md is the v1.1 slice; recall + archive come in v1.2/v1.3 as planned. §4.2 Proactive Trigger — isolated-session pattern matches "Claude 自己判断". §4.3 Opt-in gating — `companion_enable` + rate limits match.
- **Reuses Phase 1 patterns**: markdown files + state JSON + configure-by-conversation + tool-based daemon<->Claude interface.
- **Foundation for later**: `emit_decision` JSON-response pattern is how any future agentic evaluator in the daemon reports back. `persona` abstraction lives naturally alongside future "skills" (domain-specific behavior packs).
