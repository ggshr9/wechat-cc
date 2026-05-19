import { describe, it, expect, vi } from "vitest"
import { silentInstallAndStart } from "./service.js"

describe("silentInstallAndStart", () => {
  it("returns ok=true when install + start + alive all succeed", async () => {
    const invoke = vi.fn(async (_cmd: string, args: { args: string[] }) => {
      const sub = args.args[0]
      if (sub === "service" && args.args[1] === "install") return { ok: true, kind: "launchagent" }
      if (sub === "service" && args.args[1] === "start") return { ok: true }
      if (sub === "doctor") return { checks: { daemon: { alive: true, pid: 4242 } } }
      return null
    })
    const labels: string[] = []
    const result = await silentInstallAndStart({ invoke }, (l) => labels.push(l))
    expect(result.ok).toBe(true)
    expect((result as { serviceKind: string }).serviceKind).toBe("launchagent")
    expect((result as { daemonPid: number }).daemonPid).toBe(4242)
    expect(labels).toContain("安装后台服务…")
    expect(labels).toContain("启动后台服务…")
  })

  it("returns ok=false stage=install when install fails", async () => {
    const invoke = vi.fn(async (_cmd: string, args: { args: string[] }) => {
      if (args.args[0] === "service" && args.args[1] === "install") return { ok: false, error: "denied", stderr: "no perms" }
      return null
    })
    const result = await silentInstallAndStart({ invoke }, () => {})
    expect(result).toMatchObject({ ok: false, stage: "install", error: "denied", details: "no perms" })
  })

  it("returns ok=false stage=start when start fails", async () => {
    const invoke = vi.fn(async (_cmd: string, args: { args: string[] }) => {
      if (args.args[0] === "service" && args.args[1] === "install") return { ok: true, kind: "systemd-user" }
      if (args.args[0] === "service" && args.args[1] === "start") return { ok: false, error: "unit not found" }
      return null
    })
    const result = await silentInstallAndStart({ invoke }, () => {})
    expect(result).toMatchObject({ ok: false, stage: "start", error: "unit not found" })
  })

  it("returns ok=false stage=alive when daemon never responds", async () => {
    const invoke = vi.fn(async (_cmd: string, args: { args: string[] }) => {
      if (args.args[0] === "service") return { ok: true, kind: "systemd-user" }
      if (args.args[0] === "doctor") return { checks: { daemon: { alive: false } } }
      return null
    })
    vi.useFakeTimers()
    const promise = silentInstallAndStart({ invoke }, () => {})
    // Drain 15s of fake time in 500ms slices (32 slices > 15000 / 500 = 30).
    for (let i = 0; i < 32; i++) {
      await vi.advanceTimersByTimeAsync(500)
    }
    const result = await promise
    vi.useRealTimers()
    expect(result).toMatchObject({ ok: false, stage: "alive" })
  })
})
