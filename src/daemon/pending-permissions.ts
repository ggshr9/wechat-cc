export type PermissionDecision = 'allow' | 'deny' | 'timeout'

interface Entry {
  resolve: (d: PermissionDecision) => void
  expiresAt: number
}

export class PendingPermissions {
  private readonly entries = new Map<string, Entry>()

  register(hash: string, timeoutMs: number): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      this.entries.set(hash, {
        resolve,
        expiresAt: Date.now() + timeoutMs,
      })
    })
  }

  consume(hash: string, decision: 'allow' | 'deny'): boolean {
    const entry = this.entries.get(hash)
    if (!entry) return false
    this.entries.delete(hash)
    entry.resolve(decision)
    return true
  }

  sweep(): void {
    const now = Date.now()
    for (const [hash, entry] of Array.from(this.entries.entries())) {
      if (entry.expiresAt <= now) {
        this.entries.delete(hash)
        entry.resolve('timeout')
      }
    }
  }

  size(): number {
    return this.entries.size
  }
}

// Matches "y abc12" or "n abc12" (5-char hash, case-insensitive y/n).
const PERMISSION_REPLY_RE = /^([yn])\s+([A-Za-z0-9]{5})$/i

export function parsePermissionReply(text: string): { decision: 'allow' | 'deny'; hash: string } | null {
  const m = PERMISSION_REPLY_RE.exec(text.trim())
  if (!m) return null
  return {
    decision: m[1]!.toLowerCase() === 'y' ? 'allow' : 'deny',
    hash: m[2]!,
  }
}
