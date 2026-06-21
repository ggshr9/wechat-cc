/**
 * 乙 v2 BRAIN ws I/O — accepts outbound hand connections, runs the initialize
 * handshake (authenticated by verify(handId, token)), attaches each hand to the
 * hub, and bridges inbound frames → hub.onMessage. Bind 127.0.0.1 / tailnet
 * only — this is the brain's rendezvous (later: behind a cloudflared tunnel).
 */
import type { YiHub } from '../core/yi-hub'
import { buildError, buildResponse, parseMessage } from '../core/yi-protocol'

export interface YiWsServerOpts {
  host: string
  port: number
  hub: YiHub
  verify: (handId: string, authToken: string) => boolean
}

interface SockData { handId: string | null; send?: (raw: string) => void }

export interface YiWsServer {
  start(): Promise<void>
  stop(): Promise<void>
  port(): number
}

export function createYiWsServer(opts: YiWsServerOpts): YiWsServer {
  let server: ReturnType<typeof Bun.serve> | null = null

  return {
    async start() {
      if (server) return
      server = Bun.serve<SockData>({
        hostname: opts.host,
        port: opts.port,
        fetch(req, srv) {
          if (srv.upgrade(req, { data: { handId: null } })) return undefined
          return new Response('expected websocket', { status: 426 })
        },
        websocket: {
          message(ws, raw) {
            const msg = parseMessage(typeof raw === 'string' ? raw : Buffer.from(raw))
            if (ws.data.handId === null) {
              if (msg.kind === 'request' && msg.method === 'initialize') {
                const p = msg.params as { handId?: unknown; authToken?: unknown }
                if (typeof p.handId === 'string' && typeof p.authToken === 'string' && opts.verify(p.handId, p.authToken)) {
                  ws.data.handId = p.handId
                  const send = (out: string) => { try { ws.send(out) } catch { /* closed */ } }
                  ws.data.send = send
                  opts.hub.attach(p.handId, send)
                  ws.send(buildResponse(msg.id, { sessionId: `s_${p.handId}` }))
                } else {
                  ws.send(buildError(msg.kind === 'request' ? msg.id : null, -32600, 'unauthorized'))
                  ws.close()
                }
              } else {
                ws.send(buildError(null, -32600, 'expected initialize'))
                ws.close()
              }
              return
            }
            opts.hub.onMessage(ws.data.handId, typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'))
          },
          close(ws) {
            if (ws.data.handId) opts.hub.detach(ws.data.handId, ws.data.send)
          },
        },
      })
    },
    async stop() { server?.stop(); server = null },
    port() { if (!server) throw new Error('yi-ws-server not started'); return server.port! },
  }
}
