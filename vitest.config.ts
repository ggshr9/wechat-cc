import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/__e2e__/**', '**/playwright/**'],
    // Tests should never touch the operator's real ~/.claude/channels/wechat
    // channel.log. PR Phase 4 routed SESSION_INIT through src/lib/log which
    // appendFileSyncs to STATE_DIR; without this opt-out a vitest run
    // appends test garbage to a live operator's log file.
    env: { WECHAT_DISABLE_LOG_FILE: '1' },
  },
})
