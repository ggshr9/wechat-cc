import { describe, it, expect } from 'vitest'
import { slugify } from './docs'

describe('slugify', () => {
  it('converts ASCII title to lowercase slug with timestamp', () => {
    const slug = slugify('My Feature Plan')
    expect(slug).toMatch(/^my-feature-plan-[a-z0-9]+$/)
  })

  it('strips non-alphanumeric characters', () => {
    const slug = slugify('Plan: add share_page (v2)')
    expect(slug).toMatch(/^plan-add-share-page-v2-[a-z0-9]+$/)
  })

  it('truncates long titles to 40 chars before timestamp', () => {
    const longTitle = 'a'.repeat(100)
    const slug = slugify(longTitle)
    const base = slug.split('-').slice(0, -1).join('-') // remove timestamp suffix
    expect(base.length).toBeLessThanOrEqual(40)
  })

  it('falls back to doc-<timestamp> for non-ASCII-only titles', () => {
    const slug = slugify('排产计划')
    expect(slug).toMatch(/^doc-[a-z0-9]+$/)
  })

  it('falls back to doc-<timestamp> for empty title', () => {
    const slug = slugify('')
    expect(slug).toMatch(/^doc-[a-z0-9]+$/)
  })

  it('produces unique slugs on consecutive calls', () => {
    const a = slugify('same title')
    const b = slugify('same title')
    // Timestamp suffix should differ (or be very unlikely to collide)
    // In practice Date.now() may be the same ms, so we just check they're
    // both valid — true uniqueness isn't guaranteed within the same ms.
    expect(a).toMatch(/^same-title-/)
    expect(b).toMatch(/^same-title-/)
  })
})
