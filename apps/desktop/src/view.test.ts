import { describe, expect, it } from 'vitest'
import {
  doctorRows, pollAdvance, daemonStatusLine, escapeHtml,
  initialMode, dashboardHero, accountRows, configRows, formatRelativeTime,
  updateProbeLine, updateApplyLine,
} from './view.js'

function fakeReport(overrides: Record<string, any> = {}): any {
  const base = {
    ready: false,
    stateDir: '~/.claude/channels/wechat',
    checks: {
      bun: { ok: true, path: '/usr/bin/bun' },
      git: { ok: true, path: '/usr/bin/git' },
      claude: { ok: true, path: '/usr/local/bin/claude' },
      codex: { ok: false, path: null },
      accounts: { ok: false, count: 0, items: [] },
      access: { ok: false, dmPolicy: 'allowlist', allowFromCount: 0 },
      provider: { ok: true, provider: 'claude', binaryPath: '/usr/local/bin/claude' },
      daemon: { alive: false, pid: null },
    },
  }
  return { ...base, ...overrides, checks: { ...base.checks, ...(overrides.checks ?? {}) } }
}

describe('doctorRows', () => {
  it('flattens checks into [name, {ok, path}] tuples in display order', () => {
    const rows = doctorRows({
      checks: {
        bun: { ok: true, path: '/opt/homebrew/bin/bun' },
        git: { ok: true, path: '/usr/bin/git' },
        claude: { ok: true, path: '/c' },
        codex: { ok: false, path: null },
        accounts: { ok: true, count: 1, items: [] },
        access: { ok: true, allowFromCount: 1 },
        provider: { ok: true, provider: 'claude' },
        daemon: { alive: false, pid: null },
      },
    })
    expect(rows.map(([name]) => name)).toEqual([
      'Bun', 'Git', 'Claude', 'Codex', '微信账号', 'Allowlist', 'Provider', 'Daemon',
    ])
    expect(rows[4][1]).toEqual({ ok: true, path: '1 个账号' })
    expect(rows[7][1]).toEqual({ ok: false, path: 'stopped' })
  })

  it('shows live pid in Daemon row when alive', () => {
    const rows = doctorRows({
      checks: {
        bun: { ok: true, path: '' }, git: { ok: true, path: '' }, claude: { ok: true, path: '' }, codex: { ok: true, path: '' },
        accounts: { ok: true, count: 0, items: [] }, access: { ok: true, allowFromCount: 0 },
        provider: { ok: true, provider: 'claude' },
        daemon: { alive: true, pid: 4321 },
      },
    })
    expect(rows[7][1]).toEqual({ ok: true, path: 'pid 4321' })
  })
})

describe('pollAdvance', () => {
  it('wait → no UI change', () => {
    expect(pollAdvance({}, { status: 'wait' })).toEqual({ stopTimer: false })
  })
  it('scaned → updates copy, keeps polling', () => {
    expect(pollAdvance({}, { status: 'scaned' })).toMatchObject({
      stopTimer: false, qrTitle: '手机确认', continueEnabled: false,
    })
  })
  it('scaned_but_redirect → carries baseUrl forward', () => {
    expect(pollAdvance({}, { status: 'scaned_but_redirect', baseUrl: 'https://x' })).toEqual({
      stopTimer: false, currentBaseUrl: 'https://x',
    })
  })
  it('confirmed → stops timer + enables continue + names accountId', () => {
    expect(pollAdvance({}, { status: 'confirmed', accountId: 'bot-1' })).toMatchObject({
      stopTimer: true, qrTitle: '绑定成功', qrMessage: 'bot-1 已保存。', continueEnabled: true,
    })
  })
  it('expired → stops timer + tells user to refresh', () => {
    expect(pollAdvance({}, { status: 'expired' })).toMatchObject({
      stopTimer: true, qrTitle: '二维码过期', continueEnabled: false,
    })
  })
})

describe('daemonStatusLine', () => {
  it('warn class + 未运行 when daemon dead', () => {
    expect(daemonStatusLine({ alive: false, pid: null })).toEqual({ cls: 'warn', text: '未运行' })
  })
  it('ok class + 运行中 with pid when daemon alive', () => {
    expect(daemonStatusLine({ alive: true, pid: 99 })).toEqual({ cls: 'ok', text: '运行中 pid=99' })
  })
})

describe('escapeHtml', () => {
  it('escapes the standard XSS vector chars', () => {
    expect(escapeHtml(`<script>alert("x")</script>`)).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
  })
})

describe('initialMode', () => {
  it('routes to dashboard when an account is bound and provider is ok', () => {
    expect(initialMode(fakeReport({ checks: { accounts: { ok: true, count: 1, items: [] } } })))
      .toEqual({ mode: 'dashboard' })
  })
  it('parks at doctor step if bun missing', () => {
    expect(initialMode(fakeReport({ checks: { bun: { ok: false, path: null } } })))
      .toEqual({ mode: 'wizard', step: 'doctor' })
  })
  it('parks at provider step if provider binary missing', () => {
    expect(initialMode(fakeReport({ checks: { provider: { ok: false, provider: 'claude', binaryPath: null } } })))
      .toEqual({ mode: 'wizard', step: 'provider' })
  })
  it('parks at wechat step if no accounts yet', () => {
    expect(initialMode(fakeReport()))
      .toEqual({ mode: 'wizard', step: 'wechat' })
  })
})

describe('dashboardHero', () => {
  it('alive → running with pid + account count', () => {
    expect(dashboardHero({ alive: true, pid: 4321 }, 3))
      .toEqual({ headline: 'running', tone: 'ok', meta1: 'pid 4321', meta2: '3 accounts live' })
  })
  it('alive with single account → singular copy', () => {
    expect(dashboardHero({ alive: true, pid: 7 }, 1).meta2).toBe('1 account live')
  })
  it('stale pid → warn tone', () => {
    expect(dashboardHero({ alive: false, pid: 99 }, 0).tone).toBe('warn')
    expect(dashboardHero({ alive: false, pid: 99 }, 0).headline).toBe('stale')
  })
  it('no pid → stopped', () => {
    expect(dashboardHero({ alive: false, pid: null }, 0).headline).toBe('stopped')
  })
})

describe('accountRows', () => {
  it('uses friendly name from user_names.json when present', () => {
    const rows = accountRows(
      [{ id: 'abc-im-bot', botId: 'abc@im.bot', userId: 'u@x', baseUrl: '' }],
      { 'u@x': '旺仔' }
    )
    expect(rows[0].name).toBe('旺仔')
  })
  it('falls back to short bot id (dir name minus -im-bot) when no friendly name', () => {
    const rows = accountRows([{ id: 'abc-im-bot', botId: 'abc@im.bot', userId: 'u@x', baseUrl: '' }])
    expect(rows[0].name).toBe('abc')
  })
  it('returns empty array when no accounts bound', () => {
    expect(accountRows([])).toEqual([])
  })
  it('marks rows whose botId appears in expiredBots as warn + 已过期', () => {
    const rows = accountRows(
      [
        { id: 'live-im-bot', botId: 'live@im.bot', userId: 'u1', baseUrl: '' },
        { id: 'dead-im-bot', botId: 'dead@im.bot', userId: 'u2', baseUrl: '' },
      ],
      {},
      [{ botId: 'dead-im-bot', firstSeenExpiredAt: '2026-04-26T00:00:00Z' }],
      Date.parse('2026-04-26T03:30:00Z'),
    )
    expect(rows[0].badge).toEqual({ tone: 'ok', label: 'active' })
    expect(rows[1].expired).toBe(true)
    expect(rows[1].badge.tone).toBe('warn')
    expect(rows[1].badge.label).toMatch(/已过期/)
    expect(rows[1].badge.label).toMatch(/3 小时前/)
  })
})

describe('formatRelativeTime', () => {
  const NOW = Date.parse('2026-04-26T12:00:00Z')
  it('< 60s → 刚刚', () => {
    expect(formatRelativeTime('2026-04-26T11:59:30Z', NOW)).toBe('刚刚')
  })
  it('< 60m → minutes', () => {
    expect(formatRelativeTime('2026-04-26T11:45:00Z', NOW)).toBe('15 分钟前')
  })
  it('< 24h → hours', () => {
    expect(formatRelativeTime('2026-04-26T08:00:00Z', NOW)).toBe('4 小时前')
  })
  it('>= 24h → days', () => {
    expect(formatRelativeTime('2026-04-23T12:00:00Z', NOW)).toBe('3 天前')
  })
})

describe('configRows', () => {
  it('returns the four config rows in stable order', () => {
    const rows = configRows(fakeReport(), '~/.claude/channels/wechat')
    expect(rows.map(r => r[0])).toEqual(['Provider', 'Provider binary', 'Allowlist', 'State directory'])
  })
})

describe('updateProbeLine', () => {
  it('clean + behind=3 → info tone with sha→sha and lockfile note', () => {
    const line = updateProbeLine({
      ok: true, mode: 'check', currentCommit: 'aaaaaaa1234', latestCommit: 'bbbbbbb5678',
      behind: 3, aheadOfRemote: 0, lockfileWillChange: true, dirty: false, dirtyFiles: [], updateAvailable: true,
    })
    expect(line.tone).toBe('info')
    expect(line.headline).toContain('3 commits')
    expect(line.headline).toContain('依赖更新')
    expect(line.body).toContain('aaaaaaa')
    expect(line.body).toContain('bbbbbbb')
  })

  it('up to date → ok tone', () => {
    const line = updateProbeLine({
      ok: true, mode: 'check', currentCommit: 'abcdef0', latestCommit: 'abcdef0',
      behind: 0, aheadOfRemote: 0, lockfileWillChange: false, dirty: false, dirtyFiles: [], updateAvailable: false,
    })
    expect(line.tone).toBe('ok')
    expect(line.headline).toContain('已是最新')
  })

  it('dirty tree → warn tone with file count', () => {
    const line = updateProbeLine({
      ok: true, mode: 'check', currentCommit: 'abcdef0', latestCommit: 'fedcba9',
      behind: 1, aheadOfRemote: 0, lockfileWillChange: false, dirty: true, dirtyFiles: ['cli.ts', 'README.md'], updateAvailable: true,
    })
    expect(line.tone).toBe('warn')
    expect(line.headline).toContain('未提交')
    expect(line.body).toContain('2')
  })

  it('aheadOfRemote > 0 → warn tone (would diverge)', () => {
    const line = updateProbeLine({
      ok: true, mode: 'check', currentCommit: 'abc', latestCommit: 'def',
      behind: 0, aheadOfRemote: 5, lockfileWillChange: false, dirty: false, dirtyFiles: [], updateAvailable: false,
    })
    expect(line.tone).toBe('warn')
    expect(line.headline).toContain('领先')
    expect(line.headline).toContain('5')
  })

  it('fetch_failed (generic network) → bad tone', () => {
    const line = updateProbeLine({ ok: false, mode: 'check', reason: 'fetch_failed', message: 'network unreachable' })
    expect(line.tone).toBe('bad')
    expect(line.headline).toContain('检查失败')
  })

  it('not_a_git_repo (desktop bundle short-circuit) → hide tone', () => {
    const line = updateProbeLine({
      ok: false, mode: 'check', reason: 'not_a_git_repo',
      message: 'no git repo at this binary\'s location',
      details: { repoRoot: '/Applications/wechat-cc.app/Contents/MacOS' },
    })
    expect(line.tone).toBe('hide')
  })

  it('null/undefined probe → warn placeholder', () => {
    expect(updateProbeLine(null).tone).toBe('warn')
    expect(updateProbeLine(undefined).tone).toBe('warn')
  })
})

describe('updateApplyLine', () => {
  it('happy path with restart → ok tone', () => {
    const line = updateApplyLine({
      ok: true, mode: 'apply', fromCommit: 'aaaaaaa1', toCommit: 'bbbbbbb2',
      lockfileChanged: true, installRan: true, daemonAction: 'restarted', elapsedMs: 8000,
    })
    expect(line.tone).toBe('ok')
    expect(line.headline).toContain('aaaaaaa')
    expect(line.headline).toContain('bbbbbbb')
    expect(line.body).toContain('依赖')
  })

  it('restart_failed → warn tone with manual recovery hint', () => {
    const line = updateApplyLine({
      ok: true, mode: 'apply', fromCommit: 'a', toCommit: 'b',
      lockfileChanged: false, installRan: false, daemonAction: 'restart_failed', elapsedMs: 0,
    })
    expect(line.tone).toBe('warn')
    expect(line.body).toContain('手动重启')
  })

  it('daemonAction=noop on success → ok tone, no restart text', () => {
    const line = updateApplyLine({
      ok: true, mode: 'apply', fromCommit: 'a', toCommit: 'b',
      lockfileChanged: false, installRan: false, daemonAction: 'noop', elapsedMs: 0,
    })
    expect(line.tone).toBe('ok')
    expect(line.body).toContain('未做重启')
  })

  it('dirty_tree reject → warn tone with file list (truncated)', () => {
    const line = updateApplyLine({
      ok: false, mode: 'apply', reason: 'dirty_tree',
      message: 'working tree has uncommitted changes',
      details: { dirtyFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'] },
    })
    expect(line.tone).toBe('warn')
    expect(line.body).toContain('a.ts')
    expect(line.body).toContain('5 个')
  })

  it('diverged reject → warn tone', () => {
    const line = updateApplyLine({ ok: false, mode: 'apply', reason: 'diverged', message: 'x' })
    expect(line.tone).toBe('warn')
    expect(line.headline).toContain('领先')
  })

  it('daemon_running_not_service reject → bad tone with Ctrl+C hint', () => {
    const line = updateApplyLine({ ok: false, mode: 'apply', reason: 'daemon_running_not_service', message: 'x' })
    expect(line.tone).toBe('bad')
    expect(line.body).toContain('Ctrl+C')
  })

  it('all 9 reasons map to a non-default headline', () => {
    const reasons = [
      'dirty_tree', 'diverged', 'detached_head', 'fetch_failed',
      'pull_conflict', 'install_failed', 'bun_missing',
      'daemon_running_not_service', 'service_stop_failed',
    ]
    for (const reason of reasons) {
      const line = updateApplyLine({ ok: false, mode: 'apply', reason, message: 'x' })
      expect(line.headline).not.toBe('升级失败')  // generic fallback
      expect(['warn', 'bad']).toContain(line.tone)
    }
  })
})
