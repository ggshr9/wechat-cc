// @ts-check
/// <reference lib="dom" />
/**
 * Dashboard module: "Agents (A2A)" tab.
 * Renders the registered-agents list, hooks up Add Agent modal flow,
 * pause/resume/remove/activity actions.
 *
 * Click handler is attached ONCE to the list (delegated) — not per-refresh —
 * so there are no event-listener leaks across list reloads.
 */

import { invokeApi } from '../api.js'

// ── module-level state ────────────────────────────────────────────────────
/** @type {Record<string, unknown> | null} */
let previewedCard = null
let previewedUrl = ''

// ── public API ────────────────────────────────────────────────────────────

export async function initA2AAgentsTab() {
  const list = document.getElementById('a2a-agents-list')
  if (!list) return

  // Load initial list.
  await refresh().catch(err => {
    if (list) list.innerHTML = `<li class="empty">加载失败：${escapeHtml(String(err?.message ?? err))}</li>`
  })

  // Wire all event handlers ONCE.
  document.getElementById('a2a-add-btn')?.addEventListener('click', openAddModal)
  document.getElementById('a2a-add-form')?.addEventListener('submit', onPreviewSubmit)
  document.getElementById('a2a-install-confirm')?.addEventListener('click', onInstallConfirm)
  document.getElementById('a2a-install-cancel')?.addEventListener('click', closeAddModal)
  document.getElementById('a2a-add-close')?.addEventListener('click', closeAddModal)
  // ✕ in modal header (any stage) + backdrop click (click outside the
  // content area). HTML <dialog> doesn't close on backdrop click by
  // default — event target === the dialog itself only when the click
  // landed on the backdrop (not on any descendant); use that as the
  // signal. ESC is handled natively by showModal().
  document.getElementById('a2a-add-modal-close')?.addEventListener('click', closeAddModal)
  document.getElementById('a2a-add-modal')?.addEventListener('click', (e) => {
    if (e.target instanceof HTMLDialogElement) closeAddModal()
  })
  document.getElementById('a2a-test-modal-close')?.addEventListener('click', closeTestModal)
  document.getElementById('a2a-test-modal')?.addEventListener('click', (e) => {
    if (e.target instanceof HTMLDialogElement) closeTestModal()
  })
  document.getElementById('a2a-activity-close')?.addEventListener('click', () => {
    const drawer = document.getElementById('a2a-activity-drawer')
    if (drawer) drawer.hidden = true
  })
  document.getElementById('a2a-test-inbound')?.addEventListener('click', () => runTest(false))
  document.getElementById('a2a-test-outbound')?.addEventListener('click', () => runTest(true))
  document.getElementById('a2a-test-close')?.addEventListener('click', closeTestModal)
  // Delegated click handler on the list container (attached ONCE; not per
  // refresh — duplicating would multiply calls per click).
  list.addEventListener('click', onCardAction)
}

export async function refresh() {
  const list = document.getElementById('a2a-agents-list')
  if (!list) return
  list.innerHTML = '<li class="empty">加载中…</li>'

  // Refresh the server-status banner first — operator-visible "your A2A
  // base URL is X" so they can share it with external agents without
  // hunting through the Add Agent modal. Best-effort: if /info fails or
  // the banner element isn't in DOM, just skip it.
  const banner = document.getElementById('a2a-server-banner')
  if (banner) {
    const info = /** @type {Record<string, any>} */ (await invokeApi('GET', '/v1/a2a/info').catch(() => null))
    if (!info) {
      banner.innerHTML = '<span class="dot off"></span> A2A 状态未知（daemon 未启动？）'
    } else if (!info.enabled) {
      banner.innerHTML = '<span class="dot off"></span> A2A 入站服务器已禁用 — 编辑 <code>agent-config.json</code> 加 <code>"a2a_listen": { "port": 8717 }</code> 后重启 daemon'
    } else {
      const url = String(info.base_url ?? '')
      banner.innerHTML = `<span class="dot on"></span> A2A 服务器运行中，外部 agent 调用此地址：<code class="a2a-base-url">${escapeHtml(url)}/a2a/notify</code>`
    }
  }

  const resp = /** @type {{ agents?: Array<any> }} */ (await invokeApi('GET', '/v1/a2a/list'))
  const agents = resp?.agents ?? []
  list.innerHTML = ''
  if (agents.length === 0) {
    list.innerHTML = '<li class="empty">No agents registered. Click "+ Add Agent" to install one.</li>'
    return
  }
  for (const a of agents) {
    const li = document.createElement('li')
    li.className = 'a2a-agent-card' + (a.paused ? ' paused' : '')
    li.dataset.id = a.id
    li.innerHTML = `
      <header class="a2a-card-head">
        <span class="dot ${a.paused ? 'off' : 'on'}"></span>
        <strong>${escapeHtml(a.id)}</strong> · ${escapeHtml(a.name)}
      </header>
      <div class="a2a-card-url">${escapeHtml(a.url)}</div>
      <div class="a2a-card-counts">↓ ${a.counts?.inbound ?? 0} · ↑ ${a.counts?.outbound ?? 0}</div>
      <div class="a2a-card-actions">
        <button class="btn ghost" data-action="pause" data-id="${escapeHtml(a.id)}">${a.paused ? 'Resume' : 'Pause'}</button>
        <button class="btn ghost" data-action="test" data-id="${escapeHtml(a.id)}">Test</button>
        <button class="btn ghost" data-action="activity" data-id="${escapeHtml(a.id)}">Activity</button>
        <button class="btn danger" data-action="remove" data-id="${escapeHtml(a.id)}">Remove</button>
      </div>
    `
    list.appendChild(li)
  }
}

// ── event handlers ────────────────────────────────────────────────────────

/** @param {MouseEvent} e */
async function onCardAction(e) {
  const target = e.target
  if (!(target instanceof HTMLButtonElement)) return
  const action = target.dataset.action
  const id = target.dataset.id
  if (!action || !id) return

  if (action === 'pause') {
    const card = target.closest('.a2a-agent-card')
    const wasPaused = card?.classList.contains('paused')
    try {
      await invokeApi('POST', '/v1/a2a/pause', { id, paused: !wasPaused })
      await refresh()
    } catch (err) {
      alert(`Failed to ${wasPaused ? 'resume' : 'pause'} agent: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else if (action === 'remove') {
    if (!confirm(`Remove agent '${id}'?`)) return
    try {
      await invokeApi('POST', '/v1/a2a/remove', { id })
      await refresh()
    } catch (err) {
      alert(`Failed to remove agent: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else if (action === 'activity') {
    await openActivityDrawer(id).catch(err =>
      alert(`Failed to load activity: ${err instanceof Error ? err.message : String(err)}`)
    )
  } else if (action === 'test') {
    await openTestModal(id).catch(err =>
      alert(`Failed to open test dialog: ${err instanceof Error ? err.message : String(err)}`)
    )
  }
}

// ── Test modal ────────────────────────────────────────────────────────────
// Lets the operator validate either direction of the A2A loop without
// dropping to the CLI. Inbound: posts via daemon to its own /a2a/notify
// (notification lands in WeChat chat). Outbound: posts to the registered
// agent's URL via /v1/a2a/send.

let testAgentId = ''

/** @param {string} id */
async function openTestModal(id) {
  testAgentId = id
  const modal = document.getElementById('a2a-test-modal')
  if (!(modal instanceof HTMLDialogElement)) return
  const title = document.getElementById('a2a-test-title')
  if (title) title.textContent = `Test '${id}'`
  const textInput = /** @type {HTMLInputElement | null} */ (document.getElementById('a2a-test-text'))
  if (textInput) textInput.value = `test from ${id} via wechat-cc`
  const result = document.getElementById('a2a-test-result')
  if (result) { result.textContent = ''; result.className = 'a2a-test-result' }
  modal.showModal()
}

/** @param {boolean} outbound */
async function runTest(outbound) {
  const textInput = /** @type {HTMLInputElement | null} */ (document.getElementById('a2a-test-text'))
  const result = document.getElementById('a2a-test-result')
  if (!result) return
  const text = textInput?.value || `test from ${testAgentId} via wechat-cc`
  result.textContent = 'sending…'
  result.className = 'a2a-test-result pending'
  try {
    const r = /** @type {Record<string, any>} */ (await invokeApi('POST', '/v1/a2a/test', {
      agent_id: testAgentId, text, outbound,
    }))
    if (r?.ok) {
      const dir = r.direction === 'in' ? 'inbound' : 'outbound'
      const status = r.http_status ? ` (HTTP ${r.http_status})` : ''
      result.textContent = `✅ ${dir} delivered${status}` +
        (r.direction === 'in'
          ? ` — check your WeChat chat for [A2A:${testAgentId}] ${text}`
          : '')
      result.className = 'a2a-test-result ok'
    } else {
      const errMsg = r?.error ?? 'unknown error'
      const status = r?.http_status ? ` (HTTP ${r.http_status})` : ''
      result.textContent = `❌ ${r?.direction ?? 'test'} failed: ${errMsg}${status}`
      result.className = 'a2a-test-result fail'
    }
  } catch (err) {
    result.textContent = `❌ request failed: ${err instanceof Error ? err.message : String(err)}`
    result.className = 'a2a-test-result fail'
  }
  // Refresh the agent list (counts may have updated from this test).
  refresh().catch(() => {})
}

function closeTestModal() {
  const modal = document.getElementById('a2a-test-modal')
  if (modal instanceof HTMLDialogElement) modal.close()
}

function openAddModal() {
  const modal = document.getElementById('a2a-add-modal')
  if (!(modal instanceof HTMLDialogElement)) return
  const preview = /** @type {HTMLElement | null} */ (modal.querySelector('#a2a-add-preview'))
  const success = /** @type {HTMLElement | null} */ (modal.querySelector('#a2a-add-success'))
  const form    = /** @type {HTMLFormElement | null} */ (modal.querySelector('#a2a-add-form'))
  if (preview) preview.hidden = true
  if (success) success.hidden = true
  if (form) { form.hidden = false; form.reset() }
  previewedCard = null
  previewedUrl = ''
  modal.showModal()
}

function closeAddModal() {
  const modal = document.getElementById('a2a-add-modal')
  if (modal instanceof HTMLDialogElement) modal.close()
  refresh().catch(err => console.error('a2a refresh after modal close failed', err))
}

/** @param {SubmitEvent} e */
async function onPreviewSubmit(e) {
  e.preventDefault()
  const form = /** @type {HTMLFormElement} */ (e.target)
  const urlInput = /** @type {HTMLInputElement} */ (form.elements.namedItem('url'))
  const url = urlInput.value
  const submitBtn = /** @type {HTMLButtonElement | null} */ (form.querySelector('button[type="submit"]'))
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Fetching…' }
  try {
    const resp = /** @type {Record<string, any>} */ (await invokeApi('POST', '/v1/a2a/preview', { url }))
    if (resp && 'error' in resp) { alert(String(resp.error)); return }
    previewedCard = resp
    previewedUrl = url

    const nameEl = document.getElementById('a2a-preview-name')
    const descEl = document.getElementById('a2a-preview-description')
    const capsEl = document.getElementById('a2a-preview-capabilities')
    if (nameEl) nameEl.textContent = String(resp.name ?? '')
    if (descEl) descEl.textContent = String(resp.description ?? '')
    if (capsEl) {
      capsEl.innerHTML = ''
      const caps = Array.isArray(resp.capabilities) ? resp.capabilities : []
      for (const c of caps) {
        const li = document.createElement('li')
        li.textContent = `${c.name}${c.description ? ' — ' + c.description : ''}`
        capsEl.appendChild(li)
      }
    }

    form.hidden = true
    const preview = /** @type {HTMLElement | null} */ (document.getElementById('a2a-add-preview'))
    if (preview) {
      preview.hidden = false
      const idInput = /** @type {HTMLInputElement | null} */ (preview.querySelector('input[name="id"]'))
      if (idInput) idInput.value = slugify(String(resp.name ?? ''))
    }
  } catch (err) {
    alert(`Failed to fetch agent card: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Fetch Agent Card →' }
  }
}

async function onInstallConfirm() {
  const preview = /** @type {HTMLElement | null} */ (document.getElementById('a2a-add-preview'))
  if (!preview || !previewedCard) return
  const idInput = /** @type {HTMLInputElement | null} */ (preview.querySelector('input[name="id"]'))
  const keyInput = /** @type {HTMLInputElement | null} */ (preview.querySelector('input[name="outbound_key"]'))
  const id = idInput?.value?.trim() ?? ''
  const outboundKey = keyInput?.value?.trim() ?? ''
  if (!id) { alert('Please enter a local id (slug) for this agent.'); return }

  const confirmBtn = document.getElementById('a2a-install-confirm')
  if (confirmBtn instanceof HTMLButtonElement) { confirmBtn.disabled = true; confirmBtn.textContent = 'Installing…' }
  try {
    const r = /** @type {Record<string, any>} */ (await invokeApi('POST', '/v1/a2a/install', {
      id,
      name: /** @type {any} */ (previewedCard).name,
      url: previewedUrl,
      outbound_api_key: outboundKey,
    }))
    if (!r || !r.ok) {
      alert(String(r?.error ?? 'install failed'))
      return
    }
    const info = /** @type {Record<string, any>} */ (await invokeApi('GET', '/v1/a2a/info').catch(() => null))
    preview.hidden = true
    const success = /** @type {HTMLElement | null} */ (document.getElementById('a2a-add-success'))
    if (success) success.hidden = false
    const curlPre = document.getElementById('a2a-add-curl')
    if (curlPre) {
      const baseUrl = info?.base_url ?? '<wechat-cc-base-url>'
      curlPre.textContent =
        `curl -X POST ${baseUrl}/a2a/notify \\\n` +
        `  -H "Authorization: Bearer ${r.inbound_api_key}" \\\n` +
        `  -H "Content-Type: application/json" \\\n` +
        `  -d '{"agent_id":"${id}","text":"hello"}'`
    }
  } catch (err) {
    alert(`Install failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    if (confirmBtn instanceof HTMLButtonElement) { confirmBtn.disabled = false; confirmBtn.textContent = 'Install' }
  }
}

/** @param {string} id */
async function openActivityDrawer(id) {
  const drawer = /** @type {HTMLElement | null} */ (document.getElementById('a2a-activity-drawer'))
  const titleEl = document.getElementById('a2a-activity-title')
  if (!drawer || !titleEl) return
  titleEl.textContent = `${id} — recent activity`
  const ul = document.getElementById('a2a-activity-list')
  if (ul) ul.innerHTML = '<li class="empty">加载中…</li>'
  drawer.hidden = false

  const r = /** @type {{ events?: Array<any> }} */ (
    await invokeApi('GET', `/v1/a2a/activity?agent_id=${encodeURIComponent(id)}&limit=50`)
  )
  if (!ul) return
  ul.innerHTML = ''
  const events = r?.events ?? []
  if (events.length === 0) {
    ul.innerHTML = '<li class="empty">No activity yet.</li>'
  } else {
    for (const ev of events) {
      const li = document.createElement('li')
      li.className = `event ${ev.direction}`
      const arrow = ev.direction === 'in' ? '←' : '→'
      const statusNote = ev.status === 'ok' ? '' : ` [${ev.status}${ev.http_status ? ' ' + ev.http_status : ''}]`
      li.innerHTML = `<time>${escapeHtml(String(ev.ts))}</time> ${arrow} ${escapeHtml(String(ev.text))}${escapeHtml(statusNote)}`
      ul.appendChild(li)
    }
  }
}

// ── utilities ─────────────────────────────────────────────────────────────

/** @param {string} s */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => (
    /** @type {Record<string,string>} */ ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[m] ?? m
  ))
}

/** @param {string} s */
function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}
