import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeQwenProvider } from './qwen'
import { Buffer } from 'node:buffer'

const originalFetch = globalThis.fetch

describe('QwenProvider', () => {
  beforeEach(() => { globalThis.fetch = vi.fn() as any })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('has name="qwen"', () => {
    const p = makeQwenProvider({ apiKey: 'sk-test' })
    expect(p.name).toBe('qwen')
  })

  it('synth returns audio buffer on success', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([0x49, 0x44, 0x33, 0x04]).buffer,  // "ID3" MP3 header
      headers: new Map([['content-type', 'audio/mpeg']]),
    })
    const p = makeQwenProvider({ apiKey: 'sk-test' })
    const out = await p.synth('你好', 'Cherry')
    expect(out.audio).toBeInstanceOf(Buffer)
    expect(out.mimeType).toContain('audio/mpeg')
    expect(out.audio.length).toBeGreaterThan(0)
  })

  it('synth throws on non-200 response', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: false, status: 401, text: async () => 'invalid api key',
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: new Map(),
    })
    const p = makeQwenProvider({ apiKey: 'sk-bad' })
    await expect(p.synth('x', 'Cherry')).rejects.toThrow(/401|invalid/i)
  })

  it('test() returns {ok:true} on success', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true, status: 200,
      arrayBuffer: async () => new Uint8Array([1,2,3]).buffer,
      headers: new Map([['content-type', 'audio/mpeg']]),
    })
    const p = makeQwenProvider({ apiKey: 'sk-test' })
    expect(await p.test()).toEqual({ ok: true })
  })

  it('test() returns {ok:false} with reason on failure', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: false, status: 401, text: async () => 'unauthorized',
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: new Map(),
    })
    const p = makeQwenProvider({ apiKey: 'sk-bad' })
    const r = await p.test()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toMatch(/unauthorized|401/i)
    }
  })

  it('sends Authorization: Bearer header', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(10),
      headers: new Map([['content-type', 'audio/mpeg']]),
    })
    const p = makeQwenProvider({ apiKey: 'sk-abc' })
    await p.synth('x', 'Cherry')
    const call = (globalThis.fetch as any).mock.calls[0]
    const headers = call[1]?.headers ?? {}
    const authHeader = headers['Authorization'] ?? headers['authorization']
    expect(authHeader).toBe('Bearer sk-abc')
  })

  it('posts body with model, text input, voice parameter', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(10),
      headers: new Map([['content-type', 'audio/mpeg']]),
    })
    const p = makeQwenProvider({ apiKey: 'sk-test' })
    await p.synth('嗨', 'Cherry')
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body as string)
    expect(body.model).toBe('qwen3-tts-flash')
    expect(body.voice ?? body.parameters?.voice).toBe('Cherry')
    expect(body.input ?? body.text ?? body.input?.text).toBeTruthy()
  })
})
