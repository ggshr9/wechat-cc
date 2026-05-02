import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runCommand } from 'citty'
import { parseCliArgs, cittyRoot } from './cli'

describe('parseCliArgs', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('recognizes run subcommand', () => {
    expect(parseCliArgs(['run'])).toEqual({ cmd: 'run', dangerouslySkipPermissions: false })
  })
  it('recognizes setup subcommand', () => {
    expect(parseCliArgs(['setup'])).toEqual({ cmd: 'setup' })
    expect(parseCliArgs(['setup', '--qr-json'])).toEqual({ cmd: 'setup', qrJson: true })
    expect(parseCliArgs(['setup-poll', '--qrcode', 'qr-token', '--base-url', 'https://next', '--json'])).toEqual({
      cmd: 'setup-poll',
      qrcode: 'qr-token',
      baseUrl: 'https://next',
      json: true,
    })
  })
  // The following subcommands moved to citty and no longer flow through
  // parseCliArgs at all:
  //   PR4 batch 1: status / list / install / doctor / setup-status
  //   PR4 batch 2: events / observations / milestones / conversations / logs
  // Their parser-only behavior is covered by the `citty migrated commands`
  // describe block below; legacy parseCliArgs tests for them would fall
  // through to `{ cmd: 'help' }` and weren't testing the real entrypoint.
  it('recognizes service / help (provider moved to citty in batch 3a)', () => {
    expect(parseCliArgs(['service', 'status', '--json'])).toEqual({ cmd: 'service', action: 'status', json: true, unattended: undefined, autoStart: undefined })
    expect(parseCliArgs(['service', 'install', '--json'])).toEqual({ cmd: 'service', action: 'install', json: true, unattended: undefined, autoStart: undefined })
    expect(parseCliArgs(['service', 'start'])).toEqual({ cmd: 'service', action: 'start', json: false, unattended: undefined, autoStart: undefined })
    expect(parseCliArgs(['service', 'stop'])).toEqual({ cmd: 'service', action: 'stop', json: false, unattended: undefined, autoStart: undefined })
    expect(parseCliArgs(['service', 'uninstall', '--json'])).toEqual({ cmd: 'service', action: 'uninstall', json: true, unattended: undefined, autoStart: undefined })
    expect(parseCliArgs(['service', 'install', '--unattended', 'true', '--auto-start', 'true']))
      .toMatchObject({ cmd: 'service', action: 'install', unattended: true, autoStart: true })
    expect(parseCliArgs(['service', 'install', '--auto-start', 'false']))
      .toMatchObject({ cmd: 'service', action: 'install', autoStart: false })
    expect(parseCliArgs(['--help']).cmd).toBe('help')
    expect(parseCliArgs(['-h']).cmd).toBe('help')
    expect(parseCliArgs([]).cmd).toBe('help')
  })
  it('unknown subcommand returns help', () => {
    expect(parseCliArgs(['whatever']).cmd).toBe('help')
  })
  it('parses account remove <bot-id> [--json]', () => {
    expect(parseCliArgs(['account', 'remove', 'abc-im-bot'])).toEqual({
      cmd: 'account-remove', botId: 'abc-im-bot', json: false,
    })
    expect(parseCliArgs(['account', 'remove', 'abc-im-bot', '--json'])).toEqual({
      cmd: 'account-remove', botId: 'abc-im-bot', json: true,
    })
  })
  it('account without remove falls through to help', () => {
    expect(parseCliArgs(['account']).cmd).toBe('help')
    expect(parseCliArgs(['account', 'remove']).cmd).toBe('help')
  })
  it('parses daemon kill <pid> [--json]', () => {
    expect(parseCliArgs(['daemon', 'kill', '12345'])).toEqual({
      cmd: 'daemon-kill', pid: 12345, json: false,
    })
    expect(parseCliArgs(['daemon', 'kill', '12345', '--json'])).toEqual({
      cmd: 'daemon-kill', pid: 12345, json: true,
    })
  })
  it('daemon kill rejects non-numeric or missing pid', () => {
    expect(parseCliArgs(['daemon']).cmd).toBe('help')
    expect(parseCliArgs(['daemon', 'kill']).cmd).toBe('help')
    expect(parseCliArgs(['daemon', 'kill', 'abc']).cmd).toBe('help')
    expect(parseCliArgs(['daemon', 'kill', '0']).cmd).toBe('help')
  })
  it('parses memory list / read subcommands', () => {
    expect(parseCliArgs(['memory', 'list', '--json'])).toEqual({ cmd: 'memory-list', json: true })
    expect(parseCliArgs(['memory', 'read', 'u@x', 'profile.md'])).toEqual({
      cmd: 'memory-read', userId: 'u@x', path: 'profile.md', json: false,
    })
    expect(parseCliArgs(['memory']).cmd).toBe('help')
    expect(parseCliArgs(['memory', 'read']).cmd).toBe('help')
    expect(parseCliArgs(['memory', 'read', 'u@x']).cmd).toBe('help')
  })
  it('parses memory write <user> <path> --body-base64 <b64> [--json]', () => {
    expect(parseCliArgs(['memory', 'write', 'u@x', 'profile.md', '--body-base64', 'IyBoaQ=='])).toEqual({
      cmd: 'memory-write', userId: 'u@x', path: 'profile.md', bodyBase64: 'IyBoaQ==', json: false,
    })
    expect(parseCliArgs(['memory', 'write', 'u@x', 'sub/note.md', '--body-base64', 'eA==', '--json'])).toEqual({
      cmd: 'memory-write', userId: 'u@x', path: 'sub/note.md', bodyBase64: 'eA==', json: true,
    })
  })
  it('memory write rejects malformed args', () => {
    expect(parseCliArgs(['memory', 'write', 'u@x', 'profile.md']).cmd).toBe('help')
    expect(parseCliArgs(['memory', 'write', 'u@x', 'profile.md', '--body-base64']).cmd).toBe('help')
    expect(parseCliArgs(['memory', 'write', 'u@x']).cmd).toBe('help')
    expect(parseCliArgs(['memory', 'write']).cmd).toBe('help')
  })
  it('accepts --dangerously on run subcommand', () => {
    expect(parseCliArgs(['run', '--dangerously'])).toEqual({
      cmd: 'run',
      dangerouslySkipPermissions: true
    })
  })

  it('run without --dangerously defaults dangerouslySkipPermissions to false', () => {
    expect(parseCliArgs(['run'])).toEqual({
      cmd: 'run',
      dangerouslySkipPermissions: false
    })
  })

  it('still warns on other legacy flags', () => {
    const warn = vi.fn()
    parseCliArgs(['run', '--fresh', '--mcp-config=x'], { warn })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('--fresh'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('--mcp-config'))
  })

  it('parses update / update --check / update --json / update --check --json', () => {
    expect(parseCliArgs(['update'])).toEqual({ cmd: 'update', check: false, json: false })
    expect(parseCliArgs(['update', '--json'])).toEqual({ cmd: 'update', check: false, json: true })
    expect(parseCliArgs(['update', '--check'])).toEqual({ cmd: 'update', check: true, json: false })
    expect(parseCliArgs(['update', '--check', '--json'])).toEqual({ cmd: 'update', check: true, json: true })
  })

  it('parses reply with text positional', () => {
    expect(parseCliArgs(['reply', 'hello'])).toEqual({
      cmd: 'reply', text: 'hello', json: false,
    })
  })
  it('parses reply with --to and multi-word text', () => {
    expect(parseCliArgs(['reply', '--to', 'u@chat', 'hello', 'world'])).toEqual({
      cmd: 'reply', chatId: 'u@chat', text: 'hello world', json: false,
    })
  })
  it('parses reply with --json and no text (stdin path)', () => {
    expect(parseCliArgs(['reply', '--json'])).toEqual({
      cmd: 'reply', json: true,
    })
  })
  it('parses reply with --to but no text', () => {
    expect(parseCliArgs(['reply', '--to', 'u@chat'])).toEqual({
      cmd: 'reply', chatId: 'u@chat', json: false,
    })
  })
})

// sessions / avatar / guard / provider parseCliArgs tests removed in PR4
// batch 3a — these namespaces are now citty-routed; see the
// `citty migrated commands` block below for the new test surface.

describe('demo seed/unseed', () => {
  it('parses seed with --chat-id', () => {
    expect(parseCliArgs(['demo', 'seed', '--chat-id', 'chat_x', '--json'])).toEqual({
      cmd: 'demo-seed', chatId: 'chat_x', json: true,
    })
  })
  it('parses seed without --chat-id (null)', () => {
    expect(parseCliArgs(['demo', 'seed'])).toEqual({
      cmd: 'demo-seed', chatId: null, json: false,
    })
  })
  it('parses unseed', () => {
    expect(parseCliArgs(['demo', 'unseed', '--json'])).toEqual({
      cmd: 'demo-unseed', chatId: null, json: true,
    })
  })
})

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

  it('exposes the migrated subcommands (batch 1 + batch 2 + batch 3a)', () => {
    const subs = cittyRoot.subCommands as Record<string, unknown>
    expect(Object.keys(subs).sort()).toEqual([
      'avatar',
      'conversations',
      'doctor',
      'events',
      'guard',
      'install',
      'list',
      'logs',
      'milestones',
      'observations',
      'provider',
      'sessions',
      'setup-status',
      'status',
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
})
