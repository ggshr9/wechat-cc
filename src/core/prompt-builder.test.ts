import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from './prompt-builder'

describe('buildSystemPrompt', () => {
  function defaults() {
    return {
      providerId: 'claude' as const,
      peerProviderId: 'codex' as const,
      companionEnabled: false,
      delegateAvailable: true,
    }
  }

  it('includes the channel base section + reply tool guidance', () => {
    const p = buildSystemPrompt(defaults())
    expect(p).toContain('wechat-cc 的消息通道')
    expect(p).toContain('reply')
    expect(p).toContain('FALLBACK_REPLY')   // accurate fallback log tag (RFC 03 review #4)
  })

  it('lists every wechat-mcp tool surface (no v0.x staleness regression)', () => {
    const p = buildSystemPrompt(defaults())
    // The original v0.x prompt missed these. Verify they're back.
    for (const t of ['reply', 'reply_voice', 'send_file', 'edit_message', 'broadcast',
                     'list_projects', 'switch_project', 'add_project', 'remove_project',
                     'set_user_name',
                     'voice_config_status', 'save_voice_config',
                     'share_page', 'resurface_page',
                     'memory_read', 'memory_write', 'memory_list',
                     'companion_status', 'companion_enable', 'companion_disable', 'companion_snooze']) {
      expect(p, `missing tool: ${t}`).toContain(t)
    }
  })

  it('mentions delegate_codex when this is the claude session (delegateAvailable=true)', () => {
    const p = buildSystemPrompt({ ...defaults(), providerId: 'claude', peerProviderId: 'codex' })
    expect(p).toContain('delegate_codex')
    expect(p).not.toContain('delegate_claude')   // peer-of-claude is codex, not claude
  })

  it('mentions delegate_claude when this is the codex session (mirror)', () => {
    const p = buildSystemPrompt({ ...defaults(), providerId: 'codex', peerProviderId: 'claude' })
    expect(p).toContain('delegate_claude')
    expect(p).not.toContain('delegate_codex')
  })

  it('omits delegate section when delegateAvailable=false (e.g. bare delegate-mode session)', () => {
    const p = buildSystemPrompt({ ...defaults(), delegateAvailable: false })
    expect(p).not.toContain('delegate_codex')
    expect(p).not.toContain('跨 AI 咨询')
  })

  it('mentions per-chat mode awareness (RFC 03 P2-P5)', () => {
    const p = buildSystemPrompt(defaults())
    for (const cmd of ['/cc', '/codex', '/both', '/chat', '/cc + codex', '/codex + cc']) {
      expect(p, `missing slash command in mode awareness: ${cmd}`).toContain(cmd)
    }
    // Also tells the agent that chatroom envelopes will explain themselves
    expect(p).toContain('chatroom_round')
    expect(p).toContain('不要调 reply')   // chatroom-specific guidance recap
  })

  it('mentions parallel mode prefix is auto-added (so agent does not double-prefix)', () => {
    const p = buildSystemPrompt(defaults())
    expect(p).toMatch(/parallel.*前缀.*不要/s)
  })

  it('omits Companion proactive-push section when disabled', () => {
    const p = buildSystemPrompt({ ...defaults(), companionEnabled: false })
    // The full proactive-tick section (with "已开启" marker + scheduler details) is omitted.
    expect(p).not.toContain('已开启')
    expect(p).not.toContain('定时 tick')
    // companion tool names still listed in tool-surface section though — that's invariant.
    expect(p).toContain('companion_status')
  })

  it('includes Companion proactive-push section when enabled', () => {
    const p = buildSystemPrompt({ ...defaults(), companionEnabled: true })
    expect(p).toContain('Companion 主动推送（已开启）')
    expect(p).toContain('companion_snooze')
    expect(p).toContain('companion_disable')
    expect(p).toContain('定时 tick')
  })

  it('memory section is always present (memory is provider-agnostic)', () => {
    const p1 = buildSystemPrompt(defaults())
    const p2 = buildSystemPrompt({ ...defaults(), companionEnabled: true })
    expect(p1).toContain('memory_read')
    expect(p2).toContain('memory_read')
  })

  it('produces deterministic output (no Date.now or env reads)', () => {
    const a = buildSystemPrompt(defaults())
    const b = buildSystemPrompt(defaults())
    expect(a).toBe(b)
  })

  it('handles unknown / future providerId pairs without crashing', () => {
    expect(() => buildSystemPrompt({
      providerId: 'gemini' as const, peerProviderId: 'mistral' as const,
      companionEnabled: false, delegateAvailable: true,
    })).not.toThrow()
    const p = buildSystemPrompt({
      providerId: 'gemini' as const, peerProviderId: 'mistral' as const,
      companionEnabled: false, delegateAvailable: true,
    })
    expect(p).toContain('delegate_mistral')
  })
})
