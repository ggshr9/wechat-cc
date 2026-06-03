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
    expect(p).toContain('<quote')
  })

  it('opens with `你是 ${providerId}` so the agent knows its own identity (chatroom mode peer disambiguation)', () => {
    const pClaude = buildSystemPrompt({ ...defaults(), providerId: 'claude', peerProviderId: 'codex' })
    expect(pClaude).toContain('你是 claude')
    expect(pClaude).not.toContain('你是 codex')

    const pCodex = buildSystemPrompt({ ...defaults(), providerId: 'codex', peerProviderId: 'claude' })
    expect(pCodex).toContain('你是 codex')
    expect(pCodex).not.toContain('你是 claude')
  })

  it('mentions a2a_send tool and [A2A:<id>] prefix convention', () => {
    const p = buildSystemPrompt(defaults())
    expect(p).toContain('a2a_send')
    expect(p).toContain('[A2A:')
    // Make sure the agent knows agent_id comes from the prefix
    expect(p).toMatch(/agent_id.*前缀|前缀.*agent_id/)
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

  it('warns about forwarding [image:/path] markers verbatim through delegate (Bug B 2026-05-08)', () => {
    // Symmetric to the chatroom moderator paraphrase fix (commits f7acca0
    // + b69973f): the primary writes the delegate prompt itself, so it
    // can drop attachment markers the same way haiku-4-5 does. The fix
    // here is documentation-only — the prompt instructs the primary to
    // copy markers verbatim instead of paraphrasing.
    const p = buildSystemPrompt({ ...defaults(), providerId: 'claude', peerProviderId: 'codex' })
    expect(p).toContain('附件转发')
    expect(p).toContain('[image:/abs/path]')
    expect(p).toContain('marker')
  })

  it('mentions per-chat mode awareness (RFC 03 P2-P5)', () => {
    const p = buildSystemPrompt(defaults())
    // Core per-chat mode switches are present (compact form since prompt-builder
    // update; full command list is in /help, not the system prompt)
    for (const cmd of ['/cc', '/codex', '/both', '/chat', '/solo', '/stop']) {
      expect(p, `missing slash command in mode awareness: ${cmd}`).toContain(cmd)
    }
    // primary_tool pattern present (compact /<p> + <peer> form)
    expect(p).toContain('/<p> + <peer>')
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
    // agenda-driven model: companion authors dated follow-ups, system wakes it to fulfil them
    expect(p).toContain('agenda.md')
    expect(p).toContain('due:YYYY-MM-DD')
  })

  it('Companion agenda-tick guidance: default is to send, only skip if expired or user already reported', () => {
    const p = buildSystemPrompt({ ...defaults(), companionEnabled: true })
    // New model: "默认就是发" — send by default, only suppress when expired or already resolved
    expect(p).toContain('默认就是发')
    expect(p).toContain('不产生 assistant text')
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

  it('declares the envelope ts authoritative for date reasoning', () => {
    const out = buildSystemPrompt({
      providerId: 'claude', companionEnabled: false, delegateAvailable: false,
      peerProviderId: 'codex',
    })
    expect(out).toContain('以 `ts` 为准')
    expect(out).toContain("Today's date")
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
