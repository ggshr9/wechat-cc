// Pure renderers for memory pane top zone. No DOM mutation here — return
// HTML strings that main.js mounts. Tested in observations.test.ts.

import { escapeHtml } from "../view.js"

const TONE_GLYPH = {
  concern: '·',
  curious: '·',
  proud:   '✦',
  playful: '·',
  quiet:   '·',
}

export function observationRow(obs) {
  const toneAttr = obs.tone ? ` data-tone="${escapeHtml(obs.tone)}"` : ''
  const glyph = TONE_GLYPH[obs.tone] || '·'
  return `
    <button class="observation" data-id="${escapeHtml(obs.id)}"${toneAttr} data-action="observation-row">
      <span class="glyph">${glyph}</span>
      <span class="body">${escapeHtml(obs.body)}</span>
      <span class="archive-btn" data-action="archive-observation" data-id="${escapeHtml(obs.id)}">忽略</span>
      <span class="ts">${escapeHtml(obs.ts)}</span>
    </button>
  `
}

export function milestoneCard(ms) {
  return `
    <div class="milestone-card" data-id="${escapeHtml(ms.id)}">
      <span class="glyph">🎉</span>
      <span class="body">${escapeHtml(ms.body)}</span>
      <span class="ts-rel">${escapeHtml(formatRelativeTimeShort(ms.ts))}</span>
    </div>
  `
}

export function formatRelativeTimeShort(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 3600_000) return '刚刚'
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)} 小时前`
  if (ms < 30 * 86400_000) return `${Math.floor(ms / 86400_000)} 天前`
  return iso.slice(0, 10)
}
