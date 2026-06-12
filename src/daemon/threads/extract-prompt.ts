/**
 * Pure helpers for the thread-extraction LLM call.
 *
 * buildExtractPrompt  — builds the Chinese prompt from curated context
 * parseExtractResponse — defensively parses Claude's JSON response
 *
 * No SDK dependency. The extractor runtime (Task 8) wires these together
 * with a single isolated sdkEval call per introspect tick.
 * Parse failure returns null — caller holds the watermark and retries.
 */
// zod v4: `import { z } from 'zod'` resolves to undefined under vitest's
// bundler; use the default export instead.
import z from 'zod'
import type { Facet, Episode, ThreadStatus } from '../../lib/threads-store'

// ── Public types ──────────────────────────────────────────────────────────────

export type ExtractOp =
  | { op: 'create'; title: string; summary: string; facets: [Facet, ...Facet[]]; tags: string[]; private: boolean; episode: Episode }
  | { op: 'update'; id: string; title?: string; summary?: string; facets?: Facet[]; tags?: string[]; private?: boolean; status?: ThreadStatus }
  | { op: 'touch'; id: string; episode: Episode }

// ── Input types ───────────────────────────────────────────────────────────────

export interface ExtractPromptInput {
  newMessages: Array<{ ts: string; direction: 'in' | 'out'; text: string }>
  existingThreads: Array<{ id: string; title: string; facets: Facet[]; tags: string[]; summary: string }>
  tagVocabulary: string[]
  /**
   * Optional pre-watermark context tail. When present, rendered before the
   * 新增对话片段 section so the model can judge whether a topic "reappeared"
   * (condition D6) without having these messages counted as new ones.
   */
  contextTail?: Array<{ ts: string; direction: 'in' | 'out'; text: string }>
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TEXT_MAX = 500

// ── Prompt builder ────────────────────────────────────────────────────────────

export function buildExtractPrompt(input: ExtractPromptInput): string {
  const { newMessages, existingThreads, tagVocabulary, contextTail } = input

  // ── Section 1: 任务说明 ────────────────────────────────────────────────────
  const taskDescription = `你是 Claude，负责从一段新增对话片段中提取或更新"话题线索"（threads）。

每条线索代表用户聊天中反复出现的话题（如"compass 排产"、"股票观察"）。
线索有 facets（视角标签）、tags（自由标签）、episodes（时间段）和 private（私密标志）。

## 升格门槛（重要，请严格遵守）

- **touch / update（更新已有线索）**：仅当已有线索的主题在本片段中再次出现时才操作。
- **create（新建线索）**：满足以下条件之一才新建：
  (a) 该话题在本片段中有 ≥10 轮深入讨论；
  (b) 话题不在已有线索列表中，但明显是第二次出现（此前聊过的话题又出现）。
- 单次寥寥数语、首次提及的话题**不建线索**。

## tag 纪律

- 优先复用已有 tag 词表；每条线索至多 3 个 tag。
- 新造 tag 仅限明显反复出现的新概念，不要随意创造。

## 私密初判

- 涉及情绪、私人生活、人际关系的线索：private = true
- 工作/技术内容：private = false（默认）

## facets 合法值

- task：正在推进的事（项目、待办、目标）
- knowledge：了解和研究过的内容（技术、领域知识）
- life：生活、情绪、闲聊、兴趣爱好

## 输出格式

只输出一个 JSON 对象 \`{"ops":[...]}\`，不要添加 markdown、解释或其他内容。
没有可做的操作时输出 \`{"ops":[]}\`。

各 op 字段示例：
- create：{"op":"create","title":"话题名","summary":"一句话摘要","facets":["task"],"tags":["标签"],"private":false,"episode":{"from_ts":"ISO时间","to_ts":"ISO时间"}}
- update：{"op":"update","id":"thr_xxx","title":"新标题","status":"done"}（至少提供 id 和一个可选字段）
- touch：{"op":"touch","id":"thr_xxx","episode":{"from_ts":"ISO时间","to_ts":"ISO时间"}}`

  // ── Section 2: 已有线索列表 ────────────────────────────────────────────────
  let threadsSection: string
  if (existingThreads.length === 0) {
    threadsSection = '(暂无已有线索)'
  } else {
    threadsSection = existingThreads
      .map(t => {
        const facetsStr = t.facets.join(', ')
        const tagsStr = t.tags.join(', ')
        const summaryStr = t.summary ? `  摘要: ${t.summary}` : ''
        return `- id: ${t.id}  title: 「${t.title}」  facets: [${facetsStr}]  tags: [${tagsStr}]${summaryStr}`
      })
      .join('\n')
  }

  // ── Section 3: 已有 tag 词表 ───────────────────────────────────────────────
  const vocabSection = tagVocabulary.length > 0
    ? tagVocabulary.join('、')
    : '(暂无)'

  // ── Section 4: 新增对话片段 ────────────────────────────────────────────────
  let messagesSection: string
  if (newMessages.length === 0) {
    messagesSection = '(无新消息)'
  } else {
    messagesSection = newMessages
      .map(m => {
        const dir = m.direction === 'in' ? '用户' : 'bot'
        const text = m.text.length > TEXT_MAX
          ? m.text.slice(0, TEXT_MAX) + '…'
          : m.text
        return `[${m.ts}] ${dir}: ${text}`
      })
      .join('\n')
  }

  // ── Section 4b (optional): context tail ──────────────────────────────────
  let tailSection: string | null = null
  if (contextTail && contextTail.length > 0) {
    tailSection = contextTail
      .map(m => {
        const dir = m.direction === 'in' ? '用户' : 'bot'
        const text = m.text.length > TEXT_MAX
          ? m.text.slice(0, TEXT_MAX) + '…'
          : m.text
        return `[${m.ts}] ${dir}: ${text}`
      })
      .join('\n')
  }

  const tailBlock = tailSection !== null
    ? `\n## 近期历史(仅供判断话题是否"再次出现",不要为历史内容本身建线索)\n${tailSection}\n`
    : ''

  return `${taskDescription}

=== 已有线索列表 ===
${threadsSection}

=== 已有 tag 词表（请优先复用） ===
${vocabSection}
${tailBlock}
=== 新增对话片段 ===
${messagesSection}

现在返回 JSON。`
}

// ── Zod schema ────────────────────────────────────────────────────────────────

const FacetEnum = z.enum(['task', 'knowledge', 'life'])
const EpisodeSchema = z.object({ from_ts: z.string(), to_ts: z.string() })
const ThreadStatusEnum = z.enum(['active', 'dormant', 'done'])

const CreateOpSchema = z.object({
  op: z.literal('create'),
  title: z.string(),
  summary: z.string(),
  facets: z.array(FacetEnum).min(1),
  tags: z.array(z.string()),
  private: z.boolean(),
  episode: EpisodeSchema,
})

const UpdateOpSchema = z.object({
  op: z.literal('update'),
  id: z.string(),
  title: z.string().optional(),
  summary: z.string().optional(),
  facets: z.array(FacetEnum).optional(),
  tags: z.array(z.string()).optional(),
  private: z.boolean().optional(),
  status: ThreadStatusEnum.optional(),
})

const TouchOpSchema = z.object({
  op: z.literal('touch'),
  id: z.string(),
  episode: EpisodeSchema,
})

const ExtractOpSchema = z.discriminatedUnion('op', [CreateOpSchema, UpdateOpSchema, TouchOpSchema])

const ExtractResponseSchema = z.object({
  ops: z.array(ExtractOpSchema),
})

// ── Response parser ───────────────────────────────────────────────────────────

export function parseExtractResponse(raw: string): ExtractOp[] | null {
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

  const result = ExtractResponseSchema.safeParse(parsed)
  if (!result.success) return null

  return result.data.ops as ExtractOp[]
}
