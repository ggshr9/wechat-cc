/**
 * 乙 v2 HAND handler — connects out to the brain, sends `initialize`, then runs
 * the local agent (onExec) on each `task/dispatch` and replies with its result.
 * Transport-agnostic: helloFrame() is what the I/O layer sends on ws-open;
 * onMessage(raw) returns the frames to send back.
 */
import { buildRequest, buildResponse, parseMessage } from './yi-protocol'
import type { ExecResult } from './a2a-server'
import type { YiDispatch } from './yi-hub'

export interface YiHandDeps {
  handId: string
  authToken: string
  capabilities: string[]
  onExec: (task: YiDispatch) => Promise<ExecResult>
}

export interface YiHand {
  helloFrame(): string
  onMessage(raw: string): Promise<string[]>
}

export function createYiHand(deps: YiHandDeps): YiHand {
  return {
    helloFrame() {
      return buildRequest(1, 'initialize', {
        handId: deps.handId, clientName: 'wechat-cc', capabilities: deps.capabilities, authToken: deps.authToken,
      })
    },
    async onMessage(raw) {
      const msg = parseMessage(raw)
      if (msg.kind !== 'request' || msg.method !== 'task/dispatch') return []
      const p = msg.params as { taskId: string; peer: 'claude' | 'codex'; prompt: string; cwd?: string }
      let result: ExecResult
      try {
        result = await deps.onExec({ peer: p.peer, prompt: p.prompt, ...(p.cwd ? { cwd: p.cwd } : {}) })
      } catch (err) {
        result = { ok: false, reason: err instanceof Error ? err.message : String(err) }
      }
      return [buildResponse(msg.id, { taskId: p.taskId, ...result })]
    },
  }
}
