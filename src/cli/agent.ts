/**
 * wechat-cc agent <subcommand> — registered A2A agent management CLI.
 *
 * Subcommands:
 *   inspect <url>            Fetch Agent Card, print metadata
 *   add <url>                Register a new agent
 *   list                     List registered agents
 *   pause <id>               Pause inbound/outbound for an agent
 *   resume <id>              Un-pause
 *   remove <id>              Drop registration
 *   activity <id>            Print recent A2A events for this agent
 *
 * Pure CLI wrappers over a2a-registry / a2a-client / a2a-events-store.
 *
 * See docs/superpowers/specs/2026-05-24-a2a-integration-design.md.
 */
import { randomBytes } from 'node:crypto'
import { createA2ARegistry } from '../core/a2a-registry'
import { createA2AClient, type A2AClientOpts } from '../core/a2a-client'
import { makeA2AEventsStore } from '../core/a2a-events-store'
import { openWechatDb } from '../lib/db'

export interface AgentAddOpts {
  id?: string
  nameOverride?: string
  outboundKey?: string
  /** Override for the A2A HTTP client (tests inject timeoutMs / mocked fetch) */
  clientOpts?: A2AClientOpts
}

export async function cmdAgentInspect(url: string, clientOpts: A2AClientOpts = {}): Promise<void> {
  const client = createA2AClient(clientOpts)
  const card = await client.fetchAgentCard(url)
  console.log(`Name: ${card.name}`)
  if (card.description) console.log(`Description: ${card.description}`)
  if (card.version) console.log(`Version: ${card.version}`)
  if (card.auth) console.log(`Auth: ${card.auth.type} (required: ${card.auth.required})`)
  if (card.capabilities && card.capabilities.length > 0) {
    console.log('Capabilities:')
    for (const c of card.capabilities) {
      console.log(`  - ${c.name}${c.description ? ': ' + c.description : ''}`)
    }
  }
}

export async function cmdAgentAdd(stateDir: string, url: string, opts: AgentAddOpts = {}): Promise<void> {
  const client = createA2AClient(opts.clientOpts ?? {})
  const card = await client.fetchAgentCard(url)
  const id = opts.id ?? slugify(card.name)
  if (!id) {
    throw new Error(
      `Could not derive a slug from agent name '${card.name}'. ` +
      `Pass --id explicitly (e.g. --id my-agent).`,
    )
  }
  const name = opts.nameOverride ?? card.name
  // outbound_api_key schema requires min(1). Use '(none)' if operator hasn't
  // provided one — they can re-register once they have it.
  const outboundKey = opts.outboundKey && opts.outboundKey.length > 0 ? opts.outboundKey : '(none)'
  const inboundKey = `wc_${randomBytes(16).toString('hex')}`
  const reg = createA2ARegistry({ stateDir })
  reg.add({
    id,
    name,
    url,
    inbound_api_key: inboundKey,
    outbound_api_key: outboundKey,
    capabilities: card.capabilities?.map(c => c.name) ?? [],
    paused: false,
  })
  console.log(`added agent '${id}'`)
  console.log(`  inbound API key: ${inboundKey}`)
  console.log(`  Provide this key to the agent so it can authenticate when calling wechat-cc.`)
  if (outboundKey === '(none)') {
    console.log(`  outbound API key: (none) — re-register with --outbound-key once you have the agent's key.`)
  }
  console.log(`  curl example:`)
  console.log(`    curl -X POST <wechat-cc-base-url>/a2a/notify \\`)
  console.log(`      -H "Authorization: Bearer ${inboundKey}" \\`)
  console.log(`      -H "Content-Type: application/json" \\`)
  console.log(`      -d '{"agent_id":"${id}","text":"hello"}'`)
}

export function cmdAgentList(stateDir: string): void {
  const reg = createA2ARegistry({ stateDir })
  const agents = reg.list()
  if (agents.length === 0) {
    console.log('no agents registered')
    return
  }
  for (const a of agents) {
    const status = a.paused ? '(paused)' : ''
    const parts = [a.id, a.name, a.url]
    if (status) parts.push(status)
    console.log(parts.join('  '))
  }
}

export function cmdAgentPause(stateDir: string, id: string, paused: boolean): void {
  const reg = createA2ARegistry({ stateDir })
  reg.setPaused(id, paused)
  console.log(`agent '${id}' ${paused ? 'paused' : 'resumed'}`)
}

export function cmdAgentRemove(stateDir: string, id: string): void {
  const reg = createA2ARegistry({ stateDir })
  reg.remove(id)
  console.log(`agent '${id}' removed`)
}

export function cmdAgentActivity(stateDir: string, id: string, limit: number): void {
  const db = openWechatDb(stateDir)
  const store = makeA2AEventsStore(db)
  const rows = store.recentForAgent(id, limit)
  if (rows.length === 0) {
    console.log(`no activity for ${id}`)
    return
  }
  for (const r of rows) {
    const arrow = r.direction === 'in' ? '<-' : '->'
    const statusNote = r.status === 'ok' ? '' : ` [${r.status}${r.http_status ? ' ' + r.http_status : ''}]`
    const text = r.text.length > 80 ? r.text.slice(0, 80) + '...' : r.text
    console.log(`${r.ts} ${arrow} ${text}${statusNote}`)
  }
}

/**
 * Slugify: maps a display name to a lowercase-alphanumeric-hyphen id.
 * Non-ASCII characters (e.g. Chinese) are stripped, so a purely CJK name
 * produces an empty slug — caller must force --id in that case.
 */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}
