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
  // replyToolCalled = whether the agent called the wechat-mcp reply tool
  // family (reply / reply_voice / send_file / edit_message / broadcast)
  // during this turn. When false but assistantText is non-empty, the
  // channel router forwards the text as a fallback so a forgetful agent
  // (e.g. analyzing an image with a built-in tool and describing it as
  // plain text without calling reply) doesn't leave the user hanging.
  // Always returns both fields — providers must populate them, even as
  // empty array / false. (Tightened in P0 of RFC 03; the old `| void`
  // branch existed only for the cli-provider's one-shot exec path.)
  dispatch(text: string): Promise<{ assistantText: string[]; replyToolCalled: boolean }>
  close(): Promise<void>
  onAssistantText(cb: (text: string) => void): () => void
  onResult(cb: (result: AgentResult) => void): () => void
}

export interface AgentProvider {
  spawn(project: AgentProject, opts?: { resumeSessionId?: string }): Promise<AgentSession>
}
