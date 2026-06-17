import { describe, expect, it } from 'vitest'
import { buildRequest, buildResponse, buildError, buildNotification, parseMessage } from './yi-protocol'

describe('yi-protocol', () => {
  it('builds + parses a request', () => {
    const raw = buildRequest(7, 'task/dispatch', { taskId: 't1', peer: 'claude', prompt: 'hi' })
    const msg = parseMessage(raw)
    expect(msg).toEqual({ kind: 'request', id: 7, method: 'task/dispatch', params: { taskId: 't1', peer: 'claude', prompt: 'hi' } })
  })
  it('builds + parses a response', () => {
    const msg = parseMessage(buildResponse(7, { taskId: 't1', ok: true, response: 'done' }))
    expect(msg).toEqual({ kind: 'response', id: 7, result: { taskId: 't1', ok: true, response: 'done' } })
  })
  it('builds + parses an error', () => {
    const msg = parseMessage(buildError(7, -32603, 'boom'))
    expect(msg).toEqual({ kind: 'error', id: 7, error: { code: -32603, message: 'boom' } })
  })
  it('builds + parses a notification (no id)', () => {
    const msg = parseMessage(buildNotification('initialized'))
    expect(msg).toEqual({ kind: 'notification', method: 'initialized', params: undefined })
  })
  it('returns a malformed marker for non-JSON / non-2.0', () => {
    expect(parseMessage('not json').kind).toBe('malformed')
    expect(parseMessage(JSON.stringify({ id: 1 })).kind).toBe('malformed')
  })
})
