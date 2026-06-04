import { describe, it, expect } from 'vitest'
import { GEMINI_CAPABILITIES, tierProfileToGeminiSdkOpts, mcpToolsToFunctionDeclarations } from './gemini-agent-provider'
import { TIER_PROFILES } from './user-tier'

describe('GEMINI_CAPABILITIES', () => {
  it('declares per-tool gating, no SDK sandbox, no delegation/resume in v1', () => {
    expect(GEMINI_CAPABILITIES.perToolCallback).toBe(true)
    expect([...GEMINI_CAPABILITIES.sandboxLevels]).toEqual([])
    expect(GEMINI_CAPABILITIES.supportsDelegation).toBe(false)
    expect(GEMINI_CAPABILITIES.supportsResume).toBe(false)
  })
})

describe('tierProfileToGeminiSdkOpts', () => {
  it('dangerously → gate disabled; strict → gate enabled (all tiers)', () => {
    expect(tierProfileToGeminiSdkOpts(TIER_PROFILES.admin, 'dangerously')).toEqual({ gateEnabled: false })
    expect(tierProfileToGeminiSdkOpts(TIER_PROFILES.admin, 'strict')).toEqual({ gateEnabled: true })
    expect(tierProfileToGeminiSdkOpts(TIER_PROFILES.guest, 'strict')).toEqual({ gateEnabled: true })
  })
})

describe('mcpToolsToFunctionDeclarations', () => {
  it('maps MCP tools to Gemini functionDeclarations, stripping JSON-Schema meta keys', () => {
    const mcpTools = [
      { name: 'reply', description: 'reply to the user', inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, text: { type: 'string' } }, required: ['chat_id', 'text'], $schema: 'http://json-schema.org/draft-07/schema#', additionalProperties: false } },
      { name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {}, $schema: 'http://json-schema.org/draft-07/schema#' } },
    ]
    const fns = mcpToolsToFunctionDeclarations(mcpTools)
    expect(fns).toEqual([
      { name: 'reply', description: 'reply to the user', parameters: { type: 'object', properties: { chat_id: { type: 'string' }, text: { type: 'string' } }, required: ['chat_id', 'text'] } },
      { name: 'ping', description: 'ping', parameters: { type: 'object', properties: {} } },
    ])
  })
})
