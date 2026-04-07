#!/usr/bin/env bun
/**
 * WeChat channel for Claude Code.
 *
 * Single-file MCP server bridging WeChat messages via the ilink API.
 * Modeled after the official Telegram channel plugin.
 *
 * State lives in ~/.claude/channels/wechat/ — managed by /wechat:access and /wechat:configure skills.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { randomBytes, randomUUID } from 'crypto'
import {
  readFileSync, writeFileSync, mkdirSync, readdirSync,
  rmSync, statSync, renameSync, realpathSync, chmodSync, existsSync,
} from 'fs'
import { homedir } from 'os'
import { join, sep } from 'path'

// ── Paths ──────────────────────────────────────────────────────────────────
const STATE_DIR = process.env.WECHAT_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'wechat')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const ACCOUNT_FILE = join(STATE_DIR, 'account.json')
const ENV_FILE = join(STATE_DIR, '.env')
const SYNC_BUF_FILE = join(STATE_DIR, 'sync_buf')
const INBOX_DIR = join(STATE_DIR, 'inbox')

// ── .env loading ───────────────────────────────────────────────────────────
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

// ── ilink constants ────────────────────────────────────────────────────────
const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
const ILINK_APP_ID = 'bot'
const ILINK_BOT_TYPE = '3'
const ILINK_CLIENT_VERSION = '65547' // 1.0.11 → 0x0001000B
const LONG_POLL_TIMEOUT_MS = 35_000
const API_TIMEOUT_MS = 15_000
const MAX_TEXT_CHUNK = 4000

const BOT_TOKEN = process.env.WECHAT_BOT_TOKEN ?? ''

// ── ilink types ────────────────────────────────────────────────────────────
interface WeixinMessage {
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

interface MessageItem {
  type?: number  // 1=text, 2=image, 3=voice, 4=file, 5=video
  msg_id?: string
  text_item?: { text?: string }
  // image_item, voice_item, file_item, video_item — v2
}

interface GetUpdatesResp {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeixinMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

// ── ilink HTTP helpers ─────────────────────────────────────────────────────

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

async function ilinkGet(baseUrl: string, endpoint: string, timeoutMs = API_TIMEOUT_MS): Promise<string> {
  const url = new URL(endpoint, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/')
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'iLink-App-Id': ILINK_APP_ID, 'iLink-App-ClientVersion': ILINK_CLIENT_VERSION },
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`${endpoint} ${res.status}: ${await res.text()}`)
    return await res.text()
  } finally { clearTimeout(t) }
}

async function ilinkPost(baseUrl: string, endpoint: string, body: object, token?: string, timeoutMs = API_TIMEOUT_MS): Promise<string> {
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

// ── ilink API calls ────────────────────────────────────────────────────────

async function ilinkGetUpdates(baseUrl: string, token: string, buf: string): Promise<GetUpdatesResp> {
  try {
    const raw = await ilinkPost(baseUrl, 'ilink/bot/getupdates', {
      get_updates_buf: buf,
      base_info: { channel_version: '0.0.1' },
    }, token, LONG_POLL_TIMEOUT_MS)
    return JSON.parse(raw) as GetUpdatesResp
  } catch (err) {
    // Long-poll timeout is normal
    if (err instanceof Error && err.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: buf }
    }
    throw err
  }
}

async function ilinkSendMessage(baseUrl: string, token: string, msg: WeixinMessage): Promise<void> {
  await ilinkPost(baseUrl, 'ilink/bot/sendmessage', {
    msg,
    base_info: { channel_version: '0.0.1' },
  }, token)
}

async function ilinkSendTyping(baseUrl: string, token: string, userId: string, ticket: string): Promise<void> {
  await ilinkPost(baseUrl, 'ilink/bot/sendtyping', {
    ilink_user_id: userId,
    typing_ticket: ticket,
    status: 1,
    base_info: { channel_version: '0.0.1' },
  }, token)
}

async function ilinkGetConfig(baseUrl: string, token: string, userId: string, contextToken?: string): Promise<{ typing_ticket?: string }> {
  const raw = await ilinkPost(baseUrl, 'ilink/bot/getconfig', {
    ilink_user_id: userId,
    context_token: contextToken,
    base_info: { channel_version: '0.0.1' },
  }, token)
  return JSON.parse(raw)
}

// ── Access control ─────────────────────────────────────────────────────────

interface Access {
  dmPolicy: 'allowlist' | 'disabled'
  allowFrom: string[]
}

function defaultAccess(): Access {
  return { dmPolicy: 'allowlist', allowFrom: [] }
}

function readAccessFile(): Access {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'allowlist',
      allowFrom: parsed.allowFrom ?? [],
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try { renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`) } catch {}
    process.stderr.write(`wechat channel: access.json corrupt, moved aside. Starting fresh.\n`)
    return defaultAccess()
  }
}

function saveAccess(a: Access): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

function loadAccess(): Access {
  return readAccessFile()
}

function assertAllowedChat(chat_id: string): void {
  const access = loadAccess()
  if (!access.allowFrom.includes(chat_id)) {
    throw new Error(`chat ${chat_id} is not allowlisted — add via /wechat:access`)
  }
}

// ── Account state ──────────────────────────────────────────────────────────

interface Account {
  baseUrl: string
  userId: string  // ilink_user_id of the person who scanned
  botId: string   // ilink_bot_id
}

function readAccount(): Account | null {
  try {
    return JSON.parse(readFileSync(ACCOUNT_FILE, 'utf8')) as Account
  } catch {
    return null
  }
}

function saveAccount(account: Account): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCOUNT_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(account, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCOUNT_FILE)
}

// ── Sync buf (getupdates cursor) ───────────────────────────────────────────

function loadSyncBuf(): string {
  try { return readFileSync(SYNC_BUF_FILE, 'utf8') } catch { return '' }
}

function saveSyncBuf(buf: string): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(SYNC_BUF_FILE, buf, { mode: 0o600 })
}

// ── Context tokens ─────────────────────────────────────────────────────────
// ilink requires context_token from the latest inbound message when sending replies.
// Store per user_id in memory — these don't survive restarts, but getupdates
// will deliver new messages with fresh tokens.

const contextTokens = new Map<string, string>()

// ── Gate ────────────────────────────────────────────────────────────────────

type GateResult =
  | { action: 'deliver' }
  | { action: 'drop' }

function gate(fromUserId: string): GateResult {
  const access = loadAccess()
  if (access.dmPolicy === 'disabled') return { action: 'drop' }
  if (access.allowFrom.includes(fromUserId)) return { action: 'deliver' }
  return { action: 'drop' }
}
