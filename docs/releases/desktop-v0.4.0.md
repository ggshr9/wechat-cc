# wechat-cc desktop v0.4.0

**Two mirrors of accompaniment** — Sessions and Memory finally have a place to live in the dashboard, and the session view now feels like opening WeChat itself.

This is the long-deferred v0.4 release: the sessions / memory feature originally scoped in `docs/specs/2026-04-29-sessions-memory-design.md` has shipped, plus a substantial refinement pass that turned the dev-card transcript view into a 1:1 iOS WeChat replica running inside an iPhone 17 Pro frame.

## Headline changes

### A new pane: **会话 / Sessions**
Every chat × project pairing the daemon has touched is here. List view groups by recency (今天 / 7 天内 / 更早), each row carries an LLM-generated 1-line summary so you can scan months of conversations without drilling in. Click a row to open the transcript.

### A new pane: **记忆 / Memory**
Two-zone layout: top shows recent observations (what Claude noticed about you) + milestones (100-turn / handoff / 7-day streak / push-reply landmarks); below shows decisions and cron eval history. The data is the same `memory/` markdown Claude has always written — it's the surfacing that's new.

### **WeChat-replica chat detail (the big one)**
Click any session and you land inside an iPhone 17 Pro frame: black bezel, Dynamic Island, status bar with live clock, WeChat-green title bar, and the chat itself rendered with proper bubbles (`#95EC69` user / white incoming, 4px corners, tails pointing toward avatars), 40×40 rounded-square avatars, time separators between message clusters >5 min apart (`上午 8:32` / `昨天 22:16` / `周三 22:16` / `2026-04-15 22:16`), and a static input bar to complete the picture. iOS-style overlay scrollbar (hidden at rest, fades in during scroll). The whole thing auto-refreshes every 4 s so new messages flow in without a page reload.

### Image / file attachments render properly
- Images show as standalone thumbnails (no white card, no tail — matches WeChat)
- Files show as colored-badge cards (PDF red, DOC blue, XLS green, ZIP brown)
- Tap an image → fullscreen lightbox; tap a file → preview modal (text rendered in `<pre>`, binary shows hex dump of first 1 KB so you can spot magic bytes)
- The `[引用]` quote marker renders as a small grey card below the bubble

### Custom avatars
Click any avatar in the chat — your contact's letter mark, or Claude's `cc` — and a modal opens to upload a custom image. Drag-drop or file-picker; client-side canvas resizes to 80×80 PNG before saving. Stored at `<state-dir>/avatars/_claude.png` (global Claude avatar) and `<state-dir>/avatars/<sha256(chat_id)>.png` (per-contact). Remove reverts to the default letter mark.

### **精简 / 完整** toggle
Sessions pane now has a global mode toggle in the top bar. **精简** (default) shows the WeChat-style chat — only what was actually said. **完整** shows the developer view (raw SDK turn cards including `tool_use`, `tool_result`, `attachment`, `queue-operation`, etc). The toggle also drives:
- Search snippets (compact extracts user/reply text; detailed shows raw JSON substring around the match)
- Markdown export (compact emits a clean transcript with `> 我是谁` / Claude reply pairs; detailed dumps full JSON per turn)

### Real-time feel
- Detail view re-fetches the jsonl every 4 s (auto-follow if user is at bottom; preserve scroll position otherwise)
- Default scroll lands on the latest message when opening
- iOS-style overlay scrollbar (hidden at rest, fades in on scroll, fades out 700 ms after the last scroll event)
- Live clock in the iPhone status bar updates with each refresh tick

### Favorite / pin from the list directly
Click the ★ on any session-list row to favorite/unfavorite it without drilling in. The previous detail-bar 收藏 button is gone — favoriting was a list-level action all along.

## v0.4 backend infrastructure (since v0.3.1)

- `events.jsonl` per-chat append-only store with `cron_eval_started/done/failed/skipped`, `handoff_*`, etc.
- `observations.jsonl` with TTL + archive; surfaces in the memory top zone
- `milestones.jsonl` with id-level dedup; detector for 100-turn / 1000-turn / handoff / push-reply / 7-day-streak
- `activity.jsonl` daily activity tracker → drives the 7-day-streak milestone
- Introspect cron tick — agent-driven observation writer (real SDK eval via `claude-haiku-4-5`, isolated; SDK errors route to `cron_eval_failed` for visibility)
- Per-project 1-line LLM summary infrastructure: stale-summary detection + memory-aware prompt (summarizer reads `memory/<chat_id>/*.md` so the tone follows what the user has stated)
- `setSummary` API on session-store for the summarizer wiring
- First-inbound welcome observation per chat
- Persisted `last_introspect_at` so the daemon fires a startup tick if stale

## Polish + bug fixes since v0.3.1

- Dashboard overhaul: dropped the keepAlive toggle (always-on now); launchctl self-heal on macOS
- Decisions log shows `cron_eval_failed` with a ⚠ glyph
- `data-reasoning` mirrored onto `.summary` span so the expandable hint actually shows
- Memory pane wired with archive button + keyboard nav for a11y
- Inline confirms (no popups) per §1.3 design language
- Search drill-down preserves and jumps to the matching turn (not just opens the project)
- `turnHtml` handles real SDK jsonl shapes (string content + array content + thinking + tool_use + tool_result + attachment + queue-operation)
- Demo seed/unseed CLI for populating sample observations + events
- README rewrite — reorganized capability-first, dropped account-ban risk warnings (per project owner clarification: WeChat use is not at risk)
- Daemon "(non-text message)" placeholder is suppressed in compact mode when an attachment is present

## Two-month rollup (commits since v0.3.1)

58 commits land in this release. Highlights chronologically:

- **2026-04-22 to 2026-04-26**: v0.4 backend infrastructure (events / observations / milestones / introspect)
- **2026-04-27 to 2026-04-28**: v0.4 frontend — sessions and memory panes, drill-down, search, demo
- **2026-04-29 (Bundle C)**: drop "已回复" wrap-up + export respects mode + 精简/完整 toggle
- **2026-04-29 (Bundle D)**: global mode toggle + search projects through clean text
- **2026-04-29 (Bundle E)**: WeChat-replica chat bubbles + iPhone 17 Pro frame + Dynamic Island
- **2026-04-29 (Bundle E2)**: image / file / quote attachments
- **2026-04-29 (final pass)**: time separators + lightbox + live clock + custom avatars

## Configuration changes

- `apps/desktop/src-tauri/tauri.conf.json` now includes `app.security.assetProtocol` with `enable: true` and a scope covering `$HOME/.claude/channels/wechat/{inbox,avatars}/**`. Without this, image attachments and custom avatars in the bundled app would fail to render.

## Known deferred items

These were considered and intentionally pushed to a later release (memory'd in `project_backlog_2026_04_29.md`):

- **Quote-message真实内容** — currently shows "引用了一条消息" since the daemon stores `quoteTo: msg_id` only. Resolving original content needs daemon schema change.
- **Multi-chat / 多账号导航** — single chat works; multi-contact navigation deferred until pressing.
- **WebSocket push** — 4 s polling is fine at single-chat scale; SSE/WS comes when this gets hot.

## Compatibility notes

- macOS only for the bundled `.dmg` / `.app`. Linux + Windows artifacts (`.deb` / `.rpm` / `.AppImage` / `.msi`) build from the same tree if needed.
- Requires `state-dir` at `~/.claude/channels/wechat/`. Existing v0.3.1 installs upgrade in place.
- New CLI commands: `wechat-cc avatar info|set|remove <key> [--base64 ...] [--json]`. Used by the desktop UI; safe to invoke from headless setups.
