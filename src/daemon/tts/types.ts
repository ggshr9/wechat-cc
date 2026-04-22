/**
 * TTS provider abstraction for wechat-cc outbound voice.
 *
 * Two concrete impls in v1.1:
 *   - makeHttpTTSProvider (covers VoxCPM2 via vLLM-Omni + real OpenAI — shared OpenAI-compatible /v1/audio/speech shape)
 *   - makeQwenProvider (DashScope cloud fallback — different API shape)
 */
import type { Buffer } from 'node:buffer'

export interface TTSProvider {
  readonly name: 'http_tts' | 'qwen'
  /** Synthesize text to audio. mimeType is producer-native (MP3 for OpenAI/Qwen, WAV for VoxCPM2). */
  synth(text: string, voice: string): Promise<{ audio: Buffer; mimeType: string }>
  /** One-second sanity check: synth "测试" and discard. Used by save_voice_config before persisting config. */
  test(): Promise<{ ok: true } | { ok: false; reason: string; detail?: string }>
}
