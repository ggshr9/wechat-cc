// Pure helpers + render functions for the sessions pane.
//
// Drill-down (open detail), search, favorite/export/delete actions are
// added in Task 15+. This task ships the project list + time grouping
// only; loadSessionsList renders the empty/full list and wires the empty
// state. Refresh handler is wired in main.js.

import { escapeHtml } from "../view.js"
import { formatRelativeTimeShort } from "./observations.js"

const TODAY_MS = 24 * 3600_000
const WEEK_MS = 7 * TODAY_MS
const FAV_STORAGE_KEY = 'wechat-cc:favorite-sessions'

export function groupProjectsByRecency(projects, opts = {}) {
  const skipThresh = opts.skipGroupingThreshold ?? 0
  if (projects.length < skipThresh) {
    return { '全部': [...projects].sort(byRecencyDesc) }
  }
  const buckets = { '今天': [], '7 天内': [], '更早': [] }
  const now = Date.now()
  for (const p of projects) {
    const age = now - new Date(p.last_used_at).getTime()
    if (age < TODAY_MS) buckets['今天'].push(p)
    else if (age < WEEK_MS) buckets['7 天内'].push(p)
    else buckets['更早'].push(p)
  }
  for (const k of Object.keys(buckets)) buckets[k].sort(byRecencyDesc)
  return buckets
}

function byRecencyDesc(a, b) {
  return a.last_used_at < b.last_used_at ? 1 : -1
}

export function projectRow(p, opts = {}) {
  const summaryText = p.summary || '—'
  const summaryClass = p.summary ? 'summary' : 'summary empty'
  const star = opts.isFavorite ? '★' : '☆'
  const favClass = opts.isFavorite ? ' is-favorite' : ''
  return `
    <button class="project-row${favClass}" data-action="open-project" data-alias="${escapeHtml(p.alias)}">
      <span class="star">${star}</span>
      <span class="alias">${escapeHtml(p.alias)}</span>
      <span class="${summaryClass}">${escapeHtml(summaryText)}</span>
      <span class="meta">${escapeHtml(formatRelativeTimeShort(p.last_used_at))}</span>
    </button>
  `
}

export function readFavorites() {
  try {
    return new Set(JSON.parse(localStorage.getItem(FAV_STORAGE_KEY) || '[]'))
  } catch { return new Set() }
}

export function toggleFavorite(alias) {
  const favs = readFavorites()
  if (favs.has(alias)) favs.delete(alias)
  else favs.add(alias)
  localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify([...favs]))
}

export async function loadSessionsList(deps) {
  const body = document.getElementById("sessions-body")
  const empty = document.getElementById("sessions-empty")
  const meta = document.getElementById("sessions-meta")
  if (!body) return

  try {
    const resp = await deps.invoke("wechat_cli_json", { args: ["sessions", "list-projects", "--json"] })
    const projects = resp.projects || []

    if (projects.length === 0) {
      body.innerHTML = ''
      if (empty) {
        empty.style.display = ''
        body.appendChild(empty)
      }
      if (meta) meta.textContent = '—'
      return
    }

    if (empty) empty.style.display = 'none'
    if (meta) meta.textContent = `${projects.length} 个项目`

    const groups = groupProjectsByRecency(projects)
    const favorites = readFavorites()
    body.innerHTML = Object.entries(groups)
      .filter(([_, list]) => list.length > 0)
      .map(([name, list]) => `
        <div class="session-group">
          <div class="session-group-h">${escapeHtml(name)}</div>
          ${list.map(p => projectRow(p, { isFavorite: favorites.has(p.alias) })).join("")}
        </div>
      `).join("")
  } catch (err) {
    body.innerHTML = `<p class="empty-state">读取失败：${escapeHtml(String(err.message || err))}</p>`
  }
}
