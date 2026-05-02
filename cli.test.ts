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
  // status / list / install / doctor / setup-status moved to citty (PR4 batch 1).
  // Their parser-only behavior is covered by the `citty migrated commands`
  // describe block below; these legacy parseCliArgs tests would now fall
  // through to `{ cmd: 'help' }` and weren't testing the real entrypoint.
  it('recognizes service/provider/help', () => {
    expect(parseCliArgs(['service', 'status', '--json'])).toEqual({ cmd: 'service', action: 'status', json: true, unattended: undefined, autoStart: undefined })
    expect(parseCliArgs(['service', 'install', '--json'])).toEqual({ cmd: 'service', action: 'install', json: true, unattended: undefined, autoStart: undefined })
    expect(parseCliArgs(['service', 'start'])).toEqual({ cmd: 'service', action: 'start', json: false, unattended: undefined, autoStart: undefined })
    expect(parseCliArgs(['service', 'stop'])).toEqual({ cmd: 'service', action: 'stop', json: false, unattended: undefined, autoStart: undefined })
    expect(parseCliArgs(['service', 'uninstall', '--json'])).toEqual({ cmd: 'service', action: 'uninstall', json: true, unattended: undefined, autoStart: undefined })
    expect(parseCliArgs(['service', 'install', '--unattended', 'true', '--auto-start', 'true']))
      .toMatchObject({ cmd: 'service', action: 'install', unattended: true, autoStart: true })
    expect(parseCliArgs(['service', 'install', '--auto-start', 'false']))
      .toMatchObject({ cmd: 'service', action: 'install', autoStart: false })
    expect(parseCliArgs(['provider', 'set', 'codex', '--model', 'gpt-5.3-codex'])).toEqual({
      cmd: 'provider-set',
      provider: 'codex',
      model: 'gpt-5.3-codex',
    })
    expect(parseCliArgs(['provider', 'show', '--json'])).toEqual({ cmd: 'provider-show', json: true })
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
  it('parses logs subcommand with default + explicit tail count', () => {
    expect(parseCliArgs(['logs'])).toEqual({ cmd: 'logs', tail: 50, json: false })
    expect(parseCliArgs(['logs', '--tail', '20'])).toEqual({ cmd: 'logs', tail: 20, json: false })
    expect(parseCliArgs(['logs', '--tail', '100', '--json'])).toEqual({ cmd: 'logs', tail: 100, json: true })
    expect(parseCliArgs(['logs', '--json'])).toEqual({ cmd: 'logs', tail: 50, json: true })
  })
  it('logs --tail with non-numeric value falls back to default 50', () => {
    expect(parseCliArgs(['logs', '--tail', 'banana'])).toEqual({ cmd: 'logs', tail: 50, json: false })
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

describe('events list', () => {
  it('parses chat-id with optional --json --limit', () => {
    expect(parseCliArgs(['events', 'list', 'chat_x', '--json', '--limit', '20'])).toEqual({
      cmd: 'events-list', chatId: 'chat_x', json: true, limit: 20,
    })
  })
  it('limit defaults to 50 when omitted', () => {
    const r = parseCliArgs(['events', 'list', 'chat_x'])
    expect(r).toMatchObject({ cmd: 'events-list', chatId: 'chat_x', limit: 50 })
  })
})

describe('observations list', () => {
  it('parses chat-id and --include-archived', () => {
    expect(parseCliArgs(['observations', 'list', 'chat_x', '--include-archived', '--json'])).toEqual({
      cmd: 'observations-list', chatId: 'chat_x', includeArchived: true, json: true,
    })
  })
})

describe('observations archive', () => {
  it('parses obs id', () => {
    expect(parseCliArgs(['observations', 'archive', 'chat_x', 'obs_abc', '--json'])).toEqual({
      cmd: 'observations-archive', chatId: 'chat_x', obsId: 'obs_abc', json: true,
    })
  })
})

describe('milestones list', () => {
  it('parses chat-id', () => {
    expect(parseCliArgs(['milestones', 'list', 'chat_x', '--json'])).toEqual({
      cmd: 'milestones-list', chatId: 'chat_x', json: true,
    })
  })
})

describe('sessions list-projects', () => {
  it('parses --json', () => {
    expect(parseCliArgs(['sessions', 'list-projects', '--json'])).toEqual({
      cmd: 'sessions-list-projects', json: true,
    })
  })
})

describe('sessions read-jsonl', () => {
  it('parses alias', () => {
    expect(parseCliArgs(['sessions', 'read-jsonl', 'compass', '--json'])).toEqual({
      cmd: 'sessions-read-jsonl', alias: 'compass', json: true,
    })
  })
  it('parses --out-file path', () => {
    // The desktop sidecar uses this to dump 8 MB+ JSON to disk instead of
    // stdout — bun --compile binaries lose bytes on MB-sized pipe writes.
    expect(parseCliArgs(['sessions', 'read-jsonl', 'compass', '--json', '--out-file', '/tmp/x.json'])).toEqual({
      cmd: 'sessions-read-jsonl', alias: 'compass', json: true, outFile: '/tmp/x.json',
    })
  })
})

describe('sessions delete', () => {
  it('parses alias', () => {
    expect(parseCliArgs(['sessions', 'delete', 'compass', '--json'])).toEqual({
      cmd: 'sessions-delete', alias: 'compass', json: true,
    })
  })
})

describe('sessions search', () => {
  it('parses query with optional --limit', () => {
    expect(parseCliArgs(['sessions', 'search', 'ilink', '--json', '--limit', '20'])).toEqual({
      cmd: 'sessions-search', query: 'ilink', json: true, limit: 20,
    })
  })
  it('limit defaults to 50', () => {
    expect(parseCliArgs(['sessions', 'search', 'foo'])).toMatchObject({
      cmd: 'sessions-search', query: 'foo', limit: 50,
    })
  })
})

describe('conversations list', () => {
  it('parses --json', () => {
    expect(parseCliArgs(['conversations', 'list', '--json'])).toEqual({
      cmd: 'conversations-list', json: true,
    })
  })
  it('defaults json to false without --json', () => {
    expect(parseCliArgs(['conversations', 'list'])).toEqual({
      cmd: 'conversations-list', json: false,
    })
  })
  it('falls back to help when subcommand is unknown', () => {
    expect(parseCliArgs(['conversations', 'bogus']).cmd).toBe('help')
    expect(parseCliArgs(['conversations']).cmd).toBe('help')
  })
})

describe('guard', () => {
  it('parses status / enable / disable', () => {
    expect(parseCliArgs(['guard', 'status', '--json'])).toEqual({ cmd: 'guard-status', json: true })
    expect(parseCliArgs(['guard', 'enable'])).toEqual({ cmd: 'guard-enable', json: false })
    expect(parseCliArgs(['guard', 'disable', '--json'])).toEqual({ cmd: 'guard-disable', json: true })
  })
  it('falls back to help on unknown subcommand', () => {
    expect(parseCliArgs(['guard', 'who-knows'])).toEqual({ cmd: 'help' })
    expect(parseCliArgs(['guard'])).toEqual({ cmd: 'help' })
  })
})

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
  // The first batch of citty-migrated subcommands. Asserted via a stub `run`
  // override (citty calls subCommand.run with parsed args) so the tests
  // verify argument parsing without invoking real handlers (which would
  // touch ~/.claude/channels/wechat state and the doctor probe matrix).
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

  it('exposes the 5 batch-1 subcommands', () => {
    const subs = cittyRoot.subCommands as Record<string, unknown>
    expect(Object.keys(subs).sort()).toEqual(['doctor', 'install', 'list', 'setup-status', 'status'])
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
})
