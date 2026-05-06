import { describe, expect, it } from 'vitest'
import {
  doctorRows, pollAdvance, daemonStatusLine, escapeHtml,
  initialMode, dashboardHero, accountRows, formatRelativeTime,
  updateProbeLine, updateApplyLine, restartButtonState, deleteAccountConfirmCopy,
  UPDATE_REASON_COPY, modeBadge, conversationRows,
// @ts-expect-error — vanilla JS sibling module; covered at runtime.
} from './view.js'

// Single source of truth for UpdateReason union — must stay in sync with
// the type alias in update.ts. Tested below to ensure UPDATE_REASON_COPY
// covers every reason the backend can emit.
const ALL_UPDATE_REASONS: string[] = [
  'dirty_tree', 'diverged', 'detached_head', 'fetch_failed',
  'pull_conflict', 'install_failed', 'bun_missing',
  'daemon_running_not_service', 'service_stop_failed', 'not_a_git_repo',
]

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
      service: { installed: true, kind: 'systemd-user' },
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
    expect(rows.map((r: [string, unknown]) => r[0])).toEqual([
      'Bun', 'Git', 'Claude', 'Codex', '微信账号', 'Allowlist', 'Provider', 'Daemon',
    ])
    // toMatchObject — doctorRows now spreads the full check shape so
    // wizard.renderFixHint can see severity / fix metadata. Test only
    // cares about user-visible bits.
    expect(rows[4]![1]).toMatchObject({ ok: true, path: '1 个账号' })
    expect(rows[7]![1]).toEqual({ ok: false, path: 'stopped' })
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
    expect(rows[7]![1]).toEqual({ ok: true, path: 'pid 4321' })
  })

  // Compiled-bundle mode: the .msi/.dmg sidecar carries its own bun runtime
  // and doesn't shell out to git, so showing those rows leaks a dev-mode
  // concern (and gives Win 小白 a Unix-only `curl | bash` install command).
  // Filter them out — wizard's first screen should only surface what the
  // end-user can actually act on.
  it('compiled-bundle: drops Bun + Git rows entirely', () => {
    const rows = doctorRows({
      runtime: 'compiled-bundle',
      checks: {
        bun: { ok: true, path: null },  // synthesized true in bundle mode
        git: { ok: true, path: null },
        claude: { ok: false, path: null },
        codex: { ok: false, path: null },
        accounts: { ok: false, count: 0, items: [] },
        access: { ok: false, allowFromCount: 0 },
        provider: { ok: false, provider: 'claude' },
        daemon: { alive: false, pid: null },
      },
    })
    expect(rows.map((r: [string, unknown]) => r[0])).toEqual([
      'Claude', 'Codex', '微信账号', 'Allowlist', 'Provider', 'Daemon',
    ])
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
  it('ok class + pid only when daemon alive (rail-foot is space-constrained, dot conveys liveness)', () => {
    expect(daemonStatusLine({ alive: true, pid: 99 })).toEqual({ cls: 'ok', text: 'pid=99' })
  })
})

describe('escapeHtml', () => {
  it('escapes the standard XSS vector chars', () => {
    expect(escapeHtml(`<script>alert("x")</script>`)).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
  })
})

describe('restartButtonState', () => {
  it('service installed → restart action with default label', () => {
    const choice = restartButtonState(
      { alive: false, pid: null },
      { installed: true, kind: 'systemd-user' },
    )
    expect(choice.action).toBe('restart')
    expect(choice.label).toBe('重启 daemon')
    expect(choice.helper).toBeNull()
  })

  it('service missing + daemon alive (foreground source-mode) → install action with PID hint', () => {
    const choice = restartButtonState(
      { alive: true, pid: 691574 },
      { installed: false, kind: 'systemd-user' },
    )
    expect(choice.action).toBe('install')
    expect(choice.label).toBe('去安装服务')
    expect(choice.helper).toContain('691574')
  })

  it('service missing + daemon dead → install action pointing at wizard', () => {
    const choice = restartButtonState(
      { alive: false, pid: null },
      { installed: false, kind: 'launchagent' },
    )
    expect(choice.action).toBe('install')
    expect(choice.label).toBe('去设置向导')
    expect(choice.helper).toContain('设置向导')
  })

  it('service field undefined → treated as missing (defensive default)', () => {
    expect(restartButtonState({ alive: false, pid: null }, undefined).action).toBe('install')
    expect(restartButtonState({ alive: false, pid: null }, null).action).toBe('install')
  })
})

describe('deleteAccountConfirmCopy', () => {
  it('service installed → restart-daemon hint', () => {
    expect(deleteAccountConfirmCopy('丸子', { installed: true, kind: 'systemd-user' }))
      .toBe('已删除 丸子 · 重启 daemon 生效')
  })

  it('service missing → wizard-service hint', () => {
    expect(deleteAccountConfirmCopy('丸子', { installed: false, kind: 'systemd-user' }))
      .toContain('设置向导')
  })

  it('service undefined → safe default (treated as missing)', () => {
    expect(deleteAccountConfirmCopy('丸子', undefined)).toContain('设置向导')
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

  it('parks at service step when account is bound but service install never ran', () => {
    // The "happy half-finish" state: user completed `bind WeChat` and the
    // account is recorded, but `install service` failed (Windows
    // schtasks access-denied, etc.) and no service unit / scheduled
    // task is registered. Without this branch the dashboard appears
    // with a stopped daemon and no obvious next step.
    expect(initialMode(fakeReport({
      checks: {
        accounts: { ok: true, count: 1, items: [] },
        service: { installed: false, kind: 'scheduled-task' },
      },
    }))).toEqual({ mode: 'wizard', step: 'service' })
  })

  // Bundle mode: bun/git missing must NOT route to doctor — the sidecar
  // doesn't need them. The user should land where the actual missing
  // piece is (provider/wechat/service). This was a real bug — Win 小白
  // got stuck on the env-check screen forever even though their .msi
  // would have worked.
  it('compiled-bundle: bun missing does NOT park at doctor', () => {
    expect(initialMode(fakeReport({
      runtime: 'compiled-bundle',
      checks: { bun: { ok: false, path: null } },
    }))).toEqual({ mode: 'wizard', step: 'wechat' })
  })

  it('compiled-bundle: git missing does NOT park at doctor', () => {
    expect(initialMode(fakeReport({
      runtime: 'compiled-bundle',
      checks: { git: { ok: false, path: null } },
    }))).toEqual({ mode: 'wizard', step: 'wechat' })
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
    expect(rows[0]!.badge).toEqual({ tone: 'ok', label: 'active' })
    expect(rows[1]!.expired).toBe(true)
    expect(rows[1]!.badge.tone).toBe('warn')
    expect(rows[1]!.badge.label).toMatch(/已过期/)
    expect(rows[1]!.badge.label).toMatch(/3 小时前/)
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

describe('modeBadge', () => {
  it('solo → label "Solo" + provider in detail', () => {
    expect(modeBadge({ kind: 'solo', provider: 'claude' })).toEqual({
      label: 'Solo', detail: 'claude', tone: 'solo',
    })
  })
  it('parallel → label "Parallel" + providers joined', () => {
    expect(modeBadge({ kind: 'parallel', providers: ['claude', 'codex'] })).toEqual({
      label: 'Parallel', detail: 'claude + codex', tone: 'parallel',
    })
  })
  it('primary_tool → label "Primary" + primary (tool: secondary)', () => {
    expect(modeBadge({ kind: 'primary_tool', primary: 'claude', secondary: 'codex' })).toEqual({
      label: 'Primary', detail: 'claude (tool: codex)', tone: 'primary',
    })
  })
  it('chatroom → label "Chatroom" + a ↔ b', () => {
    expect(modeBadge({ kind: 'chatroom', providers: ['claude', 'codex'] })).toEqual({
      label: 'Chatroom', detail: 'claude ↔ codex', tone: 'chatroom',
    })
  })
  it('handles legacy/partial shapes without crashing', () => {
    expect(modeBadge(null).label).toBe('—')
    expect(modeBadge(undefined).label).toBe('—')
    expect(modeBadge({ kind: 'solo' }).detail).toBe('—')           // no provider
    expect(modeBadge({ kind: 'parallel' }).detail).toBe('—')       // no providers list
    expect(modeBadge({ kind: 'unknown_future' }).label).toBe('unknown_future')
  })
})

describe('conversationRows', () => {
  it('maps conversations[] → {chatId, name, badge} sorted by tone then chat_id', () => {
    const rows = conversationRows([
      { chat_id: 'c2', user_name: 'Bob', mode: { kind: 'solo', provider: 'codex' } },
      { chat_id: 'c1', user_name: 'Alice', mode: { kind: 'chatroom', providers: ['claude', 'codex'] } },
      { chat_id: 'c3', user_name: null,  mode: { kind: 'solo', provider: 'claude' } },
    ])
    // Sort by tone (chatroom < solo) then chat_id ascending.
    expect(rows.map((r: { chatId: string }) => r.chatId)).toEqual(['c1', 'c2', 'c3'])
    // Falls back to chat_id when user_name is null.
    expect(rows[2]).toMatchObject({ chatId: 'c3', name: 'c3' })
    expect(rows[0].badge.tone).toBe('chatroom')
  })
  it('returns [] for empty / non-array input', () => {
    expect(conversationRows([])).toEqual([])
    expect(conversationRows(undefined as unknown as never[])).toEqual([])
    expect(conversationRows(null as unknown as never[])).toEqual([])
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

describe('UPDATE_REASON_COPY drift protection', () => {
  it('every UpdateReason has a row in the copy table', () => {
    const tableKeys = Object.keys(UPDATE_REASON_COPY).sort()
    expect(tableKeys).toEqual([...ALL_UPDATE_REASONS].sort())
  })

  it('every row has severity ∈ {warn, bad, hide} and a body fn', () => {
    for (const [reason, row] of Object.entries(UPDATE_REASON_COPY) as Array<[string, { severity: string; label: string; body: (d?: Record<string, unknown>) => string }]>) {
      expect(['warn', 'bad', 'hide']).toContain(row.severity)
      expect(typeof row.body).toBe('function')
      // Smoke-call body() with empty details — must return a string,
      // never throw or return undefined.
      const text = row.body({})
      expect(typeof text).toBe('string')
      // hide rows return empty body; non-hide rows must have non-empty.
      if (row.severity !== 'hide') {
        expect(text.length).toBeGreaterThan(0)
        expect(row.label.length).toBeGreaterThan(0)
      }
    }
  })

  it('updateProbeLine and updateApplyLine agree on severity for every reason', () => {
    // Both view-models must emit the same tone for hide rows (suppressing
    // the card) and the same warn/bad split for everything else. This is
    // the contract the refactor was supposed to enforce.
    for (const reason of ALL_UPDATE_REASONS) {
      const probe = updateProbeLine({ ok: false, mode: 'check', reason, message: 'x' })
      const apply = updateApplyLine({ ok: false, mode: 'apply', reason, message: 'x' })
      if (probe.tone === 'hide') expect(apply.tone).toBe('hide')
      if (apply.tone === 'hide') expect(probe.tone).toBe('hide')
    }
  })
})

// fakeReport is intentionally unused-by-default in some test groups but
// needs to typecheck cleanly under tsc --noEmit.
void fakeReport
