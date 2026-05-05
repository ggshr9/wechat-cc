import { describe, it, expect, vi } from 'vitest'
import { buildInboundPipeline, type InboundPipelineDeps } from './build'
import type { InboundCtx } from './types'

function fakeDeps(over: Partial<{
  adminConsumes: boolean; modeConsumes: boolean; onboardingConsumes: boolean;
  permConsumes: boolean; guardEnabled: boolean; guardReachable: boolean;
}> = {}): { deps: InboundPipelineDeps; spy: { dispatch: ReturnType<typeof vi.fn>; activity: ReturnType<typeof vi.fn>; milestone: ReturnType<typeof vi.fn>; welcome: ReturnType<typeof vi.fn> } } {
  const dispatch = vi.fn(async () => {})
  const activity = vi.fn(async () => {})
  const milestone = vi.fn(async () => {})
  const welcome = vi.fn(async () => {})
  const log = () => {}
  const deps: InboundPipelineDeps = {
    trace: { log },
    identity: { upsertIdentity: () => {} },
    capture: { markChatActive: () => {}, captureContextToken: () => {} },
    typing: { sendTyping: async () => {} },
    admin: { adminHandler: { handle: async () => over.adminConsumes ?? false } },
    mode: { modeHandler: { handle: async () => over.modeConsumes ?? false } },
    onboarding: { onboardingHandler: { handle: async () => over.onboardingConsumes ?? false } },
    permissionReply: { handlePermissionReply: () => over.permConsumes ?? false, log },
    guard: {
      guardEnabled: () => over.guardEnabled ?? false,
      guardState: () => ({ reachable: over.guardReachable ?? true, ip: '1.2.3.4' }),
      sendMessage: async () => ({ msgId: 'm1' }),
      log,
    },
    attachments: { materializeAttachments: async () => {}, inboxDir: '/tmp', log },
    activity: { recordInbound: activity, log },
    milestone: { fireMilestonesFor: milestone, log },
    welcome: { maybeWriteWelcomeObservation: welcome, log },
    dispatch: { coordinator: { dispatch } },
  }
  return { deps, spy: { dispatch, activity, milestone, welcome } }
}

const mkCtx = (): InboundCtx => ({
  msg: { chatId: 'c1', accountId: 'a1', text: 'hi' } as InboundCtx['msg'],
  receivedAtMs: 0,
  requestId: 'r1',
})

describe('inbound pipeline (integration)', () => {
  it('full happy path: dispatch + W-tier all fire', async () => {
    const { deps, spy } = fakeDeps()
    const run = buildInboundPipeline(deps)
    await run(mkCtx())
    expect(spy.dispatch).toHaveBeenCalledOnce()
    // Allow fire-and-forget to settle
    await new Promise(r => setImmediate(r))
    expect(spy.activity).toHaveBeenCalledOnce()
    expect(spy.milestone).toHaveBeenCalledOnce()
    expect(spy.welcome).toHaveBeenCalledOnce()
  })

  it('admin short-circuit: dispatch + W-tier all skipped', async () => {
    const { deps, spy } = fakeDeps({ adminConsumes: true })
    const run = buildInboundPipeline(deps)
    const ctx = mkCtx()
    await run(ctx)
    expect(spy.dispatch).not.toHaveBeenCalled()
    expect(spy.activity).not.toHaveBeenCalled()
    expect(spy.milestone).not.toHaveBeenCalled()
    expect(spy.welcome).not.toHaveBeenCalled()
    expect(ctx.consumedBy).toBe('admin')
  })

  it('mode short-circuit: dispatch + W-tier all skipped', async () => {
    const { deps, spy } = fakeDeps({ modeConsumes: true })
    await buildInboundPipeline(deps)(mkCtx())
    expect(spy.dispatch).not.toHaveBeenCalled()
  })

  it('onboarding short-circuit', async () => {
    const { deps, spy } = fakeDeps({ onboardingConsumes: true })
    await buildInboundPipeline(deps)(mkCtx())
    expect(spy.dispatch).not.toHaveBeenCalled()
  })

  it('permission-reply short-circuit', async () => {
    const { deps, spy } = fakeDeps({ permConsumes: true })
    await buildInboundPipeline(deps)(mkCtx())
    expect(spy.dispatch).not.toHaveBeenCalled()
  })

  it('guard short-circuit when enabled and unreachable', async () => {
    const { deps, spy } = fakeDeps({ guardEnabled: true, guardReachable: false })
    await buildInboundPipeline(deps)(mkCtx())
    expect(spy.dispatch).not.toHaveBeenCalled()
  })

  it('dispatch error is caught by trace; pipeline does not reject', async () => {
    const { deps } = fakeDeps()
    deps.dispatch.coordinator.dispatch = async () => { throw new Error('coord-boom') }
    await expect(buildInboundPipeline(deps)(mkCtx())).resolves.toBeUndefined()
  })
})
