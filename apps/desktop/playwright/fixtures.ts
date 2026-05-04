import { test as base, expect } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'

interface ShimFixtures {
  shimUrl: string
  shim: { invoke(cmd: string, args?: unknown): Promise<unknown> }
}

// Worker-scoped fixtures run once per worker (not per test), so the shim
// process is started once and reused across all tests in the file.
// This avoids port-in-use races when tests share a worker.
interface WorkerShimFixtures {
  _workerShimUrl: string
}

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url, { method: 'GET' })
      if (r.ok || r.status === 404) return  // 404 means server is up but root has no handler
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`Shim did not start at ${url} within ${timeoutMs}ms`)
}

const SHIM_PORT = 4174
const SHIM_URL = `http://127.0.0.1:${SHIM_PORT}`

export const test = base.extend<ShimFixtures, WorkerShimFixtures>({
  // Worker-scoped: start the shim once per worker, share across all tests.
  _workerShimUrl: [async ({}, use) => {
    let proc: ChildProcess | null = null
    try {
      proc = spawn('bun', ['test-shim.ts'], {
        cwd: process.cwd(),  // apps/desktop when run via `playwright test`
        env: { ...process.env, WECHAT_CC_DRY_RUN: '1', WECHAT_CC_SHIM_PORT: String(SHIM_PORT) },
        stdio: 'pipe',
        shell: process.platform === 'win32',
      })
      // Suppress EADDRINUSE noise: if the port is already occupied (e.g. a
      // previous run's shim is still alive), the spawn will fail immediately
      // but waitForUrl will still succeed — so we tolerate that case.
      proc.stderr?.on('data', (d: Buffer) => {
        const msg = d.toString().trim()
        if (!msg.includes('EADDRINUSE')) process.stderr.write(`[shim] ${msg}\n`)
      })
      proc.stdout?.on('data', (d: Buffer) => process.stderr.write(`[shim] ${d.toString().trim()}\n`))
      await waitForUrl(SHIM_URL, 10_000)
      await use(SHIM_URL)
    } finally {
      if (proc) {
        proc.kill('SIGTERM')
        await new Promise(r => setTimeout(r, 500))
      }
    }
  }, { scope: 'worker' }],

  // Test-scoped: just expose the worker-scoped URL
  shimUrl: async ({ _workerShimUrl }, use) => {
    await use(_workerShimUrl)
  },

  shim: async ({ _workerShimUrl }, use) => {
    await use({
      invoke: async (cmd, args = {}) => {
        const r = await fetch(`${_workerShimUrl}/__invoke`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ command: cmd, args }),
        })
        return r.json()
      },
    })
  },
})

export { expect }
