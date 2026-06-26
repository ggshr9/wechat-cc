/**
 * hand-pairing (MVP) — shared-token pairing for one-brain-many-hands (乙).
 *
 * To let a BRAIN delegate tasks to a HAND, two A2A-registry records must
 * exist with a matching shared token T:
 *   - on the BRAIN:  { id: <hand id>,  url: <hand url>,  outbound_api_key: T }
 *       → the brain calls the hand's /a2a/exec with Bearer T.
 *   - on the HAND:   { id: <brain id>, inbound_api_key: T }
 *       → the hand's /a2a/exec verifyBearer(<brain id>, T) accepts the brain.
 *
 * `addHand` writes the first (run on the brain); `acceptBrain` writes the
 * second (run on the hand). Both go straight into agent-config.json via the
 * registry, which has no cache — a running daemon picks them up immediately,
 * no restart. The fancier pairing-code + callback flow can layer on later;
 * the record shapes here are the final ones.
 */
import { randomBytes } from 'node:crypto'
import { createA2ARegistry } from '../core/a2a-registry'
import { createA2AClient } from '../core/a2a-client'
import { decodeInvite, pairUrl } from '../lib/a2a-pairing'

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const MIN_TOKEN = 16

function assertSlug(label: string, v: string): void {
  if (!SLUG_RE.test(v)) throw new Error(`${label} must be a lowercase slug ^[a-z0-9][a-z0-9-]{0,63}$ (got "${v}")`)
}
function assertToken(token: string): void {
  if (token.length < MIN_TOKEN) throw new Error(`token must be at least ${MIN_TOKEN} chars (it's a shared secret — keep it strong)`)
}

/** Run on the BRAIN: register a hand the brain can delegate to. */
export function addHand(stateDir: string, opts: { id: string; url: string; name?: string; token: string }): void {
  assertSlug('hand id', opts.id)
  assertToken(opts.token)
  if (!opts.url) throw new Error('hand url is required')
  createA2ARegistry({ stateDir }).add({
    id: opts.id,
    name: opts.name || opts.id,
    url: opts.url,
    outbound_api_key: opts.token,                       // brain → hand exec bearer
    inbound_api_key: randomBytes(16).toString('hex'),   // hand → brain (unused for exec; schema needs ≥16)
    capabilities: ['exec'],
    paused: false,
    transport: 'push',
  })
}

export interface Pairings {
  /** Exec-capable peers THIS machine (as a brain) can delegate tasks to. */
  hands: Array<{ id: string; name: string; url: string; paused: boolean }>
  /** Peers that may delegate INTO this machine (the brain side of a pairing). */
  brains: Array<{ id: string; name: string }>
  /** Any other registered A2A agents (e.g. notify-only), for completeness. */
  others: Array<{ id: string; name: string; capabilities: string[] }>
}

/**
 * Classify the A2A registry into the 乙 roles, using our own record shapes:
 *   - hand  → has the 'exec' capability (written by addHand/join)
 *   - brain → outbound_api_key === 'unused' sentinel (written by acceptBrain/pair)
 *   - other → everything else (notify agents, etc.)
 */
export function listPairings(stateDir: string): Pairings {
  const result: Pairings = { hands: [], brains: [], others: [] }
  for (const a of createA2ARegistry({ stateDir }).list()) {
    if (a.capabilities?.includes('exec')) result.hands.push({ id: a.id, name: a.name, url: a.url, paused: a.paused })
    else if (a.outbound_api_key === 'unused') result.brains.push({ id: a.id, name: a.name })
    else result.others.push({ id: a.id, name: a.name, capabilities: a.capabilities ?? [] })
  }
  return result
}

export interface PingResult { id: string; name: string; ok: boolean; detail: string }

/** Strip the /a2a[/exec|/notify|/pair] suffix to recover the server base url. */
function baseUrlOf(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/a2a(\/(exec|notify|pair))?$/, '')
}

/**
 * Probe whether paired hands are reachable by fetching each one's Agent Card
 * (unauthenticated, no side effects — never runs the hand's agent). Confirms
 * the network path works AND that the peer is a wechat-cc A2A server that
 * advertises exec. Run on the BRAIN. Probes run concurrently.
 */
export async function pingHands(stateDir: string, opts: { filter?: string; timeoutMs?: number } = {}): Promise<PingResult[]> {
  const { hands } = listPairings(stateDir)
  const targets = opts.filter ? hands.filter(h => h.id === opts.filter || h.name === opts.filter) : hands
  const client = createA2AClient({ timeoutMs: opts.timeoutMs ?? 5_000 })
  return Promise.all(targets.map(async (h): Promise<PingResult> => {
    try {
      const card = await client.fetchAgentCard(baseUrlOf(h.url))
      const hasExec = (card.capabilities ?? []).some(c => c.name === 'exec')
      return {
        id: h.id, name: h.name, ok: true,
        detail: hasExec ? `${card.name} v${card.version ?? '?'}` : `${card.name}(⚠ 未通告 exec 能力)`,
      }
    } catch (err) {
      return { id: h.id, name: h.name, ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
  }))
}

export interface JoinResult { ok: boolean; id: string; url: string; error?: string }

/**
 * Run on the BRAIN: join a hand using its one-time invite code (the smooth
 * path — no manual token copy). Mints a fresh exec key, registers the hand
 * locally, then calls the hand's /a2a/pair to register this brain on the hand.
 * Rolls back the local hand record if the callback fails, so a rejected pair
 * doesn't leave a half-configured hand. Never throws on network error.
 */
export async function joinHand(stateDir: string, opts: {
  code: string; id: string; selfId: string; name?: string; timeoutMs?: number
}): Promise<JoinResult> {
  assertSlug('hand id', opts.id)
  assertSlug('brain self-id', opts.selfId)
  const { handUrl, secret } = decodeInvite(opts.code)
  const execKey = randomBytes(24).toString('hex')   // brain↔hand shared exec bearer (48 hex chars)

  const registry = createA2ARegistry({ stateDir })
  if (registry.get(opts.id)) registry.remove(opts.id)   // re-join overwrites
  addHand(stateDir, { id: opts.id, url: handUrl, ...(opts.name ? { name: opts.name } : {}), token: execKey })

  const client = createA2AClient({ timeoutMs: opts.timeoutMs ?? 15_000 })
  const r = await client.send({
    url: pairUrl(handUrl),
    bearer: secret,   // endpoint authenticates on the body `secret`, not this header
    body: { secret, brain_id: opts.selfId, exec_key: execKey },
  })
  const resp = r.response as { ok?: unknown; error?: unknown } | undefined
  if (!r.ok || !resp || resp.ok !== true) {
    registry.remove(opts.id)   // roll back — don't leave a half-paired hand
    // Prefer the hand's structured reason (e.g. invalid_or_expired_invite),
    // which the endpoint sends with a 401 — fall back to the transport error.
    const bodyErr = resp && typeof resp.error === 'string' ? resp.error : undefined
    const error = bodyErr ?? r.error ?? `http_${r.http_status ?? '?'}`
    return { ok: false, id: opts.id, url: handUrl, error }
  }
  return { ok: true, id: opts.id, url: handUrl }
}

/** Run on the HAND: accept a brain that may delegate tasks to this machine. */
export function acceptBrain(stateDir: string, opts: { brainId: string; token: string; brainUrl?: string }): void {
  assertSlug('brain id', opts.brainId)
  assertToken(opts.token)
  createA2ARegistry({ stateDir }).add({
    id: opts.brainId,
    name: opts.brainId,
    // The brain's url isn't used for inbound exec; a placeholder keeps the
    // record schema-valid. Provide --brain-url to also enable the hand calling
    // the brain back (notify) later.
    url: opts.brainUrl || 'http://brain.local/a2a',
    inbound_api_key: opts.token,                        // brain presents this → hand verifies
    outbound_api_key: 'unused',                         // hand → brain (unused for exec; schema needs ≥1)
    capabilities: [],
    paused: false,
    transport: 'push',
  })
}
