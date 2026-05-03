import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
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
}

export interface PollingLifecycle extends Lifecycle {
  reconcile(): Promise<void>
  /** Used by admin commands (`/health` cleanup of expired bot sessions). */
  stopAccount(accountId: string): Promise<void>
  /** Returns currently-running account ids. */
  running(): string[]
  /** Add a freshly-bound account to the polling loop without restart. */
  addAccount(account: IlinkAccount): void
}

export function registerPolling(deps: PollingDeps): PollingLifecycle {
  let stopped = false
  const inboxDir = join(deps.stateDir, 'inbox')
  mkdirSync(inboxDir, { recursive: true })

  const handle = startLongPollLoops({
    accounts: deps.accounts,
    ilink: deps.ilink,
    parse: deps.parse,
    resolveUserName: deps.resolveUserName,
    log: deps.log,
    onInbound: async (msg) => {
      const requestId = Math.random().toString(16).slice(2, 10)
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
    running: () => handle.running(),
    addAccount: (a) => handle.addAccount(a),
  }
}
