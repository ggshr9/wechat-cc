/**
 * handoff.ts — writes the cross-project handoff pointer.
 *
 * Single-file policy: exactly one `_handoff.md` per target project's
 * `memory/` dir. Overwrites on each switch. See the design spec for why
 * we don't accumulate history here.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

export interface HandoffInput {
  targetDir: string       // absolute path to target project root
  sourceAlias: string
  sourcePath: string
  sourceJsonl: string     // absolute path to source session jsonl
  timestamp: string       // ISO 8601
  note: string | null
}

export const HANDOFF_FILENAME = '_handoff.md'

function renderHandoff(input: HandoffInput): string {
  const noteLine = input.note ?? '无'
  return `---
name: Cross-project handoff
description: Switched to current project at ${input.timestamp}; previous chat in source jsonl
type: reference
---

来源项目: ${input.sourceAlias} (${input.sourcePath})
切换时间: ${input.timestamp}
上段会话 jsonl: ${input.sourceJsonl}
用户备注: ${noteLine}

用户提到"刚才"/"之前"/"切过来之前"时，用 Read 工具读上面 jsonl 的尾部，
或 Grep 关键词按需检索。不主动引用。
`
}

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, content, { mode: 0o600 })
  renameSync(tmp, file)
}

export function writeHandoff(input: HandoffInput): void {
  const memoryDir = join(input.targetDir, 'memory')
  if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true })
  const handoffPath = join(memoryDir, HANDOFF_FILENAME)
  writeAtomic(handoffPath, renderHandoff(input))
}
