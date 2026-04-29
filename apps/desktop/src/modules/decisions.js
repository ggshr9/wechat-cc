// Pure renderer for events.jsonl rows shown in the memory pane bottom
// folded zone. Click → toggles `expanded` class which CSS uses to render
// reasoning via ::after.

import { escapeHtml } from "../view.js"
import { formatRelativeTimeShort } from "./observations.js"

const GLYPH_BY_KIND = {
  cron_eval_pushed: '💬',
  cron_eval_skipped: '🤔',
  observation_written: '✨',
  milestone: '🎉',
}

export function decisionGlyph(kind) {
  return GLYPH_BY_KIND[kind] || '·'
}

export function decisionSummary(ev) {
  if (ev.kind === 'cron_eval_pushed') {
    const text = ev.push_text || '(空)'
    return `主动找你：「${text}」`
  }
  if (ev.kind === 'cron_eval_skipped') return '想了想，决定不打扰'
  if (ev.kind === 'observation_written') return '写下一条新观察'
  if (ev.kind === 'milestone') return '里程碑达成'
  return '(未知事件)'
}

export function decisionRow(ev) {
  const glyph = decisionGlyph(ev.kind)
  const ts = formatRelativeTimeShort(ev.ts)
  const summary = decisionSummary(ev)
  const reasoning = (ev.reasoning || '').replace(/\n/g, ' ')
  return `
    <button class="decision-row" data-id="${escapeHtml(ev.id)}" data-action="toggle-decision" data-reasoning="${escapeHtml(reasoning)}">
      <span class="glyph">${glyph}</span>
      <span class="ts">${escapeHtml(ts)}</span>
      <span class="summary">${escapeHtml(summary)}</span>
    </button>
  `
}
