import { describe, it, expect } from 'vitest'
import { runCommand } from 'citty'
import { cittyRoot } from './cli'

// PR4 batch 3c removed parseCliArgs — every subcommand now flows through
// citty. The legacy describe('parseCliArgs') block + per-subcommand parse
// tests are replaced by citty-routed tests in the `citty migrated commands`
// describe below.

// demo seed/unseed parseCliArgs tests removed in PR4 batch 3b — see
// the `citty migrated commands` block below.

describe('citty migrated commands', () => {
  // Citty-migrated subcommands. Asserted via a stub `run` override (citty
  // calls subCommand.run with parsed args) so the tests verify argument
  // parsing without invoking real handlers (which would touch
  // ~/.claude/channels/wechat state and the doctor probe matrix).
  type Captured = { args: Record<string, unknown> } | null

  async function runWithStub(rawArgs: string[], subName: string): Promise<Captured> {
    const subs = cittyRoot.subCommands as Record<string, { run?: unknown }>
    const original = subs[subName]
    if (!original || typeof original !== 'object') throw new Error(`no subcommand ${subName}`)
    let captured: Captured = null
    const stub = { ...original, run: (ctx: { args: Record<string, unknown> }) => { captured = { args: ctx.args } } }
    subs[subName] = stub
    try {
      await runCommand(cittyRoot, { rawArgs })
    } finally {
      subs[subName] = original
    }
    return captured
  }

  /** Stub a leaf inside a nested subcommand path (e.g. ['events', 'list']). */
  async function runWithNestedStub(rawArgs: string[], path: [string, string]): Promise<Captured> {
    const [parentName, leafName] = path
    const subs = cittyRoot.subCommands as Record<string, { subCommands?: Record<string, { run?: unknown }> }>
    const parent = subs[parentName]
    if (!parent?.subCommands) throw new Error(`no parent subcommand ${parentName}`)
    const original = parent.subCommands[leafName]
    if (!original || typeof original !== 'object') throw new Error(`no leaf ${parentName}.${leafName}`)
    let captured: Captured = null
    const stub = { ...original, run: (ctx: { args: Record<string, unknown> }) => { captured = { args: ctx.args } } }
    parent.subCommands[leafName] = stub
    try {
      await runCommand(cittyRoot, { rawArgs })
    } finally {
      parent.subCommands[leafName] = original
    }
    return captured
  }

  it('exposes the full migrated subcommand surface (batches 1 through 3c)', () => {
    const subs = cittyRoot.subCommands as Record<string, unknown>
    expect(Object.keys(subs).sort()).toEqual([
      'account',
      'avatar',
      'conversations',
      'daemon',
      'demo',
      'doctor',
      'events',
      'guard',
      'install',
      'install-progress',
      'list',
      'logs',
      'mcp-server',
      'memory',
      'milestones',
      'mode',
      'observations',
      'provider',
      'reply',
      'run',
      'service',
      'sessions',
      'setup',
      'setup-poll',
      'setup-status',
      'status',
      'update',
    ])
  })

  it('doctor accepts --json', async () => {
    const r = await runWithStub(['doctor', '--json'], 'doctor')
    expect(r?.args.json).toBe(true)
  })

  it('doctor without --json defaults to false-y', async () => {
    const r = await runWithStub(['doctor'], 'doctor')
    expect(r?.args.json).toBeFalsy()
  })

  it('setup-status accepts --json', async () => {
    const r = await runWithStub(['setup-status', '--json'], 'setup-status')
    expect(r?.args.json).toBe(true)
  })

  it('status / list parse with no extra args', async () => {
    expect(await runWithStub(['status'], 'status')).not.toBeNull()
    expect(await runWithStub(['list'], 'list')).not.toBeNull()
  })

  it('install accepts legacy --user flag (for backward arg compat)', async () => {
    const r = await runWithStub(['install', '--user'], 'install')
    expect(r?.args.user).toBe(true)
  })

  // ── PR4 batch 2 — read-only inspection commands ─────────────────────

  it('events list parses chat-id positional + --json + --limit', async () => {
    const r = await runWithNestedStub(
      ['events', 'list', 'chat_x', '--json', '--limit', '20'],
      ['events', 'list'],
    )
    expect(r?.args.chatId).toBe('chat_x')
    expect(r?.args.json).toBe(true)
    expect(r?.args.limit).toBe('20')
  })

  it('observations list parses chat-id + --include-archived', async () => {
    const r = await runWithNestedStub(
      ['observations', 'list', 'chat_x', '--include-archived'],
      ['observations', 'list'],
    )
    expect(r?.args.chatId).toBe('chat_x')
    expect(r?.args['include-archived']).toBe(true)
  })

  it('observations archive parses chat-id + obs-id', async () => {
    const r = await runWithNestedStub(
      ['observations', 'archive', 'chat_x', 'obs_abc', '--json'],
      ['observations', 'archive'],
    )
    expect(r?.args.chatId).toBe('chat_x')
    expect(r?.args.obsId).toBe('obs_abc')
    expect(r?.args.json).toBe(true)
  })

  it('milestones list parses chat-id', async () => {
    const r = await runWithNestedStub(
      ['milestones', 'list', 'chat_x', '--json'],
      ['milestones', 'list'],
    )
    expect(r?.args.chatId).toBe('chat_x')
    expect(r?.args.json).toBe(true)
  })

  it('conversations list parses --json', async () => {
    const r = await runWithNestedStub(
      ['conversations', 'list', '--json'],
      ['conversations', 'list'],
    )
    expect(r?.args.json).toBe(true)
  })

  it('logs accepts --tail + --json', async () => {
    const r = await runWithStub(['logs', '--tail', '20', '--json'], 'logs')
    expect(r?.args.tail).toBe('20')
    expect(r?.args.json).toBe(true)
  })

  it('logs without flags uses defaults', async () => {
    const r = await runWithStub(['logs'], 'logs')
    expect(r?.args.tail).toBeFalsy()
    expect(r?.args.json).toBeFalsy()
  })

  // ── PR4 batch 3a — sessions / avatar / guard / provider ─────────────

  it('sessions list-projects parses --json + --out-file', async () => {
    const r = await runWithNestedStub(
      ['sessions', 'list-projects', '--json', '--out-file', '/tmp/x.json'],
      ['sessions', 'list-projects'],
    )
    expect(r?.args.json).toBe(true)
    expect(r?.args['out-file']).toBe('/tmp/x.json')
  })

  it('sessions read-jsonl parses alias positional + --out-file', async () => {
    const r = await runWithNestedStub(
      ['sessions', 'read-jsonl', 'compass', '--json', '--out-file', '/tmp/x.json'],
      ['sessions', 'read-jsonl'],
    )
    expect(r?.args.alias).toBe('compass')
    expect(r?.args.json).toBe(true)
    expect(r?.args['out-file']).toBe('/tmp/x.json')
  })

  it('sessions delete parses alias positional', async () => {
    const r = await runWithNestedStub(
      ['sessions', 'delete', 'compass', '--json'],
      ['sessions', 'delete'],
    )
    expect(r?.args.alias).toBe('compass')
    expect(r?.args.json).toBe(true)
  })

  it('sessions search parses query + --limit', async () => {
    const r = await runWithNestedStub(
      ['sessions', 'search', 'ilink', '--limit', '20', '--json'],
      ['sessions', 'search'],
    )
    expect(r?.args.query).toBe('ilink')
    expect(r?.args.limit).toBe('20')
    expect(r?.args.json).toBe(true)
  })

  it('avatar info parses key positional', async () => {
    const r = await runWithNestedStub(
      ['avatar', 'info', 'chat_x', '--json'],
      ['avatar', 'info'],
    )
    expect(r?.args.key).toBe('chat_x')
    expect(r?.args.json).toBe(true)
  })

  it('avatar set parses key + required --base64', async () => {
    const r = await runWithNestedStub(
      ['avatar', 'set', 'chat_x', '--base64', 'eA=='],
      ['avatar', 'set'],
    )
    expect(r?.args.key).toBe('chat_x')
    expect(r?.args.base64).toBe('eA==')
  })

  it('avatar remove parses key positional', async () => {
    const r = await runWithNestedStub(
      ['avatar', 'remove', 'chat_x', '--json'],
      ['avatar', 'remove'],
    )
    expect(r?.args.key).toBe('chat_x')
    expect(r?.args.json).toBe(true)
  })

  it('guard status / enable / disable parse with --json', async () => {
    expect(await runWithNestedStub(['guard', 'status', '--json'], ['guard', 'status'])).not.toBeNull()
    expect(await runWithNestedStub(['guard', 'enable'], ['guard', 'enable'])).not.toBeNull()
    expect(await runWithNestedStub(['guard', 'disable', '--json'], ['guard', 'disable'])).not.toBeNull()
  })

  it('provider show parses --json', async () => {
    const r = await runWithNestedStub(['provider', 'show', '--json'], ['provider', 'show'])
    expect(r?.args.json).toBe(true)
  })

  it('provider set parses positional + --model + tri-state --unattended', async () => {
    const r = await runWithNestedStub(
      ['provider', 'set', 'codex', '--model', 'gpt-5.3-codex', '--unattended', 'true'],
      ['provider', 'set'],
    )
    expect(r?.args.provider).toBe('codex')
    expect(r?.args.model).toBe('gpt-5.3-codex')
    expect(r?.args.unattended).toBe('true')  // string, parsed to bool inside the run handler
  })

  // ── PR4 batch 3b — memory / account / daemon / demo ─────────────────

  it('memory list parses --json', async () => {
    const r = await runWithNestedStub(['memory', 'list', '--json'], ['memory', 'list'])
    expect(r?.args.json).toBe(true)
  })

  it('memory read parses user-id + path positionals', async () => {
    const r = await runWithNestedStub(
      ['memory', 'read', 'u@x', 'profile.md', '--json'],
      ['memory', 'read'],
    )
    expect(r?.args.userId).toBe('u@x')
    expect(r?.args.path).toBe('profile.md')
    expect(r?.args.json).toBe(true)
  })

  it('memory write parses positionals + required --body-base64', async () => {
    const r = await runWithNestedStub(
      ['memory', 'write', 'u@x', 'profile.md', '--body-base64', 'IyBoaQ==', '--json'],
      ['memory', 'write'],
    )
    expect(r?.args.userId).toBe('u@x')
    expect(r?.args.path).toBe('profile.md')
    expect(r?.args['body-base64']).toBe('IyBoaQ==')
    expect(r?.args.json).toBe(true)
  })

  it('account remove parses bot-id positional', async () => {
    const r = await runWithNestedStub(
      ['account', 'remove', 'abc-im-bot', '--json'],
      ['account', 'remove'],
    )
    expect(r?.args.botId).toBe('abc-im-bot')
    expect(r?.args.json).toBe(true)
  })

  it('daemon kill parses pid positional (string; coerced inside run)', async () => {
    const r = await runWithNestedStub(
      ['daemon', 'kill', '12345', '--json'],
      ['daemon', 'kill'],
    )
    expect(r?.args.pid).toBe('12345')
    expect(r?.args.json).toBe(true)
  })

  it('demo seed parses --chat-id', async () => {
    const r = await runWithNestedStub(
      ['demo', 'seed', '--chat-id', 'chat_x', '--json'],
      ['demo', 'seed'],
    )
    expect(r?.args['chat-id']).toBe('chat_x')
    expect(r?.args.json).toBe(true)
  })

  it('demo seed without --chat-id (handler resolves default)', async () => {
    const r = await runWithNestedStub(['demo', 'seed'], ['demo', 'seed'])
    expect(r?.args['chat-id']).toBeFalsy()
  })

  it('demo unseed parses --json', async () => {
    const r = await runWithNestedStub(['demo', 'unseed', '--json'], ['demo', 'unseed'])
    expect(r?.args.json).toBe(true)
  })

  // ── PR4 batch 3c — heavy entry points ───────────────────────────────

  it('run accepts --dangerously', async () => {
    const r = await runWithStub(['run', '--dangerously'], 'run')
    expect(r?.args.dangerously).toBe(true)
  })

  it('run defaults --dangerously to falsy', async () => {
    const r = await runWithStub(['run'], 'run')
    expect(r?.args.dangerously).toBeFalsy()
  })

  it('run accepts legacy v0.x flags (--fresh, --mcp-config) without rejecting', async () => {
    // The actual `console.warn` calls happen inside the real `run` handler
    // before it imports main.ts. With the handler stubbed for arg-capture
    // we can't observe the warnings here — but verifying citty parses the
    // flags (instead of erroring on unknown args) is what this test
    // protects: regression would surface as a citty parse error which
    // runWithStub would propagate as a test failure.
    const r = await runWithStub(['run', '--fresh', '--mcp-config', 'x'], 'run')
    expect(r?.args.fresh).toBe(true)
    expect(r?.args['mcp-config']).toBe('x')
  })

  it('setup accepts --qr-json', async () => {
    const r = await runWithStub(['setup', '--qr-json'], 'setup')
    expect(r?.args['qr-json']).toBe(true)
  })

  it('setup without flags', async () => {
    const r = await runWithStub(['setup'], 'setup')
    expect(r?.args['qr-json']).toBeFalsy()
  })

  it('setup-poll parses required --qrcode + optional --base-url + --json', async () => {
    const r = await runWithStub(
      ['setup-poll', '--qrcode', 'qr-token', '--base-url', 'https://next', '--json'],
      'setup-poll',
    )
    expect(r?.args.qrcode).toBe('qr-token')
    expect(r?.args['base-url']).toBe('https://next')
    expect(r?.args.json).toBe(true)
  })

  it('service parses positional action + --json + tri-state flags', async () => {
    const r = await runWithStub(
      ['service', 'install', '--json', '--unattended', 'true', '--auto-start', 'false'],
      'service',
    )
    expect(r?.args.action).toBe('install')
    expect(r?.args.json).toBe(true)
    expect(r?.args.unattended).toBe('true')  // string; coerced inside run
    expect(r?.args['auto-start']).toBe('false')
  })

  it('service status with no flags', async () => {
    const r = await runWithStub(['service', 'status'], 'service')
    expect(r?.args.action).toBe('status')
  })

  it('reply with single positional text lands in args._', async () => {
    const r = await runWithStub(['reply', 'hello'], 'reply')
    expect(r?.args._).toEqual(['hello'])
  })

  it('reply with --to and multi-word text', async () => {
    const r = await runWithStub(
      ['reply', '--to', 'u@chat', 'hello', 'world'],
      'reply',
    )
    expect(r?.args.to).toBe('u@chat')
    expect(r?.args._).toEqual(['hello', 'world'])
  })

  it('reply with --json and no text (stdin path)', async () => {
    const r = await runWithStub(['reply', '--json'], 'reply')
    expect(r?.args.json).toBe(true)
    expect(r?.args._ ?? []).toEqual([])
  })

  it('update parses --check + --json', async () => {
    const checkOnly = await runWithStub(['update', '--check'], 'update')
    expect(checkOnly?.args.check).toBe(true)
    expect(checkOnly?.args.json).toBeFalsy()
    const both = await runWithStub(['update', '--check', '--json'], 'update')
    expect(both?.args.check).toBe(true)
    expect(both?.args.json).toBe(true)
  })

  it('update default (no flags)', async () => {
    const r = await runWithStub(['update'], 'update')
    expect(r?.args.check).toBeFalsy()
    expect(r?.args.json).toBeFalsy()
  })
})
