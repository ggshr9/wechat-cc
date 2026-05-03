import type { Lifecycle } from '../lib/lifecycle'
import type { SessionManager } from '../core/session-manager'
import type { SessionStore } from '../core/session-store'
import type { ConversationStore } from '../core/conversation-store'

export interface SessionsLifecycleDeps {
  sessionManager: Pick<SessionManager, 'shutdown'>
  sessionStore: Pick<SessionStore, 'flush'>
  conversationStore: Pick<ConversationStore, 'flush'>
}

export function registerSessions(deps: SessionsLifecycleDeps): Lifecycle {
  let stopped = false
  return {
    name: 'sessions',
    stop: async () => {
      if (stopped) return
      stopped = true
      await deps.sessionManager.shutdown()
      await deps.sessionStore.flush()
      await deps.conversationStore.flush()
    },
  }
}
