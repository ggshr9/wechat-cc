import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Lifecycle } from '../lib/lifecycle'
import { startLongPollLoops, parseUpdates, type RawUpdate } from './poll-loop'
import { loadAllAccounts, type IlinkAccount } from './ilink-glue'
import type { PipelineRun } from './inbound/types'

export interface PollingDeps {
  stateDir: string
  accounts: IlinkAccount[]
  ilink: {
    getUpdates(accountId: string, baseUrl: string, token: string, syncBuf?: string): Promise<{
      updates?: RawUpdate[]
      sync_buf?: string
      expired?: boolean
    }>
  }
  parse: typeof parseUpdates
  resolveUserName(chatId: string): string | undefined
  log: (tag: string, line: string) => void
  runPipeline: PipelineRun
  /** Fired after each successful poll round-trip — main.ts stamps the
   *  daemon-health heartbeat the instance lock reads. See poll-loop.ts. */
  onPollCycle?: () => void
}

export interface PollingLifecycle extends Lifecycle {
  reconcile(): Promise<void>
  /** Used by admin commands (`/health` cleanup of expired bot sessions). */
  stopAccount(accountId: string): Promise<void>
  /**
   * Stop AND await full unwind for one account — caller can be sure
   * the loop's resources (sockets, file handles) are released before
   * proceeding with destructive followups (e.g. rmSync of account dir).
   */
  stopAccountAndWait(accountId: string): Promise<void>
  /** Returns currently-running account ids. */
  running(): string[]
  /** Add a freshly-bound account to the polling loop without restart. */
  addAccount(account: IlinkAccount): void
}

export function registerPolling(deps: PollingDeps): PollingLifecycle {
  let stopped = false
  const inboxDir = join(deps.stateDir, 'inbox')
  mkdirSync(inboxDir, { recursive: true })

  // Multi-device accounts (shared via `account export/import`, marked by a
  // `.multidevice` file — see account-transfer.ts) start in STANDBY, not
  // polling. Otherwise a reboot of an idle machine would silently steal the
  // live session from the machine you're actually using (startup polls
  // unconditionally → ilink hands the newest poller the session). They
  // activate explicitly via `account takeover` (SIGUSR1 → reconcile), matching
  // the "switch to the machine you're at" model. Single-device accounts
  // (never shared) auto-poll as before.
  const startupAccounts = deps.accounts.filter(
    a => !existsSync(join(deps.stateDir, 'accounts', a.id, '.multidevice')),
  )
  const heldBack = deps.accounts.length - startupAccounts.length
  if (heldBack > 0) {
    deps.log('POLL', `${heldBack} multi-device account(s) in standby at startup — run \`account takeover\` to drive a bot from this machine`)
  }

  const handle = startLongPollLoops({
    accounts: startupAccounts,
    ilink: deps.ilink,
    parse: deps.parse,
    resolveUserName: deps.resolveUserName,
    log: deps.log,
    ...(deps.onPollCycle ? { onPollCycle: deps.onPollCycle } : {}),
    // Persist the advanced ilink poll cursor so a daemon restart resumes from
    // where it left off instead of replaying ilink's unacked backlog (each
    // replay re-runs the agent + re-sends a fallback that ilink rejects with
    // errcode=-2). The poll loop only fires this on an actual cursor change.
    // Atomic write (tmp + rename) so a crash can't leave a truncated cursor.
    onSyncBuf: (accountId, syncBuf) => {
      try {
        const acctDir = join(deps.stateDir, 'accounts', accountId)
        if (!existsSync(acctDir)) return
        const dest = join(acctDir, 'sync_buf')
        const tmp = `${dest}.tmp`
        writeFileSync(tmp, syncBuf, { mode: 0o600 })
        renameSync(tmp, dest)
      } catch (err) {
        deps.log('POLL', `sync_buf persist failed for ${accountId}: ${err instanceof Error ? err.message : err}`)
      }
    },
    onInbound: async (msg) => {
      // CSPRNG-backed 8-char hex; Math.random().toString(16).slice(2,10) can
      // return shorter strings for round-binary outputs (0.5 → "0.8" → "8").
      const requestId = randomBytes(4).toString('hex')
      await deps.runPipeline({
        msg,
        receivedAtMs: Date.now(),
        requestId,
      })
    },
  })

  return {
    name: 'polling',
    stop: async () => {
      if (stopped) return
      stopped = true
      await handle.stop()
    },
    reconcile: async () => {
      // Mirror stop()'s guard — a reconcile racing/after shutdown (SIGUSR1
      // takeover, a queued reconcile) would otherwise addAccount() on the
      // already-stopped handle, spinning a poll loop nothing will ever stop
      // (leaked sockets + multi-device session theft past shutdown).
      if (stopped) return
      const latest = await loadAllAccounts(deps.stateDir)
      const known = new Set(handle.running())
      const fresh = latest.filter(a => !known.has(a.id))
      if (fresh.length === 0) {
        deps.log('RECONCILE', 'no new accounts')
        return
      }
      for (const a of fresh) handle.addAccount(a)
      deps.log('RECONCILE', `picked up ${fresh.length} new account(s): ${fresh.map(a => a.id).join(', ')}`)
    },
    stopAccount: (id) => { handle.stopAccount(id); return Promise.resolve() },
    stopAccountAndWait: (id) => handle.stopAccountAndWait(id),
    running: () => handle.running(),
    addAccount: (a) => handle.addAccount(a),
  }
}
