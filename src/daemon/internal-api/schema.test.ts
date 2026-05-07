import { describe, it, expect } from 'vitest'
import {
  HealthResponse,
  MemoryReadRequest, MemoryReadResponse,
  MemoryWriteRequest, MemoryWriteResponse,
  MemoryListQuery, MemoryListResponse,
  ProjectsListResponse,
  ProjectsSwitchRequest, ProjectsSwitchResponse,
  ProjectsAddRequest, ProjectsAddResponse,
  ProjectsRemoveRequest, ProjectsRemoveResponse,
  UserSetNameRequest, UserSetNameResponse,
  SharePageRequest, SharePageResponse,
  ShareResurfaceRequest, ShareResurfaceResponse,
  VoiceStatusResponse,
  VoiceSaveConfigRequest, VoiceSaveConfigResponse,
  CompanionStatusResponse,
  CompanionEnableResponse,
  CompanionDisableResponse,
  CompanionSnoozeRequest, CompanionSnoozeResponse,
} from './schema'

// ── health ──────────────────────────────────────────────────────────────────

describe('HealthResponse', () => {
  it('accepts valid response', () => {
    expect(HealthResponse.safeParse({ ok: true, daemon_pid: 12345 }).success).toBe(true)
  })
  it('rejects missing daemon_pid', () => {
    expect(HealthResponse.safeParse({ ok: true }).success).toBe(false)
  })
})

// ── memory/read ──────────────────────────────────────────────────────────────

describe('MemoryReadRequest', () => {
  it('accepts { path }', () => {
    expect(MemoryReadRequest.safeParse({ path: 'foo/bar.md' }).success).toBe(true)
  })
  it('rejects missing path', () => {
    expect(MemoryReadRequest.safeParse({}).success).toBe(false)
  })
})

describe('MemoryReadResponse', () => {
  it('accepts exists=false', () => {
    expect(MemoryReadResponse.safeParse({ exists: false }).success).toBe(true)
  })
  it('accepts exists=true with content', () => {
    expect(MemoryReadResponse.safeParse({ exists: true, content: 'hi' }).success).toBe(true)
  })
  it('accepts error variant', () => {
    expect(MemoryReadResponse.safeParse({ error: 'ENOENT' }).success).toBe(true)
  })
})

// ── memory/write ─────────────────────────────────────────────────────────────

describe('MemoryWriteRequest', () => {
  it('accepts { path, content }', () => {
    expect(MemoryWriteRequest.safeParse({ path: 'a.md', content: 'b' }).success).toBe(true)
  })
  it('rejects missing content', () => {
    expect(MemoryWriteRequest.safeParse({ path: 'a.md' }).success).toBe(false)
  })
})

describe('MemoryWriteResponse', () => {
  it('accepts ok=true', () => {
    expect(MemoryWriteResponse.safeParse({ ok: true }).success).toBe(true)
  })
  it('accepts ok=false with error', () => {
    expect(MemoryWriteResponse.safeParse({ ok: false, error: 'EACCES' }).success).toBe(true)
  })
})

// ── memory/list ──────────────────────────────────────────────────────────────

describe('MemoryListQuery', () => {
  it('accepts empty query', () => {
    expect(MemoryListQuery.safeParse({}).success).toBe(true)
  })
  it('accepts { dir }', () => {
    expect(MemoryListQuery.safeParse({ dir: 'sub' }).success).toBe(true)
  })
})

describe('MemoryListResponse', () => {
  it('accepts file array', () => {
    expect(MemoryListResponse.safeParse({ files: ['a.md', 'b.md'] }).success).toBe(true)
  })
  it('accepts error variant', () => {
    expect(MemoryListResponse.safeParse({ error: 'EBADF' }).success).toBe(true)
  })
})

// ── GET /v1/projects/list ────────────────────────────────────────────────────

describe('ProjectsListResponse', () => {
  it('accepts an empty array', () => {
    expect(ProjectsListResponse.safeParse([]).success).toBe(true)
  })
  it('accepts an array with items', () => {
    expect(ProjectsListResponse.safeParse([{ alias: 'foo', path: '/tmp', current: false }]).success).toBe(true)
  })
})

// ── POST /v1/projects/switch ─────────────────────────────────────────────────

describe('ProjectsSwitchRequest', () => {
  it('accepts { alias }', () => {
    expect(ProjectsSwitchRequest.safeParse({ alias: 'foo' }).success).toBe(true)
  })
  it('rejects missing alias', () => {
    expect(ProjectsSwitchRequest.safeParse({}).success).toBe(false)
  })
})

describe('ProjectsSwitchResponse', () => {
  it('accepts ok=true with path', () => {
    expect(ProjectsSwitchResponse.safeParse({ ok: true, path: '/tmp/proj' }).success).toBe(true)
  })
  it('accepts ok=false with reason', () => {
    expect(ProjectsSwitchResponse.safeParse({ ok: false, reason: 'not found' }).success).toBe(true)
  })
})

// ── POST /v1/projects/add ────────────────────────────────────────────────────

describe('ProjectsAddRequest', () => {
  it('accepts { alias, path }', () => {
    expect(ProjectsAddRequest.safeParse({ alias: 'foo', path: '/tmp' }).success).toBe(true)
  })
  it('rejects missing path', () => {
    expect(ProjectsAddRequest.safeParse({ alias: 'foo' }).success).toBe(false)
  })
})

describe('ProjectsAddResponse', () => {
  it('accepts ok=true', () => {
    expect(ProjectsAddResponse.safeParse({ ok: true }).success).toBe(true)
  })
  it('accepts ok=false with error', () => {
    expect(ProjectsAddResponse.safeParse({ ok: false, error: 'duplicate' }).success).toBe(true)
  })
})

// ── POST /v1/projects/remove ─────────────────────────────────────────────────

describe('ProjectsRemoveRequest', () => {
  it('accepts { alias }', () => {
    expect(ProjectsRemoveRequest.safeParse({ alias: 'foo' }).success).toBe(true)
  })
  it('rejects missing alias', () => {
    expect(ProjectsRemoveRequest.safeParse({}).success).toBe(false)
  })
})

describe('ProjectsRemoveResponse', () => {
  it('accepts ok=true', () => {
    expect(ProjectsRemoveResponse.safeParse({ ok: true }).success).toBe(true)
  })
  it('accepts ok=false with error', () => {
    expect(ProjectsRemoveResponse.safeParse({ ok: false, error: 'not found' }).success).toBe(true)
  })
})

// ── POST /v1/user/set_name ───────────────────────────────────────────────────

describe('UserSetNameRequest', () => {
  it('accepts snake_case chat_id', () => {
    expect(UserSetNameRequest.safeParse({ chat_id: 'abc', name: 'Alice' }).success).toBe(true)
  })
  it('rejects camelCase chatId (missing chat_id)', () => {
    expect(UserSetNameRequest.safeParse({ chatId: 'abc', name: 'Alice' }).success).toBe(false)
  })
})

describe('UserSetNameResponse', () => {
  it('accepts ok=true', () => {
    expect(UserSetNameResponse.safeParse({ ok: true }).success).toBe(true)
  })
  it('accepts ok=false with error', () => {
    expect(UserSetNameResponse.safeParse({ ok: false, error: 'failed' }).success).toBe(true)
  })
})

// ── POST /v1/share/page ──────────────────────────────────────────────────────

describe('SharePageRequest', () => {
  it('accepts title + content only', () => {
    expect(SharePageRequest.safeParse({ title: 'T', content: 'C' }).success).toBe(true)
  })
  it('accepts all optional fields', () => {
    expect(SharePageRequest.safeParse({
      title: 'T', content: 'C',
      needs_approval: true, chat_id: 'abc', account_id: 'acct',
    }).success).toBe(true)
  })
  it('rejects missing title', () => {
    expect(SharePageRequest.safeParse({ content: 'C' }).success).toBe(false)
  })
})

describe('SharePageResponse', () => {
  it('accepts url + slug on success', () => {
    expect(SharePageResponse.safeParse({ url: 'https://x.com/s/abc', slug: 'abc' }).success).toBe(true)
  })
  it('accepts ok=false with error', () => {
    expect(SharePageResponse.safeParse({ ok: false, error: 'share failed' }).success).toBe(true)
  })
})

// ── POST /v1/share/resurface ─────────────────────────────────────────────────

describe('ShareResurfaceRequest', () => {
  it('accepts slug', () => {
    expect(ShareResurfaceRequest.safeParse({ slug: 'foo' }).success).toBe(true)
  })
  it('accepts title_fragment', () => {
    expect(ShareResurfaceRequest.safeParse({ title_fragment: 'foo' }).success).toBe(true)
  })
  it('accepts empty object (server returns not-found)', () => {
    expect(ShareResurfaceRequest.safeParse({}).success).toBe(true)
  })
})

describe('ShareResurfaceResponse', () => {
  it('accepts url + slug on success', () => {
    expect(ShareResurfaceResponse.safeParse({ url: 'https://x.com/s/abc', slug: 'abc' }).success).toBe(true)
  })
  it('accepts ok=false reason=not found', () => {
    expect(ShareResurfaceResponse.safeParse({ ok: false, reason: 'not found' }).success).toBe(true)
  })
  it('accepts ok=false with generic error', () => {
    expect(ShareResurfaceResponse.safeParse({ ok: false, error: 'db error' }).success).toBe(true)
  })
})

// ── GET /v1/voice/status ─────────────────────────────────────────────────────

describe('VoiceStatusResponse', () => {
  it('accepts configured=false', () => {
    expect(VoiceStatusResponse.safeParse({ configured: false }).success).toBe(true)
  })
  it('accepts configured=true with full fields', () => {
    expect(VoiceStatusResponse.safeParse({
      configured: true,
      provider: 'http_tts',
      default_voice: 'zh-CN-XiaoxiaoNeural',
      saved_at: '2026-05-07T10:00:00Z',
    }).success).toBe(true)
  })
  it('accepts configured=true with optional base_url + model', () => {
    expect(VoiceStatusResponse.safeParse({
      configured: true,
      provider: 'qwen',
      default_voice: 'qwen-voice',
      base_url: 'https://api.qwen.com',
      model: 'qwen-tts-v1',
      saved_at: '2026-05-07T10:00:00Z',
    }).success).toBe(true)
  })
})

// ── POST /v1/voice/save_config ───────────────────────────────────────────────

describe('VoiceSaveConfigRequest', () => {
  it('accepts http_tts provider', () => {
    expect(VoiceSaveConfigRequest.safeParse({ provider: 'http_tts' }).success).toBe(true)
  })
  it('accepts qwen provider with api_key', () => {
    expect(VoiceSaveConfigRequest.safeParse({ provider: 'qwen', api_key: 'sk-x' }).success).toBe(true)
  })
  it('rejects unknown provider', () => {
    expect(VoiceSaveConfigRequest.safeParse({ provider: 'foo' }).success).toBe(false)
  })
})

describe('VoiceSaveConfigResponse', () => {
  it('accepts ok=true with tested_ms + provider + default_voice', () => {
    expect(VoiceSaveConfigResponse.safeParse({
      ok: true, tested_ms: 120, provider: 'http_tts', default_voice: 'zh-CN-XiaoxiaoNeural',
    }).success).toBe(true)
  })
  it('accepts ok=false with reason', () => {
    expect(VoiceSaveConfigResponse.safeParse({ ok: false, reason: 'bad_url' }).success).toBe(true)
  })
  it('accepts ok=false reason=unexpected_error with detail', () => {
    expect(VoiceSaveConfigResponse.safeParse({
      ok: false, reason: 'unexpected_error', detail: 'ECONNREFUSED',
    }).success).toBe(true)
  })
})

// ── GET /v1/companion/status ─────────────────────────────────────────────────

describe('CompanionStatusResponse', () => {
  it('accepts enabled=false with nulls', () => {
    expect(CompanionStatusResponse.safeParse({
      enabled: false,
      timezone: 'Asia/Shanghai',
      default_chat_id: null,
      snooze_until: null,
    }).success).toBe(true)
  })
  it('accepts enabled=true with snooze', () => {
    expect(CompanionStatusResponse.safeParse({
      enabled: true,
      timezone: 'Asia/Shanghai',
      default_chat_id: 'abc123',
      snooze_until: '2026-05-07T12:00:00Z',
    }).success).toBe(true)
  })
})

// ── POST /v1/companion/enable ────────────────────────────────────────────────

describe('CompanionEnableResponse', () => {
  it('accepts ok=true with new config fields', () => {
    expect(CompanionEnableResponse.safeParse({
      ok: true,
      state_dir: '/home/.companion',
      welcome_message: 'Welcome!',
      cost_estimate_note: 'costs ~$0.01/day',
    }).success).toBe(true)
  })
  it('accepts ok=true already_configured', () => {
    expect(CompanionEnableResponse.safeParse({ ok: true, already_configured: true }).success).toBe(true)
  })
  it('accepts ok=false with error (forward-compat)', () => {
    expect(CompanionEnableResponse.safeParse({ ok: false, error: 'failed' }).success).toBe(true)
  })
})

// ── POST /v1/companion/disable ───────────────────────────────────────────────

describe('CompanionDisableResponse', () => {
  it('accepts ok=true enabled=false', () => {
    expect(CompanionDisableResponse.safeParse({ ok: true, enabled: false }).success).toBe(true)
  })
  it('accepts ok=false with error (forward-compat)', () => {
    expect(CompanionDisableResponse.safeParse({ ok: false, error: 'failed' }).success).toBe(true)
  })
})

// ── POST /v1/companion/snooze ────────────────────────────────────────────────

describe('CompanionSnoozeRequest', () => {
  it('accepts 1 minute', () => {
    expect(CompanionSnoozeRequest.safeParse({ minutes: 1 }).success).toBe(true)
  })
  it('accepts 1440 minutes (24h)', () => {
    expect(CompanionSnoozeRequest.safeParse({ minutes: 1440 }).success).toBe(true)
  })
  it('rejects 0 minutes', () => {
    expect(CompanionSnoozeRequest.safeParse({ minutes: 0 }).success).toBe(false)
  })
  it('rejects > 1440 minutes', () => {
    expect(CompanionSnoozeRequest.safeParse({ minutes: 1441 }).success).toBe(false)
  })
  it('rejects non-integer', () => {
    expect(CompanionSnoozeRequest.safeParse({ minutes: 1.5 }).success).toBe(false)
  })
})

describe('CompanionSnoozeResponse', () => {
  it('accepts ok=true with until timestamp', () => {
    expect(CompanionSnoozeResponse.safeParse({ ok: true, until: '2026-05-07T12:00:00Z' }).success).toBe(true)
  })
  it('accepts ok=false with error (forward-compat)', () => {
    expect(CompanionSnoozeResponse.safeParse({ ok: false, error: 'failed' }).success).toBe(true)
  })
})
