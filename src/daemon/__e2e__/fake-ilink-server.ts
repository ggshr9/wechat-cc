/**
 * Fake ilink HTTP server for daemon e2e tests.
 *
 * Emulates 4 endpoints:
 *   POST /ilink/bot/getupdates  → returns queued RawUpdate[], clears queue
 *   POST /ilink/bot/sendmessage → captures into outbox
 *   POST /ilink/bot/sendfile    → captures into outbox
 *   POST /ilink/bot/typing      → no-op, returns ok
 *
 * Bun.serve on random port. Tests await waitForOutbound(predicate) to
 * synchronize on the daemon's async polling loop.
 */
import type { RawUpdate } from '../poll-loop'

export interface OutboundMsg {
  endpoint: 'sendmessage' | 'sendfile' | 'typing'
  chatId: string
  text?: string
  filePath?: string
  raw: unknown
}

export interface FakeIlinkHandle {
  baseUrl: string
  port: number
  /** Queue a raw update for the next getupdates poll. */
  enqueueInbound(update: RawUpdate): void
  /** Wait until outbox satisfies predicate (polls every 50ms, 5s default timeout). */
  waitForOutbound(predicate: (msgs: readonly OutboundMsg[]) => boolean, timeoutMs?: number): Promise<readonly OutboundMsg[]>
  /** Snapshot of current outbox (no wait). */
  outbox(): readonly OutboundMsg[]
  /** Reset outbox + queue (between tests in same suite). */
  reset(): void
  /** Stop server, free port. */
  stop(): Promise<void>
}

export async function startFakeIlink(): Promise<FakeIlinkHandle> {
  const queue: RawUpdate[] = []
  const captured: OutboundMsg[] = []

  const server = Bun.serve({
    port: 0,  // random
    // Bind explicitly to IPv4 loopback. Bun.serve's default hostname is
    // "localhost" which on this machine resolves only to ::1 — but our
    // baseUrl below (and ilinkPost in src/lib/ilink.ts) hits 127.0.0.1,
    // so without this fetch hangs until timeout with the cryptic
    // "Unable to connect" error. (Bun 1.3.x; see test reproduction in
    // commit log for v0.6 PR1.)
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === 'POST' ? await req.json().catch(() => ({})) as Record<string, unknown> : {}
      // Debug log every request — controlled by E2E_DEBUG_ILINK env
      if (process.env.E2E_DEBUG_ILINK) console.log('[fake-ilink]', req.method, url.pathname)

      if (url.pathname === '/ilink/bot/getupdates') {
        const msgs = queue.splice(0, queue.length)
        if (process.env.E2E_DEBUG_ILINK && msgs.length > 0) {
          console.log('[fake-ilink] returning', msgs.length, 'msgs to bot:', JSON.stringify(msgs).slice(0, 300))
        }
        // Real ilink wire format: { ret: 0, msgs: [...], get_updates_buf: '...' }
        // transport.ts:74 extracts resp.msgs → updates and resp.get_updates_buf → sync_buf
        return Response.json({ ret: 0, msgs, get_updates_buf: '' })
      }
      // Real ilink wire shape for send endpoints is {msg: {to_user_id, ...},
      // base_info}. The fake originally read body.to_user_id at the top level
      // and silently captured chatId='' for every reply — making it impossible
      // to write a real inbound→reply e2e because waitForReplyTo could never
      // match. Unwrap msg first; fall back to top-level for forward compat.
      const msg = (body.msg as Record<string, unknown> | undefined) ?? body
      const itemList = msg.item_list as Array<{ text_item?: { text?: string } }> | undefined
      if (url.pathname === '/ilink/bot/sendmessage') {
        captured.push({
          endpoint: 'sendmessage',
          chatId: String(msg.to_user_id ?? ''),
          text: typeof msg.text === 'string' ? msg.text : itemList?.[0]?.text_item?.text,
          raw: body,
        })
        return Response.json({ errcode: 0, msg_id: `m${captured.length}` })
      }
      if (url.pathname === '/ilink/bot/sendfile') {
        captured.push({
          endpoint: 'sendfile',
          chatId: String(msg.to_user_id ?? ''),
          filePath: typeof msg.file_path === 'string' ? msg.file_path : undefined,
          raw: body,
        })
        return Response.json({ errcode: 0, msg_id: `f${captured.length}` })
      }
      if (url.pathname === '/ilink/bot/typing') {
        captured.push({
          endpoint: 'typing',
          chatId: String(msg.to_user_id ?? body.ilink_user_id ?? ''),
          raw: body,
        })
        return Response.json({ errcode: 0 })
      }
      return new Response('not found', { status: 404 })
    },
  })

  const port = server.port!
  const baseUrl = `http://127.0.0.1:${port}`

  return {
    baseUrl,
    port,
    enqueueInbound(update) { queue.push(update) },
    outbox() { return [...captured] },
    reset() { queue.length = 0; captured.length = 0 },
    async waitForOutbound(predicate, timeoutMs = 5000) {
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        if (predicate(captured)) return [...captured]
        await new Promise(r => setTimeout(r, 50))
      }
      throw new Error(`waitForOutbound: predicate not satisfied after ${timeoutMs}ms; outbox=${JSON.stringify(captured)}`)
    },
    async stop() { server.stop(true) },
  }
}
