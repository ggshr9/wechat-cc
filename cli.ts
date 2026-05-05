#!/usr/bin/env bun
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { defineCommand, runMain } from 'citty'
import { STATE_DIR } from './src/lib/config'
import { loadAgentConfig, saveAgentConfig, type AgentProviderKind } from './src/lib/agent-config'
import { analyzeDoctor, defaultDoctorDeps, printDoctor, serviceStatus, setupStatus } from './src/cli/doctor'
import { buildServicePlan, installService, startService, stopService, uninstallService } from './src/cli/service-manager'
import { compiledBinaryPath, compiledRepoRoot } from './src/lib/runtime-info'

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

// PR4 batch 3c: parseCliArgs + CliArgs union deleted. All subcommands now
// flow through citty (see `cittyRoot` below). The previous gate
// `MIGRATED_COMMANDS.has(first)` is gone — citty handles unknown commands
// by printing its auto-generated usage. Bare `wechat-cc` / `--help` /
// `-h` / `help` is intercepted in main() and renders HELP_TEXT.

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

/**
 * citty migration — batch 1.
 *
 * Subcommands listed in `MIGRATED_COMMANDS` go through the citty root below;
 * everything else still falls through to legacy `parseCliArgs` + the
 * executor switch in `main()`. Each batch will move ~5-10 more commands from
 * the legacy switch into `cittyRoot.subCommands` until the legacy parser is
 * empty.
 *
 * Subcommand `run` handlers preserve the dynamic-import pattern
 * (`await import('./src/cli/X.ts')`) so cold-start cost stays the same.
 */
const statusListRun = async (cmd: 'status' | 'list'): Promise<void> => {
  const { runStatus } = await import('./src/cli/cli-status.ts')
  await runStatus(cmd)
}

const statusCmd = defineCommand({
  meta: { name: 'status', description: 'Show daemon status + accounts' },
  async run() { await statusListRun('status') },
})

const listCmd = defineCommand({
  meta: { name: 'list', description: 'List bound accounts' },
  async run() { await statusListRun('list') },
})

const installCmd = defineCommand({
  meta: {
    name: 'install',
    description: 'Deprecated since v1.0 — use `wechat-cc service install`',
  },
  args: {
    user: { type: 'boolean', description: 'legacy --user scope (ignored)' },
  },
  run() {
    // `wechat-cc install [--user]` was the v0.x entrypoint that wrote a
    // wechat MCP server entry into ~/.claude.json so Claude Code would
    // spawn the channel as a child MCP. v1.0+ flipped the model: the
    // daemon now drives Claude via the Agent SDK directly, so an MCP
    // entry serves no purpose. Tell the user the new path instead of
    // silently writing a broken entry.
    console.error('wechat-cc install is deprecated since v1.0.')
    console.error('Use `wechat-cc service install` to register the daemon (macOS launchd / Linux systemd / Windows ScheduledTask),')
    console.error('or open the desktop app and walk through the setup wizard.')
    process.exit(2)
  },
})

const doctorCmd = defineCommand({
  meta: { name: 'doctor', description: 'Diagnose install/setup state' },
  args: {
    json: { type: 'boolean', description: 'machine-readable output' },
  },
  run({ args }) {
    const report = analyzeDoctor(defaultDoctorDeps())
    if (args.json) console.log(JSON.stringify(report, null, 2))
    else printDoctor(report)
  },
})

const setupStatusCmd = defineCommand({
  meta: { name: 'setup-status', description: 'Machine-readable setup status for desktop UI' },
  args: {
    json: { type: 'boolean', description: 'JSON envelope (vs single-line text)' },
  },
  run({ args }) {
    const deps = defaultDoctorDeps()
    const status = setupStatus(deps)
    if (args.json) console.log(JSON.stringify(status, null, 2))
    else console.log(status.bound ? 'wechat: bound' : 'wechat: not bound')
  },
})

// ── PR4 batch 2 — read-only inspection commands ─────────────────────
//
// Same defineCommand pattern as batch 1 (status / list / etc.) but with
// nested subCommands for namespaces that have multiple verbs
// (`events list`, `observations list|archive`, etc.). Citty's `--help`
// auto-generates per-level usage so users get correct help on either
// `wechat-cc events --help` or `wechat-cc events list --help`.
//
// Each leaf does the same work the legacy switch did — preserved
// verbatim so behavior diff is zero. Only argv parsing moves.

const eventsListCmd = defineCommand({
  meta: { name: 'list', description: 'Tail Companion decisions log (push/skip/observation/milestone)' },
  args: {
    chatId: { type: 'positional', required: true, description: 'WeChat chat id', valueHint: 'chat-id' },
    limit: { type: 'string', description: 'Max events to return (default 50)' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const limitNum = args.limit ? Number.parseInt(args.limit, 10) : 50
    const limit = Number.isFinite(limitNum) ? limitNum : 50
    const { makeEventsStore } = await import('./src/daemon/events/store')
    const { openWechatDb } = await import('./src/lib/db')
    const memoryRoot = join(STATE_DIR, 'memory')
    const db = openWechatDb(STATE_DIR)
    const store = makeEventsStore(db, args.chatId, {
      migrateFromFile: join(memoryRoot, args.chatId, 'events.jsonl'),
    })
    const list = await store.list({ limit })
    console.log(args.json ? JSON.stringify({ ok: true, events: list }, null, 2) : list.map(e => `${e.ts} ${e.kind} ${e.trigger}`).join('\n'))
  },
})

const eventsCmd = defineCommand({
  meta: { name: 'events', description: 'Companion decisions log' },
  subCommands: { list: eventsListCmd },
})

const observationsListCmd = defineCommand({
  meta: { name: 'list', description: 'List observations (active by default; --include-archived for the archive)' },
  args: {
    chatId: { type: 'positional', required: true, description: 'WeChat chat id', valueHint: 'chat-id' },
    'include-archived': { type: 'boolean', description: 'Show archived items instead of active' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const includeArchived = Boolean(args['include-archived'])
    const { makeObservationsStore } = await import('./src/daemon/observations/store')
    const { openWechatDb } = await import('./src/lib/db')
    const memoryRoot = join(STATE_DIR, 'memory')
    const db = openWechatDb(STATE_DIR)
    const store = makeObservationsStore(db, args.chatId, {
      migrateFromFile: join(memoryRoot, args.chatId, 'observations.jsonl'),
    })
    const list = includeArchived ? await store.listArchived() : await store.listActive()
    console.log(args.json ? JSON.stringify({ ok: true, observations: list }, null, 2) : list.map(o => `${o.ts} ${o.body}`).join('\n'))
  },
})

const observationsArchiveCmd = defineCommand({
  meta: { name: 'archive', description: 'Mark an observation archived (user "ignore")' },
  args: {
    chatId: { type: 'positional', required: true, description: 'WeChat chat id', valueHint: 'chat-id' },
    obsId: { type: 'positional', required: true, description: 'Observation id (obs_…)', valueHint: 'obs-id' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { makeObservationsStore } = await import('./src/daemon/observations/store')
    const { openWechatDb } = await import('./src/lib/db')
    const memoryRoot = join(STATE_DIR, 'memory')
    const db = openWechatDb(STATE_DIR)
    const store = makeObservationsStore(db, args.chatId, {
      migrateFromFile: join(memoryRoot, args.chatId, 'observations.jsonl'),
    })
    await store.archive(args.obsId)
    console.log(args.json ? JSON.stringify({ ok: true, archived: args.obsId }, null, 2) : `archived ${args.obsId}`)
  },
})

const observationsCmd = defineCommand({
  meta: { name: 'observations', description: 'Companion observations (per chat)' },
  subCommands: {
    list: observationsListCmd,
    archive: observationsArchiveCmd,
  },
})

const milestonesListCmd = defineCommand({
  meta: { name: 'list', description: 'Per-chat milestones (id-deduped)' },
  args: {
    chatId: { type: 'positional', required: true, description: 'WeChat chat id', valueHint: 'chat-id' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { makeMilestonesStore } = await import('./src/daemon/milestones/store')
    const { openWechatDb } = await import('./src/lib/db')
    const memoryRoot = join(STATE_DIR, 'memory')
    const db = openWechatDb(STATE_DIR)
    const store = makeMilestonesStore(db, args.chatId, {
      migrateFromFile: join(memoryRoot, args.chatId, 'milestones.jsonl'),
    })
    const list = await store.list()
    console.log(args.json ? JSON.stringify({ ok: true, milestones: list }, null, 2) : list.map(m => `${m.ts} ${m.body}`).join('\n'))
  },
})

const milestonesCmd = defineCommand({
  meta: { name: 'milestones', description: 'Per-chat milestone fires' },
  subCommands: { list: milestonesListCmd },
})

const conversationsListCmd = defineCommand({
  meta: { name: 'list', description: 'Read-only snapshot of conversations + identities' },
  args: {
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    // Read-only snapshot of conversations. Used by the desktop dashboard
    // (P5.2) to display per-chat mode badges. PR5 Task 22: identity now
    // sources from conversationStore.getIdentity (user_names.json was
    // deprecated in Task 21); envelope grows user_id/account_id alongside
    // user_name so the dashboard table can render account/user columns.
    const { makeConversationStore } = await import('./src/core/conversation-store')
    const { openWechatDb } = await import('./src/lib/db')
    const db = openWechatDb(STATE_DIR)
    const store = makeConversationStore(db, { migrateFromFile: join(STATE_DIR, 'conversations.json') })
    const conversations = Object.entries(store.all()).map(([chat_id, rec]) => {
      const id = store.getIdentity(chat_id)
      return {
        chat_id,
        user_id: id?.user_id ?? null,
        account_id: id?.account_id ?? null,
        user_name: id?.last_user_name ?? null,
        mode: rec.mode,
      }
    })
    if (args.json) console.log(JSON.stringify({ ok: true, conversations }, null, 2))
    else console.log(conversations.map(c => `${c.chat_id} ${c.user_name ?? ''} ${c.mode.kind}`).join('\n'))
  },
})

const conversationsCmd = defineCommand({
  meta: { name: 'conversations', description: 'Per-chat conversation modes (RFC 03)' },
  subCommands: { list: conversationsListCmd },
})

const logsCmd = defineCommand({
  meta: { name: 'logs', description: "Tail the daemon's channel.log (default --tail 50)" },
  args: {
    tail: { type: 'string', description: 'Number of trailing entries (default 50)' },
    json: { type: 'boolean', description: 'JSON envelope (parsed entries)' },
  },
  async run({ args }) {
    const tailNum = args.tail ? Number.parseInt(args.tail, 10) : 50
    const tail = Number.isFinite(tailNum) ? tailNum : 50
    const { tailLog } = await import('./src/cli/logs.ts')
    const result = tailLog(STATE_DIR, tail)
    if (args.json) {
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
  },
})

// ── PR4 batch 3a — small-namespace state inspection / config commands ─
//
// 4 namespaces, 12 leaves total. All bounded: read-only or
// single-store / single-config-file writes. No daemon restart, no
// ilink, no contextToken. Same defineCommand pattern as batch 2.

const sessionsListProjectsCmd = defineCommand({
  meta: { name: 'list-projects', description: 'Project sessions with cached summaries' },
  args: {
    json: { type: 'boolean', description: 'JSON envelope' },
    'out-file': { type: 'string', description: 'Write JSON to a sibling file (avoids pipe buffer truncation in compiled binaries)' },
  },
  async run({ args }) {
    const outFile = args['out-file']
    const { makeSessionStore } = await import('./src/core/session-store')
    const { openWechatDb } = await import('./src/lib/db')
    const db = openWechatDb(STATE_DIR)
    const store = makeSessionStore(db, { migrateFromFile: join(STATE_DIR, 'sessions.json') })
    const all = store.all()
    const projects = Object.entries(all).map(([alias, rec]) => ({
      alias,
      session_id: rec.session_id,
      last_used_at: rec.last_used_at,
      summary: rec.summary ?? null,
      summary_updated_at: rec.summary_updated_at ?? null,
    }))
    if (args.json) emitJson({ ok: true, projects }, outFile)
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
            db,
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
  },
})

const sessionsReadJsonlCmd = defineCommand({
  meta: { name: 'read-jsonl', description: "Read all turns from the alias's session jsonl" },
  args: {
    alias: { type: 'positional', required: true, description: 'Session alias', valueHint: 'alias' },
    json: { type: 'boolean', description: 'JSON envelope' },
    'out-file': { type: 'string', description: 'Write JSON to a sibling file (avoids pipe buffer truncation in compiled binaries)' },
  },
  async run({ args }) {
    const outFile = args['out-file']
    const { makeSessionStore } = await import('./src/core/session-store')
    const { openWechatDb } = await import('./src/lib/db')
    const db = openWechatDb(STATE_DIR)
    const store = makeSessionStore(db, { migrateFromFile: join(STATE_DIR, 'sessions.json') })
    const rec = store.get(args.alias)
    if (!rec) {
      console.log(args.json ? JSON.stringify({ ok: false, error: 'no such alias' }, null, 2) : 'no such alias')
      return
    }
    const { resolveProjectJsonlPath } = await import('./src/daemon/sessions/path-resolver')
    const path = resolveProjectJsonlPath(args.alias, rec.session_id)
    const { existsSync, readFileSync } = await import('node:fs')
    if (!existsSync(path)) {
      console.log(args.json ? JSON.stringify({ ok: false, error: 'jsonl missing' }, null, 2) : 'jsonl missing')
      return
    }
    const lines = readFileSync(path, 'utf8').split('\n').filter(l => l.length > 0)
    const turns = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(t => t !== null)
    if (args.json) emitJson({ ok: true, alias: args.alias, session_id: rec.session_id, turns }, outFile)
    else console.log(`${turns.length} turns`)
  },
})

const sessionsDeleteCmd = defineCommand({
  meta: { name: 'delete', description: 'Remove the sessions table entry (jsonl on disk untouched)' },
  args: {
    alias: { type: 'positional', required: true, description: 'Session alias', valueHint: 'alias' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { makeSessionStore } = await import('./src/core/session-store')
    const { openWechatDb } = await import('./src/lib/db')
    const db = openWechatDb(STATE_DIR)
    const store = makeSessionStore(db, { migrateFromFile: join(STATE_DIR, 'sessions.json') })
    store.delete(args.alias)
    await store.flush()
    console.log(args.json ? JSON.stringify({ ok: true, deleted: args.alias }, null, 2) : `deleted ${args.alias}`)
  },
})

const sessionsSearchCmd = defineCommand({
  meta: { name: 'search', description: 'Naive case-insensitive substring search across all session jsonls' },
  args: {
    query: { type: 'positional', required: true, description: 'Search query', valueHint: 'query' },
    limit: { type: 'string', description: 'Max hits (default 50)' },
    json: { type: 'boolean', description: 'JSON envelope' },
    'out-file': { type: 'string', description: 'Write JSON to a sibling file' },
  },
  async run({ args }) {
    const limitNum = args.limit ? Number.parseInt(args.limit, 10) : 50
    const limit = Number.isFinite(limitNum) ? limitNum : 50
    const outFile = args['out-file']
    const { searchAcrossSessions } = await import('./src/daemon/sessions/searcher')
    const { openWechatDb } = await import('./src/lib/db')
    const db = openWechatDb(STATE_DIR)
    const hits = await searchAcrossSessions(args.query, { limit, stateDir: STATE_DIR, db })
    if (args.json) emitJson({ ok: true, query: args.query, hits }, outFile)
    else console.log(hits.map(h => `${h.alias} · ${h.snippet}`).join('\n'))
  },
})

const sessionsCmd = defineCommand({
  meta: { name: 'sessions', description: 'Per-project session inspection (resume-id store + jsonl readers)' },
  subCommands: {
    'list-projects': sessionsListProjectsCmd,
    'read-jsonl': sessionsReadJsonlCmd,
    delete: sessionsDeleteCmd,
    search: sessionsSearchCmd,
  },
})

const avatarInfoCmd = defineCommand({
  meta: { name: 'info', description: "Show stored avatar metadata for a key (chat / bot / user)" },
  args: {
    key: { type: 'positional', required: true, description: 'Avatar key', valueHint: 'key' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { avatarInfo } = await import('./src/daemon/avatar/store')
    const info = avatarInfo(STATE_DIR, args.key)
    if (args.json) console.log(JSON.stringify({ ok: true, ...info }))
    else console.log(`${args.key}: ${info.exists ? info.path : '(no avatar)'}`)
  },
})

const avatarSetCmd = defineCommand({
  meta: { name: 'set', description: 'Set avatar from base64 (PNG/JPG)' },
  args: {
    key: { type: 'positional', required: true, description: 'Avatar key', valueHint: 'key' },
    base64: { type: 'string', required: true, description: 'Base64-encoded image bytes' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { setAvatar } = await import('./src/daemon/avatar/store')
    try {
      const result = setAvatar(STATE_DIR, args.key, args.base64)
      if (args.json) console.log(JSON.stringify(result))
      else console.log(`set ${args.key} → ${result.path}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) console.log(JSON.stringify({ ok: false, error: msg }))
      else console.error(`avatar set failed: ${msg}`)
      process.exit(1)
    }
  },
})

const avatarRemoveCmd = defineCommand({
  meta: { name: 'remove', description: 'Remove stored avatar for a key' },
  args: {
    key: { type: 'positional', required: true, description: 'Avatar key', valueHint: 'key' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { removeAvatar } = await import('./src/daemon/avatar/store')
    const result = removeAvatar(STATE_DIR, args.key)
    if (args.json) console.log(JSON.stringify(result))
    else console.log(`removed ${args.key}`)
  },
})

const avatarCmd = defineCommand({
  meta: { name: 'avatar', description: 'Avatar metadata + binary set/remove (per chat / bot / user key)' },
  subCommands: {
    info: avatarInfoCmd,
    set: avatarSetCmd,
    remove: avatarRemoveCmd,
  },
})

const guardStatusCmd = defineCommand({
  meta: { name: 'status', description: "Live one-shot probe — current external IP + reachability" },
  args: {
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
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
    if (args.json) console.log(JSON.stringify(out, null, 2))
    else {
      console.log(`enabled: ${out.enabled}`)
      console.log(`ip:      ${out.ip ?? '?'}${out.ip_error ? ` (${out.ip_error})` : ''}`)
      console.log(`probe:   ${out.reachable ? 'reachable' : 'UNREACHABLE'} (${cfg.probe_url})${out.probe_error ? ` — ${out.probe_error}` : ''}`)
    }
  },
})

async function setGuardEnabled(enabled: boolean, json: boolean): Promise<void> {
  const { loadGuardConfig, saveGuardConfig } = await import('./src/daemon/guard/store')
  const cfg = loadGuardConfig(STATE_DIR)
  cfg.enabled = enabled
  saveGuardConfig(STATE_DIR, cfg)
  if (json) console.log(JSON.stringify({ ok: true, enabled: cfg.enabled }))
  else console.log(`guard: ${cfg.enabled ? 'enabled' : 'disabled'}`)
}

const guardEnableCmd = defineCommand({
  meta: { name: 'enable', description: 'Enable network-guard scheduler (next daemon start)' },
  args: { json: { type: 'boolean', description: 'JSON envelope' } },
  async run({ args }) { await setGuardEnabled(true, Boolean(args.json)) },
})

const guardDisableCmd = defineCommand({
  meta: { name: 'disable', description: 'Disable network-guard scheduler' },
  args: { json: { type: 'boolean', description: 'JSON envelope' } },
  async run({ args }) { await setGuardEnabled(false, Boolean(args.json)) },
})

const guardCmd = defineCommand({
  meta: { name: 'guard', description: 'Network-guard config + live probe' },
  subCommands: {
    status: guardStatusCmd,
    enable: guardEnableCmd,
    disable: guardDisableCmd,
  },
})

const providerShowCmd = defineCommand({
  meta: { name: 'show', description: 'Show selected agent provider' },
  args: { json: { type: 'boolean', description: 'JSON envelope' } },
  run({ args }) {
    const config = loadAgentConfig(STATE_DIR)
    if (args.json) console.log(JSON.stringify(config, null, 2))
    else console.log(`provider: ${config.provider}${config.model ? ` (${config.model})` : ''} unattended=${config.dangerouslySkipPermissions}`)
  },
})

const providerSetCmd = defineCommand({
  meta: { name: 'set', description: 'Switch agent provider (claude|codex), optionally with --model + --unattended' },
  args: {
    provider: { type: 'positional', required: true, description: 'claude | codex', valueHint: 'claude|codex' },
    model: { type: 'string', description: 'Override default model' },
    // String, not boolean: matches the legacy parseBoolFlag tri-state semantics
    // (true / false / undefined). Citty's boolean type can't represent
    // "absent" vs "explicit false", and provider-set treats omitting
    // --unattended as "don't change the existing dangerouslySkipPermissions
    // setting" — distinct from an explicit `--unattended false`.
    unattended: { type: 'string', description: 'true | false | yes | no | on | off (omit to leave unchanged)', valueHint: 'true|false' },
  },
  run({ args }) {
    if (args.provider !== 'claude' && args.provider !== 'codex') {
      console.error(`provider must be 'claude' or 'codex' (got: ${args.provider})`)
      process.exit(2)
    }
    const provider = args.provider as AgentProviderKind
    const unattended = parseBoolValue(args.unattended)
    const existing = loadAgentConfig(STATE_DIR)
    const next = {
      ...existing,
      provider,
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(unattended !== undefined ? { dangerouslySkipPermissions: unattended } : {}),
    }
    // When switching provider, drop a stale model from the previous provider
    // unless the caller explicitly set one.
    if (existing.provider !== provider && args.model === undefined) {
      delete (next as Partial<typeof next>).model
    }
    saveAgentConfig(STATE_DIR, next)
    console.log(`provider set: ${next.provider}${next.model ? ` (${next.model})` : ''} unattended=${next.dangerouslySkipPermissions}`)
  },
})

const providerCmd = defineCommand({
  meta: { name: 'provider', description: 'Agent provider config (claude / codex)' },
  subCommands: {
    show: providerShowCmd,
    set: providerSetCmd,
  },
})

/**
 * Tri-state boolean parser for citty string args that need to mirror the
 * legacy parseBoolFlag semantics: true / false / undefined. Used by
 * `provider set --unattended` (and reusable for any future flag where
 * "absent" is a distinct meaning from "explicit false").
 */
function parseBoolValue(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  if (value === 'true' || value === '1' || value === 'yes' || value === 'on') return true
  if (value === 'false' || value === '0' || value === 'no' || value === 'off') return false
  return undefined
}

// ── PR4 batch 3b — memory / account / daemon / demo ─────────────────
//
// 4 namespaces, 7 leaves total. Same shape as 3a: bounded surface,
// no daemon-restart, no ilink. memory-write decodes a base64 body
// (sandboxed: .md only, ≤100KB, traversal-safe), account-remove wipes
// a single account dir, daemon-kill signals a process by pid (with
// cmdline verification), demo seed/unseed mutate a per-chat slice
// of the SQLite db.

const memoryListCmd = defineCommand({
  meta: { name: 'list', description: 'List Companion v2 memory files (per user)' },
  args: { json: { type: 'boolean', description: 'JSON envelope' } },
  async run({ args }) {
    const { listAllMemory } = await import('./src/cli/memory.ts')
    const users = listAllMemory(STATE_DIR)
    if (args.json) console.log(JSON.stringify(users, null, 2))
    else {
      if (users.length === 0) console.log('(no memory files)')
      for (const u of users) {
        console.log(`${u.userId}  (${u.fileCount} 文件 · ${u.totalBytes} 字节)`)
        for (const f of u.files) console.log(`  - ${f.path}  (${f.size}B)`)
      }
    }
  },
})

const memoryReadCmd = defineCommand({
  meta: { name: 'read', description: 'Read one .md memory file (path is relative to the user dir, traversal-safe)' },
  args: {
    userId: { type: 'positional', required: true, description: 'User id', valueHint: 'user-id' },
    path: { type: 'positional', required: true, description: 'Path under the user memory dir', valueHint: 'path' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { readMemoryFile } = await import('./src/cli/memory.ts')
    try {
      const content = readMemoryFile(STATE_DIR, args.userId, args.path)
      if (args.json) console.log(JSON.stringify({ ok: true, userId: args.userId, path: args.path, content }, null, 2))
      else process.stdout.write(content)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // --json: emit ok:false on stdout + exit 0 so GUI callers can read
      // the structured error. Non-JSON: stderr + exit 1 (matches the
      // pattern in `update --json` and is what the GUI invoke path
      // expects — error info travels via JSON.ok=false, not exit code).
      if (args.json) {
        console.log(JSON.stringify({ ok: false, error: msg }))
        return
      }
      console.error(`memory read failed: ${msg}`)
      process.exit(1)
    }
  },
})

const memoryWriteCmd = defineCommand({
  meta: { name: 'write', description: 'Write/overwrite one .md memory file (sandboxed: .md only, ≤100KB, no traversal)' },
  args: {
    userId: { type: 'positional', required: true, description: 'User id', valueHint: 'user-id' },
    path: { type: 'positional', required: true, description: 'Path under the user memory dir', valueHint: 'path' },
    'body-base64': { type: 'string', required: true, description: 'Base64-encoded UTF-8 body (avoids shell-quote pain)' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { writeMemoryFile } = await import('./src/cli/memory.ts')
    try {
      // Body comes in via base64 to dodge shell-quoting hell on multi-line
      // markdown content (Tauri sidecar IPC passes args as a list, but
      // the underlying CLI would still see CRLF/quote/backtick sequences
      // unsafely if we tried to inline the content). Decoder + UTF-8
      // assumption matches the GUI's btoa(unescape(encodeURIComponent(body))).
      const body = Buffer.from(args['body-base64'], 'base64').toString('utf8')
      const result = writeMemoryFile(STATE_DIR, args.userId, args.path, body)
      if (args.json) console.log(JSON.stringify({ ok: true, userId: args.userId, path: args.path, ...result }, null, 2))
      else console.log(`${result.created ? 'created' : 'updated'}: ${args.userId}/${args.path} (${result.bytesWritten}B)`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) {
        console.log(JSON.stringify({ ok: false, error: msg }))
        return
      }
      console.error(`memory write failed: ${msg}`)
      process.exit(1)
    }
  },
})

const memoryCmd = defineCommand({
  meta: { name: 'memory', description: 'Companion v2 memory files (per user)' },
  subCommands: {
    list: memoryListCmd,
    read: memoryReadCmd,
    write: memoryWriteCmd,
  },
})

const accountRemoveCmd = defineCommand({
  meta: { name: 'remove', description: 'Decommission a bound bot — wipes account dir + related state. Restart daemon afterwards.' },
  args: {
    botId: { type: 'positional', required: true, description: 'Bot id', valueHint: 'bot-id' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { removeAccount } = await import('./src/cli/account-remove.ts')
    try {
      const result = removeAccount({ stateDir: STATE_DIR }, args.botId)
      if (args.json) {
        console.log(JSON.stringify({ ok: true, ...result, restartRequired: true }, null, 2))
      } else {
        console.log(`removed: ${result.botId}`)
        for (const r of result.removed) console.log(`  - ${r}`)
        for (const w of result.warnings) console.log(`  ! ${w}`)
        console.log('\nrestart daemon for the change to take effect.')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) console.log(JSON.stringify({ ok: false, error: msg }))
      else console.error(`account remove failed: ${msg}`)
      process.exit(1)
    }
  },
})

const accountCmd = defineCommand({
  meta: { name: 'account', description: 'Account management (decommission a bound bot)' },
  subCommands: { remove: accountRemoveCmd },
})

const daemonKillCmd = defineCommand({
  meta: { name: 'kill', description: 'Force-kill a daemon process by pid (verifies cmdline; SIGTERM 1.5s grace then SIGKILL)' },
  args: {
    pid: { type: 'positional', required: true, description: 'Process id (positive integer)', valueHint: 'pid' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const pid = Number.parseInt(args.pid, 10)
    if (!Number.isFinite(pid) || pid <= 0) {
      console.error(`pid must be a positive integer (got: ${args.pid})`)
      process.exit(2)
    }
    const { killDaemonByPid, defaultKillDeps } = await import('./src/cli/daemon-kill.ts')
    const result = await killDaemonByPid(defaultKillDeps(), pid)
    if (args.json) console.log(JSON.stringify(result, null, 2))
    else console.log(result.killed ? `killed pid ${result.pid}` : `failed: ${result.message}`)
    if (!result.killed) process.exit(1)
  },
})

const daemonCmd = defineCommand({
  meta: { name: 'daemon', description: 'Daemon process control' },
  subCommands: { kill: daemonKillCmd },
})

async function runDemo(verb: 'seed' | 'unseed', chatIdArg: string | undefined, json: boolean): Promise<void> {
  const { loadCompanionConfig } = await import('./src/daemon/companion/config')
  const cfg = loadCompanionConfig(STATE_DIR)
  const chatId = chatIdArg ?? cfg.default_chat_id
  if (!chatId) {
    const msg = 'no default chat configured — pass --chat-id or run setup first'
    console.error(json ? JSON.stringify({ ok: false, error: msg }, null, 2) : msg)
    process.exit(1)
  }
  const { seedDemo, unseedDemo } = await import('./src/daemon/demo/seed')
  const { openWechatDb } = await import('./src/lib/db')
  const db = openWechatDb(STATE_DIR)
  const fn = verb === 'seed' ? seedDemo : unseedDemo
  const result = await fn({ stateDir: STATE_DIR, chatId, db })
  console.log(json ? JSON.stringify({ ok: true, ...result }, null, 2) : JSON.stringify(result))
}

const demoSeedCmd = defineCommand({
  meta: { name: 'seed', description: 'Populate sample observations + milestones + events for first-impression / screenshot use' },
  args: {
    'chat-id': { type: 'string', description: 'Target chat (defaults to companion default_chat_id)' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) { await runDemo('seed', args['chat-id'], Boolean(args.json)) },
})

const demoUnseedCmd = defineCommand({
  meta: { name: 'unseed', description: 'Remove items written by `demo seed`. Idempotent.' },
  args: {
    'chat-id': { type: 'string', description: 'Target chat (defaults to companion default_chat_id)' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) { await runDemo('unseed', args['chat-id'], Boolean(args.json)) },
})

const demoCmd = defineCommand({
  meta: { name: 'demo', description: 'Seed/unseed demo data for the dashboard' },
  subCommands: {
    seed: demoSeedCmd,
    unseed: demoUnseedCmd,
  },
})

// ── PR4 batch 3c — heavy entry points ────────────────────────────────
//
// 6 commands, the rest of the legacy switch. After this batch the
// parseCliArgs function + CliArgs union can be deleted entirely; only
// the help fall-through remains, and that's served by citty's
// auto-generated root help.
//
// Notable shapes:
//   - `run` mutates process.argv before main.ts import (legacy --dangerously
//     dance preserved verbatim).
//   - `setup` either drives an interactive QR scan (imports setup.ts which
//     never returns) or returns a one-shot JSON envelope under --qr-json.
//   - `setup-poll --qrcode` is required.
//   - `service` keeps a positional action (status/install/start/stop/uninstall)
//     because all five share ~95% of the same setup; nesting into 5
//     subCommands would mean shared-helper-with-5-args. Tri-state
//     --unattended / --auto-start use parseBoolValue.
//   - `reply` has multi-word positional text — citty's positionals are
//     1-slot, so we declare none and read args._ (RawArgs._ — the
//     unconsumed positionals citty hands through). Stdin path preserved.
//   - `update --check` flips between probe + apply modes; same body
//     branches as the legacy case.

const runCmd = defineCommand({
  meta: { name: 'run', description: 'Start the daemon (foreground). --dangerously skips permission prompts.' },
  args: {
    dangerously: { type: 'boolean', description: 'Skip permission prompts (matches claude --dangerously-skip-permissions)' },
    // Legacy v0.x flags. Kept declared so citty doesn't reject them; warned
    // in run() to nudge users toward the new daemon model. Without these
    // declarations, `wechat-cc run --fresh` would error on parse.
    fresh: { type: 'boolean', description: 'Legacy v0.x flag (ignored)' },
    continue: { type: 'boolean', description: 'Legacy v0.x flag (ignored)' },
    channels: { type: 'boolean', description: 'Legacy v0.x flag (ignored)' },
    'mcp-config': { type: 'string', description: 'Legacy v0.x flag (ignored)' },
  },
  async run({ args }) {
    if (args.fresh) console.warn(`[wechat-cc] legacy flag ignored: --fresh (v1.0+ daemon doesn't spawn claude directly)`)
    if (args.continue) console.warn(`[wechat-cc] legacy flag ignored: --continue (v1.0+ daemon doesn't spawn claude directly)`)
    if (args.channels) console.warn(`[wechat-cc] legacy flag ignored: --channels (v1.0+ daemon doesn't spawn claude directly)`)
    if (args['mcp-config']) console.warn(`[wechat-cc] legacy flag ignored: --mcp-config (v1.0+ daemon doesn't spawn claude directly)`)
    // Run the daemon in-process by calling main.ts's exported main(). Used
    // to spawn `bun src/daemon/main.ts`, but that doesn't work in
    // `bun build --compile`d binaries where the source tree isn't on disk —
    // the compiled sidecar shipped inside the desktop bundle is the single
    // source of truth for both CLI and daemon. We must call main() EXPLICITLY:
    // a bare `await import(...)` won't trigger main() because import.meta.main
    // is false for any imported module under standard ESM semantics, so the
    // import-then-block pattern silently no-ops.
    if (args.dangerously && !process.argv.includes('--dangerously')) {
      process.argv.push('--dangerously')
    }
    const { main: runDaemon } = await import('./src/daemon/main.ts')
    await runDaemon()
    // main() returns after attaching signal handlers; the daemon's lifecycle
    // (HTTP server, polling intervals) keeps the event loop alive. Block here
    // so cli.ts's caller doesn't see a premature resolve.
    await new Promise(() => {})
  },
})

const setupCmd = defineCommand({
  meta: { name: 'setup', description: 'Scan QR + bind a WeChat bot' },
  args: {
    'qr-json': { type: 'boolean', description: 'Emit JSON envelope (one-shot QR fetch) instead of starting an interactive scan' },
  },
  async run({ args }) {
    if (args['qr-json']) {
      const { requestSetupQrCode } = await import('./src/cli/setup-flow.ts')
      console.log(JSON.stringify(await requestSetupQrCode(), null, 2))
      return
    }
    // Same rationale as `run`: import setup.ts directly so the compiled
    // sidecar can drive the QR flow from inside Tauri-spawned shells too.
    await import('./setup.ts')
  },
})

const setupPollCmd = defineCommand({
  meta: { name: 'setup-poll', description: 'Poll a setup-status QR code (paired with `setup --qr-json`)' },
  args: {
    qrcode: { type: 'string', required: true, description: 'QR token returned from `setup --qr-json`' },
    'base-url': { type: 'string', description: 'Override ilink base URL (defaults to setup-flow internal default)' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { pollSetupQrStatus } = await import('./src/cli/setup-flow.ts')
    const result = await pollSetupQrStatus({
      qrcode: args.qrcode,
      ...(args['base-url'] !== undefined ? { baseUrl: args['base-url'] } : {}),
      stateDir: STATE_DIR,
    })
    if (args.json) console.log(JSON.stringify(result, null, 2))
    else console.log(result.status)
  },
})

const serviceCmd = defineCommand({
  meta: {
    name: 'service',
    description: 'Daemon service management — register / start / stop / uninstall a launchd / systemd / ScheduledTask entry',
  },
  args: {
    action: {
      type: 'positional',
      required: true,
      description: 'status | install | start | stop | uninstall',
      valueHint: 'status|install|start|stop|uninstall',
    },
    json: { type: 'boolean', description: 'JSON envelope' },
    // Tri-state strings (parseBoolValue inside run): true / false / undefined.
    // Citty's boolean type can't distinguish "absent" from "explicit false",
    // and service install treats omission as "leave existing config alone".
    unattended: { type: 'string', description: 'true | false | yes | no | on | off — persist into agent-config (omit to leave unchanged)' },
    'auto-start': { type: 'string', description: 'true | false | yes | no | on | off — register for boot/login auto-start' },
  },
  async run({ args }) {
    const validActions = ['status', 'install', 'start', 'stop', 'uninstall'] as const
    type ServiceAction = typeof validActions[number]
    const action = args.action as ServiceAction
    if (!validActions.includes(action)) {
      console.error(`service action must be one of ${validActions.join(' | ')} (got: ${args.action})`)
      process.exit(2)
    }
    const unattended = parseBoolValue(args.unattended)
    const autoStart = parseBoolValue(args['auto-start'])
    // If the caller passed --unattended or --auto-start, persist them into
    // agent-config first so it's the source of truth (re-installs from the
    // GUI re-pick the same values).
    if (unattended !== undefined || autoStart !== undefined) {
      const existing = loadAgentConfig(STATE_DIR)
      saveAgentConfig(STATE_DIR, {
        ...existing,
        ...(unattended !== undefined ? { dangerouslySkipPermissions: unattended } : {}),
        ...(autoStart !== undefined ? { autoStart } : {}),
      })
    }
    const config = loadAgentConfig(STATE_DIR)
    // Compiled-bundle mode: launch the daemon via the same self-contained
    // binary (no external bun + cli.ts source). Source mode: legacy
    // `bunPath cli.ts run` ExecStart. compiledBinaryPath/compiledRepoRoot
    // both return non-null only in compiled mode — see runtime-info.ts.
    const binaryPath = compiledBinaryPath() ?? undefined
    const planCwd = compiledRepoRoot() ?? dirname(fileURLToPath(import.meta.url))
    const plan = buildServicePlan({
      cwd: planCwd,
      dangerouslySkipPermissions: config.dangerouslySkipPermissions,
      autoStart: config.autoStart,
      ...(binaryPath ? { binaryPath } : {}),
    })
    const json = Boolean(args.json)
    if (action === 'status') {
      const status = serviceStatus(defaultDoctorDeps())
      if (json) console.log(JSON.stringify({ ...status, plan, agentConfig: config }, null, 2))
      else console.log(`service: ${status.state}${status.installed ? ' [installed]' : ''}${status.pid ? ` pid=${status.pid}` : ''}`)
      return
    }
    // WECHAT_CC_DRY_RUN=1 makes install/uninstall/start/stop a no-op (still
    // returns the plan in JSON). Used by the apps/desktop e2e shim so tests
    // exercise real cli.ts without touching ~/Library/LaunchAgents/launchd.
    const dryRun = process.env.WECHAT_CC_DRY_RUN === '1'
    const sideOpts = { dryRun }
    if (action === 'install') {
      // Idempotent: best-effort tear down any previous install so we can
      // re-write the plist (e.g. unattended toggle changed). Swallow errors
      // — a partial/stale state (plist missing, launchd doesn't have it)
      // would otherwise block the fresh install.
      try { uninstallService(plan, sideOpts) } catch { /* tolerate */ }
      // Wire onProgress → install-progress.json so the GUI wizard can poll
      // real step state ("(2/4) systemctl daemon-reload") instead of showing
      // an opaque "安装中…" forever. Cleared at start + end so a stale file
      // from a previous crashed install doesn't haunt the next one.
      const progressPath = join(STATE_DIR, 'install-progress.json')
      try { rmSync(progressPath, { force: true }) } catch { /* tolerate */ }
      installService(plan, {
        ...sideOpts,
        onProgress: (e) => {
          try {
            mkdirSync(STATE_DIR, { recursive: true })
            writeFileSync(progressPath, JSON.stringify({ ...e, ts: Date.now() }))
          } catch { /* progress is best-effort — never break install */ }
        },
      })
      try { rmSync(progressPath, { force: true }) } catch { /* tolerate */ }
    } else if (action === 'start') startService(plan, sideOpts)
    else if (action === 'stop') stopService(plan, sideOpts)
    else if (action === 'uninstall') uninstallService(plan, sideOpts)
    const out = { ok: true, action, plan, agentConfig: config, dryRun }
    if (json) console.log(JSON.stringify(out, null, 2))
    else console.log(`service ${action}: ok${dryRun ? ' (dry-run)' : ''}`)
  },
})

const installProgressCmd = defineCommand({
  meta: {
    name: 'install-progress',
    description: 'Read the current service-install progress (JSON: {step, total, label, ts}). Used by the desktop wizard to poll real install state instead of guessing. Empty {} when no install is in flight.',
  },
  args: {
    json: { type: 'boolean', description: 'JSON envelope (default; flag is for symmetry with other commands)' },
  },
  async run() {
    const { existsSync, readFileSync } = await import('node:fs')
    const progressPath = join(STATE_DIR, 'install-progress.json')
    if (!existsSync(progressPath)) {
      console.log('{}')
      return
    }
    try {
      const raw = readFileSync(progressPath, 'utf8')
      console.log(raw.trim() || '{}')
    } catch {
      console.log('{}')
    }
  },
})

const replyCmd = defineCommand({
  meta: {
    name: 'reply',
    description: 'Send a text reply via WeChat (CLI fallback for the MCP `reply` tool — same on-disk state as the running daemon)',
  },
  args: {
    to: { type: 'string', description: 'Target chat id (omit → most-recently-active chat)' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    // text comes from positional args (citty surfaces unconsumed positionals
    // via RawArgs._). Joining with ' ' matches the legacy parser, which
    // accumulated all non-flag tokens. Empty → fall through to stdin.
    const positional = (args._ ?? []) as string[]
    const inlineText = positional.length > 0 ? positional.join(' ') : undefined
    // CLI fallback for the MCP `reply` tool — same code path as the
    // daemon (sendReplyOnce reads state from disk), so recipient
    // resolution + session continuity are identical whether the
    // daemon is running or not.
    const { sendReplyOnce, defaultTerminalChatId } = await import('./src/lib/send-reply.ts')
    const json = Boolean(args.json)
    const emitFailure = (error: string): void => {
      if (json) console.log(JSON.stringify({ ok: false, error }))
      else console.error(`reply failed: ${error}`)
      process.exit(1)
    }
    const chatId = args.to ?? defaultTerminalChatId() ?? undefined
    if (!chatId) {
      emitFailure('no chat resolved — pass --to <chat_id> or send a WeChat message first so the daemon records one')
      return
    }
    const text = inlineText ?? (await readStdin()).trim()
    if (!text) {
      emitFailure('no text — pass it as an argument or pipe it on stdin')
      return
    }
    const result = await sendReplyOnce(chatId, text)
    if (!result.ok) {
      emitFailure(result.error)
      return
    }
    if (json) {
      console.log(JSON.stringify({ ok: true, chat_id: chatId, chunks: result.chunks, account: result.account }))
    } else {
      console.log(`Sent: ${result.chunks} chunk(s) via account ${result.account} → ${chatId}`)
    }
  },
})

const updateCmd = defineCommand({
  meta: {
    name: 'update',
    description: 'Pull latest + reinstall deps + restart service. --check probes only (no side effects).',
  },
  args: {
    check: { type: 'boolean', description: 'Probe only — no side effects' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const check = Boolean(args.check)
    const json = Boolean(args.json)
    const { analyzeUpdate, applyUpdate, defaultUpdateDeps } = await import('./src/cli/update.ts')
    // Compiled-bundle short-circuit: when the binary is shipped inside a
    // desktop .app/.exe, there is no git repo nearby. Surface this with a
    // dedicated `not_a_git_repo` reason instead of bubbling up an empty-
    // stderr fetch_failed (which the GUI couldn't tell from a real outage).
    const { existsSync } = await import('node:fs')
    const here = dirname(fileURLToPath(import.meta.url))
    const repoRoot = compiledRepoRoot() ?? here
    const hasGitRepo = existsSync(join(repoRoot, '.git'))
    if (!hasGitRepo) {
      const synthetic = {
        ok: false as const,
        mode: check ? ('check' as const) : ('apply' as const),
        reason: 'not_a_git_repo' as const,
        message: 'no git repo at this binary\'s location; in-place updates are not available for desktop bundles (download a newer version from GitHub Releases instead)',
        details: { repoRoot },
      }
      if (json) console.log(JSON.stringify(synthetic, null, 2))
      else console.error(`update: not_a_git_repo — ${synthetic.message}`)
      if (!json) process.exit(1)
      return
    }
    const deps = defaultUpdateDeps(repoRoot, STATE_DIR)
    if (check) {
      const probe = analyzeUpdate(deps)
      if (json) {
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
    if (json) {
      console.log(JSON.stringify(result, null, 2))
    } else if (!result.ok) {
      console.error(`update failed: ${result.reason} — ${result.message}`)
      process.exit(1)
    } else {
      const lockNote = result.lockfileChanged ? ', deps reinstalled' : ''
      console.log(`updated: ${result.fromCommit} → ${result.toCommit}${lockNote}, daemon=${result.daemonAction} (${result.elapsedMs}ms)`)
    }
  },
})

// ── mode set — programmatic mode switch via running daemon's internal-api ──
//
// Reads STATE_DIR/internal-api-info.json (written by daemon on start) to
// discover the bound port + token file. Posts to /v1/conversation/set-mode.
// On error (daemon not running, 401, 5xx): clear error message + exit 1.

const modeSetCmd = defineCommand({
  meta: { name: 'set', description: 'Set chat mode programmatically (calls running daemon via internal-api)' },
  args: {
    chatId: { type: 'positional', required: true, description: 'WeChat chat id', valueHint: 'chat-id' },
    mode: {
      type: 'positional',
      required: true,
      description: 'cc|codex|solo|both|chat (or full JSON mode shape)',
      valueHint: 'cc|codex|solo|both|chat|json',
    },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { existsSync, readFileSync } = await import('node:fs')
    const infoPath = join(STATE_DIR, 'internal-api-info.json')
    const jsonOut = Boolean(args.json)

    const emitError = (msg: string): never => {
      if (jsonOut) console.log(JSON.stringify({ ok: false, error: msg }))
      else console.error(`mode set: ${msg}`)
      process.exit(1)
    }

    if (!existsSync(infoPath)) {
      emitError('daemon not running (internal-api-info.json not found — start the daemon first)')
    }

    let info: { baseUrl: string; tokenFilePath: string }
    try {
      info = JSON.parse(readFileSync(infoPath, 'utf8'))
    } catch (err) {
      emitError(`could not read internal-api-info.json: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!info!.baseUrl || !info!.tokenFilePath) {
      emitError('internal-api-info.json is malformed (missing baseUrl or tokenFilePath)')
    }

    let tokenHex: string
    try {
      tokenHex = readFileSync(info!.tokenFilePath, 'utf8').trim()
    } catch (err) {
      emitError(`could not read token file: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Map shorthands to full Mode shapes (matches mode-commands.ts semantics)
    const SHORTHAND: Record<string, object> = {
      cc:    { kind: 'solo', provider: 'claude' },
      codex: { kind: 'solo', provider: 'codex' },
      solo:  { kind: 'solo', provider: 'claude' },
      both:  { kind: 'parallel' },
      chat:  { kind: 'chatroom' },
    }

    let modeObj: object
    const raw = args.mode
    if (SHORTHAND[raw]) {
      modeObj = SHORTHAND[raw]!
    } else {
      try {
        modeObj = JSON.parse(raw)
        if (typeof modeObj !== 'object' || modeObj === null) throw new Error('must be a JSON object')
      } catch (err) {
        emitError(`unrecognised mode '${raw}' — use cc/codex/solo/both/chat or a JSON mode shape: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    let resp: Response
    try {
      resp = await fetch(`${info!.baseUrl}/v1/conversation/set-mode`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${tokenHex!}`,
        },
        body: JSON.stringify({ chatId: args.chatId, mode: modeObj! }),
      })
    } catch (err) {
      emitError(`could not reach daemon (${info!.baseUrl}): ${err instanceof Error ? err.message : String(err)}`)
    }

    if (!resp!.ok) {
      const text = await resp!.text().catch(() => '')
      if (resp!.status === 401) emitError('unauthorized — token mismatch (restart the daemon?)')
      emitError(`daemon returned ${resp!.status}: ${text}`)
    }

    const result = await resp!.json() as Record<string, unknown>
    if (jsonOut) console.log(JSON.stringify(result, null, 2))
    else console.log(`mode set: ok (chat=${args.chatId} mode=${JSON.stringify(modeObj!)})`)
  },
})

const modeCmd = defineCommand({
  meta: { name: 'mode', description: 'Conversation mode management (programmatic switch via running daemon)' },
  subCommands: { set: modeSetCmd },
})

// Subcommands literal first → both `cittyRoot.subCommands` and
// `MIGRATED_COMMANDS` derive from this single source of truth. Adding a new
// citty subcommand only requires touching this object — the dispatch set
// updates itself, and there's no `cittyRoot.subCommands as Record<string,
// unknown>` cast needed (which would have hidden a future Resolvable<>
// refactor — citty's type allows lazy / promise forms — from typecheck).
const SUBCOMMANDS = {
  status: statusCmd,
  list: listCmd,
  install: installCmd,
  doctor: doctorCmd,
  'setup-status': setupStatusCmd,
  // PR4 batch 2 — read-only inspection commands.
  events: eventsCmd,
  observations: observationsCmd,
  milestones: milestonesCmd,
  conversations: conversationsCmd,
  logs: logsCmd,
  // PR4 batch 3a — sessions / avatar / guard / provider namespaces.
  sessions: sessionsCmd,
  avatar: avatarCmd,
  guard: guardCmd,
  provider: providerCmd,
  // PR4 batch 3b — memory / account / daemon / demo namespaces.
  memory: memoryCmd,
  account: accountCmd,
  daemon: daemonCmd,
  demo: demoCmd,
  // PR4 batch 3c — heavy entry points. Completes the migration; legacy
  // parseCliArgs + CliArgs union are deleted in this commit.
  run: runCmd,
  setup: setupCmd,
  'setup-poll': setupPollCmd,
  service: serviceCmd,
  reply: replyCmd,
  update: updateCmd,
  'install-progress': installProgressCmd,
  mode: modeCmd,
} as const

export const cittyRoot = defineCommand({
  meta: {
    name: 'wechat-cc',
    description: 'WeChat bridge for Claude Code (Agent SDK daemon)',
  },
  subCommands: SUBCOMMANDS,
})


async function main() {
  const argv = process.argv.slice(2)
  const first = argv[0]
  // Bare `wechat-cc` / `--help` / `-h` / `help` → top-level long-form help.
  // citty's auto-generated root help just lists subcommands; HELP_TEXT
  // carries the back-story (RFC pointers, deprecation notes, --dangerously
  // semantics) that we don't want to lose.
  //
  // `wechat-cc <subcommand> --help` still hits citty per-subcommand help
  // because runMain consumes it before any of our run() handlers fire.
  if (!first || first === '--help' || first === '-h' || first === 'help') {
    console.log(HELP_TEXT)
    return
  }
  // runMain (vs runCommand) gives us auto `--help` / `-h` handling per
  // subcommand and prints citty's auto-generated usage on unknown commands.
  await runMain(cittyRoot, { rawArgs: argv })
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
