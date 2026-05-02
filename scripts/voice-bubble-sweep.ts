#!/usr/bin/env bun
/**
 * Voice bubble parameter sweep: synthesizes ONE WAV via VoxCPM2, then sends
 * it to WeChat under many different upload + voice_item shapes so the user
 * can visually tell (on their phone) which config actually renders a bubble.
 *
 * Each config is preceded by a plain text label message so you can scroll
 * through WeChat chat and see "A came through as file", "F came through as
 * bubble", etc. Then we pick the winning shape.
 *
 * Usage:
 *   bun scripts/voice-bubble-sweep.ts [chat_id] [account_id]
 * Defaults to the first entry in user_account_ids.json.
 */
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { uploadToCdn, UPLOAD_MEDIA_TYPE, parseWavHeader } from '../src/daemon/media'
import { ilinkSendMessage, botTextMessage, type MessageItem, type CDNMedia } from '../ilink'

const STATE_DIR = join(homedir(), '.claude', 'channels', 'wechat')
const TTS_URL = 'http://127.0.0.1:8765/v1/audio/speech'
const SAMPLE_TEXT = '(年轻女性，温柔甜美)语音气泡测试'

const userAccountIds = JSON.parse(readFileSync(join(STATE_DIR, 'user_account_ids.json'), 'utf8')) as Record<string, string>
const chat_id_raw = process.argv[2] ?? Object.keys(userAccountIds)[0]
if (!chat_id_raw) throw new Error('no chat_id (pass as argv[2] or seed user_account_ids.json)')
const chat_id: string = chat_id_raw
const account_id_raw = process.argv[3] ?? userAccountIds[chat_id]
if (!account_id_raw) throw new Error(`no account_id for chat ${chat_id}`)
const account_id: string = account_id_raw

const acctDir = join(STATE_DIR, 'accounts', account_id)
const account = JSON.parse(readFileSync(join(acctDir, 'account.json'), 'utf8')) as { baseUrl: string }
const token = readFileSync(join(acctDir, 'token'), 'utf8').trim()
const ctxTokens = JSON.parse(readFileSync(join(STATE_DIR, 'context_tokens.json'), 'utf8')) as Record<string, string>
const ctxToken = ctxTokens[chat_id]
if (!ctxToken) throw new Error(`no context_token for ${chat_id}`)

console.log(`[sweep] chat=${chat_id} account=${account_id} base=${account.baseUrl}`)

async function synthWav(): Promise<Buffer> {
  const res = await fetch(TTS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'openbmb/VoxCPM2', input: SAMPLE_TEXT, voice: 'default' }),
  })
  if (!res.ok) throw new Error(`TTS ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

function transcodeWavToMp3(wavPath: string, mp3Path: string, sampleRate: number, bitrate = '32k'): void {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', wavPath,
    '-ar', String(sampleRate), '-ac', '1', '-b:a', bitrate,
    '-codec:a', 'libmp3lame', mp3Path,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr?.toString().slice(0, 200)}`)
}

async function sendText(text: string) {
  try {
    await ilinkSendMessage(account.baseUrl, token, botTextMessage(chat_id, text, ctxToken))
  } catch (err) {
    console.log(`[sweep]   sendText failed: ${err instanceof Error ? err.message : err}`)
  }
}

async function sendVoiceItem(item: MessageItem, label: string) {
  try {
    await ilinkSendMessage(account.baseUrl, token, {
      to_user_id: chat_id, message_type: 2, message_state: 2,
      item_list: [item], context_token: ctxToken,
    })
    console.log(`[sweep] ${label} → ilink accepted`)
  } catch (err) {
    console.log(`[sweep] ${label} → FAILED: ${err instanceof Error ? err.message : err}`)
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

async function uploadFile(filePath: string, mediaType: number): Promise<CDNMedia> {
  const up = await uploadToCdn({ filePath, toUserId: chat_id, baseUrl: account.baseUrl, token, mediaType })
  return {
    encrypt_query_param: up.downloadParam,
    aes_key: Buffer.from(up.aeskey).toString('base64'),
    encrypt_type: 1,
  }
}

async function main() {
  const tmpDir = join(STATE_DIR, 'tts-tmp')
  mkdirSync(tmpDir, { recursive: true })
  const wavPath = join(tmpDir, `sweep-${Date.now()}.wav`)
  const mp3Path = wavPath.replace(/\.wav$/, '.mp3')
  const mp3_24k = wavPath.replace(/\.wav$/, '.24k.mp3')
  const mp3_16k = wavPath.replace(/\.wav$/, '.16k.mp3')

  console.log('[sweep] synthesizing once via Mac …')
  const wavBuf = await synthWav()
  writeFileSync(wavPath, wavBuf)
  const { sampleRate: wavRate, bitsPerSample, durationMs } = parseWavHeader(wavBuf)
  console.log(`[sweep] WAV: ${wavBuf.length}B  ${wavRate}Hz/${bitsPerSample}bit  ${durationMs}ms`)

  console.log('[sweep] transcoding MP3 variants …')
  transcodeWavToMp3(wavPath, mp3_24k, 24000)
  transcodeWavToMp3(wavPath, mp3_16k, 16000)
  transcodeWavToMp3(wavPath, mp3Path, 44100)

  // Pre-upload each variant once — avoid re-uploading the same bytes 8 times.
  console.log('[sweep] uploading variants …')
  const mediaWavAsVOICE = await uploadFile(wavPath, UPLOAD_MEDIA_TYPE.VOICE)
  const mediaWavAsFILE = await uploadFile(wavPath, UPLOAD_MEDIA_TYPE.FILE)
  const mediaMp3_24k_VOICE = await uploadFile(mp3_24k, UPLOAD_MEDIA_TYPE.VOICE)
  const mediaMp3_24k_FILE = await uploadFile(mp3_24k, UPLOAD_MEDIA_TYPE.FILE)
  const mediaMp3_16k_VOICE = await uploadFile(mp3_16k, UPLOAD_MEDIA_TYPE.VOICE)
  const mediaMp3_44k_VOICE = await uploadFile(mp3Path, UPLOAD_MEDIA_TYPE.VOICE)

  // Build 8 experiments. Label appears before the voice so you can tell them
  // apart on WeChat ("A failed", "C rendered as bubble!", etc.).
  const configs: { label: string; desc: string; item: MessageItem }[] = [
    {
      label: 'A', desc: 'MP3 24k / upload=VOICE(4) / msg.type=3 / encode_type=7',
      item: { type: 3, voice_item: { media: mediaMp3_24k_VOICE, encode_type: 7, sample_rate: 24000, bits_per_sample: 16, playtime: durationMs } },
    },
    {
      label: 'B', desc: 'MP3 24k / upload=FILE(3) / msg.type=3 / encode_type=7',
      item: { type: 3, voice_item: { media: mediaMp3_24k_FILE, encode_type: 7, sample_rate: 24000, bits_per_sample: 16, playtime: durationMs } },
    },
    {
      label: 'C', desc: 'MP3 24k / upload=VOICE(4) / msg.type=3 / NO encode_type',
      item: { type: 3, voice_item: { media: mediaMp3_24k_VOICE, sample_rate: 24000, bits_per_sample: 16, playtime: durationMs } },
    },
    {
      label: 'D', desc: 'MP3 16k / upload=VOICE(4) / msg.type=3 / encode_type=7',
      item: { type: 3, voice_item: { media: mediaMp3_16k_VOICE, encode_type: 7, sample_rate: 16000, bits_per_sample: 16, playtime: durationMs } },
    },
    {
      label: 'E', desc: 'MP3 44k / upload=VOICE(4) / msg.type=3 / encode_type=7',
      item: { type: 3, voice_item: { media: mediaMp3_44k_VOICE, encode_type: 7, sample_rate: 44100, bits_per_sample: 16, playtime: durationMs } },
    },
    {
      label: 'F', desc: 'RAW WAV / upload=VOICE(4) / msg.type=3 / encode_type=1 (PCM)',
      item: { type: 3, voice_item: { media: mediaWavAsVOICE, encode_type: 1, sample_rate: wavRate, bits_per_sample: bitsPerSample, playtime: durationMs } },
    },
    {
      label: 'G', desc: 'RAW WAV / upload=VOICE(4) / msg.type=3 / NO encode_type',
      item: { type: 3, voice_item: { media: mediaWavAsVOICE, sample_rate: wavRate, bits_per_sample: bitsPerSample, playtime: durationMs } },
    },
    {
      label: 'H', desc: 'baseline — RAW WAV / upload=FILE(3) / msg.type=4 (file)',
      item: { type: 4, file_item: { media: mediaWavAsFILE, file_name: 'voice.wav', len: String(wavBuf.length) } },
    },
  ]

  const onlyLabels = process.env.SWEEP_LABELS?.split(',').map(s => s.trim()) ?? null
  const toRun = onlyLabels ? configs.filter(c => onlyLabels.includes(c.label)) : configs

  if (!onlyLabels) {
    await sendText(`[sweep] 开始 ${toRun.length} 个语音配置实验；每条语音前面会有 [X] 标签。报给我哪几个 X 你看到了 bubble / 文件 / 空。`)
    await sleep(3000)
  }

  for (const cfg of toRun) {
    await sendText(`[${cfg.label}] ${cfg.desc}`)
    await sleep(2500)
    await sendVoiceItem(cfg.item, cfg.label)
    await sleep(5000)   // spread out to avoid ilink rate limiting (errcode=-2)
  }

  await sendText(`[sweep] done (${toRun.map(c => c.label).join(',')}) — 告诉我每个标签下面看到了什么`)

  // Cleanup
  for (const p of [wavPath, mp3Path, mp3_24k, mp3_16k]) {
    try { unlinkSync(p) } catch { /* */ }
  }
  console.log('[sweep] done')
}

main().catch(err => { console.error(err); process.exit(1) })
