/**
 * connection-probe.ts — answer "does THIS machine currently hold the ilink
 * bot connection?" by doing one short getUpdates and reading the result.
 *
 * The only ground-truth signal ilink gives is errcode=-14 ("session timeout"
 * — token rebound on another device). No -14 within the short poll window
 * means the server accepted our session (we are the live connection, or it
 * long-polled with nothing to send). See the design doc's "待验证" note on
 * multi-reader semantics.
 */
import type { GetUpdatesResp } from '../lib/ilink'

export type ConnectionState = 'connected' | 'taken_over' | 'inconclusive'

export interface ProbeVerdict {
  state: ConnectionState
  detail?: string
}

// ── classifyProbeResult ──────────────────────────────────────────────────────

export function classifyProbeResult(input: { resp?: GetUpdatesResp; error?: unknown }): ProbeVerdict {
  if (input.error) {
    return { state: 'inconclusive', detail: input.error instanceof Error ? input.error.message : String(input.error) }
  }
  const resp = input.resp ?? {}
  if (resp.errcode === -14 || resp.ret === -14) {
    return { state: 'taken_over', ...(resp.errmsg ? { detail: resp.errmsg } : {}) }
  }
  return { state: 'connected' }
}

// ── probeConnection ─────────────────────────────────────────────────────────

export interface ProbeAccount { id: string; botId: string; baseUrl: string; token: string }

export interface ProbeDeps {
  account: ProbeAccount
  /** Call ilinkGetUpdates(baseUrl, token, '', timeoutMs) — injected so tests need no network. */
  getUpdates: (baseUrl: string, token: string, timeoutMs: number) => Promise<GetUpdatesResp>
  /**
   * Reuse SessionStateStore.markExpired — single source of truth with the
   * passive poll loop. Keyed by account.id (the dir name), matching the key
   * that poll-loop.ts passes as `accountId` to transport.getUpdatesForLoop
   * which forwards it to sessionState.markExpired unchanged.
   */
  markExpired: (accountId: string, reason?: string) => boolean
  probeTimeoutMs: number
}

export interface ProbeResult { id: string; state: ConnectionState; detail?: string }

export async function probeConnection(deps: ProbeDeps): Promise<ProbeResult> {
  const { account } = deps
  let verdict: ProbeVerdict
  try {
    const resp = await deps.getUpdates(account.baseUrl, account.token, deps.probeTimeoutMs)
    verdict = classifyProbeResult({ resp })
  } catch (error) {
    verdict = classifyProbeResult({ error })
  }
  if (verdict.state === 'taken_over') {
    // Key must match the passive poll loop: poll-loop.ts calls
    // ilink.getUpdates(account.id, ...), transport.ts receives that as
    // `accountId` and passes it to sessionState.markExpired — so account.id
    // (the dir name) is the correct key, not account.botId.
    deps.markExpired(account.id, `connection probe errcode=-14: ${verdict.detail ?? ''}`)
  }
  return { id: account.id, state: verdict.state, ...(verdict.detail ? { detail: verdict.detail } : {}) }
}
