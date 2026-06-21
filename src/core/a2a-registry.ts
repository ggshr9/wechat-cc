/**
 * A2A registry — source of truth for registered external A2A agents.
 *
 * Loads from agent-config.json:a2a_agents at construction; provides
 * read APIs (list/get/verifyBearer) for the server + client modules
 * and mutation APIs (add/remove/setPaused) for the CLI + dashboard.
 *
 * Mutations write back to agent-config.json synchronously (the file is
 * the source of truth — in-memory cache mirrors disk). Per-mutation
 * file rewrites are fine: a2a_agents changes are operator-driven, not
 * a hot path.
 *
 * See docs/superpowers/specs/2026-05-24-a2a-integration-design.md.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { A2AAgentRecord } from '../lib/agent-config'

/** Subset of A2AAgentRecord that's safe to patch via update(). `id` is the
 *  primary key and can't be changed; `capabilities` is derived from the
 *  Agent Card; `paused` has its own toggle. */
export type A2AAgentPatch = Partial<Pick<A2AAgentRecord, 'name' | 'url' | 'inbound_api_key' | 'outbound_api_key'>>

export interface A2ARegistry {
  list(): readonly A2AAgentRecord[]
  get(id: string): A2AAgentRecord | null
  verifyBearer(agentId: string, bearer: string): A2AAgentRecord | null
  add(rec: A2AAgentRecord): void
  remove(id: string): void
  setPaused(id: string, paused: boolean): void
  /** Patch one or more fields on an existing agent. Throws if id not found
   *  or if the resulting record fails validation (e.g. empty key). Returns
   *  the updated record. */
  update(id: string, patch: A2AAgentPatch): A2AAgentRecord
}

export interface A2ARegistryOpts {
  stateDir: string
}

export function createA2ARegistry(opts: A2ARegistryOpts): A2ARegistry {
  const configPath = join(opts.stateDir, 'agent-config.json')

  function loadAll(): A2AAgentRecord[] {
    if (!existsSync(configPath)) return []
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as { a2a_agents?: A2AAgentRecord[] }
      return raw.a2a_agents ?? []
    } catch {
      return []
    }
  }

  function persistAll(agents: A2AAgentRecord[]): void {
    // Read full config so we don't lose other top-level fields.
    let raw: Record<string, unknown> = {}
    if (existsSync(configPath)) {
      try {
        raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
      } catch {
        raw = {}
      }
    }
    raw.a2a_agents = agents
    writeFileSync(configPath, JSON.stringify(raw, null, 2))
  }

  // No in-memory cache: agent-config.json is shared with CLI / dashboard /
  // sibling processes that may also mutate `a2a_agents`. A long-lived cache
  // led to desync — a CLI `wechat-cc agent add` would write to disk while
  // the daemon kept serving its boot-time snapshot, so verifyBearer 401'd
  // until restart (or the daemon's own mutation would clobber the CLI's
  // change). The file is small (a few hundred bytes per agent at most)
  // and even hot-path reads (verifyBearer per A2A notify) are inexpensive.
  function validatePatch(patch: A2AAgentPatch): void {
    if (patch.name !== undefined && patch.name.length === 0) throw new Error(`name must be non-empty`)
    if (patch.url !== undefined && patch.url.length === 0) throw new Error(`url must be non-empty`)
    if (patch.inbound_api_key !== undefined && patch.inbound_api_key.length < 16) {
      throw new Error(`inbound_api_key must be at least 16 chars`)
    }
    if (patch.outbound_api_key !== undefined && patch.outbound_api_key.length === 0) {
      throw new Error(`outbound_api_key must be non-empty`)
    }
  }

  function validateRecord(rec: A2AAgentRecord): void {
    if (!rec.id) throw new Error(`id must be non-empty`)
    validatePatch(rec)
  }

  return {
    list: () => loadAll(),
    get: (id) => loadAll().find(a => a.id === id) ?? null,
    verifyBearer: (agentId, bearer) => {
      const agent = loadAll().find(a => a.id === agentId)
      if (!agent) return null
      // Never authenticate against an empty stored key or an empty bearer:
      // constantTimeEquals('', '') is true, so a corrupted/hand-edited config
      // with an empty inbound_api_key + a `Bearer ` (empty) header would bypass
      // auth. validateRecord blocks empty keys on write, but loadAll does NOT
      // re-validate, so this is the load-bearing guard for the read path.
      if (!agent.inbound_api_key || !bearer) return null
      // Constant-time string compare to mitigate timing side-channels on key check.
      // For 16-byte hex keys the timing leak is theoretical but cheap to defend.
      if (!constantTimeEquals(agent.inbound_api_key, bearer)) return null
      return agent
    },
    add: (rec) => {
      // Validate before write — closes the install-route gap where
      // /v1/a2a/install routed through add() (no validation) and could
      // persist short/empty keys. add() and update() now enforce the
      // same A2AAgentRecord schema rules.
      validateRecord(rec)
      const current = loadAll()
      if (current.some(a => a.id === rec.id)) throw new Error(`a2a agent '${rec.id}' already exists`)
      persistAll([...current, rec])
    },
    remove: (id) => {
      const current = loadAll()
      if (!current.some(a => a.id === id)) throw new Error(`a2a agent '${id}' not found`)
      persistAll(current.filter(a => a.id !== id))
    },
    setPaused: (id, paused) => {
      const current = loadAll()
      const ix = current.findIndex(a => a.id === id)
      if (ix < 0) throw new Error(`a2a agent '${id}' not found`)
      persistAll(current.map((a, i) => i === ix ? { ...a, paused } : a))
    },
    update: (id, patch) => {
      validatePatch(patch)
      const current = loadAll()
      const ix = current.findIndex(a => a.id === id)
      if (ix < 0) throw new Error(`a2a agent '${id}' not found`)
      const next = { ...current[ix]!, ...patch }
      persistAll(current.map((a, i) => i === ix ? next : a))
      return next
    },
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
