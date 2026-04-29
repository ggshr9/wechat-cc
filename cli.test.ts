import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseCliArgs } from './cli'

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
  it('recognizes install subcommand with --user', () => {
    expect(parseCliArgs(['install', '--user'])).toEqual({ cmd: 'install', userScope: true })
  })
  it('recognizes install subcommand without --user', () => {
    expect(parseCliArgs(['install'])).toEqual({ cmd: 'install', userScope: false })
  })
  it('recognizes status/list/help', () => {
    expect(parseCliArgs(['status']).cmd).toBe('status')
    expect(parseCliArgs(['list']).cmd).toBe('list')
    expect(parseCliArgs(['doctor']).cmd).toBe('doctor')
    expect(parseCliArgs(['doctor', '--json'])).toEqual({ cmd: 'doctor', json: true })
    expect(parseCliArgs(['setup-status', '--json'])).toEqual({ cmd: 'setup-status', json: true })
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
