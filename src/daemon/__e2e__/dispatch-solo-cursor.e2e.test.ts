// Tier 2 / Task 12 — solo cursor text inbound. Mirror of
// dispatch-solo-codex.e2e.test.ts but routed to the cursor provider,
// exercising the @cursor/sdk fake's Agent.create + Run.stream() path
// and cursor-agent-provider's session lifecycle.
//
// What this catches:
//   - cursor provider not registered when CURSOR_API_KEY is set
//   - cursor SDK stream shape changes break the provider's
//     dispatchGenerator (tool_use / status: FINISHED translation)
//   - mode persistence ignores cursor selection
//   - reply MCP tool call from a cursor session never lands as an
//     outbound sendmessage in the fake-ilink outbox
import { afterEach, describe, expect, it } from 'vitest'
import { startTestDaemon, type DaemonHandle } from './harness'

describe('e2e: solo cursor text inbound → cursor dispatch + outbound reply', () => {
  let daemon: DaemonHandle | null = null
  let prevCursorApiKey: string | undefined

  afterEach(async () => {
    if (daemon) {
      await daemon.stop()
      daemon = null
    }
    if (prevCursorApiKey === undefined) delete process.env.CURSOR_API_KEY
    else process.env.CURSOR_API_KEY = prevCursorApiKey
  })

  it('user "你好" with mode=solo+cursor routes through cursor provider', async () => {
    // CURSOR_API_KEY must be present at boot time — bootstrap reads it
    // synchronously to decide whether to register the cursor provider.
    // (The harness has no `env` option, so we mutate process.env directly
    // and restore in afterEach.)
    prevCursorApiKey = process.env.CURSOR_API_KEY
    process.env.CURSOR_API_KEY = 'test-cursor-key'

    let cursorDispatched: string | null = null
    let claudeWasCalled = false
    let codexWasCalled = false
    daemon = await startTestDaemon({
      dangerously: true,
      modes: { chat1: { kind: 'solo', provider: 'cursor' } },
      claudeScript: {
        async onDispatch(_text) {
          claudeWasCalled = true
          return { toolCalls: [], finalText: '' }
        },
      },
      codexScript: {
        async onDispatch(_text) {
          codexWasCalled = true
          return { toolCalls: [], finalText: '' }
        },
      },
      cursorScript: {
        async onDispatch(text) {
          cursorDispatched = text
          // Emit a reply MCP tool call so the fake-sdk bridge fires the
          // internal-api → outbound sendmessage. The fake wraps bare
          // tool names with `mcp__wechat__` automatically (see fake-sdk
          // REPLY_TOOL_TO_ROUTE handling).
          return {
            toolCalls: [{ name: 'reply', input: { chat_id: 'chat1', text: '你好（cursor）' } }],
            finalText: '你好（cursor）',
          }
        },
      },
    })

    daemon.sendText('chat1', '你好')
    const replies = await daemon.waitForReplyTo('chat1', 8000)
    expect(replies[0]?.endpoint).toBe('sendmessage')
    expect(replies[0]?.text).toContain('你好（cursor）')
    // Routing assertion — neither peer must be invoked when mode=solo+cursor.
    expect(claudeWasCalled).toBe(false)
    expect(codexWasCalled).toBe(false)
    expect(cursorDispatched).toContain('你好')
    expect(cursorDispatched).toContain('chat_id="chat1"')
  })
})
