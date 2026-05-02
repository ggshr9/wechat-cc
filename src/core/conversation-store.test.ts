import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeConversationStore } from './conversation-store'
import { modeRequiresParticipantPrefix } from './conversation'

describe('ConversationStore', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'conv-store-'))
    file = join(dir, 'conversations.json')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('starts empty', () => {
    const s = makeConversationStore(file, { debounceMs: 0 })
    expect(s.get('chat-1')).toBeNull()
    expect(s.all()).toEqual({})
  })

  it('set + get for solo mode', () => {
    const s = makeConversationStore(file, { debounceMs: 0 })
    s.set('chat-1', { kind: 'solo', provider: 'codex' })
    const r = s.get('chat-1')
    expect(r?.mode).toEqual({ kind: 'solo', provider: 'codex' })
  })

  it('set replaces previous mode for the same chat', () => {
    const s = makeConversationStore(file, { debounceMs: 0 })
    s.set('chat-1', { kind: 'solo', provider: 'claude' })
    s.set('chat-1', { kind: 'solo', provider: 'codex' })
    expect(s.get('chat-1')?.mode).toEqual({ kind: 'solo', provider: 'codex' })
  })

  it('set works for parallel and chatroom modes (no provider field)', () => {
    const s = makeConversationStore(file, { debounceMs: 0 })
    s.set('chat-a', { kind: 'parallel' })
    s.set('chat-b', { kind: 'chatroom' })
    s.set('chat-c', { kind: 'primary_tool', primary: 'claude' })
    expect(s.get('chat-a')?.mode).toEqual({ kind: 'parallel' })
    expect(s.get('chat-b')?.mode).toEqual({ kind: 'chatroom' })
    expect(s.get('chat-c')?.mode).toEqual({ kind: 'primary_tool', primary: 'claude' })
  })

  it('delete removes the record', () => {
    const s = makeConversationStore(file, { debounceMs: 0 })
    s.set('chat-1', { kind: 'solo', provider: 'codex' })
    s.delete('chat-1')
    expect(s.get('chat-1')).toBeNull()
  })

  it('persists across instances + writes mode 0600', async () => {
    const s1 = makeConversationStore(file, { debounceMs: 0 })
    s1.set('chat-1', { kind: 'solo', provider: 'codex' })
    s1.set('chat-2', { kind: 'parallel' })
    await s1.flush()
    const st = statSync(file)
    // POSIX 0600 is the contract; Windows / NTFS doesn't model POSIX modes
    // and fs.stat returns 0666. Skip the mode assertion there.
    if (process.platform !== 'win32') {
      expect((st.mode & 0o777).toString(8)).toBe('600')
    }

    const s2 = makeConversationStore(file, { debounceMs: 0 })
    expect(s2.get('chat-1')?.mode).toEqual({ kind: 'solo', provider: 'codex' })
    expect(s2.get('chat-2')?.mode).toEqual({ kind: 'parallel' })
  })

  it('survives corrupt JSON (starts empty)', () => {
    writeFileSync(file, '{not json')
    const s = makeConversationStore(file, { debounceMs: 0 })
    expect(s.get('x')).toBeNull()
    s.set('x', { kind: 'solo', provider: 'claude' })
    expect(s.get('x')?.mode.kind).toBe('solo')
  })

  it('all() returns a snapshot copy (independent of subsequent set)', () => {
    const s = makeConversationStore(file, { debounceMs: 0 })
    s.set('chat-1', { kind: 'solo', provider: 'claude' })
    const snap = s.all()
    s.set('chat-2', { kind: 'parallel' })
    expect(Object.keys(snap)).toEqual(['chat-1'])
  })

  it('reads JSON in the v1 format with `conversations` field', async () => {
    writeFileSync(file, JSON.stringify({
      version: 1,
      conversations: { 'chat-x': { mode: { kind: 'solo', provider: 'codex' } } },
    }))
    const s = makeConversationStore(file, { debounceMs: 0 })
    expect(s.get('chat-x')?.mode).toEqual({ kind: 'solo', provider: 'codex' })
  })
})

describe('modeRequiresParticipantPrefix (RFC 03 review #5)', () => {
  it('returns true for parallel + chatroom (multi-participant modes)', () => {
    expect(modeRequiresParticipantPrefix({ kind: 'parallel' })).toBe(true)
    expect(modeRequiresParticipantPrefix({ kind: 'chatroom' })).toBe(true)
  })

  it('returns false for solo + primary_tool (single-visible-speaker modes)', () => {
    expect(modeRequiresParticipantPrefix({ kind: 'solo', provider: 'claude' })).toBe(false)
    expect(modeRequiresParticipantPrefix({ kind: 'solo', provider: 'codex' })).toBe(false)
    expect(modeRequiresParticipantPrefix({ kind: 'primary_tool', primary: 'claude' })).toBe(false)
    expect(modeRequiresParticipantPrefix({ kind: 'primary_tool', primary: 'codex' })).toBe(false)
  })
})
