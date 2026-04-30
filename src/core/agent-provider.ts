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
  // replyToolCalled = whether Claude called mcp__wechat__reply (or
  // reply_voice / send_file) during this turn. When false but
  // assistantText is non-empty, the channel router forwards the text
  // as a fallback so a forgetful Claude (analyzing an image and
  // describing it as plain text without calling reply) doesn't leave
  // the user hanging.
  dispatch(text: string): Promise<{ assistantText?: string[]; replyToolCalled?: boolean } | void>
  close(): Promise<void>
  onAssistantText(cb: (text: string) => void): () => void
  onResult(cb: (result: AgentResult) => void): () => void
}

export interface AgentProvider {
  spawn(project: AgentProject, opts?: { resumeSessionId?: string }): Promise<AgentSession>
}
