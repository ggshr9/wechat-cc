import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const STATE_DIR = join(homedir(), '.claude', 'channels', 'wechat')
const ACCOUNTS_DIR = join(STATE_DIR, 'accounts')
const PID_PATH = join(STATE_DIR, 'server.pid')

function isDaemonAlive(): { alive: boolean; pid: number | null } {
  if (!existsSync(PID_PATH)) return { alive: false, pid: null }
  try {
    const raw = readFileSync(PID_PATH, 'utf8').trim()
    const pid = Number(raw)
    if (!Number.isFinite(pid) || pid <= 0) return { alive: false, pid: null }
    try {
      process.kill(pid, 0)
      return { alive: true, pid }
    } catch {
      return { alive: false, pid }
    }
  } catch {
    return { alive: false, pid: null }
  }
}

function printAccounts(): void {
  if (!existsSync(ACCOUNTS_DIR)) {
    console.log('No bound accounts. Run `wechat-cc setup` to scan QR and bind.')
    return
  }
  let dirs: string[]
  try {
    dirs = readdirSync(ACCOUNTS_DIR)
  } catch {
    console.log('Could not read accounts directory.')
    return
  }
  // Hide v0.5.6 dedupe-archived dirs from the user-facing listing.
  // They live on disk for the audit trail; for everyday `list` output
  // we show only the active set.
  dirs = dirs.filter(id => !id.includes('.superseded.'))
  if (dirs.length === 0) {
    console.log('No bound accounts. Run `wechat-cc setup` to scan QR and bind.')
    return
  }
  console.log(`Bound accounts (${dirs.length}):\n`)
  for (const id of dirs) {
    try {
      const account = JSON.parse(readFileSync(join(ACCOUNTS_DIR, id, 'account.json'), 'utf8'))
      console.log(`  ${id}`)
      console.log(`    botId:  ${account.botId}`)
      console.log(`    userId: ${account.userId}`)
      console.log(`    base:   ${account.baseUrl}`)
      console.log()
    } catch {
      console.log(`  ${id} (could not read account.json)`)
    }
  }
}

export async function runStatus(cmd: 'status' | 'list'): Promise<void> {
  if (cmd === 'list') {
    printAccounts()
    return
  }

  // cmd === 'status'
  const { alive, pid } = isDaemonAlive()
  if (alive && pid != null) {
    console.log(`daemon: running (pid=${pid})`)
  } else if (pid != null) {
    console.log(`daemon: stale pid file (pid=${pid}, process not found)`)
  } else {
    console.log('daemon: no daemon running')
  }
  console.log()
  printAccounts()
}
