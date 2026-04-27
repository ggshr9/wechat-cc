import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Strict botId shape: hex prefix + "-im-bot". setup-flow.ts produces
// `<ilink_bot_id>` then strips non-[a-zA-Z0-9_-], so anything fancier than
// this is suspicious and we refuse to act (path traversal guard).
const BOT_ID_RE = /^[a-zA-Z0-9_-]+-im-bot$/

export interface RemoveAccountResult {
  botId: string
  removed: string[]
  warnings: string[]
}

export interface RemoveAccountDeps {
  stateDir: string
}

// Fully decommission a bound bot — wipes its directory and all per-bot
// references from the four shared state files. Best-effort: each cleanup
// is independent, errors collected as warnings instead of aborting.
//
// Caller must restart the daemon afterwards: in-memory poll loops + the
// userAccountMap aren't reloaded on file change.
//
// Files touched:
//   accounts/<botId>/         — removed entirely
//   context_tokens.json       — drop entry keyed by userId
//   user_account_ids.json     — drop entry keyed by userId
//   session-state.json        — drop entry keyed by botId
//
// Files NOT touched:
//   user_names.json           — keep nickname for re-bind
//   access.json               — owner decides if userId stays in allowlist
export function removeAccount(deps: RemoveAccountDeps, botId: string): RemoveAccountResult {
  if (!BOT_ID_RE.test(botId)) {
    throw new Error(`invalid bot id: ${botId}`)
  }
  const removed: string[] = []
  const warnings: string[] = []
  const stateDir = deps.stateDir

  const accountDir = join(stateDir, 'accounts', botId)
  const userId = readUserIdFromAccount(accountDir)
  if (!existsSync(accountDir)) {
    warnings.push(`account dir not found: ${accountDir}`)
  } else {
    rmSync(accountDir, { recursive: true, force: true })
    removed.push(`accounts/${botId}/`)
  }

  if (userId) {
    if (dropJsonKey(join(stateDir, 'context_tokens.json'), userId)) removed.push(`context_tokens.json[${userId}]`)
    if (dropJsonKey(join(stateDir, 'user_account_ids.json'), userId)) removed.push(`user_account_ids.json[${userId}]`)
  } else {
    warnings.push('account.json missing userId — skipped context_tokens / user_account_ids cleanup')
  }

  if (dropSessionStateBot(join(stateDir, 'session-state.json'), botId)) {
    removed.push(`session-state.json.bots[${botId}]`)
  }

  return { botId, removed, warnings }
}

function readUserIdFromAccount(accountDir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(accountDir, 'account.json'), 'utf8')) as { userId?: unknown }
    return typeof parsed.userId === 'string' && parsed.userId.length > 0 ? parsed.userId : null
  } catch {
    return null
  }
}

function dropJsonKey(file: string, key: string): boolean {
  if (!existsSync(file)) return false
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch { return false }
  if (!(key in parsed)) return false
  delete parsed[key]
  atomicWrite(file, JSON.stringify(parsed, null, 2) + '\n')
  return true
}

function dropSessionStateBot(file: string, botId: string): boolean {
  if (!existsSync(file)) return false
  let parsed: { version?: number; bots?: Record<string, unknown> }
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch { return false }
  if (!parsed.bots || !(botId in parsed.bots)) return false
  delete parsed.bots[botId]
  atomicWrite(file, JSON.stringify(parsed, null, 2) + '\n')
  return true
}

function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content, { mode: 0o600 })
  renameSync(tmp, file)
}
