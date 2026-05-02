/**
 * send-reply.ts — shared send path for the MCP `reply` tool and the
 * `wechat-cc reply` CLI fallback. Reads routing state from disk each call
 * so it works both inside the server process and standalone.
 */

import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { STATE_DIR, MAX_TEXT_CHUNK } from '../lib/config'
import { ilinkSendMessage, botTextMessage } from '../lib/ilink'

export interface MinimalAccount {
  baseUrl: string
  token: string
  id: string
}

export type SendReplyResult =
  | { ok: true; chunks: number; account: string }
  | { ok: false; error: string }

/**
 * Single source of truth for the "chat has no on-disk routing state" error.
 * Shared between sendReplyOnce (CLI/standalone) and the daemon's IlinkContext
 * so all outbound paths surface the same actionable message instead of
 * leaking ilink server errcodes to the user.
 */
export function unknownChatIdError(chatId: string): string {
  return `unknown chat_id ${chatId} — no contextToken or account routing on record. The user must send a WeChat message to the bot first so the daemon can capture session state.`
}

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T }
  catch { return null }
}

function loadAccounts(stateDir: string): MinimalAccount[] {
  const accountsDir = join(stateDir, 'accounts')
  let ids: string[]
  try { ids = readdirSync(accountsDir) } catch { return [] }
  const out: MinimalAccount[] = []
  for (const id of ids) {
    const dir = join(accountsDir, id)
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
 * Send a text reply. Shared by MCP `reply` and `wechat-cc reply`.
 *
 * `stateDir` exists only for tests — the production callers always use the
 * compile-time STATE_DIR; the override matches the same convention as
 * defaultTerminalChatId() since bun test shares one process and env-based
 * overrides don't reliably reach this module.
 */
export async function sendReplyOnce(
  chatId: string,
  text: string,
  stateDir: string = STATE_DIR,
): Promise<SendReplyResult> {
  if (!text) return { ok: false, error: 'empty text' }

  const accounts = loadAccounts(stateDir)
  if (accounts.length === 0) {
    return { ok: false, error: 'no accounts configured — run: wechat-cc setup' }
  }

  const userAccountIds = readJson<Record<string, string>>(join(stateDir, 'user_account_ids.json')) ?? {}
  const contextTokens = readJson<Record<string, string>>(join(stateDir, 'context_tokens.json')) ?? {}

  const persistedAccountId = userAccountIds[chatId]
  const account =
    accounts.find(a => a.id === persistedAccountId)
    ?? accounts[0]! // last-resort fallback to first account; non-empty checked above

  const ctxToken = contextTokens[chatId]

  // ilink's sendmessage requires a per-chat context_token issued by the
  // server when the user last messaged the bot. Without it, ilink rejects
  // the request with errcode != 0 — a confusing failure for callers that
  // just want to send. Detect the missing token here so the error names
  // the actual cause + the user-actionable fix.
  if (!ctxToken && !persistedAccountId) {
    return { ok: false, error: unknownChatIdError(chatId) }
  }

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
 *
 * The `stateDir` override exists only for tests — bun test shares one
 * process, so env-based overrides don't reliably reach this module.
 */
export function defaultTerminalChatId(stateDir: string = STATE_DIR): string | null {
  const files = [
    join(stateDir, 'user_account_ids.json'),
    join(stateDir, 'context_tokens.json'),
  ]
  for (const file of files) {
    const keys = Object.keys(readJson<Record<string, string>>(file) ?? {})
    if (keys.length > 0) return keys[keys.length - 1]!
  }
  return null
}
