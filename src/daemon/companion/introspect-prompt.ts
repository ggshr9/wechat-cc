/**
 * Pure-helper layer for the introspect SDK call. Builds the prompt from
 * curated context; parses Claude's response defensively (handles code
 * fences, prose preamble, malformed output). No SDK dependency — Task 3
 * wires this together with @anthropic-ai/claude-agent-sdk.
 */
import type { ObservationTone } from '../observations/store'

export interface IntrospectPromptInput {
  chatId: string
  memorySnapshot: string         // concatenated memory/<chat_id>/*.md content
  recentObservations: Array<{ ts: string; body: string }>
  recentEvents: Array<{ ts: string; kind: string; reasoning: string }>
  recentInboundMessages: string[]  // last N inbound user texts
}

export interface IntrospectDecision {
  write: boolean
  body?: string
  tone?: ObservationTone
  reasoning: string
}

const VALID_TONES: ObservationTone[] = ['concern', 'curious', 'proud', 'playful', 'quiet']

const MEMORY_MAX = 2500
const OBS_MAX = 600
const EVT_MAX = 600
const MSG_MAX = 800

const SYSTEM_PROMPT = `你是 Claude，正在审视跟一位特定 wechat 用户最近的对话和你之前留下的记忆/观察。\
你的任务是决定：要不要在这位用户的"记忆"区写一条新的观察？

观察的语气应该像老朋友的随手观察，克制、留白。例如：
  ✅ 「我注意到你最近 3 次都在 23:30 后才发消息——会不会让你休息一下？」
  ✅ 「你说过想学吉他，最近还在弹吗？也许我看错了。」
  ❌ 「检测到用户连续 3 晚熬夜，建议干预。」（监控感太强）
  ❌ 「用户身体状况：欠佳。」（过于权威）

每条观察尽量带"也许我看错了 / 你回我一下"那种留白。

判断标准：
- 最近对话里有没有重复的主题/担忧/兴趣？
- 跟之前的观察有没有重复？已存在 archived 的观察题材避开
- 这条观察对用户有意义吗？还是只是为了写而写？

如果你觉得现在没什么新观察值得写，返回 write=false。这是合理且常见的选择。

返回 JSON（且只返回 JSON，不要前后加 markdown / 解释）：
{
  "write": true|false,
  "body": "观察内容（中文，≤80 字）",  // 仅 write=true 时
  "tone": "concern"|"curious"|"proud"|"playful"|"quiet",  // 可选
  "reasoning": "为什么写或不写（中文，给运维看的，≤60 字）"
}
`

export function buildIntrospectPrompt(input: IntrospectPromptInput): string {
  const memory = input.memorySnapshot.length > MEMORY_MAX
    ? input.memorySnapshot.slice(0, MEMORY_MAX) + '…[已截断]'
    : input.memorySnapshot

  const obsLines = input.recentObservations
    .map(o => `[${o.ts.slice(0, 10)}] ${o.body}`)
    .join('\n')
    .slice(0, OBS_MAX)

  const evtLines = input.recentEvents
    .map(e => `[${e.ts.slice(0, 10)}] ${e.kind}: ${e.reasoning}`)
    .join('\n')
    .slice(0, EVT_MAX)

  const msgLines = input.recentInboundMessages
    .slice(-10)
    .map(m => `用户: ${m}`)
    .join('\n')
    .slice(0, MSG_MAX)

  return `${SYSTEM_PROMPT}

=== 当前记忆（memory/${input.chatId}/*.md 内容）===
${memory || '(空)'}

=== 你最近写过的观察（近 30 天）===
${obsLines || '(空)'}

=== 你最近的决策日志 ===
${evtLines || '(空)'}

=== 用户最近发的消息 ===
${msgLines || '(空)'}

现在返回 JSON。`
}

export function parseIntrospectResponse(raw: string): IntrospectDecision | null {
  if (!raw || typeof raw !== 'string') return null

  // Strip ```json ... ``` code fences if present.
  let text = raw.trim()
  text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '')

  // Find the first '{' and the last '}' — handles prose preamble/postscript.
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>

  if (typeof obj.write !== 'boolean') return null
  if (typeof obj.reasoning !== 'string') return null

  if (obj.write) {
    if (typeof obj.body !== 'string' || obj.body.trim().length === 0) return null
  }

  if (obj.tone !== undefined && obj.tone !== null) {
    if (typeof obj.tone !== 'string' || !VALID_TONES.includes(obj.tone as ObservationTone)) return null
  }

  return {
    write: obj.write,
    ...(obj.write && typeof obj.body === 'string' ? { body: obj.body } : {}),
    ...(obj.tone ? { tone: obj.tone as ObservationTone } : {}),
    reasoning: obj.reasoning,
  }
}
