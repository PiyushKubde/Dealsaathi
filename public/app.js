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
  { key: 'notes', label: 'Notes', type: 'textarea', wide: true }
]

// ---------- helpers ----------
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
  if (!res.ok) throw new ApiError(res.status, data)
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
  form.querySelectorAll('.field').forEach((el) => { el.classList.remove('invalid'); el.querySelector('.err').textContent = '' })
  for (const [key, message] of Object.entries(fields)) {
    const el = form.querySelector(`[data-field="${key}"]`)
    if (el) { el.classList.add('invalid'); el.querySelector('.err').textContent = message }
  }
  form.querySelector('.invalid input, .invalid select')?.focus()
}

function duplicatesHtml(duplicates, { canOverride }) {
  if (!duplicates?.length) return ''
  const strong = duplicates.some((d) => d.strong)
  const items = duplicates.map((d) => `<li><a href="#/leads/${d.lead.id}">${esc(d.lead.full_name)}</a> <span class="code">${esc(d.lead.code)}</span> (${esc(d.reasons.join(', '))})</li>`).join('')
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
    <div class="page-head"><div><h1>Dashboard</h1><p>All counts come from the leads saved in the local database on this computer.</p></div>
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
    </div>`
}

async function renderLeads(params) {
  const state = { q: params.get('q') || '', customer_type: params.get('customer_type') || '', status: params.get('status') || '', location: params.get('location') || '', follow_up: params.get('follow_up') || '' }
  const opt = (group, sel) => Object.entries(LABELS[group]).map(([k, l]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${esc(l)}</option>`).join('')
  main.innerHTML = `
    <div class="page-head"><div><h1>Leads</h1><p>Saved in the local database on this computer. Not synced to any CRM.</p></div>
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
    ['Assigned broker', dash(l.assigned_broker)], ['Notes', dash(l.notes)], ['Created', esc(fmtDateTime(l.created_at))], ['Last updated', esc(fmtDateTime(l.updated_at))],
    ['Stored in', 'Local database on this computer']
  ]
  main.innerHTML = `
    <div class="page-head"><div><a href="#/leads" class="small">← All leads</a><h1>${esc(l.full_name)}</h1></div>
      <div class="row"><a class="btn ghost" href="#/leads/${l.id}/edit">Edit</a><button class="btn danger" id="delete">Delete</button></div></div>
    <div class="grid two-col">
      <section class="card"><h2>Details</h2><dl class="details">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></section>
      <section class="card"><h2>Activity</h2><ul class="timeline">${activities.map((a) => `<li><strong>${esc(a.summary)}</strong>
        <div class="small muted">${esc(fmtDateTime(a.created_at))} · via ${a.via === 'assistant' ? 'AI assistant (confirmed by you)' : 'form'}</div></li>`).join('')}</ul></section>
    </div>`
  document.getElementById('delete').addEventListener('click', async () => {
    const ok = await confirmDialog(`Delete ${l.full_name}?`, 'This permanently removes the lead and its activity history from the local database. It cannot be undone.', 'Delete permanently')
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
      toast(id ? (res.changed.length ? 'Changes saved to the local database.' : 'No changes to save.') : `Saved ${res.lead.full_name} (${res.lead.code}) to the local database.`)
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
      <div class="notice ok">${alreadySaved ? 'This lead was already saved earlier; it was not saved twice.' : 'Saved to the local database on this computer'} as <strong>${esc(lead.code)}</strong>. It has not been sent to any CRM or other app.</div>
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
        addMsg('assistant', res.alreadySaved ? `${res.lead.full_name} was already saved as ${res.lead.code}.` : `Saved ${res.lead.full_name} as lead ${res.lead.code} in the local database.`)
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

// ---------- router ----------
async function route() {
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?')
  const parts = path.split('/').filter(Boolean)
  const params = new URLSearchParams(query)
  const section = parts[0] || 'dashboard'
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === section))
  try {
    if (section === 'dashboard') await renderDashboard()
    else if (section === 'assistant') await renderAssistant()
    else if (section === 'leads' && parts[1] === 'new') await renderLeadForm(null)
    else if (section === 'leads' && parts[1] && parts[2] === 'edit') await renderLeadForm(parts[1])
    else if (section === 'leads' && parts[1]) await renderLeadDetail(parts[1])
    else if (section === 'leads') await renderLeads(params)
    else main.innerHTML = '<div class="empty"><h1>Page not found</h1><p><a href="#/dashboard">Go to the dashboard</a></p></div>'
  } catch (error) {
    main.innerHTML = `<div class="notice err">${esc(error.message)}</div>`
  }
  main.focus({ preventScroll: true })
}

async function checkHealth() {
  const dot = document.getElementById('health-dot')
  const text = document.getElementById('health-text')
  try {
    const h = await api('/api/health')
    dot.className = `dot ${h.ai === 'configured' ? 'ok' : 'warn'}`
    text.textContent = h.ai === 'configured' ? 'Local database · AI credentials set' : 'Local database · AI not configured'
  } catch {
    dot.className = 'dot bad'
    text.textContent = 'Server not reachable'
  }
}

window.addEventListener('hashchange', route)
if (!location.hash) history.replaceState(null, '', '#/dashboard')
route()
checkHealth()
