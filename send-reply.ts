/**
 * send-reply.ts — shared send path for the MCP `reply` tool and the
 * `wechat-cc reply` CLI fallback. Reads routing state from disk each call
 * so it works both inside the server process and standalone.
 */

import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { STATE_DIR, MAX_TEXT_CHUNK } from './config.ts'
import { ilinkSendMessage, botTextMessage } from './ilink.ts'

const ACCOUNTS_DIR = join(STATE_DIR, 'accounts')
const CONTEXT_TOKENS_FILE = join(STATE_DIR, 'context_tokens.json')
const USER_ACCOUNT_IDS_FILE = join(STATE_DIR, 'user_account_ids.json')

export interface MinimalAccount {
  baseUrl: string
  token: string
  id: string
}

export type SendReplyResult =
  | { ok: true; chunks: number; account: string }
  | { ok: false; error: string }

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T }
  catch { return null }
}

function loadAccounts(): MinimalAccount[] {
  let ids: string[]
  try { ids = readdirSync(ACCOUNTS_DIR) } catch { return [] }
  const out: MinimalAccount[] = []
  for (const id of ids) {
    const dir = join(ACCOUNTS_DIR, id)
    try {
      const token = readFileSync(join(dir, 'token'), 'utf8').trim()
      const account = JSON.parse(readFileSync(join(dir, 'account.json'), 'utf8')) as { baseUrl?: string }
      if (token && account.baseUrl) {
        out.push({ id, token, baseUrl: account.baseUrl })
      }
    } catch { /* skip invalid */ }
  }
  return out
}

export function chunk(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const para = rest.lastIndexOf('\n\n', limit)
    const line = rest.lastIndexOf('\n', limit)
    const space = rest.lastIndexOf(' ', limit)
    const cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

/** Send a text reply. Shared by MCP `reply` and `wechat-cc reply`. */
export async function sendReplyOnce(chatId: string, text: string): Promise<SendReplyResult> {
  if (!text) return { ok: false, error: 'empty text' }

  const accounts = loadAccounts()
  if (accounts.length === 0) {
    return { ok: false, error: 'no accounts configured — run: wechat-cc setup' }
  }

  const userAccountIds = readJson<Record<string, string>>(USER_ACCOUNT_IDS_FILE) ?? {}
  const contextTokens = readJson<Record<string, string>>(CONTEXT_TOKENS_FILE) ?? {}

  const persistedAccountId = userAccountIds[chatId]
  const account =
    accounts.find(a => a.id === persistedAccountId)
    ?? accounts[0] // last-resort fallback to first account

  const ctxToken = contextTokens[chatId]

  try {
    const chunks = chunk(text, MAX_TEXT_CHUNK)
    for (const part of chunks) {
      await ilinkSendMessage(account.baseUrl, account.token, botTextMessage(chatId, part, ctxToken))
    }
    return { ok: true, chunks: chunks.length, account: account.id }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Most recently active chat_id, or null if nothing on record.
 *
 * Why: server.ts does delete-then-set on each inbound, so JSON key order
 * on disk = recency order — last key is newest. userAccountIds is the
 * authoritative file; context_tokens is a fallback for the edge case
 * where the former is empty/missing.
 */
export function defaultTerminalChatId(): string | null {
  for (const file of [USER_ACCOUNT_IDS_FILE, CONTEXT_TOKENS_FILE]) {
    const keys = Object.keys(readJson<Record<string, string>>(file) ?? {})
    if (keys.length > 0) return keys[keys.length - 1]!
  }
  return null
}
