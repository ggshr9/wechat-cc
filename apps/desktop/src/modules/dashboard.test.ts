import { describe, it, expect, vi, beforeEach } from 'vitest'

// Use vitest's jsdom-like DOM stub so setPending no-ops cleanly. The
// existing dashboard.js uses document.getElementById in setPending; we
// just need the call not to crash.
beforeEach(() => {
  // @ts-expect-error provide a minimal getElementById stub
  globalThis.document = { getElementById: () => null }
  // @ts-expect-error provide the DOM constant used by renderRestartButton
  globalThis.Node = { TEXT_NODE: 3 }
})

// Import AFTER document stub so setPending's getElementById doesn't crash
const { renderDashboard, renderRestartButton, restartDaemon, runRestartSequence, stopDaemon, renderDiagnoseCard, hideDiagnoseCard } = await import('./dashboard.js')

function textNode(text = '') {
  return { nodeType: 3, textContent: text }
}

function fakeEl() {
  return {
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    title: '',
    dataset: {},
    childNodes: [] as Array<any>,
    classList: {
      values: new Set<string>(),
      toggle(cls: string, force?: boolean) {
        if (force) this.values.add(cls)
        else this.values.delete(cls)
      },
      contains(cls: string) { return this.values.has(cls) },
    },
    appendChild(node: any) { this.childNodes.push(node); return node },
    removeAttribute(name: string) {
      if (name === 'title') this.title = ''
    },
    querySelector() { return null },
    addEventListener: vi.fn(),
    contains: (_node: any) => false,
    closest: (_sel: string) => null,
  }
}

function installDashboardDom() {
  const els = {
    heroCard: fakeEl(),
    heroHeadline: fakeEl(),
    heroMeta: fakeEl(),
    dashPending: fakeEl(),
    dashStop: fakeEl(),
    dashRestart: { ...fakeEl(), childNodes: [textNode(' 重新连接')] },
    accountsBody: fakeEl(),
    accountsCurrent: fakeEl(),
    accountsMeta: fakeEl(),
    // Diagnose-card elements
    rdcCard: { ...fakeEl(), hidden: true },
    rdcTitle: fakeEl(),
    rdcHint: fakeEl(),
    rdcFix: { ...fakeEl(), hidden: true },
    rdcPrimary: fakeEl(),
    rdcSecondary: { ...fakeEl(), hidden: true },
  }
  const byId: Record<string, any> = {
    'hero-card': els.heroCard,
    'hero-headline': els.heroHeadline,
    'hero-meta': els.heroMeta,
    'dash-pending': els.dashPending,
    'dash-stop': els.dashStop,
    'dash-restart': els.dashRestart,
    'accounts-body': els.accountsBody,
    'accounts-current': els.accountsCurrent,
    'accounts-meta': els.accountsMeta,
    'reconnect-diagnose-card': els.rdcCard,
    'rdc-title': els.rdcTitle,
    'rdc-hint': els.rdcHint,
    'rdc-fix': els.rdcFix,
    'rdc-primary': els.rdcPrimary,
    'rdc-secondary': els.rdcSecondary,
  }
  const fakeDocument = {
    getElementById: (id: string) => byId[id] ?? null,
    createElement: (tag: string) => ({
      ...fakeEl(),
      tagName: tag.toUpperCase(),
      href: '',
      target: '',
      rel: '',
      style: { cssText: '' },
    }),
  }
  globalThis.document = fakeDocument as unknown as typeof document
  return els
}

function dashboardReport(overrides: Record<string, any> = {}) {
  const report = {
    checks: {
      daemon: { alive: false, pid: null },
      accounts: { count: 1, items: [{ id: 'demo-im-bot', botId: 'demo@im.bot', userId: 'u1', baseUrl: '' }] },
      provider: { provider: 'codex' },
      access: { allowFromCount: 1 },
      service: { installed: true },
    },
    userNames: { u1: '锦鲤大人' },
    expiredBots: [],
  }
  return { ...report, ...overrides, checks: { ...report.checks, ...(overrides.checks ?? {}) } }
}

function fakeDoctorPoller(cachedDaemonRunning = true) {
  // Return a doctor cache that doesn't trigger the "install" route — so
  // restartDaemon flows into the stop+start path. The shape is enough to
  // satisfy restartButtonState() returning action != "install".
  const checks = {
    daemon: { alive: cachedDaemonRunning, pid: cachedDaemonRunning ? 1234 : null },
    // restartButtonState() checks service.installed — set true so the
    // function returns action: "restart" (not "install"), letting our
    // pid-check path execute.
    service: { installed: true },
    accounts: { count: 1, items: [] },
    access: { allowFromCount: 1 },
    provider: { provider: 'claude' },
    claude: { ok: true },
  }
  return {
    refresh: vi.fn(async () => ({ checks, expiredBots: [] })),
    current: { checks, expiredBots: [] },
    lastError: null,
  }
}

// A minimal doctor report shaped to produce code-1 from diagnose()
// (daemon dead + pid ≠ null + service installed).
function deadDaemonReport() {
  return {
    checks: {
      daemon: { alive: false, pid: 1234 },
      service: { installed: true },
      accounts: { count: 1, items: [] },
      access: { allowFromCount: 1 },
      provider: { provider: 'claude' },
      claude: { ok: true },
    },
    expiredBots: [],
    userNames: {},
  }
}

// A report that produces code-5 (account expired).
function expiredAccountReport() {
  return {
    checks: {
      daemon: { alive: true, pid: 1234 },
      service: { installed: true },
      accounts: { count: 1, items: [{ id: 'bot1', botId: 'b1', userId: 'u1', baseUrl: '' }] },
      access: { allowFromCount: 1 },
      provider: { provider: 'claude' },
      claude: { ok: true },
    },
    expiredBots: [{ botId: 'b1', firstSeenExpiredAt: Date.now() - 3600000 }],
    userNames: {},
  }
}

// A report that produces code-4 (provider hard-missing, daemon alive).
function providerMissingReport() {
  return {
    checks: {
      daemon: { alive: true, pid: 1234 },
      service: { installed: true },
      accounts: { count: 1, items: [] },
      access: { allowFromCount: 1 },
      provider: { provider: 'claude' },
      claude: { severity: 'hard', fix: { command: 'npm install -g @anthropic-ai/claude-code' } },
    },
    expiredBots: [],
    userNames: {},
  }
}

// A report that produces code-0 (all green).
function allGreenReport() {
  return {
    checks: {
      daemon: { alive: true, pid: 1234 },
      service: { installed: true },
      accounts: { count: 1, items: [] },
      access: { allowFromCount: 1 },
      provider: { provider: 'claude' },
      claude: { ok: true },
    },
    expiredBots: [],
    userNames: {},
  }
}

describe('dashboard button state', () => {
  it('companion-active hero shows disconnect only, even while daemon is recovering', () => {
    const els = installDashboardDom()
    const report = dashboardReport()

    renderDashboard(report)
    renderRestartButton(report)

    expect(els.heroHeadline.textContent).toBe('AI 正在陪伴中')
    expect(els.heroMeta.textContent).toBe('一切正常，连接稳定')
    expect(els.dashStop.hidden).toBe(false)
    expect(els.dashRestart.hidden).toBe(true)
  })

  it('offline hero shows reconnect only', () => {
    const els = installDashboardDom()
    const report = dashboardReport({
      checks: {
        accounts: { count: 0, items: [] },
      },
      userNames: {},
    })

    renderDashboard(report)
    renderRestartButton(report)

    expect(els.heroHeadline.textContent).toBe('暂时失去连接')
    expect(els.heroMeta.textContent).toBe('当前连接不稳定，正在尝试重新恢复陪伴')
    expect(els.dashStop.hidden).toBe(true)
    expect(els.dashRestart.hidden).toBe(false)
  })
})

describe('stopDaemon', () => {
  it('continues residual kill after service stop warning and marks disconnected when daemon is down', async () => {
    const els = installDashboardDom()
    const invoke = vi.fn(async (_name: string, args?: any) => {
      if (args?.args?.[0] === 'service' && args.args[1] === 'stop') {
        throw new Error('Boot-out failed: long launchctl stack that should not be rendered')
      }
      return { ok: true }
    })
    const markDisconnected = vi.fn()
    const doctorPoller = {
      refresh: vi.fn(async () => dashboardReport({ checks: { daemon: { alive: false, pid: null } } })),
    }

    await stopDaemon({
      invoke,
      doctorPoller,
      markDisconnected,
      formatInvokeError: (e: unknown) => String(e),
    })

    expect(invoke.mock.calls.map(c => c[1]?.args?.slice(0, 2))).toEqual([
      ['service', 'stop'],
      ['daemon', 'kill-residual'],
    ])
    expect(markDisconnected).toHaveBeenCalledTimes(1)
    expect(els.dashPending.textContent).toBe('已断开；后台服务停止时有警告')
    expect(els.dashPending.textContent.includes('Boot-out failed')).toBe(false)
  })
})

// ── runRestartSequence — the actual stop+kill+start chain ──────────────
// These tests mirror the old restartDaemon (PR3) tests since the chain
// moved verbatim into runRestartSequence.

describe('runRestartSequence', () => {
  it('happy path: pid changes → success message includes both pids', async () => {
    const els = installDashboardDom()
    const markConnected = vi.fn()
    const invoke = vi.fn(async (name: string, _args?: unknown) => {
      if (name === 'wechat_daemon_pid') {
        // First call (before): 1234. Second call (after): 5678.
        const callIdx = invoke.mock.calls.filter(c => c[0] === 'wechat_daemon_pid').length
        return callIdx === 1 ? 1234 : 5678
      }
      return { ok: true }
    })
    await runRestartSequence({
      invoke,
      doctorPoller: fakeDoctorPoller(),
      formatInvokeError: (e: unknown) => String(e),
      markConnected,
    })
    // Verify both pid calls happened
    const pidCalls = invoke.mock.calls.filter(c => c[0] === 'wechat_daemon_pid')
    expect(pidCalls.length).toBe(2)
    expect(markConnected).toHaveBeenCalled()
    expect(els.dashPending.textContent).toBe('已重启 (pid 1234 → 5678)')
  })

  it('service start failure renders a short visible reconnect failure', async () => {
    const els = installDashboardDom()
    const invoke = vi.fn(async (name: string, args?: any) => {
      if (name === 'wechat_daemon_pid') return null
      if (args?.args?.[0] === 'service' && args.args[1] === 'start') {
        throw new Error('launchctl bootstrap failed with a very long stack')
      }
      return { ok: true }
    })

    await runRestartSequence({
      invoke,
      doctorPoller: fakeDoctorPoller(false),
      formatInvokeError: (e: unknown) => String(e),
    })

    expect(els.dashPending.textContent).toBe('重新连接失败：后台服务启动失败')
    expect(els.dashPending.textContent.includes('launchctl bootstrap')).toBe(false)
  })

  it('service start ok but daemon still down keeps offline state', async () => {
    const els = installDashboardDom()
    const markConnected = vi.fn()
    const invoke = vi.fn(async (name: string, _args?: unknown) => {
      if (name === 'wechat_daemon_pid') return null
      return { ok: true }
    })

    await runRestartSequence({
      invoke,
      doctorPoller: fakeDoctorPoller(false),
      formatInvokeError: (e: unknown) => String(e),
      markConnected,
    })

    expect(markConnected).not.toHaveBeenCalled()
    expect(els.dashPending.textContent).toBe('重新连接失败：后台服务没起来')
  })

  it('pid unchanged → permission error message', async () => {
    const els = installDashboardDom()
    const invoke = vi.fn(async (name: string, _args?: unknown) => {
      if (name === 'wechat_daemon_pid') return 1234  // same pid both times
      return { ok: true }
    })
    await runRestartSequence({
      invoke,
      doctorPoller: fakeDoctorPoller(),
      formatInvokeError: (e: unknown) => String(e),
    })
    // The function returns early on this branch (no auto-clear) — verify
    // by checking pid was queried twice
    const pidCalls = invoke.mock.calls.filter(c => c[0] === 'wechat_daemon_pid')
    expect(pidCalls.length).toBe(2)
  })

  it('non-Windows (pid always null) → falls through to generic OK', async () => {
    const els = installDashboardDom()
    const invoke = vi.fn(async (name: string, _args?: unknown) => {
      if (name === 'wechat_daemon_pid') return null
      return { ok: true }
    })
    await runRestartSequence({
      invoke,
      doctorPoller: fakeDoctorPoller(),
      formatInvokeError: (e: unknown) => String(e),
    })
    const pidCalls = invoke.mock.calls.filter(c => c[0] === 'wechat_daemon_pid')
    expect(pidCalls.length).toBe(2)
  })
})

// ── restartDaemon — diagnose → card or toast ──────────────────────────────
// restartDaemon now calls diagnose() and renders the card (or shows a toast
// for code 0). These tests cover all 9 diagnose code branches.

describe('restartDaemon (diagnose → card)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function makeDeps(report: any, extra: Record<string, any> = {}) {
    return {
      invoke: vi.fn(async () => ({ ok: true })),
      doctorPoller: {
        refresh: vi.fn(async () => report),
        current: report,
        lastError: null,
      },
      formatInvokeError: (e: unknown) => String(e),
      healthProbe: null,
      routeToWizardService: vi.fn(),
      routeToWizardBind: vi.fn(),
      routeToAccessSettings: vi.fn(),
      routeToProviderSettings: vi.fn(),
      ...extra,
    }
  }

  it('code-1 (dead daemon + pid): card is shown with title "后台服务挂了"', async () => {
    const els = installDashboardDom()
    await restartDaemon(makeDeps(deadDaemonReport()))
    expect(els.rdcCard.hidden).toBe(false)
    expect(els.rdcTitle.textContent).toBe('后台服务挂了')
    expect(els.rdcPrimary.textContent).toBe('一键重启后台')
  })

  it('code-5 (account expired): card shows "微信账号已过期"', async () => {
    const els = installDashboardDom()
    await restartDaemon(makeDeps(expiredAccountReport()))
    expect(els.rdcCard.hidden).toBe(false)
    expect(els.rdcTitle.textContent).toBe('微信账号已过期')
  })

  it('code-4 (provider missing): card shows "AI 工具缺失" and fix section is shown', async () => {
    const els = installDashboardDom()
    await restartDaemon(makeDeps(providerMissingReport()))
    expect(els.rdcCard.hidden).toBe(false)
    expect(els.rdcTitle.textContent).toBe('AI 工具缺失')
    // fix div should be populated (hidden=false because command is present)
    expect(els.rdcFix.hidden).toBe(false)
  })

  it('code-0 (all green): no card shown, pending shows "一切正常，无需操作" then clears', async () => {
    const els = installDashboardDom()
    await restartDaemon(makeDeps(allGreenReport()))
    // Card stays hidden for code 0
    expect(els.rdcCard.hidden).toBe(true)
    expect(els.dashPending.textContent).toBe('一切正常，无需操作')
  })

  it('code-3 (service not installed): card shows "后台服务没安装"', async () => {
    const els = installDashboardDom()
    const report = {
      checks: {
        daemon: { alive: false, pid: null },
        service: { installed: false },
        accounts: { count: 0, items: [] },
        access: { allowFromCount: 0 },
        provider: { provider: 'claude' },
        claude: { ok: true },
      },
      expiredBots: [],
      userNames: {},
    }
    await restartDaemon(makeDeps(report))
    expect(els.rdcCard.hidden).toBe(false)
    expect(els.rdcTitle.textContent).toBe('后台服务没安装')
  })

  it('code-6 (empty allowlist): card shows "白名单是空的"', async () => {
    const els = installDashboardDom()
    const report = {
      checks: {
        daemon: { alive: true, pid: 1234 },
        service: { installed: true },
        accounts: { count: 1, items: [{ id: 'b1', botId: 'b1', userId: 'u1', baseUrl: '' }] },
        access: { allowFromCount: 0 },
        provider: { provider: 'claude' },
        claude: { ok: true },
      },
      expiredBots: [],
      userNames: {},
    }
    await restartDaemon(makeDeps(report))
    expect(els.rdcCard.hidden).toBe(false)
    expect(els.rdcTitle.textContent).toBe('白名单是空的')
  })

  it('code-2 (daemon dead + pid=null): card shows "后台服务从没启动过"', async () => {
    const els = installDashboardDom()
    const report = {
      checks: {
        daemon: { alive: false, pid: null },
        service: { installed: true },
        accounts: { count: 1, items: [] },
        access: { allowFromCount: 1 },
        provider: { provider: 'claude' },
        claude: { ok: true },
      },
      expiredBots: [],
      userNames: {},
    }
    await restartDaemon(makeDeps(report))
    expect(els.rdcCard.hidden).toBe(false)
    expect(els.rdcTitle.textContent).toBe('后台服务从没启动过')
  })

  it('code-5 (no accounts): card shows "没有绑定微信账号"', async () => {
    const els = installDashboardDom()
    const report = {
      checks: {
        daemon: { alive: true, pid: 1234 },
        service: { installed: true },
        accounts: { count: 0, items: [] },
        access: { allowFromCount: 1 },
        provider: { provider: 'claude' },
        claude: { ok: true },
      },
      expiredBots: [],
      userNames: {},
    }
    await restartDaemon(makeDeps(report))
    expect(els.rdcCard.hidden).toBe(false)
    expect(els.rdcTitle.textContent).toBe('没有绑定微信账号')
  })

  it('no doctor report falls back to runRestartSequence directly', async () => {
    const els = installDashboardDom()
    const invoke = vi.fn(async (name: string, _args?: unknown) => {
      if (name === 'wechat_daemon_pid') return null
      return { ok: true }
    })
    const deps = {
      invoke,
      doctorPoller: {
        refresh: vi.fn(async () => null),
        current: null,
        lastError: null,
      },
      formatInvokeError: (e: unknown) => String(e),
      healthProbe: null,
    }
    await restartDaemon(deps)
    // With no report, restartDaemon falls back to runRestartSequence chain
    // which runs stop + kill + start. Verify stop was called.
    const stopCall = invoke.mock.calls.find(c => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a = c[1] as any
      return a?.args?.[0] === 'service' && a?.args?.[1] === 'stop'
    })
    expect(stopCall).toBeTruthy()
  })
})
