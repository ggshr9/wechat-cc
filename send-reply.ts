/**
 * send-reply.ts — standalone reply helper used by both the MCP `reply` tool
 * and the `wechat-cc reply` CLI fallback.
 *
 * The MCP server keeps in-memory Maps of contextTokens / userAccountIds but
 * also persists them to disk (state/context_tokens.json / state/user_account_ids.json).
 * This helper reads those files fresh each call so it works whether invoked
 * from inside the MCP server process or from a standalone CLI.
 *
 * Terminal `wechat-cc reply` exists as a fallback when the MCP channel is
 * unavailable (server crashed, or Claude Code not running). It reuses the
 * same state files so there is exactly ONE source of truth for who-talks-to-whom.
 */

import { existsSync, readFileSync, readdirSync } from 'fs'
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
  if (!existsSync(ACCOUNTS_DIR)) return []
  const out: MinimalAccount[] = []
  for (const id of readdirSync(ACCOUNTS_DIR)) {
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

/**
 * Send a text reply to a WeChat user. Single source of truth for the send
 * path — both MCP `reply` tool and CLI `wechat-cc reply` route through here.
 *
 * Reads state fresh each call so behavior doesn't depend on whether the
 * caller is an MCP server process (with in-memory caches) or a one-shot CLI.
 */
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
 * Resolve the "default" chat_id for terminal use — the MOST RECENTLY
 * active user.
 *
 * Relies on server.ts bumping each user to end-of-Map on inbound (via
 * delete-then-set), so the JSON key order on disk = recency order and
 * the LAST key is the most recent. Prefer userAccountIds (the authoritative
 * routing map); fall back to context_tokens when that file doesn't exist
 * yet (older server versions, or before the first inbound post-upgrade).
 *
 * Returns null only when the user has literally never received a message.
 */
export function defaultTerminalChatId(): string | null {
  const userAccountIds = readJson<Record<string, string>>(USER_ACCOUNT_IDS_FILE) ?? {}
  const fromAccounts = Object.keys(userAccountIds)
  if (fromAccounts.length > 0) return fromAccounts[fromAccounts.length - 1]!

  const contextTokens = readJson<Record<string, string>>(CONTEXT_TOKENS_FILE) ?? {}
  const fromContext = Object.keys(contextTokens)
  if (fromContext.length > 0) return fromContext[fromContext.length - 1]!

  return null
}
