import { describe, it, expect } from 'vitest'
import { tierMeets, minTierFor, ROUTE_MIN_TIER } from './route-tiers'
import { makeRoutes } from './routes'
import type { InternalApiDeps } from './types'

describe('route-tiers', () => {
  it('tierMeets ranks admin > trusted > guest', () => {
    expect(tierMeets('admin', 'trusted')).toBe(true)
    expect(tierMeets('trusted', 'admin')).toBe(false)
    expect(tierMeets('guest', 'guest')).toBe(true)
    expect(tierMeets('trusted', 'guest')).toBe(true)
  })

  it('daemon-control routes require admin', () => {
    expect(minTierFor('POST /v1/daemon/restart')).toBe('admin')
    expect(minTierFor('POST /v1/sessions/release')).toBe('admin')
    expect(minTierFor('POST /v1/model')).toBe('admin')
    expect(minTierFor('GET /v1/turns')).toBe('admin')
    expect(minTierFor('GET /v1/sessions')).toBe('admin')
    expect(minTierFor('GET /v1/model')).toBe('admin')
  })

  it('reply/health/memory-read are guest; broadcast/a2a are trusted', () => {
    expect(minTierFor('GET /v1/health')).toBe('guest')
    expect(minTierFor('POST /v1/wechat/reply')).toBe('guest')
    expect(minTierFor('POST /v1/memory/read')).toBe('guest')
    expect(minTierFor('POST /v1/wechat/broadcast')).toBe('trusted')
    expect(minTierFor('GET /v1/a2a/list')).toBe('trusted')
  })

  it('an unlisted route defaults to admin (fail-closed)', () => {
    expect(minTierFor('POST /v1/some/new/route')).toBe('admin')
  })

  it('every registered route has an explicit min tier (no accidental default-deny)', () => {
    const deps = { stateDir: '/tmp', daemonPid: 1 } as unknown as InternalApiDeps
    const routes = makeRoutes({ deps, getDelegate: () => null, maybePrefix: (_c, t) => t })
    const missing = Object.keys(routes).filter(k => ROUTE_MIN_TIER[k] === undefined)
    expect(missing, `routes missing from ROUTE_MIN_TIER: ${missing.join(', ')}`).toEqual([])
  })
})
