#!/bin/bash
# Start Claude Code with WeChat channel
#
# Usage:
#   1. First run setup: bun ~/.claude/plugins/local/wechat/setup.ts
#   2. Then: ~/.claude/plugins/local/wechat/start-channel.sh
#
# This script creates a temporary .mcp.json in the current directory if needed.

PLUGIN_DIR="$HOME/.claude/plugins/local/wechat"
BUN="$HOME/.bun/bin/bun"

# Check if .mcp.json in current dir already has wechat
if [ -f .mcp.json ] && grep -q '"wechat"' .mcp.json 2>/dev/null; then
  exec claude --dangerously-load-development-channels server:wechat --channels server:wechat "$@"
fi

# Use --mcp-config to inject the server
exec claude \
  --mcp-config "{\"mcpServers\":{\"wechat\":{\"command\":\"$BUN\",\"args\":[\"run\",\"--cwd\",\"$PLUGIN_DIR\",\"--silent\",\"start\"]}}}" \
  --dangerously-load-development-channels server:wechat \
  --channels server:wechat \
  "$@"
