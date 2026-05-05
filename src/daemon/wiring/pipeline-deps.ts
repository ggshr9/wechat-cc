/**
 * Pipeline dep builder — admin/mode/onboarding handler construction +
 * 13-mw deps assembly into InboundPipelineDeps.
 *
 * Refs are passed in for late-bound polling/guard access from closures.
 */
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Ref } from '../../lib/lifecycle'
import type { IlinkAdapter } from '../ilink-glue'
import type { Bootstrap } from '../bootstrap'
import type { GuardLifecycle } from '../guard/lifecycle'
import type { PollingLifecycle } from '../polling-lifecycle'
import type { InboundPipelineDeps } from '../inbound/build'
import type { PipelineRun } from '../inbound/types'
import { isAdmin } from '../../lib/access'
import { makeAdminCommands } from '../admin-commands'
import { makeModeCommands } from '../mode-commands'
import { makeOnboardingHandler } from '../onboarding'
import { botNameForMode } from '../bot-name'
import { materializeAttachments } from '../media'
import { loadGuardConfig } from '../guard/store'
import { makeFireMilestonesFor, makeRecordInbound, makeMaybeWriteWelcomeObservation } from './side-effects'

export interface PipelineDepsOpts {
  stateDir: string
  db: import('../../lib/db').Db
  ilink: IlinkAdapter
  boot: Bootstrap
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void
}

export interface PipelineDepsRefs {
  polling: Ref<PollingLifecycle>
  guard: Ref<GuardLifecycle>
  pipeline: Ref<PipelineRun>
}

const STARTED_AT_ISO = new Date().toISOString()

export function buildPipelineDeps(opts: PipelineDepsOpts, refs: PipelineDepsRefs): { pipelineDeps: InboundPipelineDeps } {
  const { stateDir, db, ilink, boot, log } = opts
  const inboxDir = join(stateDir, 'inbox')

  const fireMilestonesFor = makeFireMilestonesFor({ stateDir, db })
  const recordInbound = makeRecordInbound({ stateDir, db })
  const maybeWriteWelcomeObservation = makeMaybeWriteWelcomeObservation({ stateDir, db })

  const adminCommandsHandler = makeAdminCommands({
    stateDir, isAdmin,
    sessionState: ilink.sessionState,
    pollHandle: {
      stopAccount: (id) => refs.polling.current?.stopAccount(id) ?? Promise.resolve(),
      running: () => refs.polling.current?.running() ?? [],
    },
    resolveUserName: (cid) => ilink.resolveUserName(cid),
    sendMessage: (cid, txt) => ilink.sendMessage(cid, txt),
    sharePage: (t, c, o) => ilink.sharePage(t, c, o),
    log,
    startedAt: STARTED_AT_ISO,
  })

  const modeHandler = makeModeCommands({
    coordinator: boot.coordinator,
    registry: boot.registry,
    defaultProviderId: boot.defaultProviderId,
    sendMessage: (cid, txt) => ilink.sendMessage(cid, txt),
    setUserName: (cid, name) => ilink.setUserName(cid, name),
    getUserName: (cid) => ilink.resolveUserName(cid) ?? null,
    log,
  })

  const onboardingHandler = makeOnboardingHandler({
    isKnownUser: (uid) => ilink.resolveUserName(uid) !== undefined,
    setUserName: (cid, name) => ilink.setUserName(cid, name),
    sendMessage: async (cid, txt) => { await ilink.sendMessage(cid, txt) },
    botName: (cid) => botNameForMode(boot.coordinator.getMode(cid)),
    dispatchInbound: async (msg) => {
      // Re-fire this inbound through the normal pipeline. Onboarding has
      // already cleared its awaiting state and persisted the nickname, so
      // mw-onboarding will short-circuit (isKnownUser=true) and the message
      // flows to the provider as if it were just received.
      await refs.pipeline.deref('onboarding echo dispatch')({
        msg,
        receivedAtMs: Date.now(),
        requestId: randomBytes(4).toString('hex'),
      })
    },
    log,
  })

  const pipelineDeps: InboundPipelineDeps = {
    trace: { log },
    capture: {
      markChatActive: (c, a) => ilink.markChatActive(c, a),
      captureContextToken: (c, t) => ilink.captureContextToken(c, t),
    },
    typing: { sendTyping: (c, a) => ilink.sendTyping(c, a) },
    admin: { adminHandler: adminCommandsHandler },
    mode: { modeHandler },
    onboarding: { onboardingHandler },
    permissionReply: {
      handlePermissionReply: (text: string) => ilink.handlePermissionReply(text),
      log,
    },
    guard: {
      guardEnabled: () => loadGuardConfig(stateDir).enabled,
      guardState: () => refs.guard.current?.current() ?? { reachable: true, ip: null },
      sendMessage: (c, t) => ilink.sendMessage(c, t).then(r => r as { msgId: string }),
      log,
    },
    attachments: { materializeAttachments, inboxDir, log },
    activity: { recordInbound, log },
    milestone: { fireMilestonesFor, log },
    welcome: { maybeWriteWelcomeObservation, log },
    dispatch: { coordinator: { dispatch: (msg) => boot.coordinator.dispatch(msg) } },
  }

  return { pipelineDeps }
}
