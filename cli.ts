#!/usr/bin/env bun
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { STATE_DIR } from './config'
import { loadAgentConfig, saveAgentConfig, type AgentProviderKind } from './agent-config'
import { analyzeDoctor, defaultDoctorDeps, printDoctor, serviceStatus, setupStatus } from './doctor'
import { buildServicePlan, installService, startService, stopService, uninstallService } from './service-manager'
import { compiledBinaryPath, compiledRepoRoot } from './runtime-info'

// Write potentially-large JSON to a sibling file, return the small
// envelope {ok, out_file, bytes} via stdout. Fixes the desktop sessions
// browser truncation: bun --compile binaries lose bytes when emitting
// MB-sized payloads to a pipe (observed across console.log, process.stdout
// .write, and chunked fs.writeSync — the kernel pipe buffer fills, the
// receiver drains line-by-line, and the producer drops writes on
// EAGAIN). Tauri-side reads from disk instead. CLI consumers that pass
// --out-file get the file route; everyone else (terminal users, tests)
// falls back to plain stdout via console.log.
function emitJson(data: unknown, outFile: string | undefined): void {
  if (!outFile) {
    console.log(JSON.stringify(data, null, 2))
    return
  }
  // Sync write to a regular file: no pipe buffer, no async stdio path.
  const body = JSON.stringify(data, null, 2)
  writeFileSync(outFile, body, 'utf8')
  console.log(JSON.stringify({ ok: true, out_file: outFile, bytes: body.length }))
}

export type CliArgs =
  | { cmd: 'run'; dangerouslySkipPermissions: boolean }
  | { cmd: 'setup'; qrJson?: boolean }
  | { cmd: 'setup-poll'; qrcode: string; baseUrl?: string; json: boolean }
  | { cmd: 'install'; userScope: boolean }
  | { cmd: 'status' }
  | { cmd: 'list' }
  | { cmd: 'doctor'; json: boolean }
  | { cmd: 'setup-status'; json: boolean }
  | { cmd: 'service'; action: 'status' | 'install' | 'start' | 'stop' | 'uninstall'; json: boolean; unattended?: boolean; autoStart?: boolean }
  | { cmd: 'provider-set'; provider: AgentProviderKind; model?: string; unattended?: boolean }
  | { cmd: 'provider-show'; json: boolean }
  | { cmd: 'account-remove'; botId: string; json: boolean }
  | { cmd: 'daemon-kill'; pid: number; json: boolean }
  | { cmd: 'memory-list'; json: boolean }
  | { cmd: 'memory-read'; userId: string; path: string; json: boolean }
  | { cmd: 'memory-write'; userId: string; path: string; bodyBase64: string; json: boolean }
  | { cmd: 'events-list'; chatId: string; json: boolean; limit: number }
  | { cmd: 'observations-list'; chatId: string; json: boolean; includeArchived: boolean }
  | { cmd: 'observations-archive'; chatId: string; obsId: string; json: boolean }
  | { cmd: 'milestones-list'; chatId: string; json: boolean }
  | { cmd: 'sessions-list-projects'; json: boolean; outFile?: string }
  | { cmd: 'sessions-read-jsonl'; alias: string; json: boolean; outFile?: string }
  | { cmd: 'sessions-delete'; alias: string; json: boolean }
  | { cmd: 'sessions-search'; query: string; json: boolean; limit: number; outFile?: string }
  | { cmd: 'conversations-list'; json: boolean }
  | { cmd: 'logs'; tail: number; json: boolean }
  | { cmd: 'reply'; chatId?: string; text?: string; json: boolean }
  | { cmd: 'update'; check: boolean; json: boolean }
  | { cmd: 'demo-seed'; chatId: string | null; json: boolean }
  | { cmd: 'demo-unseed'; chatId: string | null; json: boolean }
  | { cmd: 'avatar-info'; key: string; json: boolean }
  | { cmd: 'avatar-set'; key: string; base64: string; json: boolean }
  | { cmd: 'avatar-remove'; key: string; json: boolean }
  | { cmd: 'guard-status'; json: boolean }
  | { cmd: 'guard-enable'; json: boolean }
  | { cmd: 'guard-disable'; json: boolean }
  | { cmd: 'help' }

export function parseCliArgs(argv: string[], opts?: { warn?: (m: string) => void }): CliArgs {
  const warn = opts?.warn ?? ((m: string) => console.warn(m))
  const [cmd, ...rest] = argv
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') return { cmd: 'help' }
  switch (cmd) {
    case 'run': {
      let dangerouslySkipPermissions = false
      for (const a of rest) {
        if (a === '--dangerously') {
          dangerouslySkipPermissions = true
        } else if (a === '--fresh' || a === '--continue' || a === '--channels' || a.startsWith('--mcp-config')) {
          warn(`[wechat-cc] legacy flag ignored: ${a} (v1.0+ daemon doesn't spawn claude directly)`)
        }
      }
      return { cmd: 'run', dangerouslySkipPermissions }
    }
    case 'setup': return rest.includes('--qr-json') ? { cmd: 'setup', qrJson: true } : { cmd: 'setup' }
    case 'setup-poll': {
      const qrcodeIdx = rest.indexOf('--qrcode')
      const qrcode = qrcodeIdx >= 0 ? rest[qrcodeIdx + 1] : undefined
      if (!qrcode) return { cmd: 'help' }
      const baseUrlIdx = rest.indexOf('--base-url')
      const baseUrl = baseUrlIdx >= 0 ? rest[baseUrlIdx + 1] : undefined
      return baseUrl
        ? { cmd: 'setup-poll', qrcode, baseUrl, json: rest.includes('--json') }
        : { cmd: 'setup-poll', qrcode, json: rest.includes('--json') }
    }
    case 'install': return { cmd: 'install', userScope: rest.includes('--user') }
    case 'status': return { cmd: 'status' }
    case 'list': return { cmd: 'list' }
    case 'doctor': return { cmd: 'doctor', json: rest.includes('--json') }
    case 'setup-status': return { cmd: 'setup-status', json: rest.includes('--json') }
    case 'service': {
      if (rest[0] === 'status' || rest[0] === 'install' || rest[0] === 'start' || rest[0] === 'stop' || rest[0] === 'uninstall') {
        return {
          cmd: 'service', action: rest[0], json: rest.includes('--json'),
          unattended: parseBoolFlag(rest, '--unattended'),
          autoStart: parseBoolFlag(rest, '--auto-start'),
        }
      }
      return { cmd: 'help' }
    }
    case 'account': {
      if (rest[0] === 'remove' && rest[1]) {
        return { cmd: 'account-remove', botId: rest[1], json: rest.includes('--json') }
      }
      return { cmd: 'help' }
    }
    case 'daemon': {
      if (rest[0] === 'kill' && rest[1]) {
        const pid = Number.parseInt(rest[1], 10)
        if (!Number.isFinite(pid) || pid <= 0) return { cmd: 'help' }
        return { cmd: 'daemon-kill', pid, json: rest.includes('--json') }
      }
      return { cmd: 'help' }
    }
    case 'memory': {
      if (rest[0] === 'list') return { cmd: 'memory-list', json: rest.includes('--json') }
      if (rest[0] === 'read' && rest[1] && rest[2]) {
        return { cmd: 'memory-read', userId: rest[1], path: rest[2], json: rest.includes('--json') }
      }
      if (rest[0] === 'write' && rest[1] && rest[2]) {
        const idx = rest.indexOf('--body-base64')
        if (idx < 0 || !rest[idx + 1]) return { cmd: 'help' }
        return { cmd: 'memory-write', userId: rest[1], path: rest[2], bodyBase64: rest[idx + 1]!, json: rest.includes('--json') }
      }
      return { cmd: 'help' }
    }
    case 'events': {
      if (rest[0] === 'list' && rest[1]) {
        const limitIdx = rest.indexOf('--limit')
        const limit = limitIdx >= 0 ? Number.parseInt(rest[limitIdx + 1] ?? '', 10) : 50
        return { cmd: 'events-list', chatId: rest[1], json: rest.includes('--json'), limit: Number.isFinite(limit) ? limit : 50 }
      }
      return { cmd: 'help' }
    }
    case 'observations': {
      if (rest[0] === 'list' && rest[1]) {
        return { cmd: 'observations-list', chatId: rest[1], json: rest.includes('--json'), includeArchived: rest.includes('--include-archived') }
      }
      if (rest[0] === 'archive' && rest[1] && rest[2]) {
        return { cmd: 'observations-archive', chatId: rest[1], obsId: rest[2], json: rest.includes('--json') }
      }
      return { cmd: 'help' }
    }
    case 'milestones': {
      if (rest[0] === 'list' && rest[1]) {
        return { cmd: 'milestones-list', chatId: rest[1], json: rest.includes('--json') }
      }
      return { cmd: 'help' }
    }
    case 'avatar': {
      if (rest[0] === 'info' && rest[1]) {
        return { cmd: 'avatar-info', key: rest[1], json: rest.includes('--json') }
      }
      if (rest[0] === 'set' && rest[1]) {
        const idx = rest.indexOf('--base64')
        if (idx < 0 || !rest[idx + 1]) return { cmd: 'help' }
        return { cmd: 'avatar-set', key: rest[1], base64: rest[idx + 1]!, json: rest.includes('--json') }
      }
      if (rest[0] === 'remove' && rest[1]) {
        return { cmd: 'avatar-remove', key: rest[1], json: rest.includes('--json') }
      }
      return { cmd: 'help' }
    }
    case 'sessions': {
      const outFileIdx = rest.indexOf('--out-file')
      const outFile = outFileIdx >= 0 ? rest[outFileIdx + 1] : undefined
      if (rest[0] === 'list-projects') {
        return { cmd: 'sessions-list-projects', json: rest.includes('--json'), outFile }
      }
      if (rest[0] === 'read-jsonl' && rest[1]) {
        return { cmd: 'sessions-read-jsonl', alias: rest[1], json: rest.includes('--json'), outFile }
      }
      if (rest[0] === 'delete' && rest[1]) {
        return { cmd: 'sessions-delete', alias: rest[1], json: rest.includes('--json') }
      }
      if (rest[0] === 'search' && rest[1]) {
        const limitIdx = rest.indexOf('--limit')
        const limit = limitIdx >= 0 ? Number.parseInt(rest[limitIdx + 1] ?? '', 10) : 50
        return { cmd: 'sessions-search', query: rest[1], json: rest.includes('--json'), limit: Number.isFinite(limit) ? limit : 50, outFile }
      }
      return { cmd: 'help' }
    }
    case 'conversations': {
      if (rest[0] === 'list') {
        return { cmd: 'conversations-list', json: rest.includes('--json') }
      }
      return { cmd: 'help' }
    }
    case 'provider': {
      if (rest[0] === 'show') return { cmd: 'provider-show', json: rest.includes('--json') }
      if (rest[0] === 'set' && (rest[1] === 'claude' || rest[1] === 'codex')) {
        const modelIdx = rest.indexOf('--model')
        const model = modelIdx >= 0 ? rest[modelIdx + 1] : undefined
        const unattended = parseBoolFlag(rest, '--unattended')
        const base: { cmd: 'provider-set'; provider: AgentProviderKind; model?: string; unattended?: boolean } = { cmd: 'provider-set', provider: rest[1] }
        if (model) base.model = model
        if (unattended !== undefined) base.unattended = unattended
        return base
      }
      return { cmd: 'help' }
    }
    case 'update': {
      return {
        cmd: 'update',
        check: rest.includes('--check'),
        json: rest.includes('--json'),
      }
    }
    case 'guard': {
      const json = rest.includes('--json')
      if (rest[0] === 'status') return { cmd: 'guard-status', json }
      if (rest[0] === 'enable')  return { cmd: 'guard-enable', json }
      if (rest[0] === 'disable') return { cmd: 'guard-disable', json }
      return { cmd: 'help' }
    }
    case 'demo': {
      if (rest[0] === 'seed' || rest[0] === 'unseed') {
        const chatIdx = rest.indexOf('--chat-id')
        const chatId = chatIdx >= 0 ? rest[chatIdx + 1] ?? null : null
        return { cmd: rest[0] === 'seed' ? 'demo-seed' : 'demo-unseed', chatId, json: rest.includes('--json') }
      }
      return { cmd: 'help' }
    }
    case 'logs': {
      const idx = rest.indexOf('--tail')
      const tail = idx >= 0 ? Number.parseInt(rest[idx + 1] ?? '', 10) : 50
      return {
        cmd: 'logs',
        tail: Number.isFinite(tail) ? tail : 50,
        json: rest.includes('--json'),
      }
    }
    case 'reply': {
      // wechat-cc reply [--to <chat_id>] [text]
      // text omitted → read from stdin (handled by the dispatch case below).
      const json = rest.includes('--json')
      const toIdx = rest.indexOf('--to')
      const chatId = toIdx >= 0 ? rest[toIdx + 1] : undefined
      const positional = rest.filter((arg, i) =>
        arg !== '--json' && arg !== '--to' && (toIdx < 0 || i !== toIdx + 1),
      )
      const text = positional.length > 0 ? positional.join(' ') : undefined
      const out: { cmd: 'reply'; chatId?: string; text?: string; json: boolean } = { cmd: 'reply', json }
      if (chatId) out.chatId = chatId
      if (text !== undefined) out.text = text
      return out
    }
    default: return { cmd: 'help' }
  }
}

function parseBoolFlag(args: string[], name: string): boolean | undefined {
  const idx = args.indexOf(name)
  if (idx < 0) return undefined
  const value = args[idx + 1]
  if (value === 'true' || value === '1' || value === 'yes' || value === 'on') return true
  if (value === 'false' || value === '0' || value === 'no' || value === 'off') return false
  // Bare flag (no value following) means true.
  if (value === undefined || value.startsWith('--')) return true
  return undefined
}

const HELP_TEXT = `wechat-cc — WeChat bridge for Claude Code (Agent SDK daemon)

Usage:
  wechat-cc setup [--qr-json] Scan QR + bind a WeChat bot
  wechat-cc setup-poll --qrcode TOKEN [--base-url URL] [--json]
  wechat-cc run [--dangerously]   Start the daemon (foreground)
                        --dangerously: skip permission prompts
                        (matches claude --dangerously-skip-permissions)
  wechat-cc install [--user]   Register the MCP plugin entry for claude
  wechat-cc status      Show daemon status + accounts
  wechat-cc list        List bound accounts
  wechat-cc doctor [--json]        Diagnose install/setup state
  wechat-cc setup-status [--json]  Machine-readable setup status for desktop UI
  wechat-cc service <status|install|start|stop|uninstall> [--json] [--unattended true|false] [--auto-start true|false]
                        --unattended: persist into agent-config and re-write plist.
                                      Idempotent: install replaces any existing daemon.
                        --auto-start: register for boot/login auto-start
                                      (macOS RunAtLoad, systemd enable,
                                      schtasks ONLOGON). Default false: opt-in.
                        Crash-respawn (macOS KeepAlive / systemd Restart=always)
                        is always on — no longer a user-facing flag.
  wechat-cc account remove <bot-id> [--json]
                        Decommission a bound bot — wipes its account dir,
                        context_token, user_account_id, session-state entry.
                        Restart the daemon afterwards for it to take effect.
  wechat-cc daemon kill <pid> [--json]
                        Force-kill a daemon process by pid. Verifies cmdline
                        contains cli.ts or src/daemon/main.ts before signaling.
                        SIGTERM (1.5s grace) then SIGKILL.
  wechat-cc memory list [--json]
                        List Companion v2 memory files (per user).
  wechat-cc memory read <user-id> <path> [--json]
                        Read one .md memory file. Path is relative to the
                        user's memory dir, traversal-safe.
  wechat-cc memory write <user-id> <path> --body-base64 <b64> [--json]
                        Write/overwrite one .md memory file. Body is
                        passed as base64 (avoids shell-quote pain with
                        multi-line markdown). Sandboxed: .md only,
                        ≤100KB, no traversal, atomic rename.
  wechat-cc events list <chat-id> [--limit N] [--json]
                        Tail Companion decisions log (push/skip/observation/milestone).
  wechat-cc observations list <chat-id> [--include-archived] [--json]
                        Active observations (default) or archive.
  wechat-cc observations archive <chat-id> <obs-id> [--json]
                        Mark an observation archived (user "ignore").
  wechat-cc milestones list <chat-id> [--json]
                        Per-chat milestones (id-deduped).
  wechat-cc sessions list-projects [--json]
                        Project sessions with cached summaries.
  wechat-cc sessions read-jsonl <alias> [--json]
                        Read all turns from the alias's session jsonl.
  wechat-cc sessions delete <alias> [--json]
                        Remove the sessions.json entry (jsonl on disk untouched).
  wechat-cc sessions search <query> [--limit N] [--json]
                        Naive case-insensitive substring search across
                        all sessions.json-registered jsonls.
  wechat-cc demo seed [--chat-id <id>] [--json]
                        Populate sample observations + milestones + events
                        for first-impression / screenshot use. Defaults to
                        companion default_chat_id if --chat-id omitted.
  wechat-cc demo unseed [--chat-id <id>] [--json]
                        Remove items written by \`demo seed\`. Idempotent.
  wechat-cc reply [--to <chat_id>] [text] [--json]
                        Send a text reply via WeChat. Reuses the daemon's
                        on-disk state (contextToken + account routing) so
                        recipient resolution matches the running daemon.
                        --to omitted → most-recently-active chat.
                        text omitted → read from stdin.
                        Useful when the daemon's MCP server is unreachable.
  wechat-cc logs [--tail N] [--json]
                        Tail the daemon's channel.log. Default --tail 50.
                        --json returns parsed entries (timestamp, tag,
                        message). Without --json, raw lines are printed
                        (equivalent to: tail -n N channel.log).
  wechat-cc update [--check] [--json]
                        Pull latest + reinstall deps + restart service.
                        --check probes only (no side effects); GUI calls
                        this on a timer to surface the Update button.
  wechat-cc provider show [--json]  Show selected agent provider
  wechat-cc provider set <claude|codex> [--model MODEL] [--unattended true|false]
                        --unattended: when true (default for new installs), the
                          installed daemon runs the daemon with --dangerously so
                          inbound WeChat messages don't hang waiting for human
                          permission prompts. Set false for interactive mode.

Notes for 0.x users:
  * The old --fresh / --continue flags are ignored; --dangerously is restored.
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
      // Run the daemon in-process by importing main.ts (its module top-level
      // invokes main()). This used to spawn `bun src/daemon/main.ts`, but that
      // doesn't work in `bun build --compile`d binaries where the source tree
      // isn't on disk anymore — and the compiled sidecar shipped inside the
      // desktop bundle is the single source of truth for both CLI and daemon.
      if (parsed.dangerouslySkipPermissions && !process.argv.includes('--dangerously')) {
        process.argv.push('--dangerously')
      }
      await import('./src/daemon/main.ts')
      // main() is started by main.ts's top-level; it never resolves under
      // normal operation (long poll loops keep the event loop alive). Block
      // here so cli.ts's main() doesn't return and trigger process exit.
      await new Promise(() => {})
      return
    }
    case 'setup': {
      if (parsed.qrJson) {
        const { requestSetupQrCode } = await import('./setup-flow.ts')
        console.log(JSON.stringify(await requestSetupQrCode(), null, 2))
        return
      }
      // Same rationale as `run`: import setup.ts directly so the compiled
      // sidecar can drive the QR flow from inside Tauri-spawned shells too.
      await import('./setup.ts')
      return
    }
    case 'setup-poll': {
      const { pollSetupQrStatus } = await import('./setup-flow.ts')
      const result = await pollSetupQrStatus({ qrcode: parsed.qrcode, baseUrl: parsed.baseUrl, stateDir: STATE_DIR })
      if (parsed.json) console.log(JSON.stringify(result, null, 2))
      else console.log(result.status)
      return
    }
    case 'install': {
      // `wechat-cc install [--user]` was the v0.x entrypoint that wrote a
      // wechat MCP server entry into ~/.claude.json so Claude Code would
      // spawn the channel as a child MCP. v1.0+ flipped the model: the
      // daemon now drives Claude via the Agent SDK directly, so an MCP
      // entry serves no purpose — the args we used to write
      // (`['run', '--cwd', here, '--silent', 'start']`) aren't even valid
      // for the v1.2 cli parser. Tell the user the new path instead of
      // silently writing a broken entry.
      console.error('wechat-cc install is deprecated since v1.0.')
      console.error('Use `wechat-cc service install` to register the daemon (macOS launchd / Linux systemd / Windows ScheduledTask),')
      console.error('or open the desktop app and walk through the setup wizard.')
      process.exit(2)
    }
    case 'status': case 'list': {
      const { runStatus } = await import('./cli-status.ts')
      await runStatus(parsed.cmd)
      return
    }
    case 'doctor': {
      const report = analyzeDoctor(defaultDoctorDeps())
      if (parsed.json) console.log(JSON.stringify(report, null, 2))
      else printDoctor(report)
      return
    }
    case 'setup-status': {
      const deps = defaultDoctorDeps()
      const status = setupStatus(deps)
      if (parsed.json) console.log(JSON.stringify(status, null, 2))
      else console.log(status.bound ? 'wechat: bound' : 'wechat: not bound')
      return
    }
    case 'service': {
      // If the caller passed --unattended or --auto-start, persist them into
      // agent-config first so it's the source of truth (re-installs from the
      // GUI re-pick the same values).
      if (parsed.unattended !== undefined || parsed.autoStart !== undefined) {
        const existing = loadAgentConfig(STATE_DIR)
        saveAgentConfig(STATE_DIR, {
          ...existing,
          ...(parsed.unattended !== undefined ? { dangerouslySkipPermissions: parsed.unattended } : {}),
          ...(parsed.autoStart !== undefined ? { autoStart: parsed.autoStart } : {}),
        })
      }
      const config = loadAgentConfig(STATE_DIR)
      // Compiled-bundle mode: launch the daemon via the same self-contained
      // binary (no external bun + cli.ts source). Source mode: legacy
      // `bunPath cli.ts run` ExecStart. compiledBinaryPath/compiledRepoRoot
      // both return non-null only in compiled mode — see runtime-info.ts.
      const binaryPath = compiledBinaryPath() ?? undefined
      const planCwd = compiledRepoRoot() ?? here
      const plan = buildServicePlan({
        cwd: planCwd,
        dangerouslySkipPermissions: config.dangerouslySkipPermissions,
        autoStart: config.autoStart,
        ...(binaryPath ? { binaryPath } : {}),
      })
      if (parsed.action === 'status') {
        const status = serviceStatus(defaultDoctorDeps())
        if (parsed.json) console.log(JSON.stringify({ ...status, plan, agentConfig: config }, null, 2))
        else console.log(`service: ${status.state}${status.installed ? ' [installed]' : ''}${status.pid ? ` pid=${status.pid}` : ''}`)
        return
      }
      // WECHAT_CC_DRY_RUN=1 makes install/uninstall/start/stop a no-op (still
      // returns the plan in JSON). Used by the apps/desktop e2e shim so tests
      // exercise real cli.ts without touching ~/Library/LaunchAgents/launchd.
      const dryRun = process.env.WECHAT_CC_DRY_RUN === '1'
      const sideOpts = { dryRun }
      if (parsed.action === 'install') {
        // Idempotent: best-effort tear down any previous install so we can
        // re-write the plist (e.g. unattended toggle changed). Swallow errors
        // — a partial/stale state (plist missing, launchd doesn't have it)
        // would otherwise block the fresh install.
        try { uninstallService(plan, sideOpts) } catch { /* tolerate */ }
        installService(plan, sideOpts)
      } else if (parsed.action === 'start') startService(plan, sideOpts)
      else if (parsed.action === 'stop') stopService(plan, sideOpts)
      else if (parsed.action === 'uninstall') uninstallService(plan, sideOpts)
      const out = { ok: true, action: parsed.action, plan, agentConfig: config, dryRun }
      if (parsed.json) console.log(JSON.stringify(out, null, 2))
      else console.log(`service ${parsed.action}: ok${dryRun ? ' (dry-run)' : ''}`)
      return
    }
    case 'memory-list': {
      const { listAllMemory } = await import('./memory.ts')
      const users = listAllMemory(STATE_DIR)
      if (parsed.json) console.log(JSON.stringify(users, null, 2))
      else {
        if (users.length === 0) console.log('(no memory files)')
        for (const u of users) {
          console.log(`${u.userId}  (${u.fileCount} 文件 · ${u.totalBytes} 字节)`)
          for (const f of u.files) console.log(`  - ${f.path}  (${f.size}B)`)
        }
      }
      return
    }
    case 'memory-read': {
      const { readMemoryFile } = await import('./memory.ts')
      try {
        const content = readMemoryFile(STATE_DIR, parsed.userId, parsed.path)
        if (parsed.json) console.log(JSON.stringify({ ok: true, userId: parsed.userId, path: parsed.path, content }, null, 2))
        else process.stdout.write(content)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // --json: emit ok:false on stdout + exit 0 so GUI callers can read
        // the structured error. Non-JSON: stderr + exit 1 (matches the
        // pattern in `update --json` and is what the GUI invoke path
        // expects — error info travels via JSON.ok=false, not exit code).
        if (parsed.json) {
          console.log(JSON.stringify({ ok: false, error: msg }))
          return
        }
        console.error(`memory read failed: ${msg}`)
        process.exit(1)
      }
      return
    }
    case 'logs': {
      const { tailLog } = await import('./logs.ts')
      const result = tailLog(STATE_DIR, parsed.tail)
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2))
        return
      }
      if (!result.ok) {
        console.error(`logs read failed: ${result.error}`)
        process.exit(1)
      }
      // Plain-text form for terminal users — match the file's original layout
      // so `wechat-cc logs --tail 30` looks like a `tail -n 30 channel.log`.
      for (const e of result.entries) console.log(e.raw)
      return
    }
    case 'memory-write': {
      const { writeMemoryFile } = await import('./memory.ts')
      try {
        // Body comes in via base64 to dodge shell-quoting hell on multi-line
        // markdown content (Tauri sidecar IPC passes args as a list, but
        // the underlying CLI would still see CRLF/quote/backtick sequences
        // unsafely if we tried to inline the content). Decoder + UTF-8
        // assumption matches the GUI's btoa(unescape(encodeURIComponent(body))).
        const body = Buffer.from(parsed.bodyBase64, 'base64').toString('utf8')
        const result = writeMemoryFile(STATE_DIR, parsed.userId, parsed.path, body)
        if (parsed.json) console.log(JSON.stringify({ ok: true, userId: parsed.userId, path: parsed.path, ...result }, null, 2))
        else console.log(`${result.created ? 'created' : 'updated'}: ${parsed.userId}/${parsed.path} (${result.bytesWritten}B)`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (parsed.json) {
          console.log(JSON.stringify({ ok: false, error: msg }))
          return
        }
        console.error(`memory write failed: ${msg}`)
        process.exit(1)
      }
      return
    }
    case 'events-list': {
      const { makeEventsStore } = await import('./src/daemon/events/store')
      const memoryRoot = join(STATE_DIR, 'memory')
      const store = makeEventsStore(memoryRoot, parsed.chatId)
      const list = await store.list({ limit: parsed.limit })
      console.log(parsed.json ? JSON.stringify({ ok: true, events: list }, null, 2) : list.map(e => `${e.ts} ${e.kind} ${e.trigger}`).join('\n'))
      return
    }
    case 'observations-list': {
      const { makeObservationsStore } = await import('./src/daemon/observations/store')
      const memoryRoot = join(STATE_DIR, 'memory')
      const store = makeObservationsStore(memoryRoot, parsed.chatId)
      const list = parsed.includeArchived ? await store.listArchived() : await store.listActive()
      console.log(parsed.json ? JSON.stringify({ ok: true, observations: list }, null, 2) : list.map(o => `${o.ts} ${o.body}`).join('\n'))
      return
    }
    case 'observations-archive': {
      const { makeObservationsStore } = await import('./src/daemon/observations/store')
      const memoryRoot = join(STATE_DIR, 'memory')
      const store = makeObservationsStore(memoryRoot, parsed.chatId)
      await store.archive(parsed.obsId)
      console.log(parsed.json ? JSON.stringify({ ok: true, archived: parsed.obsId }, null, 2) : `archived ${parsed.obsId}`)
      return
    }
    case 'milestones-list': {
      const { makeMilestonesStore } = await import('./src/daemon/milestones/store')
      const memoryRoot = join(STATE_DIR, 'memory')
      const store = makeMilestonesStore(memoryRoot, parsed.chatId)
      const list = await store.list()
      console.log(parsed.json ? JSON.stringify({ ok: true, milestones: list }, null, 2) : list.map(m => `${m.ts} ${m.body}`).join('\n'))
      return
    }
    case 'sessions-list-projects': {
      const { makeSessionStore } = await import('./src/core/session-store')
      const store = makeSessionStore(join(STATE_DIR, 'sessions.json'), { debounceMs: 500 })
      const all = store.all()
      const projects = Object.entries(all).map(([alias, rec]) => ({
        alias,
        session_id: rec.session_id,
        last_used_at: rec.last_used_at,
        summary: rec.summary ?? null,
        summary_updated_at: rec.summary_updated_at ?? null,
      }))
      if (parsed.json) emitJson({ ok: true, projects }, parsed.outFile)
      else console.log(projects.map(p => `${p.alias} ${p.last_used_at}`).join('\n'))

      // Fire-and-forget: refresh stale summaries in the background. The current
      // request returns immediately with whatever's cached; next list call will
      // pick up the fresh summaries. WECHAT_CC_DISABLE_SUMMARIZER=1 skips for
      // CI/e2e where SDK calls are undesirable.
      if (process.env.WECHAT_CC_DISABLE_SUMMARIZER !== '1') {
        void (async () => {
          try {
            const { triggerStaleSummaryRefresh } = await import('./src/daemon/sessions/summarizer-runtime')
            // resolveIntrospectChatId is named for its first caller (introspect)
            // but it's actually a generic "default chat" resolver that reads
            // companion config. Reusing it here avoids extracting yet another
            // helper for what is, today, the same v0.4.x single-chat lookup.
            const { resolveIntrospectChatId } = await import('./src/daemon/companion/introspect-runtime')
            const { query } = await import('@anthropic-ai/claude-agent-sdk')
            await triggerStaleSummaryRefresh({
              stateDir: STATE_DIR,
              resolveChatId: () => resolveIntrospectChatId(STATE_DIR),
              sdkEval: async (prompt) => {
                let text = ''
                const q = query({ prompt, options: { model: 'claude-haiku-4-5', maxTurns: 1 } })
                for await (const raw of q as AsyncGenerator<import('@anthropic-ai/claude-agent-sdk').SDKMessage>) {
                  const msg = raw as unknown as { type: string; message?: { content?: unknown } }
                  if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
                    for (const part of msg.message.content as Array<{ type?: string; text?: string }>) {
                      if (part.type === 'text' && typeof part.text === 'string') text += part.text
                    }
                  }
                }
                return text
              },
            })
          } catch { /* swallow — summary is non-critical */ }
        })()
      }
      return
    }
    case 'sessions-read-jsonl': {
      const { makeSessionStore } = await import('./src/core/session-store')
      const store = makeSessionStore(join(STATE_DIR, 'sessions.json'), { debounceMs: 0 })
      const rec = store.get(parsed.alias)
      if (!rec) {
        console.log(parsed.json ? JSON.stringify({ ok: false, error: 'no such alias' }, null, 2) : 'no such alias')
        return
      }
      const { resolveProjectJsonlPath } = await import('./src/daemon/sessions/path-resolver')
      const path = resolveProjectJsonlPath(parsed.alias, rec.session_id)
      const { existsSync, readFileSync } = await import('node:fs')
      if (!existsSync(path)) {
        console.log(parsed.json ? JSON.stringify({ ok: false, error: 'jsonl missing' }, null, 2) : 'jsonl missing')
        return
      }
      const lines = readFileSync(path, 'utf8').split('\n').filter(l => l.length > 0)
      const turns = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(t => t !== null)
      if (parsed.json) emitJson({ ok: true, alias: parsed.alias, session_id: rec.session_id, turns }, parsed.outFile)
      else console.log(`${turns.length} turns`)
      return
    }
    case 'sessions-delete': {
      const { makeSessionStore } = await import('./src/core/session-store')
      const store = makeSessionStore(join(STATE_DIR, 'sessions.json'), { debounceMs: 0 })
      store.delete(parsed.alias)
      await store.flush()
      console.log(parsed.json ? JSON.stringify({ ok: true, deleted: parsed.alias }, null, 2) : `deleted ${parsed.alias}`)
      return
    }
    case 'sessions-search': {
      const { searchAcrossSessions } = await import('./src/daemon/sessions/searcher')
      const hits = await searchAcrossSessions(parsed.query, { limit: parsed.limit, stateDir: STATE_DIR })
      if (parsed.json) emitJson({ ok: true, query: parsed.query, hits }, parsed.outFile)
      else console.log(hits.map(h => `${h.alias} · ${h.snippet}`).join('\n'))
      return
    }
    case 'conversations-list': {
      // Read-only snapshot of conversations.json + user_names.json. Used by
      // the desktop dashboard (P5.2) to display per-chat mode badges. Falls
      // back to chat_id as user_name when no name has been captured yet.
      const { makeConversationStore } = await import('./src/core/conversation-store')
      const { makeStateStore } = await import('./src/daemon/state-store')
      const store = makeConversationStore(join(STATE_DIR, 'conversations.json'), { debounceMs: 0 })
      const names = makeStateStore(join(STATE_DIR, 'user_names.json'), { debounceMs: 0 })
      const conversations = Object.entries(store.all()).map(([chat_id, rec]) => ({
        chat_id,
        user_name: names.get(chat_id) ?? null,
        mode: rec.mode,
      }))
      if (parsed.json) console.log(JSON.stringify({ ok: true, conversations }, null, 2))
      else console.log(conversations.map(c => `${c.chat_id} ${c.user_name ?? ''} ${c.mode.kind}`).join('\n'))
      return
    }
    case 'avatar-info': {
      const { avatarInfo } = await import('./src/daemon/avatar/store')
      const info = avatarInfo(STATE_DIR, parsed.key)
      if (parsed.json) console.log(JSON.stringify({ ok: true, ...info }))
      else console.log(`${parsed.key}: ${info.exists ? info.path : '(no avatar)'}`)
      return
    }
    case 'avatar-set': {
      const { setAvatar } = await import('./src/daemon/avatar/store')
      try {
        const result = setAvatar(STATE_DIR, parsed.key, parsed.base64)
        if (parsed.json) console.log(JSON.stringify(result))
        else console.log(`set ${parsed.key} → ${result.path}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (parsed.json) console.log(JSON.stringify({ ok: false, error: msg }))
        else console.error(`avatar set failed: ${msg}`)
        process.exit(1)
      }
      return
    }
    case 'avatar-remove': {
      const { removeAvatar } = await import('./src/daemon/avatar/store')
      const result = removeAvatar(STATE_DIR, parsed.key)
      if (parsed.json) console.log(JSON.stringify(result))
      else console.log(`removed ${parsed.key}`)
      return
    }
    case 'guard-status': {
      // Live one-shot probe (independent of any running daemon's
      // scheduler). Useful for both the dashboard status row and
      // operator debugging — `wechat-cc guard status --json` from
      // any terminal returns the current external IP + reachability.
      const { loadGuardConfig } = await import('./src/daemon/guard/store')
      const { fetchPublicIp, probeReachable } = await import('./src/daemon/guard/probe')
      const cfg = loadGuardConfig(STATE_DIR)
      const ipRes = await fetchPublicIp({ url: cfg.ipify_url })
      const probeRes = await probeReachable(cfg.probe_url)
      const out = {
        enabled: cfg.enabled,
        ip: ipRes.ip,
        reachable: probeRes.reachable,
        probe_url: cfg.probe_url,
        ip_error: ipRes.error ?? null,
        probe_error: probeRes.error ?? null,
        probe_ms: probeRes.ms,
      }
      if (parsed.json) console.log(JSON.stringify(out, null, 2))
      else {
        console.log(`enabled: ${out.enabled}`)
        console.log(`ip:      ${out.ip ?? '?'}${out.ip_error ? ` (${out.ip_error})` : ''}`)
        console.log(`probe:   ${out.reachable ? 'reachable' : 'UNREACHABLE'} (${cfg.probe_url})${out.probe_error ? ` — ${out.probe_error}` : ''}`)
      }
      return
    }
    case 'guard-enable':
    case 'guard-disable': {
      const { loadGuardConfig, saveGuardConfig } = await import('./src/daemon/guard/store')
      const cfg = loadGuardConfig(STATE_DIR)
      cfg.enabled = parsed.cmd === 'guard-enable'
      saveGuardConfig(STATE_DIR, cfg)
      if (parsed.json) console.log(JSON.stringify({ ok: true, enabled: cfg.enabled }))
      else console.log(`guard: ${cfg.enabled ? 'enabled' : 'disabled'}`)
      return
    }
    case 'daemon-kill': {
      const { killDaemonByPid, defaultKillDeps } = await import('./daemon-kill.ts')
      const result = await killDaemonByPid(defaultKillDeps(), parsed.pid)
      if (parsed.json) console.log(JSON.stringify(result, null, 2))
      else console.log(result.killed ? `killed pid ${result.pid}` : `failed: ${result.message}`)
      if (!result.killed) process.exit(1)
      return
    }
    case 'account-remove': {
      const { removeAccount } = await import('./account-remove.ts')
      try {
        const result = removeAccount({ stateDir: STATE_DIR }, parsed.botId)
        if (parsed.json) {
          console.log(JSON.stringify({ ok: true, ...result, restartRequired: true }, null, 2))
        } else {
          console.log(`removed: ${result.botId}`)
          for (const r of result.removed) console.log(`  - ${r}`)
          for (const w of result.warnings) console.log(`  ! ${w}`)
          console.log('\nrestart daemon for the change to take effect.')
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (parsed.json) console.log(JSON.stringify({ ok: false, error: msg }))
        else console.error(`account remove failed: ${msg}`)
        process.exit(1)
      }
      return
    }
    case 'update': {
      const { analyzeUpdate, applyUpdate, defaultUpdateDeps } = await import('./update.ts')
      // Compiled-bundle short-circuit: when the binary is shipped inside a
      // desktop .app/.exe, there is no git repo nearby. Surface this with a
      // dedicated `not_a_git_repo` reason instead of bubbling up an empty-
      // stderr fetch_failed (which the GUI couldn't tell from a real outage).
      const { existsSync } = await import('node:fs')
      const { join } = await import('node:path')
      const repoRoot = compiledRepoRoot() ?? here
      const hasGitRepo = existsSync(join(repoRoot, '.git'))
      if (!hasGitRepo) {
        const synthetic = {
          ok: false as const,
          mode: parsed.check ? ('check' as const) : ('apply' as const),
          reason: 'not_a_git_repo' as const,
          message: 'no git repo at this binary\'s location; in-place updates are not available for desktop bundles (download a newer version from GitHub Releases instead)',
          details: { repoRoot },
        }
        if (parsed.json) console.log(JSON.stringify(synthetic, null, 2))
        else console.error(`update: not_a_git_repo — ${synthetic.message}`)
        if (!parsed.json) process.exit(1)
        return
      }
      const deps = defaultUpdateDeps(repoRoot, STATE_DIR)
      if (parsed.check) {
        const probe = analyzeUpdate(deps)
        if (parsed.json) {
          console.log(JSON.stringify(probe, null, 2))
        } else if (!probe.ok) {
          console.error(`update check: ${probe.reason} — ${probe.message}`)
          process.exit(1)
        } else {
          console.log(probe.updateAvailable
            ? `update available: ${probe.currentCommit} → ${probe.latestCommit} (${probe.behind} commits${probe.lockfileWillChange ? ', lockfile changes' : ''})`
            : `up to date (${probe.currentCommit})`)
        }
        return
      }
      const result = await applyUpdate(deps)
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2))
      } else if (!result.ok) {
        console.error(`update failed: ${result.reason} — ${result.message}`)
        process.exit(1)
      } else {
        const lockNote = result.lockfileChanged ? ', deps reinstalled' : ''
        console.log(`updated: ${result.fromCommit} → ${result.toCommit}${lockNote}, daemon=${result.daemonAction} (${result.elapsedMs}ms)`)
      }
      return
    }
    case 'provider-show': {
      const config = loadAgentConfig(STATE_DIR)
      if (parsed.json) console.log(JSON.stringify(config, null, 2))
      else console.log(`provider: ${config.provider}${config.model ? ` (${config.model})` : ''} unattended=${config.dangerouslySkipPermissions}`)
      return
    }
    case 'provider-set': {
      const existing = loadAgentConfig(STATE_DIR)
      const next = {
        ...existing,
        provider: parsed.provider,
        ...(parsed.model !== undefined ? { model: parsed.model } : {}),
        ...(parsed.unattended !== undefined ? { dangerouslySkipPermissions: parsed.unattended } : {}),
      }
      // When switching provider, drop a stale model from the previous provider
      // unless the caller explicitly set one.
      if (existing.provider !== parsed.provider && parsed.model === undefined) {
        delete (next as Partial<typeof next>).model
      }
      saveAgentConfig(STATE_DIR, next)
      console.log(`provider set: ${next.provider}${next.model ? ` (${next.model})` : ''} unattended=${next.dangerouslySkipPermissions}`)
      return
    }
    case 'demo-seed':
    case 'demo-unseed': {
      const { loadCompanionConfig } = await import('./src/daemon/companion/config')
      const cfg = loadCompanionConfig(STATE_DIR)
      const chatId = parsed.chatId ?? cfg.default_chat_id
      if (!chatId) {
        const msg = 'no default chat configured — pass --chat-id or run setup first'
        console.error(parsed.json ? JSON.stringify({ ok: false, error: msg }, null, 2) : msg)
        process.exit(1)
      }
      const { seedDemo, unseedDemo } = await import('./src/daemon/demo/seed')
      const fn = parsed.cmd === 'demo-seed' ? seedDemo : unseedDemo
      const result = await fn({ stateDir: STATE_DIR, chatId })
      console.log(parsed.json ? JSON.stringify({ ok: true, ...result }, null, 2) : JSON.stringify(result))
      return
    }
    case 'reply': {
      // CLI fallback for the MCP `reply` tool — same code path as the
      // daemon (sendReplyOnce reads state from disk), so recipient
      // resolution + session continuity are identical whether the
      // daemon is running or not.
      const { sendReplyOnce, defaultTerminalChatId } = await import('./send-reply.ts')
      const emitFailure = (error: string): void => {
        if (parsed.json) console.log(JSON.stringify({ ok: false, error }))
        else console.error(`reply failed: ${error}`)
        process.exit(1)
      }
      const chatId = parsed.chatId ?? defaultTerminalChatId() ?? undefined
      if (!chatId) {
        emitFailure('no chat resolved — pass --to <chat_id> or send a WeChat message first so the daemon records one')
        return
      }
      const text = parsed.text ?? (await readStdin()).trim()
      if (!text) {
        emitFailure('no text — pass it as an argument or pipe it on stdin')
        return
      }
      const result = await sendReplyOnce(chatId, text)
      if (!result.ok) {
        emitFailure(result.error)
        return
      }
      if (parsed.json) {
        console.log(JSON.stringify({ ok: true, chat_id: chatId, chunks: result.chunks, account: result.account }))
      } else {
        console.log(`Sent: ${result.chunks} chunk(s) via account ${result.account} → ${chatId}`)
      }
      return
    }
    case 'help': {
      console.log(HELP_TEXT)
      return
    }
  }
}

/** Read stdin to EOF. Returns '' immediately if stdin is a TTY. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

if (import.meta.main) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
