import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

export interface StateStoreOptions {
  debounceMs: number
}

export interface StateStore {
  get(key: string): string | undefined
  set(key: string, value: string): void
  delete(key: string): void
  all(): Record<string, string>
  flush(): Promise<void>
}

export function makeStateStore(filePath: string, opts: StateStoreOptions): StateStore {
  let data: Record<string, string> = {}
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | null = null

  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = parsed as Record<string, string>
      }
    } catch {
      // corrupt JSON — start empty
    }
  }

  function writeNowSync(): void {
    if (!dirty) return
    const dir = dirname(filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, JSON.stringify(data), 'utf8')
    renameSync(tmp, filePath)
    dirty = false
  }

  async function writeNow(): Promise<void> { writeNowSync() }

  function markDirty(): void {
    dirty = true
    // debounceMs <= 0 ⇒ write-through (synchronous): critical, low-frequency
    // state (context tokens, account routing) that must survive a SIGKILL the
    // debounce window would otherwise drop. `set` already no-ops unchanged
    // values, so this stays cheap.
    if (opts.debounceMs <= 0) {
      if (timer) { clearTimeout(timer); timer = null }
      writeNowSync()
      return
    }
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void writeNow()
    }, opts.debounceMs)
  }

  return {
    get(key) { return data[key] },
    set(key, value) {
      if (data[key] === value) return
      data[key] = value
      markDirty()
    },
    delete(key) {
      if (!(key in data)) return
      delete data[key]
      markDirty()
    },
    all() { return { ...data } },
    async flush() {
      if (timer) { clearTimeout(timer); timer = null }
      await writeNow()
    },
  }
}
