import { describe, it, expect } from 'vitest'
import {
  HealthResponse,
  MemoryReadRequest, MemoryReadResponse,
  MemoryWriteRequest, MemoryWriteResponse,
  MemoryListQuery, MemoryListResponse,
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
