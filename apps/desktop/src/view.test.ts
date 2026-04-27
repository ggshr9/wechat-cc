import { describe, expect, it } from 'vitest'
import { doctorRows, pollAdvance, daemonStatusLine, escapeHtml } from './view.js'

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
