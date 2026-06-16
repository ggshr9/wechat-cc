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
  })
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
  })
}
