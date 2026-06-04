# Gemini provider — Phase 0 spike findings (2026-06-04)

## Versions
- @google/genai: 2.8.0
- @modelcontextprotocol/sdk: 1.29.0 (already a daemon dependency)
- Bun: 1.3.12

## Bun compatibility
- import + instantiate (@google/genai): OK under plain `bun` (no --bun needed). Constructor is `GoogleGenAI`; entry points are `ai.models.generateContent(...)` / `ai.models.generateContentStream(...)`. `ai.models` prototype methods confirmed present.
- MCP client (already a daemon dep, Bun-proven): OK — `Client` + `StdioClientTransport` imported from `@modelcontextprotocol/sdk/client/index.js` and `…/client/stdio.js`; client connected to the wechat stdio server, `listTools` resolved cleanly (24 tools), `client.close()` exited cleanly. Full round-trip proved under plain `bun`.
- live streaming / function-calling: UNVERIFIED — no GEMINI_API_KEY in this environment; pin shapes from genai 2.x docs at Phase A impl time
- Verdict: GO — Bun runs the full stack (genai load + MCP client bridge).

## Pinned API shapes (for Phase A)
- genai constructor: `GoogleGenAI({ apiKey })`; entry `ai.models.generateContent(...)` / `ai.models.generateContentStream(...)`
- NOTE genai 2.8 has native MCP/AFC hooks (`processParamsMaybeAddMcpUsage`, `initAfcToolsMap`) — but per spec we use the standard MCP client + manual `functionDeclaration` bridge to stay off the experimental path. Fallback exists if needed.
- stream chunk → text / response → functionCalls / functionResponse shape: UNVERIFIED live; genai 2.8 documented shapes: `chunk.text`; `response.functionCalls()`; functionResponse turn as `{ role: 'user', parts: [{ functionResponse: { name, response } }] }`. Confirm during Phase A against a real key.

## MCP
- wechat server launch (from `src/daemon/bootstrap/mcp-specs.ts`):
  - command: `process.execPath` (= `bun` in source mode, `wechat-cc-cli` in compiled binary mode)
  - args (source mode): `[join(here, '..', '..', 'mcp-servers', 'wechat', 'main.ts')]` → resolves to `src/mcp-servers/wechat/main.ts`
  - args (compiled binary mode): `['mcp-server', 'wechat']`
  - env required: `WECHAT_INTERNAL_API` (e.g. `http://127.0.0.1:54321`), `WECHAT_INTERNAL_TOKEN_FILE` (abs path to token file)
  - env optional: `WECHAT_PARTICIPANT_TAG` (providerId, e.g. `gemini` — used to prefix `[Gemini]` in parallel/chatroom modes)
- listTools result: **24 tools** connected cleanly with dummy env (real internal-api not needed for enumeration — tools are registered at startup before any call touches internal-api).
  - tool names: `ping, memory_read, memory_write, memory_list, memory_delete, list_projects, switch_project, add_project, remove_project, set_user_name, voice_config_status, save_voice_config, share_page, resurface_page, reply, reply_voice, send_file, edit_message, broadcast, companion_enable, companion_disable, companion_status, companion_snooze, a2a_send`
  - first tool (`ping`) full JSON for reference:
    ```json
    {
      "name": "ping",
      "title": "Ping daemon",
      "description": "Round-trips a request through the daemon internal-api and returns its pid. Used by integration tests to verify the full MCP-over-stdio + internal-api channel is alive.",
      "inputSchema": {
        "type": "object",
        "properties": {},
        "$schema": "http://json-schema.org/draft-07/schema#"
      },
      "outputSchema": {
        "type": "object",
        "properties": {
          "ok": { "type": "boolean" },
          "daemon_pid": { "type": "number" }
        },
        "required": ["ok", "daemon_pid"],
        "$schema": "http://json-schema.org/draft-07/schema#",
        "additionalProperties": false
      },
      "execution": { "taskSupport": "forbidden" }
    }
    ```
- inputSchema → Gemini `parameters`: all tools use JSON Schema Draft-07 with `type: "object"`, `properties` map, and `required` array (where applicable). Maps directly to Gemini `FunctionDeclaration.parameters` shape — strip `$schema` and `additionalProperties` keys (Gemini doesn't use them), pass `type`, `properties`, `required` verbatim. Example for `reply`: `{ type: "object", properties: { chat_id: { type: "string" }, text: { type: "string" } }, required: ["chat_id", "text"] }`.

## Go / No-Go
- **GO**: genai 2.8.0 loads under Bun 1.3.12 with no flags; MCP SDK is already a daemon dependency and proven via a live `listTools` round-trip (24 tools, clean connect + close). Proceed to Phase A (provider class + tool loop) using these shapes; pin the live streaming/functionCall shapes during Phase A (test against a real key there). No-go risks retired: "Bun can't load genai" — FALSE, it loads cleanly; "MCP client bridge unproven under Bun" — FALSE, proven live this spike.
