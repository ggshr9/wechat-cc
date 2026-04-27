import { spawn } from 'node:child_process'
import type { AgentProject, AgentProvider, AgentResult, AgentSession } from './agent-provider'

export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access'
export type CodexApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never'

export interface CommandRun {
  command: string
  args: string[]
  input: string
}

export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
  duration_ms: number
}

export type CommandRunner = (run: CommandRun) => Promise<CommandResult>

export interface CodexCliProviderOptions {
  command?: string
  model?: string
  sandbox?: CodexSandbox
  approvalPolicy?: CodexApprovalPolicy
  run?: CommandRunner
}

export function createCodexCliProvider(opts: CodexCliProviderOptions = {}): AgentProvider {
  const command = opts.command ?? 'codex'
  const sandbox = opts.sandbox ?? 'workspace-write'
  const approvalPolicy = opts.approvalPolicy ?? 'never'
  const run = opts.run ?? spawnCommand

  return {
    async spawn(project: AgentProject): Promise<AgentSession> {
      const assistantListeners = new Set<(text: string) => void>()
      const resultListeners = new Set<(result: AgentResult) => void>()
      let turns = 0

      return {
        async dispatch(text: string): Promise<{ assistantText?: string[] }> {
          const args = [
            'exec',
            '--cd', project.path,
            ...(opts.model ? ['--model', opts.model] : []),
            '--sandbox', sandbox,
            '--ask-for-approval', approvalPolicy,
            '-',
          ]
          const result = await run({ command, args, input: text })
          turns += 1
          const assistantText = result.stdout.trim()
          if (assistantText) for (const cb of assistantListeners) cb(assistantText)
          for (const cb of resultListeners) cb({
            session_id: `codex-cli:${project.alias}`,
            num_turns: turns,
            duration_ms: result.duration_ms,
          })
          if (result.exitCode !== 0) {
            throw new Error(`codex exec failed exit=${result.exitCode}: ${result.stderr.slice(0, 500)}`)
          }
          return assistantText ? { assistantText: [assistantText] } : {}
        },
        async close(): Promise<void> {},
        onAssistantText(cb) { assistantListeners.add(cb); return () => { assistantListeners.delete(cb) } },
        onResult(cb) { resultListeners.add(cb); return () => { resultListeners.delete(cb) } },
      }
    },
  }
}

async function spawnCommand(run: CommandRun): Promise<CommandResult> {
  const started = Date.now()
  return await new Promise((resolve, reject) => {
    const child = spawn(run.command, run.args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', code => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
        duration_ms: Date.now() - started,
      })
    })
    child.stdin.end(run.input)
  })
}
