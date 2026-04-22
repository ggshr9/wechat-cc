#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

export type CliArgs =
  | { cmd: 'run' }
  | { cmd: 'setup' }
  | { cmd: 'install'; userScope: boolean }
  | { cmd: 'status' }
  | { cmd: 'list' }
  | { cmd: 'help' }

export function parseCliArgs(argv: string[], opts?: { warn?: (m: string) => void }): CliArgs {
  const warn = opts?.warn ?? ((m: string) => console.warn(m))
  const [cmd, ...rest] = argv
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') return { cmd: 'help' }
  switch (cmd) {
    case 'run': {
      for (const a of rest) {
        if (
          a === '--fresh' || a === '--continue' || a === '--dangerously' ||
          a === '--channels' || a.startsWith('--mcp-config')
        ) {
          warn(`[wechat-cc] legacy flag ignored: ${a} (v1.0 daemon doesn't spawn claude directly)`)
        }
      }
      return { cmd: 'run' }
    }
    case 'setup': return { cmd: 'setup' }
    case 'install': return { cmd: 'install', userScope: rest.includes('--user') }
    case 'status': return { cmd: 'status' }
    case 'list': return { cmd: 'list' }
    default: return { cmd: 'help' }
  }
}

const HELP_TEXT = `wechat-cc — WeChat bridge for Claude Code (Agent SDK daemon)

Usage:
  wechat-cc setup       Scan QR + bind a WeChat bot
  wechat-cc run         Start the daemon (foreground)
  wechat-cc install [--user]   Register the MCP plugin entry for claude
  wechat-cc status      Show daemon status + accounts
  wechat-cc list        List bound accounts

Notes for 0.x users:
  * The old --fresh / --continue / --dangerously flags are ignored.
    v1.0 uses @anthropic-ai/claude-agent-sdk; daemon manages claude
    subprocesses internally, per-project session pool.
  * /restart from WeChat is removed. Use /project switch or restart
    the daemon process.
`

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2))
  const here = dirname(fileURLToPath(import.meta.url))
  switch (parsed.cmd) {
    case 'run': {
      const daemonPath = join(here, 'src', 'daemon', 'main.ts')
      const r = spawnSync(process.execPath, [daemonPath], { stdio: 'inherit' })
      process.exit(r.status ?? 1)
    }
    case 'setup': {
      const setupPath = join(here, 'setup.ts')
      const r = spawnSync(process.execPath, [setupPath], { stdio: 'inherit' })
      process.exit(r.status ?? 1)
    }
    case 'install': {
      const { installUserMcp } = await import('./install-user-mcp.ts')
      const { join: pathJoin } = await import('node:path')
      const { homedir } = await import('node:os')
      if (parsed.userScope) {
        const configFile = pathJoin(homedir(), '.claude.json')
        installUserMcp(configFile, 'wechat', {
          command: process.execPath,
          args: ['run', '--cwd', here, '--silent', 'start'],
        })
        console.log(`Updated user-scope MCP config: ${configFile}`)
        console.log('\nNext: wechat-cc run or start claude in any project')
      } else {
        console.log('Project-scope install: run `wechat-cc install --user` to register globally,')
        console.log('or manually add the wechat entry to your project .mcp.json.')
      }
      return
    }
    case 'status': case 'list': {
      const { runStatus } = await import('./cli-status.ts')
      await runStatus(parsed.cmd)
      return
    }
    case 'help': {
      console.log(HELP_TEXT)
      return
    }
  }
}

if (import.meta.main) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
