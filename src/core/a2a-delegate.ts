/**
 * a2a-delegate — the BRAIN side of one-brain-many-hands (乙).
 *
 * The brain delegates a task to a registered "hand" (another wechat-cc whose
 * A2A server exposes POST /a2a/exec) and awaits the result. Built on the
 * generic A2A client `send` — the hand's /a2a/exec runs its LOCAL agent and
 * returns an ExecResult, which we surface back to the caller.
 */
import type { A2AClient } from './a2a-client'
import type { A2AAgentRecord } from '../lib/agent-config'
import type { ExecResult } from './a2a-server'

/**
 * Derive a hand's /a2a/exec URL from its registered url, tolerating the
 * common shapes the operator might have registered: a bare base, `/a2a`,
 * `/a2a/notify`, or already `/a2a/exec`.
 */
export function handExecUrl(agentUrl: string): string {
  const u = agentUrl.replace(/\/+$/, '')
  if (u.endsWith('/a2a/exec')) return u
  if (u.endsWith('/a2a/notify')) return u.replace(/\/a2a\/notify$/, '/a2a/exec')
  if (u.endsWith('/a2a')) return `${u}/exec`
  return `${u}/a2a/exec`
}

export interface DelegateToHandReq {
  hand: A2AAgentRecord
  /** The brain's agent id as the HAND knows it (the hand's Bearer check keys on this). */
  selfId: string
  prompt: string
  /** Which provider the hand should run (claude|codex); hand defaults to claude. */
  peer?: string
  /** Working directory on the hand. */
  cwd?: string
}

/**
 * Delegate `prompt` to `hand` (POST its /a2a/exec) and return the result of
 * running the hand's local agent. Network/HTTP failures and malformed hand
 * responses come back as `{ ok: false, reason }` — never throws.
 */
export async function delegateToHand(client: A2AClient, req: DelegateToHandReq): Promise<ExecResult> {
  const r = await client.send({
    url: handExecUrl(req.hand.url),
    bearer: req.hand.outbound_api_key,
    body: {
      agent_id: req.selfId,
      prompt: req.prompt,
      ...(req.peer ? { peer: req.peer } : {}),
      ...(req.cwd ? { cwd: req.cwd } : {}),
    },
  })
  if (!r.ok) return { ok: false, reason: r.error ?? `http_${r.http_status ?? '?'}` }
  const resp = r.response as { ok?: unknown; response?: unknown; reason?: unknown } | undefined
  if (resp && typeof resp === 'object' && typeof resp.ok === 'boolean') {
    return resp.ok
      ? { ok: true, response: String(resp.response ?? '') }
      : { ok: false, reason: String(resp.reason ?? 'unknown') }
  }
  return { ok: false, reason: 'malformed hand response' }
}
