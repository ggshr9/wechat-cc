/**
 * ilink.ts — ilink API types and HTTP helpers.
 *
 * Pure transport layer: knows how to talk to ilink but has no business
 * logic about what to do with the messages. Imported by server.ts, cdn.ts,
 * and (transitively) anything that sends or receives ilink traffic.
 */

import { randomBytes } from 'crypto'
import { ILINK_APP_ID, LONG_POLL_TIMEOUT_MS } from './config.ts'
import { log } from './log.ts'

// ── Per-file constants (see config.ts for why these aren't shared) ────────
const ILINK_CLIENT_VERSION = '131335' // 2.1.7 → 0x00020107
const API_TIMEOUT_MS = 30_000
export const ILINK_BASE_INFO = { channel_version: '2.1.7' } as const

// ── Types ─────────────────────────────────────────────────────────────────

export interface WeixinMessage {
  seq?: number
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  create_time_ms?: number
  update_time_ms?: number
  message_type?: number   // 1=user, 2=bot
  message_state?: number  // 0=new, 1=generating, 2=finish
  item_list?: MessageItem[]
  context_token?: string
  session_id?: string
}

export interface CDNMedia {
  encrypt_query_param?: string
  aes_key?: string       // base64-encoded
  encrypt_type?: number
  full_url?: string
}

export interface MessageItem {
  type?: number  // 1=text, 2=image, 3=voice, 4=file, 5=video
  msg_id?: string
  text_item?: { text?: string }
  voice_item?: { text?: string; media?: CDNMedia; encode_type?: number; bits_per_sample?: number; sample_rate?: number; playtime?: number }
  ref_msg?: { title?: string; message_item?: { type?: number; text_item?: { text?: string }; unsupported_item?: { text?: string } } }
  image_item?: { media?: CDNMedia; aeskey?: string; mid_size?: number; hd_size?: number }
  file_item?: { media?: CDNMedia; file_name?: string; md5?: string; len?: string }
  video_item?: { media?: CDNMedia; video_size?: number; thumb_media?: CDNMedia }
}

export interface GetUpdatesResp {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeixinMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

// ── HTTP helpers ──────────────────────────────────────────────────────────

function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf-8').toString('base64')
}

function buildHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': ILINK_CLIENT_VERSION,
    'X-WECHAT-UIN': randomWechatUin(),
  }
  if (token) h['Authorization'] = `Bearer ${token}`
  return h
}

export async function ilinkPost(baseUrl: string, endpoint: string, body: object, token?: string, timeoutMs = API_TIMEOUT_MS): Promise<string> {
  const url = new URL(endpoint, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/')
  const json = JSON.stringify(body)
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { ...buildHeaders(token), 'Content-Length': String(Buffer.byteLength(json, 'utf-8')) },
      body: json,
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`${endpoint} ${res.status}: ${await res.text()}`)
    return await res.text()
  } finally { clearTimeout(t) }
}

// ── API calls ─────────────────────────────────────────────────────────────

export async function ilinkGetUpdates(baseUrl: string, token: string, buf: string): Promise<GetUpdatesResp> {
  try {
    const raw = await ilinkPost(baseUrl, 'ilink/bot/getupdates', {
      get_updates_buf: buf,
      base_info: ILINK_BASE_INFO,
    }, token, LONG_POLL_TIMEOUT_MS)
    return JSON.parse(raw) as GetUpdatesResp
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: buf }
    }
    throw err
  }
}

export function generateClientId(): string {
  return `claude-code-wechat:${Date.now()}-${randomBytes(4).toString('hex')}`
}

export function botTextMessage(toUserId: string, text: string, ctxToken?: string): WeixinMessage {
  return {
    to_user_id: toUserId,
    message_type: 2,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text } }],
    context_token: ctxToken,
  }
}

export async function ilinkSendMessage(baseUrl: string, token: string, msg: WeixinMessage): Promise<void> {
  const body = {
    msg: { from_user_id: '', client_id: generateClientId(), ...msg },
    base_info: ILINK_BASE_INFO,
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await ilinkPost(baseUrl, 'ilink/bot/sendmessage', body, token)
      return
    } catch (err) {
      const isRetryable = err instanceof Error &&
        (err.name === 'AbortError' || /^ilink.*5\d\d/.test(err.message))
      if (!isRetryable || attempt === 3) throw err
      log('RETRY', `sendmessage attempt ${attempt} failed, retrying in 1s: ${err instanceof Error ? err.message : err}`)
      await new Promise(r => setTimeout(r, 1000))
    }
  }
}

export async function ilinkSendTyping(baseUrl: string, token: string, userId: string, ticket: string): Promise<void> {
  await ilinkPost(baseUrl, 'ilink/bot/sendtyping', {
    ilink_user_id: userId,
    typing_ticket: ticket,
    status: 1,
    base_info: ILINK_BASE_INFO,
  }, token)
}

export async function ilinkGetConfig(baseUrl: string, token: string, userId: string, contextToken?: string): Promise<{ typing_ticket?: string }> {
  const raw = await ilinkPost(baseUrl, 'ilink/bot/getconfig', {
    ilink_user_id: userId,
    context_token: contextToken,
    base_info: ILINK_BASE_INFO,
  }, token)
  return JSON.parse(raw)
}
