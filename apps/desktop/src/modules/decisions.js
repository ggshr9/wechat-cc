// Pure renderer for events.jsonl rows shown in the memory pane bottom
// folded zone. Click → toggles `expanded` class which CSS uses to render
// reasoning via ::after.

import { escapeHtml } from "../view.js"
import { formatRelativeTimeShort } from "./observations.js"

const GLYPH_BY_KIND = {
  cron_eval_pushed: '💬',
  cron_eval_skipped: '🤔',
  cron_eval_failed: '⚠',
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
  if (ev.kind === 'cron_eval_failed') return 'introspect 出错（点开看原因）'
  if (ev.kind === 'observation_written') return '写下一条新观察'
  if (ev.kind === 'milestone') return '里程碑达成'
  return '(未知事件)'
}

export function decisionRow(ev) {
  const glyph = decisionGlyph(ev.kind)
  const ts = formatRelativeTimeShort(ev.ts)
  const summary = decisionSummary(ev)
  const reasoning = (ev.reasoning || '').replace(/\n/g, ' ')
  // data-reasoning lives on BOTH the row (for click delegation in main.js
  // — toggles .expanded class) AND the .summary span (so the CSS rule
  // `.decision-row.expanded .summary::after { content: attr(data-reasoning) }`
  // can read it; CSS attr() only resolves attributes on the same element,
  // not parents).
  const reasoningEsc = escapeHtml(reasoning)
  return `
    <button class="decision-row" data-id="${escapeHtml(ev.id)}" data-action="toggle-decision" data-reasoning="${reasoningEsc}">
      <span class="glyph">${glyph}</span>
      <span class="ts">${escapeHtml(ts)}</span>
      <span class="summary" data-reasoning="${reasoningEsc}">${escapeHtml(summary)}</span>
    </button>
  `
}
