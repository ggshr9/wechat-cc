// Regression guard for test-shim's /attachment endpoint path guard.
//
// The endpoint is dev-only and binds to 127.0.0.1, but any local process
// can reach it. The previous guard used naive `startsWith(root)` which:
//   1. matches sibling dirs (e.g. inbox vs inbox-evil), and
//   2. did not normalize `..` segments before the file open,
// letting attacker-controlled `path=` query escape the inbox root and
// read arbitrary files.

import { test, expect } from './fixtures'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const HOME = process.env.HOME ?? ''
const STATE_DIR = process.env.WECHAT_CC_STATE_DIR ?? join(HOME, '.claude', 'channels', 'wechat')
const INBOX = join(STATE_DIR, 'inbox')

test.describe('shim /attachment path guard', () => {
  test('rejects path traversal via `..`', async ({ shimUrl }) => {
    // A `..` chain that string-prefix-matches the inbox root but resolves
    // OUTSIDE it. Pre-fix this would be served if the target existed.
    const attack = `${INBOX}/../../../../etc/passwd`
    const r = await fetch(`${shimUrl}/attachment?path=${encodeURIComponent(attack)}`)
    expect(r.status).toBe(403)
  })

  test('rejects sibling-prefix collisions (inbox-evil/x)', async ({ shimUrl }) => {
    // Create an actual file at a sibling dir that string-prefix-matches
    // the inbox root, so we can prove the request would have succeeded
    // pre-fix and is rejected now.
    const evilDir = `${INBOX}-evil-pwtest`
    const evilFile = join(evilDir, 'secret.txt')
    if (!existsSync(evilDir)) mkdirSync(evilDir, { recursive: true })
    writeFileSync(evilFile, 'classified')
    try {
      const r = await fetch(`${shimUrl}/attachment?path=${encodeURIComponent(evilFile)}`)
      expect(r.status).toBe(403)
    } finally {
      rmSync(evilDir, { recursive: true, force: true })
    }
  })

  test('rejects empty path', async ({ shimUrl }) => {
    const r = await fetch(`${shimUrl}/attachment`)
    expect(r.status).toBe(403)
  })

  test('serves legitimate file inside the inbox root', async ({ shimUrl }) => {
    if (!existsSync(INBOX)) mkdirSync(INBOX, { recursive: true })
    const file = join(INBOX, 'pwtest-allowed.txt')
    writeFileSync(file, 'ok')
    try {
      const r = await fetch(`${shimUrl}/attachment?path=${encodeURIComponent(file)}`)
      expect(r.status).toBe(200)
      expect(await r.text()).toBe('ok')
    } finally {
      try { rmSync(file) } catch { /* ignore */ }
    }
  })
})
