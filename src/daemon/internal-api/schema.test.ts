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
