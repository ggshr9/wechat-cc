/**
 * handoff.ts — writes the cross-project handoff pointer.
 *
 * Single-file policy: exactly one `_handoff.md` per target project's
 * `memory/` dir. Overwrites on each switch. See the design spec for why
 * we don't accumulate history here.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
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

function buildIndexLine(sourceAlias: string, timestamp: string): string {
  const date = timestamp.slice(0, 10)  // YYYY-MM-DD
  return `- [Cross-project handoff](${HANDOFF_FILENAME}) — 从 ${sourceAlias} 切过来 (${date})`
}

function updateMemoryIndex(memoryDir: string, sourceAlias: string, timestamp: string): void {
  const file = join(memoryDir, 'MEMORY.md')
  const newLine = buildIndexLine(sourceAlias, timestamp)
  if (!existsSync(file)) {
    writeAtomic(file, `# Memory\n\n${newLine}\n`)
    return
  }
  const existing = readFileSync(file, 'utf8')
  const lines = existing.split('\n')
  const idx = lines.findIndex(l => l.includes(`](${HANDOFF_FILENAME})`))
  if (idx >= 0) {
    lines[idx] = newLine
  } else {
    // Append as a new line at the end (before trailing newline)
    if (lines[lines.length - 1] === '') lines.splice(lines.length - 1, 0, newLine)
    else lines.push(newLine)
  }
  writeAtomic(file, lines.join('\n'))
}

export function writeHandoff(input: HandoffInput): void {
  const memoryDir = join(input.targetDir, 'memory')
  if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true })
  const handoffPath = join(memoryDir, HANDOFF_FILENAME)
  writeAtomic(handoffPath, renderHandoff(input))
  updateMemoryIndex(memoryDir, input.sourceAlias, input.timestamp)
}
