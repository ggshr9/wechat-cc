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
    expect(parseCliArgs(['service', 'status', '--json'])).toEqual({ cmd: 'service', action: 'status', json: true })
    expect(parseCliArgs(['service', 'install', '--json'])).toEqual({ cmd: 'service', action: 'install', json: true })
    expect(parseCliArgs(['service', 'start'])).toEqual({ cmd: 'service', action: 'start', json: false })
    expect(parseCliArgs(['service', 'stop'])).toEqual({ cmd: 'service', action: 'stop', json: false })
    expect(parseCliArgs(['service', 'uninstall', '--json'])).toEqual({ cmd: 'service', action: 'uninstall', json: true })
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
})
