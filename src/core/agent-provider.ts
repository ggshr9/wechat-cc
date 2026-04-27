export interface AgentProject {
  alias: string
  path: string
}

export interface AgentResult {
  session_id: string
  num_turns: number
  duration_ms: number
}

export interface AgentSession {
  dispatch(text: string): Promise<{ assistantText?: string[] } | void>
  close(): Promise<void>
  onAssistantText(cb: (text: string) => void): () => void
  onResult(cb: (result: AgentResult) => void): () => void
}

export interface AgentProvider {
  spawn(project: AgentProject, opts?: { resumeSessionId?: string }): Promise<AgentSession>
}
