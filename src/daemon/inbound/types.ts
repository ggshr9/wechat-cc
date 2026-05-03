// src/daemon/inbound/types.ts
import type { InboundMsg } from '../../core/prompt-format'

export type ConsumedBy = 'admin' | 'mode' | 'onboarding' | 'permission-reply' | 'guard'

export interface InboundCtx {
  readonly msg: InboundMsg
  readonly receivedAtMs: number
  readonly requestId: string
  consumedBy?: ConsumedBy
  attachmentsMaterialized?: boolean
}

export type Middleware = (ctx: InboundCtx, next: () => Promise<void>) => Promise<void>
export type PipelineRun = (ctx: InboundCtx) => Promise<void>
