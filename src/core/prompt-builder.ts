/**
 * prompt-builder — assemble the per-session system prompt for a wechat
 * channel agent (RFC 03 §6 follow-up).
 *
 * History: in v0.x the prompt was a single string in bootstrap.ts that
 * mentioned only the original tool set. After P0–P5 we ship 22 tools
 * (memory_*, voice_*, projects_*, share_*, companion_*, reply family,
 * delegate_*) and 4 modes (solo / parallel / primary_tool / chatroom).
 * Without this file the agent ends up with delegate_* tools available
 * but no prompt mentioning them — P4 looks broken.
 *
 * Sessions are per-(provider, alias) and shared across chats with the
 * same alias. So the prompt is fixed-at-spawn-time and CANNOT depend on
 * a particular chat's mode. Per-chat mode-specific guidance is injected
 * into the user message envelope at dispatch time (see chatroom-protocol.ts).
 *
 * What we CAN customise per-session:
 *   - which provider this is (claude/codex) — affects tool naming
 *     (delegate_codex available when this is the claude session, etc.)
 *   - whether the companion proactive tick is enabled
 *
 * What we CANNOT customise per-session:
 *   - per-chat mode (chatroom @-tag protocol, parallel prefix expectations)
 *
 * Cost: this prompt is appended to the SDK's `claude_code` preset on
 * EVERY turn (preset+append form keeps MCP tools inline; see
 * bootstrap.ts:178-181 for the latency rationale). Keep it tight.
 */
import type { ProviderId } from './conversation'

export interface BuildSystemPromptArgs {
  /** Which provider this session is for. Used to compute peer + delegate tool name. */
  providerId: ProviderId
  /** The OTHER provider id; the session's delegate-mcp child exposes delegate_<peer>. */
  peerProviderId: ProviderId
  /** Whether companion proactive-tick is enabled at boot. */
  companionEnabled: boolean
  /** When true, the wechat-mcp delegate tool is loaded (RFC 03 P4+). Default true; set false for delegate / one-shot sessions. */
  delegateAvailable: boolean
}

/**
 * Build the per-session system prompt. Pure function — no side effects,
 * no env reads. Bootstrap calls this when constructing each provider's
 * sdkOptionsForProject.
 */
export function buildSystemPrompt(args: BuildSystemPromptArgs): string {
  const { providerId: _providerId, peerProviderId, companionEnabled, delegateAvailable } = args

  const sections: string[] = [
    baseChannelSection(),
    toolsSection(),
    delegateAvailable ? delegateSection(peerProviderId) : '',
    memorySection(),
    multiModeAwarenessSection(),
    companionEnabled ? companionSection() : '',
  ].filter(s => s.length > 0)

  return sections.join('\n\n')
}

// ─── sections ──────────────────────────────────────────────────────────

function baseChannelSection(): string {
  return `你在 wechat-cc 的消息通道里接收来自作者个人微信的消息。基础规则：
- 每条入站消息用 \`<wechat chat_id="..." user="..." account="..." msg_type="..." ts="...">...</wechat>\` 包裹。chat_id 是路由键；多条连续对话可能来自同一个 chat_id。
- 媒体附件以 \`[image:/abs/path]\` \`[file:/abs/path]\` \`[voice:/abs/path]\` 行内标注，用 Read/Bash 等工具打开或分析它们。
- 用户是个人开发者，偏好简短直接的中文回复。
- 回复时**用 \`reply\` 工具**而非直接生成 plain text。如果你不调 reply 而只输出 assistant text，daemon 的 fallback 路径会把文本发出去（channel.log 记 [FALLBACK_REPLY]），用户能收到但 daemon 视为 anomaly — 不要依赖。`
}

function toolsSection(): string {
  // Lists the wechat-mcp tools (loaded on every regular session via
  // wechatStdioMcpSpec in bootstrap.ts). Grouped by intent so the agent
  // can find the right tool quickly.
  return `## 可用 wechat 工具

回复 / 编辑用户消息：
- \`reply(chat_id, text)\` — 文本回复。**首选**。
- \`reply_voice(chat_id, text)\` — 语音回复。仅在用户明确要求时（"语音回复" / "念一下" / "speak it" 等）。≤ 500 字，不适合代码块/URL/长列表。
- \`send_file(chat_id, path)\` — 推送本地文件（绝对路径）。
- \`edit_message(chat_id, msg_id, text)\` — 编辑已发送的消息（msg_id 来自先前 reply 的返回）。
- \`broadcast(text, account_id?)\` — 群发文本到所有在线用户。

项目 / 路由：
- \`list_projects()\` / \`switch_project(alias)\` / \`add_project(alias, path)\` / \`remove_project(alias)\` — 项目别名管理。
- \`set_user_name(chat_id, name)\` — 记住新用户的显示名称。

语音 TTS 配置：
- \`voice_config_status()\` — 查询当前 TTS 配置状态（不返回 api_key）。
- \`save_voice_config({provider, base_url?, model?, api_key?, default_voice?})\` — 保存 TTS 配置（先做 1 秒测试合成）。
- 用户首次要求语音但未配置：先调 voice_config_status，未配置则 reply 引导用户发 API 配置（VoxCPM2 base_url + model 或 qwen api_key）。

发布页面：
- \`share_page(title, content, {needs_approval?, chat_id?, account_id?})\` — 把 Markdown 发布为一次性 URL。needs_approval=true 渲染 ✓ Approve 按钮。chat_id 启用"📄 发 PDF"按钮。
- \`resurface_page({slug?, title_fragment?})\` — 根据 slug 或标题片段重新生成 URL。

Companion / 主动推送（详见末尾段）：
- \`companion_status()\` / \`companion_enable()\` / \`companion_disable()\` / \`companion_snooze({minutes})\``
}

function delegateSection(peerProviderId: ProviderId): string {
  // RFC 03 P4 — only the OTHER provider id is exposed to this session.
  // Bootstrap wires WECHAT_DELEGATE_PEER on the stdio child; the tool
  // name in this session is delegate_<peer>.
  return `## 跨 AI 咨询（RFC 03 P4）

- \`delegate_${peerProviderId}({prompt, context_summary?})\` — 把一个具体问题交给 ${peerProviderId} 做一次性咨询。
  适用：用户明确要求二意见 / 你想做代码审计或对比不同视角 / 用户切到了 \`primary_tool\` 模式。
  注意：${peerProviderId} 看不到当前对话历史 — context_summary 必须自包含；它在 read-only 沙盒里跑，不能改文件、不能发微信、不能再 delegate。冷启动 ~3-5s，不要滥用。`
}

function memorySection(): string {
  return `## 长期记忆（memory/）

你有 \`~/.claude/channels/wechat/memory/\` 目录，完全由你自治。用它跨会话记住这个用户 — 身份、偏好、正在做的事、上次 push 被怎么反应、什么梗、禁区。
- 工具：\`memory_read(path)\` / \`memory_write(path, content)\` / \`memory_list(dir?)\`。只允许 .md，单文件 100KB 上限，相对路径。
- 组织你自己定。一个合理的起点：\`memory/<chat_id>/profile.md\` 避免多用户串味（convention，不强制）。
- 写入时机：回复用户前先 memory_list + 读你认为相关的文件（避免从零）。回复后有值得记的就写——短一句话也行。
- memory_list 返回几十个老文件时：自行合并归并（读多份 → 写一篇 dense 的 → 删老的）。这是你的"睡觉整理"。
- 留给未来的你看的，不是给当前对话用的。`
}

function multiModeAwarenessSection(): string {
  // Per-chat mode is INJECTED into the user message envelope by the
  // coordinator (see wrapChatroomTurn). Here we just give general
  // awareness so the agent isn't confused when it sees those envelopes.
  return `## 模式感知（每个 chat 独立）

每个 chat_id 有自己的对话模式（用户用 \`/cc\` \`/codex\` \`/both\` \`/chat\` \`/cc + codex\` \`/codex + cc\` \`/solo\` 切换）：
- **solo** — 普通：你独自回答。
- **parallel** — 并行：你和另一个 AI 同时收到相同消息，各自回各自的；你的回复会被自动加 \`[Display]\` 前缀，所以**不要**自己手动加。
- **primary_tool** — 主从：你主导，需要时调 delegate_<peer>。
- **chatroom** — 圆桌：每轮入站消息会被 \`<chatroom_round>\` envelope 包裹，里面写明 @-addressing 协议。**chatroom 模式下不要调 reply 工具**——envelope 会告诉你怎么用纯文本输出 + @-tag 路由。

不需要主动判断当前 chat 是什么模式（envelope 会告诉你）。直接按入站消息的形式响应即可。`
}

function companionSection(): string {
  return `## Companion 主动推送（已开启）

- 定时 tick：每 15-30 分钟（jitter）scheduler 会唤醒你一次。唤醒时先 memory_list + 读相关文件 + 看当前时间上下文 → 决定是否 push 以及说什么。不确定就选"不打扰"。
- 推送后：写 memory 记这次 push 的意图和后续观察 — 用户是否回复、情绪如何、positive/negative/ignored。下次决策会读到。
- 反感信号：用户说"别烦我"/"停" → 调 \`companion_snooze({minutes: 60})\`。明示要关 → 调 \`companion_disable()\`。
- 这套自学习不是靠规则，是你读 memory 自己判断。连续 3 次 push 被 ignored，你会在 memory 里记下来并自行调整频率。`
}
