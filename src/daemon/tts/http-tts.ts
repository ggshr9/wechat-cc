import type { TTSProvider } from './types'
import { Buffer } from 'node:buffer'

export interface HttpTTSProviderOptions {
  /** Full endpoint URL, e.g. 'http://mac:8000/v1/audio/speech' or 'https://api.openai.com/v1/audio/speech' */
  baseUrl: string
  /** Model id, e.g. 'openbmb/VoxCPM2' or 'gpt-4o-mini-tts' */
  model: string
  /** Optional. Omit for local VoxCPM2 reached via Tailscale LAN. Required for real OpenAI. */
  apiKey?: string
  /** Used by .test() and when reply_voice doesn't provide a voice explicitly. Default 'default'. */
  defaultVoice?: string
}

export function makeHttpTTSProvider(opts: HttpTTSProviderOptions): TTSProvider {
  const defaultVoice = opts.defaultVoice ?? 'default'

  async function synth(text: string, voice: string) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (opts.apiKey) headers['Authorization'] = `Bearer ${opts.apiKey}`
    const res = await fetch(opts.baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: opts.model,
        voice,
        input: text,
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`HTTP TTS ${res.status}: ${body.slice(0, 200)}`)
    }
    const audio = Buffer.from(await res.arrayBuffer())
    const mimeType = typeof res.headers.get === 'function'
      ? (res.headers.get('content-type') ?? 'audio/mpeg')
      : 'audio/mpeg'
    return { audio, mimeType }
  }

  async function test(): Promise<{ ok: true } | { ok: false; reason: string; detail?: string }> {
    try {
      await synth('测试', defaultVoice)
      return { ok: true }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      const status = /\b(\d{3})\b/.exec(detail)?.[1]
      const reason = status === '401' ? 'unauthorized (check api key)'
        : status === '404' ? 'endpoint not found (check base_url)'
        : status === '429' ? 'rate limited'
        : /^5\d\d/.test(status ?? '') ? 'tts service error'
        : /ECONNREFUSED|fetch failed/i.test(detail) ? 'cannot connect (is vllm serve running?)'
        : 'unknown'
      return { ok: false, reason, detail }
    }
  }

  return { name: 'http_tts' as const, synth, test }
}
