import { describe, expect, it, vi } from 'vitest'
import type { A2AClient, SendRequest, SendResult } from './a2a-client'
import type { A2AAgentRecord } from '../lib/agent-config'
import { delegateToHand, handExecUrl } from './a2a-delegate'

function hand(url: string): A2AAgentRecord {
  return { id: 'home', name: 'home', url, inbound_api_key: 'in_home_key_16chars', outbound_api_key: 'out_home_key', capabilities: ['exec'], paused: false, transport: 'push' }
}

function fakeClient(send: (req: SendRequest) => Promise<SendResult>): A2AClient {
  return { fetchAgentCard: vi.fn(), send: vi.fn(send) }
}

describe('handExecUrl', () => {
  it('derives /a2a/exec from the common url shapes', () => {
    expect(handExecUrl('https://home/a2a/notify')).toBe('https://home/a2a/exec')
    expect(handExecUrl('https://home/a2a')).toBe('https://home/a2a/exec')
    expect(handExecUrl('https://home/a2a/exec')).toBe('https://home/a2a/exec')
    expect(handExecUrl('https://home/')).toBe('https://home/a2a/exec')
  })
})

describe('delegateToHand', () => {
  it('POSTs to the hand /a2a/exec with bearer + body, returns the hand result', async () => {
    let captured!: SendRequest
    const client = fakeClient(async (req) => {
      captured = req
      return { ok: true, http_status: 200, response: { ok: true, response: '家里 README 写着 X' } }
    })
    const res = await delegateToHand(client, { hand: hand('https://home/a2a/notify'), selfId: 'work-brain', prompt: '看下家里 README', peer: 'codex', cwd: '/h/p' })
    expect(res).toEqual({ ok: true, response: '家里 README 写着 X' })
    expect(captured.url).toBe('https://home/a2a/exec')
    expect(captured.bearer).toBe('out_home_key')
    expect(captured.body).toEqual({ agent_id: 'work-brain', prompt: '看下家里 README', peer: 'codex', cwd: '/h/p' })
  })

  it('surfaces a hand-side failure result', async () => {
    const client = fakeClient(async () => ({ ok: true, http_status: 200, response: { ok: false, reason: 'unknown peer: gemini' } }))
    const res = await delegateToHand(client, { hand: hand('https://home/a2a'), selfId: 'b', prompt: 'x' })
    expect(res).toEqual({ ok: false, reason: 'unknown peer: gemini' })
  })

  it('maps a transport failure to { ok:false }', async () => {
    const client = fakeClient(async () => ({ ok: false, error: 'timeout' }))
    const res = await delegateToHand(client, { hand: hand('https://home/a2a'), selfId: 'b', prompt: 'x' })
    expect(res).toEqual({ ok: false, reason: 'timeout' })
  })

  it('rejects a malformed hand response', async () => {
    const client = fakeClient(async () => ({ ok: true, http_status: 200, response: 'not an exec result' }))
    const res = await delegateToHand(client, { hand: hand('https://home/a2a'), selfId: 'b', prompt: 'x' })
    expect(res).toEqual({ ok: false, reason: 'malformed hand response' })
  })

  it('omits peer/cwd from the body when not given', async () => {
    let captured!: SendRequest
    const client = fakeClient(async (req) => { captured = req; return { ok: true, response: { ok: true, response: 'r' } } })
    await delegateToHand(client, { hand: hand('https://home/a2a'), selfId: 'b', prompt: 'x' })
    expect(captured.body).toEqual({ agent_id: 'b', prompt: 'x' })
  })
})
