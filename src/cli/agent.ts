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
    transport: 'push',
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
 * `wechat-cc agent test <id>` — by default, sends a synthetic INBOUND notify
 * to the daemon's own /a2a/notify endpoint as if it came from the registered
 * agent. Operator runs this to validate: server up + key matches + chat
 * routing works end-to-end. The notification lands in operator's WeChat chat
 * as a normal `[A2A:<id>]` line.
 *
 * With `outbound: true`, instead calls the internal-api's POST /v1/a2a/send
 * to push a message OUT to the registered agent's URL. Validates the
 * outbound side: agent URL is reachable + outbound_api_key is correct.
 * Doesn't touch the operator's WeChat chat — the external agent receives
 * the test message instead.
 */
export async function cmdAgentTest(
  stateDir: string,
  id: string,
  text: string,
  opts: { outbound?: boolean } = {},
): Promise<void> {
  const reg = createA2ARegistry({ stateDir })
  const agent = reg.get(id)
  if (!agent) throw new Error(`agent '${id}' not registered`)

  if (opts.outbound) {
    await testOutbound(stateDir, id, text, agent)
    return
  }

  // Inbound path (default).
  const info = readA2AInfo(stateDir)
  if (!info) throw new Error('daemon not running — start it first')
  if (!info.enabled) throw new Error('A2A inbound server is disabled — configure agent-config.json:a2a_listen and restart the daemon')
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

/**
 * Outbound test: POST /v1/a2a/send to the daemon's internal-api so the
 * daemon-side a2a-client makes the real HTTP call out to the agent's URL.
 * Validates outbound_api_key + URL reachability without going through the
 * operator's chat or claude/codex session.
 */
async function testOutbound(stateDir: string, id: string, text: string, agent: { url: string }): Promise<void> {
  // Internal-api auth: read base URL from internal-api-info.json + token from tokenFilePath.
  const infoPath = join(stateDir, 'internal-api-info.json')
  if (!existsSync(infoPath)) {
    throw new Error('daemon not running — internal-api-info.json not found')
  }
  let info: { baseUrl?: string; tokenFilePath?: string }
  try { info = JSON.parse(readFileSync(infoPath, 'utf8')) }
  catch (err) { throw new Error(`internal-api-info.json malformed: ${err instanceof Error ? err.message : err}`) }
  if (!info.baseUrl || !info.tokenFilePath) throw new Error('internal-api-info.json missing baseUrl or tokenFilePath')
  let token: string
  try { token = readFileSync(info.tokenFilePath, 'utf8').trim() }
  catch (err) { throw new Error(`could not read token file: ${err instanceof Error ? err.message : err}`) }

  const res = await fetch(`${info.baseUrl}/v1/a2a/send`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ agent_id: id, text }),
  })
  const responseText = await res.text()
  let parsed: unknown = responseText
  try { parsed = JSON.parse(responseText) } catch { /* keep raw */ }
  const body = parsed as { ok?: boolean; http_status?: number; error?: string; response?: unknown }

  if (body.ok) {
    console.log(`✅ outbound delivered to ${agent.url}`)
    if (body.http_status) console.log(`   external agent returned HTTP ${body.http_status}`)
    if (body.response) console.log(`   response: ${JSON.stringify(body.response)}`)
  } else {
    console.log(`❌ outbound failed`)
    if (body.error) console.log(`   error: ${body.error}`)
    if (body.http_status) console.log(`   external agent returned HTTP ${body.http_status}`)
    if (body.response) console.log(`   response: ${JSON.stringify(body.response)}`)
    if (!body.error && !body.http_status) {
      console.log(`   raw: ${responseText.slice(0, 500)}`)
    }
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

export interface AgentEditOpts {
  name?: string
  url?: string
  outboundKey?: string
  rotateInboundKey?: boolean
}

/**
 * `wechat-cc agent edit <id>` — patch one or more fields on a registered
 * agent. Most common use: rotate `outbound_api_key` after the external
 * agent rotated theirs. With `--rotate-inbound-key`, generates a new
 * inbound key locally and prints it for the operator to share with the
 * external agent.
 *
 * Doesn't restart the daemon — outbound calls pick up the new
 * outbound_api_key on the next call (registry is read at request time).
 * Inbound auth verification also reads the registry per-request, so
 * rotated inbound keys take effect immediately too.
 */
export function cmdAgentEdit(stateDir: string, id: string, opts: AgentEditOpts): void {
  const reg = createA2ARegistry({ stateDir })
  if (!reg.get(id)) throw new Error(`agent '${id}' not registered`)

  const patch: Parameters<typeof reg.update>[1] = {}
  if (opts.name !== undefined) patch.name = opts.name
  if (opts.url !== undefined) patch.url = opts.url
  if (opts.outboundKey !== undefined) patch.outbound_api_key = opts.outboundKey
  let newInboundKey: string | null = null
  if (opts.rotateInboundKey) {
    newInboundKey = `wc_${randomBytes(16).toString('hex')}`
    patch.inbound_api_key = newInboundKey
  }
  if (Object.keys(patch).length === 0) {
    throw new Error(`no fields to update — pass --name, --url, --outbound-key, or --rotate-inbound-key`)
  }
  const updated = reg.update(id, patch)
  console.log(`✅ agent '${id}' updated`)
  if (patch.name !== undefined) console.log(`   name → ${updated.name}`)
  if (patch.url !== undefined) console.log(`   url → ${updated.url}`)
  if (patch.outbound_api_key !== undefined) console.log(`   outbound_api_key → (rotated, ${patch.outbound_api_key.length} chars)`)
  if (newInboundKey) {
    console.log(`   inbound_api_key → ${newInboundKey}`)
    console.log(`   ⚠ Share this new key with the external agent — the old key no longer works.`)
  }
}

export function cmdAgentActivity(stateDir: string, id: string, limit: number): void {
  // Close the db handle before returning — a leaked SQLite handle blocks the
  // file from being deleted on Windows (EBUSY), breaking both this one-shot
  // CLI command's hygiene and any caller that later rm's the state dir.
  const db = openWechatDb(stateDir)
  try {
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
  } finally {
    db.close()
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

// ── daemon a2a {enable, disable, status} ────────────────────────────────
//
// Reads/writes agent-config.json's `a2a_listen` field directly, preserving
// other top-level fields. Doesn't restart the daemon — operator's call.

import { writeFileSync as _writeFileSync } from 'node:fs'  // re-export alias for clarity in tests

function readAgentConfigRaw(stateDir: string): Record<string, unknown> {
  const path = join(stateDir, 'agent-config.json')
  if (!existsSync(path)) return {}
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function writeAgentConfigRaw(stateDir: string, cfg: Record<string, unknown>): void {
  const path = join(stateDir, 'agent-config.json')
  _writeFileSync(path, JSON.stringify(cfg, null, 2))
}

export interface DaemonA2AEnableOpts {
  host?: string
  port?: number
}

export function cmdDaemonA2AEnable(stateDir: string, opts: DaemonA2AEnableOpts = {}): void {
  const host = opts.host ?? '127.0.0.1'
  const port = opts.port ?? 8717
  if (port < 1 || port > 65535) throw new Error(`port must be in [1, 65535]; got ${port}`)
  const cfg = readAgentConfigRaw(stateDir)
  const prev = (cfg.a2a_listen && typeof cfg.a2a_listen === 'object')
    ? cfg.a2a_listen as { host?: string; port?: number }
    : null
  cfg.a2a_listen = { host, port }
  writeAgentConfigRaw(stateDir, cfg)
  if (prev) {
    console.log(`✅ A2A server config updated: ${prev.host ?? '?'}:${prev.port ?? '?'} → ${host}:${port}`)
  } else {
    console.log(`✅ A2A server enabled at ${host}:${port}`)
  }
  if (host !== '127.0.0.1') {
    console.log(`⚠ Binding to ${host} (not loopback). A paired peer can call /a2a/exec, which runs a FULL local agent (Read/Bash) on THIS machine — treat the pairing token like a remote-shell key.`)
    if (host === '0.0.0.0' || host === '::') {
      console.log(`⚠ ${host} listens on EVERY network interface. For multi-machine (一个大脑多手), bind to your private Tailscale IP (100.x.y.z) instead — only your tailnet should be able to reach /a2a/exec, never an untrusted network.`)
    }
  }
  console.log('⟳ Restart the daemon to apply: kill it and re-launch (or use the desktop GUI restart).')
}

export function cmdDaemonA2ADisable(stateDir: string): void {
  const cfg = readAgentConfigRaw(stateDir)
  if (!('a2a_listen' in cfg)) {
    console.log('A2A server already disabled (no a2a_listen in agent-config.json)')
    return
  }
  delete cfg.a2a_listen
  writeAgentConfigRaw(stateDir, cfg)
  console.log('✅ A2A server disabled (a2a_listen removed from agent-config.json)')
  console.log('⟳ Restart the daemon to apply.')
}

export function cmdDaemonA2AStatus(stateDir: string): void {
  // Show BOTH the on-disk config (operator's stated intent) AND the
  // runtime state (what the daemon actually has bound). Mismatches between
  // the two = operator changed config but hasn't restarted yet.
  const cfg = readAgentConfigRaw(stateDir)
  const configured = (cfg.a2a_listen && typeof cfg.a2a_listen === 'object')
    ? cfg.a2a_listen as { host?: string; port?: number }
    : null
  const runtime = readA2AInfo(stateDir)

  console.log('Configuration (agent-config.json:a2a_listen):')
  if (!configured) {
    console.log('  disabled (no a2a_listen)')
  } else {
    console.log(`  host: ${configured.host ?? '?'}`)
    console.log(`  port: ${configured.port ?? '?'}`)
  }

  console.log('Runtime (daemon a2a-info.json):')
  if (!runtime) {
    console.log('  daemon not running')
    return
  }
  if (!runtime.enabled) {
    console.log('  daemon running, A2A server NOT bound')
  } else {
    console.log(`  A2A server running at ${runtime.base_url}`)
    console.log(`  bound to ${runtime.host}:${runtime.port}, daemon pid ${runtime.pid}`)
  }
  // Drift detection: configured but runtime differs.
  if (configured && runtime?.enabled) {
    if (configured.host !== runtime.host || configured.port !== runtime.port) {
      console.log(`⚠ Config differs from runtime — restart the daemon to apply config (${configured.host}:${configured.port}).`)
    }
  } else if (configured && !runtime?.enabled) {
    console.log(`⚠ Config has a2a_listen but daemon hasn't started the server — restart needed.`)
  } else if (!configured && runtime?.enabled) {
    console.log(`⚠ Daemon has A2A bound but config doesn't request it — config was removed; restart needed to disable.`)
  }
}
