import { describe, it, expect } from 'vitest'
import { makeResolver } from './project-resolver'

describe('project-resolver', () => {
  it('returns current project when set', () => {
    const resolve = makeResolver({
      loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
    })
    expect(resolve('any-chat')).toEqual({ alias: 'P', path: '/p' })
  })

  it('returns null when no current, no fallback, no chat override', () => {
    const resolve = makeResolver({
      loadProjects: () => ({ projects: {}, current: null }),
    })
    expect(resolve('any-chat')).toBeNull()
  })

  it('returns null when current alias does not exist in projects map (and no fallback)', () => {
    const resolve = makeResolver({
      loadProjects: () => ({ projects: {}, current: 'ghost' }),
    })
    expect(resolve('any-chat')).toBeNull()
  })

  it('returns fallback when current is unset', () => {
    const resolve = makeResolver({
      loadProjects: () => ({ projects: {}, current: null }),
      fallback: () => ({ alias: '_default', path: '/home/u/proj' }),
    })
    expect(resolve('any-chat')).toEqual({ alias: '_default', path: '/home/u/proj' })
  })

  it('returns fallback when current points at missing alias', () => {
    const resolve = makeResolver({
      loadProjects: () => ({ projects: {}, current: 'ghost' }),
      fallback: () => ({ alias: '_default', path: '/home/u/proj' }),
    })
    expect(resolve('any-chat')).toEqual({ alias: '_default', path: '/home/u/proj' })
  })

  it('prefers current over fallback when current is valid', () => {
    const resolve = makeResolver({
      loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
      fallback: () => ({ alias: '_default', path: '/unused' }),
    })
    expect(resolve('any-chat')).toEqual({ alias: 'P', path: '/p' })
  })
})
