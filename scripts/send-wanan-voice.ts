#!/usr/bin/env bun
/**
 * Overnight task: synthesize "晚安" via VoxCPM2 (running on homebot Mac,
 * reached via SSH tunnel to 127.0.0.1:8765) and send to user's WeChat.
 *
 * Run from the repo root. Requires the SSH tunnel to be up:
 *   ssh -N -L 8765:127.0.0.1:8765 homebot@100.64.249.44
 */
import { writeFileSync, unlinkSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Buffer } from 'node:buffer'
import { buildMediaItemFromFile } from '../src/daemon/media'
import { ilinkSendMessage } from '../src/lib/ilink'

const VOXCPM_URL = 'http://127.0.0.1:8765/v1/audio/speech'
const CHAT_ID = 'o9cq800sObd3lbrHBgiItB1pooDQ@im.wechat'
const ACCT_DIR = join(homedir(), '.claude', 'channels', 'wechat', 'accounts', '050e6db19b2f-im-bot')

interface Account { baseUrl: string; userId: string; botId: string }
const ACCT: Account = JSON.parse(readFileSync(join(ACCT_DIR, 'account.json'), 'utf8'))
const TOKEN = readFileSync(join(ACCT_DIR, 'token'), 'utf8').trim()

async function main() {
  // Voice design: young female, gentle, loli
  const voiceDescriptor = '年轻女性，温柔甜美，萝莉音色'
  const text = `(${voiceDescriptor})晚安`

  console.log('[tts] POST', VOXCPM_URL)
  const started = Date.now()
  const res = await fetch(VOXCPM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'openbmb/VoxCPM2', input: text, voice: 'default' }),
  })
  if (!res.ok) throw new Error(`VoxCPM2 ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const audio = Buffer.from(await res.arrayBuffer())
  console.log(`[tts] ${audio.length} bytes WAV in ${Date.now() - started}ms`)

  // Save
  const tmpDir = join(homedir(), '.claude', 'channels', 'wechat', 'tts-tmp')
  mkdirSync(tmpDir, { recursive: true })
  const tmpPath = join(tmpDir, `voxcpm-wanan-${Date.now()}.wav`)
  writeFileSync(tmpPath, audio)
  console.log(`[tts] saved ${tmpPath}`)

  // Upload + send as file attachment (voice-bubble requires specific upload type + params; TBD)
  console.log('[ilink] uploading + building MessageItem')
  const item = await buildMediaItemFromFile(tmpPath, CHAT_ID, ACCT.baseUrl, TOKEN)
  console.log(`[ilink] item.type=${item.type}`)

  const msg = {
    to_user_id: CHAT_ID,
    message_type: 2,
    message_state: 2,
    item_list: [item],
    context_token: '',
  }
  console.log('[ilink] sending...')
  await ilinkSendMessage(ACCT.baseUrl, TOKEN, msg as any)
  console.log('[ilink] DONE — message dispatched')

  try { unlinkSync(tmpPath) } catch {}
}

main().catch(e => {
  console.error('[fatal]', e)
  process.exit(1)
})
