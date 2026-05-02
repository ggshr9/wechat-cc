#!/usr/bin/env bun
/**
 * Tiny stdio MCP server with a single `echo` tool. Used by Spike 1 to
 * verify that Codex SDK's programmatic config injection actually causes
 * the resulting Codex CLI session to load + invoke an MCP server.
 *
 * Hand-rolled JSON-RPC over stdio (no @modelcontextprotocol/sdk dep) so
 * the spike is hermetic — only depends on @openai/codex-sdk + node stdlib.
 *
 * Protocol subset implemented (just enough for tools/list + tools/call):
 *   - initialize
 *   - tools/list
 *   - tools/call (with name="echo", args={text: string})
 *   - notifications/initialized (ignored)
 *
 * Logs to stderr (not stdout — stdout is the MCP transport).
 */

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string
  result?: unknown
  error?: { code: number; message: string }
}

const log = (...args: unknown[]) => {
  process.stderr.write(`[echo-mcp] ${args.map(String).join(' ')}\n`)
}

function send(msg: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function handle(req: JsonRpcRequest): JsonRpcResponse | null {
  log('recv', req.method, 'id=', req.id)

  if (req.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: req.id!,
      result: {
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'echo-mcp-spike', version: '0.0.1' },
        capabilities: { tools: {} },
      },
    }
  }

  if (req.method === 'notifications/initialized') {
    // Notification, no response.
    return null
  }

  if (req.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: req.id!,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Returns its input text verbatim. Used to verify MCP wiring.',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string', description: 'The text to echo back.' } },
              required: ['text'],
              additionalProperties: false,
            },
          },
        ],
      },
    }
  }

  if (req.method === 'tools/call') {
    const params = req.params as { name: string; arguments?: { text?: string } }
    if (params.name !== 'echo') {
      return {
        jsonrpc: '2.0',
        id: req.id!,
        error: { code: -32601, message: `unknown tool: ${params.name}` },
      }
    }
    const text = params.arguments?.text ?? ''
    log('echo', JSON.stringify(text))
    return {
      jsonrpc: '2.0',
      id: req.id!,
      result: {
        content: [{ type: 'text', text }],
        isError: false,
      },
    }
  }

  return {
    jsonrpc: '2.0',
    id: req.id!,
    error: { code: -32601, message: `method not found: ${req.method}` },
  }
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buf += chunk
  let idx: number
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    try {
      const req = JSON.parse(line) as JsonRpcRequest
      const resp = handle(req)
      if (resp) send(resp)
    } catch (err) {
      log('parse error:', err instanceof Error ? err.message : err, 'line=', line.slice(0, 200))
    }
  }
})

process.stdin.on('end', () => {
  log('stdin ended, exiting')
  process.exit(0)
})

log('ready (stdio)')
