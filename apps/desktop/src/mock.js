// Browser-mode fallback used when window.__TAURI__ is missing.
// In bundled Tauri or shim mode this file is loaded but mockInvoke is never
// called — the real invoke replaces it.

export async function mockInvoke(command, args, state) {
  await new Promise(resolve => setTimeout(resolve, 120))
  if (command === "wechat_cli_json" && args.args?.[0] === "doctor") {
    return {
      ready: false,
      stateDir: "~/.claude/channels/wechat",
      checks: {
        bun: { ok: true, path: "/opt/homebrew/bin/bun" },
        git: { ok: true, path: "/usr/bin/git" },
        claude: { ok: true, path: "/usr/local/bin/claude" },
        codex: { ok: true, path: "/opt/homebrew/bin/codex" },
        accounts: { ok: false, count: 0, items: [] },
        access: { ok: false, dmPolicy: "allowlist", allowFromCount: 0 },
        provider: { ok: true, provider: state?.selectedProvider ?? "claude", binaryPath: "/usr/local/bin/claude" },
        daemon: { alive: false, pid: null },
      },
      nextActions: ["run_wechat_setup", "start_service"],
    }
  }
  if (command === "wechat_cli_json" && args.args?.[0] === "setup") {
    return { qrcode: "mock-qr-token", qrcode_img_content: "weixin://mock-qr", expires_in_ms: 480000 }
  }
  if (command === "wechat_cli_json" && args.args?.[0] === "setup-poll") {
    const count = Number(sessionStorage.getItem("qrPollCount") || "0") + 1
    sessionStorage.setItem("qrPollCount", String(count))
    if (count < 3) return { status: count === 1 ? "wait" : "scaned" }
    return { status: "confirmed", accountId: "mock-bot", userId: "mock-user" }
  }
  if (command === "wechat_cli_json" && args.args?.[0] === "service") {
    return { ok: true, state: "running", alive: true, pid: 12345, plan: { kind: "launchagent", serviceName: "wechat-cc" } }
  }
  if (command === "wechat_cli_json" && args.args?.[0] === "provider" && args.args?.[1] === "show") {
    return { provider: state?.selectedProvider ?? "claude", dangerouslySkipPermissions: state?.unattended ?? true }
  }
  if (command === "wechat_cli_text") return "ok"
  return {}
}
