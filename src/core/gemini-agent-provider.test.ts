import { describe, it, expect } from 'vitest'
import { GEMINI_CAPABILITIES, tierProfileToGeminiSdkOpts } from './gemini-agent-provider'
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
