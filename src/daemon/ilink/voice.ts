/**
 * Voice sub-adapter — TTS synthesis, config, and voice-reply delivery.
 *
 * Lives in its own module so when v1.2 Task 3 splits MCP servers, the
 * wechat-voice MCP can depend on this module directly instead of re-
 * importing the full ilink-glue surface.
 */
import { join } from 'node:path'
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import type { WechatVoiceDep } from '../wechat-tool-deps'
import { buildMediaItemFromFile } from '../media'
import { ilinkSendMessage } from '../../lib/ilink'
import { log } from '../../lib/log'
import { loadVoiceConfig, saveVoiceConfig, type VoiceConfig } from '../tts/voice-config'
import { makeHttpTTSProvider } from '../tts/http-tts'
import { makeQwenProvider } from '../tts/qwen'
import type { TTSProvider } from '../tts/types'
import type { IlinkContext } from './context'

function providerFromConfig(cfg: VoiceConfig): TTSProvider {
  if (cfg.provider === 'http_tts') {
    return makeHttpTTSProvider({
      baseUrl: cfg.base_url,
      model: cfg.model,
      apiKey: cfg.api_key,
      defaultVoice: cfg.default_voice,
    })
  }
  return makeQwenProvider({ apiKey: cfg.api_key })
}

export function makeVoice(ctx: IlinkContext): WechatVoiceDep {
  const { stateDir, ctxStore, resolveAccount, assertChatRoutable } = ctx

  return {
    async replyVoice(chatId, text) {
      const cfg = loadVoiceConfig(stateDir)
      if (!cfg) return { ok: false as const, reason: 'not_configured' }
      // Fail fast before spending TTS synthesis time / CDN upload bandwidth
      // on a chat we won't be able to deliver to.
      try { assertChatRoutable(chatId) } catch (err) {
        const errmsg = err instanceof Error ? err.message : String(err)
        log('VOICE', `replyVoice REJECTED chat=${chatId}: ${errmsg}`)
        return { ok: false as const, reason: errmsg }
      }
      try {
        const provider = providerFromConfig(cfg)
        const { audio, mimeType } = await provider.synth(
          text,
          cfg.default_voice ?? (cfg.provider === 'qwen' ? 'Cherry' : 'default'),
        )
        const tmpDir = join(stateDir, 'tts-tmp')
        mkdirSync(tmpDir, { recursive: true })
        const ext = /wav/i.test(mimeType) ? '.wav' : '.mp3'
        const tmpPath = join(tmpDir, `reply-${Date.now()}-${process.pid}${ext}`)
        writeFileSync(tmpPath, audio)
        try {
          const acct = resolveAccount(chatId)
          // Voice bubble path (voice_item, encode_type=7) is silently dropped
          // by the WeChat client — confirmed 2026-04-23 Spike 4 4-config
          // sweep; openclaw-weixin has VoiceItem types but no sendVoice;
          // openclaw/#56225 open. Until Tencent ships sendVoice, always send
          // as a file attachment so the user at least receives a playable
          // WAV/MP3. buildVoiceItemFromWav kept in media.ts for forward-
          // enablement.
          const item = await buildMediaItemFromFile(tmpPath, chatId, acct.baseUrl, acct.token)
          const ctxToken = ctxStore.get(chatId)
          await ilinkSendMessage(acct.baseUrl, acct.token, {
            to_user_id: chatId,
            message_type: 2,
            message_state: 2,
            item_list: [item],
            context_token: ctxToken,
          })
          const msgId = `v-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          log('VOICE', `replyVoice sent chat=${chatId} chars=${text.length} bytes=${audio.length}`)
          return { ok: true as const, msgId }
        } finally {
          try { unlinkSync(tmpPath) } catch { /* best-effort */ }
        }
      } catch (err) {
        const errmsg = err instanceof Error ? err.message : String(err)
        log('VOICE', `replyVoice FAILED chat=${chatId}: ${errmsg}`)
        const reason = /5\d\d/.test(errmsg) ? 'transient' : 'error'
        return { ok: false as const, reason }
      }
    },

    async saveConfig(input) {
      if (input.provider === 'http_tts') {
        if (!input.base_url || !input.model) {
          return { ok: false as const, reason: 'invalid', detail: 'http_tts needs base_url + model' }
        }
      } else {
        if (!input.api_key) {
          return { ok: false as const, reason: 'invalid', detail: 'qwen needs api_key' }
        }
      }
      const cfg: VoiceConfig = input.provider === 'http_tts'
        ? {
            provider: 'http_tts',
            base_url: input.base_url!,
            model: input.model!,
            api_key: input.api_key,
            default_voice: input.default_voice,
            saved_at: new Date().toISOString(),
          }
        : {
            provider: 'qwen',
            api_key: input.api_key!,
            default_voice: input.default_voice,
            saved_at: new Date().toISOString(),
          }
      const provider = providerFromConfig(cfg)
      const started = Date.now()
      const test = await provider.test()
      if (!test.ok) {
        return { ok: false as const, reason: test.reason, detail: test.detail }
      }
      await saveVoiceConfig(stateDir, cfg)
      return {
        ok: true as const,
        tested_ms: Date.now() - started,
        provider: input.provider,
        default_voice: input.default_voice ?? (input.provider === 'qwen' ? 'Cherry' : 'default'),
      }
    },

    configStatus() {
      const cfg = loadVoiceConfig(stateDir)
      if (!cfg) return { configured: false as const }
      return {
        configured: true as const,
        provider: cfg.provider,
        default_voice: cfg.default_voice ?? (cfg.provider === 'qwen' ? 'Cherry' : 'default'),
        base_url: cfg.provider === 'http_tts' ? cfg.base_url : undefined,
        model: cfg.provider === 'http_tts' ? cfg.model : undefined,
        saved_at: cfg.saved_at,
      }
    },
  }
}
