import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createInternalApi, type InternalApi } from '../../daemon/internal-api'

/**
 * P1.A end-to-end: this test wires up the complete provider→stdio MCP→
 * loopback HTTP→daemon round-trip without involving Claude/Codex SDK.
 * If this passes, the architecture proven in RFC 03 §5 is operational.
 *
 *  ┌─────────────────────────────────────────────────────────────┐
 *  │ test process                                                │
 *  │  ─ MCP Client ────────── stdio ────► wechat-mcp child       │
 *  │      ▲                                  │                   │
 *  │      │ tool result (daemon_pid)         │ HTTP fetch         │
 *  │      │                                  ▼                   │
 *  │  ─ internalApi ◄───────── 127.0.0.1:<port> ────────────────┘ │
 *  └─────────────────────────────────────────────────────────────┘
 *
 * The wechat-mcp child is spawned with WECHAT_INTERNAL_API + WECHAT_INTERNAL_TOKEN_FILE
 * env vars so its hand-off matches what bootstrap.ts wires for production.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const WECHAT_MCP_MAIN = join(HERE, 'main.ts')
// We always spawn wechat-mcp under bun: the source is .ts and uses
// extensionless imports (e.g. `./client`) that node's ESM loader can't
// resolve. Bootstrap.ts in production passes process.execPath because
// the daemon itself runs under bun (`bun src/daemon/main.ts`); tests
// here run under node via vitest, so we hard-code bun. If the test
// machine doesn't have bun on PATH, this expectedly fails fast.
const RUNTIME = 'bun'

describe('wechat-mcp stdio integration', () => {
  let stateDir: string
  let api: InternalApi | null = null
  let client: Client | null = null

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'wechat-mcp-int-'))
  })
  afterEach(async () => {
    if (client) {
      try { await client.close() } catch { /* swallow */ }
      client = null
    }
    if (api) {
      try { await api.stop({ unlinkToken: true }) } catch { /* swallow */ }
      api = null
    }
    rmSync(stateDir, { recursive: true, force: true })
  })

  async function bootChain(): Promise<{ client: Client }> {
    api = createInternalApi({ stateDir, daemonPid: 7777 })
    const { port, tokenFilePath } = await api.start()

    const transport = new StdioClientTransport({
      command: RUNTIME,
      args: [WECHAT_MCP_MAIN],
      env: {
        ...process.env as Record<string, string>,
        WECHAT_INTERNAL_API: `http://127.0.0.1:${port}`,
        WECHAT_INTERNAL_TOKEN_FILE: tokenFilePath,
      },
      stderr: 'pipe',
    })
    const c = new Client({ name: 'integration-test', version: '0.0.1' }, { capabilities: {} })
    await c.connect(transport)
    client = c
    return { client: c }
  }

  it('lists the ping tool via tools/list', async () => {
    const { client } = await bootChain()
    const list = await client.listTools()
    const names = list.tools.map(t => t.name)
    expect(names).toContain('ping')
  })

  it('ping tool round-trips the daemon_pid through the full provider → stdio → HTTP → daemon chain', async () => {
    const { client } = await bootChain()
    const result = await client.callTool({ name: 'ping', arguments: {} })
    expect(result.isError).toBeFalsy()

    // The ping handler returns both a text content block (JSON-encoded) and
    // structuredContent ({ ok, daemon_pid }). Either is fine for the test.
    const sc = result.structuredContent as { ok: boolean; daemon_pid: number } | undefined
    if (sc) {
      expect(sc).toEqual({ ok: true, daemon_pid: 7777 })
      return
    }
    const content = result.content as Array<{ type: string; text?: string }>
    const textBlock = content.find(b => b.type === 'text')
    expect(textBlock).toBeDefined()
    const parsed = JSON.parse(textBlock!.text!) as { ok: boolean; daemon_pid: number }
    expect(parsed).toEqual({ ok: true, daemon_pid: 7777 })
  })

  it('ping tool returns isError=true when internal-api is unreachable', async () => {
    // Don't start internal-api — point the child at a port that nothing
    // is listening on. The child should still come up (no precondition
    // on api at boot) but the ping call must surface the failure cleanly
    // rather than hang or crash the child.
    const transport = new StdioClientTransport({
      command: RUNTIME,
      args: [WECHAT_MCP_MAIN],
      env: {
        ...process.env as Record<string, string>,
        // Point at port 1 — privileged on linux, fails fast with ECONNREFUSED.
        WECHAT_INTERNAL_API: 'http://127.0.0.1:1',
        WECHAT_INTERNAL_TOKEN_FILE: join(stateDir, 'never-exists'),
      },
      stderr: 'pipe',
    })
    const c = new Client({ name: 'integration-test-noapi', version: '0.0.1' }, { capabilities: {} })
    await c.connect(transport)
    client = c

    const result = await client.callTool({ name: 'ping', arguments: {} })
    expect(result.isError).toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    expect(content[0]?.text).toMatch(/ping failed/)
  })
})
