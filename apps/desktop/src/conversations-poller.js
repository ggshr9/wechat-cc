// @ts-check
/** @typedef {import('../../../src/cli/schema').ConversationsListOutputT} ConversationsList */

// conversations-poller — RFC 03 P5.2. Polls
// `wechat-cc conversations list --json` and notifies subscribers.
// Same lifecycle contract as doctor-poller, intentionally dumb (no
// dedup-across-tabs or anything fancy) because the payload is small
// and changes infrequently — modes flip only when the user types a
// /cc /codex /both /chat slash command.
//
// Default interval is 10s — not 5s like doctor — because state-on-disk
// is what we read here and the daemon flushes the conversation store
// on a 500ms debounce; nothing this poller catches will be more recent
// than that.

/**
 * @param {{ invoke: (cmd: string, args: { args: string[] }) => Promise<unknown>, intervalMs?: number }} opts
 */
export function createConversationsPoller({ invoke, intervalMs = 10000 }) {
  /** @type {ConversationsList | null} */
  let last = null
  /** @type {unknown} */
  let lastError = null
  /** @type {Set<(report: ConversationsList) => void>} */
  const subscribers = new Set()
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null
  /** @type {Promise<ConversationsList | null> | null} */
  let inflight = null

  /** @param {ConversationsList} report */
  function notify(report) {
    const snap = Array.from(subscribers)
    for (const cb of snap) {
      try { cb(report) } catch (err) { console.error("conversations subscriber threw", err) }
    }
  }

  function refresh() {
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const report = /** @type {ConversationsList} */ (await invoke("wechat_cli_json", { args: ["conversations", "list", "--json"] }))
        last = report
        lastError = null
        notify(report)
        return report
      } catch (err) {
        lastError = err
        return null
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => { refresh() }, intervalMs)
      refresh()
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null }
    },
    refresh,
    /** @param {(report: ConversationsList) => void} cb */
    subscribe(cb) {
      subscribers.add(cb)
      if (last) {
        try { cb(last) } catch (err) { console.error("conversations subscriber threw", err) }
      }
      return () => subscribers.delete(cb)
    },
    get current() { return last },
    get lastError() { return lastError },
  }
}
