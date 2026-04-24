/**
 * Companion sub-adapter — v2 memory-first gate + destination hint.
 *
 * Claude owns `memory/`; this module only toggles the proactive-tick
 * scheduler (enabled / snooze) and records the default_chat_id.
 */
import { mkdirSync } from 'node:fs'
import type { ToolDeps } from '../../features/tools'
import { companionDir } from '../companion/paths'
import { loadCompanionConfig, saveCompanionConfig, defaultCompanionConfig } from '../companion/config'
import type { IlinkContext } from './context'

export function makeCompanion(ctx: IlinkContext): ToolDeps['companion'] {
  const { stateDir, acctStore, lastActiveRef } = ctx

  return {
    async enable() {
      const cfg = loadCompanionConfig(stateDir)
      if (cfg.enabled) {
        return { ok: true as const, already_configured: true as const }
      }

      mkdirSync(companionDir(stateDir), { recursive: true })
      const newCfg = {
        ...defaultCompanionConfig(),
        ...cfg,
        enabled: true,
        default_chat_id:
          cfg.default_chat_id
          ?? lastActiveRef.current
          ?? (Object.keys(acctStore.all()).slice(-1)[0] ?? null),
      }
      await saveCompanionConfig(stateDir, newCfg)

      return {
        ok: true as const,
        state_dir: companionDir(stateDir),
        welcome_message:
          '主动提醒已开启。我会每 15-30 分钟醒一次，决定是不是联系你。\n' +
          '不确定时我会选不打扰；连续被 ignore/snooze 我会自己调整频率。\n' +
          '随时说 "别烦我" / "snooze 2 小时" 让我歇；或 "关掉主动" 完全停。\n' +
          '你对我的偏好（语气、作息、什么话题想聊）我会记在 memory 里，一点点学。',
        cost_estimate_note:
          '每次主动 tick 评估一次 Claude（~$0.01/次）；默认 20 分钟一次有 jitter；不说话就不花钱。',
      }
    },

    async disable() {
      const cfg = loadCompanionConfig(stateDir)
      cfg.enabled = false
      await saveCompanionConfig(stateDir, cfg)
      return { ok: true as const, enabled: false as const }
    },

    status() {
      const cfg = loadCompanionConfig(stateDir)
      return {
        enabled: cfg.enabled,
        timezone: cfg.timezone,
        default_chat_id: cfg.default_chat_id,
        snooze_until: cfg.snooze_until,
      }
    },

    async snooze(minutes: number) {
      const cfg = loadCompanionConfig(stateDir)
      const until = new Date(Date.now() + minutes * 60_000).toISOString()
      cfg.snooze_until = until
      await saveCompanionConfig(stateDir, cfg)
      return { ok: true as const, until }
    },
  } satisfies ToolDeps['companion']
}
