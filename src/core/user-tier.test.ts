import { describe, it, expect } from 'vitest'
import { resolveTier, resolveEffectiveTier, TIER_PROFILES, type UserTier, type ToolKind } from './user-tier'
import type { Access } from '../lib/access'

const baseAccess: Access = {
  dmPolicy: 'allowlist',
  allowFrom: ['admin1', 'trusted1', 'guest1'],
  admins: ['admin1'],
  trusted: ['trusted1'],
}

describe('resolveTier', () => {
  it('returns admin when chatId is in admins', () => {
    expect(resolveTier('admin1', baseAccess)).toBe('admin')
  })

  it('returns trusted when chatId is in trusted but not admins', () => {
    expect(resolveTier('trusted1', baseAccess)).toBe('trusted')
  })

  it('returns guest for allowed-but-unclassified chats', () => {
    expect(resolveTier('guest1', baseAccess)).toBe('guest')
  })

  it('returns guest when admins is empty', () => {
    expect(resolveTier('any', { ...baseAccess, admins: [] })).toBe('guest')
  })

  it('admin takes precedence over trusted if both lists include the chatId', () => {
    expect(resolveTier('dupe', {
      ...baseAccess, admins: ['dupe'], trusted: ['dupe'],
    })).toBe('admin')
  })
})

describe('resolveEffectiveTier — --dangerously override', () => {
  it('strict mode: behaves identically to resolveTier', () => {
    expect(resolveEffectiveTier('admin1', baseAccess, 'strict')).toBe('admin')
    expect(resolveEffectiveTier('trusted1', baseAccess, 'strict')).toBe('trusted')
    expect(resolveEffectiveTier('guest1', baseAccess, 'strict')).toBe('guest')
    expect(resolveEffectiveTier('unknown', baseAccess, 'strict')).toBe('guest')
  })

  it('dangerously mode: every chat is promoted to admin', () => {
    // The operator launched `wechat-cc run --dangerously` expecting all
    // chats to bypass sandbox/relay. Pre-fix, only access.admins chats
    // got admin perms; guest/trusted chats silently kept their reduced
    // sandbox (codex guest → read-only + untrusted, claude trusted →
    // canUseTool relay) regardless of the daemon flag.
    expect(resolveEffectiveTier('admin1', baseAccess, 'dangerously')).toBe('admin')
    expect(resolveEffectiveTier('trusted1', baseAccess, 'dangerously')).toBe('admin')
    expect(resolveEffectiveTier('guest1', baseAccess, 'dangerously')).toBe('admin')
    expect(resolveEffectiveTier('unknown', baseAccess, 'dangerously')).toBe('admin')
  })
})

describe('TIER_PROFILES', () => {
  const ALL_KINDS: ToolKind[] = [
    'reply', 'share_page', 'memory_read', 'memory_write', 'memory_delete',
    'observations_read', 'observations_write',
    'fs_read', 'fs_write', 'shell', 'shell_destructive', 'network', 'subagent',
    'a2a_send',
  ]

  for (const tier of ['admin', 'trusted', 'guest'] as UserTier[]) {
    it(`tier=${tier}: allow ∪ relay ∪ deny covers every ToolKind exactly once`, () => {
      const p = TIER_PROFILES[tier]
      const seen = new Set<ToolKind>()
      for (const k of p.allow) seen.add(k)
      for (const k of p.relay) {
        expect(p.allow.has(k)).toBe(false)
        seen.add(k)
      }
      for (const k of p.deny) {
        expect(p.allow.has(k)).toBe(false)
        expect(p.relay.has(k)).toBe(false)
        seen.add(k)
      }
      for (const k of ALL_KINDS) {
        expect(seen.has(k)).toBe(true)
      }
    })
  }

  it('admin relays destructive ops only (post-RFC-05 / C4)', () => {
    // Post-RFC-05: admin tier is no longer "auto-bypass everything".
    // Destructive Bash and memory_delete now relay to the admin chat
    // (which is the admin themselves per resolveAdminChatId), giving
    // a "are you sure?" gate. Operators wanting zero prompts launch
    // with `--dangerously`.
    expect(TIER_PROFILES.admin.relay.has('shell_destructive')).toBe(true)
    expect(TIER_PROFILES.admin.relay.has('memory_delete')).toBe(true)
    expect(TIER_PROFILES.admin.relay.size).toBe(2)
    expect(TIER_PROFILES.admin.deny.size).toBe(0)
    // Non-destructive ops stay auto-allowed.
    expect(TIER_PROFILES.admin.allow.has('shell')).toBe(true)
    expect(TIER_PROFILES.admin.allow.has('fs_read')).toBe(true)
    expect(TIER_PROFILES.admin.allow.has('a2a_send')).toBe(true)
  })

  it('trusted relays shell_destructive and memory_delete', () => {
    expect(TIER_PROFILES.trusted.relay.has('shell_destructive')).toBe(true)
    expect(TIER_PROFILES.trusted.relay.has('memory_delete')).toBe(true)
    expect(TIER_PROFILES.trusted.deny.size).toBe(0)
  })

  it('guest allows only reply/share_page/memory_read/observations_read', () => {
    expect(TIER_PROFILES.guest.allow.has('reply')).toBe(true)
    expect(TIER_PROFILES.guest.allow.has('share_page')).toBe(true)
    expect(TIER_PROFILES.guest.allow.has('memory_read')).toBe(true)
    expect(TIER_PROFILES.guest.allow.has('observations_read')).toBe(true)
    expect(TIER_PROFILES.guest.allow.has('shell')).toBe(false)
    expect(TIER_PROFILES.guest.allow.has('fs_write')).toBe(false)
  })
})

import { classifyToolUse } from './user-tier'

describe('classifyToolUse', () => {
  it('reply → reply', () => {
    expect(classifyToolUse('mcp__wechat__reply', {})).toBe('reply')
  })
  it('share_page → share_page', () => {
    expect(classifyToolUse('mcp__wechat__share_page', {})).toBe('share_page')
  })
  it('memory_list / memory_read → memory_read', () => {
    expect(classifyToolUse('mcp__wechat__memory_list', {})).toBe('memory_read')
    expect(classifyToolUse('mcp__wechat__memory_read', {})).toBe('memory_read')
  })
  it('memory_write / memory_edit → memory_write', () => {
    expect(classifyToolUse('mcp__wechat__memory_write', {})).toBe('memory_write')
    expect(classifyToolUse('mcp__wechat__memory_edit', {})).toBe('memory_write')
  })
  it('memory_delete → memory_delete', () => {
    expect(classifyToolUse('mcp__wechat__memory_delete', {})).toBe('memory_delete')
  })
  it('observations_list / observations_read → observations_read', () => {
    expect(classifyToolUse('mcp__wechat__observations_list', {})).toBe('observations_read')
    expect(classifyToolUse('mcp__wechat__observations_read', {})).toBe('observations_read')
  })
  it('observations_write / observations_archive → observations_write', () => {
    expect(classifyToolUse('mcp__wechat__observations_write', {})).toBe('observations_write')
    expect(classifyToolUse('mcp__wechat__observations_archive', {})).toBe('observations_write')
  })
  it('Read / Glob / Grep / LS → fs_read', () => {
    expect(classifyToolUse('Read', {})).toBe('fs_read')
    expect(classifyToolUse('Glob', {})).toBe('fs_read')
    expect(classifyToolUse('Grep', {})).toBe('fs_read')
    expect(classifyToolUse('LS', {})).toBe('fs_read')
  })
  it('Write / Edit / NotebookEdit → fs_write', () => {
    expect(classifyToolUse('Write', {})).toBe('fs_write')
    expect(classifyToolUse('Edit', {})).toBe('fs_write')
    expect(classifyToolUse('NotebookEdit', {})).toBe('fs_write')
  })
  it('Bash with non-destructive command → shell', () => {
    expect(classifyToolUse('Bash', { command: 'ls -la' })).toBe('shell')
    expect(classifyToolUse('Bash', { command: 'git status' })).toBe('shell')
    expect(classifyToolUse('Bash', { command: 'echo hello' })).toBe('shell')
  })
  it('Bash with destructive patterns → shell_destructive', () => {
    expect(classifyToolUse('Bash', { command: 'rm -rf /tmp/foo' })).toBe('shell_destructive')
    expect(classifyToolUse('Bash', { command: 'rm file.txt' })).toBe('shell_destructive')
    expect(classifyToolUse('Bash', { command: 'git reset --hard HEAD~1' })).toBe('shell_destructive')
    expect(classifyToolUse('Bash', { command: 'git push origin main --force' })).toBe('shell_destructive')
    expect(classifyToolUse('Bash', { command: 'git push --force-with-lease' })).toBe('shell_destructive')
    expect(classifyToolUse('Bash', { command: 'git branch -D feature' })).toBe('shell_destructive')
  })
  it('Bash with destructive command inside bash -c "..." → shell_destructive', () => {
    // AI agents routinely chain commands via `bash -c "..."`; the destructive
    // intent inside quotes must still trigger the relay. Trigger class
    // includes `'` and `"` for this reason.
    expect(classifyToolUse('Bash', { command: 'bash -c "rm -rf /tmp/important"' })).toBe('shell_destructive')
    expect(classifyToolUse('Bash', { command: "bash -c 'rm -rf /tmp/important'" })).toBe('shell_destructive')
    expect(classifyToolUse('Bash', { command: 'sh -c "git reset --hard HEAD~1"' })).toBe('shell_destructive')
    expect(classifyToolUse('Bash', { command: 'bash -c "cd foo && git push --force"' })).toBe('shell_destructive')
  })
  it('Bash echoing a destructive string is a known false positive (relay-side)', () => {
    // Conservative classifier: prefer over-prompting to under-prompting.
    // `echo "rm is dangerous"` doesn't actually delete anything, but the
    // tier policy classifies it as destructive so the operator sees a
    // relay prompt. Acceptable trade since the intent is preventing
    // accidents, not stopping a determined adversary.
    expect(classifyToolUse('Bash', { command: 'echo "rm is dangerous"' })).toBe('shell_destructive')
  })
  it('Bash with rm-substring inside path is not destructive', () => {
    // The word-boundary anchor (`\s+` after rm) requires rm to look like a
    // command token, so `/var/farm/...` stays classified as plain shell.
    expect(classifyToolUse('Bash', { command: 'ls /var/farm/data' })).toBe('shell')
    expect(classifyToolUse('Bash', { command: 'cd /home/uname/' })).toBe('shell')
  })
  it('KillShell → shell', () => {
    expect(classifyToolUse('KillShell', { shell_id: 'x' })).toBe('shell')
  })
  it('WebFetch / WebSearch → network', () => {
    expect(classifyToolUse('WebFetch', {})).toBe('network')
    expect(classifyToolUse('WebSearch', {})).toBe('network')
  })
  it('Task → subagent', () => {
    expect(classifyToolUse('Task', {})).toBe('subagent')
  })
  it('unknown tool defaults to subagent (treated as untrusted)', () => {
    expect(classifyToolUse('SomeNewToolNobodyDocumented', {})).toBe('subagent')
  })
})

describe('user-tier — a2a_send', () => {
  it('classifies mcp__wechat__a2a_send as ToolKind a2a_send', () => {
    expect(classifyToolUse('mcp__wechat__a2a_send', { agent_id: 'x', text: 'hi' })).toBe('a2a_send')
  })

  it('admin tier allows a2a_send', () => {
    expect(TIER_PROFILES.admin.allow.has('a2a_send')).toBe(true)
  })

  it('trusted tier relays a2a_send (requires approval)', () => {
    expect(TIER_PROFILES.trusted.relay.has('a2a_send')).toBe(true)
    expect(TIER_PROFILES.trusted.allow.has('a2a_send')).toBe(false)
  })

  it('guest tier denies a2a_send', () => {
    expect(TIER_PROFILES.guest.allow.has('a2a_send')).toBe(false)
    expect(TIER_PROFILES.guest.relay.has('a2a_send')).toBe(false)
  })
})
