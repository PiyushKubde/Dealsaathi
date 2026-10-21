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
const VIA_LABELS = { form: 'form', assistant: 'AI assistant (confirmed by you)', gmail: 'Gmail via viaSocket', matching: 'automatic matching' }
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
    </div>`
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
    ['Assigned broker', dash(l.assigned_broker)], ['Notes', dash(l.notes)], ['Created', esc(fmtDateTime(l.created_at))], ['Last updated', esc(fmtDateTime(l.updated_at))],
    ['Stored in', esc(storedIn())]
  ]
  main.innerHTML = `
    <div class="page-head"><div><a href="#/leads" class="small">← All leads</a><h1>${esc(l.full_name)}</h1></div>
      <div class="row"><a class="btn ghost" href="#/leads/${l.id}/edit">Edit</a><button class="btn danger" id="delete">Delete</button></div></div>
    <div class="grid two-col">
      <section class="card"><h2>Details</h2><dl class="details">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></section>
      <section class="card"><h2>Activity</h2><ul class="timeline">${activities.map((a) => `<li><strong>${esc(a.summary)}</strong>
        <div class="small muted">${esc(fmtDateTime(a.created_at))} · via ${esc(VIA_LABELS[a.via] || a.via)}${a.user_name ? ` · by ${esc(a.user_name)}` : ''}</div></li>`).join('')}</ul></section>
    </div>
    <section class="card" style="margin-top:1rem"><h2>Matching properties</h2><div id="lead-matches"><p class="muted">Loading…</p></div></section>
    <section class="card" style="margin-top:1rem"><h2>Follow-up email</h2>
      <p class="small muted">Sent from your own connected Gmail through viaSocket (Gmail · Send Email). You review it before anything is sent.</p>
      <div id="followup"><p class="muted">Loading…</p></div></section>`
  renderLeadMatches(l, document.getElementById('lead-matches'))
  renderFollowupPanel(l, document.getElementById('followup'))
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
      <p class="muted">${register ? 'Each broker has their own account, so their connected apps and automations stay their own.' : 'Sign in to DealSaathi.'}</p>
      <form id="auth-form" class="stack" novalidate>
        ${register ? '<div class="field" data-field="name"><label for="a-name">Your name</label><input id="a-name" name="name" autocomplete="name" required><div class="err"></div></div>' : ''}
        <div class="field" data-field="email"><label for="a-email">Email</label><input id="a-email" name="email" type="email" autocomplete="email" required><div class="err"></div></div>
        <div class="field" data-field="password"><label for="a-password">Password</label><input id="a-password" name="password" type="password" autocomplete="${register ? 'new-password' : 'current-password'}" required>${register ? '<div class="hint">At least 10 characters.</div>' : ''}<div class="err"></div></div>
        ${register && session.registrationNeedsCode ? '<div class="field" data-field="accessCode"><label for="a-code">Team access code</label><input id="a-code" name="accessCode" type="password" autocomplete="off" required><div class="hint">Ask the person who set up DealSaathi.</div><div class="err"></div></div>' : ''}
        <div id="auth-error"></div>
        <button class="btn primary" type="submit">${register ? 'Create account' : 'Sign in'}</button>
        <button class="btn ghost" type="button" id="auth-switch">${register ? 'I already have an account' : 'Create an account'}</button>
      </form>
    </div>`
  const form = document.getElementById('auth-form')
  form.querySelector('input').focus()
  document.getElementById('auth-switch').addEventListener('click', () => renderLogin(register ? 'signin' : 'register'))
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const body = Object.fromEntries(new FormData(form))
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

function renderLocked() {
  main.innerHTML = `<div class="card" style="max-width:520px;margin:3rem auto"><h1>Not ready yet</h1>
    <p>This hosted copy of DealSaathi is locked because no team access code has been set.</p>
    <p class="muted">The owner adds <strong>APP_PASSWORD</strong> (at least 12 characters) in the hosting settings, then reloads this page. Brokers then use that code once, to create their own accounts.</p></div>`
}

function updateAccessUi() {
  const foot = document.querySelector('.sidebar-foot')
  document.getElementById('account')?.remove()
  if (!session.user) return
  const box = document.createElement('div')
  box.id = 'account'
  box.className = 'account'
  box.innerHTML = `<div class="small"><strong>${esc(session.user.name)}</strong><div class="muted">${esc(session.user.email)}</div></div>`
  const out = document.createElement('button')
  out.className = 'btn ghost small'
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
const appIcon = (url, name) => (url ? `<img class="app-icon" src="${esc(url)}" alt="" width="28" height="28" referrerpolicy="no-referrer">` : `<span class="app-icon app-icon-fallback" aria-hidden="true">${esc((name || '?')[0])}</span>`)

async function renderIntegrations() {
  main.innerHTML = `
    <div class="page-head"><div><h1>Integrations</h1>
      <p>Connect your own app accounts through viaSocket. You sign in on the app’s own page; viaSocket keeps the access, and DealSaathi stores only a reference to the connection.</p></div></div>
    <div id="int-notice"></div>
    <div class="grid two-col">
      <section class="card"><h2>Your connections</h2><div id="conn-list"><p class="muted">Loading…</p></div></section>
      <section class="card"><h2>Gmail for follow-ups</h2>
        <p class="small muted">Lead follow-up emails are sent from your own Gmail through viaSocket’s <em>Gmail · Send Email</em> action. Connecting asks only for that action’s permissions.</p>
        <div id="gmail-box"><p class="muted">Loading…</p></div></section>
    </div>
    <section class="card" style="margin-top:1rem"><h2>Find another app</h2>
      <div class="field"><label for="app-q">Search viaSocket’s catalog</label><input id="app-q" type="search" placeholder="e.g. Google Calendar, HubSpot, WhatsApp" autocomplete="off"></div>
      <div id="app-results" class="app-grid"></div>
      <div id="app-detail"></div>
    </section>`
  const notice = document.getElementById('int-notice')
  let ready
  try {
    ready = await prepareConnect()
  } catch (error) {
    notice.innerHTML = `<div class="notice err">${esc(error.message)}</div>`
  }

  const loadList = async () => {
    const box = document.getElementById('conn-list')
    try {
      const { connections, live, error } = await api('/api/integrations/connections')
      box.innerHTML = (error ? `<div class="notice warn">${esc(error)}</div>` : '') + (connections.length
        ? `<ul class="timeline">${connections.map((c) => `<li class="conn-row">${appIcon(c.iconUrl, c.appName)}
            <div style="flex:1;min-width:0"><strong>${esc(c.appName)}</strong> ${STATUS_BADGE[c.status] || ''}
              <div class="small muted">${esc(c.label || 'Account')} · connected ${esc(fmtDate(c.createdAt))}${live ? '' : ' · live status not checked'}</div></div>
            <div class="row">${c.status === 'expired' ? `<button class="btn ghost small" data-reconnect="${c.id}">Reconnect</button>` : ''}
              <button class="btn ghost small" data-disconnect="${c.id}" data-name="${esc(c.appName)}">Disconnect</button></div></li>`).join('')}</ul>`
        : '<p class="muted">Nothing connected yet.</p>')
      box.querySelectorAll('[data-disconnect]').forEach((b) => b.addEventListener('click', async () => {
        const ok = await confirmDialog(`Disconnect ${b.dataset.name}?`, 'DealSaathi pauses anything it runs on this account, then revokes the connection on viaSocket. You can connect again later.', 'Disconnect')
        if (!ok) return
        try {
          await api(`/api/integrations/connections/${b.dataset.disconnect}`, { method: 'DELETE' })
          toast(`${b.dataset.name} disconnected.`)
          loadList(); loadGmail()
        } catch (error) { toast(error.message) }
      }))
      box.querySelectorAll('[data-reconnect]').forEach((b) => b.addEventListener('click', async () => {
        try {
          const r = await api(`/api/integrations/connections/${b.dataset.reconnect}/reconnect`, { method: 'POST', body: {} })
          const out = await runConnect({ ...ready, token: r.embedToken }, { serviceId: r.serviceId, authId: r.authId }, () => loadList())
          if (!out.ok) notice.innerHTML = `<div class="notice ${out.code === 'closed' ? 'warn' : 'err'}">${esc(out.message)}</div>`
        } catch (error) { toast(error.message) }
      }))
    } catch (error) {
      box.innerHTML = `<div class="notice err">${esc(error.message)}</div>`
    }
  }

  const loadGmail = async () => {
    const box = document.getElementById('gmail-box')
    try {
      const [gmail, { connections }] = await Promise.all([api('/api/integrations/gmail'), api('/api/integrations/connections')])
      const mine = connections.filter((c) => c.serviceId === gmail.serviceId && c.status === 'active')
      box.innerHTML = `${mine.length ? `<div class="notice ok">Connected: ${mine.map((c) => esc(c.label || 'Gmail')).join(', ')}</div>` : ''}
        <button class="btn primary connect-btn" id="connect-gmail" ${ready ? '' : 'disabled'}>${appIcon('https://stuff.thingsofbrand.com/gmail.com/images/imge_idrA5FDGTH_1763454052978.svg', 'Gmail')} ${mine.length ? 'Connect another Gmail' : 'Connect Gmail'}</button>
        <div id="gmail-msg"></div>`
      document.getElementById('connect-gmail').addEventListener('click', async () => {
        const out = await runConnect(ready, { serviceId: gmail.serviceId, actions: gmail.actions, appName: 'Gmail' }, () => { loadList(); loadGmail() })
        if (!out.ok) document.getElementById('gmail-msg').innerHTML = `<div class="notice ${out.code === 'closed' ? 'warn' : 'err'}" style="margin-top:.75rem">${esc(out.message)}</div>`
      })
    } catch (error) {
      box.innerHTML = `<div class="notice err">${esc(error.message)}</div>`
    }
  }

  const q = document.getElementById('app-q')
  const results = document.getElementById('app-results')
  const detail = document.getElementById('app-detail')
  let timer, seq = 0
  q.addEventListener('input', () => {
    clearTimeout(timer)
    timer = setTimeout(async () => {
      const mine = ++seq
      detail.innerHTML = ''
      if (q.value.trim().length < 2) { results.innerHTML = ''; return }
      try {
        const { apps } = await api(`/api/integrations/apps?q=${encodeURIComponent(q.value.trim())}`)
        if (mine !== seq) return
        results.innerHTML = apps.length ? apps.map((a) => `<button class="app-tile" data-service="${esc(a.serviceId)}">${appIcon(a.iconUrl, a.name)}<span>${esc(a.name)}</span></button>`).join('') : '<p class="muted">No apps match.</p>'
        results.querySelectorAll('[data-service]').forEach((b) => b.addEventListener('click', () => showApp(b.dataset.service)))
      } catch (error) {
        results.innerHTML = `<div class="notice err">${esc(error.message)}</div>`
      }
    }, 300)
  })

  const showApp = async (serviceId) => {
    detail.innerHTML = '<p class="muted">Loading…</p>'
    try {
      const a = await api(`/api/integrations/apps/${encodeURIComponent(serviceId)}`)
      const events = (list, kind) => list.length ? `<h3>${list.length} ${kind}</h3><ul class="small">${list.slice(0, 8).map((e) => `<li>${esc(e.name)}</li>`).join('')}${list.length > 8 ? `<li class="muted">and ${list.length - 8} more</li>` : ''}</ul>` : ''
      detail.innerHTML = `<div class="app-detail">
        <div class="row">${appIcon(a.iconUrl, a.name)}<h2 style="margin:0">${esc(a.name)}</h2>${a.authType ? `<span class="badge">${esc(a.authType)}</span>` : ''}</div>
        <p class="small muted">${esc(a.description)}</p>
        <div class="grid two-col">${events(a.actions, 'actions') || '<p class="small muted">No published actions.</p>'}${events(a.triggers, 'triggers')}</div>
        ${a.requiresAuth ? `<button class="btn primary connect-btn" id="connect-app" ${ready ? '' : 'disabled'}>${appIcon(a.iconUrl, a.name)} Connect ${esc(a.name)}</button>` : '<div class="notice info">This app needs no sign-in, so there is nothing to connect.</div>'}
        <div id="app-msg"></div>
        <p class="small muted">Connecting makes the account available to DealSaathi. Only Gmail is used by a DealSaathi feature today; any connected app can be used in your own automations.</p></div>`
      document.getElementById('connect-app')?.addEventListener('click', async () => {
        const out = await runConnect(ready, { serviceId: a.serviceId, appName: a.name }, () => loadList())
        if (!out.ok) document.getElementById('app-msg').innerHTML = `<div class="notice ${out.code === 'closed' ? 'warn' : 'err'}">${esc(out.message)}</div>`
      })
    } catch (error) {
      detail.innerHTML = `<div class="notice err">${esc(error.message)}</div>`
    }
  }

  loadList()
  loadGmail()
}

// ---------- automations: viaSocket's prebuilt UI (https://flow.viasocket.com/documentation/embed.md) ----------
let currentEmbed = null
let embedScript = null
function loadEmbedScript() {
  embedScript ||= new Promise((resolve, reject) => {
    if (window.viaSocket?.mount) return resolve()
    const tag = document.createElement('script')
    tag.src = 'https://embed.viasocket.com/prod-embedcomponent.js'
    tag.onload = () => (window.viaSocket?.mount ? resolve() : reject(new Error('The viaSocket workflow builder did not start.')))
    tag.onerror = () => { embedScript = null; reject(new Error('The viaSocket workflow builder could not load. Check your internet connection or ad blocker.')) }
    document.head.append(tag)
  })
  return embedScript
}

// Flow events from the prebuilt UI, through the SDK's own embed.on('flow'). Only the flow id and the event
// go to the server, which reads the flow back from viaSocket itself; nothing else in the event (such as its
// run URL) is used or stored.
const FLOW_EVENTS = ['initiated', 'published', 'updated', 'paused', 'deleted']
function onFlowEvent(flow) {
  if (!flow?.id || !FLOW_EVENTS.includes(flow.action)) return
  api('/api/automations/flow-events', { method: 'POST', body: { flowId: String(flow.id), action: flow.action } })
    .then((r) => { toast(`Automation “${r.title}”: ${r.event}.`); document.dispatchEvent(new CustomEvent('ds-flows-changed')) })
    .catch(() => {})
}

async function renderAutomations() {
  main.innerHTML = `
    <div class="page-head"><div><h1>Automations</h1>
      <p>Build automations across your connected apps with viaSocket’s workflow builder, below. Published automations run on viaSocket, under your own account.</p></div></div>
    <section class="card"><h2>Your automations</h2><div id="flow-list"><p class="muted">Loading…</p></div></section>
    <section class="card" style="margin-top:1rem;padding:0;overflow:hidden">
      <div style="padding:1rem 1.25rem .5rem"><h2 style="margin:0">Workflow builder</h2><p class="small muted" style="margin:.25rem 0 0">viaSocket’s own screens, signed in as you.</p></div>
      <div id="embed-msg" style="padding:0 1.25rem"></div>
      <div id="vs-embed" style="height:680px"></div>
    </section>`

  const loadFlows = async () => {
    const box = document.getElementById('flow-list')
    if (!box) return
    try {
      const { flows, events } = await api('/api/automations/flows')
      box.innerHTML = (flows.length ? `<ul class="timeline">${flows.map((f) => `<li class="conn-row"><div style="flex:1;min-width:0"><strong>${esc(f.title)}</strong>
          <span class="badge ${f.status === 'active' ? 'saved' : 'draft'}">${esc(f.status)}</span>${f.kind === 'dealsaathi' ? ' <span class="badge ai">Used by DealSaathi</span>' : ''}
          <div class="small muted">${esc(f.description || '')}</div></div>
          <button class="btn ghost small" data-ref="${f.ref}" data-to="${f.status === 'active' ? 'paused' : 'active'}">${f.status === 'active' ? 'Pause' : 'Resume'}</button></li>`).join('')}</ul>`
        : '<p class="muted">No automations yet. Build one below.</p>') +
        (events.length ? `<h3 style="margin-top:1rem">Recent changes</h3><ul class="small">${events.slice(0, 5).map((e) => `<li>${esc(e.title)}: ${esc(e.event)} · ${esc(fmtDateTime(e.at))}</li>`).join('')}</ul>` : '')
      box.querySelectorAll('[data-ref]').forEach((b) => b.addEventListener('click', async () => {
        b.disabled = true
        try {
          await api(`/api/automations/flows/${b.dataset.ref}/status`, { method: 'POST', body: { status: b.dataset.to } })
          toast(b.dataset.to === 'paused' ? 'Automation paused.' : 'Automation resumed.')
          loadFlows()
        } catch (error) { toast(error.message); b.disabled = false }
      }))
    } catch (error) {
      box.innerHTML = `<div class="notice err">${esc(error.message)}</div>`
    }
  }
  document.addEventListener('ds-flows-changed', loadFlows)
  loadFlows()

  const msg = document.getElementById('embed-msg')
  try {
    const [{ embedToken }] = await Promise.all([api('/api/integrations/token'), loadEmbedScript()])
    if (!document.getElementById('vs-embed')) return
    currentEmbed = window.viaSocket.mount({
      embedToken,
      parent: '#vs-embed',
      config: { pageheading: 'Automation', pagesubheading: 'Connect DealSaathi with the other apps you use.', showEnabled: true }
    })
    currentEmbed.on('flow', onFlowEvent)
    currentEmbed.on('error', (e) => { msg.innerHTML = `<div class="notice err">The workflow builder reported a problem: ${esc(e?.message || String(e))}</div>` })
  } catch (error) {
    msg.innerHTML = `<div class="notice err">${esc(error.message)}</div>`
  }
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

async function renderProperties(params) {
  main.innerHTML = `
    <div class="page-head"><div><h1>Properties</h1><p>Your listings. Saving one matches it against saved buyers and tenants straight away.</p></div>
      <div class="row"><button class="btn ghost" id="load-samples">Load sample listings</button><a class="btn primary" href="#/properties/new">New property</a></div></div>
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
      const { properties } = await api(`/api/properties?${qs}`)
      box.innerHTML = properties.length ? `<table><thead><tr><th>Listing</th><th>Type</th><th>Where</th><th>Price</th><th>Status</th><th>Matched buyers</th></tr></thead><tbody>
        ${properties.map((p) => `<tr data-id="${p.id}" tabindex="0"><td><div class="cell-name">${esc(p.title)}${sampleBadge(p)}</div><div class="code">${esc(p.code)}</div></td>
          <td>${esc(P_LABELS.listing_type[p.listing_type])} · ${esc(label('property_type', p.property_type))}${p.bedrooms != null ? ` · ${p.bedrooms} BHK` : ''}</td>
          <td>${esc([p.locality, p.city].filter(Boolean).join(', '))}</td><td>${esc(priceText(p))}</td><td>${esc(P_LABELS.status[p.status])}</td><td>${p.match_count}</td></tr>`).join('')}</tbody></table>`
        : `<p class="empty">${qs.toString() ? 'No listings match these filters.' : 'No listings yet. Add one, or load the sample listings to try matching.'}</p>`
      box.querySelectorAll('tr[data-id]').forEach((tr) => {
        const go = () => { location.hash = `#/properties/${tr.dataset.id}` }
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
  document.getElementById('load-samples').addEventListener('click', async () => {
    try {
      const { properties } = await api('/api/properties/samples', { method: 'POST', body: {} })
      toast(`Loaded ${properties.length} sample listings (labelled Sample, not real inventory).`)
      load()
    } catch (error) { toast(error.message) }
  })
  load()
}

async function renderPropertyDetail(id) {
  let data
  try {
    data = await api(`/api/properties/${encodeURIComponent(id)}`)
  } catch (error) {
    main.innerHTML = `<div class="notice err">${esc(error.message)}</div><a href="#/properties">Back to properties</a>`
    return
  }
  const { property: p, matches } = data
  const rows = [['Listing ID', `<span class="code">${esc(p.code)}</span>`], ['Listing', esc(P_LABELS.listing_type[p.listing_type])], ['Type', esc(label('property_type', p.property_type))],
    ['Bedrooms', dash(p.bedrooms)], ['Price', esc(priceText(p))], ['Where', esc([p.locality, p.city].filter(Boolean).join(', '))], ['Address', dash(p.address)],
    ['Area', p.area_sqft ? `${esc(p.area_sqft)} sq ft` : dash(null)], ['Amenities', p.amenities.length ? esc(p.amenities.join(', ')) : dash(null)],
    ['Status', esc(P_LABELS.status[p.status])], ['Notes', dash(p.notes)], ['Updated', esc(fmtDateTime(p.updated_at))]]
  main.innerHTML = `
    <div class="page-head"><div><a href="#/properties" class="small">← All properties</a><h1>${esc(p.title)}${sampleBadge(p)}</h1>
      ${p.is_sample ? '<p class="small muted">A sample listing for trying DealSaathi. It is not real inventory.</p>' : ''}</div>
      <div class="row"><a class="btn ghost" href="#/properties/${p.id}/edit">Edit</a><button class="btn danger" id="p-delete">Delete</button></div></div>
    <div class="grid two-col">
      <section class="card"><h2>Details</h2><dl class="details">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></section>
      <section class="card"><h2>Matched buyers</h2>
        <p class="small muted">Worked out when the listing was saved, from each lead’s saved location, budget, bedrooms and property type. Leads whose stated needs it does not meet are left out.</p>
        ${matches.length ? `<ul class="timeline">${matches.map((m) => `<li${m.status === 'dismissed' ? ' class="muted"' : ''}><a href="#/leads/${m.leadId}"><strong>${esc(m.name)}</strong></a> ${typeBadge(m.customerType)} <span class="badge">${m.score}/100</span>${m.status === 'dismissed' ? ' <span class="badge">Dismissed</span>' : ''}
          <ul class="small">${m.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}${m.gaps.map((g) => `<li class="muted">Unknown: ${esc(g)}</li>`).join('')}</ul>
          ${m.status === 'suggested' ? `<button class="btn ghost small" data-dismiss="${m.leadId}">Not a fit</button>` : ''}</li>`).join('')}</ul>`
          : `<p class="muted">No saved ${p.listing_type === 'rent' ? 'tenant' : 'buyer'} fits this listing${p.status !== 'available' ? ' (it is not marked available)' : ''}.</p>`}
        <div class="notice info small">Sending these to buyers on WhatsApp needs a connected WhatsApp Business account with an approved template. See Integrations.</div></section>
    </div>`
  main.querySelectorAll('[data-dismiss]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/api/properties/${p.id}/matches/${b.dataset.dismiss}/dismiss`, { method: 'POST', body: {} }); renderPropertyDetail(p.id) } catch (error) { toast(error.message) }
  }))
  document.getElementById('p-delete').addEventListener('click', async () => {
    if (!(await confirmDialog(`Delete ${p.title}?`, 'This removes the listing and its buyer matches. It cannot be undone.', 'Delete permanently'))) return
    try { await api(`/api/properties/${p.id}`, { method: 'DELETE' }); toast('Listing deleted.'); location.hash = '#/properties' } catch (error) { toast(error.message) }
  })
}

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
    <div class="page-head"><div><a href="${id ? `#/properties/${id}` : '#/properties'}" class="small">← Back</a><h1>${id ? `Edit ${esc(p.title)}` : 'New property'}</h1>
      <p>Fields marked * are required. Price is the total for a sale, or the monthly rent.</p></div></div>
    <form class="card" id="p-form" novalidate><div id="p-notice"></div>
      <div class="form-grid">${P_FIELDS.map((f) => fieldHtml(f, values[f.key])).join('')}</div>
      <div class="row end" style="margin-top:1rem"><a class="btn ghost" href="${id ? `#/properties/${id}` : '#/properties'}">Cancel</a><button class="btn primary" type="submit" id="p-save">${id ? 'Save changes' : 'Save property'}</button></div></form>`
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
      const res = id ? await api(`/api/properties/${id}`, { method: 'PATCH', body: { property } }) : await api('/api/properties', { method: 'POST', body: { property } })
      toast(`Saved. ${res.matching.matched} matching buyer${res.matching.matched === 1 ? '' : 's'}${res.matching.newMatches ? ` (${res.matching.newMatches} new)` : ''}.`)
      location.hash = `#/properties/${res.property.id}`
    } catch (error) {
      showFieldErrors(form, error.details?.fields)
      document.getElementById('p-notice').innerHTML = `<div class="notice err">${esc(error.message)} Nothing was saved.</div>`
    } finally {
      busy = false
      btn.disabled = false
    }
  })
}

async function renderLeadMatches(lead, box) {
  try {
    const { matches } = await api(`/api/leads/${lead.id}/matches`)
    box.innerHTML = matches.length
      ? `<ul class="timeline">${matches.slice(0, 5).map((m) => `<li><a href="#/properties/${m.property.id}"><strong>${esc(m.property.title)}</strong></a>${sampleBadge(m.property)} <span class="badge">${m.score}/100</span>
          <div class="small">${esc(priceText(m.property))} · ${esc([m.property.locality, m.property.city].filter(Boolean).join(', '))}</div>
          <ul class="small">${m.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}${m.gaps.map((g) => `<li class="muted">Unknown: ${esc(g)}</li>`).join('')}</ul></li>`).join('')}</ul>`
      : `<p class="muted">${['buyer', 'tenant'].includes(lead.customer_type) ? 'No available listing fits this lead’s saved needs.' : 'Matching applies to buyers and tenants.'}</p>`
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

async function renderFollowupPanel(lead, box) {
  let data
  try {
    data = await api(`/api/leads/${lead.id}/followups`)
  } catch (error) {
    box.innerHTML = `<div class="notice err">${esc(error.message)}</div>`
    return
  }
  const history = data.followups.length ? `<h3 style="margin-top:1rem">Sent and attempted</h3><ul class="timeline">${data.followups.map((f) => `<li>${FOLLOWUP_STATUS[f.status] || esc(f.status)} <strong>${esc(f.subject)}</strong>
      <div class="small muted">to ${esc(f.recipient)} · ${esc(fmtDateTime(f.sentAt || f.createdAt))}${f.userName ? ` · by ${esc(f.userName)}` : ''}</div>
      ${f.status === 'sent' && f.result ? `<div class="small">Gmail message id <span class="code">${esc(f.result.messageId)}</span>${f.result.labelIds?.length ? ` · labels ${esc(f.result.labelIds.join(', '))}` : ''}</div>` : ''}
      ${f.error ? `<div class="small" style="color:var(--danger)">${esc(f.error)}</div>` : ''}</li>`).join('')}</ul>` : ''

  if (!data.viasocket) { box.innerHTML = `<div class="notice warn">viaSocket is not configured on this server, so emails cannot be sent.</div>${history}`; return }
  if (!data.recipient) { box.innerHTML = `<div class="notice info">This lead has no email address. <a href="#/leads/${lead.id}/edit">Add one</a> to send a follow-up.</div>${history}`; return }
  if (!data.connections.length) { box.innerHTML = `<div class="notice info">Connect your Gmail first: <a href="#/integrations">Integrations → Connect Gmail</a>.</div>${history}`; return }

  box.innerHTML = `
    <form id="fu-form" class="stack" novalidate>
      <div class="field"><label>To</label><input value="${esc(data.recipient)}" readonly aria-readonly="true"><div class="hint">From the lead’s saved email. Edit the lead to change it.</div></div>
      <div class="form-grid">
        <div class="field"><label for="fu-conn">Send with</label><select id="fu-conn" name="connectionId">${data.connections.map((c) => `<option value="${c.id}">${esc(c.label || c.appName)}</option>`).join('')}</select></div>
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
    const body = { connectionId: Number(form.elements.connectionId.value), from: form.elements.from.value || null, subject: form.elements.subject.value, body: form.elements.body.value }
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

// ---------- router ----------
async function route() {
  if (currentEmbed) { try { currentEmbed.destroy() } catch { /* already gone */ } currentEmbed = null }
  if (session.mode === 'locked') return renderLocked()
  if (!session.user) return renderLogin()
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
    else if (section === 'properties' && parts[1] === 'new') await renderPropertyForm(null)
    else if (section === 'properties' && parts[1] && parts[2] === 'edit') await renderPropertyForm(parts[1])
    else if (section === 'properties' && parts[1]) await renderPropertyDetail(parts[1])
    else if (section === 'properties') await renderProperties(params)
    else if (section === 'integrations') await renderIntegrations()
    else if (section === 'automations') await renderAutomations()
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
