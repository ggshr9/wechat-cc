import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseCliArgs } from './cli'

describe('parseCliArgs', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('recognizes run subcommand', () => {
    expect(parseCliArgs(['run'])).toEqual({ cmd: 'run' })
  })
  it('recognizes setup subcommand', () => {
    expect(parseCliArgs(['setup'])).toEqual({ cmd: 'setup' })
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
    expect(parseCliArgs(['--help']).cmd).toBe('help')
    expect(parseCliArgs(['-h']).cmd).toBe('help')
    expect(parseCliArgs([]).cmd).toBe('help')
  })
  it('unknown subcommand returns help', () => {
    expect(parseCliArgs(['whatever']).cmd).toBe('help')
  })
  it('no longer accepts --fresh, --continue, --dangerously (warns instead)', () => {
    const warn = vi.fn()
    const out = parseCliArgs(['run', '--fresh', '--dangerously'], { warn })
    expect(out).toEqual({ cmd: 'run' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('--fresh'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('--dangerously'))
  })
  it('warns for --mcp-config and --channels too', () => {
    const warn = vi.fn()
    parseCliArgs(['run', '--mcp-config=x', '--channels'], { warn })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('--mcp-config'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('--channels'))
  })
})
