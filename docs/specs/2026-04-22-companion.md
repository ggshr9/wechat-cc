# Companion Spec (Phase 2 → 3 · Sub-spec 2)

**Status**: v0.2 · 2026-04-22
**Target**: v1.1 foundation · v1.2 recall · v1.3 archival
**Supersedes**: the originally-scoped `/cron` sub-spec (Companion fully subsumes it)

---

## Goal

Turn wechat-cc from reactive bridge into a long-running AI presence that can proactively reach out — but only with the user's opt-in, within rhythm-based guardrails, and with two user-pickable **人格 / Personas** governing how pushes feel.

RFC §4 defined this as the "灵魂，独家" layer. This spec takes it from concept to implementation, sliced across v1.1 → v1.3.

## v0.2 departures from v0.1 (for posterity)

- **Personas are proactive-only**. Reactive user sessions use the base (Phase 1) systemPrompt, minimally extended to know about Companion tools. Tonal shifts in reactive chat emerge from Claude's natural context-reading — we don't inject full-identity roleplay there.
- **Triggers are Claude tasks, not shell commands.** Replaces the security foot-gun where the daemon's permission relay wasn't in the loop for trigger-defined commands.
- **Standard cron syntax** (`"0 22 * * *"`) replaces `interval_minutes + on_change`.
- **No hard daily push cap.** Replaced by a single safety rail (`min_push_gap_minutes`, default 10) plus recent-push context injected into each eval — Claude judges cadence based on signal, not a counter.
- **No `emit_decision` tool.** Claude either calls `reply` (push happens) or doesn't (silent completion). Daemon logs either way.
- **Dual-file scaffold + welcome** on `companion_enable` — both personas exist from day one.

---

## Non-goals (v1.1)

- No automatic persona switching (explicit-only).
- No memory retrieval beyond `profile.md` injected into isolated eval sessions.
- No archival summaries, vector search, embeddings.
- No custom-persona creation tool — users who want a third persona drop a markdown file; daemon picks it up.
- No multi-user / multi-account Companion state (single account in v1.1).
- No dashboard / web UI.
- No hot-reload of `config.json` (restart daemon to pick up changes). Markdown files (profile, personas) DO hot-reload (read per session spawn).
- No engagement-based push-budget feedback (v1.2).

---

## Personas (人格)

### Model: Proactive Persona

Personas govern **three things, nothing else**:

1. Which proactive triggers fire for a given project (via trigger `personas: [...]` filter).
2. The narrator system prompt used inside the isolated eval session that evaluates a trigger.
3. The tone of any push message that results.

They do **NOT** affect reactive (user-initiated) Claude sessions. Reactive systemPrompt is the Phase 1 channel-tag prompt, minimally extended (see §Reactive session below).

### File format

Each persona is one markdown file at `<stateDir>/companion/personas/<name>.md`. Files are hand-editable; changes picked up on next trigger eval.

```markdown
---
name: assistant
display_name: 小助手
min_push_gap_minutes: 10
quiet_hours_local: "00:00-08:00"
---

# 小助手 · 推送角色系统提示

你现在作为 "小助手" 评估一个 trigger，决定是否推送给作者。

**判断原则：**
- 必要性：这件事用户真的需要现在知道吗？若等一小时也没区别，就等。
- 频率感：看 `recent_pushes` 上下文。若刚推过类似内容，这次沉默。
- 整合：合并同类提醒（3 个 PR review 请求打包成一条，而不是三条）。
- 工作时段偏好：代码块、文件路径、精简、直接。

**要推的情况：**
- 用户本人要做决定（审批、冲突、确认）
- 有阻塞（CI 红、部署失败、merge conflict）
- 时间敏感（今天要交、周末要合）

**不要推的情况：**
- 信息性更新（build 绿了、PR 被 review 了）
- 周期性检查的无变化结果
- 纯社交 / 问候（那是 "陪伴" 人格的事）

**推送格式：**
- 中文为主，简短直接
- 引用具体文件:行号
- 代码块用 fenced
- ≤ 200 字

若决定推送：调用 `reply(chat_id, message)` 工具。
若决定不推送：什么都不做，让这轮安静结束。

---

# 用户还有另一个人格 "陪伴"

轻盈、温暖、偏向生活侧。若对话氛围合适（用户明显累了、抱怨工作太久没休息），可以轻轻提一句 "要切到陪伴聊会儿吗？"。不推销，只在时机明显时一句带过。
```

Front-matter fields (YAML; parsed at load, stripped before systemPrompt injection):
- `name` (string, matches filename slug)
- `display_name` (string, zh)
- `min_push_gap_minutes` (number; default 10; safety rail against runaway)
- `quiet_hours_local` (string `HH:MM-HH:MM`; empty = no quiet hours)

Everything after front-matter is the persona's body — injected as-is into the isolated eval session's `systemPrompt`. The body is where persona "character" lives; the daemon is policy-light, content is markdown-heavy.

### Built-in personas shipped in v1.1

Both scaffolded on first `companion_enable`:
- `personas/assistant.md` — 小助手. Strict propensity, work tone.
- `personas/companion.md` — 陪伴. Lenient propensity, warm tone, intro to natural check-ins.

Malformed persona files are logged and skipped; `companion_status` only reports loadable personas.

### Persona resolution chain (per project)

At trigger-eval time, daemon picks the active persona via:
1. `config.per_project_persona[project_alias]` if set
2. else `config.per_project_persona._default` if set
3. else hardcoded fallback: `assistant`

---

## profile.md — user facts as free markdown

`<stateDir>/companion/profile.md`. **Unstructured markdown**, never parsed by the daemon. Injected verbatim into isolated eval session systemPrompt before the persona body.

Scaffolded template on first enable:

```markdown
# 用户信息

(Claude 会在与用户聊天中，根据你提供的信息持续更新这份文件。你也可以直接编辑它。)

## 身份
- 名字：<待确认>
- 时区：<自动填充，基于系统时区>
- 活跃时段：<工作日 09:00-23:00 / 周末 11:00-01:00（默认，可编辑）>

## 长期目标 / 在意的事

## 最近在做

## 偏好
- 回复语言：中文
- 代码块语言偏好：中文注释 + 英文代码

## push 偏好
- 需求多时可以每天几次；没回响时退潮
- 偶尔的关心 OK；不要为刷存在感而频繁问候
```

Timezone precedence: `profile.md` can declare it in free text; daemon doesn't parse. For `quiet_hours_local` enforcement, daemon reads `config.json.timezone` (written by `companion_enable` from `Intl.DateTimeFormat().resolvedOptions().timeZone` at scaffold time). User changes via `config.json` edit + daemon restart.

---

## Triggers (Claude tasks, cron-scheduled)

### Data shape

Triggers persisted in `config.json`:

```json
{
  "enabled": true,
  "timezone": "Asia/Shanghai",
  "per_project_persona": {
    "wechat-cc": "assistant",
    "notes": "companion",
    "_default": "assistant"
  },
  "default_chat_id": "o9cq800sObd3lbrHBgiItB1pooDQ@im.wechat",
  "snooze_until": null,
  "triggers": [
    {
      "id": "ci-monitor",
      "project": "wechat-cc",
      "schedule": "*/10 9-22 * * 1-5",
      "task": "用 `gh run list --branch main --limit 5 --json ...` 查看最近 CI。若最后一次是失败且尚未推送过（见 recent_pushes 上下文），按 '小助手' 原则决定是否推送。",
      "personas": ["assistant"],
      "on_failure": "silent",
      "created_at": "2026-04-22T10:30:00Z"
    },
    {
      "id": "evening-checkin",
      "project": "notes",
      "schedule": "0 19 * * 1-5",
      "task": "评估是否适合和用户做一次轻量晚间关心。读 profile 和最近 24h push_log。若今天用户已经收到过关心消息，多半不要重复；若看起来在抱怨或疲惫，适合问候；若在忙，不要打断。",
      "personas": ["companion"],
      "on_failure": "silent",
      "created_at": "2026-04-22T10:31:00Z"
    }
  ]
}
```

Trigger fields:
- `id` (string, unique within triggers)
- `project` (string, matches project alias; `_default` for fallback project)
- `schedule` (string, standard 5-field cron syntax in `timezone`; parsed by `croner` or `node-cron`)
- `task` (string, Claude prompt — describes what to evaluate; NOT a shell command)
- `personas` (string[]; trigger fires only when current active persona for the project matches; `[]` means "any")
- `on_failure` (enum: `"silent"` | `"notify-user"` | `"retry-once"`)
- `created_at` (ISO, daemon-written)

### Schedule semantics

`schedule` is standard 5-field cron: `"minute hour day-of-month month day-of-week"`. Evaluated in the `timezone` from `config.json`. Minimum effective tick = the scheduler's coarse tick (1 min) — if the cron expression would fire more than once per minute, extras are collapsed.

**Minimum gap constraint** is independent: `min_push_gap_minutes` on the active persona is enforced regardless of schedule. If the schedule fires but gap since last push <10min → eval still runs (for logging + run history), but push is suppressed.

### Scheduler tick loop

Single interval timer (1-minute granularity). On each tick:

1. Load `config.json`; if `snooze_until > now` → skip entire tick, log `snoozed`.
2. If `config.enabled === false` → no ticks (scheduler halted on disable).
3. For each `trigger` in `config.triggers`:
   a. Skip if schedule doesn't match current minute.
   b. Resolve project's active persona via resolution chain.
   c. Skip if `trigger.personas` non-empty AND persona not in list → log `skipped_persona`.
   d. Skip if persona's quiet_hours active for current time in `timezone` → log `skipped_quiet_hours`.
   e. Check `min_push_gap_minutes` vs. last push across all triggers for this persona → if gap not met, we still evaluate but suppress push (log `would_push_but_gap_enforced` or `silent`).
   f. Spawn isolated eval session with task (see below).

Daemon startup: reads `config.json`, computes "next valid fire time" for each trigger. Overdue triggers (last_eval older than one interval) do NOT retroactively fire — we start clean on next valid minute. Stated explicitly to avoid post-restart flood.

### Isolated eval session

Fresh Agent SDK `query()` per trigger fire:

```ts
const result = await query({
  prompt: buildTaskPrompt(trigger, profile, persona, recentPushes, recentRuns),
  options: {
    cwd: projectPath,
    systemPrompt: profileContent + '\n---\n' + personaBody,  // front-matter stripped
    mcpServers: { wechat: mcp.config },        // full user tools available
    permissionMode: 'bypassPermissions',       // matches Claude Code's default; see §Security
    settingSources: ['user', 'project', 'local'],
  },
})
// Wait for the session to reach a 'result' message.
// If during the session, the 'reply' tool was invoked → a push happened.
// If not → silent completion.
```

`buildTaskPrompt`:

```xml
<eval_context>
  <trigger id="ci-monitor" persona="assistant" project="wechat-cc" />
  <current_time local="2026-04-22 10:20" timezone="Asia/Shanghai" />
  <recent_pushes last_24h="2">
    <push ts="2026-04-22 09:15" msg="CI 炸了..." trigger="ci-monitor" />
    <push ts="2026-04-22 10:00" msg="..." trigger="..." />
  </recent_pushes>
  <recent_runs trigger="ci-monitor" last_24h="6" last_push="2026-04-22 09:15" />
  <min_push_gap_minutes>10</min_push_gap_minutes>
</eval_context>

任务：
<task>
用 `gh run list --branch main --limit 5 --json ...` 查看最近 CI。
若最后一次是失败且尚未推送过（见 recent_pushes 上下文），按 "小助手" 原则决定是否推送。
</task>

若决定推送，调用 reply(chat_id="{default_chat_id}", text=...)。
若不推送，直接完成本轮——不要调用 reply，也不要解释理由。
```

Task language is flexible; the daemon doesn't constrain it beyond "reply is the push mechanism, silence is the don't-push mechanism".

`chat_id` is defaulted from `config.default_chat_id` (set by daemon when first inbound message arrives).

### Logging: two append-only files

- `runs.jsonl`: every eval attempt, regardless of outcome. Fields: `{ts, trigger_id, persona, duration_ms, pushed: bool, reason: string, tool_uses_count: number, cost_usd: number}`. Rotated at 10 MB.
- `push-log.jsonl`: subset — entries where `pushed=true`. Also includes `message`, `chat_id`, `delivery_status`, `delivered_at`. Rotated at 10 MB.

Both live under `<stateDir>/companion/`.

### Security model for triggers

Isolated eval sessions use `permissionMode: 'bypassPermissions'` — the same default Claude Code itself ships with when users pass `--dangerously-skip-permissions`. Rationale:

- Triggers are **prompts**, not scripts. The attack surface is task content written by the user (or Claude, via `trigger_add`). User owns their own prompts.
- Claude is trained to recognize destructive ops and confirm via natural language before performing them. In a trigger context this means: if a task gets Claude into a position where `rm -rf` feels warranted, Claude will either (a) not do it and emit a push asking the user, or (b) reach for safer tools (`ls`, `git status`) first. In practice, trigger tasks are evaluation-shaped ("check X, push if Y"), not action-shaped.
- Forcing a permission prompt during eval would stall the scheduler tick on a sleeping user's WeChat — breaking the whole point of proactive triggers.

Users who want stricter behavior can:
- Scope the task description ("check CI; do NOT modify any files").
- Restrict `mcpServers` or `tools` via persona front-matter (v1.2 escape hatch).

README note: *"Triggers run with the same permission model as Claude Code's `--dangerously-skip-permissions`. Dangerous actions Claude will ask about before doing; evaluation tasks don't touch state. Review `runs.jsonl` if anything feels off."*

---

## Snooze & emergency halt

Claude-driven via tool, not daemon regex:

```ts
tool(
  'companion_snooze',
  '暂停所有主动推送若干分钟。用户说 "别烦我"/"停"/"snooze"/"shut up" 等时调用。',
  { minutes: z.number().min(1).max(24*60).default(180) },
  async ({ minutes }) => { /* writes config.snooze_until; returns {ok, until} */ },
)
```

Persona system prompts (appended to reactive systemPrompt when Companion is enabled) contain:

> 若用户显然在表达"停止打扰"（"别烦我" / "stop" / "snooze N 小时" / "shut up" 等），调用 `companion_snooze` 工具。默认暂停 3 小时；用户若指定时长按指定；然后简短确认。

Over-matching risk: user asks "how do I use 别烦我?" — Claude should recognize the meta-question and NOT snooze. Documented as a limitation; if it misfires, user calls `companion_disable` explicitly.

---

## Tool surface

New tools in v1.1 (added to `buildWechatMcpServer`):

| Tool | Purpose |
|---|---|
| `companion_enable()` | Flips `enabled=true`. On first call: scaffolds `profile.md` + `personas/assistant.md` + `personas/companion.md` + `config.json`. Returns welcome message text for Claude to deliver. |
| `companion_disable()` | Flips `enabled=false`. Scheduler halts next tick. |
| `companion_snooze({minutes?})` | Writes `config.snooze_until = now + minutes`. Default 180 min. |
| `companion_status()` | Returns `{enabled, timezone, per_project_persona, personas_available: [{name, display_name}], triggers: [{id, project, schedule, personas, next_fire_at, last_run_at, last_pushed_at}], snooze_until, pushes_last_24h, runs_last_24h}`. Consolidated view — replaces separate list tools. |
| `persona_switch({persona, project?})` | Updates `config.per_project_persona[project]=persona` (current project if omitted). Returns `{ok, project, persona}`. No session forced-close needed — personas are proactive-only, reactive isn't affected. |
| `trigger_add({id, project, schedule, task, personas?, on_failure?})` | Appends to `config.triggers`. Validates: id unique within file, schedule parses, project known. Returns `{ok, next_fire_at}`. |
| `trigger_remove({id})` | Removes from `config.triggers`. |
| `trigger_pause({id, minutes?})` | Disables a trigger temporarily (or indefinitely if minutes omitted). Persisted via `paused_until` field on the trigger. |

**Tool count math:**
- Phase 1: 11
- Voice: 3
- Companion: 8 (this list)
- **Total in-user-sessions: 22.** Running Spike 6 pre-implementation to check model behavior at this count; if degraded, MCP sub-server split (`wechat-core`, `wechat-voice`, `wechat-companion`) is v1.2's first task.

### `persona_list` and `trigger_list` removed

Folded into `companion_status`. Claude asks status, gets everything at once.

### Removed `emit_decision`

Not needed. Isolated eval session signals push-or-not by calling (or not calling) `reply`.

---

## Reactive session behavior

Phase 1's reactive systemPrompt is extended ONLY when Companion is enabled. The extension, appended after the Phase 1 channel rules, is short:

```
---
Companion 功能已开启。用户当前项目默认人格：{current_persona}。

可用工具：
- companion_snooze: 用户说"别烦我"/"停"/"snooze N 小时"时调用
- companion_disable: 用户明确要关闭推送时调用
- persona_switch: 用户说"切到陪伴"/"换回小助手"时调用
- companion_status: 用户问"当前怎么样"/"都有什么提醒"时调用
- trigger_add / trigger_remove / trigger_pause: 用户说"加个 X 监控"/"删掉 X"/"暂停 X"时调用

反应式对话由你自然判断语气。Companion 的人格只影响主动推送的角色；此刻你是 Claude 本人。
```

No persona-tone injection into reactive systemPrompt. No tone pinning. Claude reads the room.

---

## Scaffold & welcome flow

### First call to `companion_enable`

1. Create `<stateDir>/companion/` directory (mode 0700 on POSIX).
2. Write `profile.md` from template (with inferred timezone filled in).
3. Write `personas/assistant.md` from embedded template.
4. Write `personas/companion.md` from embedded template.
5. Write `config.json` with `enabled=true`, `timezone` inferred, `per_project_persona={_default: "assistant"}`, `default_chat_id` set from the current session's chat context (passed via a session-local), `triggers=[]`, `snooze_until=null`.
6. Initialize empty `runs.jsonl` + `push-log.jsonl`.
7. Return payload:

```ts
{
  ok: true,
  state_dir: '<absolute path>',
  personas_scaffolded: ['assistant', 'companion'],
  welcome_message: `
开启完成。两个人格已经装好：
- 小助手（当前默认）：干活为主，推送从严。CI / PR / 部署故障会提醒。
- 陪伴：聊天为主，推送更随性。下班时段切过去比较舒服。

目前还没配任何触发器。要加提醒就说 "加个 CI 监控" / "每周五下午提醒我写周记" 这类。
要切人格就说 "切到陪伴"。要暂停就说 "别烦我" 或 "snooze 3 小时"。
`,
  cost_estimate_note: `
主动推送每次评估走 Claude Agent SDK 一次短会话，典型成本约 $0.01/次。
频率由你的触发器决定；默认只提醒明显需要动手的事。
`,
}
```

Claude receives this from the tool, calls `reply` with the welcome text to the user. (The natural flow is: user asks "开启 companion" → Claude calls `companion_enable` → Claude calls `reply` with welcome.)

### Subsequent calls to `companion_enable`

Idempotent: flips `enabled=true` if disabled, does NOT overwrite existing persona / profile files. Returns brief `{ok, already_configured: true}` signal; Claude responds naturally.

---

## File layout for v1.1

```
~/.claude/channels/wechat/
├── [Phase 1 files]
└── companion/
    ├── profile.md
    ├── personas/
    │   ├── assistant.md
    │   └── companion.md
    ├── config.json               (ops: enabled, timezone, triggers[], per_project_persona, snooze_until, default_chat_id)
    ├── runs.jsonl                (append-only, rotated 10MB; every eval)
    └── push-log.jsonl            (append-only, rotated 10MB; pushes only)
```

---

## User flows

### Flow 1 — First-time enable

```
User: 开启 companion
Claude → companion_enable() → {ok, welcome_message, cost_estimate_note}
Claude → reply(chat_id, welcome_message + "\n\n" + cost_estimate_note)
        "开启完成。两个人格已经装好..."
```

### Flow 2 — Add a trigger

```
User: 加个 CI 监控，每 10 分钟检查一次 main 分支
Claude → trigger_add({
  id: 'ci-monitor',
  project: 'wechat-cc',
  schedule: '*/10 * * * *',
  task: '用 `gh run list --branch main --limit 5 --json ...` 查看 CI ...',
  personas: ['assistant'],
  on_failure: 'silent',
}) → {ok, next_fire_at: '2026-04-22 10:30'}
Claude → reply "加好了。10 分钟一次，下一次评估在 10:30。"
```

### Flow 3 — Persona switch

```
User: 切到陪伴
Claude → persona_switch({persona: 'companion'}) → {ok, project: 'wechat-cc', persona: 'companion'}
Claude → reply "好，wechat-cc 切到陪伴了。"
```

Subsequent pushes for `wechat-cc` project will use companion persona's system prompt + narrator tone.

### Flow 4 — Proactive push

```
[10:30:00] scheduler tick matches ci-monitor's cron
[10:30:00] daemon resolves active persona for wechat-cc → assistant
[10:30:00] min_gap check: last push for assistant was 09:15 → gap 75min OK
[10:30:00] spawns isolated query() with profile.md + personas/assistant.md + eval_context XML
[10:30:08] Claude reads task, uses Bash tool → gh run list JSON
[10:30:12] Claude decides: run 1234 failed, last push didn't mention it → push
[10:30:12] Claude calls reply(chat_id, "CI 炸了：run 1234 failed ...") → daemon logs push
[10:30:12] runs.jsonl += {..., pushed: true, duration_ms: 12000, cost_usd: 0.012, ...}
[10:30:12] push-log.jsonl += {...}
[10:30:13] WeChat received message
```

### Flow 5 — Snooze

```
User: 别烦我 2 小时
Claude (reactive, user session): recognizes snooze intent
Claude → companion_snooze({minutes: 120}) → {ok, until: '2026-04-22 13:00'}
Claude → reply "好，停 2 小时。13:00 恢复。"
[scheduler ticks during snooze → logged as 'snoozed', no evals]
```

### Flow 6 — Disable

```
User: 关掉 companion
Claude → companion_disable() → {ok, enabled: false}
Claude → reply "关掉了。要再开就说 '开启 companion'。"
[scheduler halts next tick; in-flight eval (if any) completes and logs]
```

### Flow 7 — Status

```
User: 看下当前 companion 状态
Claude → companion_status() → { ... full blob ... }
Claude → reply (formatted summary, e.g. "开着，时区 Asia/Shanghai。
  当前人格 per 项目：wechat-cc → 小助手, notes → 陪伴.
  触发器 2 个：
    - ci-monitor (wechat-cc, 每 10 分钟)，上次评估 10:30，上次推送 09:15
    - evening-checkin (notes, 每周 1-5 的 19:00)，尚未触发
  过去 24 小时推送 3 次 / 评估 58 次。")
```

---

## Spike items (run before Phase 2 implementation)

**Spike 5 — isolated eval session latency + cache**
- Cold-spawn latency target: ≤ 5s per eval. Spike 1 saw ~11s with no prompt cache; isolated sessions with stable systemPrompt should hit cache better.
- Measure: 20 sequential evals with same persona + task-template, different context XML. Record p50/p95 wall time + cost.
- Decision: if p50 > 5s consistently, pool isolated sessions (small process pool, recycle with explicit context reset). Else accept spawn-per-eval.

**Spike 6 — tool count impact**
- Test model tool-selection quality at 22 tools (post-v1.1 count). 
- Compare against 11-tool baseline (Phase 1).
- If regression detected, MCP sub-server split becomes v1.2 Task 0.

**Spike 7 — cron expression edge cases + timezone**
- Verify `croner` (or chosen lib) handles DST transitions in Asia/Shanghai (no DST — easy) and a DST timezone (e.g. America/New_York) correctly.
- Edge: cron scheduled for 02:30 on a spring-forward day — does it fire / skip / double-fire?

(Spike 8 was about `canUseTool` stalling scheduler ticks; resolved by the §Security decision — isolated eval uses `bypassPermissions`, no permission prompt during eval.)

---

## Testing

Unit:
- Persona front-matter parser: valid / malformed / missing-name / extra fields.
- Cron schedule parser: typical + edge cases.
- Persona resolution chain: all 3 fallback levels.
- Scheduler `min_push_gap` enforcement across triggers for same persona.
- Scaffold idempotency: re-enable after disable.

Integration:
- Mock Agent SDK `query()`: trigger tick → verify isolated session spawn with correct systemPrompt (profile + persona).
- Mock ilink: Claude's `reply` call during eval → push-log entry + runs-log entry.
- Silent completion: eval that doesn't call reply → runs entry only, no push entry.

E2E (Task 16-style):
- Enable Companion via WeChat.
- Add a trigger using a task like "出当前时间和你的运行模式，若现在是偶数分钟则推送；否则不推送" — deterministic.
- Wait across minute boundary; verify exactly one push when expected.
- Snooze; verify scheduler halts within 1 tick.

---

## Acceptance criteria for v1.1

- [ ] `companion_enable` scaffolds 5 files + directory, idempotent on re-run.
- [ ] Welcome message delivered to user via `reply` on first enable.
- [ ] `persona_switch` flips config; next trigger fire for that project uses new persona. Reactive session responses are unchanged (Claude still Claude).
- [ ] `trigger_add` with cron syntax + task → scheduler picks up on next minute boundary; eval runs in isolated session.
- [ ] Claude's `reply` call inside eval → push-log entry + delivered in WeChat.
- [ ] Silent completion (no reply call) → runs entry only, no push.
- [ ] `min_push_gap_minutes` honored across triggers for same persona.
- [ ] Quiet hours honored (per-persona).
- [ ] `companion_snooze` halts scheduler for specified duration; resumes automatically.
- [ ] `companion_disable` halts scheduler; in-flight eval (if any) completes and logs.
- [ ] Markdown files (profile.md, personas/*.md) hot-reload — edit file, next eval reflects changes.
- [ ] `config.json` does NOT hot-reload — document this; daemon restart required.
- [ ] Zero impact on Phase 1 reactive sessions when `enabled=false`.

---

## Roadmap beyond v1.1

- **v1.2**: Recall layer — `recall/YYYY-MM-DD.md` daily logs auto-appended by daemon (mirror of incoming + outgoing messages). `recall_search` tool. Engagement tracking (did user reply to push? how fast?). Adaptive-budget feed into Claude's push decisions. Built-in trigger templates library.
- **v1.3**: Archival — weekly QMD compaction (Claude writes `archive/YYYY-WW.md` summary). Embedding-free semantic retrieval via periodic Claude-driven re-indexing. `persona_create` tool (conversational creation of custom personas).
- **v2.0**: Multi-account Companion, calendar/webhook external triggers, dashboard.

---

## Cross-cutting implications

- **State-dir footprint** (1 month typical use): profile.md + 2 personas + config.json ≈ 20KB; runs.jsonl (one entry per eval, 6/hour × 24h × 30d) ≈ 400KB; push-log.jsonl (3-5 pushes/day) ≈ 30KB. Comfortable.
- **New deps**: `croner` (or `node-cron`) for cron parsing. ~15KB. Runtime-only.
- **RFC alignment**: §4.2 Proactive Trigger — isolated-session + Claude-judges pattern matches. §4.3 Opt-in gating — `companion_enable` + snooze match. §4.1 Relationship Memory — profile.md v1.1 slice; recall + archive deferred.
- **Reuses Phase 1 patterns**: markdown files + config JSON + configure-by-conversation + tool-based daemon↔Claude interface + permission relay.
- **Foundation for later**: the "daemon dispatches Claude task via isolated session" pattern generalizes to any future agentic evaluation (memory compaction, persona auto-tuning). Cron syntax + task prompts + runs log is a reusable substrate.
