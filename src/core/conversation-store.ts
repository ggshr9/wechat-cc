/**
 * conversation-store — persistent chatId → Mode map (RFC 03 §3.4).
 *
 * Tiny on-disk store, same atomic-write + debounced-flush pattern as
 * session-store. Holds the user's mode preference per chat: which
 * provider for solo, primary for primary_tool, parallel/chatroom flags.
 *
 * The store is provider-id-aware (modes carry ProviderId strings) but
 * does NOT validate against the registry — that's the coordinator's
 * job, since the registry isn't always loaded when conversations.json
 * is read (e.g. by CLI tools that just inspect state).
 *
 * File: ~/.local/share/wechat-cc/conversations.json (or any path the
 * daemon configures — tests use temp dirs).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Mode, PersistedConversation } from './conversation'

export interface ConversationStore {
  /** Get the persisted mode for a chat, or null if none set. */
  get(chatId: string): PersistedConversation | null
  /** Set the mode for a chat. */
  set(chatId: string, mode: Mode): void
  /** Remove a chat's mode (revert to daemon default). */
  delete(chatId: string): void
  /** Snapshot of all persisted conversations. */
  all(): Record<string, PersistedConversation>
  /** Force-write to disk (test/teardown). */
  flush(): Promise<void>
}

interface StoredShape {
  version: 1
  conversations: Record<string, PersistedConversation>
}

export function makeConversationStore(
  filePath: string,
  opts: { debounceMs: number },
): ConversationStore {
  let data: StoredShape = { version: 1, conversations: {} }
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | null = null

  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<StoredShape>
      if (parsed && typeof parsed === 'object' && parsed.conversations && typeof parsed.conversations === 'object') {
        data = { version: 1, conversations: parsed.conversations as Record<string, PersistedConversation> }
      }
    } catch { /* corrupt — start empty */ }
  }

  async function writeNow(): Promise<void> {
    if (!dirty) return
    const dir = dirname(filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, filePath)
    dirty = false
  }

  function markDirty(): void {
    dirty = true
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; void writeNow() }, opts.debounceMs)
  }

  return {
    get(chatId) {
      return data.conversations[chatId] ?? null
    },
    set(chatId, mode) {
      data.conversations[chatId] = { mode }
      markDirty()
    },
    delete(chatId) {
      if (!(chatId in data.conversations)) return
      delete data.conversations[chatId]
      markDirty()
    },
    all() {
      return { ...data.conversations }
    },
    async flush() {
      if (timer) { clearTimeout(timer); timer = null }
      await writeNow()
    },
  }
}
