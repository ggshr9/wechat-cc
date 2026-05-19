import { describe, it, expect } from 'vitest'
import {
  DoctorOutput,
  SetupPollOutput,
  SetupStatusOutput,
  SetupQrJsonOutput,
  ServiceStatusOutput,
  ServiceInstallOutput,
  ServiceStartOutput,
  ServiceStopOutput,
  ServiceUninstallOutput,
  InstallProgressOutput,
  AccountRemoveOutput,
  DaemonKillOutput,
  ProviderShowOutput,
  MemoryListOutput,
  MemoryReadOutput,
  MemoryWriteOutput,
  EventsListOutput,
  ObservationsListOutput,
  ObservationsArchiveOutput,
  MilestonesListOutput,
  SessionsListProjectsOutput,
  SessionsReadJsonlOutput,
  SessionsDeleteOutput,
  SessionsSearchOutput,
  DemoSeedOutput,
  DemoUnseedOutput,
  ReplyOutput,
  LogsOutput,
  UpdateCheckOutput,
  UpdateApplyOutput,
  ConversationsListOutput,
  GuardStatusOutput,
  GuardEnableOutput,
  GuardDisableOutput,
  AvatarInfoOutput,
  AvatarSetOutput,
  AvatarRemoveOutput,
} from './schema'

describe('DoctorOutput', () => {
  it('accepts a minimal valid report', () => {
    const sample = {
      ready: false,
      stateDir: '/tmp/wechat-cc',
      runtime: 'source',
      wslDetected: false,
      checks: {
        bun: { ok: true, path: '/usr/local/bin/bun' },
        git: { ok: true, path: '/usr/bin/git' },
        claude: { ok: false, path: null, severity: 'hard', fix: { command: 'npm install -g @anthropic-ai/claude-code' } },
        codex: { ok: false, path: null, severity: 'soft' },
        accounts: { ok: false, count: 0, items: [] },
        access: { ok: false, dmPolicy: 'allowlist', allowFromCount: 0 },
        provider: { ok: false, provider: 'claude', binaryPath: null, severity: 'hard' },
        daemon: { alive: false, pid: null },
        service: { installed: false, kind: 'launchagent' },
      },
      userNames: {},
      expiredBots: [],
      nextActions: ['install_claude', 'run_wechat_setup'],
    }
    expect(DoctorOutput.safeParse(sample).success).toBe(true)
  })

  it('accepts a fully-green report with optional fields present', () => {
    const sample = {
      ready: true,
      stateDir: '/home/user/.local/share/wechat-cc',
      runtime: 'compiled-bundle',
      wslDetected: false,
      checks: {
        bun: { ok: true, path: '/usr/local/bin/bun' },
        git: { ok: true, path: '/usr/bin/git' },
        claude: { ok: true, path: '/usr/local/bin/claude' },
        codex: { ok: false, path: null, severity: 'soft' },
        accounts: {
          ok: true,
          count: 1,
          items: [{ id: 'bot1', botId: 'bot1', userId: 'user1', baseUrl: 'https://example.com' }],
        },
        access: { ok: true, dmPolicy: 'allowlist', allowFromCount: 1 },
        provider: { ok: true, provider: 'claude', model: 'claude-opus-4-5', binaryPath: '/usr/local/bin/claude' },
        daemon: { alive: true, pid: 12345 },
        service: { installed: true, kind: 'launchagent' },
      },
      userNames: { 'chat-abc': 'Alice' },
      expiredBots: [{ botId: 'old-bot', firstSeenExpiredAt: '2026-01-01T00:00:00Z', lastReason: 'session expired' }],
      nextActions: [],
    }
    expect(DoctorOutput.safeParse(sample).success).toBe(true)
  })

  it('rejects an empty object', () => {
    expect(DoctorOutput.safeParse({}).success).toBe(false)
  })

  it('rejects a report with invalid runtime value', () => {
    const sample = {
      ready: true,
      stateDir: '/tmp',
      runtime: 'invalid-runtime',
      wslDetected: false,
      checks: {
        bun: { ok: true, path: null },
        git: { ok: true, path: null },
        claude: { ok: true, path: null },
        codex: { ok: true, path: null },
        accounts: { ok: true, count: 0, items: [] },
        access: { ok: true, dmPolicy: 'allowlist', allowFromCount: 0 },
        provider: { ok: true, provider: 'claude', binaryPath: null },
        daemon: { alive: false, pid: null },
        service: { installed: false, kind: 'launchagent' },
      },
      userNames: {},
      expiredBots: [],
      nextActions: [],
    }
    expect(DoctorOutput.safeParse(sample).success).toBe(false)
  })
})

describe('SetupPollOutput', () => {
  it('accepts wait status', () => {
    expect(SetupPollOutput.safeParse({ status: 'wait' }).success).toBe(true)
  })
  it('accepts scaned status', () => {
    expect(SetupPollOutput.safeParse({ status: 'scaned' }).success).toBe(true)
  })
  it('accepts expired status', () => {
    expect(SetupPollOutput.safeParse({ status: 'expired' }).success).toBe(true)
  })
  it('accepts scaned_but_redirect with baseUrl', () => {
    expect(SetupPollOutput.safeParse({ status: 'scaned_but_redirect', baseUrl: 'https://alt.example.com' }).success).toBe(true)
  })
  it('accepts confirmed with accountId, userId, and scenario', () => {
    expect(SetupPollOutput.safeParse({ status: 'confirmed', accountId: 'bot-123', userId: 'user-456', scenario: 'first' }).success).toBe(true)
  })
  it('accepts each of the four scenario enum values on confirmed', () => {
    for (const scenario of ['first', 'reconnect', 'redundant', 'new_account'] as const) {
      expect(SetupPollOutput.safeParse({ status: 'confirmed', accountId: 'bot-123', userId: 'user-456', scenario }).success).toBe(true)
    }
  })
  it('rejects confirmed without scenario (additive field is required)', () => {
    expect(SetupPollOutput.safeParse({ status: 'confirmed', accountId: 'bot-123', userId: 'user-456' }).success).toBe(false)
  })
  it('rejects confirmed with an unknown scenario value', () => {
    expect(SetupPollOutput.safeParse({ status: 'confirmed', accountId: 'bot-123', userId: 'user-456', scenario: 'mystery' }).success).toBe(false)
  })
  it('rejects an empty payload', () => {
    expect(SetupPollOutput.safeParse({}).success).toBe(false)
  })
})

describe('SetupStatusOutput', () => {
  it('accepts the snapshot shape', () => {
    expect(SetupStatusOutput.safeParse({
      stateDir: '/tmp/wechat-cc',
      bound: true,
      accounts: [{ id: 'bot-1', botId: 'bot-1', userId: 'user-1', baseUrl: 'https://example.com' }],
      access: { dmPolicy: 'allowlist', allowFrom: ['user-1'] },
      provider: 'claude',
      daemon: { alive: true, pid: 1234 },
      service: { installed: true, kind: 'launchagent' },
    }).success).toBe(true)
  })
  it('accepts the snapshot shape with optional model field', () => {
    expect(SetupStatusOutput.safeParse({
      stateDir: '/tmp/wechat-cc',
      bound: false,
      accounts: [],
      access: { dmPolicy: 'allowlist', allowFrom: [] },
      provider: 'claude',
      model: 'claude-opus-4-5',
      daemon: { alive: false, pid: null },
      service: { installed: false, kind: 'systemd-user' },
    }).success).toBe(true)
  })
  it('rejects an empty payload', () => {
    expect(SetupStatusOutput.safeParse({}).success).toBe(false)
  })
})

describe('SetupQrJsonOutput', () => {
  it('accepts the QR payload shape', () => {
    expect(SetupQrJsonOutput.safeParse({
      qrcode: 'https://qr.example.com/token-abc',
      qrcode_img_content: 'data:image/png;base64,abc123',
      expires_in_ms: 480000,
    }).success).toBe(true)
  })
  it('rejects missing qrcode', () => {
    expect(SetupQrJsonOutput.safeParse({ qrcode_img_content: 'x', expires_in_ms: 480000 }).success).toBe(false)
  })
})

// Shared ServicePlan fixture used across service tests.
const samplePlan = {
  kind: 'launchagent',
  serviceName: 'wechat-cc',
  serviceFile: '/Users/test/Library/LaunchAgents/com.wechat-cc.daemon.plist',
  fileContent: '<?xml version="1.0"?>',
  installCommands: [['launchctl', 'bootstrap', 'gui/501', '/path/plist']],
  startCommands: [['launchctl', 'kickstart', '-k', 'gui/501/com.wechat-cc.daemon']],
  stopCommands: [['launchctl', 'bootout', 'gui/501', '/path/plist']],
  uninstallCommands: [['launchctl', 'bootout', 'gui/501', '/path/plist']],
}

const sampleAgentConfig = {
  provider: 'claude',
  dangerouslySkipPermissions: true,
  autoStart: true,
  closeStopsDaemon: false,
}

describe('ServiceStatusOutput', () => {
  it('accepts a status report', () => {
    expect(ServiceStatusOutput.safeParse({
      installed: true,
      alive: true,
      pid: 12345,
      state: 'running',
      plan: samplePlan,
      agentConfig: sampleAgentConfig,
    }).success).toBe(true)
  })
  it('rejects empty payload', () => {
    expect(ServiceStatusOutput.safeParse({}).success).toBe(false)
  })
})

describe('ServiceInstallOutput', () => {
  it('accepts success branch', () => {
    expect(ServiceInstallOutput.safeParse({
      ok: true,
      action: 'install',
      plan: samplePlan,
      agentConfig: sampleAgentConfig,
      dryRun: false,
    }).success).toBe(true)
  })
  it('accepts error branch', () => {
    expect(ServiceInstallOutput.safeParse({
      ok: false,
      error: 'launchctl bootstrap failed with exit 1',
    }).success).toBe(true)
  })
  it('rejects unknown discriminator', () => {
    expect(ServiceInstallOutput.safeParse({ ok: 'maybe' }).success).toBe(false)
  })
})

describe('ServiceStartOutput', () => {
  it('accepts success branch', () => {
    expect(ServiceStartOutput.safeParse({
      ok: true,
      action: 'start',
      plan: samplePlan,
      agentConfig: sampleAgentConfig,
      dryRun: false,
    }).success).toBe(true)
  })
  it('accepts error branch', () => {
    expect(ServiceStartOutput.safeParse({
      ok: false,
      error: 'launchctl kickstart failed with exit 113',
    }).success).toBe(true)
  })
  it('rejects unknown discriminator', () => {
    expect(ServiceStartOutput.safeParse({ ok: 'maybe' }).success).toBe(false)
  })
})

describe('ServiceStopOutput', () => {
  it('accepts success branch', () => {
    expect(ServiceStopOutput.safeParse({
      ok: true,
      action: 'stop',
      plan: samplePlan,
      agentConfig: sampleAgentConfig,
      dryRun: false,
    }).success).toBe(true)
  })
  it('accepts error branch', () => {
    expect(ServiceStopOutput.safeParse({
      ok: false,
      error: 'launchctl bootout failed',
    }).success).toBe(true)
  })
  it('rejects unknown discriminator', () => {
    expect(ServiceStopOutput.safeParse({ ok: 'maybe' }).success).toBe(false)
  })
})

describe('ServiceUninstallOutput', () => {
  it('accepts success branch', () => {
    expect(ServiceUninstallOutput.safeParse({
      ok: true,
      action: 'uninstall',
      plan: samplePlan,
      agentConfig: sampleAgentConfig,
      dryRun: true,
    }).success).toBe(true)
  })
  it('accepts error branch', () => {
    expect(ServiceUninstallOutput.safeParse({
      ok: false,
      error: 'plist file removal failed',
    }).success).toBe(true)
  })
  it('rejects unknown discriminator', () => {
    expect(ServiceUninstallOutput.safeParse({ ok: 'maybe' }).success).toBe(false)
  })
})

describe('InstallProgressOutput', () => {
  it('accepts a progress event', () => {
    expect(InstallProgressOutput.safeParse({
      step: 2,
      total: 4,
      label: 'launchctl bootstrap',
      ts: 1714900000000,
    }).success).toBe(true)
  })
  it('rejects empty payload (no install in flight yields {}, not this schema)', () => {
    expect(InstallProgressOutput.safeParse({}).success).toBe(false)
  })
})

describe('AccountRemoveOutput', () => {
  it('accepts success branch', () => {
    expect(AccountRemoveOutput.safeParse({
      ok: true,
      botId: 'abc123-im-bot',
      removed: ['accounts/abc123-im-bot/', 'context_tokens.json[user-1]'],
      warnings: [],
      restartRequired: true,
    }).success).toBe(true)
  })
  it('accepts error branch', () => {
    expect(AccountRemoveOutput.safeParse({
      ok: false,
      error: 'invalid bot id: ../evil',
    }).success).toBe(true)
  })
  it('rejects unknown discriminator', () => {
    expect(AccountRemoveOutput.safeParse({ ok: 'maybe' }).success).toBe(false)
  })
})

describe('DaemonKillOutput', () => {
  it('accepts killed=true branch', () => {
    expect(DaemonKillOutput.safeParse({
      killed: true,
      pid: 12345,
      message: 'killed (SIGTERM)',
    }).success).toBe(true)
  })
  it('accepts killed=false branch', () => {
    expect(DaemonKillOutput.safeParse({
      killed: false,
      pid: 99999,
      message: 'pid 99999 not found',
    }).success).toBe(true)
  })
  it('rejects unknown discriminator', () => {
    expect(DaemonKillOutput.safeParse({ killed: 'yes' }).success).toBe(false)
  })
})

describe('ProviderShowOutput', () => {
  it('accepts a full provider config', () => {
    expect(ProviderShowOutput.safeParse({
      provider: 'codex',
      model: 'codex-mini-latest',
      dangerouslySkipPermissions: false,
      autoStart: true,
      closeStopsDaemon: false,
    }).success).toBe(true)
  })
  it('rejects empty payload', () => {
    expect(ProviderShowOutput.safeParse({}).success).toBe(false)
  })
})

describe('MemoryListOutput', () => {
  it('accepts an empty array (no memory files)', () => {
    expect(MemoryListOutput.safeParse([]).success).toBe(true)
  })
  it('accepts an array with one user entry', () => {
    expect(MemoryListOutput.safeParse([
      {
        userId: 'o9cq80abc@im.wechat',
        fileCount: 2,
        totalBytes: 512,
        files: [
          { name: 'notes.md', path: 'notes.md', size: 256, mtime: '2026-05-01T10:00:00.000Z' },
          { name: 'context.md', path: 'sub/context.md', size: 256, mtime: '2026-05-02T11:00:00.000Z' },
        ],
      },
    ]).success).toBe(true)
  })
  it('rejects a non-array (e.g. plain object)', () => {
    expect(MemoryListOutput.safeParse({ userId: 'u1' }).success).toBe(false)
  })
})

describe('MemoryReadOutput', () => {
  it('accepts ok:true branch with userId, path, content', () => {
    expect(MemoryReadOutput.safeParse({
      ok: true,
      userId: 'o9cq80abc@im.wechat',
      path: 'notes.md',
      content: '# My notes\nHello world',
    }).success).toBe(true)
  })
  it('accepts ok:false branch with error', () => {
    expect(MemoryReadOutput.safeParse({
      ok: false,
      error: 'file not found: o9cq80abc@im.wechat/notes.md',
    }).success).toBe(true)
  })
  it('rejects unknown discriminator', () => {
    expect(MemoryReadOutput.safeParse({ ok: 'maybe' }).success).toBe(false)
  })
})

describe('MemoryWriteOutput', () => {
  it('accepts ok:true branch with userId, path, bytesWritten, created', () => {
    expect(MemoryWriteOutput.safeParse({
      ok: true,
      userId: 'o9cq80abc@im.wechat',
      path: 'notes.md',
      bytesWritten: 256,
      created: true,
    }).success).toBe(true)
  })
  it('accepts ok:false branch with error', () => {
    expect(MemoryWriteOutput.safeParse({
      ok: false,
      error: 'body too large: 102401B exceeds 102400B',
    }).success).toBe(true)
  })
  it('rejects unknown discriminator', () => {
    expect(MemoryWriteOutput.safeParse({ ok: 'maybe' }).success).toBe(false)
  })
})

// ── wechat-cc events list --json ──────────────────────────────────────────────

describe('EventsListOutput', () => {
  it('accepts ok:true with a populated events array', () => {
    expect(EventsListOutput.safeParse({
      ok: true,
      events: [
        {
          id: 'evt_abc123',
          ts: '2026-05-07T10:00:00.000Z',
          kind: 'cron_eval_pushed',
          trigger: 'daily-checkin',
          reasoning: 'User seemed stressed; sending supportive message.',
          push_text: 'Hey, just checking in on you!',
          jsonl_session_id: 'sess_xyz',
        },
        {
          id: 'evt_def456',
          ts: '2026-05-07T09:00:00.000Z',
          kind: 'observation_written',
          trigger: 'weekly-introspect',
          reasoning: 'Observed a shift in mood.',
          observation_id: 'obs_999',
        },
      ],
    }).success).toBe(true)
  })
  it('accepts ok:true with an empty events array', () => {
    expect(EventsListOutput.safeParse({ ok: true, events: [] }).success).toBe(true)
  })
  it('rejects when ok is missing', () => {
    expect(EventsListOutput.safeParse({ events: [] }).success).toBe(false)
  })
})

// ── wechat-cc observations list --json ───────────────────────────────────────

describe('ObservationsListOutput', () => {
  it('accepts ok:true with a populated observations array', () => {
    expect(ObservationsListOutput.safeParse({
      ok: true,
      observations: [
        {
          id: 'obs_abc123',
          ts: '2026-05-07T10:00:00.000Z',
          body: 'User mentioned feeling overwhelmed with work.',
          tone: 'concern',
          archived: false,
          event_id: 'evt_xyz',
        },
      ],
    }).success).toBe(true)
  })
  it('accepts ok:true with an empty observations array', () => {
    expect(ObservationsListOutput.safeParse({ ok: true, observations: [] }).success).toBe(true)
  })
  it('rejects when ok is missing', () => {
    expect(ObservationsListOutput.safeParse({ observations: [] }).success).toBe(false)
  })
})

// ── wechat-cc observations archive --json ────────────────────────────────────

describe('ObservationsArchiveOutput', () => {
  it('accepts ok:true with archived id', () => {
    expect(ObservationsArchiveOutput.safeParse({ ok: true, archived: 'obs_abc123' }).success).toBe(true)
  })
  it('rejects when archived field is missing', () => {
    expect(ObservationsArchiveOutput.safeParse({ ok: true }).success).toBe(false)
  })
  it('rejects when ok is missing', () => {
    expect(ObservationsArchiveOutput.safeParse({ archived: 'obs_abc123' }).success).toBe(false)
  })
})

// ── wechat-cc milestones list --json ─────────────────────────────────────────

describe('MilestonesListOutput', () => {
  it('accepts ok:true with a populated milestones array', () => {
    expect(MilestonesListOutput.safeParse({
      ok: true,
      milestones: [
        {
          id: 'ms_first_message',
          ts: '2026-05-01T08:00:00.000Z',
          body: 'Sent first message to this contact.',
          event_id: 'evt_abc',
        },
      ],
    }).success).toBe(true)
  })
  it('accepts ok:true with an empty milestones array', () => {
    expect(MilestonesListOutput.safeParse({ ok: true, milestones: [] }).success).toBe(true)
  })
  it('rejects when ok is missing', () => {
    expect(MilestonesListOutput.safeParse({ milestones: [] }).success).toBe(false)
  })
})

// ── wechat-cc sessions list-projects --json ───────────────────────────────────

describe('SessionsListProjectsOutput', () => {
  it('accepts ok:true with a populated projects array', () => {
    expect(SessionsListProjectsOutput.safeParse({
      ok: true,
      projects: [
        {
          alias: 'my-project',
          session_id: 'sess_abc123',
          last_used_at: '2026-05-01T10:00:00.000Z',
          summary: 'Working on feature X',
          summary_updated_at: '2026-05-01T10:05:00.000Z',
        },
      ],
    }).success).toBe(true)
  })
  it('accepts ok:true with an empty projects array (summary fields null)', () => {
    expect(SessionsListProjectsOutput.safeParse({
      ok: true,
      projects: [
        {
          alias: 'bare',
          session_id: 'sess_xyz',
          last_used_at: '2026-05-02T08:00:00.000Z',
          summary: null,
          summary_updated_at: null,
        },
      ],
    }).success).toBe(true)
  })
  it('rejects when ok is missing', () => {
    expect(SessionsListProjectsOutput.safeParse({ projects: [] }).success).toBe(false)
  })
})

// ── wechat-cc sessions read-jsonl --json ─────────────────────────────────────

describe('SessionsReadJsonlOutput', () => {
  it('accepts ok:true success variant with turns array', () => {
    expect(SessionsReadJsonlOutput.safeParse({
      ok: true,
      alias: 'my-project',
      session_id: 'sess_abc123',
      turns: [{ type: 'human', content: 'hello' }, { type: 'assistant', content: 'hi' }],
    }).success).toBe(true)
  })
  it('accepts ok:false error variant (no such alias)', () => {
    expect(SessionsReadJsonlOutput.safeParse({
      ok: false,
      error: 'no such alias',
    }).success).toBe(true)
  })
  it('rejects when ok is missing', () => {
    expect(SessionsReadJsonlOutput.safeParse({ alias: 'x', session_id: 'y', turns: [] }).success).toBe(false)
  })
})

// ── wechat-cc sessions delete --json ─────────────────────────────────────────

describe('SessionsDeleteOutput', () => {
  it('accepts ok:true with deleted alias', () => {
    expect(SessionsDeleteOutput.safeParse({ ok: true, deleted: 'my-project' }).success).toBe(true)
  })
  it('rejects when deleted field is missing', () => {
    expect(SessionsDeleteOutput.safeParse({ ok: true }).success).toBe(false)
  })
  it('rejects when ok is missing', () => {
    expect(SessionsDeleteOutput.safeParse({ deleted: 'my-project' }).success).toBe(false)
  })
})

// ── wechat-cc sessions search --json ─────────────────────────────────────────

describe('SessionsSearchOutput', () => {
  it('accepts ok:true with query and populated hits array', () => {
    expect(SessionsSearchOutput.safeParse({
      ok: true,
      query: 'feature X',
      hits: [{ alias: 'my-project', snippet: '...working on feature X...' }],
    }).success).toBe(true)
  })
  it('accepts ok:true with an empty hits array', () => {
    expect(SessionsSearchOutput.safeParse({ ok: true, query: 'nothing', hits: [] }).success).toBe(true)
  })
  it('rejects when ok is missing', () => {
    expect(SessionsSearchOutput.safeParse({ query: 'x', hits: [] }).success).toBe(false)
  })
})

// ── wechat-cc demo seed --json ────────────────────────────────────────────────

describe('DemoSeedOutput', () => {
  it('accepts ok:true with seed counts', () => {
    expect(DemoSeedOutput.safeParse({
      ok: true,
      observations: 3,
      milestones: 2,
      events: 1,
    }).success).toBe(true)
  })
  it('rejects when ok is missing', () => {
    expect(DemoSeedOutput.safeParse({ observations: 3, milestones: 2, events: 1 }).success).toBe(false)
  })
  it('rejects when a count field is missing', () => {
    expect(DemoSeedOutput.safeParse({ ok: true, observations: 3, milestones: 2 }).success).toBe(false)
  })
})

// ── wechat-cc demo unseed --json ──────────────────────────────────────────────

describe('DemoUnseedOutput', () => {
  it('accepts ok:true with removed count', () => {
    expect(DemoUnseedOutput.safeParse({ ok: true, removed: 7 }).success).toBe(true)
  })
  it('accepts ok:true with zero removed (idempotent unseed)', () => {
    expect(DemoUnseedOutput.safeParse({ ok: true, removed: 0 }).success).toBe(true)
  })
  it('rejects when ok is missing', () => {
    expect(DemoUnseedOutput.safeParse({ removed: 7 }).success).toBe(false)
  })
})

// ── wechat-cc reply --json ────────────────────────────────────────────────────

describe('ReplyOutput', () => {
  it('accepts ok:true with chat_id, chunks and account', () => {
    expect(ReplyOutput.safeParse({
      ok: true,
      chat_id: 'o9cq80abc@im.wechat',
      chunks: 1,
      account: 'bot-abc123-im-bot',
    }).success).toBe(true)
  })
  it('accepts ok:false with error message', () => {
    expect(ReplyOutput.safeParse({
      ok: false,
      error: 'no chat resolved — pass --to <chat_id> or send a WeChat message first',
    }).success).toBe(true)
  })
  it('rejects unknown discriminator', () => {
    expect(ReplyOutput.safeParse({ ok: 'maybe' }).success).toBe(false)
  })
})

// ── wechat-cc update --check --json ──────────────────────────────────────────

describe('UpdateCheckOutput', () => {
  it('accepts ok:true probe with update available + binary-mode fields', () => {
    expect(UpdateCheckOutput.safeParse({
      ok: true,
      mode: 'check',
      currentCommit: 'abc1234',
      latestCommit: 'def5678',
      updateAvailable: true,
      behind: 3,
      aheadOfRemote: 0,
      lockfileWillChange: true,
      // Binary-mode fields surfaced post-2026-05-08 (commit 0a94357).
      // Schema must round-trip them so dashboard / desktop consumers
      // can render "binary stale even when no upstream changes" UI.
      binaryStale: true,
      binaryPath: '/home/u/.local/bin/wechat-cc-cli',
      dirty: false,
      dirtyFiles: [],
    }).success).toBe(true)
  })
  it('accepts ok:false probe with reason (e.g. fetch_failed)', () => {
    expect(UpdateCheckOutput.safeParse({
      ok: false,
      mode: 'check',
      reason: 'fetch_failed',
      message: 'git fetch origin failed',
      details: { stderr: 'fatal: unable to access' },
    }).success).toBe(true)
  })
  it('rejects when mode is missing', () => {
    expect(UpdateCheckOutput.safeParse({ ok: true }).success).toBe(false)
  })
})

// ── wechat-cc update --json (apply path) ──────────────────────────────────────

describe('UpdateApplyOutput', () => {
  it('accepts ok:true applied branch (with rebuildRan)', () => {
    expect(UpdateApplyOutput.safeParse({
      ok: true,
      mode: 'apply',
      fromCommit: 'abc1234',
      toCommit: 'def5678',
      lockfileChanged: true,
      installRan: true,
      // Required field added 2026-05-08 (commit 3707980). Producers always
      // emit it; this fixture pins the contract so a future schema drift
      // (TS type updated, Zod schema not) fails CI before reaching desktop.
      rebuildRan: true,
      daemonAction: 'restarted',
      elapsedMs: 4200,
    }).success).toBe(true)
  })
  it('rejects ok:true branch without rebuildRan (regression for 2026-05-08 schema-drift gap)', () => {
    expect(UpdateApplyOutput.safeParse({
      ok: true,
      mode: 'apply',
      fromCommit: 'abc1234',
      toCommit: 'def5678',
      lockfileChanged: false,
      installRan: false,
      // rebuildRan deliberately omitted — schema must require it so the
      // CLI producer is forced to populate it on every code path.
      daemonAction: 'noop',
      elapsedMs: 100,
    }).success).toBe(false)
  })
  it('accepts ok:false rejected branch', () => {
    expect(UpdateApplyOutput.safeParse({
      ok: false,
      mode: 'apply',
      reason: 'dirty_tree',
      message: 'working tree has uncommitted changes; commit/stash/discard then retry',
      details: { dirtyFiles: ['src/foo.ts'] },
    }).success).toBe(true)
  })
  it('accepts new rebuild_failed reason', () => {
    expect(UpdateApplyOutput.safeParse({
      ok: false,
      mode: 'apply',
      reason: 'rebuild_failed',
      message: 'bun build --compile failed for /home/u/.local/bin/wechat-cc-cli',
      details: { stderr: 'TS2305: ...' },
    }).success).toBe(true)
  })
  it('rejects unknown ok discriminator', () => {
    expect(UpdateApplyOutput.safeParse({ ok: 'maybe', mode: 'apply' }).success).toBe(false)
  })
})

// ── wechat-cc conversations list --json ───────────────────────────────────────

describe('ConversationsListOutput', () => {
  it('accepts ok:true with a populated conversations array', () => {
    expect(ConversationsListOutput.safeParse({
      ok: true,
      conversations: [
        {
          chat_id: 'o9cq80abc@im.wechat',
          user_id: 'user-123',
          account_id: 'bot-456',
          user_name: 'Alice',
          mode: { kind: 'solo', provider: 'claude' },
        },
      ],
    }).success).toBe(true)
  })
  it('accepts ok:true with null identity fields (no getIdentity record)', () => {
    expect(ConversationsListOutput.safeParse({
      ok: true,
      conversations: [
        {
          chat_id: 'group_xyz@chatroom',
          user_id: null,
          account_id: null,
          user_name: null,
          mode: { kind: 'chatroom' },
        },
      ],
    }).success).toBe(true)
  })
  it('rejects when ok is missing', () => {
    expect(ConversationsListOutput.safeParse({ conversations: [] }).success).toBe(false)
  })
})

// ── wechat-cc logs --json ─────────────────────────────────────────────────────

describe('LogsOutput', () => {
  it('accepts ok:true with populated entries array', () => {
    expect(LogsOutput.safeParse({
      ok: true,
      logFile: '/home/user/.local/share/wechat-cc/channel.log',
      totalLines: 120,
      entries: [
        {
          timestamp: '2026-05-07T10:00:00.000Z',
          tag: 'SESSION_EXPIRED',
          message: '18ca067b4366-im-bot — token revoked',
          raw: '2026-05-07T10:00:00.000Z [SESSION_EXPIRED] 18ca067b4366-im-bot — token revoked',
        },
      ],
    }).success).toBe(true)
  })
  it('accepts ok:true with empty entries array (log file absent)', () => {
    expect(LogsOutput.safeParse({
      ok: true,
      logFile: '/home/user/.local/share/wechat-cc/channel.log',
      totalLines: 0,
      entries: [],
    }).success).toBe(true)
  })
  it('rejects when ok is missing', () => {
    expect(LogsOutput.safeParse({ logFile: '/tmp/channel.log', totalLines: 0, entries: [] }).success).toBe(false)
  })
})

// ── wechat-cc guard status --json ─────────────────────────────────────────────

describe('GuardStatusOutput', () => {
  it('accepts a fully-populated status snapshot', () => {
    expect(GuardStatusOutput.safeParse({
      enabled: true,
      ip: '1.2.3.4',
      reachable: true,
      probe_url: 'https://probe.example.com',
      ip_error: null,
      probe_error: null,
      probe_ms: 120,
    }).success).toBe(true)
  })
  it('accepts a snapshot with ip_error and probe_error populated (probe failure)', () => {
    expect(GuardStatusOutput.safeParse({
      enabled: false,
      ip: null,
      reachable: false,
      probe_url: 'https://probe.example.com',
      ip_error: 'fetch timeout',
      probe_error: 'connection refused',
      probe_ms: null,
    }).success).toBe(true)
  })
  it('rejects an empty object', () => {
    expect(GuardStatusOutput.safeParse({}).success).toBe(false)
  })
})

// ── wechat-cc guard enable --json ────────────────────────────────────────────

describe('GuardEnableOutput', () => {
  it('accepts ok:true with enabled:true', () => {
    expect(GuardEnableOutput.safeParse({ ok: true, enabled: true }).success).toBe(true)
  })
  it('rejects when ok is missing', () => {
    expect(GuardEnableOutput.safeParse({ enabled: true }).success).toBe(false)
  })
})

// ── wechat-cc guard disable --json ───────────────────────────────────────────

describe('GuardDisableOutput', () => {
  it('accepts ok:true with enabled:false', () => {
    expect(GuardDisableOutput.safeParse({ ok: true, enabled: false }).success).toBe(true)
  })
  it('rejects when enabled is missing', () => {
    expect(GuardDisableOutput.safeParse({ ok: true }).success).toBe(false)
  })
})

// ── wechat-cc avatar info --json ──────────────────────────────────────────────

describe('AvatarInfoOutput', () => {
  it('accepts ok:true with exists:true and a path', () => {
    expect(AvatarInfoOutput.safeParse({
      ok: true,
      exists: true,
      path: '/home/user/.local/share/wechat-cc/avatars/abc123.png',
    }).success).toBe(true)
  })
  it('accepts ok:true with exists:false (no avatar stored)', () => {
    expect(AvatarInfoOutput.safeParse({
      ok: true,
      exists: false,
      path: '/home/user/.local/share/wechat-cc/avatars/abc123.png',
    }).success).toBe(true)
  })
  it('rejects when ok is missing', () => {
    expect(AvatarInfoOutput.safeParse({ exists: true, path: '/tmp/avatar.png' }).success).toBe(false)
  })
})

// ── wechat-cc avatar set --json ───────────────────────────────────────────────

describe('AvatarSetOutput', () => {
  it('accepts ok:true success branch with path', () => {
    expect(AvatarSetOutput.safeParse({
      ok: true,
      path: '/home/user/.local/share/wechat-cc/avatars/abc123.png',
    }).success).toBe(true)
  })
  it('accepts ok:false error branch', () => {
    expect(AvatarSetOutput.safeParse({
      ok: false,
      error: 'invalid base64: illegal character at position 4',
    }).success).toBe(true)
  })
  it('rejects unknown discriminator', () => {
    expect(AvatarSetOutput.safeParse({ ok: 'maybe' }).success).toBe(false)
  })
})

// ── wechat-cc avatar remove --json ───────────────────────────────────────────

describe('AvatarRemoveOutput', () => {
  it('accepts ok:true with path (always succeeds — no-op if absent)', () => {
    expect(AvatarRemoveOutput.safeParse({
      ok: true,
      path: '/home/user/.local/share/wechat-cc/avatars/abc123.png',
    }).success).toBe(true)
  })
  it('rejects when path is missing', () => {
    expect(AvatarRemoveOutput.safeParse({ ok: true }).success).toBe(false)
  })
  it('rejects when ok is missing', () => {
    expect(AvatarRemoveOutput.safeParse({ path: '/tmp/avatar.png' }).success).toBe(false)
  })
})
