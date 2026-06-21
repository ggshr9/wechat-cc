/**
 * 乙 v2 BRAIN hub — tracks connected hands and dispatches tasks to them over
 * the persistent channel, correlating each task/dispatch request with its
 * JSON-RPC response by id. Transport-agnostic: a hand is "attached" with a
 * send(raw) callback; the I/O layer feeds inbound frames via onMessage().
 */
import { buildRequest, parseMessage } from './yi-protocol'
import type { ExecResult } from './a2a-server'

export interface YiDispatch { peer: 'claude' | 'codex'; prompt: string; cwd?: string }

interface Pending { handId: string; resolve: (r: ExecResult) => void; timer: ReturnType<typeof setTimeout> }

export interface YiHub {
  attach(handId: string, send: (raw: string) => void): void
  detach(handId: string, send?: (raw: string) => void): void
  isConnected(handId: string): boolean
  onMessage(handId: string, raw: string): void
  dispatchTask(handId: string, task: YiDispatch, timeoutMs: number): Promise<ExecResult>
}

export function createYiHub(): YiHub {
  const conns = new Map<string, (raw: string) => void>()
  const pending = new Map<number, Pending>()
  let nextId = 1
  let nextTask = 1

  function settle(id: number, r: ExecResult): void {
    const p = pending.get(id)
    if (!p) return
    clearTimeout(p.timer)
    pending.delete(id)
    p.resolve(r)
  }

  return {
    attach(handId, send) { conns.set(handId, send) },
    detach(handId, send?) {
      // If a specific send fn is provided, only evict the slot if the caller
      // still owns it (guard against stale-socket close evicting a newer attach).
      if (send !== undefined && conns.get(handId) !== send) return
      conns.delete(handId)
      // Settle all in-flight tasks for this hand immediately as hand_offline.
      for (const [id, p] of pending) {
        if (p.handId === handId) settle(id, { ok: false, reason: 'hand_offline' })
      }
    },
    isConnected(handId) { return conns.has(handId) },
    onMessage(handId, raw) {
      const msg = parseMessage(raw)
      // Only the hand that OWNS a pending request may settle it. nextId is a
      // small global monotonic counter, so without this check a buggy/malicious
      // hand could settle (hijack) another hand's in-flight task by replaying
      // its id. ownsPending gates both the response and error paths.
      const ownsPending = (id: unknown): id is number =>
        typeof id === 'number' && pending.get(id)?.handId === handId
      if (msg.kind === 'response') {
        if (!ownsPending(msg.id)) return
        const res = msg.result as { ok?: boolean; response?: unknown; reason?: unknown }
        settle(msg.id, res && res.ok
          ? { ok: true, response: String(res.response ?? '') }
          : { ok: false, reason: String(res?.reason ?? 'unknown') })
      } else if (msg.kind === 'error') {
        if (!ownsPending(msg.id)) return
        settle(msg.id, { ok: false, reason: msg.error.message })
      }
    },
    dispatchTask(handId, task, timeoutMs) {
      const send = conns.get(handId)
      if (!send) return Promise.resolve<ExecResult>({ ok: false, reason: 'hand_offline' })
      const id = nextId++
      const taskId = `t${nextTask++}`
      return new Promise<ExecResult>((resolve) => {
        const timer = setTimeout(() => settle(id, { ok: false, reason: 'timeout' }), timeoutMs)
        pending.set(id, { handId, resolve, timer })
        try {
          send(buildRequest(id, 'task/dispatch', { taskId, peer: task.peer, prompt: task.prompt, ...(task.cwd ? { cwd: task.cwd } : {}) }))
        } catch (err) {
          settle(id, { ok: false, reason: err instanceof Error ? err.message : String(err) })
        }
      })
    },
  }
}
