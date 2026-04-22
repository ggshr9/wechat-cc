import type { TTSProvider } from './types'
import { Buffer } from 'node:buffer'

export interface QwenProviderOptions {
  apiKey: string
  /** Defaults to 'qwen3-tts-flash' */
  model?: string
  /** Defaults to the public DashScope endpoint. */
  baseUrl?: string
}

// NOTE: DashScope TTS endpoint — verify exact path if API changes.
// The public API at spec-writing time accepts POST {model, input:{text}, parameters:{voice}}
// and returns audio bytes directly (not base64 in JSON).
const DEFAULT_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/'

export function makeQwenProvider(opts: QwenProviderOptions): TTSProvider {
  const endpoint = opts.baseUrl ?? DEFAULT_ENDPOINT
  const model = opts.model ?? 'qwen3-tts-flash'

  async function synth(text: string, voice: string) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: { text },
        parameters: { voice },
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Qwen TTS ${res.status}: ${body.slice(0, 200)}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    const mimeType = typeof res.headers.get === 'function'
      ? (res.headers.get('content-type') ?? 'audio/mpeg')
      : 'audio/mpeg'
    return { audio: buf, mimeType }
  }

  async function test(): Promise<{ ok: true } | { ok: false; reason: string; detail?: string }> {
    try {
      await synth('测试', 'Cherry')
      return { ok: true }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      const status = /\b(\d{3})\b/.exec(detail)?.[1]
      const reason = status === '401' ? 'unauthorized (check api key)'
        : status === '429' ? 'rate limited'
        : /^5\d\d/.test(status ?? '') ? 'qwen service error'
        : 'unknown'
      return { ok: false, reason, detail }
    }
  }

  return { name: 'qwen' as const, synth, test }
}
