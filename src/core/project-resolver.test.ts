import { describe, it, expect } from 'vitest'
import { makeResolver } from './project-resolver'

describe('project-resolver', () => {
  it('returns current project when set', () => {
    const resolve = makeResolver({
      loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
    })
    expect(resolve('any-chat')).toEqual({ alias: 'P', path: '/p' })
  })

  it('returns null when no current and no chat override', () => {
    const resolve = makeResolver({
      loadProjects: () => ({ projects: {}, current: null }),
    })
    expect(resolve('any-chat')).toBeNull()
  })

  it('returns null when current alias does not exist in projects map', () => {
    const resolve = makeResolver({
      loadProjects: () => ({ projects: {}, current: 'ghost' }),
    })
    expect(resolve('any-chat')).toBeNull()
  })
})
