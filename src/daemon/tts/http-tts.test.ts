import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeHttpTTSProvider } from './http-tts'
import { Buffer } from 'node:buffer'

const originalFetch = globalThis.fetch

describe('HttpTTSProvider', () => {
  beforeEach(() => { globalThis.fetch = vi.fn() as any })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('has name="http_tts"', () => {
    const p = makeHttpTTSProvider({
      baseUrl: 'http://mac:8000/v1/audio/speech',
      model: 'openbmb/VoxCPM2',
    })
    expect(p.name).toBe('http_tts')
  })

  it('synth POSTs {model, voice, input} to baseUrl and returns audio buffer', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true, status: 200,
      arrayBuffer: async () => new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer,  // "RIFF" WAV header
      headers: new Map([['content-type', 'audio/wav']]),
    })
    const p = makeHttpTTSProvider({
      baseUrl: 'http://mac:8000/v1/audio/speech',
      model: 'openbmb/VoxCPM2',
    })
    const out = await p.synth('你好', 'default')
    expect(out.audio).toBeInstanceOf(Buffer)
    expect(out.audio.length).toBeGreaterThan(0)
    expect(out.mimeType).toContain('audio/wav')
    const call = (globalThis.fetch as any).mock.calls[0]
    expect(call[0]).toBe('http://mac:8000/v1/audio/speech')
    const body = JSON.parse(call[1].body as string)
    expect(body).toMatchObject({ model: 'openbmb/VoxCPM2', voice: 'default', input: '你好' })
  })

  it('omits Authorization header when apiKey is undefined (local VoxCPM2 case)', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(10),
      headers: new Map([['content-type', 'audio/wav']]),
    })
    const p = makeHttpTTSProvider({
      baseUrl: 'http://mac:8000/v1/audio/speech',
      model: 'openbmb/VoxCPM2',
    })
    await p.synth('x', 'default')
    const headers = (globalThis.fetch as any).mock.calls[0][1].headers
    // Either omitted, or empty-string, or undefined — but NOT "Bearer undefined"
    const auth = headers['Authorization'] ?? headers['authorization']
    expect(auth === undefined || auth === '' || auth === null).toBe(true)
    // And definitely does not contain the string "undefined"
    expect(String(auth ?? '')).not.toContain('undefined')
  })

  it('includes Authorization: Bearer header when apiKey is provided (real OpenAI case)', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(10),
      headers: new Map([['content-type', 'audio/mpeg']]),
    })
    const p = makeHttpTTSProvider({
      baseUrl: 'https://api.openai.com/v1/audio/speech',
      model: 'gpt-4o-mini-tts',
      apiKey: 'sk-abc',
    })
    await p.synth('hi', 'nova')
    const headers = (globalThis.fetch as any).mock.calls[0][1].headers
    const auth = headers['Authorization'] ?? headers['authorization']
    expect(auth).toBe('Bearer sk-abc')
  })

  it('synth throws on non-200', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: false, status: 500, text: async () => 'server error',
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: new Map(),
    })
    const p = makeHttpTTSProvider({
      baseUrl: 'http://x/v1/audio/speech', model: 'm',
    })
    await expect(p.synth('t', 'v')).rejects.toThrow(/500/)
  })

  it('test() returns {ok:true} on success', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(5),
      headers: new Map([['content-type', 'audio/wav']]),
    })
    const p = makeHttpTTSProvider({
      baseUrl: 'http://x/v1/audio/speech', model: 'm',
    })
    expect(await p.test()).toEqual({ ok: true })
  })

  it('test() returns {ok:false, reason} on 401', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: false, status: 401, text: async () => 'unauthorized',
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: new Map(),
    })
    const p = makeHttpTTSProvider({
      baseUrl: 'http://x/v1/audio/speech', model: 'm', apiKey: 'sk-bad',
    })
    const r = await p.test()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/unauth|401/i)
  })

  it('test() uses provided defaultVoice', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(5),
      headers: new Map([['content-type', 'audio/wav']]),
    })
    const p = makeHttpTTSProvider({
      baseUrl: 'http://x/v1/audio/speech', model: 'm', defaultVoice: 'Cherry',
    })
    await p.test()
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body as string)
    expect(body.voice).toBe('Cherry')
  })
})
