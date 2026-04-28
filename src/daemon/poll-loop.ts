/**
 * poll-loop.ts — per-account ilink long-poll loop + inbound message normalization.
 *
 * parseUpdates: pure function, no I/O. Converts raw WeixinMessage items into
 * InboundMsg. Media is emitted as an opaque CDN reference in
 * attachments[].caption — the compose step materializes it via media.ts.
 *
 * startLongPollLoops: runs one getUpdates loop per account. Backoff 2s on
 * transient errors. stop() flips a shared flag and awaits all in-flight loops.
 */

import type { InboundMsg } from '../core/prompt-format'
import type { Account } from './ilink-glue'

// ── RawUpdate: subset of ilink WeixinMessage that we care about ─────────────
// Mirrors the real ilink WeixinMessage shape (item_list-based, ms timestamps).

export interface RawMediaItem {
  encrypt_query_param?: string
  aes_key?: string
  encrypt_type?: number
  full_url?: string
}

export interface RawMessageItem {
  type?: number           // 1=text, 2=image, 3=voice, 4=file, 5=video
  msg_id?: string
  create_time_ms?: number
  text_item?: { text?: string }
  voice_item?: { text?: string; media?: RawMediaItem }
  image_item?: { media?: RawMediaItem; aeskey?: string }
  file_item?: { media?: RawMediaItem; file_name?: string }
  video_item?: { media?: RawMediaItem }
  ref_msg?: { title?: string; message_item?: { text_item?: { text?: string } } }
}

export interface RawUpdate {
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  create_time_ms?: number
  message_type?: number   // 1=user message, 2=bot message
  message_state?: number  // 0=new, 1=generating, 2=finish
  item_list?: RawMessageItem[]
  context_token?: string
  session_id?: string
}

export interface ParseDeps {
  accountId: string
  resolveUserName: (chatId: string) => string | undefined
}

/**
 * Parse a raw ilink WeixinMessage list into normalized InboundMsg entries.
 * Pure function — no I/O. Media references are returned un-downloaded; the
 * caller materializes them via src/daemon/media.ts.
 */
export function parseUpdates(
  updates: RawUpdate[],
  deps: ParseDeps,
): InboundMsg[] {
  const results: InboundMsg[] = []

  for (const msg of updates) {
    // Only process user messages (type=1) that are finished (state=2)
    if (msg.message_type !== 1) continue
    if (msg.message_state !== undefined && msg.message_state !== 2) continue

    const fromUserId = msg.from_user_id ?? ''
    if (!fromUserId) continue

    const textParts: string[] = []
    const attachments: InboundMsg['attachments'] = []
    let quoteTo: string | undefined

    for (const item of msg.item_list ?? []) {
      // Detect quote/ref_msg — capture the msg_id of the item that carries the ref
      if (item.ref_msg) {
        if (!quoteTo && item.msg_id) {
          quoteTo = item.msg_id
        }
        const refText = item.ref_msg.title
          ?? item.ref_msg.message_item?.text_item?.text
        if (refText) {
          textParts.push(`[引用: ${refText}]`)
        } else {
          textParts.push('[引用]')
        }
      }

      if (item.type === 1) {
        // Text item
        if (item.text_item?.text) {
          textParts.push(item.text_item.text)
        }
      } else if (item.type === 2) {
        // Image item — emit opaque CDN reference; caller downloads via media.ts
        const media = item.image_item?.media
        attachments.push({
          kind: 'image',
          path: '<pending-cdn-ref>',
          caption: JSON.stringify(media ?? {}),
        })
      } else if (item.type === 3) {
        // Voice item
        if (item.voice_item?.text) {
          textParts.push(`[语音] ${item.voice_item.text}`)
        } else {
          const media = item.voice_item?.media
          attachments.push({
            kind: 'voice',
            path: '<pending-cdn-ref>',
            caption: JSON.stringify(media ?? {}),
          })
        }
      } else if (item.type === 4) {
        // File item
        const media = item.file_item?.media
        const fileName = item.file_item?.file_name ?? 'file.bin'
        attachments.push({
          kind: 'file',
          path: '<pending-cdn-ref>',
          caption: JSON.stringify({ media: media ?? {}, file_name: fileName }),
        })
      } else if (item.type === 5) {
        // Video item
        const media = item.video_item?.media
        attachments.push({
          kind: 'file',
          path: '<pending-cdn-ref>',
          caption: JSON.stringify(media ?? {}),
        })
      }
    }

    // Determine msgType from first non-ref item type
    let msgType = 'unknown'
    for (const item of msg.item_list ?? []) {
      if (item.ref_msg) continue
      if (item.type === 1) { msgType = 'text'; break }
      if (item.type === 2) { msgType = 'image'; break }
      if (item.type === 3) { msgType = 'voice'; break }
      if (item.type === 4) { msgType = 'file'; break }
      if (item.type === 5) { msgType = 'video'; break }
    }

    const inbound: InboundMsg = {
      chatId: fromUserId,
      userId: fromUserId,
      userName: deps.resolveUserName(fromUserId),
      text: textParts.join('\n') || '(non-text message)',
      msgType,
      createTimeMs: msg.create_time_ms ?? 0,
      accountId: deps.accountId,
      ...(quoteTo !== undefined ? { quoteTo } : {}),
      // ilink puts context_token on every inbound message; threading it
      // through to onInbound lets the daemon persist it before replying.
      // See InboundMsg.contextToken docstring for the regression history.
      ...(msg.context_token ? { contextToken: msg.context_token } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    }

    results.push(inbound)
  }

  return results
}

// ── PollLoopOptions ──────────────────────────────────────────────────────────

export interface PollLoopOptions {
  accounts: Account[]
  onInbound: (msg: InboundMsg) => Promise<void>
  ilink: {
    /**
     * Returns { updates?, sync_buf?, expired? } — mapped from GetUpdatesResp.
     * When ilink reports errcode=-14 (session timeout), the adapter sets
     * `expired: true` so the loop can self-terminate and flag the bot in
     * SessionStateStore for the /health admin command.
     */
    getUpdates: (accountId: string, baseUrl: string, token: string, syncBuf: string) => Promise<{
      updates?: RawUpdate[]
      sync_buf?: string
      expired?: boolean
    }>
  }
  parse: (updates: RawUpdate[], deps: ParseDeps) => InboundMsg[]
  resolveUserName?: (chatId: string) => string | undefined
  log?: (tag: string, line: string) => void
}

const RETRY_DELAY_MS = 2_000

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })
}

/**
 * Handle returned by startLongPollLoops. Exposes `addAccount` for on-the-fly
 * registration so `wechat-cc setup` can signal the daemon via SIGUSR1 to pick
 * up a freshly-bound bot without a restart; `stopAccount` so individual loops
 * can be shut down (e.g. admin cleaning up a dead bot or getUpdates reporting
 * errcode=-14 session timeout).
 */
export interface PollLoopHandle {
  /** Register a new account; idempotent (re-adding an already-running id is a no-op). */
  addAccount(account: Account): void
  /** Stop the loop for one account (idempotent; no-op if not running). */
  stopAccount(accountId: string): void
  /** Signal all loops to exit and await them. */
  stop(): Promise<void>
  /** Read-only snapshot of currently-polling account ids. */
  running(): string[]
}

interface LoopRecord {
  abort: AbortController
  promise: Promise<void>
}

/**
 * Start one long-poll loop per account. Returns a handle that permits adding
 * more accounts later (for hot-reload after setup) or shutting down a single
 * one (for cleanup).
 */
export function startLongPollLoops(opts: PollLoopOptions): PollLoopHandle {
  const { onInbound, ilink, parse, log = () => {} } = opts
  const resolveUserName = opts.resolveUserName ?? (() => undefined)

  const loops = new Map<string, LoopRecord>()

  async function runLoop(account: Account, sig: AbortSignal): Promise<void> {
    let syncBuf = account.syncBuf

    log('POLL', `loop started for ${account.id}`)

    while (!sig.aborted) {
      try {
        const resp = await ilink.getUpdates(account.id, account.baseUrl, account.token, syncBuf)

        if (sig.aborted) break

        // Adapter has marked the bot session expired — self-terminate. The
        // ilink-glue wrapper has already written to SessionStateStore, so
        // /health admin command will show this bot as expired.
        if (resp.expired) {
          log('SESSION_EXPIRED', `bot ${account.id} — stopping loop (/health to view, "清理 ${account.id}" to remove)`)
          break
        }

        const rawUpdates = resp.updates ?? []

        if (rawUpdates.length > 0) {
          const msgs = parse(rawUpdates, {
            accountId: account.id,
            resolveUserName,
          })
          for (const msg of msgs) {
            try {
              await onInbound(msg)
            } catch (err) {
              log('ERROR', `onInbound threw: ${err}`)
            }
          }
        }

        if (resp.sync_buf !== undefined) {
          syncBuf = resp.sync_buf
        }
      } catch (err) {
        if (sig.aborted) break
        log('ERROR', `getUpdates failed: ${err}`)
        await sleep(RETRY_DELAY_MS, sig)
      }
    }

    log('POLL', `loop stopped for ${account.id}`)
  }

  function addAccount(account: Account): void {
    if (loops.has(account.id)) return
    const abort = new AbortController()
    const promise = runLoop(account, abort.signal).finally(() => {
      // Remove self on natural exit so addAccount can re-add under same id.
      if (loops.get(account.id)?.abort === abort) loops.delete(account.id)
    })
    loops.set(account.id, { abort, promise })
  }

  function stopAccount(accountId: string): void {
    const record = loops.get(accountId)
    if (!record) return
    record.abort.abort()
    // Leave entry in map; runLoop.finally cleans up once it exits.
  }

  for (const account of opts.accounts) addAccount(account)

  return {
    addAccount,
    stopAccount,
    running: () => Array.from(loops.keys()),
    async stop(): Promise<void> {
      for (const record of loops.values()) record.abort.abort()
      await Promise.all(Array.from(loops.values()).map(r => r.promise))
    },
  }
}
