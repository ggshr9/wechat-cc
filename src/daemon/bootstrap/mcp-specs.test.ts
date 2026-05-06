import { describe, it, expect, vi, afterEach } from 'vitest'
import { wechatStdioMcpSpec, delegateStdioMcpSpec } from './mcp-specs'
import * as runtimeInfo from '../../lib/runtime-info'

const deps = {
  baseUrl: 'http://127.0.0.1:54321',
  tokenFilePath: '/some/abs/path/internal-token',
}

describe('wechatStdioMcpSpec', () => {
  afterEach(() => vi.restoreAllMocks())

  it('source mode → args is the absolute path to src/mcp-servers/wechat/main.ts', () => {
    vi.spyOn(runtimeInfo, 'isCompiledBundle').mockReturnValue(false)
    const spec = wechatStdioMcpSpec(deps)
    expect(spec.args).toHaveLength(1)
    expect(spec.args[0]).toMatch(/[/\\]src[/\\]mcp-servers[/\\]wechat[/\\]main\.ts$/)
    expect(spec.command).toBe(process.execPath)
  })

  it('compiled mode → args is ["mcp-server", "wechat"] (Bug v0.5.4 → v0.5.5 fix)', () => {
    vi.spyOn(runtimeInfo, 'isCompiledBundle').mockReturnValue(true)
    const spec = wechatStdioMcpSpec(deps)
    expect(spec.args).toEqual(['mcp-server', 'wechat'])
    expect(spec.command).toBe(process.execPath)
  })

  it('passes participantTag through env when provided', () => {
    const spec = wechatStdioMcpSpec(deps, 'claude')
    expect(spec.env.WECHAT_PARTICIPANT_TAG).toBe('claude')
  })

  it('omits participantTag from env when not provided', () => {
    const spec = wechatStdioMcpSpec(deps)
    expect(spec.env.WECHAT_PARTICIPANT_TAG).toBeUndefined()
  })

  it('always sets WECHAT_INTERNAL_API + WECHAT_INTERNAL_TOKEN_FILE', () => {
    const spec = wechatStdioMcpSpec(deps)
    expect(spec.env.WECHAT_INTERNAL_API).toBe(deps.baseUrl)
    expect(spec.env.WECHAT_INTERNAL_TOKEN_FILE).toBe(deps.tokenFilePath)
  })
})

describe('delegateStdioMcpSpec', () => {
  afterEach(() => vi.restoreAllMocks())

  it('source mode → args is the absolute path to src/mcp-servers/delegate/main.ts', () => {
    vi.spyOn(runtimeInfo, 'isCompiledBundle').mockReturnValue(false)
    const spec = delegateStdioMcpSpec(deps, 'codex')
    expect(spec.args).toHaveLength(1)
    expect(spec.args[0]).toMatch(/[/\\]src[/\\]mcp-servers[/\\]delegate[/\\]main\.ts$/)
  })

  it('compiled mode → args is ["mcp-server", "delegate"]', () => {
    vi.spyOn(runtimeInfo, 'isCompiledBundle').mockReturnValue(true)
    const spec = delegateStdioMcpSpec(deps, 'codex')
    expect(spec.args).toEqual(['mcp-server', 'delegate'])
  })

  it('sets WECHAT_DELEGATE_PEER from the peer arg', () => {
    expect(delegateStdioMcpSpec(deps, 'codex').env.WECHAT_DELEGATE_PEER).toBe('codex')
    expect(delegateStdioMcpSpec(deps, 'claude').env.WECHAT_DELEGATE_PEER).toBe('claude')
  })
})
