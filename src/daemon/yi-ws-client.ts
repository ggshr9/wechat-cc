/**
 * 乙 v2 HAND ws I/O — connects OUTBOUND to the brain's rendezvous, sends the
 * initialize frame on open, runs each task via yi-hand, and reconnects with
 * capped backoff. Outbound-only: works behind NAT, no inbound port.
 */
import { createYiHand, type YiHandDeps } from '../core/yi-hand'

export interface YiWsClientOpts extends YiHandDeps {
  brainUrl: string
  log?: (msg: string) => void
}

export interface YiWsClient {
  start(): void
  stop(): void
}

export function createYiWsClient(opts: YiWsClientOpts): YiWsClient {
  const hand = createYiHand(opts)
  let ws: WebSocket | null = null
  let stopped = false
  let backoff = 1000

  function connect(): void {
    if (stopped) return
    ws = new WebSocket(opts.brainUrl)
    ws.onopen = () => { backoff = 1000; ws!.send(hand.helloFrame()) }
    ws.onmessage = async (ev) => {
      const out = await hand.onMessage(String(ev.data))
      for (const frame of out) { try { ws?.send(frame) } catch { /* closed */ } }
    }
    ws.onclose = () => {
      ws = null
      if (stopped) return
      opts.log?.(`yi: disconnected from ${opts.brainUrl}, retry in ${backoff}ms`)
      setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, 30_000)
    }
    ws.onerror = () => { try { ws?.close() } catch { /* noop */ } }
  }

  return {
    start() { stopped = false; connect() },
    stop() { stopped = true; try { ws?.close() } catch { /* noop */ } ws = null },
  }
}
