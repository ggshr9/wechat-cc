import { describe, expect, it, vi } from 'vitest'
import { createCodexCliProvider } from './codex-cli-provider'

describe('Codex CLI provider', () => {
  it('dispatches each prompt through codex exec in the project cwd', async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: 'done from codex',
      stderr: '',
      exitCode: 0,
      duration_ms: 25,
    })
    const provider = createCodexCliProvider({
      command: 'codex',
      model: 'gpt-5.3-codex',
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      run,
    })
    const session = await provider.spawn({ alias: 'mobile', path: '/repo' })
    const assistant: string[] = []
    const results: unknown[] = []
    session.onAssistantText(t => { assistant.push(t) })
    session.onResult(r => { results.push(r) })

    await session.dispatch('<wechat>hi</wechat>')

    expect(run).toHaveBeenCalledWith({
      command: 'codex',
      args: [
        'exec',
        '--cd', '/repo',
        '--model', 'gpt-5.3-codex',
        '--sandbox', 'workspace-write',
        '--ask-for-approval', 'never',
        '-',
      ],
      input: '<wechat>hi</wechat>',
    })
    expect(assistant).toEqual(['done from codex'])
    expect(results).toEqual([{ session_id: 'codex-cli:mobile', num_turns: 1, duration_ms: 25 }])
  })
})
