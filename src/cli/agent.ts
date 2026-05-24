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
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createA2ARegistry } from '../core/a2a-registry'
import { createA2AClient, type A2AClientOpts } from '../core/a2a-client'
import { makeA2AEventsStore } from '../core/a2a-events-store'
import { openWechatDb } from '../lib/db'

/**
 * Read the daemon-written a2a-info.json (no token; safe to read directly).
 * Returns null if file missing (daemon not running) or unreadable.
 */
export function readA2AInfo(stateDir: string): { enabled: boolean; base_url: string | null; host: string | null; port: number | null; pid: number; ts: number } | null {
  const p = join(stateDir, 'a2a-info.json')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

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
  // Substitute the actual A2A base URL if daemon is running and has the
  // server enabled; otherwise print a clear placeholder + hint for how to
  // enable inbound. Operator needs the URL to share with the external agent.
  const info = readA2AInfo(stateDir)
  const baseUrl = info?.enabled && info.base_url
    ? info.base_url
    : '<wechat-cc-base-url>'
  console.log(`  curl example:`)
  console.log(`    curl -X POST ${baseUrl}/a2a/notify \\`)
  console.log(`      -H "Authorization: Bearer ${inboundKey}" \\`)
  console.log(`      -H "Content-Type: application/json" \\`)
  console.log(`      -d '{"agent_id":"${id}","text":"hello"}'`)
  if (baseUrl === '<wechat-cc-base-url>') {
    if (!info) {
      console.log(`  (daemon not running — start it to see the actual A2A base URL via "wechat-cc agent info")`)
    } else if (!info.enabled) {
      console.log(`  (A2A server disabled — set "a2a_listen": { "port": <port> } in agent-config.json and restart the daemon)`)
    }
  }
}

/**
 * `wechat-cc agent info` — show the daemon's A2A status (base URL, server
 * enabled/disabled, registered agent count). Reads a2a-info.json directly
 * so it works without going through internal-api auth.
 */
export function cmdAgentInfo(stateDir: string): void {
  const info = readA2AInfo(stateDir)
  const reg = createA2ARegistry({ stateDir })
  const agents = reg.list()
  if (!info) {
    console.log('A2A status: daemon not running (or never started — no a2a-info.json found)')
    console.log(`Registered agents: ${agents.length}`)
    return
  }
  if (!info.enabled) {
    console.log('A2A status: daemon running, but inbound server is disabled')
    console.log(`  Enable by adding to agent-config.json:`)
    console.log(`    "a2a_listen": { "host": "127.0.0.1", "port": 8717 }`)
    console.log(`  Then restart the daemon.`)
  } else {
    console.log('A2A status: running')
    console.log(`  Base URL: ${info.base_url}`)
    console.log(`  Bound:    ${info.host}:${info.port}`)
    console.log(`  PID:      ${info.pid}`)
  }
  console.log(`Registered agents: ${agents.length}`)
  for (const a of agents) {
    const status = a.paused ? ' (paused)' : ''
    console.log(`  - ${a.id}${status} → ${a.url}`)
  }
}

/**
 * `wechat-cc agent test <id>` — sends a synthetic inbound notify to the
 * daemon's own /a2a/notify endpoint as if it came from the registered agent.
 * Operator runs this to validate: server up + key matches + chat routing
 * works end-to-end. The notification lands in operator's WeChat chat as
 * a normal `[A2A:<id>]` line.
 */
export async function cmdAgentTest(stateDir: string, id: string, text: string): Promise<void> {
  const info = readA2AInfo(stateDir)
  if (!info) throw new Error('daemon not running — start it first')
  if (!info.enabled) throw new Error('A2A inbound server is disabled — configure agent-config.json:a2a_listen and restart the daemon')
  const reg = createA2ARegistry({ stateDir })
  const agent = reg.get(id)
  if (!agent) throw new Error(`agent '${id}' not registered`)
  const res = await fetch(`${info.base_url}/a2a/notify`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${agent.inbound_api_key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ agent_id: id, text }),
  })
  const body = await res.text()
  if (res.ok) {
    console.log(`✅ delivered (HTTP ${res.status})`)
    console.log(`   The message "${text}" should appear in your WeChat chat as: [A2A:${id}] ${text}`)
    console.log(`   If not, check that the daemon is bound to a bot and that your operator chat has at least one prior message.`)
  } else {
    console.log(`❌ delivery failed (HTTP ${res.status})`)
    console.log(`   ${body}`)
  }
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
