// Throwaway spike — MCP client listTools probe against wechat stdio server.
/* eslint-disable no-console */
async function smokeMcp() {
  console.log('=== MCP client listTools ===')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  // wechatStdioMcpSpec (src/daemon/bootstrap/mcp-specs.ts) uses:
  //   command: process.execPath  (bun in source mode)
  //   args:    [join(here, '..', '..', 'mcp-servers', 'wechat', 'main.ts')]
  //   env:     WECHAT_INTERNAL_API + WECHAT_INTERNAL_TOKEN_FILE (+ optional WECHAT_PARTICIPANT_TAG)
  // The server exits(2) if either env is absent; with dummy values it starts,
  // registers its tools, then connects — listTools resolves before any tool
  // call tries the internal-api, so a dummy URL is sufficient for enumeration.
  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['src/mcp-servers/wechat/main.ts'],
    env: {
      ...process.env,
      WECHAT_INTERNAL_API: 'http://127.0.0.1:19999',       // dummy — no daemon running
      WECHAT_INTERNAL_TOKEN_FILE: '/tmp/spike-dummy-token', // dummy — never read for listTools
    },
  })
  const client = new Client({ name: 'gemini-spike', version: '0.0.0' }, { capabilities: {} })
  await client.connect(transport)
  const tools = await client.listTools()
  console.log('tool count:', tools.tools.length)
  console.log('tool names:', tools.tools.map((t: { name: string }) => t.name).join(', '))
  console.log('first tool full:', JSON.stringify(tools.tools[0], null, 2))
  await client.close()
  console.log('MCP-SMOKE: OK')
}
await smokeMcp()
