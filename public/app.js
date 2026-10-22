// DealSaathi browser app. Talks only to this app's own /api; no secret or viaSocket token is ever here.
const main = document.getElementById('main')

const LABELS = {
  customer_type: { buyer: 'Buyer', seller: 'Seller', tenant: 'Tenant', landlord: 'Landlord' },
  status: { new: 'New', contacted: 'Contacted', qualified: 'Qualified', viewing_scheduled: 'Viewing scheduled', negotiating: 'Negotiating', won: 'Won', lost: 'Lost' },
  source: { walk_in: 'Walk-in', referral: 'Referral', website: 'Website', phone_call: 'Phone call', social_media: 'Social media', property_portal: 'Property portal', other: 'Other' },
  property_type: { apartment: 'Apartment', independent_house: 'Independent house', villa: 'Villa', plot: 'Plot', commercial: 'Commercial', other: 'Other' }
}
const FIELDS = [
  { key: 'full_name', label: 'Full name', type: 'text', required: true },
  { key: 'customer_type', label: 'Customer type', type: 'select', options: LABELS.customer_type, required: true },
  { key: 'phone', label: 'Phone', type: 'tel', hint: 'Phone or email is required.' },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'preferred_location', label: 'Preferred location', type: 'text', hint: 'City and locality, e.g. Baner, Pune' },
  { key: 'property_type', label: 'Property type', type: 'select', options: LABELS.property_type },
  { key: 'property_interest', label: 'Interested in', type: 'text', hint: 'e.g. 2 BHK near the metro' },
  { key: 'bedrooms', label: 'Bedrooms', type: 'number', min: 0, max: 20 },
  { key: 'budget_min', label: 'Min budget (₹)', type: 'money' },
  { key: 'budget_max', label: 'Max budget (₹)', type: 'money' },
  { key: 'source', label: 'Lead source', type: 'select', options: LABELS.source },
  { key: 'status', label: 'Status', type: 'select', options: LABELS.status, noEmpty: true },
  { key: 'assigned_broker', label: 'Assigned broker', type: 'text' },
  { key: 'follow_up_on', label: 'Follow-up date', type: 'date', hint: 'Buyer Follow-Up Reminders reminds you on this date.' },
  { key: 'notes', label: 'Notes', type: 'textarea', wide: true }
]

// ---------- helpers ----------
/** Links that come from providers (payment, calendar) are shown only when they are plain https addresses. */
const safeUrl = (u) => (/^https:\/\/[^\s"'<>]+$/.test(String(u || '')) ? u : null)
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const label = (group, v) => (v ? LABELS[group][v] || v : '')

function formatINR(n) {
  if (n == null) return ''
  if (n >= 1e7) return `₹${+(n / 1e7).toFixed(2)} Cr`
  if (n >= 1e5) return `₹${+(n / 1e5).toFixed(2)} L`
  return `₹${n.toLocaleString('en-IN')}`
}
function budgetText(l) {
  if (l.budget_min != null && l.budget_max != null) return `${formatINR(l.budget_min)} – ${formatINR(l.budget_max)}`
  if (l.budget_max != null) return `Up to ${formatINR(l.budget_max)}`
  if (l.budget_min != null) return `From ${formatINR(l.budget_min)}`
  return ''
}
function lookingFor(l) {
  const parts = []
  if (l.property_interest) parts.push(l.property_interest)
  else if (l.bedrooms != null) parts.push(`${l.bedrooms} BHK`)
  if (l.property_type && !(l.property_interest || '').toLowerCase().includes(label('property_type', l.property_type).toLowerCase())) parts.push(label('property_type', l.property_type))
  return parts.join(' · ')
}
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '')
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
const typeBadge = (t) => (t ? `<span class="badge ${esc(t)}">${esc(label('customer_type', t))}</span>` : '')
const VIA_LABELS = { buyer: 'the buyer (their own account)', assignment: 'assignment', form: 'form', assistant: 'AI assistant (confirmed by you)', gmail: 'Gmail via viaSocket', matching: 'automatic matching', automation: 'Buyer Follow-Up Reminders', calendar: 'Google Calendar via viaSocket', feedback: 'the buyer’s feedback' }
const dash = (v) => (v == null || v === '' ? '<span class="muted">Unknown</span>' : esc(v))

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`)
    this.status = status
    this.code = body?.error?.code
    this.details = body?.error?.details
  }
}

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  let res
  try {
    res = await fetch(path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
  } catch {
    throw new ApiError(0, { error: { code: 'network', message: 'Could not reach the DealSaathi server. Is it still running?' } })
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    if (data?.error?.code === 'login_required' && !path.startsWith('/api/session')) {
      session.user = null
      updateAccessUi()
      renderLogin('signin')
    }
    throw new ApiError(res.status, data)
  }
  return data
}

let toastTimer
function toast(text) {
  const el = document.getElementById('toast')
  el.textContent = text
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.hidden = true }, 4000)
}

function confirmDialog(title, body, okText = 'Delete') {
  const dialog = document.getElementById('confirm-dialog')
  dialog.querySelector('#confirm-title').textContent = title
  dialog.querySelector('#confirm-body').textContent = body
  dialog.querySelector('#confirm-ok').textContent = okText
  dialog.returnValue = ''
  dialog.showModal()
  return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true }))
}

const store = {
  get(k) { try { return sessionStorage.getItem(k) } catch { return null } },
  set(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v) } catch { /* storage unavailable */ } }
}

// ---------- shared lead form ----------
function fieldHtml(f, value, { missing = false, aiTag = false } = {}) {
  const id = `f-${f.key}`
  const v = value ?? ''
  let input
  if (f.type === 'select') {
    const opts = Object.entries(f.options).map(([k, l]) => `<option value="${esc(k)}"${k === v ? ' selected' : ''}>${esc(l)}</option>`).join('')
    input = `<select id="${id}" name="${f.key}">${f.noEmpty ? '' : '<option value="">Unknown</option>'}${opts}</select>`
  } else if (f.type === 'textarea') {
    input = `<textarea id="${id}" name="${f.key}" maxlength="2000">${esc(v)}</textarea>`
  } else {
    const type = f.type === 'money' ? 'number' : f.type
    const extra = f.type === 'money' ? ' min="0" step="1" inputmode="numeric"' : f.type === 'number' ? ` min="${f.min}" max="${f.max}" step="1"` : ''
    input = `<input id="${id}" name="${f.key}" type="${type}" value="${esc(v)}"${extra}${f.type === 'text' ? ' maxlength="200"' : ''}>`
  }
  const hint = f.type === 'money' ? `<div class="hint" data-money-hint="${f.key}">${v !== '' ? esc(formatINR(Number(v))) : 'In rupees: 50 lakh = 5000000'}</div>` : f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''
  return `<div class="field${f.wide ? ' wide' : ''}${missing ? ' missing' : ''}" data-field="${f.key}">
    <label for="${id}">${esc(f.label)}${f.required ? ' *' : ''} ${aiTag ? '<span class="badge ai" title="Filled in by AI from your message. Please check it.">AI</span>' : ''}</label>
    ${input}${hint}<div class="err" role="alert"></div></div>`
}

/** Reads a lead form: empty inputs become null (unknown). */
function readForm(form, keys = FIELDS.map((f) => f.key)) {
  const out = {}
  for (const key of keys) {
    const el = form.elements[key]
    if (!el) continue
    const raw = el.value.trim()
    const f = FIELDS.find((x) => x.key === key)
    out[key] = raw === '' ? null : (f.type === 'number' || f.type === 'money') ? Number(raw) : raw
  }
  return out
}

function bindMoneyHints(form) {
  form.querySelectorAll('[data-money-hint]').forEach((hint) => {
    const input = form.elements[hint.dataset.moneyHint]
    input.addEventListener('input', () => { hint.textContent = input.value ? formatINR(Number(input.value)) : 'In rupees: 50 lakh = 5000000' })
  })
}

function showFieldErrors(form, fields = {}) {
  form.querySelectorAll('.field').forEach((el) => { el.classList.remove('invalid'); const err = el.querySelector('.err'); if (err) err.textContent = '' })
  for (const [key, message] of Object.entries(fields || {})) {
    const el = form.querySelector(`[data-field="${key}"]`)
    const err = el?.querySelector('.err')
    if (el) el.classList.add('invalid')
    if (err) err.textContent = message
  }
  form.querySelector('.invalid input, .invalid select')?.focus()
}

function duplicatesHtml(duplicates, { canOverride }) {
  if (!duplicates?.length) return ''
  const strong = duplicates.some((d) => d.strong)
  const items = duplicates.map((d) => d.lead
    ? `<li><a href="#/leads/${d.lead.id}">${esc(d.lead.full_name)}</a> <span class="code">${esc(d.lead.code)}</span> (${esc(d.reasons.join(', '))})</li>`
    : `<li>A lead managed by another agent (${esc(d.reasons.join(', '))})</li>`).join('')
  return `<div class="notice ${strong ? 'err' : 'warn'}"><strong>${strong ? 'This lead already exists.' : 'A lead with the same name exists.'}</strong>
    <ul>${items}</ul>${strong ? '<div>Use the existing lead, or change the phone/email.</div>' : canOverride ? '<div>If this is a different person, choose <em>Save anyway</em>.</div>' : ''}</div>`
}

// ---------- pages ----------
async function renderDashboard() {
  main.innerHTML = '<p class="muted">Loading…</p>'
  const d = await api('/api/dashboard')
  const t = d.byType
  const list = (leads, empty) => leads.length
    ? `<ul class="timeline">${leads.map((l) => `<li><a href="#/leads/${l.id}"><strong>${esc(l.full_name)}</strong></a> ${typeBadge(l.customer_type)}
        <div class="small muted">${esc([l.preferred_location, lookingFor(l), budgetText(l)].filter(Boolean).join(' · ') || 'No preferences yet')} · ${esc(label('status', l.status))} · updated ${esc(fmtDate(l.updated_at))}</div></li>`).join('')}</ul>`
    : `<p class="muted">${empty}</p>`
  main.innerHTML = `
    <div class="page-head"><div><h1>Dashboard</h1><p>All counts come from the leads saved in ${esc(storedIn())}.</p></div>
      <div class="row"><a class="btn primary" href="#/assistant">Add a lead with AI</a><a class="btn ghost" href="#/leads/new">New lead form</a></div></div>
    <div class="grid stats">
      <div class="card stat"><div class="label">Total leads</div><div class="value">${d.total}</div></div>
      <div class="card stat"><div class="label">Buyers</div><div class="value">${t.buyer || 0}</div></div>
      <div class="card stat"><div class="label">Sellers</div><div class="value">${t.seller || 0}</div></div>
      <div class="card stat"><div class="label">Tenants / Landlords</div><div class="value">${(t.tenant || 0) + (t.landlord || 0)}</div></div>
      <div class="card stat"><div class="label">Need follow-up</div><div class="value">${d.followUp.total}</div></div>
    </div>
    <div class="grid two-col">
      <section class="card"><h2>Recent leads</h2>${list(d.recent, 'No leads yet. Add your first one with AI or the form.')}</section>
      <section class="card"><h2>Need follow-up</h2><p class="small muted">Status New or Contacted, and not updated for ${d.followUpAfterDays}+ days.</p>
        ${list(d.followUp.leads, 'Nothing to follow up right now.')}${d.followUp.total > 5 ? `<a href="#/leads?follow_up=1">See all ${d.followUp.total}</a>` : ''}</section>
    </div>
    <section class="card" style="margin-top:1rem"><h2>Your follow-up reminders</h2>
      <p class="small muted">Created by the Buyer Follow-Up Reminders automation (<a href="#/automations">Automations</a>).</p><div id="reminders"><p class="muted">Loading…</p></div></section>`
  const box = document.getElementById('reminders')
  const loadReminders = async () => {
    try {
      const { reminders } = await api('/api/reminders')
      box.innerHTML = reminders.length ? `<ul class="timeline">${reminders.map((r) => `<li class="conn-row"><div style="flex:1;min-width:0"><a href="#/leads/${r.leadId}"><strong>${esc(r.leadName)}</strong></a> ${typeBadge(r.customerType)}
          <div class="small muted">${esc(r.detail)} · ${esc(fmtDateTime(r.createdAt))}</div></div>
          <button class="btn ghost small" data-rem="${r.id}" data-to="done">Done</button><button class="btn ghost small" data-rem="${r.id}" data-to="dismissed">Dismiss</button></li>`).join('')}</ul>`
        : '<p class="muted">No open reminders.</p>'
      box.querySelectorAll('[data-rem]').forEach((b) => b.addEventListener('click', async () => {
        try { await api(`/api/reminders/${b.dataset.rem}`, { method: 'POST', body: { status: b.dataset.to } }); loadReminders() } catch (error) { toast(error.message) }
      }))
    } catch (error) {
      box.innerHTML = `<div class="notice err">${esc(error.message)}</div>`
    }
  }
  loadReminders()
}

async function renderLeads(params) {
  const state = { q: params.get('q') || '', customer_type: params.get('customer_type') || '', status: params.get('status') || '', location: params.get('location') || '', follow_up: params.get('follow_up') || '' }
  const opt = (group, sel) => Object.entries(LABELS[group]).map(([k, l]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${esc(l)}</option>`).join('')
  main.innerHTML = `
    <div class="page-head"><div><h1>Leads</h1><p>Saved in ${esc(storedIn())}. Not synced to any CRM.</p></div>
      <div class="row"><a class="btn primary" href="#/assistant">Add with AI</a><a class="btn ghost" href="#/leads/new">New lead</a></div></div>
    <form class="filters" id="filters" role="search">
      <div class="field"><label for="q">Search</label><input id="q" name="q" type="search" placeholder="Name, phone, email, location, notes" value="${esc(state.q)}"></div>
      <div class="field"><label for="customer_type">Type</label><select id="customer_type" name="customer_type"><option value="">All</option>${opt('customer_type', state.customer_type)}</select></div>
      <div class="field"><label for="status">Status</label><select id="status" name="status"><option value="">All</option>${opt('status', state.status)}</select></div>
      <div class="field"><label for="location">Location</label><input id="location" name="location" value="${esc(state.location)}" placeholder="e.g. Pune"></div>
    </form>
    ${state.follow_up ? '<div class="notice info">Showing leads that need follow-up. <a href="#/leads">Show all</a></div>' : ''}
    <div class="card" style="padding:0"><div class="table-wrap" id="results"><p class="empty">Loading…</p></div></div>`

  const form = document.getElementById('filters')
  let timer
  let seq = 0
  const load = async () => {
    const values = Object.fromEntries(new FormData(form))
    const qs = new URLSearchParams(Object.entries({ ...values, follow_up: state.follow_up }).filter(([, v]) => v))
    history.replaceState(null, '', `#/leads${qs.toString() ? `?${qs}` : ''}`)
    const mine = ++seq
    const results = document.getElementById('results')
    try {
      const { total, leads } = await api(`/api/leads?${qs}`)
      if (mine !== seq) return
      results.innerHTML = leads.length ? `
        <table><thead><tr><th>Name</th><th>Type</th><th>Location</th><th>Looking for</th><th>Budget</th><th>Contact</th><th>Status</th><th>Created</th></tr></thead>
        <tbody>${leads.map((l) => `<tr data-id="${l.id}" tabindex="0">
          <td><div class="cell-name">${esc(l.full_name)}</div><div class="code">${esc(l.code)}</div></td>
          <td>${typeBadge(l.customer_type)}</td><td>${esc(l.preferred_location || '')}</td><td>${esc(lookingFor(l))}</td>
          <td>${esc(budgetText(l))}</td><td>${esc(l.phone || '')}${l.phone && l.email ? '<br>' : ''}<span class="small">${esc(l.email || '')}</span></td>
          <td>${esc(label('status', l.status))}</td><td class="small">${esc(fmtDate(l.created_at))}</td></tr>`).join('')}</tbody></table>
        <p class="small muted" style="padding:.5rem .75rem;margin:0">${total} lead${total === 1 ? '' : 's'}${total > leads.length ? `, showing the latest ${leads.length}` : ''}</p>`
        : `<p class="empty">${Object.values(values).some(Boolean) || state.follow_up ? 'No leads match these filters.' : 'No leads yet. <a href="#/assistant">Add one with AI</a>.'}</p>`
      results.querySelectorAll('tr[data-id]').forEach((tr) => {
        const go = () => { location.hash = `#/leads/${tr.dataset.id}` }
        tr.addEventListener('click', go)
        tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go() })
      })
    } catch (error) {
      results.innerHTML = `<div class="notice err" style="margin:1rem">${esc(error.message)}</div>`
    }
  }
  form.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250) })
  form.addEventListener('submit', (e) => { e.preventDefault(); load() })
  load()
}

async function renderLeadDetail(id) {
  main.innerHTML = '<p class="muted">Loading…</p>'
  let data
  try {
    data = await api(`/api/leads/${encodeURIComponent(id)}`)
  } catch (error) {
    main.innerHTML = `<div class="notice err">${esc(error.message)}</div><a href="#/leads">Back to leads</a>`
    return
  }
  const { lead: l, activities } = data
  const rows = [
    ['Lead ID', `<span class="code">${esc(l.code)}</span>`], ['Customer type', typeBadge(l.customer_type)], ['Phone', dash(l.phone)], ['Email', dash(l.email)],
    ['Preferred location', dash(l.preferred_location)], ['Property type', dash(label('property_type', l.property_type))], ['Interested in', dash(l.property_interest)],
    ['Bedrooms', dash(l.bedrooms)], ['Budget', dash(budgetText(l))], ['Lead source', dash(label('source', l.source))], ['Status', esc(label('status', l.status))],
    ['Assigned to', l.buyer_user_id ? 'You (registered buyer, assigned by service area or claimed)' : 'You'], ['How assigned', dash((l.assignment_rule || '').replace(/_/g, ' '))],
    ['Self-registered buyer', l.buyer_user_id ? 'Yes: they manage their own requirements' : 'No'], ['Follow-up date', dash(l.follow_up_on)], ['Notes', dash(l.notes)], ['Created', esc(fmtDateTime(l.created_at))], ['Last updated', esc(fmtDateTime(l.updated_at))],
    ['Stored in', esc(storedIn())]
  ]
  main.innerHTML = `
    <div class="page-head"><div><a href="#/leads" class="small">← All leads</a><h1>${esc(l.full_name)}</h1></div>
      <div class="row"><a class="btn ghost" href="#/viewings?lead=${l.id}">Schedule viewing</a><a class="btn ghost" href="#/leads/${l.id}/edit">Edit</a><button class="btn danger" id="delete">Delete</button></div></div>
    <div class="grid two-col">
      <section class="card"><h2>Details</h2><dl class="details">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></section>
      <section class="card"><h2>Activity</h2><ul class="timeline">${activities.map((a) => `<li><strong>${esc(a.summary)}</strong>
        <div class="small muted">${esc(fmtDateTime(a.created_at))} · via ${esc(VIA_LABELS[a.via] || a.via)}${a.user_name ? ` · by ${esc(a.user_name)}` : ''}</div></li>`).join('')}</ul></section>
    </div>
    <section class="card" style="margin-top:1rem"><h2>Matching properties</h2><p class="small muted">Kept up to date automatically when this lead’s requirements or any listing change.</p><div id="lead-matches"><p class="muted">Loading…</p></div></section>
    <section class="card" style="margin-top:1rem"><h2>Transfer to another agent</h2><form id="transfer" class="row"><label for="t-agent" class="sr-only">Agent</label><select id="t-agent" name="agentId" style="width:auto"><option value="">Choose an agent</option></select><button class="btn ghost" type="submit">Transfer</button></form><div id="transfer-msg"></div></section>
    <section class="card" style="margin-top:1rem"><h2>Email this lead</h2>
      <p class="small muted">A follow-up or property recommendation, sent from your own connected Gmail through viaSocket (Gmail · Send Email). You review it before anything is sent.</p>
      <div id="followup"><p class="muted">Loading…</p></div></section>`
  const followupBox = document.getElementById('followup')
  renderLeadMatches(l, document.getElementById('lead-matches'), (preset) => renderFollowupPanel(l, followupBox, preset))
  renderFollowupPanel(l, followupBox)
  api('/api/agents').then(({ agents }) => {
    document.getElementById('t-agent').insertAdjacentHTML('beforeend', agents.filter((a) => a.id !== session.user.id).map((a) => `<option value="${esc(a.id)}">${esc(a.name)}${a.agency ? ` (${esc(a.agency)})` : ''}</option>`).join(''))
  }).catch(() => {})
  document.getElementById('transfer').addEventListener('submit', async (e) => {
    e.preventDefault()
    const agentId = e.target.elements.agentId.value
    if (!agentId || !(await confirmDialog(`Transfer ${l.full_name}?`, 'The other agent becomes responsible and is notified. You will no longer see this lead.', 'Transfer'))) return
    try { await api(`/api/leads/${l.id}/transfer`, { method: 'POST', body: { agentId } }); toast('Lead transferred.'); location.hash = '#/leads' } catch (error) { document.getElementById('transfer-msg').innerHTML = `<div class="notice err">${esc(error.message)}</div>` }
  })
  document.getElementById('delete').addEventListener('click', async () => {
    const ok = await confirmDialog(`Delete ${l.full_name}?`, 'This permanently removes the lead and its activity history from DealSaathi\'s database. It cannot be undone.', 'Delete permanently')
    if (!ok) return
    try {
      await api(`/api/leads/${l.id}`, { method: 'DELETE' })
      toast(`Deleted ${l.full_name}.`)
      location.hash = '#/leads'
    } catch (error) {
      toast(error.message)
    }
  })
}

async function renderLeadForm(id) {
  let lead = { status: 'new' }
  if (id) {
    try {
      lead = (await api(`/api/leads/${encodeURIComponent(id)}`)).lead
    } catch (error) {
      main.innerHTML = `<div class="notice err">${esc(error.message)}</div><a href="#/leads">Back to leads</a>`
      return
    }
  }
  const idempotencyKey = crypto.randomUUID()
  main.innerHTML = `
    <div class="page-head"><div><a href="${id ? `#/leads/${id}` : '#/leads'}" class="small">← Back</a><h1>${id ? `Edit ${esc(lead.full_name)}` : 'New lead'}</h1>
      <p>Fields marked * are required. Leave anything you don't know empty.</p></div></div>
    <form class="card" id="lead-form" novalidate>
      <div id="form-notice"></div>
      <div class="form-grid">${FIELDS.map((f) => fieldHtml(f, lead[f.key])).join('')}</div>
      <div class="row end" style="margin-top:1rem"><a class="btn ghost" href="${id ? `#/leads/${id}` : '#/leads'}">Cancel</a>
        <button class="btn ghost" type="button" id="save-anyway" hidden>Save anyway</button>
        <button class="btn primary" type="submit" id="save">${id ? 'Save changes' : 'Save lead'}</button></div>
    </form>`
  const form = document.getElementById('lead-form')
  const notice = document.getElementById('form-notice')
  const saveBtn = document.getElementById('save')
  const anywayBtn = document.getElementById('save-anyway')
  bindMoneyHints(form)
  let busy = false
  const submit = async (allowSameName) => {
    if (busy) return
    busy = true
    saveBtn.disabled = anywayBtn.disabled = true
    saveBtn.textContent = 'Saving…'
    notice.innerHTML = ''
    try {
      const body = { lead: readForm(form), allowSameName }
      const res = id
        ? await api(`/api/leads/${id}`, { method: 'PATCH', body })
        : await api('/api/leads', { method: 'POST', body, headers: { 'Idempotency-Key': idempotencyKey } })
      toast(id ? (res.changed.length ? 'Changes saved.' : 'No changes to save.') : `Saved ${res.lead.full_name} (${res.lead.code}).`)
      location.hash = `#/leads/${res.lead.id}`
    } catch (error) {
      showFieldErrors(form, error.details?.fields)
      if (error.code === 'possible_duplicate') {
        const canOverride = !error.details.duplicates.some((d) => d.strong)
        notice.innerHTML = duplicatesHtml(error.details.duplicates, { canOverride })
        anywayBtn.hidden = !canOverride
      } else {
        notice.innerHTML = `<div class="notice err">${esc(error.message)} Nothing was saved.</div>`
      }
      notice.scrollIntoView({ block: 'nearest' })
    } finally {
      busy = false
      saveBtn.disabled = anywayBtn.disabled = false
      saveBtn.textContent = id ? 'Save changes' : 'Save lead'
    }
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(false) })
  anywayBtn.addEventListener('click', () => submit(true))
}

// ---------- assistant ----------
const EXAMPLES = [
  'Add Rahul Sharma, a buyer looking for a 2 BHK in Pune with a budget of ₹50 lakh. Phone 98765 43210.',
  'New tenant lead: Priya Nair wants a 1 BHK flat in Koramangala, Bangalore, up to 30,000 a month. priya.nair@example.com',
  'Seller Amit Joshi wants to sell his 3 BHK villa in Baner, Pune'
]

async function renderAssistant() {
  main.innerHTML = `
    <div class="page-head"><div><h1>Add a lead with AI</h1><p>Describe the lead in your own words. AI fills in a draft; nothing is saved until you check it and press <strong>Confirm and save</strong>.</p></div>
      <button class="btn ghost" id="new-chat">New conversation</button></div>
    <div class="assistant-layout">
      <section class="card chat" aria-label="Conversation">
        <div class="chat-log" id="log" aria-live="polite"></div>
        <div class="examples" id="examples">${EXAMPLES.map((e) => `<button type="button">${esc(e)}</button>`).join('')}</div>
        <form class="chat-form" id="chat-form">
          <label for="chat-input" class="skip">Message</label>
          <textarea id="chat-input" placeholder="e.g. Add Rahul Sharma, a buyer looking for a 2 BHK in Pune…" maxlength="2000"></textarea>
          <button class="btn primary" id="send">Send</button>
        </form>
      </section>
      <section class="card" id="review" aria-label="Review">
        <h2>Review</h2><p class="muted">The lead draft appears here after you send a message.</p>
      </section>
    </div>`

  const log = document.getElementById('log')
  const form = document.getElementById('chat-form')
  const input = document.getElementById('chat-input')
  const sendBtn = document.getElementById('send')
  const review = document.getElementById('review')
  let conversationId = store.get('ds_conversation')
  let action = null
  const dirty = new Set() // review fields the broker edited by hand: a later AI turn does not overwrite them

  const addMsg = (role, text, cls = '') => {
    const el = document.createElement('div')
    el.className = `msg ${role} ${cls}`.trim()
    el.textContent = text
    log.append(el)
    log.scrollTop = log.scrollHeight
    document.getElementById('examples').hidden = true
    return el
  }

  const renderEmptyReview = () => {
    review.innerHTML = '<h2>Review</h2><p class="muted">The lead draft appears here after you send a message.</p>'
  }

  const renderSaved = (lead, alreadySaved) => {
    review.innerHTML = `
      <div class="review-state"><span class="badge saved">Saved</span><h2 style="margin:0">${esc(lead.full_name)}</h2></div>
      <div class="notice ok">${alreadySaved ? 'This lead was already saved earlier; it was not saved twice.' : `Saved to ${esc(storedIn())}`} as <strong>${esc(lead.code)}</strong>. It has not been sent to any CRM or other app.</div>
      <dl class="details">${[['Type', typeBadge(lead.customer_type)], ['Phone', dash(lead.phone)], ['Email', dash(lead.email)], ['Location', dash(lead.preferred_location)],
        ['Looking for', dash(lookingFor(lead))], ['Budget', dash(budgetText(lead))], ['Saved at', esc(fmtDateTime(lead.created_at))]].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      <div class="row" style="margin-top:1rem"><a class="btn primary" href="#/leads/${lead.id}">Open lead</a><button class="btn ghost" id="another">Add another lead</button></div>`
    document.getElementById('another').addEventListener('click', () => { startOver(); input.focus() })
  }

  const renderReview = (a, notice = '') => {
    if (!a) return renderEmptyReview()
    const prev = review.querySelector('form') ? readForm(review.querySelector('form')) : {}
    const draft = { status: 'new', ...a.draft }
    for (const key of dirty) draft[key] = prev[key]
    const missing = new Set(a.missing.flatMap((m) => (m === 'phone_or_email' ? ['phone', 'email'] : [m])).filter((k) => draft[k] == null || draft[k] === ''))
    const canOverride = a.duplicates.length > 0 && !a.duplicates.some((d) => d.strong)
    review.innerHTML = `
      <div class="review-state"><span class="badge draft">Draft, not saved</span><h2 style="margin:0">Check the details</h2></div>
      <p class="small muted">Fields tagged <span class="badge ai">AI</span> were filled in from your message. Empty fields are unknown. Correct anything before saving.</p>
      ${a.uncertain.length ? `<div class="notice warn"><strong>Please double-check:</strong><ul>${a.uncertain.map((u) => `<li>${esc(u.question)}</li>`).join('')}</ul></div>` : ''}
      ${a.warnings.length ? `<div class="notice info"><ul>${a.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
      <div id="review-notice">${notice}${duplicatesHtml(a.duplicates, { canOverride })}</div>
      <form id="review-form" novalidate>
        <div class="form-grid">${FIELDS.map((f) => fieldHtml(f, draft[f.key], { missing: missing.has(f.key), aiTag: a.sources?.[f.key] === 'ai' && !dirty.has(f.key) })).join('')}</div>
        <div class="row end" style="margin-top:1rem">
          <button class="btn ghost" type="button" id="cancel-draft">Cancel draft</button>
          <button class="btn ghost" type="button" id="save-anyway" ${canOverride ? '' : 'hidden'}>Save anyway</button>
          <button class="btn primary" type="submit" id="confirm">Confirm and save</button>
        </div>
      </form>`
    const rf = document.getElementById('review-form')
    bindMoneyHints(rf)
    rf.addEventListener('input', (e) => { if (e.target.name) dirty.add(e.target.name) })
    rf.addEventListener('change', (e) => { if (e.target.name) dirty.add(e.target.name) })
    let busy = false
    const confirmBtn = document.getElementById('confirm')
    const anywayBtn = document.getElementById('save-anyway')
    const save = async (allowSameName) => {
      if (busy) return
      busy = true
      confirmBtn.disabled = anywayBtn.disabled = true
      confirmBtn.textContent = 'Saving…'
      try {
        const res = await api(`/api/assistant/actions/${a.id}/confirm`, { method: 'POST', body: { fields: readForm(rf), allowSameName } })
        addMsg('assistant', res.alreadySaved ? `${res.lead.full_name} was already saved as ${res.lead.code}.` : `Saved ${res.lead.full_name} as lead ${res.lead.code} in DealSaathi's database.`)
        action = null
        dirty.clear()
        renderSaved(res.lead, res.alreadySaved)
      } catch (error) {
        showFieldErrors(rf, error.details?.fields)
        const box = document.getElementById('review-notice')
        if (error.code === 'possible_duplicate') {
          const override = !error.details.duplicates.some((d) => d.strong)
          box.innerHTML = duplicatesHtml(error.details.duplicates, { canOverride: override })
          anywayBtn.hidden = !override
        } else {
          box.innerHTML = `<div class="notice err">${esc(error.message)}${error.code === 'validation_failed' ? ' Nothing was saved.' : ''}</div>`
        }
        box.scrollIntoView({ block: 'nearest' })
      } finally {
        busy = false
        confirmBtn.disabled = anywayBtn.disabled = false
        confirmBtn.textContent = 'Confirm and save'
      }
    }
    rf.addEventListener('submit', (e) => { e.preventDefault(); save(false) })
    anywayBtn.addEventListener('click', () => save(true))
    document.getElementById('cancel-draft').addEventListener('click', async () => {
      try {
        await api(`/api/assistant/actions/${a.id}/cancel`, { method: 'POST', body: {} })
        addMsg('assistant', 'Cancelled. Nothing was saved.')
        action = null
        dirty.clear()
        renderEmptyReview()
      } catch (error) {
        toast(error.message)
      }
    })
  }

  const startOver = () => {
    conversationId = null
    action = null
    dirty.clear()
    store.set('ds_conversation', null)
    log.innerHTML = ''
    document.getElementById('examples').hidden = false
    renderEmptyReview()
  }

  let sending = false
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text || sending) return
    sending = true
    sendBtn.disabled = true
    addMsg('user', text)
    input.value = ''
    const thinking = addMsg('assistant', 'Reading your message…', 'thinking')
    try {
      const res = await api('/api/assistant/messages', { method: 'POST', body: { conversationId, message: text } })
      conversationId = res.conversationId
      store.set('ds_conversation', conversationId)
      thinking.remove()
      addMsg('assistant', res.reply)
      if (res.action) {
        if (action && action.id !== res.action.id) dirty.clear()
        action = res.action
        renderReview(action)
      } else if (res.status === 'cancelled') {
        action = null
        dirty.clear()
        renderEmptyReview()
      }
    } catch (error) {
      thinking.remove()
      if (error.details?.conversationId) {
        conversationId = error.details.conversationId
        store.set('ds_conversation', conversationId)
      }
      if (error.code === 'conversation_not_found') startOver()
      addMsg('assistant', `${error.message} Nothing was saved.`, 'error')
    } finally {
      sending = false
      sendBtn.disabled = false
      input.focus()
    }
  })
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit() } })
  document.getElementById('examples').addEventListener('click', (e) => {
    if (e.target.tagName === 'BUTTON') { input.value = e.target.textContent; input.focus() }
  })
  document.getElementById('new-chat').addEventListener('click', () => { startOver(); input.focus() })

  if (conversationId) {
    try {
      const conv = await api(`/api/assistant/conversations/${encodeURIComponent(conversationId)}`)
      for (const m of conv.messages) addMsg(m.role, m.content, m.payload?.status === 'ai_error' ? 'error' : '')
      action = conv.action
      renderReview(action)
    } catch {
      startOver()
    }
  }
}

// ---------- access ----------
const session = { mode: 'accounts', hosted: false, user: null, hasUsers: true, registrationNeedsCode: false }
const storedIn = () => (session.hosted ? "DealSaathi's own database on its hosting server" : 'the local database on this computer')

function renderLogin(view = session.hasUsers ? 'signin' : 'register') {
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.remove('active'))
  const register = view === 'register'
  main.innerHTML = `
    <div class="card" style="max-width:440px;margin:3rem auto">
      <h1>${register ? 'Create your account' : 'Sign in'}</h1>
      <p class="muted">${register ? 'DealSaathi connects buyers, sellers and the agents who help them.' : 'Sign in to DealSaathi.'}</p>
      <form id="auth-form" class="stack" novalidate>
        ${register ? `<fieldset class="field role-pick" data-field="role"><legend>I am a…</legend>
          <label class="radio"><input type="radio" name="role" value="buyer"> <span><strong>Buyer or tenant</strong><br><span class="small muted">Save what you are looking for and get matching properties</span></span></label>
          <label class="radio"><input type="radio" name="role" value="seller"> <span><strong>Seller or landlord</strong><br><span class="small muted">List your property and see interest</span></span></label>
          <label class="radio"><input type="radio" name="role" value="agent"> <span><strong>Agent</strong><br><span class="small muted">Manage leads, listings, viewings and rent${session.registrationNeedsCode ? ' (needs your team’s access code)' : ''}</span></span></label>
          <div class="err"></div></fieldset>
          <div class="field" data-field="name"><label for="a-name">Your name</label><input id="a-name" name="name" autocomplete="name" required><div class="err"></div></div>
          <div class="field" data-field="phone"><label for="a-phone">Phone (optional)</label><input id="a-phone" name="phone" type="tel" autocomplete="tel"><div class="err"></div></div>` : ''}
        <div class="field" data-field="email"><label for="a-email">Email</label><input id="a-email" name="email" type="email" autocomplete="email" required><div class="err"></div></div>
        <div class="field" data-field="password"><label for="a-password">Password</label><input id="a-password" name="password" type="password" autocomplete="${register ? 'new-password' : 'current-password'}" required>${register ? '<div class="hint">At least 10 characters.</div>' : ''}<div class="err"></div></div>
        ${register && session.registrationNeedsCode ? '<div class="field" data-field="accessCode" id="code-field" hidden><label for="a-code">Team access code</label><input id="a-code" name="accessCode" type="password" autocomplete="off"><div class="hint">Agents only. Ask the person who set up DealSaathi.</div><div class="err"></div></div>' : ''}
        <div id="auth-error"></div>
        <button class="btn primary" type="submit">${register ? 'Create account' : 'Sign in'}</button>
        <button class="btn ghost" type="button" id="auth-switch">${register ? 'I already have an account' : 'Create an account'}</button>
        ${register ? '' : '<button class="btn link small" type="button" id="auth-forgot">Forgot your password?</button>'}
      </form>
    </div>`
  const form = document.getElementById('auth-form')
  form.querySelector('input').focus()
  form.querySelectorAll('input[name=role]').forEach((r) => r.addEventListener('change', () => {
    const code = document.getElementById('code-field')
    if (code) code.hidden = form.elements.role.value !== 'agent'
  }))
  document.getElementById('auth-switch').addEventListener('click', () => renderLogin(register ? 'signin' : 'register'))
  document.getElementById('auth-forgot')?.addEventListener('click', renderForgot)
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const body = Object.fromEntries(new FormData(form))
    if (register && !body.role) { showFieldErrors(form, { role: 'Choose Buyer, Seller or Agent.' }); return }
    try {
      const res = await api(register ? '/api/session/register' : '/api/session/login', { method: 'POST', body })
      Object.assign(session, { user: res.user, hasUsers: true })
      updateAccessUi()
      route()
    } catch (error) {
      showFieldErrors(form, error.details?.fields)
      document.getElementById('auth-error').innerHTML = `<div class="notice err">${esc(error.message)}</div>`
    }
  })
}

function renderForgot() {
  main.innerHTML = `<div class="card" style="max-width:440px;margin:3rem auto"><h1>Reset your password</h1>
    <p class="muted">Enter your account’s email. If it has an account, we send a link that works for 30 minutes.</p>
    <form id="fg-form" class="stack" novalidate><div class="field" data-field="email"><label for="fg-email">Email</label><input id="fg-email" name="email" type="email" autocomplete="email"><div class="err"></div></div>
      <div id="fg-msg"></div><button class="btn primary" type="submit">Send reset link</button><button class="btn ghost" type="button" id="fg-back">Back to sign in</button></form></div>`
  document.getElementById('fg-back').addEventListener('click', () => renderLogin('signin'))
  document.getElementById('fg-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const msg = document.getElementById('fg-msg')
    try {
      const r = await api('/api/session/password/forgot', { method: 'POST', body: { email: e.target.elements.email.value } })
      msg.innerHTML = `<div class="notice ok">${esc(r.message)}</div>`
    } catch (error) { msg.innerHTML = `<div class="notice ${error.status === 503 ? 'warn' : 'err'}">${esc(error.message)}</div>` }
  })
}

async function renderResetPassword(token) {
  main.innerHTML = `<div class="card" style="max-width:440px;margin:3rem auto"><h1>Choose a new password</h1>
    <form id="rp-form" class="stack" novalidate><div class="field" data-field="password"><label for="rp-pw">New password</label><input id="rp-pw" name="password" type="password" autocomplete="new-password"><div class="hint">At least 10 characters. You will be signed out everywhere.</div><div class="err"></div></div>
      <div id="rp-msg"></div><button class="btn primary" type="submit">Save new password</button></form></div>`
  document.getElementById('rp-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    try {
      await api('/api/session/password/reset', { method: 'POST', body: { token, password: e.target.elements.password.value } })
      history.replaceState(null, '', '#/dashboard')
      session.user = null
      updateAccessUi()
      renderLogin('signin')
      toast('Password changed. Sign in with the new one.')
    } catch (error) { showFieldErrors(e.target, error.details?.fields); document.getElementById('rp-msg').innerHTML = `<div class="notice err">${esc(error.message)}</div>` }
  })
}

async function renderVerifyEmail(token) {
  main.innerHTML = '<div class="card" style="max-width:440px;margin:3rem auto"><h1>Confirming your email…</h1></div>'
  try {
    const r = await api('/api/session/verify-email', { method: 'POST', body: { token } })
    if (session.user) session.user.emailVerified = true
    main.innerHTML = `<div class="card" style="max-width:440px;margin:3rem auto"><h1>Email confirmed</h1><p>Thank you.${r.tenanciesLinked ? ` ${r.tenanciesLinked} tenancy record(s) were linked to your account.` : ''}</p><a class="btn primary" href="#/dashboard">Continue</a></div>`
    updateAccessUi()
  } catch (error) {
    main.innerHTML = `<div class="card" style="max-width:440px;margin:3rem auto"><h1>Link not valid</h1><div class="notice err">${esc(error.message)}</div><a href="#/dashboard">Continue</a></div>`
  }
  history.replaceState(null, '', '#/dashboard')
}

async function renderInvite(token) {
  try {
    const p = await api('/api/invites/preview', { method: 'POST', body: { token } })
    const ok = p.state === 'pending' && p.matchesYourAccount
    main.innerHTML = `<div class="card" style="max-width:520px;margin:3rem auto"><h1>Tenancy invitation</h1>
      <p>${esc(p.agentName || 'An agent')} invited <strong>${esc(p.sentTo)}</strong> to see a tenancy as its ${esc(p.party)}${p.propertyLabel ? `: <strong>${esc(p.propertyLabel)}</strong>` : ''}.</p>
      ${p.state !== 'pending' ? `<div class="notice warn">This invitation is ${esc(p.state)}. Ask your agent for a new one.</div>` : !p.matchesYourAccount ? `<div class="notice warn">You are signed in as ${esc(session.user.email)} (${esc(ROLE_LABEL[session.user.role])}). This invitation is for a ${p.party === 'tenant' ? 'buyer/tenant' : 'seller/landlord'} account with the invited email. Sign out and sign in with that account.</div>` : ''}
      <div id="inv-msg"></div><div class="row end">${ok ? '<button class="btn primary" id="inv-accept">Accept</button>' : ''}<a class="btn ghost" href="#/dashboard">Not now</a></div></div>`
    document.getElementById('inv-accept')?.addEventListener('click', async () => {
      try { await api('/api/invites/accept', { method: 'POST', body: { token } }); store.set('pendingInvite', null); toast('Tenancy linked to your account.'); location.hash = '#/my-tenancies' } catch (error) { document.getElementById('inv-msg').innerHTML = `<div class="notice err">${esc(error.message)}</div>` }
    })
  } catch (error) {
    main.innerHTML = `<div class="notice err">${esc(error.message)}</div>`
  }
}

function renderLocked() {
  main.innerHTML = `<div class="card" style="max-width:520px;margin:3rem auto"><h1>Not ready yet</h1>
    <p>This hosted copy of DealSaathi is locked because no team access code has been set.</p>
    <p class="muted">The owner adds <strong>APP_PASSWORD</strong> (at least 12 characters) in the hosting settings, then reloads this page. Brokers then use that code once, to create their own accounts.</p></div>`
}

const ROLE_LABEL = { buyer: 'Buyer', seller: 'Seller', agent: 'Agent' }
/** Each role's sections, in nav order. The server enforces the same split; this only decides what is shown. */
const NAV = {
  agent: [['dashboard', 'Dashboard'], ['notifications', 'Notifications'], ['assistant', 'Add with AI'], ['leads', 'Leads'], ['pool', 'Lead pool'], ['properties', 'Properties'], ['viewings', 'Viewings'], ['feedback', 'Feedback'], ['rent', 'Rent'], ['integrations', 'Integrations'], ['automations', 'Automations'], ['activity', 'Activity log'], ['profile', 'Profile']],
  buyer: [['dashboard', 'Home'], ['assistant', 'Assistant'], ['requirements', 'My requirements'], ['recommendations', 'Recommendations'], ['browse', 'Browse listings'], ['my-viewings', 'My viewings'], ['my-tenancies', 'My rent'], ['notifications', 'Notifications']],
  seller: [['dashboard', 'Home'], ['my-listings', 'My listings'], ['listing-viewings', 'Viewings'], ['my-tenancies', 'My rentals'], ['notifications', 'Notifications'], ['profile', 'Profile']]
}
function renderNav() {
  const nav = document.getElementById('nav')
  const items = session.user ? NAV[session.user.role] || [] : []
  nav.innerHTML = items.map(([key, text]) => `<a href="#/${key}" data-nav="${key}">${esc(text)}${key === 'notifications' ? ' <span class="badge" id="unread" hidden></span>' : ''}</a>`).join('')
}
async function refreshUnread() {
  const el = document.getElementById('unread')
  if (!el || !session.user) return
  try {
    const { unread } = await api('/api/notifications?unread=1&limit=1')
    el.textContent = unread
    el.hidden = !unread
  } catch { /* the page shows its own error */ }
}

function updateAccessUi() {
  const foot = document.querySelector('.sidebar-foot')
  document.getElementById('account')?.remove()
  renderNav()
  if (!session.user) return
  const box = document.createElement('div')
  box.id = 'account'
  box.className = 'account'
  box.innerHTML = `<div class="small"><strong>${esc(session.user.name)}</strong> <span class="badge">${esc(ROLE_LABEL[session.user.role] || '')}</span><div class="muted">${esc(session.user.email)}</div>
    ${session.user.emailVerified ? '' : '<div class="small" style="margin-top:.25rem"><span class="pill pill-setup">Email not verified</span> <button class="btn link small" type="button" id="verify-send">Send link</button></div>'}</div>`
  box.querySelector('#verify-send')?.addEventListener('click', async () => {
    try { await api('/api/me/verification/send', { method: 'POST', body: {} }); toast(`Verification link sent to ${session.user.email}.`) } catch (error) { toast(error.message) }
  })
  const out = document.createElement('button')
  out.className = 'btn ghost small'
  out.id = 'sign-out'
  out.textContent = 'Sign out'
  out.addEventListener('click', async () => {
    await api('/api/session/logout', { method: 'POST', body: {} }).catch(() => {})
    session.user = null
    updateAccessUi()
    renderLogin('signin')
  })
  box.append(out)
  foot.before(box)
}

// ---------- viaSocket: the official browser SDK (viasocket-apps/browser) ----------
let sdkPromise = null
/** The official connect() module, served from the installed viasocket-apps package. */
function loadSdk() {
  sdkPromise ||= import('/vendor/viasocket-apps-browser.js').then((sdk) => {
    sdk.loadConnectScript().catch(() => {}) // ahead of the click, so the popup opens at once
    return sdk
  })
  return sdkPromise
}

const CONNECT_ERRORS = {
  closed: 'The window was closed before you finished, so nothing was connected. If you did finish signing in, the connection will still appear here shortly.',
  rejected: 'The app refused the connection.',
  invalid: 'viaSocket did not accept this app id.',
  script: 'viaSocket’s connect script could not load. Check your internet connection or ad blocker, then try again.',
  unavailable: 'The sign-in window could not open. Allow pop-ups for this site and try again.'
}

/**
 * Opens viaSocket's Connect popup for one app and saves the connection on the server, which checks it
 * belongs to this user. `ready` must already hold the token and SDK: the popup has to open straight from the click.
 */
async function runConnect(ready, { serviceId, actions, authId, appName }, onDone) {
  const save = async (newAuthId) => {
    const { connection } = await api('/api/integrations/connections', { method: 'POST', body: { serviceId, authId: newAuthId } })
    toast(`${connection.appName} connected${connection.label ? ` (${connection.label})` : ''}.`)
    onDone?.(connection)
  }
  try {
    const { authId: newAuthId } = await ready.sdk.connect({
      embedToken: ready.token,
      serviceId,
      ...(actions?.length ? { actions, skipActionSelection: true } : {}),
      ...(authId ? { authId } : {}),
      onLateSuccess: ({ authId: late }) => save(late).catch((e) => toast(e.message))
    })
    await save(newAuthId)
    return { ok: true }
  } catch (error) {
    const known = CONNECT_ERRORS[error?.code]
    const message = error?.code === 'rejected' && error.message ? `${appName || 'The app'} refused the connection: ${error.message}` : known || error.message || 'The connection did not complete.'
    return { ok: false, code: error?.code || 'error', message }
  }
}

/** Token and SDK fetched when the page opens, so a later click can open the popup immediately. */
async function prepareConnect() {
  const [{ embedToken }, sdk] = await Promise.all([api('/api/integrations/token'), loadSdk()])
  return { token: embedToken, sdk }
}

const STATUS_BADGE = {
  active: '<span class="badge saved">Connected</span>',
  expired: '<span class="badge draft">Expired: reconnect</span>',
  missing: '<span class="badge danger-badge">Removed on viaSocket</span>',
  unknown: '<span class="badge">Status unknown</span>'
}
const appIcon = (url, name) => (url ? `<img class="app-icon" src="${esc(url)}" alt="" width="28" height="28" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">` : `<span class="app-icon app-icon-fallback" aria-hidden="true">${esc((name || '?')[0])}</span>`)

const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Moscow', 'Africa/Johannesburg', 'America/New_York', 'America/Toronto', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Mexico_City', 'America/Sao_Paulo']
const PILL = {
  enabled: '<span class="pill pill-on">Enabled</span>',
  disabled: '<span class="pill pill-off">Disabled</span>',
  needs_setup: '<span class="pill pill-setup">Needs setup</span>'
}
const RUN_STATUS = { running: 'Running', succeeded: 'Succeeded', failed: 'Failed', skipped: 'Skipped', unknown: 'Outcome unknown' }

/** The broker's connections per curated app, from /api/integrations/apps (live-checked on the server). */
async function loadApps() {
  const { apps, live, error } = await api('/api/integrations/apps')
  return { apps, live, error, bySlug: Object.fromEntries(apps.map((a) => [a.slug, a])) }
}

async function renderIntegrations() {
  main.innerHTML = `
    <div class="page-head"><div><h1>Integrations</h1>
      <p>The apps DealSaathi works with. You sign in on each app’s own page; viaSocket keeps the access, and DealSaathi stores only a reference to your connection.</p></div></div>
    <div id="int-notice"></div><div class="int-grid" id="int-grid"><p class="muted">Loading…</p></div>`
  const notice = document.getElementById('int-notice')
  let ready = null
  try {
    ready = await prepareConnect()
  } catch (error) {
    notice.innerHTML = `<div class="notice err">${esc(error.message)}</div>`
  }

  const draw = async () => {
    const grid = document.getElementById('int-grid')
    if (!grid) return
    let data
    try {
      data = await loadApps()
    } catch (error) {
      grid.innerHTML = `<div class="notice err">${esc(error.message)}</div>`
      return
    }
    if (data.error) notice.innerHTML = `<div class="notice warn">${esc(data.error)}</div>`
    grid.innerHTML = data.apps.map((a) => {
      const active = a.connections.filter((c) => c.status === 'active')
      const pill = !data.live && a.connections.length ? '<span class="pill pill-off">Status unknown</span>'
        : active.length ? '<span class="pill pill-on">Connected</span>'
          : a.connections.some((c) => c.status === 'expired') ? '<span class="pill pill-setup">Expired</span>' : '<span class="pill pill-off">Not connected</span>'
      return `<section class="card int-card">
        <div class="row">${appIcon(a.iconUrl, a.name)}<h2 style="margin:0;flex:1">${esc(a.name)}</h2>${pill}</div>
        <p class="small">${esc(a.purpose)}</p>
        <p class="small muted">Used by: ${esc(a.usedBy.join(', '))}</p>
        ${a.liveBlocked ? `<div class="notice warn small"><strong>Not available for live use.</strong> ${esc(a.liveBlocked)}</div>` : a.inUse ? '' : '<div class="notice info small">DealSaathi does not use this app yet. You can connect it now; nothing will run on it until that feature is built.</div>'}
        ${a.error ? `<div class="notice err small">${esc(a.error)}</div>` : ''}
        ${a.connections.length ? `<ul class="timeline">${a.connections.map((c) => `<li class="conn-row"><div class="conn-info"><strong>${esc(c.label || a.name)}</strong> ${STATUS_BADGE[c.status] || ''}
            <div class="small muted">connection #${c.id} · connected ${esc(fmtDate(c.createdAt))}${c.verification ? ` · access check ${esc(fmtDateTime(c.verification.at))}: <span style="color:${c.verification.status === 'ok' ? 'inherit' : 'var(--danger)'}">${esc(c.verification.detail)}</span>` : ' · access not checked yet'}</div></div>
            ${c.status === 'active' && a.inUse ? `<button class="btn ghost small" data-verify="${c.id}">Check access</button>` : ''}
            ${c.status === 'active' && ['gmail', 'slack', 'google-calendar'].includes(a.slug) ? `<button class="btn ghost small" data-livetest="${c.id}" data-slug="${a.slug}">Send test</button>` : ''}
            ${c.status === 'expired' ? `<button class="btn ghost small" data-reconnect="${c.id}">Reconnect</button>` : ''}
            <button class="btn ghost small" data-disconnect="${c.id}" data-name="${esc(a.name)}">Disconnect</button></li>`).join('')}</ul>` : ''}
        <div><button class="btn ${active.length || !a.inUse ? 'ghost' : 'primary'} connect-btn" data-connect="${esc(a.slug)}" ${ready && a.serviceId ? '' : 'disabled'}>${appIcon(a.iconUrl, a.name)} ${active.length ? `Connect another ${esc(a.name)} account` : `Connect ${esc(a.name)}`}</button></div>
        <div data-msg="${esc(a.slug)}"></div>
      </section>`
    }).join('')
    grid.querySelectorAll('[data-connect]').forEach((b) => b.addEventListener('click', async () => {
      const a = data.bySlug[b.dataset.connect]
      const out = await runConnect(ready, { serviceId: a.serviceId, actions: a.actions, appName: a.name }, () => draw())
      if (!out.ok) grid.querySelector(`[data-msg="${a.slug}"]`).innerHTML = `<div class="notice ${out.code === 'closed' ? 'warn' : 'err'} small">${esc(out.message)}</div>`
    }))
    grid.querySelectorAll('[data-disconnect]').forEach((b) => b.addEventListener('click', async () => {
      const ok = await confirmDialog(`Disconnect ${b.dataset.name}?`, 'DealSaathi pauses what it runs on this account, then revokes the connection on viaSocket. Automations that use it will show Needs setup until you connect again.', 'Disconnect')
      if (!ok) return
      try {
        await api(`/api/integrations/connections/${b.dataset.disconnect}`, { method: 'DELETE' })
        toast(`${b.dataset.name} disconnected.`)
        draw()
      } catch (error) { toast(error.message) }
    }))
    grid.querySelectorAll('[data-verify]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true
      b.textContent = 'Checking…'
      try {
        const r = await api(`/api/integrations/connections/${b.dataset.verify}/verify`, { method: 'POST', body: {} })
        toast(r.status === 'ok' ? r.detail : `Access check failed: ${r.detail}`)
      } catch (error) { toast(error.message) }
      draw()
    }))
    grid.querySelectorAll('[data-livetest]').forEach((b) => b.addEventListener('click', async () => {
      const slug = b.dataset.slug
      const body = { confirm: true }
      if (slug === 'slack') {
        try {
          const { options } = await api(`/api/automations/slack-channels?connectionId=${b.dataset.livetest}`)
          const pick = prompt(`Post one test message to which channel?\n${options.map((o) => o.label).join(', ')}`, options[0]?.label || '')
          const ch = options.find((o) => o.label === pick || o.value === pick)
          if (!ch) return
          body.slackChannelId = ch.value
        } catch (error) { toast(error.message); return }
      }
      const what = { gmail: `send one real email to ${session.user.email}`, slack: 'post one real message to that channel', 'google-calendar': 'create a real 15-minute event tomorrow at 09:00 in your calendar and delete it again' }[slug]
      if (!(await confirmDialog('Run a real test?', `This will ${what}, through your own connected account.`, 'Run test'))) return
      b.disabled = true
      b.textContent = 'Testing…'
      try {
        const r = await api(`/api/integrations/connections/${b.dataset.livetest}/test`, { method: 'POST', body })
        toast(r.status === 'sent' ? `Real test passed: ${r.detail}` : `Test ${r.status}: ${r.detail}`)
      } catch (error) { toast(error.message) }
      draw()
    }))
    grid.querySelectorAll('[data-reconnect]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const r = await api(`/api/integrations/connections/${b.dataset.reconnect}/reconnect`, { method: 'POST', body: {} })
        const out = await runConnect({ ...ready, token: r.embedToken }, { serviceId: r.serviceId, authId: r.authId }, () => draw())
        if (!out.ok) notice.innerHTML = `<div class="notice ${out.code === 'closed' ? 'warn' : 'err'}">${esc(out.message)}</div>`
      } catch (error) { toast(error.message) }
    }))
  }
  draw()
}

// ---------- real estate automations: DealSaathi's own, run by its server ----------
function runLine(run) {
  if (!run) return '<span class="muted">Not run yet</span>'
  return `<span class="run-${run.status}">${esc(RUN_STATUS[run.status])}</span> · ${esc(fmtDateTime(run.finishedAt || run.startedAt))}${run.summary || run.error ? ` · ${esc(run.summary || run.error)}` : ''}`
}

async function renderAutomations() {
  main.innerHTML = `
    <div class="page-head"><div><h1>Real Estate Automations</h1>
      <p>Ready-made automations for your brokerage. DealSaathi runs them for you, and each one acts only through the accounts you connect on the Integrations page.</p></div></div>
    <div id="auto-notice"></div><div class="auto-grid" id="auto-grid"><p class="muted">Loading…</p></div>
    <dialog id="auto-dialog" class="wide-dialog" aria-labelledby="auto-title"><div id="auto-panel"></div></dialog>`
  const draw = async () => {
    const grid = document.getElementById('auto-grid')
    if (!grid) return
    let list
    try {
      ({ automations: list } = await api('/api/automations'))
    } catch (error) {
      grid.innerHTML = `<div class="notice err">${esc(error.message)}</div>`
      return
    }
    const warning = list.find((a) => a.warning)?.warning
    document.getElementById('auto-notice').innerHTML = warning ? `<div class="notice warn">${esc(warning)}</div>` : ''
    grid.innerHTML = list.map((a) => `<section class="card auto-card">
      <div class="row" style="align-items:flex-start"><h2 style="margin:0;flex:1">${esc(a.name)}</h2>${PILL[a.status]}</div>
      <p class="small">${esc(a.description)}</p>
      <dl class="mini"><dt>Trigger</dt><dd>${esc(a.trigger)}</dd><dt>Action</dt><dd>${esc(a.action)}</dd></dl>
      ${a.status === 'needs_setup' && a.problems.length ? `<div class="notice ${a.available ? 'warn' : 'info'} small"><ul>${a.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
      <div class="small">${a.available ? `Last run: ${runLine(a.lastRun)}` : ''}</div>
      <div class="row card-foot">
        <label class="switch"><input type="checkbox" role="switch" data-toggle="${a.key}" ${a.enabled ? 'checked' : ''} ${a.available ? '' : 'disabled'}><span>${a.enabled ? 'On' : 'Off'}</span></label>
        <button class="btn ghost small" data-configure="${a.key}">${a.available ? 'Configure' : 'What’s needed'}</button>
      </div></section>`).join('')
    grid.querySelectorAll('[data-toggle]').forEach((el) => el.addEventListener('change', async () => {
      const a = list.find((x) => x.key === el.dataset.toggle)
      el.disabled = true
      try {
        await api(`/api/automations/${a.key}`, { method: 'PUT', body: { enabled: el.checked, config: a.config } })
        toast(`${a.name} ${el.checked ? 'switched on' : 'switched off'}.`)
      } catch (error) {
        toast(error.details?.problems ? `${error.message} ${error.details.problems[0]}` : error.message)
        if (error.code === 'needs_setup') openConfigure(a)
      }
      draw()
    }))
    grid.querySelectorAll('[data-configure]').forEach((b) => b.addEventListener('click', () => openConfigure(list.find((x) => x.key === b.dataset.configure))))
  }

  async function openConfigure(a) {
    const dialog = document.getElementById('auto-dialog')
    const panel = document.getElementById('auto-panel')
    panel.innerHTML = '<p class="muted">Loading…</p>'
    dialog.showModal()
    if (!a.available) {
      panel.innerHTML = `<h2 id="auto-title">${esc(a.name)}</h2><p>${esc(a.description)}</p><div class="notice info">${esc(a.problems[0])}</div>
        <div class="row end"><button class="btn primary" id="auto-close">Close</button></div>`
      document.getElementById('auto-close').addEventListener('click', () => dialog.close())
      return
    }
    let apps = { bySlug: {} }
    let runs = []
    try {
      [apps, { runs }] = await Promise.all([a.channels.length ? loadApps() : Promise.resolve({ bySlug: {} }), api(`/api/automations/${a.key}/runs`)])
    } catch (error) {
      panel.innerHTML = `<div class="notice err">${esc(error.message)}</div>`
      return
    }
    const cfg = a.config || {}
    const accounts = (slug) => (apps.bySlug[slug]?.connections || []).filter((c) => c.status === 'active')
    const accountSelect = (slug, name, selected) => {
      const list = accounts(slug)
      return list.length
        ? `<select name="${name}">${list.map((c) => `<option value="${c.id}" ${String(c.id) === String(selected) ? 'selected' : ''}>${esc(c.label || apps.bySlug[slug].name)}</option>`).join('')}</select>`
        : `<div class="notice info small">No ${esc(apps.bySlug[slug]?.name || slug)} account connected. <a href="#/integrations">Connect one on Integrations</a>.</div>`
    }
    const channelFields = (prefix, channel, allowNone) => `
      <div class="field"><label>${prefix === 'notify' ? 'Notify me' : 'Send through'}</label>
        <div class="row">${allowNone ? `<label class="radio"><input type="radio" name="ch" value="none" ${channel === 'none' || !channel ? 'checked' : ''}> Only in DealSaathi</label>` : ''}
          <label class="radio"><input type="radio" name="ch" value="gmail" ${channel === 'gmail' ? 'checked' : ''}> Email (Gmail)</label>
          <label class="radio"><input type="radio" name="ch" value="slack" ${channel === 'slack' ? 'checked' : ''}> Slack</label></div></div>
      <div data-ch="gmail" class="stack">
        <div class="field"><label>Gmail account</label>${accountSelect('gmail', 'gmailConnectionId', cfg.channel === 'gmail' || cfg.notify === 'gmail' ? cfg.connectionId : null)}</div>
        <div class="field"><label for="emailTo">Send to</label><input id="emailTo" name="emailTo" value="${esc(cfg.emailTo || session.user.email)}"><div class="hint">One to five addresses, separated by commas.</div></div>
      </div>
      <div data-ch="slack" class="stack">
        <div class="field"><label>Slack workspace</label>${accountSelect('slack', 'slackConnectionId', cfg.channel === 'slack' || cfg.notify === 'slack' ? cfg.connectionId : null)}</div>
        <div class="field"><label for="slackChannelId">Channel</label><select id="slackChannelId" name="slackChannelId"><option value="">Loading channels…</option></select></div>
      </div>`

    let body = ''
    if (a.key === 'new_lead_alert') body = channelFields('send', cfg.channel || 'gmail', false) + '<p class="small muted">The message includes the lead’s name, phone, email, source, budget, location and requirements as saved. Anything not on record says “not given”.</p>'
    if (a.key === 'buyer_matching') body = `<p>Matching runs for the whole marketplace on its own: whenever a listing is published or changed, or a buyer saves or changes requirements. Each match is stored with its reasons, and nobody is told twice about the same unchanged match.</p>
      <p class="small">While this is on, you get an in-app notice for new matches involving your buyers and listings. You can also get one message per change, listing every new match for your buyers:</p>
      ${channelFields('notify', cfg.notify || 'none', true)}
      <div class="notice info small">Registered buyers see their matches in the app automatically. Sending to buyers on WhatsApp needs a WhatsApp Business account with an approved message template, which is not available yet.</div>`
    if (a.key === 'property_recommendations') body = `<div class="field"><label>Send from Gmail account</label>${accountSelect('gmail', 'gmailConnectionId', cfg.connectionId)}</div>
      <div class="notice info small">You always review and approve each recommendation before it is sent. This cannot be turned off.</div>
      <p class="small muted">Open a lead, tick the matching listings, and choose “Email these to the lead”. Sample listings can never be sent.</p>`
    if (a.key === 'followup_reminders') body = `<div class="field"><label for="inactiveDays">Remind me when a buyer or tenant has no recorded activity for</label>
        <div class="row"><input id="inactiveDays" name="inactiveDays" type="number" min="1" max="90" value="${esc(cfg.inactiveDays ?? 3)}" style="width:6rem"> days</div>
        <div class="hint">DealSaathi cannot see whether a buyer opened or replied to anything, so this counts activity recorded in DealSaathi. A lead’s follow-up date (on its edit page) also creates a reminder when it arrives.</div></div>
      ${channelFields('notify', cfg.notify || 'none', true)}
      <div class="notice ${a.scheduler ? 'ok' : 'warn'} small">${a.scheduler ? 'The scheduler checks every 15 minutes (India time).' : 'The 15-minute scheduler runs only on the hosted DealSaathi. Here, use Run check now.'}
        ${a.lastCheck ? `<br>Last check: ${esc(fmtDateTime(a.lastCheck.at))} (${esc(a.lastCheck.trigger)}): ${a.lastCheck.created} new reminder(s).` : ''}</div>
      <div class="row"><button class="btn ghost small" type="button" id="run-now">Run check now</button><span id="run-now-out" class="small"></span></div>`

    if (a.key === 'viewing_scheduler') body = `
      <div class="field"><label>Google Calendar account</label>${accountSelect('google-calendar', 'calendarConnectionId', cfg.calendarConnectionId)}</div>
      <div class="field"><label for="calendarId">Book viewings in</label><select id="calendarId" name="calendarId"><option value="">Loading calendars…</option></select></div>
      <div class="form-grid">
        <div class="field"><label for="timezone">Time zone</label><select id="timezone" name="timezone">${TIMEZONES.map((z) => `<option ${z === (cfg.timezone || 'Asia/Kolkata') ? 'selected' : ''}>${z}</option>`).join('')}</select></div>
        <div class="field"><label for="durationMinutes">Usual length</label><select id="durationMinutes" name="durationMinutes">${[30, 45, 60, 90, 120].map((m) => `<option value="${m}" ${m === (cfg.durationMinutes || 60) ? 'selected' : ''}>${m} minutes</option>`).join('')}</select></div>
        <div class="field"><label for="dayStart">Viewings from</label><input id="dayStart" name="dayStart" type="time" value="${esc(cfg.dayStart || '09:00')}"></div>
        <div class="field"><label for="dayEnd">until</label><input id="dayEnd" name="dayEnd" type="time" value="${esc(cfg.dayEnd || '19:00')}"></div>
      </div>
      <div class="field"><label>Confirm to the lead by</label>
        <div class="row"><label class="radio"><input type="radio" name="confirmation" value="none" ${cfg.confirmation !== 'gmail' ? 'checked' : ''}> No message (shown as “not sent”)</label>
        <label class="radio"><input type="radio" name="confirmation" value="gmail" ${cfg.confirmation === 'gmail' ? 'checked' : ''}> Email (Gmail)</label></div></div>
      <div class="field" data-conf="gmail"><label>Gmail account</label>${accountSelect('gmail', 'gmailConnectionId', cfg.gmailConnectionId)}</div>
      <p class="small muted">Free times come from your calendar’s busy times. Each booking re-checks the slot first, and is marked Busy in your calendar.</p>`
    if (a.key === 'viewing_feedback') body = `
      <div class="field"><label>Send feedback requests from Gmail account</label>${accountSelect('gmail', 'gmailConnectionId', cfg.gmailConnectionId)}</div>
      <div class="field"><label for="expiryDays">Feedback link stays open for</label><div class="row"><input id="expiryDays" name="expiryDays" type="number" min="1" max="60" value="${esc(cfg.expiryDays ?? 14)}" style="width:6rem"> days</div></div>
      <p class="small muted">When a viewing ends, DealSaathi reminds you to say whether it took place. Only then is the request sent. The buyer’s page shows only that viewing’s listings; their answer updates their budget, rejected areas and future matches.</p>`
    if (a.key === 'rent_reminders') body = `
      <div class="field"><label>Send reminders from Gmail account</label>${accountSelect('gmail', 'gmailConnectionId', cfg.gmailConnectionId)}</div>
      <div class="form-grid">
        <div class="field"><label for="beforeDays">First reminder, days before due</label><input id="beforeDays" name="beforeDays" type="number" min="0" max="15" value="${esc(cfg.beforeDays ?? 3)}"><div class="hint">0 = none before the due date.</div></div>
        <div class="field"><label for="afterDays">Overdue reminders after (days)</label><input id="afterDays" name="afterDays" value="${esc((cfg.afterDays ?? [3, 7]).join(', '))}"><div class="hint">Up to five, e.g. 3, 7, 14.</div></div>
      </div>
      <label class="radio"><input type="checkbox" name="onDue" ${cfg.onDue !== false ? 'checked' : ''}> Also remind on the due date</label>
      <div class="field"><label for="razorpayConnectionId">Payment links (optional)</label>${(apps.bySlug.razorpay?.connections || []).filter((c) => c.status === 'active').length
        ? `<select id="razorpayConnectionId" name="razorpayConnectionId"><option value="">Don’t use Razorpay: I confirm payments myself</option>${apps.bySlug.razorpay.connections.filter((c) => c.status === 'active').map((c) => `<option value="${c.id}" ${String(c.id) === String(cfg.razorpayConnectionId) ? 'selected' : ''}>Razorpay: ${esc(c.label || 'account')}</option>`).join('')}</select>`
        : '<div class="notice info small">Without Razorpay you confirm payments yourself on the Rent page. <a href="#/integrations">Connect Razorpay</a> to add payment links and automatic checks.</div>'}</div>
      <p class="small muted">Reminders go out between 9 am and 9 pm (India time), one per stage, and stop when Razorpay reports the link paid or you record a payment.</p>
      <div class="notice ${a.scheduler ? 'ok' : 'warn'} small">${a.scheduler ? 'The scheduler checks every 15 minutes.' : 'The 15-minute scheduler runs only on the hosted DealSaathi. Here, use Run check now.'}</div>
      <div class="row"><button class="btn ghost small" type="button" id="rent-run-now">Run check now</button><span id="rent-run-out" class="small"></span></div>`
    panel.innerHTML = `<h2 id="auto-title">${esc(a.name)}</h2><p class="small muted">${esc(a.description)}</p>
      <form id="auto-form" class="stack" novalidate>${body}
        <label class="switch"><input type="checkbox" name="enabled" ${a.enabled ? 'checked' : ''}><span>Automation on</span></label>
        <div id="auto-problems"></div>
        <div class="row end"><button class="btn ghost" type="button" id="auto-cancel">Close</button><button class="btn primary" type="submit">Save</button></div>
      </form>
      <h3 style="margin-top:1rem">Recent runs</h3>
      ${runs.length ? `<ul class="timeline">${runs.map((r) => `<li class="small">${runLine(r)}${r.retryable ? ` <button class="btn ghost small" data-retry="${r.id}">Retry</button>` : ''}</li>`).join('')}</ul>` : '<p class="small muted">No runs yet.</p>'}`
    const form = document.getElementById('auto-form')
    document.getElementById('auto-cancel').addEventListener('click', () => dialog.close())

    const showChannel = () => {
      const ch = form.querySelector('input[name="ch"]:checked')?.value
      form.querySelectorAll('[data-ch]').forEach((el) => { el.hidden = el.dataset.ch !== ch })
      if (ch === 'slack') loadChannels()
    }
    const loadChannels = async () => {
      const sel = form.elements.slackChannelId
      const conn = form.elements.slackConnectionId?.value
      if (!sel) return
      if (!conn) { sel.innerHTML = '<option value="">Connect Slack first</option>'; return }
      try {
        const { options } = await api(`/api/automations/slack-channels?connectionId=${encodeURIComponent(conn)}`)
        sel.innerHTML = '<option value="">Choose a channel</option>' + options.map((o) => `<option value="${esc(o.value)}" ${o.value === cfg.slackChannelId ? 'selected' : ''}>${esc(o.label)}</option>`).join('')
      } catch (error) {
        sel.innerHTML = `<option value="">${esc(error.message)}</option>`
      }
    }
    const loadCalendars = async () => {
      const sel = form.elements.calendarId
      const conn = form.elements.calendarConnectionId?.value
      if (!sel) return
      if (!conn) { sel.innerHTML = '<option value="">Connect Google Calendar first</option>'; return }
      try {
        const { options } = await api(`/api/viewings/calendars?connectionId=${encodeURIComponent(conn)}`)
        sel.innerHTML = '<option value="">Choose a calendar</option>' + options.map((o) => `<option value="${esc(o.value)}" ${o.value === cfg.calendarId ? 'selected' : ''}>${esc(o.label)}</option>`).join('')
      } catch (error) {
        sel.innerHTML = `<option value="">${esc(error.message)}</option>`
      }
    }
    if (a.key === 'viewing_scheduler') {
      loadCalendars()
      form.elements.calendarConnectionId?.addEventListener('change', loadCalendars)
      const showConf = () => { const g = form.querySelector('input[name="confirmation"]:checked')?.value === 'gmail'; form.querySelectorAll('[data-conf]').forEach((el) => { el.hidden = !g }) }
      form.querySelectorAll('input[name="confirmation"]').forEach((r) => r.addEventListener('change', showConf))
      showConf()
    }
    document.getElementById('rent-run-now')?.addEventListener('click', async (e) => {
      const out = document.getElementById('rent-run-out')
      e.target.disabled = true
      try {
        await api(`/api/automations/${a.key}`, { method: 'PUT', body: { enabled: a.enabled, config: collect() } })
        const { result } = await api('/api/automations/rent_reminders/run', { method: 'POST', body: {} })
        out.textContent = `Checked: ${result.sent} reminder(s) sent, ${result.verified} payment(s) verified${result.failed ? `, ${result.failed} failed (see runs)` : ''}.`
        draw()
      } catch (error) {
        out.textContent = error.details?.problems ? error.details.problems.join(' ') : error.message
      } finally {
        e.target.disabled = false
      }
    })
    form.querySelectorAll('input[name="ch"]').forEach((r) => r.addEventListener('change', showChannel))
    form.elements.slackConnectionId?.addEventListener('change', loadChannels)
    if (form.querySelector('input[name="ch"]')) showChannel()

    const collect = () => {
      const ch = form.querySelector('input[name="ch"]:checked')?.value
      const config = {}
      if (a.key === 'property_recommendations') config.connectionId = form.elements.gmailConnectionId?.value || null
      if (a.key === 'followup_reminders') config.inactiveDays = Number(form.elements.inactiveDays.value)
      if (a.key === 'viewing_scheduler') {
        const cal = form.elements.calendarId
        Object.assign(config, {
          calendarConnectionId: form.elements.calendarConnectionId?.value || null, calendarId: cal?.value || null, calendarLabel: cal?.selectedOptions[0]?.textContent || '',
          timezone: form.elements.timezone.value, dayStart: form.elements.dayStart.value, dayEnd: form.elements.dayEnd.value, durationMinutes: Number(form.elements.durationMinutes.value),
          confirmation: form.querySelector('input[name="confirmation"]:checked')?.value || 'none', gmailConnectionId: form.elements.gmailConnectionId?.value || null
        })
      }
      if (a.key === 'viewing_feedback') Object.assign(config, { gmailConnectionId: form.elements.gmailConnectionId?.value || null, expiryDays: Number(form.elements.expiryDays.value) })
      if (a.key === 'rent_reminders') {
        Object.assign(config, {
          gmailConnectionId: form.elements.gmailConnectionId?.value || null, beforeDays: Number(form.elements.beforeDays.value), afterDays: form.elements.afterDays.value,
          onDue: form.elements.onDue.checked, razorpayConnectionId: form.elements.razorpayConnectionId?.value || null
        })
      }
      if (ch) {
        config[['followup_reminders', 'buyer_matching'].includes(a.key) ? 'notify' : 'channel'] = ch
        if (ch === 'gmail') Object.assign(config, { connectionId: form.elements.gmailConnectionId?.value || null, emailTo: form.elements.emailTo.value })
        if (ch === 'slack') {
          const sel = form.elements.slackChannelId
          Object.assign(config, { connectionId: form.elements.slackConnectionId?.value || null, slackChannelId: sel.value, slackChannelLabel: sel.selectedOptions[0]?.textContent || '' })
        }
      }
      return config
    }
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      const box = document.getElementById('auto-problems')
      box.innerHTML = ''
      try {
        await api(`/api/automations/${a.key}`, { method: 'PUT', body: { enabled: form.elements.enabled.checked, config: collect() } })
        toast(`${a.name} saved.`)
        dialog.close()
        draw()
      } catch (error) {
        box.innerHTML = `<div class="notice err">${esc(error.message)}${error.details?.problems ? `<ul>${error.details.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}</div>`
      }
    })
    document.getElementById('run-now')?.addEventListener('click', async (e) => {
      const out = document.getElementById('run-now-out')
      e.target.disabled = true
      try {
        await api(`/api/automations/${a.key}`, { method: 'PUT', body: { enabled: a.enabled, config: collect() } })
        const { result } = await api('/api/automations/followup_reminders/run', { method: 'POST', body: {} })
        out.textContent = `Checked: ${result.created} new reminder(s)${result.notified ? ', notification sent' : ''}${result.failed ? ', notification failed (see runs)' : ''}.`
        draw()
      } catch (error) {
        out.textContent = error.details?.problems ? error.details.problems.join(' ') : error.message
      } finally {
        e.target.disabled = false
      }
    })
    panel.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true
      try {
        const { run } = await api(`/api/automations/runs/${b.dataset.retry}/retry`, { method: 'POST', body: {} })
        toast(`Retry: ${RUN_STATUS[run.status]}${run.error ? `: ${run.error}` : ''}.`)
        dialog.close()
        draw()
      } catch (error) { toast(error.message); b.disabled = false }
    }))
  }
  draw()
}

// ---------- properties and matching ----------
const P_LABELS = {
  listing_type: { sale: 'For sale', rent: 'For rent' },
  status: { available: 'Available', under_offer: 'Under offer', sold: 'Sold', rented: 'Rented', off_market: 'Off market' }
}
const P_FIELDS = [
  { key: 'title', label: 'Title', type: 'text', required: true, wide: true },
  { key: 'listing_type', label: 'Listing', type: 'select', options: P_LABELS.listing_type, required: true },
  { key: 'property_type', label: 'Property type', type: 'select', options: LABELS.property_type, required: true },
  { key: 'price', label: 'Price (₹)', type: 'money', required: true },
  { key: 'bedrooms', label: 'Bedrooms', type: 'number', min: 0, max: 20 },
  { key: 'city', label: 'City', type: 'text', required: true },
  { key: 'locality', label: 'Locality', type: 'text' },
  { key: 'address', label: 'Address', type: 'text', wide: true },
  { key: 'area_sqft', label: 'Area (sq ft)', type: 'number', min: 0, max: 10000000 },
  { key: 'status', label: 'Status', type: 'select', options: P_LABELS.status, noEmpty: true },
  { key: 'amenities', label: 'Amenities', type: 'text', hint: 'Comma separated, e.g. Lift, Parking', wide: true },
  { key: 'notes', label: 'Notes', type: 'textarea', wide: true }
]
const priceText = (p) => `${formatINR(p.price)}${p.listing_type === 'rent' ? '/month' : ''}`
const sampleBadge = (p) => (p.is_sample ? ' <span class="badge draft" title="Not real inventory">Sample</span>' : '')

const STATE_BADGE = { draft: '<span class="badge draft">Draft</span>', published: '<span class="pill pill-on">Published</span>', unpublished: '<span class="pill pill-off">Unpublished</span>', archived: '<span class="pill pill-off">Archived</span>' }

async function renderProperties(params, { scope = params.get('scope') || 'mine' } = {}) {
  const role = session.user.role
  const base = role === 'seller' ? '#/my-listings' : role === 'buyer' ? '#/browse' : '#/properties'
  const heading = role === 'buyer' ? ['Browse listings', 'Published, available properties. Your best matches are on Recommendations.']
    : role === 'seller' ? ['My listings', 'Drafts are private. Publishing matches a listing against buyers’ saved requirements; you see how many match, never who.']
      : ['Properties', scope === 'market' ? 'Every published listing on DealSaathi, including sellers’ listings.' : 'Listings you own or are the agent for. Publishing one matches it against every saved buyer requirement in the background.']
  main.innerHTML = `
    <div class="page-head"><div><h1>${heading[0]}</h1><p>${heading[1]}</p></div>
      <div class="row">${role === 'agent' ? `<a class="btn ${scope === 'mine' ? 'primary' : 'ghost'} small" href="#/properties?scope=mine">My listings</a><a class="btn ${scope === 'market' ? 'primary' : 'ghost'} small" href="#/properties?scope=market">All published</a><button class="btn ghost" id="load-samples">Load sample listings</button>` : ''}
        ${role !== 'buyer' ? `<a class="btn primary" href="${role === 'seller' ? '#/my-listings/new' : '#/properties/new'}">New listing</a>` : ''}</div></div>
    <form class="filters" id="p-filters" role="search">
      <div class="field"><label for="pq">Search</label><input id="pq" name="q" type="search" value="${esc(params.get('q') || '')}" placeholder="Title, locality or city"></div>
      <div class="field"><label for="pl">Listing</label><select id="pl" name="listing_type"><option value="">All</option>${Object.entries(P_LABELS.listing_type).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
      <div class="field"><label for="ps">Status</label><select id="ps" name="status"><option value="">All</option>${Object.entries(P_LABELS.status).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
      <div class="field"><label for="pc">City</label><input id="pc" name="city" placeholder="e.g. Pune"></div>
    </form>
    <div class="card" style="padding:0"><div class="table-wrap" id="p-results"><p class="empty">Loading…</p></div></div>`
  const form = document.getElementById('p-filters')
  const load = async () => {
    const qs = new URLSearchParams(Object.entries(Object.fromEntries(new FormData(form))).filter(([, v]) => v))
    const box = document.getElementById('p-results')
    try {
      qs.set('scope', role === 'buyer' ? 'market' : role === 'seller' ? 'mine' : scope)
      const { properties } = await api(`/api/properties?${qs}`)
      const showState = qs.get('scope') === 'mine'
      box.innerHTML = properties.length ? `<table><thead><tr><th>Listing</th><th>Type</th><th>Where</th><th>Price</th><th>Status</th>${showState ? '<th>Listing state</th>' : ''}${role !== 'buyer' ? '<th>Matched buyers</th>' : ''}</tr></thead><tbody>
        ${properties.map((p) => `<tr data-id="${p.id}" tabindex="0"><td><div class="cell-name">${esc(p.title)}${sampleBadge(p)}</div><div class="code">${esc(p.code)}</div></td>
          <td>${esc(P_LABELS.listing_type[p.listing_type])} · ${esc(label('property_type', p.property_type))}${p.bedrooms != null ? ` · ${p.bedrooms} BHK` : ''}</td>
          <td>${esc([p.locality, p.city].filter(Boolean).join(', '))}</td><td>${esc(priceText(p))}</td><td>${esc(P_LABELS.status[p.status])}</td>${showState ? `<td>${STATE_BADGE[p.listing_state]}</td>` : ''}${role !== 'buyer' ? `<td>${p.match_count}</td>` : ''}</tr>`).join('')}</tbody></table>`
        : `<p class="empty">${qs.has('q') || qs.has('city') || qs.has('status') || qs.has('listing_type') ? 'No listings match these filters.' : role === 'buyer' ? 'No listings are published yet.' : 'No listings yet. Add your first one.'}</p>`
      box.querySelectorAll('tr[data-id]').forEach((tr) => {
        const go = () => { location.hash = `${base}/${tr.dataset.id}` }
        tr.addEventListener('click', go)
        tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go() })
      })
    } catch (error) {
      box.innerHTML = `<div class="notice err" style="margin:1rem">${esc(error.message)}</div>`
    }
  }
  let timer
  form.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250) })
  form.addEventListener('submit', (e) => { e.preventDefault(); load() })
  document.getElementById('load-samples')?.addEventListener('click', async () => {
    try {
      const { properties } = await api('/api/properties/samples', { method: 'POST', body: {} })
      toast(`Loaded ${properties.length} sample listings (labelled Sample, not real inventory).`)
      load()
    } catch (error) { toast(error.message) }
  })
  load()
}

async function renderPropertyDetail(id) {
  const role = session.user.role
  const base = role === 'seller' ? '#/my-listings' : role === 'buyer' ? '#/browse' : '#/properties'
  let data
  try {
    data = await api(`/api/properties/${encodeURIComponent(id)}`)
  } catch (error) {
    main.innerHTML = `<div class="notice err">${esc(error.message)}</div><a href="${base}">Back to listings</a>`
    return
  }
  const { property: p, matches = [], otherBuyers = 0 } = data
  const rows = [['Listing ID', `<span class="code">${esc(p.code)}</span>`], ['Listing', esc(P_LABELS.listing_type[p.listing_type])], ['Type', esc(label('property_type', p.property_type))],
    ['Bedrooms', dash(p.bedrooms)], ['Price', esc(priceText(p))], ['Where', esc([p.locality, p.city].filter(Boolean).join(', '))], ...(p.address != null || p.mine ? [['Address', dash(p.address)]] : []),
    ['Area', p.area_sqft ? `${esc(p.area_sqft)} sq ft` : dash(null)], ['Amenities', p.amenities.length ? esc(p.amenities.join(', ')) : dash(null)],
    ['Status', esc(P_LABELS.status[p.status])], ...(p.mine ? [['Listing state', STATE_BADGE[p.listing_state]], ['Notes', dash(p.notes)]] : []), ['Updated', esc(fmtDateTime(p.updated_at))]]
  const actions = p.mine ? [
    p.listing_state !== 'archived' ? `<a class="btn ghost" href="${base}/${p.id}/edit">Edit</a>` : '',
    ['draft', 'unpublished'].includes(p.listing_state) ? '<button class="btn primary" data-state="publish">Publish</button>' : '',
    p.listing_state === 'published' ? '<button class="btn ghost" data-state="unpublish">Unpublish</button>' : '',
    p.listing_state !== 'archived' && p.published_at && !p.is_sample ? '<button class="btn ghost" data-state="archive">Archive</button>' : '',
    !p.published_at || p.is_sample ? '<button class="btn danger" id="p-delete">Delete</button>' : ''
  ].join('') : role === 'buyer' ? '<button class="btn primary" id="p-view">Request a viewing</button>' : ''
  const matchSection = role === 'buyer' ? '' : role === 'seller' ? `<section class="card"><h2>Interest</h2>
      <p>${p.listing_state === 'published' ? `<strong>${otherBuyers}</strong> saved buyer requirement${otherBuyers === 1 ? ' matches' : 's match'} this listing.` : 'Publish the listing to match it against buyers’ requirements.'}</p>
      <p class="small muted">Buyers’ identities stay private; your agent contacts interested buyers.</p></section>`
    : `<section class="card"><h2>Matched buyers</h2>
        <p class="small muted">Recalculated from the event queue whenever this listing or a buyer’s requirements change. You see your own buyers by name${otherBuyers ? `; ${otherBuyers} other agents’ buyer${otherBuyers === 1 ? '' : 's'} also match` : ''}.</p>
        ${matches.length ? `<ul class="timeline">${matches.map((m) => `<li${m.status === 'dismissed' ? ' class="muted"' : ''}><a href="#/leads/${m.leadId}"><strong>${esc(m.name)}</strong></a> ${typeBadge(m.customerType)} <span class="badge">${m.score}/100</span>${m.status === 'dismissed' ? ' <span class="badge">Dismissed</span>' : ''}
          <ul class="small">${m.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}${m.gaps.map((g) => `<li class="muted">Unknown: ${esc(g)}</li>`).join('')}</ul>
          ${m.status === 'suggested' ? `<button class="btn ghost small" data-dismiss="${m.leadId}">Not a fit</button>` : ''}</li>`).join('')}</ul>`
          : `<p class="muted">None of your ${p.listing_type === 'rent' ? 'tenants' : 'buyers'} fit this listing${p.listing_state !== 'published' ? ' (it is not published)' : p.status !== 'available' ? ' (it is not marked available)' : ''}.</p>`}
        <div class="notice info small">Sending listings on WhatsApp needs a WhatsApp Business account with an approved template; it is not available yet.</div></section>`
  main.innerHTML = `
    <div class="page-head"><div><a href="${base}" class="small">← Listings</a><h1>${esc(p.title)}${sampleBadge(p)}</h1>
      ${p.is_sample ? '<p class="small muted">A sample listing for trying DealSaathi. It is not real inventory.</p>' : ''}</div>
      <div class="row">${actions}</div></div>
    <div class="grid two-col">
      <section class="card"><h2>Details</h2><dl class="details">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></section>
      ${matchSection}
    </div><div id="p-extra"></div>`
  main.querySelectorAll('[data-dismiss]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/api/properties/${p.id}/matches/${b.dataset.dismiss}/dismiss`, { method: 'POST', body: {} }); renderPropertyDetail(p.id) } catch (error) { toast(error.message) }
  }))
  main.querySelectorAll('[data-state]').forEach((b) => b.addEventListener('click', async () => {
    const action = b.dataset.state
    if (action === 'archive' && !(await confirmDialog(`Archive ${p.title}?`, 'It leaves the market for good, its matches are withdrawn, and it can no longer be edited. Its history is kept.', 'Archive'))) return
    try {
      await api(`/api/properties/${p.id}/${action}`, { method: 'POST', body: {} })
      toast(action === 'publish' ? 'Published. Matching runs in the background.' : action === 'unpublish' ? 'Unpublished. Its matches are withdrawn.' : 'Archived.')
      renderPropertyDetail(p.id)
    } catch (error) { toast(error.message) }
  }))
  document.getElementById('p-delete')?.addEventListener('click', async () => {
    if (!(await confirmDialog(`Delete ${p.title}?`, 'This removes the draft. It cannot be undone.', 'Delete permanently'))) return
    try { await api(`/api/properties/${p.id}`, { method: 'DELETE' }); toast('Listing deleted.'); location.hash = base } catch (error) { toast(error.message) }
  })
  document.getElementById('p-view')?.addEventListener('click', () => viewingRequestPanel(p, document.getElementById('p-extra')))
}

const listBase = () => (session.user.role === 'seller' ? '#/my-listings' : '#/properties')
async function renderPropertyForm(id) {
  let p = { status: 'available', listing_type: 'sale' }
  if (id) {
    try { p = (await api(`/api/properties/${encodeURIComponent(id)}`)).property } catch (error) {
      main.innerHTML = `<div class="notice err">${esc(error.message)}</div>`
      return
    }
  }
  const values = { ...p, amenities: Array.isArray(p.amenities) ? p.amenities.join(', ') : p.amenities }
  main.innerHTML = `
    <div class="page-head"><div><a href="${id ? `${listBase()}/${id}` : listBase()}" class="small">← Back</a><h1>${id ? `Edit ${esc(p.title)}` : 'New listing'}</h1>
      <p>Fields marked * are required. Price is the total for a sale, or the monthly rent.</p></div></div>
    <form class="card" id="p-form" novalidate><div id="p-notice"></div>
      <div class="form-grid">${P_FIELDS.map((f) => fieldHtml(f, values[f.key])).join('')}
        ${id ? '' : `<div class="field wide"><label class="radio"><input type="checkbox" name="publish" ${session.user.role === 'agent' ? 'checked' : ''}> Publish now (otherwise it is saved as a private draft)</label></div>`}</div>
      <div class="row end" style="margin-top:1rem"><a class="btn ghost" href="${id ? `${listBase()}/${id}` : listBase()}">Cancel</a><button class="btn primary" type="submit" id="p-save">${id ? 'Save changes' : 'Save listing'}</button></div></form>`
  const form = document.getElementById('p-form')
  bindMoneyHints(form)
  let busy = false
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (busy) return
    busy = true
    const btn = document.getElementById('p-save')
    btn.disabled = true
    const property = {}
    for (const f of P_FIELDS) {
      const raw = form.elements[f.key].value.trim()
      property[f.key] = raw === '' ? null : (f.type === 'number' || f.type === 'money') ? Number(raw) : raw
    }
    try {
      const res = id ? await api(`/api/properties/${id}`, { method: 'PATCH', body: { property } }) : await api('/api/properties', { method: 'POST', body: { property, publish: form.elements.publish.checked } })
      toast(res.property.listing_state === 'published' ? 'Saved. Matching against buyers runs in the background.' : 'Saved as a draft. Publish it when it is ready.')
      location.hash = `${listBase()}/${res.property.id}`
    } catch (error) {
      showFieldErrors(form, error.details?.fields)
      document.getElementById('p-notice').innerHTML = `<div class="notice err">${esc(error.message)} Nothing was saved.</div>`
    } finally {
      busy = false
      btn.disabled = false
    }
  })
}

async function renderLeadMatches(lead, box, onRecommend) {
  try {
    const { matches } = await api(`/api/leads/${lead.id}/matches`)
    if (!matches.length) {
      box.innerHTML = `<p class="muted">${['buyer', 'tenant'].includes(lead.customer_type) ? 'No available listing fits this lead’s saved needs.' : 'Matching applies to buyers and tenants.'}</p>`
      return
    }
    const top = matches.slice(0, 5)
    box.innerHTML = `<ul class="timeline">${top.map((m) => `<li class="conn-row" style="align-items:flex-start">
        ${m.property.is_sample ? '<span class="pick-gap" title="Sample listings cannot be sent"></span>' : `<input type="checkbox" class="pick" value="${m.property.id}" aria-label="Recommend ${esc(m.property.title)}">`}
        <div style="flex:1;min-width:0"><a href="#/properties/${m.property.id}"><strong>${esc(m.property.title)}</strong></a>${sampleBadge(m.property)} <span class="badge">${m.score}/100</span>
        <div class="small">${esc(priceText(m.property))} · ${esc([m.property.locality, m.property.city].filter(Boolean).join(', '))}</div>
        <ul class="small">${m.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}${m.gaps.map((g) => `<li class="muted">Unknown: ${esc(g)}</li>`).join('')}</ul></div></li>`).join('')}</ul>
      <div class="row"><button class="btn ghost" id="recommend" disabled>Email these to the lead</button><span class="small muted" id="rec-msg">Tick listings to recommend. You review the email before it is sent.</span></div>`
    const btn = document.getElementById('recommend')
    box.querySelectorAll('.pick').forEach((c) => c.addEventListener('change', () => { btn.disabled = !box.querySelector('.pick:checked') }))
    btn.addEventListener('click', async () => {
      const propertyIds = [...box.querySelectorAll('.pick:checked')].map((c) => Number(c.value))
      try {
        const draft = await api(`/api/leads/${lead.id}/recommendations/draft`, { method: 'POST', body: { propertyIds } })
        onRecommend({ kind: 'recommendation', ...draft })
      } catch (error) {
        document.getElementById('rec-msg').textContent = error.details?.fields?.properties || error.message
      }
    })
  } catch (error) {
    box.innerHTML = `<div class="notice err">${esc(error.message)}</div>`
  }
}

// ---------- lead follow-up: Gmail · Send Email through viaSocket ----------
const FOLLOWUP_STATUS = {
  awaiting_confirmation: '<span class="badge draft">Not sent: awaiting confirmation</span>',
  sending: '<span class="badge draft">Sending…</span>',
  sent: '<span class="badge saved">Sent via Gmail</span>',
  failed: '<span class="badge danger-badge">Failed</span>',
  unknown: '<span class="badge draft">Outcome unknown</span>',
  cancelled: '<span class="badge">Cancelled</span>'
}

async function renderFollowupPanel(lead, box, preset = null) {
  let data
  try {
    data = await api(`/api/leads/${lead.id}/followups`)
  } catch (error) {
    box.innerHTML = `<div class="notice err">${esc(error.message)}</div>`
    return
  }
  const history = data.followups.length ? `<h3 style="margin-top:1rem">Sent and attempted</h3><ul class="timeline">${data.followups.map((f) => `<li>${FOLLOWUP_STATUS[f.status] || esc(f.status)} ${f.kind === 'recommendation' ? '<span class="badge ai">Recommendation</span> ' : ''}<strong>${esc(f.subject)}</strong>
      <div class="small muted">to ${esc(f.recipient)} · ${esc(fmtDateTime(f.sentAt || f.createdAt))}${f.userName ? ` · by ${esc(f.userName)}` : ''}</div>
      ${f.status === 'sent' && f.result ? `<div class="small">Gmail message id <span class="code">${esc(f.result.messageId)}</span>${f.result.labelIds?.length ? ` · labels ${esc(f.result.labelIds.join(', '))}` : ''}</div>` : ''}
      ${f.error ? `<div class="small" style="color:var(--danger)">${esc(f.error)}</div>` : ''}</li>`).join('')}</ul>` : ''

  if (!data.viasocket) { box.innerHTML = `<div class="notice warn">viaSocket is not configured on this server, so emails cannot be sent.</div>${history}`; return }
  if (!data.recipient) { box.innerHTML = `<div class="notice info">This lead has no email address. <a href="#/leads/${lead.id}/edit">Add one</a> to send a follow-up.</div>${history}`; return }
  if (!data.connections.length) { box.innerHTML = `<div class="notice info">Connect your Gmail first: <a href="#/integrations">Integrations → Connect Gmail</a>.</div>${history}`; return }
  if (preset && !data.recommendations.enabled) {
    box.innerHTML = `<div class="notice info">Turn on <strong>Property Recommendations</strong> on the <a href="#/automations">Automations</a> page to email listings to leads.</div>${history}`
    box.scrollIntoView({ block: 'start', behavior: 'smooth' })
    return
  }

  box.innerHTML = `
    <form id="fu-form" class="stack" novalidate>
      ${preset ? `<div class="notice info small">Property recommendation: ${preset.propertyIds.length} listing${preset.propertyIds.length === 1 ? '' : 's'}, written from the saved listing details. Edit it as you like.</div>` : ''}
      <div class="field"><label>To</label><input value="${esc(data.recipient)}" readonly aria-readonly="true"><div class="hint">From the lead’s saved email. Edit the lead to change it.</div></div>
      <div class="form-grid">
        <div class="field"><label for="fu-conn">Send with</label><select id="fu-conn" name="connectionId">${data.connections.map((c) => `<option value="${c.id}" ${preset && c.id === data.recommendations.connectionId ? 'selected' : ''}>${esc(c.label || c.appName)}</option>`).join('')}</select></div>
        <div class="field" data-field="from"><label for="fu-from">From address</label><select id="fu-from" name="from"><option value="">Account’s default address</option></select><div class="err"></div></div>
      </div>
      <div class="field" data-field="subject"><label for="fu-subject">Subject</label><input id="fu-subject" name="subject" maxlength="200"><div class="err"></div></div>
      <div class="field" data-field="body"><label for="fu-body">Message</label><textarea id="fu-body" name="body" rows="7" maxlength="10000"></textarea><div class="err"></div></div>
      <div id="fu-msg"></div>
      <div class="row end">${data.ai ? '<button class="btn ghost" type="button" id="fu-draft">Draft with AI</button>' : ''}<button class="btn primary" type="submit">Review email</button></div>
    </form>
    <div id="fu-review"></div>${history}`
  const form = document.getElementById('fu-form')
  const msg = document.getElementById('fu-msg')
  const fromSel = document.getElementById('fu-from')
  if (preset) {
    form.elements.subject.value = preset.subject
    form.elements.body.value = preset.body
    box.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  const loadFrom = async () => {
    fromSel.innerHTML = '<option value="">Account’s default address</option>'
    try {
      const { options } = await api(`/api/followups/from-options?connectionId=${encodeURIComponent(form.elements.connectionId.value)}`)
      fromSel.innerHTML += options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')
    } catch (error) {
      msg.innerHTML = `<div class="notice warn">${esc(error.message)}</div>`
    }
  }
  form.elements.connectionId.addEventListener('change', loadFrom)
  loadFrom()

  document.getElementById('fu-draft')?.addEventListener('click', async (e) => {
    e.target.disabled = true
    e.target.textContent = 'Drafting…'
    try {
      const d = await api(`/api/leads/${lead.id}/followups/draft`, { method: 'POST', body: {} })
      form.elements.subject.value = d.subject
      form.elements.body.value = d.body
      msg.innerHTML = '<div class="notice info">AI wrote this draft from the lead’s saved details. Read and edit it before sending.</div>'
    } catch (error) {
      msg.innerHTML = `<div class="notice err">${esc(error.message)}</div>`
    } finally {
      e.target.disabled = false
      e.target.textContent = 'Draft with AI'
    }
  })

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    msg.innerHTML = ''
    const body = { connectionId: Number(form.elements.connectionId.value), from: form.elements.from.value || null, subject: form.elements.subject.value, body: form.elements.body.value, ...(preset ? { kind: 'recommendation', propertyIds: preset.propertyIds } : {}) }
    let prep
    try {
      prep = await api(`/api/leads/${lead.id}/followups`, { method: 'POST', body })
    } catch (error) {
      showFieldErrors(form, error.details?.fields)
      msg.innerHTML = `<div class="notice err">${esc(error.message)}</div>`
      return
    }
    const f = prep.followup
    form.hidden = true
    const review = document.getElementById('fu-review')
    review.innerHTML = `<div class="review-box">
      <div class="review-state"><span class="badge draft">Not sent yet</span><strong>Check the email</strong></div>
      <dl class="details"><dt>To</dt><dd>${esc(f.recipient)}</dd><dt>From</dt><dd>${esc(f.from || prep.sendsAs || 'Account default')}${prep.inputPreview.fromName ? ` (as ${esc(prep.inputPreview.fromName)})` : ''}</dd>
        <dt>Subject</dt><dd>${esc(f.subject)}</dd><dt>Message</dt><dd style="white-space:pre-wrap">${esc(f.body)}</dd></dl>
      <div class="notice warn" style="margin-top:.75rem">Pressing <strong>Send now</strong> sends a real email from your Gmail, through viaSocket.</div>
      <div id="fu-result"></div>
      <div class="row end"><button class="btn ghost" id="fu-back">Back</button><button class="btn primary" id="fu-send">Send now</button></div></div>`
    document.getElementById('fu-back').addEventListener('click', async () => {
      await api(`/api/followups/${f.id}/cancel`, { method: 'POST', body: {} }).catch(() => {})
      review.innerHTML = ''
      form.hidden = false
    })
    document.getElementById('fu-send').addEventListener('click', async (ev) => {
      ev.target.disabled = true
      document.getElementById('fu-back').disabled = true
      ev.target.textContent = 'Sending…'
      const out = document.getElementById('fu-result')
      try {
        const res = await api(`/api/followups/${f.id}/send`, { method: 'POST', body: {} })
        const r = res.followup
        if (r.status === 'sent') toast(`Sent via Gmail. Message id ${r.result.messageId}.`)
        else toast(r.status === 'failed' ? 'The email was not sent.' : 'The outcome is unknown: check your Gmail Sent folder.')
        renderLeadDetail(lead.id)
      } catch (error) {
        out.innerHTML = `<div class="notice err">${esc(error.message)} The email was not sent.</div>`
        ev.target.disabled = false
        document.getElementById('fu-back').disabled = false
        ev.target.textContent = 'Send now'
      }
    })
  })
}

// ---------- viewings (Property Viewing Scheduler) ----------
const VIEW_STATUS = {
  draft: '<span class="pill pill-off">Draft</span>', booking: '<span class="pill pill-setup">Booking…</span>', booked: '<span class="pill pill-on">Booked</span>',
  failed: '<span class="pill pill-err">Not booked</span>', unknown: '<span class="pill pill-setup">Outcome unknown</span>', completed: '<span class="pill pill-on">Took place</span>',
  no_show: '<span class="pill pill-off">No-show</span>', cancelled: '<span class="pill pill-off">Cancelled</span>'
}
const CONF_STATUS = { not_sent: 'Not sent', not_configured: 'Not sent: no channel set', sent: 'Sent', failed: 'Failed', unknown: 'Outcome unknown' }
const todayLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)

async function renderViewings(params) {
  main.innerHTML = `
    <div class="page-head"><div><h1>Viewings</h1><p>Booked in your Google Calendar after you confirm a free time. You record whether each viewing took place.</p></div></div>
    <div id="v-setup"></div>
    <section class="card" id="v-new"><h2>Schedule a viewing</h2><p class="muted">Loading…</p></section>
    <section class="card" style="margin-top:1rem"><h2>Your viewings</h2><div id="v-list"><p class="muted">Loading…</p></div></section>`
  const auto = (await api('/api/automations')).automations.find((a) => a.key === 'viewing_scheduler')
  const box = document.getElementById('v-new')
  if (auto.status !== 'enabled') {
    box.innerHTML = `<h2>Schedule a viewing</h2><div class="notice warn">Switch on <strong>Property Viewing Scheduler</strong> on the <a href="#/automations">Automations</a> page first.${auto.problems.length ? `<ul>${auto.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}</div>`
  } else {
    const [{ leads }, { properties }] = await Promise.all([api('/api/leads?limit=200'), api('/api/properties?status=available')])
    const real = properties.filter((p) => !p.is_sample)
    const preLead = params.get('lead')
    box.innerHTML = `<h2>Schedule a viewing</h2>
      <form id="v-form" class="stack" novalidate>
        <div class="form-grid">
          <div class="field"><label for="v-lead">Lead</label><select id="v-lead" name="leadId"><option value="">Choose a lead</option>${leads.map((l) => `<option value="${l.id}" ${String(l.id) === preLead ? 'selected' : ''}>${esc(l.full_name)} (${esc(l.code)})</option>`).join('')}</select></div>
          <div class="field"><label for="v-date">Date</label><input id="v-date" name="date" type="date" min="${todayLocal()}" value="${todayLocal()}"></div>
          <div class="field"><label for="v-dur">Length</label><select id="v-dur" name="durationMinutes">${[30, 45, 60, 90, 120].map((m) => `<option value="${m}" ${m === auto.config.durationMinutes ? 'selected' : ''}>${m} minutes</option>`).join('')}</select></div>
        </div>
        <div class="field"><label>Properties to view</label>${real.length ? `<div class="pick-list">${real.map((p) => `<label class="radio"><input type="checkbox" name="prop" value="${p.id}"> ${esc(p.title)} <span class="muted small">${esc([p.locality, p.city].filter(Boolean).join(', '))}</span></label>`).join('')}</div>` : '<div class="notice info small">No available real listings. Add one on the Properties page (sample listings cannot be viewed).</div>'}</div>
        <div class="row"><button class="btn ghost" type="button" id="v-find">Find free times</button><span class="small muted">Times in ${esc(auto.config.timezone)}, ${esc(auto.config.dayStart)}–${esc(auto.config.dayEnd)}.</span></div>
        <div id="v-slots"></div>
        <div id="v-review"></div>
      </form>`
    const form = document.getElementById('v-form')
    let chosen = null
    document.getElementById('v-find').addEventListener('click', async () => {
      const out = document.getElementById('v-slots')
      document.getElementById('v-review').innerHTML = ''
      chosen = null
      out.innerHTML = '<p class="muted small">Checking your Google Calendar…</p>'
      try {
        const r = await api(`/api/viewings/slots?date=${encodeURIComponent(form.elements.date.value)}&durationMinutes=${form.elements.durationMinutes.value}`)
        out.innerHTML = r.slots.length
          ? `<p class="small muted">Free in your calendar (${r.busyCount} busy period${r.busyCount === 1 ? '' : 's'} that day; checked ${esc(fmtDateTime(r.checkedAt))}):</p><div class="slot-grid">${r.slots.map((sl) => `<button type="button" class="btn ghost small" data-slot="${sl.start}">${esc(sl.label)}</button>`).join('')}</div>`
          : '<div class="notice info small">No free time that day in your working hours. Try another date.</div>'
        out.querySelectorAll('[data-slot]').forEach((b) => b.addEventListener('click', () => {
          out.querySelectorAll('[data-slot]').forEach((x) => x.classList.toggle('primary', x === b))
          chosen = b.dataset.slot
          showReview()
        }))
      } catch (error) { out.innerHTML = `<div class="notice err">${esc(error.message)}</div>` }
    })
    const showReview = () => {
      const lead = leads.find((l) => String(l.id) === form.elements.leadId.value)
      document.getElementById('v-review').innerHTML = `<div class="review-box stack">
        <label class="radio"><input type="checkbox" name="inviteLead" ${lead?.email ? '' : 'disabled'}> Send the lead a Google Calendar invitation${lead?.email ? ` (${esc(lead.email)})` : ' (no email on record)'}</label>
        <div class="field"><label for="v-note">Note for the calendar (optional)</label><input id="v-note" name="note" maxlength="500"></div>
        <div id="v-msg"></div><div class="row end"><button class="btn primary" type="button" id="v-prepare">Review booking</button></div></div>`
      document.getElementById('v-prepare').addEventListener('click', prepare)
    }
    const prepare = async () => {
      const msg = document.getElementById('v-msg')
      try {
        const { viewing: v, confirmationWillBeSent } = await api('/api/viewings', { method: 'POST', body: {
          leadId: Number(form.elements.leadId.value), propertyIds: [...form.querySelectorAll('input[name="prop"]:checked')].map((c) => Number(c.value)),
          start: chosen, durationMinutes: Number(form.elements.durationMinutes.value), inviteLead: form.elements.inviteLead?.checked === true, note: form.elements.note?.value
        } })
        document.getElementById('v-review').innerHTML = `<div class="review-box">
          <div class="review-state"><span class="badge draft">Not booked yet</span><strong>Check the viewing</strong></div>
          <dl class="details"><dt>Lead</dt><dd>${esc(v.leadName)}</dd><dt>When</dt><dd>${esc(v.when)} · ${v.durationMinutes} min</dd>
            <dt>Properties</dt><dd>${v.properties.map((p) => esc(p.title)).join('<br>')}</dd><dt>Where</dt><dd>${esc(v.location)}</dd>
            <dt>Invitation</dt><dd>${v.inviteLead ? 'Google Calendar invitation to the lead' : 'None'}</dd>
            <dt>Confirmation</dt><dd>${confirmationWillBeSent ? 'Emailed to the lead from your Gmail after booking' : 'None: no channel set, or the lead has no email'}</dd></dl>
          <div id="v-book-msg"></div>
          <div class="row end"><button class="btn primary" id="v-book">Confirm booking</button></div></div>`
        document.getElementById('v-book').addEventListener('click', async (e) => {
          e.target.disabled = true
          e.target.textContent = 'Checking and booking…'
          try {
            const { viewing: b } = await api(`/api/viewings/${v.id}/book`, { method: 'POST', body: {} })
            toast(b.status === 'booked' ? `Booked in Google Calendar${b.confirmationStatus === 'sent' ? '; confirmation emailed' : ''}.` : `Not booked: ${b.error}`)
            renderViewings(new URLSearchParams())
          } catch (error) {
            document.getElementById('v-book-msg').innerHTML = `<div class="notice err">${esc(error.message)}</div>`
            e.target.disabled = false
            e.target.textContent = 'Confirm booking'
          }
        })
      } catch (error) {
        msg.innerHTML = `<div class="notice err">${esc(error.details?.fields ? Object.values(error.details.fields).join(' ') : error.message)}</div>`
      }
    }
  }
  loadViewingList()
}

async function loadViewingList() {
  const list = document.getElementById('v-list')
  if (!list) return
  try {
    const { viewings } = await api('/api/viewings')
    list.innerHTML = viewings.length ? `<ul class="timeline">${viewings.map((v) => `<li data-v="${v.id}">
      <div class="row" style="justify-content:space-between"><div><a href="#/leads/${v.leadId}"><strong>${esc(v.leadName)}</strong></a> ${v.status === 'draft' && v.requestedByBuyer ? '<span class="pill pill-setup">Requested by the buyer</span>' : VIEW_STATUS[v.status]}
        <div class="small">${esc(v.when)} · ${v.durationMinutes} min · ${v.properties.map((p) => esc(p.title)).join(', ')}</div>
        <div class="small muted">Confirmation: ${esc(CONF_STATUS[v.confirmationStatus])}${v.confirmationDetail ? ` (${esc(v.confirmationDetail)})` : ''}${safeUrl(v.eventLink) ? ` · <a href="${esc(v.eventLink)}" target="_blank" rel="noopener noreferrer">Open in Google Calendar</a>` : ''}${v.feedback ? ` · Feedback: ${esc(v.feedback.status.replace('_', ' '))}` : ''}</div>
        ${v.error ? `<div class="small" style="color:var(--danger)">${esc(v.error)}</div>` : ''}
        ${v.status === 'booked' && v.ended ? '<div class="notice warn small" style="margin-top:.35rem">This viewing has ended. Did it take place?</div>' : ''}</div>
      <div class="row">
        ${v.status === 'booked' && Date.parse(v.startAt) <= Date.now() ? '<button class="btn primary small" data-act="completed">It took place</button><button class="btn ghost small" data-act="no_show">No-show</button>' : ''}
        ${v.status === 'booked' && !v.ended ? '<button class="btn ghost small" data-act="move">Move</button>' : ''}
        ${v.status === 'booked' && v.confirmationStatus === 'failed' ? '<button class="btn ghost small" data-act="resend">Resend confirmation</button>' : ''}
        ${v.status === 'draft' && v.requestedByBuyer ? '<button class="btn primary small" data-act="confirm">Confirm booking</button><button class="btn ghost small" data-act="cancel">Decline</button>' : ''}
        ${['failed', 'unknown'].includes(v.status) ? '<button class="btn ghost small" data-act="retry">Try booking again</button>' : ''}
        ${['booked', 'failed', 'unknown'].includes(v.status) && !v.ended ? '<button class="btn ghost small" data-act="cancel">Cancel</button>' : ''}
      </div></div><div class="v-extra"></div></li>`).join('')}</ul>` : '<p class="muted">No viewings yet.</p>'
    list.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => viewingAction(viewings.find((v) => v.id === b.closest('[data-v]').dataset.v), b.dataset.act, b)))
  } catch (error) {
    list.innerHTML = `<div class="notice err">${esc(error.message)}</div>`
  }
}

async function viewingAction(v, act, btn) {
  const extra = btn.closest('[data-v]').querySelector('.v-extra')
  try {
    if (act === 'completed' || act === 'no_show') {
      const r = await api(`/api/viewings/${v.id}/outcome`, { method: 'POST', body: { outcome: act } })
      toast(act === 'completed' ? `Marked as taken place. Feedback: ${r.feedback?.detail || r.feedback?.status}` : 'Marked as a no-show.')
    } else if (act === 'cancel') {
      if (!(await confirmDialog('Cancel this viewing?', v.status === 'booked' ? 'DealSaathi removes the event from your Google Calendar and, if the lead had a confirmation, emails them.' : 'This viewing was not booked in your calendar; it is just closed.', 'Cancel viewing'))) return
      const r = await api(`/api/viewings/${v.id}/cancel`, { method: 'POST', body: {} })
      toast(`Cancelled${r.leadNotified ? `; lead notified: ${r.leadNotified}` : ''}.`)
    } else if (act === 'resend') {
      const r = await api(`/api/viewings/${v.id}/confirmation`, { method: 'POST', body: {} })
      toast(`Confirmation: ${CONF_STATUS[r.viewing.confirmationStatus]}.`)
    } else if (act === 'confirm') {
      btn.disabled = true
      const r = await api(`/api/viewings/${v.id}/book`, { method: 'POST', body: {} })
      toast(r.viewing.status === 'booked' ? 'Booked in your Google Calendar; the buyer is notified.' : `Not booked: ${r.viewing.error}`)
    } else if (act === 'retry') {
      if (v.status === 'unknown' && !(await confirmDialog('Is it missing from your calendar?', 'The last attempt got no answer, so it may already be in your Google Calendar. Book again only if it is not there.', 'Book again'))) return
      const r = await api(`/api/viewings/${v.id}/book`, { method: 'POST', body: { confirmNotInCalendar: v.status === 'unknown' } })
      toast(r.viewing.status === 'booked' ? 'Booked in Google Calendar.' : `Not booked: ${r.viewing.error}`)
    } else if (act === 'move') {
      extra.innerHTML = `<div class="row" style="margin-top:.5rem"><input type="date" min="${todayLocal()}" value="${esc(v.localDate)}" style="width:auto"><button class="btn ghost small" data-find>Find free times</button></div><div data-slots></div>`
      extra.querySelector('[data-find]').addEventListener('click', async () => {
        const date = extra.querySelector('input[type=date]').value
        const out = extra.querySelector('[data-slots]')
        try {
          const r = await api(`/api/viewings/slots?date=${date}&durationMinutes=${v.durationMinutes}&except=${v.id}`)
          out.innerHTML = r.slots.length ? `<div class="slot-grid">${r.slots.map((sl) => `<button class="btn ghost small" data-slot="${sl.start}">${esc(sl.label)}</button>`).join('')}</div>` : '<p class="small muted">No free time that day.</p>'
          out.querySelectorAll('[data-slot]').forEach((sb) => sb.addEventListener('click', async () => {
            try {
              const m = await api(`/api/viewings/${v.id}/reschedule`, { method: 'POST', body: { start: sb.dataset.slot } })
              toast(`Moved to ${m.viewing.when}${m.leadNotified ? `; lead notified: ${m.leadNotified}` : ''}.`)
              loadViewingList()
            } catch (error) { out.innerHTML = `<div class="notice err small">${esc(error.message)}</div>` }
          }))
        } catch (error) { out.innerHTML = `<div class="notice err small">${esc(error.message)}</div>` }
      })
      return
    }
    loadViewingList()
  } catch (error) {
    toast(error.message)
  }
}

// ---------- feedback (Post-Viewing Feedback) ----------
const FB_STATUS = { created: 'Not sent', sent: 'Sent, waiting for the answer', send_failed: 'Send failed', send_unknown: 'Send outcome unknown', submitted: 'Answered', expired: 'Expired' }
const VERDICT_LABEL = { liked: 'Liked it', too_expensive: 'Too expensive', wrong_location: 'Wrong location', wrong_size: 'Wrong size or layout', other_property: 'Interested in another property' }

async function renderFeedback() {
  main.innerHTML = `<div class="page-head"><div><h1>Feedback</h1><p>Requests sent after viewings you marked as taken place, and what buyers answered.</p></div></div>
    <section class="card"><div id="fb-list"><p class="muted">Loading…</p></div></section>`
  const box = document.getElementById('fb-list')
  try {
    const { requests } = await api('/api/feedback')
    box.innerHTML = requests.length ? `<ul class="timeline">${requests.map((r) => `<li><div class="row" style="justify-content:space-between"><div>
        <a href="#/leads/${r.leadId}"><strong>${esc(r.leadName)}</strong></a> <span class="pill ${r.status === 'submitted' ? 'pill-on' : r.status === 'send_failed' ? 'pill-err' : 'pill-setup'}">${esc(FB_STATUS[r.status])}</span>
        <div class="small muted">Viewing ${esc(r.viewedAt)} · ${r.properties.map((p) => esc(p.title)).join(', ')}${r.sendDetail ? ` · ${esc(r.sendDetail)}` : ''}</div></div>
        ${['send_failed', 'send_unknown'].includes(r.status) ? `<button class="btn ghost small" data-resend="${r.id}" data-unknown="${r.status === 'send_unknown'}">Send again</button>` : ''}</div>
        ${r.response ? `<ul class="small">${r.response.answers.map((a) => `<li>${esc(r.properties.find((p) => p.id === a.propertyId)?.title || 'Listing')}: <strong>${esc(VERDICT_LABEL[a.verdict])}</strong></li>`).join('')}</ul>
          ${r.response.comments ? `<p class="small">“${esc(r.response.comments)}”</p>` : ''}
          ${r.preferenceChanges.length ? `<div class="notice info small"><strong>Preferences updated:</strong><ul>${r.preferenceChanges.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>` : ''}` : ''}</li>`).join('')}</ul>`
      : '<p class="muted">No feedback requests yet. They are sent when you mark a viewing as having taken place (with Post-Viewing Feedback switched on).</p>'
    box.querySelectorAll('[data-resend]').forEach((b) => b.addEventListener('click', async () => {
      const unknown = b.dataset.unknown === 'true'
      if (unknown && !(await confirmDialog('Send it again?', 'The last email got no answer, so it may have arrived. Check your Gmail Sent folder first.', 'Send again'))) return
      try {
        const r = await api(`/api/feedback/${b.dataset.resend}/resend`, { method: 'POST', body: { confirm: unknown } })
        toast(`Feedback request: ${FB_STATUS[r.status] || r.status}.`)
        renderFeedback()
      } catch (error) { toast(error.message) }
    }))
  } catch (error) {
    box.innerHTML = `<div class="notice err">${esc(error.message)}</div>`
  }
}

// ---------- tenancies and rent (Rent and Payment Reminders) ----------
const DUE_STATE = {
  upcoming: '<span class="pill pill-off">Upcoming</span>', due_today: '<span class="pill pill-setup">Due today</span>', overdue: '<span class="pill pill-err">Overdue</span>',
  partially_paid: '<span class="pill pill-setup">Part paid</span>', partially_paid_due_today: '<span class="pill pill-setup">Part paid · due today</span>', partially_paid_overdue: '<span class="pill pill-err">Part paid · overdue</span>',
  paid: '<span class="pill pill-on">Paid</span>', waived: '<span class="pill pill-off">Waived</span>', cancelled: '<span class="pill pill-off">Cancelled</span>'
}
const rupees = (n) => `₹${Number(n).toLocaleString('en-IN')}`
const T_FIELDS = [
  { key: 'tenant_name', label: 'Tenant name', type: 'text', required: true },
  { key: 'tenant_email', label: 'Tenant email', type: 'email', hint: 'Reminders are emailed here.' },
  { key: 'tenant_phone', label: 'Tenant phone', type: 'tel' },
  { key: 'landlord_email', label: 'Landlord email', type: 'email', hint: 'To invite the landlord to see this tenancy.' },
  { key: 'property_label', label: 'Property', type: 'text', required: true, hint: 'e.g. Flat 4B, Koramangala' },
  { key: 'rent_amount', label: 'Monthly rent (₹)', type: 'number', min: 1, max: 100000000, required: true },
  { key: 'due_day', label: 'Due on day of month', type: 'number', min: 1, max: 28, required: true },
  { key: 'lease_start', label: 'Lease start', type: 'date', required: true },
  { key: 'lease_end', label: 'Lease end', type: 'date' },
  { key: 'reference', label: 'Agreement reference', type: 'text' },
  { key: 'notes', label: 'Notes', type: 'textarea', wide: true }
]

async function renderRent() {
  main.innerHTML = `<div class="page-head"><div><h1>Tenancies and rent</h1><p>Rent is paid only when Razorpay confirms it or you record a payment you verified.</p></div>
      <div class="row"><a class="btn primary" href="#/rent/new">Add tenancy</a></div></div><div id="rent-body"><p class="muted">Loading…</p></div>`
  const box = document.getElementById('rent-body')
  try {
    const d = await api('/api/rent')
    const dueRow = (x) => `<li class="conn-row"><div style="flex:1;min-width:0"><a href="#/rent/${x.tenancyId}"><strong>${esc(x.tenantName)}</strong></a> ${DUE_STATE[x.state]}
      <div class="small muted">${esc(x.propertyLabel)} · ${esc(x.period)} · due ${esc(x.dueDate)} · ${rupees(x.outstanding)} owed${x.reminders.length ? ` · last reminder: ${esc(x.reminders.at(-1).status)}` : ''}</div></div></li>`
    box.innerHTML = `
      <div class="grid stats"><div class="card stat"><div class="label">Outstanding</div><div class="value">${rupees(d.totals.outstanding)}</div></div>
        <div class="card stat"><div class="label">Overdue</div><div class="value">${rupees(d.totals.overdue)}</div></div>
        <div class="card stat"><div class="label">Active tenancies</div><div class="value">${d.tenancies.filter((t) => t.status === 'active').length}</div></div></div>
      <div class="grid two-col">
        <section class="card"><h2>Overdue</h2>${d.overdue.length ? `<ul class="timeline">${d.overdue.map(dueRow).join('')}</ul>` : '<p class="muted">Nothing overdue.</p>'}</section>
        <section class="card"><h2>Due soon</h2>${d.dueSoon.length ? `<ul class="timeline">${d.dueSoon.map(dueRow).join('')}</ul>` : '<p class="muted">Nothing due soon.</p>'}</section>
      </div>
      <section class="card" style="margin-top:1rem"><h2>Tenancies</h2>${d.tenancies.length ? `<table><thead><tr><th>Tenant</th><th>Property</th><th>Rent</th><th>Due day</th><th>Lease ends</th><th>Status</th></tr></thead><tbody>
        ${d.tenancies.map((t) => `<tr data-t="${t.id}" tabindex="0"><td class="cell-name">${esc(t.tenantName)}${t.optOut ? ' <span class="badge">Opted out</span>' : ''}</td><td>${esc(t.propertyLabel)}</td><td>${rupees(t.rentAmount)}</td><td>${t.dueDay}</td><td>${esc(t.leaseEnd || '—')}</td><td>${esc(t.status)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No tenancies yet.</p>'}</section>`
    box.querySelectorAll('tr[data-t]').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/rent/${tr.dataset.t}` }))
  } catch (error) {
    box.innerHTML = `<div class="notice err">${esc(error.message)}</div>`
  }
}

async function renderTenancyForm(id) {
  let t = { due_day: 1, lease_start: todayLocal() }
  if (id) t = (await api(`/api/rent/tenancies/${encodeURIComponent(id)}`)).tenancy
  main.innerHTML = `<div class="page-head"><div><a href="${id ? `#/rent/${id}` : '#/rent'}" class="small">← Back</a><h1>${id ? 'Edit tenancy' : 'Add tenancy'}</h1>
      <p>Rent is tracked from the month the tenancy is added (or its start, if later): no backlog of past months is created.</p></div></div>
    <form class="card" id="t-form" novalidate><div id="t-notice"></div>
      <div class="form-grid">${T_FIELDS.map((f) => fieldHtml(f, t[f.key])).join('')}
        <div class="field"><label><input type="checkbox" name="reminders_opt_out" style="width:auto" ${t.reminders_opt_out ? 'checked' : ''}> Tenant opted out of reminders</label></div>
        ${id ? `<div class="field"><label for="t-status">Status</label><select id="t-status" name="status">${['active', 'paused', 'ended'].map((x) => `<option ${x === t.status ? 'selected' : ''}>${x}</option>`).join('')}</select></div>` : ''}
      </div>
      <div class="row end" style="margin-top:1rem"><button class="btn primary" type="submit">Save</button></div></form>`
  const form = document.getElementById('t-form')
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const tenancy = Object.fromEntries(T_FIELDS.map((f) => [f.key, form.elements[f.key].value.trim() === '' ? null : f.type === 'number' ? Number(form.elements[f.key].value) : form.elements[f.key].value.trim()]))
    tenancy.reminders_opt_out = form.elements.reminders_opt_out.checked
    if (id) tenancy.status = form.elements.status.value
    try {
      const r = id ? await api(`/api/rent/tenancies/${id}`, { method: 'PATCH', body: { tenancy } }) : await api('/api/rent/tenancies', { method: 'POST', body: { tenancy } })
      toast('Tenancy saved.')
      location.hash = `#/rent/${r.tenancy.id}`
    } catch (error) {
      showFieldErrors(form, error.details?.fields)
      document.getElementById('t-notice').innerHTML = `<div class="notice err">${esc(error.message)}</div>`
    }
  })
}

async function renderTenancy(id) {
  const d = await api(`/api/rent/tenancies/${encodeURIComponent(id)}`)
  const t = d.tenancy
  main.innerHTML = `<div class="page-head"><div><a href="#/rent" class="small">← Tenancies</a><h1>${esc(t.tenant_name)}</h1><p>${esc(t.property_label)} · ${rupees(t.rent_amount)} a month, due on day ${t.due_day} · ${esc(t.status)}${t.reminders_opt_out ? ' · opted out of reminders' : ''}</p></div>
      <a class="btn ghost" href="#/rent/${t.id}/edit">Edit</a></div>
    <section class="card"><h2>Rent</h2>${d.dues.length ? `<ul class="timeline">${d.dues.map((x) => `<li data-due="${x.id}">
      <div class="row" style="justify-content:space-between"><div><strong>${esc(x.period)}</strong> ${DUE_STATE[x.state]} <span class="small">due ${esc(x.dueDate)} · ${rupees(x.amount)}${x.amountPaid ? ` · ${rupees(x.amountPaid)} paid` : ''}${x.verificationSource ? ` (${x.verificationSource === 'razorpay' ? 'confirmed by Razorpay' : 'recorded by you'})` : ''}</span>
        ${x.paymentLink ? `<div class="small">Payment link: ${safeUrl(x.paymentLink.url) ? `<a href="${esc(x.paymentLink.url)}" target="_blank" rel="noopener noreferrer">${esc(x.paymentLink.url)}</a>` : esc(x.paymentLink.url)} (Razorpay status: ${esc(x.paymentLink.status)})</div>` : ''}
        ${x.paymentLinkError ? `<div class="small" style="color:var(--danger)">Payment link: ${esc(x.paymentLinkError)}</div>` : ''}
        ${x.reminders.length ? `<div class="small muted">Reminders: ${x.reminders.map((r) => `${esc(r.stage.replace('_', ' '))} ${esc(r.status)}`).join(', ')}</div>` : ''}</div>
      ${['open', 'partially_paid'].includes(x.status) ? `<div class="row"><button class="btn ghost small" data-pay>Record payment</button>${x.paymentLink ? '<button class="btn ghost small" data-check>Check Razorpay</button>' : ''}<button class="btn ghost small" data-waive>Waive</button></div>` : ''}</div>
      <div class="due-extra"></div></li>`).join('')}</ul>` : '<p class="muted">No rent obligations yet.</p>'}</section>
    <section class="card" style="margin-top:1rem"><h2>Who else can see this tenancy</h2>
      <p class="small muted">Only an account you invite (signed in with the email on the tenancy) or one whose email is verified can see it. Tenants see their rent; landlords also record rent they received.</p>
      <ul class="timeline">${[['tenant', t.tenant_email], ['landlord', t.landlord_email]].map(([party, email]) => {
        const p = d.parties[party]
        return `<li class="conn-row" data-party="${party}"><div style="flex:1;min-width:0"><strong>${party === 'tenant' ? 'Tenant' : 'Landlord'}</strong> ${p.linked ? '<span class="pill pill-on">Linked</span>' : p.pendingInvite ? '<span class="pill pill-setup">Invited</span>' : '<span class="pill pill-off">Not linked</span>'}
          <div class="small muted">${email ? esc(email) : `No ${party} email on the tenancy`}${p.pendingInvite ? ` · invitation valid until ${esc(fmtDate(p.pendingInvite.expires_at))}` : ''}</div><div class="invite-out"></div></div>
          ${email && !p.linked ? `<button class="btn ghost small" data-invite>${p.pendingInvite ? 'New invitation link' : 'Invite'}</button>` : ''}
          ${p.pendingInvite ? '<button class="btn ghost small" data-revoke>Withdraw invitation</button>' : ''}
          ${p.linked ? '<button class="btn ghost small" data-unlink>Remove access</button>' : ''}</li>`
      }).join('')}</ul></section>
    <section class="card" style="margin-top:1rem"><h2>History</h2><ul class="timeline">${d.events.map((e) => `<li class="small"><strong>${esc(e.detail)}</strong><div class="muted">${esc(fmtDateTime(e.created_at))}</div></li>`).join('')}</ul></section>`
  main.querySelectorAll('[data-party]').forEach((li) => {
    const party = li.dataset.party
    li.querySelector('[data-invite]')?.addEventListener('click', async () => {
      try {
        const r = await api(`/api/rent/tenancies/${t.id}/invites`, { method: 'POST', body: { party } })
        li.querySelector('.invite-out').innerHTML = `<div class="notice info small" style="margin-top:.5rem">Send this link to ${esc(r.email)} yourself (it is shown only now and works once, until ${esc(fmtDate(r.expiresAt))}):
          <div class="row" style="margin-top:.35rem"><input readonly value="${esc(r.link)}" aria-label="Invitation link"><button class="btn ghost small" type="button" data-copy>Copy</button></div></div>`
        li.querySelector('[data-copy]').addEventListener('click', () => { navigator.clipboard?.writeText(r.link).then(() => toast('Link copied.')).catch(() => toast('Select the link and copy it.')) })
      } catch (error) { toast(error.details?.fields ? Object.values(error.details.fields).join(' ') : error.message) }
    })
    li.querySelector('[data-revoke]')?.addEventListener('click', async () => { try { await api(`/api/rent/tenancies/${t.id}/invites/revoke`, { method: 'POST', body: { party } }); renderTenancy(t.id) } catch (error) { toast(error.message) } })
    li.querySelector('[data-unlink]')?.addEventListener('click', async () => {
      if (!(await confirmDialog(`Remove the ${party}’s access?`, 'They will no longer see this tenancy in DealSaathi.', 'Remove access'))) return
      try { await api(`/api/rent/tenancies/${t.id}/unlink`, { method: 'POST', body: { party } }); renderTenancy(t.id) } catch (error) { toast(error.message) }
    })
  })
  main.querySelectorAll('[data-due]').forEach((li) => {
    const dueId = li.dataset.due
    const extra = li.querySelector('.due-extra')
    li.querySelector('[data-pay]')?.addEventListener('click', () => {
      const x = d.dues.find((y) => String(y.id) === dueId)
      extra.innerHTML = `<form class="form-grid" style="margin-top:.5rem" novalidate>
        <div class="field" data-field="amount"><label>Amount received (₹)</label><input name="amount" type="number" min="1" value="${x.outstanding}"><div class="err"></div></div>
        <div class="field" data-field="paidOn"><label>Received on</label><input name="paidOn" type="date" max="${todayLocal()}" value="${todayLocal()}"><div class="err"></div></div>
        <div class="field wide" data-field="note"><label>How you verified it</label><input name="note" placeholder="e.g. HDFC statement, UTR 1234"><div class="err"></div></div>
        <div class="row end wide"><button class="btn primary small">Record verified payment</button></div></form>`
      const f = extra.querySelector('form')
      f.addEventListener('submit', async (e) => {
        e.preventDefault()
        try {
          await api(`/api/rent/dues/${dueId}/payments`, { method: 'POST', body: { amount: Number(f.elements.amount.value), paidOn: f.elements.paidOn.value, note: f.elements.note.value } })
          toast('Payment recorded.')
          renderTenancy(id)
        } catch (error) { showFieldErrors(f, error.details?.fields); if (!error.details?.fields) toast(error.message) }
      })
    })
    li.querySelector('[data-check]')?.addEventListener('click', async () => {
      try {
        const r = await api(`/api/rent/dues/${dueId}/check`, { method: 'POST', body: {} })
        toast(r.check.changed ? 'Razorpay confirmed a payment.' : `Razorpay status: ${r.check.status || 'no change'}.`)
        renderTenancy(id)
      } catch (error) { toast(error.message) }
    })
    li.querySelector('[data-waive]')?.addEventListener('click', async () => {
      const note = prompt('Why is this month waived?')
      if (!note) return
      try { await api(`/api/rent/dues/${dueId}/waive`, { method: 'POST', body: { note } }); renderTenancy(id) } catch (error) { toast(error.message) }
    })
  })
}

// ---------- every role: notifications and profile ----------
async function renderNotifications() {
  main.innerHTML = `<div class="page-head"><div><h1>Notifications</h1><p>What DealSaathi told you, newest first. Each fact reaches you once.</p></div>
    <button class="btn ghost" id="n-all">Mark all as read</button></div><section class="card"><div id="n-list"><p class="muted">Loading…</p></div></section>`
  const box = document.getElementById('n-list')
  const load = async () => {
    const { notifications } = await api('/api/notifications?limit=100')
    box.innerHTML = notifications.length ? `<ul class="timeline">${notifications.map((n) => `<li class="conn-row${n.status === 'unread' ? ' unread' : ''}"><div style="flex:1;min-width:0">
        ${n.link ? `<a href="${esc(n.link)}" data-read="${n.id}"><strong>${esc(n.title)}</strong></a>` : `<strong>${esc(n.title)}</strong>`} ${n.status === 'unread' ? '<span class="badge draft">New</span>' : ''}
        ${n.body ? `<div class="small">${esc(n.body)}</div>` : ''}<div class="small muted">${esc(fmtDateTime(n.createdAt))}</div></div>
        ${n.status === 'unread' ? `<button class="btn ghost small" data-mark="${n.id}">Mark read</button>` : ''}</li>`).join('')}</ul>` : '<p class="muted">Nothing yet.</p>'
    box.querySelectorAll('[data-mark]').forEach((b) => b.addEventListener('click', async () => { await api(`/api/notifications/${b.dataset.mark}/read`, { method: 'POST', body: {} }).catch(() => {}); load(); refreshUnread() }))
    box.querySelectorAll('[data-read]').forEach((a) => a.addEventListener('click', () => { api(`/api/notifications/${a.dataset.read}/read`, { method: 'POST', body: {} }).then(refreshUnread).catch(() => {}) }))
  }
  document.getElementById('n-all').addEventListener('click', async () => { await api('/api/notifications/read-all', { method: 'POST', body: {} }); load(); refreshUnread() })
  load().catch((error) => { box.innerHTML = `<div class="notice err">${esc(error.message)}</div>` })
}

async function renderProfile() {
  const { profile } = await api('/api/me')
  const agent = session.user.role === 'agent'
  main.innerHTML = `<div class="page-head"><div><h1>Profile</h1><p>${agent ? 'Your service areas decide which self-registered buyers and sellers are assigned to you.' : 'Your contact details and notification settings.'}</p></div></div>
    <form class="card" id="pr-form" novalidate><div id="pr-msg"></div><div class="form-grid">
      <div class="field" data-field="phone"><label for="pr-phone">Phone</label><input id="pr-phone" name="phone" type="tel" value="${esc(profile.phone || '')}"><div class="err"></div></div>
      ${agent ? `<div class="field" data-field="agency"><label for="pr-agency">Agency</label><input id="pr-agency" name="agency" value="${esc(profile.agency || '')}"><div class="err"></div></div>
      <div class="field wide" data-field="serviceAreas"><label for="pr-areas">Service areas</label><input id="pr-areas" name="serviceAreas" value="${esc(profile.serviceAreas.join(', '))}" placeholder="e.g. Pune, Baner, Wakad"><div class="hint">Cities or localities, comma separated. A buyer whose preferred location names one of them can be assigned to you.</div><div class="err"></div></div>
      <div class="field"><label class="radio"><input type="checkbox" name="acceptingLeads" ${profile.acceptingLeads ? 'checked' : ''}> Accepting new leads</label></div>`
      : `<div class="field"><label class="radio"><input type="checkbox" name="notifyInApp" ${profile.notifyInApp ? 'checked' : ''}> Notify me in DealSaathi when buyers match or viewings change</label></div>
      <div class="field wide"><strong>Your agent:</strong> ${profile.agent ? `${esc(profile.agent.name)} (${esc(profile.agent.email)})` : 'Not assigned yet: one is assigned when you list a property in an area an agent serves.'}</div>`}
    </div><div class="row end" style="margin-top:1rem"><button class="btn primary" type="submit">Save</button></div></form>`
  const form = document.getElementById('pr-form')
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const body = { phone: form.elements.phone.value }
    if (agent) Object.assign(body, { agency: form.elements.agency.value, serviceAreas: form.elements.serviceAreas.value, acceptingLeads: form.elements.acceptingLeads.checked })
    else body.notifyInApp = form.elements.notifyInApp.checked
    try { await api('/api/me/profile', { method: 'PATCH', body }); toast('Profile saved.') } catch (error) { showFieldErrors(form, error.details?.fields); document.getElementById('pr-msg').innerHTML = `<div class="notice err">${esc(error.message)}</div>` }
  })
}

// ---------- agents: the unassigned pool and the activity log ----------
async function renderPool() {
  main.innerHTML = `<div class="page-head"><div><h1>Lead pool</h1><p>Leads no agent is responsible for yet (for example, buyers in an area no agent serves). Nobody is notified about them; claim one to see its contact details.</p></div></div>
    <section class="card"><div id="pool"><p class="muted">Loading…</p></div></section>`
  const box = document.getElementById('pool')
  const { leads } = await api('/api/pool')
  box.innerHTML = leads.length ? `<ul class="timeline">${leads.map((l) => `<li class="conn-row"><div style="flex:1;min-width:0"><strong>${esc(l.firstName)}</strong> ${typeBadge(l.customerType)} ${l.selfRegistered ? '<span class="badge">Registered buyer</span>' : ''}
      <div class="small muted">${esc([l.preferredLocation, l.bedrooms != null ? `${l.bedrooms} BHK` : null, l.budgetMax ? `up to ${formatINR(l.budgetMax)}` : null, label('property_type', l.propertyType)].filter(Boolean).join(' · ') || 'No requirements yet')} · ${esc(fmtDate(l.createdAt))}</div></div>
      <button class="btn primary small" data-claim="${l.id}">Claim</button></li>`).join('')}</ul>` : '<p class="muted">The pool is empty: every lead has an agent.</p>'
  box.querySelectorAll('[data-claim]').forEach((b) => b.addEventListener('click', async () => {
    try { const { lead } = await api(`/api/pool/${b.dataset.claim}/claim`, { method: 'POST', body: {} }); toast(`${lead.full_name} is now yours.`); location.hash = `#/leads/${lead.id}` } catch (error) { toast(error.message); renderPool() }
  }))
}

const EVENT_LABEL = {
  'lead.created': 'Lead created', 'lead.assigned': 'Lead assigned', 'lead.requirements_changed': 'Requirements changed', 'property.published': 'Listing published', 'property.changed': 'Listing changed',
  'property.unpublished': 'Listing taken down', 'match.created': 'Match found', 'match.digest': 'Match notice', 'viewing.requested': 'Viewing requested', 'viewing.booked': 'Viewing booked',
  'viewing.rescheduled': 'Viewing moved', 'viewing.cancelled': 'Viewing cancelled', 'viewing.completed': 'Viewing took place', 'feedback.submitted': 'Feedback received',
  'rent.payment_recorded': 'Rent payment recorded', 'rent.reminder_sent': 'Rent reminder sent', 'tenancy.linked': 'Tenancy linked'
}
async function renderActivity(params) {
  const status = params.get('status') || ''
  main.innerHTML = `<div class="page-head"><div><h1>Activity log</h1><p>Every platform event about your leads and listings, and what processing it did. Failed events are retried automatically up to 5 times; then you can retry them here.</p></div>
    <div class="row">${[['', 'All'], ['failed', 'Failed'], ['pending', 'Waiting']].map(([k, v]) => `<a class="btn ${status === k ? 'primary' : 'ghost'} small" href="#/activity${k ? `?status=${k}` : ''}">${v}</a>`).join('')}</div></div>
    <section class="card" style="padding:0"><div class="table-wrap" id="ev"><p class="empty">Loading…</p></div></section>`
  const { events } = await api(`/api/events${status ? `?status=${status}` : ''}`)
  const box = document.getElementById('ev')
  box.innerHTML = events.length ? `<table><thead><tr><th>When</th><th>Event</th><th>Status</th><th>Result</th></tr></thead><tbody>${events.map((e) => `<tr>
      <td class="small">${esc(fmtDateTime(e.createdAt))}</td><td>${esc(EVENT_LABEL[e.type] || e.type)} <span class="code">#${e.id}</span></td>
      <td>${e.status === 'done' ? '<span class="pill pill-on">Done</span>' : e.status === 'failed' ? '<span class="pill pill-err">Failed</span>' : e.status === 'skipped' ? '<span class="pill pill-off">Recorded</span>' : '<span class="pill pill-setup">Waiting</span>'}${e.attempts > 1 ? ` <span class="small muted">${e.attempts} attempts</span>` : ''}</td>
      <td class="small">${e.lastError ? `<span style="color:var(--danger)">${esc(e.lastError)}</span>` : esc(summarizeResult(e.result))}${e.status === 'failed' ? ` <button class="btn ghost small" data-retry="${e.id}">Retry</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">No events yet.</p>'
  box.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/api/events/${b.dataset.retry}/retry`, { method: 'POST', body: {} }); toast('Queued again.'); setTimeout(() => renderActivity(params), 800) } catch (error) { toast(error.message) }
  }))
}
function summarizeResult(r) {
  if (!r) return ''
  if (r.matching) return `${r.matching.matched} match(es), ${r.matching.newMatches} new or changed, ${r.matching.withdrawn} withdrawn${r.matching.reason ? ` (${r.matching.reason})` : ''}${r.alert ? `; alert: ${r.alert}` : ''}`
  if (r.notified) return r.notified.length ? `Notified: ${r.notified.join(', ').replace(/_/g, ' ')}` : 'Nobody new to notify'
  if (r.alert) return `Alert: ${r.alert}${r.note ? ` — ${r.note}` : ''}`
  if (r.external) return `External notice: ${r.external.replace(/_/g, ' ')}`
  return r.skipped || r.note || ''
}

// ---------- buyers ----------
const REQ_FIELDS = [
  { key: 'customer_type', label: 'I want to', type: 'select', options: { buyer: 'Buy', tenant: 'Rent' }, noEmpty: true },
  { key: 'preferred_location', label: 'Preferred location', type: 'text', hint: 'Locality and city, e.g. Baner, Pune' },
  { key: 'property_type', label: 'Property type', type: 'select', options: LABELS.property_type },
  { key: 'bedrooms', label: 'Bedrooms (BHK)', type: 'number', min: 0, max: 20 },
  { key: 'budget_min', label: 'Min budget (₹)', type: 'money' },
  { key: 'budget_max', label: 'Max budget (₹)', type: 'money', hint: 'For renting, the monthly rent.' },
  { key: 'phone', label: 'Phone', type: 'tel' },
  { key: 'property_interest', label: 'Anything else', type: 'text', wide: true, hint: 'e.g. near the metro, east facing' }
]

async function renderBuyerHome() {
  const [{ profile }, recs, { viewings }, { notifications, unread }] = await Promise.all([api('/api/me'), api('/api/me/recommendations'), api('/api/me/viewings'), api('/api/notifications?limit=5')])
  const state = !profile.requirements ? '<div class="notice info">Start by saving <a href="#/requirements">what you are looking for</a>. We match it against every published listing, now and as new ones arrive.</div>'
    : !profile.matchingConsent ? '<div class="notice warn">Matching is off because you have not agreed to it. Turn it on in <a href="#/requirements">My requirements</a>.</div>' : ''
  main.innerHTML = `<div class="page-head"><div><h1>Hello, ${esc(session.user.name.split(' ')[0])}</h1><p>${profile.agent ? `Your agent is <strong>${esc(profile.agent.name)}</strong>.` : profile.requirements && profile.matchingConsent ? 'An agent will be assigned to you soon.' : ''}</p></div>
    <div class="row"><a class="btn primary" href="#/requirements">${profile.requirements ? 'Edit requirements' : 'Save my requirements'}</a></div></div>${state}
    <div class="grid stats"><div class="card stat"><div class="label">Matching properties</div><div class="value">${recs.recommendations.length}</div></div>
      <div class="card stat"><div class="label">Viewings</div><div class="value">${viewings.filter((v) => ['requested', 'booked'].includes(v.status)).length}</div></div>
      <div class="card stat"><div class="label">Unread notifications</div><div class="value">${unread}</div></div></div>
    <div class="grid two-col"><section class="card"><h2>Top matches</h2>${recs.recommendations.length ? `<ul class="timeline">${recs.recommendations.slice(0, 3).map((r) => `<li><a href="#/browse/${r.property.id}"><strong>${esc(r.property.title)}</strong></a> <span class="badge">${r.score}/100</span><div class="small">${esc(priceText(r.property))} · ${esc([r.property.locality, r.property.city].filter(Boolean).join(', '))}</div></li>`).join('')}</ul><a href="#/recommendations">See all</a>` : '<p class="muted">No matches yet. New listings are checked against your requirements as they are published.</p>'}</section>
      <section class="card"><h2>Latest notifications</h2>${notifications.length ? `<ul class="timeline">${notifications.map((n) => `<li>${n.link ? `<a href="${esc(n.link)}">${esc(n.title)}</a>` : esc(n.title)}<div class="small muted">${esc(fmtDateTime(n.createdAt))}</div></li>`).join('')}</ul>` : '<p class="muted">Nothing yet.</p>'}</section></div>`
}

async function renderRequirements() {
  const { profile } = await api('/api/me')
  const r = profile.requirements || { customer_type: 'buyer', phone: profile.phone }
  main.innerHTML = `<div class="page-head"><div><h1>My requirements</h1><p>Saved requirements are matched against every published listing straight away, and again whenever a listing is published or changed.</p></div></div>
    <form class="card" id="rq-form" novalidate><div id="rq-msg"></div>
      <div class="form-grid">${REQ_FIELDS.map((f) => fieldHtml(f, r[f.key])).join('')}</div>
      <fieldset class="stack" style="margin-top:1rem;border:0;padding:0"><legend><strong>Consent and notifications</strong></legend>
        <label class="radio"><input type="checkbox" name="matchingConsent" ${profile.matchingConsent ? 'checked' : ''}> Match me with listings and share my requirements and contact details with the one agent assigned to me</label>
        <label class="radio"><input type="checkbox" name="notifyInApp" ${profile.notifyInApp ? 'checked' : ''}> Tell me in DealSaathi when a new property matches</label>
        <label class="radio"><input type="checkbox" name="allowAgentEmail" ${profile.allowAgentEmail ? 'checked' : ''}> My agent may email me recommendations they have reviewed</label>
      </fieldset>
      <div class="row end" style="margin-top:1rem"><button class="btn primary" type="submit" id="rq-save">Save requirements</button></div></form>`
  const form = document.getElementById('rq-form')
  bindMoneyHints(form)
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const requirements = {}
    for (const f of REQ_FIELDS) {
      const raw = form.elements[f.key].value.trim()
      requirements[f.key] = raw === '' ? null : (f.type === 'number' || f.type === 'money') ? Number(raw) : raw
    }
    try {
      await api('/api/me/requirements', { method: 'PUT', body: { requirements, matchingConsent: form.elements.matchingConsent.checked, notifyInApp: form.elements.notifyInApp.checked, allowAgentEmail: form.elements.allowAgentEmail.checked } })
      toast(form.elements.matchingConsent.checked ? 'Saved. Matching runs in the background; see Recommendations.' : 'Saved. Matching stays off until you agree to it.')
      location.hash = '#/recommendations'
    } catch (error) { showFieldErrors(form, error.details?.fields); document.getElementById('rq-msg').innerHTML = `<div class="notice err">${esc(error.message)}</div>` }
  })
}

async function renderRecommendations() {
  main.innerHTML = '<div class="page-head"><div><h1>Recommendations</h1><p>Published properties that fit your saved requirements, best first, with the reasons. Updated automatically.</p></div><button class="btn ghost" id="rec-refresh">Refresh</button></div><div id="recs"><p class="muted">Loading…</p></div>'
  const box = document.getElementById('recs')
  const load = async () => {
    const { recommendations, state } = await api('/api/me/recommendations')
    box.innerHTML = state === 'no_requirements' ? '<div class="notice info">Save <a href="#/requirements">your requirements</a> first.</div>'
      : state === 'no_consent' ? '<div class="notice warn">Matching is off until you agree to it in <a href="#/requirements">My requirements</a>.</div>'
        : recommendations.length ? `<div class="grid cards">${recommendations.map((r) => `<article class="card"><h2><a href="#/browse/${r.property.id}">${esc(r.property.title)}</a></h2>
            <div><strong>${esc(priceText(r.property))}</strong> · ${esc([r.property.locality, r.property.city].filter(Boolean).join(', '))} <span class="badge">${r.score}/100</span></div>
            <ul class="small">${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}${(r.gaps || []).map((g) => `<li class="muted">Unknown: ${esc(g)}</li>`).join('')}</ul>
            <div class="small muted">Matched ${esc(fmtDate(r.matchedAt))}</div><a class="btn ghost small" href="#/browse/${r.property.id}">View and request a viewing</a></article>`).join('')}</div>`
          : '<p class="muted">Nothing matches yet. You will be notified when a new listing fits.</p>'
  }
  document.getElementById('rec-refresh').addEventListener('click', () => load().catch((e) => toast(e.message)))
  await load()
}

/** A buyer picks a free time in their agent's calendar; the agent confirms before anything is booked. */
function viewingRequestPanel(p, box) {
  box.innerHTML = `<section class="card" style="margin-top:1rem"><h2>Request a viewing</h2>
    <p class="small muted">Times come from your agent’s Google Calendar. Your agent confirms the request before it is booked.</p>
    <div class="row"><label for="vr-date">Date</label><input id="vr-date" type="date" min="${todayLocal()}" value="${todayLocal()}" style="width:auto"><button class="btn ghost" id="vr-find">Find free times</button></div>
    <div id="vr-slots"></div></section>`
  document.getElementById('vr-find').addEventListener('click', async () => {
    const out = document.getElementById('vr-slots')
    out.innerHTML = '<p class="muted small">Checking your agent’s calendar…</p>'
    try {
      const r = await api(`/api/me/viewing-slots?propertyId=${p.id}&date=${document.getElementById('vr-date').value}`)
      out.innerHTML = r.slots.length ? `<p class="small">Free with ${esc(r.agentName)} (${esc(r.timezone)}):</p><div class="slot-grid">${r.slots.map((sl) => `<button class="btn ghost small" data-slot="${sl.start}">${esc(sl.label)}</button>`).join('')}</div>` : '<p class="small muted">No free time that day. Try another date.</p>'
      out.querySelectorAll('[data-slot]').forEach((b) => b.addEventListener('click', async () => {
        b.disabled = true
        try { await api('/api/me/viewings', { method: 'POST', body: { propertyId: p.id, start: b.dataset.slot } }); toast('Requested. Your agent will confirm it.'); location.hash = '#/my-viewings' } catch (error) { out.insertAdjacentHTML('beforeend', `<div class="notice err small">${esc(error.message)}</div>`); b.disabled = false }
      }))
    } catch (error) { out.innerHTML = `<div class="notice ${error.status === 409 ? 'warn' : 'err'}">${esc(error.message)}</div>` }
  })
}

const BV_STATUS = { requested: '<span class="pill pill-setup">Waiting for your agent</span>', booked: '<span class="pill pill-on">Booked</span>', completed: '<span class="pill pill-on">Took place</span>', no_show: '<span class="pill pill-off">Missed</span>', cancelled: '<span class="pill pill-off">Cancelled</span>', failed: '<span class="pill pill-err">Not booked</span>', unknown: '<span class="pill pill-setup">Being checked</span>', booking: '<span class="pill pill-setup">Booking…</span>' }
async function renderMyViewings() {
  main.innerHTML = '<div class="page-head"><div><h1>My viewings</h1><p>Request one from any listing’s page. After a viewing, tell us what you thought: it improves your matches.</p></div></div><section class="card"><div id="mv"><p class="muted">Loading…</p></div></section>'
  const box = document.getElementById('mv')
  const { viewings } = await api('/api/me/viewings')
  box.innerHTML = viewings.length ? `<ul class="timeline">${viewings.map((v) => `<li data-v="${v.id}"><div class="row" style="justify-content:space-between"><div><strong>${esc(v.when)}</strong> ${BV_STATUS[v.status] || esc(v.status)}
      <div class="small">${v.properties.map((p) => esc(p.title)).join(', ')}${v.agentName ? ` · with ${esc(v.agentName)}` : ''}</div></div>
      <div class="row">${['requested', 'booked'].includes(v.status) ? '<button class="btn ghost small" data-cancel>Cancel</button>' : ''}${v.status === 'completed' && !v.feedbackGiven ? '<button class="btn primary small" data-fb>Give feedback</button>' : ''}${v.feedbackGiven ? '<span class="small muted">Feedback sent</span>' : ''}</div></div><div class="v-extra"></div></li>`).join('')}</ul>` : '<p class="muted">No viewings yet.</p>'
  box.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.closest('[data-v]').dataset.v
    if (!(await confirmDialog('Cancel this viewing?', 'Your agent is told, and a booked viewing is removed from their calendar.', 'Cancel viewing'))) return
    try { await api(`/api/me/viewings/${id}/cancel`, { method: 'POST', body: {} }); toast('Cancelled.'); renderMyViewings() } catch (error) { toast(error.message) }
  }))
  box.querySelectorAll('[data-fb]').forEach((b) => b.addEventListener('click', () => {
    const li = b.closest('[data-v]')
    const v = viewings.find((x) => x.id === li.dataset.v)
    const extra = li.querySelector('.v-extra')
    extra.innerHTML = `<form class="stack" style="margin-top:.5rem">${v.properties.map((p) => `<fieldset style="border:0;padding:0"><legend><strong>${esc(p.title)}</strong></legend>
      ${Object.entries(VERDICT_LABEL).map(([k, l]) => `<label class="radio"><input type="radio" name="p${p.id}" value="${k}"> ${esc(l)}</label>`).join('')}</fieldset>`).join('')}
      <label for="fb-c-${v.id}">Anything else? (optional)</label><textarea id="fb-c-${v.id}" name="comments" maxlength="1000"></textarea>
      <div class="row end"><button class="btn primary small">Send feedback</button></div></form>`
    extra.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault()
      const f = e.target
      const responses = v.properties.map((p) => ({ propertyId: p.id, verdict: f.querySelector(`input[name="p${p.id}"]:checked`)?.value })).filter((x) => x.verdict)
      if (!responses.length) { toast('Choose an answer for at least one property.'); return }
      try {
        const r = await api(`/api/me/viewings/${v.id}/feedback`, { method: 'POST', body: { responses, comments: f.elements.comments.value } })
        toast(r.changes?.length ? `Thanks. Updated: ${r.changes.join('; ')}` : 'Thanks for your feedback.')
        renderMyViewings()
      } catch (error) { toast(error.message) }
    })
  }))
}

// ---------- the buyer's AI assistant ----------
const AGENT_EXAMPLES = ['Find me a 2 BHK near Vijay Nagar under ₹50 lakh', 'Show me my best matches', 'What requirements have I saved?']
const AGENT_ACTION_STATE = {
  awaiting_confirmation: '', executing: '<div class="notice info small">Sending…</div>',
  completed: '<div class="notice ok small"><strong>Request sent.</strong> Your agent confirms it before it is booked in their Google Calendar. Follow it in <a href="#/my-viewings">My viewings</a>.</div>',
  cancelled: '<div class="notice small">Cancelled. Nothing was sent.</div>', expired: '<div class="notice warn small">This request expired. Ask the assistant to check free times again.</div>'
}
const agentListingCard = (l) => `<article class="card"><h2><a href="#/browse/${Number(l.id)}">${esc(l.title)}</a></h2>
  <div><strong>${esc(l.price_text)}</strong> · ${esc([l.locality, l.city].filter(Boolean).join(', '))}${l.score != null ? ` <span class="badge">${Number(l.score)}/100</span>` : ''}</div>
  ${l.reasons?.length || l.gaps?.length ? `<ul class="small">${(l.reasons || []).map((x) => `<li>${esc(x)}</li>`).join('')}${(l.gaps || []).map((g) => `<li class="muted">Unknown: ${esc(g)}</li>`).join('')}</ul>` : ''}
  ${l.flags?.length ? `<div class="notice warn small">This listing’s own text includes ${l.flags.map((f) => (f === 'contact_details' ? 'contact details' : 'instructions addressed to an assistant')).join(' and ')}. DealSaathi does not endorse it: request viewings only through DealSaathi.</div>` : ''}
  <a class="btn ghost small" href="#/browse/${Number(l.id)}">Open listing</a></article>`
function agentActionHtml(a) {
  if (!a) return ''
  return `<div class="card agent-action" data-action="${esc(a.id)}"><h2>Viewing request</h2>
    <p class="small">${a.properties.map((p) => esc(p.title)).join(', ')}<br><strong>${esc(a.when)}</strong></p>
    ${a.interrupted ? '<div class="notice info small">Your last Confirm was interrupted before anything was sent. Press Confirm to try again.</div>' : ''}
    ${a.status === 'needs_review' ? `<div class="notice warn small">${esc(a.error || 'We could not confirm whether this request reached your agent.')} <a href="#/my-viewings">Open My viewings</a></div>` : ''}
    ${a.status === 'awaiting_confirmation' ? `<p class="small muted">Confirm sends this request to your agent. It is booked in their Google Calendar only after they confirm it.</p>
      <div class="row"><button class="btn primary small" data-confirm>Confirm and send to my agent</button><button class="btn ghost small" data-cancel>Cancel</button></div>`
      : a.status === 'failed' ? `<div class="notice err small">Not sent: ${esc(a.error || 'it could not be sent')}</div>` : AGENT_ACTION_STATE[a.status] || ''}</div>`
}

async function renderAgentAssistant() {
  main.innerHTML = `<div class="page-head"><div><h1>Assistant</h1><p>Ask in your own words. It searches published listings, explains why they match and can check your agent’s free times. Nothing reaches your agent until you press <strong>Confirm</strong>, and a viewing is booked only when your agent confirms it.</p></div>
      <button class="btn ghost" id="ag-new">New conversation</button></div>
    <section class="card chat agent-chat" aria-label="Conversation">
      <div class="chat-log" id="ag-log" aria-live="polite"></div>
      <div class="examples" id="ag-examples">${AGENT_EXAMPLES.map((e) => `<button type="button">${esc(e)}</button>`).join('')}</div>
      <form class="chat-form" id="ag-form"><label for="ag-input" class="skip">Message</label>
        <textarea id="ag-input" maxlength="1000" placeholder="e.g. Find me a 2 BHK near Vijay Nagar under ₹50 lakh"></textarea>
        <button class="btn primary" id="ag-send">Send</button></form>
    </section>`
  const log = document.getElementById('ag-log')
  const form = document.getElementById('ag-form')
  const input = document.getElementById('ag-input')
  let conversationId = store.get('ds_agent_conversation')

  const scroll = () => { log.scrollTop = log.scrollHeight }
  const addUser = (text) => {
    const el = document.createElement('div')
    el.className = 'msg user'
    el.textContent = text
    log.append(el)
    document.getElementById('ag-examples').hidden = true
    scroll()
  }
  const addAssistant = (m) => {
    const el = document.createElement('div')
    el.className = `msg assistant agent-msg${['failed', 'stopped', 'action_failed'].includes(m.status) ? ' agent-warn' : ''}`
    el.innerHTML = `${m.steps?.length ? `<ul class="agent-steps small">${m.steps.map((s) => `<li class="${s.status === 'ok' ? 'ok' : 'warn'}">${esc(s.label)}</li>`).join('')}</ul>` : ''}
      <div class="agent-text"></div>
      ${m.listings?.length ? `<div class="grid cards agent-block">${m.listings.map(agentListingCard).join('')}</div>` : ''}
      ${m.offer?.slots?.length ? `<div class="agent-block"><p class="small">Free with ${esc(m.offer.agent_name)} on ${esc(m.offer.date)} (${esc(m.offer.timezone)}):</p>
        <div class="slot-grid">${m.offer.slots.slice(0, 48).map((sl) => `<button class="btn ghost small" type="button" data-slot="${esc(sl.label)}" data-date="${esc(m.offer.date)}">${esc(sl.label)}</button>`).join('')}</div></div>` : ''}
      ${m.action ? `<div class="agent-block">${agentActionHtml(m.action)}</div>` : ''}`
    el.querySelector('.agent-text').textContent = m.reply ?? m.content ?? ''
    el.querySelectorAll('[data-slot]').forEach((b) => b.addEventListener('click', () => send(`Please request a viewing at ${b.dataset.slot} on ${b.dataset.date}.`)))
    bindAction(el)
    log.append(el)
    scroll()
  }
  const bindAction = (el) => {
    const card = el.querySelector('[data-action]')
    if (!card) return
    card.querySelector('[data-confirm]')?.addEventListener('click', async (e) => {
      e.target.disabled = true
      try {
        const { action } = await api(`/api/agent/actions/${card.dataset.action}/confirm`, { method: 'POST', body: {} })
        card.outerHTML = agentActionHtml(action)
        await load()
      } catch (error) {
        toast(error.message)
        if (error.status === 409) await load() // expired, cancelled or already sent: show its real state
        else e.target.disabled = false
      }
    })
    card.querySelector('[data-cancel]')?.addEventListener('click', async () => {
      try { const { action } = await api(`/api/agent/actions/${card.dataset.action}/cancel`, { method: 'POST', body: {} }); card.outerHTML = agentActionHtml(action) } catch (error) { toast(error.message); if (error.status === 409) await load() }
    })
  }
  const load = async () => {
    log.innerHTML = ''
    if (!conversationId) { log.innerHTML = '<p class="muted small">Tell the assistant what you are looking for: area, budget, bedrooms. It only uses real listings that are on the market.</p>'; return }
    try {
      const { messages } = await api(`/api/agent/conversations/${conversationId}`)
      document.getElementById('ag-examples').hidden = messages.length > 0
      for (const m of messages) m.role === 'user' ? addUser(m.content) : addAssistant(m)
    } catch (error) {
      if (error.status === 404) { conversationId = null; store.set('ds_agent_conversation', null); return load() }
      throw error
    }
  }
  let sending = false
  const send = async (text) => {
    if (!text.trim() || sending) return // one message at a time (Enter and free-time buttons too)
    sending = true
    const btn = document.getElementById('ag-send')
    btn.disabled = true
    if (log.querySelector('p.muted')) log.innerHTML = ''
    addUser(text)
    const wait = document.createElement('div')
    wait.className = 'msg assistant thinking'
    wait.textContent = 'Working on it: searching and checking…'
    log.append(wait)
    scroll()
    try {
      const r = await api('/api/agent/messages', { method: 'POST', body: { message: text, conversationId } })
      conversationId = r.conversationId
      store.set('ds_agent_conversation', conversationId)
      wait.remove()
      addAssistant(r)
    } catch (error) {
      wait.className = 'msg error'
      wait.textContent = error.message
      if (error.status === 404) { conversationId = null; store.set('ds_agent_conversation', null) }
    } finally { sending = false; btn.disabled = false; input.focus() }
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); const text = input.value; input.value = ''; send(text) })
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit() } })
  document.getElementById('ag-examples').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => send(b.textContent)))
  document.getElementById('ag-new').addEventListener('click', () => { conversationId = null; store.set('ds_agent_conversation', null); document.getElementById('ag-examples').hidden = false; load(); input.focus() })
  await load()
}

// ---------- sellers ----------
async function renderSellerHome() {
  const [{ profile }, { properties }, { viewings }, { notifications }] = await Promise.all([api('/api/me'), api('/api/properties?scope=mine'), api('/api/me/listing-viewings'), api('/api/notifications?limit=5')])
  const live = properties.filter((p) => p.listing_state === 'published')
  main.innerHTML = `<div class="page-head"><div><h1>Hello, ${esc(session.user.name.split(' ')[0])}</h1><p>${profile.agent ? `Your agent is <strong>${esc(profile.agent.name)}</strong>.` : 'An agent is assigned when you list a property in an area an agent serves.'}</p></div>
    <a class="btn primary" href="#/my-listings/new">List a property</a></div>
    <div class="grid stats"><div class="card stat"><div class="label">Listings</div><div class="value">${properties.length}</div></div>
      <div class="card stat"><div class="label">Published</div><div class="value">${live.length}</div></div>
      <div class="card stat"><div class="label">Matching buyer requirements</div><div class="value">${live.reduce((a, p) => a + p.match_count, 0)}</div></div>
      <div class="card stat"><div class="label">Upcoming viewings</div><div class="value">${viewings.filter((v) => v.status === 'booked').length}</div></div></div>
    <section class="card"><h2>Latest notifications</h2>${notifications.length ? `<ul class="timeline">${notifications.map((n) => `<li>${n.link ? `<a href="${esc(n.link)}">${esc(n.title)}</a>` : esc(n.title)}<div class="small muted">${esc(fmtDateTime(n.createdAt))}</div></li>`).join('')}</ul>` : '<p class="muted">Nothing yet.</p>'}</section>`
}

async function renderListingViewings() {
  const { viewings } = await api('/api/me/listing-viewings')
  main.innerHTML = `<div class="page-head"><div><h1>Viewings</h1><p>Viewings of your listings, arranged by your agent. Buyers’ details stay private.</p></div></div>
    <section class="card">${viewings.length ? `<ul class="timeline">${viewings.map((v) => `<li><strong>${esc(v.when)}</strong> ${BV_STATUS[v.status] || esc(v.status)}<div class="small">${v.properties.map((p) => esc(p.title)).join(', ')}</div></li>`).join('')}</ul>` : '<p class="muted">No viewings yet.</p>'}</section>`
}

// ---------- tenants and landlords ----------
async function renderMyTenancies() {
  const landlord = session.user.role === 'seller'
  const { tenancies } = await api('/api/me/tenancies')
  main.innerHTML = `<div class="page-head"><div><h1>${landlord ? 'My rentals' : 'My rent'}</h1><p>${landlord ? 'Tenancies on your properties, managed by your agent. You can record rent you received.' : 'Your rent, as recorded by your agent. Rent is marked paid only when a payment is confirmed.'}</p></div></div>
    ${tenancies.length ? tenancies.map(({ tenancy: t, dues }) => `<section class="card" style="margin-bottom:1rem"><h2>${esc(t.propertyLabel)}</h2>
      <p class="small">${rupees(t.rentAmount)} a month, due on day ${t.dueDay} · ${esc(t.status)}${landlord ? ` · tenant ${esc(t.tenantName)}` : ''}${t.agent ? ` · managed by ${esc(t.agent.name)}` : ''}</p>
      <ul class="timeline">${dues.map((d) => `<li data-due="${d.id}"><strong>${esc(d.period)}</strong> ${DUE_STATE[d.state]} <span class="small">due ${esc(d.dueDate)} · ${rupees(d.amount)}${d.amountPaid ? ` · ${rupees(d.amountPaid)} paid` : ''}${d.verificationSource ? ` (${d.verificationSource === 'razorpay' ? 'confirmed by Razorpay' : 'recorded'})` : ''}</span>
        ${safeUrl(d.paymentLink?.url) ? `<div class="small"><a href="${esc(d.paymentLink.url)}" target="_blank" rel="noopener noreferrer">Pay with Razorpay</a></div>` : ''}
        ${d.canRecord ? '<button class="btn ghost small" data-pay>Record payment received</button><div class="due-extra"></div>' : ''}</li>`).join('')}</ul></section>`).join('') : `<p class="muted">No tenancy is linked to your account. Your agent can send you an invitation link, or link it once your email address is verified.</p>`}`
  main.querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', () => {
    const li = b.closest('[data-due]')
    li.querySelector('.due-extra').innerHTML = `<form class="form-grid" novalidate style="margin-top:.5rem">
      <div class="field" data-field="amount"><label>Amount received (₹)</label><input name="amount" type="number" min="1"><div class="err"></div></div>
      <div class="field" data-field="paidOn"><label>Received on</label><input name="paidOn" type="date" max="${todayLocal()}" value="${todayLocal()}"><div class="err"></div></div>
      <div class="field wide" data-field="note"><label>How you verified it</label><input name="note" placeholder="e.g. UPI ref 8812, bank statement"><div class="err"></div></div>
      <div class="row end wide"><button class="btn primary small">Record payment</button></div></form>`
    const f = li.querySelector('form')
    f.addEventListener('submit', async (e) => {
      e.preventDefault()
      try { await api(`/api/me/rent/dues/${li.dataset.due}/payments`, { method: 'POST', body: { amount: Number(f.elements.amount.value), paidOn: f.elements.paidOn.value, note: f.elements.note.value } }); toast('Payment recorded.'); renderMyTenancies() } catch (error) { showFieldErrors(f, error.details?.fields); if (!error.details?.fields) toast(error.message) }
    })
  }))
}

// ---------- router ----------
/** Pages per role. A section not listed for the signed-in role is not shown (and its API refuses the role anyway). */
const ROUTES = {
  agent: {
    dashboard: () => renderDashboard(), notifications: () => renderNotifications(), profile: () => renderProfile(), assistant: () => renderAssistant(),
    leads: (p, params) => (p[1] === 'new' ? renderLeadForm(null) : p[1] && p[2] === 'edit' ? renderLeadForm(p[1]) : p[1] ? renderLeadDetail(p[1]) : renderLeads(params)),
    pool: () => renderPool(), activity: (p, params) => renderActivity(params),
    properties: (p, params) => (p[1] === 'new' ? renderPropertyForm(null) : p[1] && p[2] === 'edit' ? renderPropertyForm(p[1]) : p[1] ? renderPropertyDetail(p[1]) : renderProperties(params)),
    viewings: (p, params) => renderViewings(params), feedback: () => renderFeedback(),
    rent: (p) => (p[1] === 'new' ? renderTenancyForm(null) : p[1] && p[2] === 'edit' ? renderTenancyForm(p[1]) : p[1] ? renderTenancy(p[1]) : renderRent()),
    integrations: () => renderIntegrations(), automations: () => renderAutomations()
  },
  buyer: {
    dashboard: () => renderBuyerHome(), assistant: () => renderAgentAssistant(), requirements: () => renderRequirements(), recommendations: () => renderRecommendations(),
    browse: (p, params) => (p[1] ? renderPropertyDetail(p[1]) : renderProperties(params)), 'my-viewings': () => renderMyViewings(),
    'my-tenancies': () => renderMyTenancies(), notifications: () => renderNotifications()
  },
  seller: {
    dashboard: () => renderSellerHome(), profile: () => renderProfile(), notifications: () => renderNotifications(),
    'my-listings': (p, params) => (p[1] === 'new' ? renderPropertyForm(null) : p[1] && p[2] === 'edit' ? renderPropertyForm(p[1]) : p[1] ? renderPropertyDetail(p[1]) : renderProperties(params)),
    'listing-viewings': () => renderListingViewings(), 'my-tenancies': () => renderMyTenancies()
  }
}

async function route() {
  if (session.mode === 'locked') return renderLocked()
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?')
  const parts = path.split('/').filter(Boolean)
  // Links from emails work signed in or not; an invitation waits for sign-in.
  if (parts[0] === 'verify-email' && parts[1]) return renderVerifyEmail(parts[1])
  if (parts[0] === 'reset-password' && parts[1]) return renderResetPassword(parts[1])
  if (parts[0] === 'invite' && parts[1]) store.set('pendingInvite', parts[1])
  if (!session.user) return renderLogin()
  const invite = store.get('pendingInvite')
  if (invite) { store.set('pendingInvite', null); history.replaceState(null, '', '#/dashboard'); return renderInvite(invite) }
  const params = new URLSearchParams(query)
  const section = parts[0] || 'dashboard'
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === section))
  const page = ROUTES[session.user.role]?.[section]
  try {
    if (page) await page(parts, params)
    else main.innerHTML = '<div class="empty"><h1>Page not found</h1><p>This page does not exist, or is not part of your account’s role. <a href="#/dashboard">Go home</a></p></div>'
  } catch (error) {
    main.innerHTML = `<div class="notice err">${esc(error.message)}</div>`
  }
  refreshUnread()
  main.focus({ preventScroll: true })
}

async function checkHealth() {
  const dot = document.getElementById('health-dot')
  const text = document.getElementById('health-text')
  try {
    const h = await api('/api/health')
    dot.className = `dot ${h.viasocket === 'configured' ? 'ok' : 'warn'}`
    text.textContent = h.viasocket === 'configured' ? 'Database ok · viaSocket credentials set' : 'Database ok · viaSocket not configured'
  } catch {
    dot.className = 'dot bad'
    text.textContent = 'Server not reachable'
  }
}

window.addEventListener('hashchange', route)
if (!location.hash) history.replaceState(null, '', '#/dashboard')
api('/api/session')
  .then((s) => Object.assign(session, s))
  .catch(() => {})
  .finally(() => { updateAccessUi(); route(); checkHealth() })
