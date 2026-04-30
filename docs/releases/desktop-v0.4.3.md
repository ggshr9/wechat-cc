# wechat-cc desktop v0.4.3

Two real bugs caught by Playwright + shim end-to-end:

## 导出 markdown 不工作

The export-markdown click in v0.4.0 → v0.4.2 silently did nothing.
Root cause: `apps/desktop/src/modules/sessions.js` checked for
`window.__TAURI__.dialog.save` and `window.__TAURI__.fs.writeTextFile`,
but the Cargo deps only ship `tauri-plugin-shell` — `dialog` and `fs`
are absent, the condition is always false, and the blob fallback
(`<a download>.click()`) silently no-ops in Tauri's WebKit/WebView2
since downloads aren't wired by default.

v0.4.3 adds a `save_text_file(filename, content)` Tauri command in
`lib.rs` that writes directly to `$HOME/Downloads/<basename>` (with
basename-only safety), and the frontend invokes it instead of the
broken dialog/fs path. The shim's `/__invoke` mirror handler now
also serves `save_text_file` so dev iteration covers it. End-to-end
verified: clicking 导出 markdown writes a 370 KB / 9106-line .md to
`~/Downloads/<alias>-session.md` and shows an alert with the path.

## 用户发图片，Claude 没回复

When Claude analyzed an inbound image, it called the `Read` tool to
inspect the file, then generated a description as plain assistant
text — but **never called `mcp__wechat__reply`**. The daemon's
`onInbound` in `main.ts` had `sendAssistantText` deliberately
omitted (a stale comment from the duplicate-message-suppression era)
so any raw assistant text was silently dropped → user got nothing
back on WeChat.

v0.4.3 reroutes this: the agent provider now tracks reply-family
tool calls (`mcp__wechat__reply`, `reply_voice`, `send_file`,
`edit_message`, `broadcast`) per turn and exposes a
`replyToolCalled` flag on the dispatch result. The router uses raw
assistant text as a **fallback** — only when *no* reply-family tool
was called this turn — so the duplicate-message worry stays solved
while a forgetful Claude no longer strands the user. Each fallback
fire logs `[FALLBACK_REPLY]` with chat + project + chunk count +
preview so we can see how often Claude misroutes.

## Other

* `apps/desktop/test-shim.ts`: wire `wechat_cli_json_via_file`
  (added in v0.4.1 lib.rs but missed in the shim) so Playwright
  smoke tests of sessions detail / export markdown actually work
  against the dev shim instead of failing with `unknown command`.

## Verified

- 799/799 tests passing (+2 regression tests for `replyToolCalled`)
- Playwright end-to-end: open compass session → click 导出 markdown →
  alert "已导出: /home/nategu/Downloads/compass-session.md", file
  has correct content
- Provider regression: tool_use(`Read`) + text without reply →
  `replyToolCalled=false`, `assistantText=['描述一下图片']`
