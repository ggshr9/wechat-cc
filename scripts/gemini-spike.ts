// Throwaway spike — verifies @google/genai + MCP SDK under Bun.
/* eslint-disable no-console */
async function smokeImport() {
  console.log('=== import + instantiate under Bun ===')
  const genai = await import('@google/genai')
  console.log('genai exports:', Object.keys(genai).slice(0, 25).join(', '))
  const Ctor = (genai as any).GoogleGenAI ?? (genai as any).GoogleGenerativeAI
  console.log('constructor present:', Ctor?.name ?? 'NONE')
  const ai = new Ctor({ apiKey: process.env.GEMINI_API_KEY ?? 'dummy-no-call' })
  console.log('instantiated ok; typeof ai.models:', typeof (ai as any).models)
  console.log('ai.models methods:', (ai as any).models ? Object.getOwnPropertyNames(Object.getPrototypeOf((ai as any).models)).join(', ') : 'n/a')

  const mcpClient = await import('@modelcontextprotocol/sdk/client/index.js')
  console.log('mcp client exports:', Object.keys(mcpClient).join(', '))
  const mcpStdio = await import('@modelcontextprotocol/sdk/client/stdio.js')
  console.log('mcp stdio exports:', Object.keys(mcpStdio).join(', '))
  console.log('IMPORT-SMOKE: OK')
}
await smokeImport()
