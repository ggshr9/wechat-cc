import { describe, it, expect, vi } from 'vitest'
import { compose } from './compose'
import type { InboundCtx, Middleware } from './types'

const mkCtx = (): InboundCtx => ({
  msg: {} as InboundCtx['msg'],
  receivedAtMs: Date.now(),
  requestId: 'r1',
})

describe('compose', () => {
  it('runs middlewares in registration order, inner after outer next()', async () => {
    const order: string[] = []
    const a: Middleware = async (_ctx, next) => { order.push('a-pre'); await next(); order.push('a-post') }
    const b: Middleware = async (_ctx, next) => { order.push('b-pre'); await next(); order.push('b-post') }
    const c: Middleware = async () => { order.push('c') }
    await compose([a, b, c])(mkCtx())
    expect(order).toEqual(['a-pre', 'b-pre', 'c', 'b-post', 'a-post'])
  })

  it('short-circuits when middleware does not call next()', async () => {
    const inner = vi.fn()
    const a: Middleware = async () => { /* no next */ }
    await compose([a, inner])(mkCtx())
    expect(inner).not.toHaveBeenCalled()
  })

  it('handles empty array', async () => {
    await expect(compose([])(mkCtx())).resolves.toBeUndefined()
  })

  it('propagates errors thrown by inner middleware', async () => {
    const a: Middleware = async (_c, next) => { await next() }
    const b: Middleware = async () => { throw new Error('boom') }
    await expect(compose([a, b])(mkCtx())).rejects.toThrow('boom')
  })

  it('outer middleware can catch inner thrown error', async () => {
    let caught: unknown = null
    const a: Middleware = async (_c, next) => { try { await next() } catch (e) { caught = e } }
    const b: Middleware = async () => { throw new Error('x') }
    await compose([a, b])(mkCtx())
    expect((caught as Error).message).toBe('x')
  })

  it('rejects when middleware calls next() twice', async () => {
    const a: Middleware = async (_c, next) => { await next(); await next() }
    await expect(compose([a, async () => {}])(mkCtx()))
      .rejects.toThrow(/next\(\) called multiple times/)
  })
})
