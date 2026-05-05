/**
 * mw-identity — upsert WeChat identity (userId, accountId, userName)
 * to the conversations table on every inbound. Always continues the
 * chain; never short-circuits.
 *
 * Runs early in the pipeline (right after mw-trace) so identity is
 * populated BEFORE any handler that might want to read it (admin
 * commands' /whoami, mode-cmds, etc.). Replaces PR4's in-memory
 * accountChatIndex once Task 23 wires the SQL query against account_id.
 */
import type { Middleware } from './types'

export interface IdentityMwDeps {
  upsertIdentity(
    chatId: string,
    ids: { userId?: string; accountId?: string; userName?: string },
  ): void
}

export function makeMwIdentity(deps: IdentityMwDeps): Middleware {
  return async (ctx, next) => {
    deps.upsertIdentity(ctx.msg.chatId, {
      userId: ctx.msg.userId,
      accountId: ctx.msg.accountId,
      userName: ctx.msg.userName,
    })
    await next()
  }
}
