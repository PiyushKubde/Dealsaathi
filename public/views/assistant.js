import { api, badge, budget, busy, date, errorText, h, humanize, inr, mount, sampleBadge, statusBadge, toast } from '../lib.js'
import { openLead } from './leads.js'
import { propertyResultCard } from './properties.js'
import { rentTable } from './rent.js'
import { draftCard, notConfiguredBanner } from './shared.js'
import { viewingCard } from './viewings.js'

const SUGGESTIONS = [
  'Add Rahul Sharma as a new buyer lead, phone 98765 43210, looking for a 2BHK in Baner under 50 lakh',
  'Draft a follow-up email for Rahul Sharma about new listings in Baner',
  'Schedule a property visit for Rahul Sharma tomorrow at 4 PM at the Baner 2BHK',
  'Find properties under ₹50 lakh in Pune with two bedrooms',
  'Show me rent payments that are due this week'
]

const INTENT_LABEL = {
  create_lead: 'Lead management · new lead', update_lead: 'Lead management · update', find_leads: 'Lead management · search',
  draft_followup: 'Lead follow-up', schedule_viewing: 'Viewing scheduling', match_properties: 'Property matching',
  rent_due: 'Rent reminders', clarify: 'Needs clarification', unsupported: 'Not supported'
}

const LEAD_LABELS = {
  full_name: 'Name', email: 'Email', phone: 'Phone', category: 'Category', source: 'Source', property_interest: 'Interest',
  preferred_location: 'Location', budget_min: 'Min budget', budget_max: 'Max budget', status: 'Status', assigned_broker: 'Broker', notes: 'Notes'
}

const show = (key, value) => (key.startsWith('budget') ? inr(value) : Array.isArray(value) ? value.join(', ') : humanize(value))

function kv(entries) {
  const rows = entries.filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))
  if (!rows.length) return null
  return h('dl', { class: 'kv small' }, rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))
}

function extractedCard(extracted) {
  const entries = []
  if (extracted.lead) for (const [k, v] of Object.entries(extracted.lead)) entries.push([LEAD_LABELS[k] || k, show(k, v)])
  if (extracted.changes) for (const [k, v] of Object.entries(extracted.changes)) entries.push([`New ${LEAD_LABELS[k] || k}`, show(k, v)])
  if (extracted.lead_reference) entries.push(['Lead', extracted.lead_reference])
  if (extracted.purpose) entries.push(['Purpose', extracted.purpose])
  if (extracted.viewing) {
    const v = extracted.viewing
    entries.push(['Property', v.property_reference], ['Date', v.date && date(v.date)], ['Time', v.time], ['Duration', v.duration_minutes && `${v.duration_minutes} min`], ['Time zone', v.time_zone])
  }
  if (extracted.criteria) {
    const c = extracted.criteria
    entries.push(['City', c.city], ['Locality', c.locality], ['Buy / rent', c.listing_type && humanize(c.listing_type)], ['Type', c.property_type],
      ['Budget', c.budget_min != null || c.budget_max != null ? budget(c.budget_min, c.budget_max) : null], ['Bedrooms', c.bedrooms], ['Amenities', c.amenities])
  }
  if (extracted.filters) entries.push(['Search', extracted.filters.q], ['Status', extracted.filters.status], ['Category', extracted.filters.category])
  if (extracted.window_days != null) entries.push(['Window', `next ${extracted.window_days} days`])
  const body = kv(entries)
  return body ? h('div', { class: 'card stack tight' }, h('h3', {}, 'What I understood'), body) : null
}

function actionCard(action, outcome, status, onDone) {
  const card = h('div', { class: 'card stack' })
  function render(current) {
    const p = current.payload
    const title = { create_lead: 'Create lead', update_lead: 'Update lead', schedule_viewing: 'Save viewing proposal' }[current.type]
    let details
    if (current.type === 'create_lead') details = kv(Object.entries(p.lead).map(([k, v]) => [LEAD_LABELS[k] || k, show(k, v)]))
    else if (current.type === 'update_lead') {
      details = h('div', { class: 'stack tight' },
        h('p', { class: 'small' }, `Lead: ${outcome.existing?.full_name || `#${p.lead_id}`} (#${p.lead_id})`),
        kv(Object.entries(p.changes).map(([k, v]) => [LEAD_LABELS[k] || k, `${outcome.existing?.[k] != null ? `${show(k, outcome.existing[k])} → ` : ''}${show(k, v)}`])) ||
          h('p', { class: 'small muted' }, 'No field changes.'))
    } else if (current.type === 'schedule_viewing') {
      details = kv([['Lead', outcome.preview?.lead], ['Property', outcome.preview?.property], ['Date', date(p.start_date)], ['Time', `${p.start_time} (${p.time_zone})`], ['Duration', `${p.duration_minutes} min`], ['Notes', p.notes]])
    }
    const confirm = h('button', { class: 'primary small' }, 'Confirm')
    const cancel = h('button', { class: 'small ghost' }, 'Cancel')
    confirm.onclick = () => busy(confirm, (async () => {
      try {
        const result = await api(`/actions/${current.id}/confirm`, { method: 'POST' })
        toast('Done.')
        render({ ...current, status: 'succeeded', result: result.result })
        onDone?.()
      } catch (e) {
        toast(errorText(e), 'error')
        render({ ...current, status: e.data?.code === 'already_handled' ? e.data.action?.status || current.status : 'failed', error: errorText(e) })
      }
    })())
    cancel.onclick = async () => {
      try {
        await api(`/actions/${current.id}/cancel`, { method: 'POST' })
        render({ ...current, status: 'cancelled' })
      } catch (e) {
        toast(errorText(e), 'error')
      }
    }
    let resultView = null
    if (current.status === 'succeeded' && current.result?.lead) {
      const lead = current.result.lead
      resultView = h('div', { class: 'banner info' }, h('div', {}, h('strong', {}, `Saved: ${lead.full_name} (#${lead.id})`),
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); openLead(lead.id) } }, 'Open lead')))
    } else if (current.status === 'succeeded' && current.result?.viewing) {
      resultView = viewingCard(current.result.viewing, { status })
    } else if (current.status === 'failed') {
      resultView = h('div', { class: 'banner danger' }, h('div', {}, h('strong', {}, 'Not completed'), current.error || 'The action failed. Nothing was saved.'))
    }
    mount(card,
      h('div', { class: 'row between' }, h('h3', {}, title), statusBadge(current.status === 'proposed' ? 'awaiting confirmation' : current.status)),
      outcome.preview?.property_is_sample ? h('p', { class: 'small' }, sampleBadge(), ' This viewing is for a sample listing.') : null,
      details,
      current.status === 'proposed' ? h('div', { class: 'row' }, confirm, cancel) : null,
      resultView)
  }
  render(action)
  return card
}

function resultsView(results, status) {
  if (results.kind === 'leads') {
    return results.items.length
      ? h('div', { class: 'card' }, h('div', { class: 'list' }, results.items.map((l) => h('div', { class: 'list-item clickable', onclick: () => openLead(l.id) },
          h('div', {}, h('div', { class: 'row' }, h('span', { class: 'title' }, l.full_name), l.is_sample ? sampleBadge() : null),
            h('div', { class: 'small muted' }, [humanize(l.category), l.preferred_location, budget(l.budget_min, l.budget_max)].filter(Boolean).join(' · '))),
          statusBadge(l.status)))))
      : null
  }
  if (results.kind === 'properties') {
    return results.items.length ? h('div', { class: 'grid cols-2', style: { width: 'min(760px, 100%)' } }, results.items.map(propertyResultCard)) : null
  }
  if (results.kind === 'rent') {
    return results.items.length ? h('div', { class: 'card', style: { width: 'min(760px, 100%)' } }, rentTable(results.items)) : null
  }
  return null
}

function assistantTurn(content, data, status) {
  const turn = h('div', { class: 'turn' })
  const failed = data?.status === 'failed'
  turn.append(
    data?.extracted?.intent ? h('div', { class: 'status-line' }, badge(INTENT_LABEL[data.extracted.intent] || data.extracted.intent, 'primary'),
      data.status === 'needs_info' ? badge('needs more details', 'warn') : data.status === 'awaiting_confirmation' ? badge('awaiting your confirmation', 'warn') : null) : null,
    h('div', { class: `bubble assistant${failed ? ' error' : ''}` }, content))
  if (data?.extracted) {
    const card = extractedCard(data.extracted)
    // The action card already lists what will be saved; this one is for questions and drafts.
    if (card && !data.action && data.status !== 'completed') turn.append(card)
  }
  if (data?.choices?.length) {
    turn.append(h('div', { class: 'card' }, h('div', { class: 'list' }, data.choices.map((c) => h('div', { class: 'list-item' },
      h('div', {}, h('div', { class: 'title' }, `${c.full_name} (#${c.id})`), h('div', { class: 'small muted' }, [c.email, c.phone].filter(Boolean).join(' · '))),
      h('button', { class: 'small', onclick: () => openLead(c.id) }, 'View'))))))
  }
  if (data?.action) turn.append(actionCard(data.action, data, status))
  if (data?.draft) turn.append(draftCard(data.draft, { gmailReady: status.integrations.gmail }))
  if (data?.results) {
    const view = resultsView(data.results, status)
    if (view) turn.append(view)
  }
  return turn
}

export async function renderAssistant(container, ctx) {
  const status = ctx.status
  let conversationId = sessionStorage.getItem('ds:conversation') || null
  const log = h('div', { class: 'chat-log', 'aria-live': 'polite' })
  const input = h('textarea', { placeholder: status.ai.available ? 'Ask DealSaathi to add a lead, draft a follow-up, schedule a viewing…' : 'The AI assistant is not configured on this server.', 'aria-label': 'Message', disabled: !status.ai.available, maxlength: 2000 })
  const send = h('button', { class: 'primary', type: 'submit', disabled: !status.ai.available }, 'Send')
  const form = h('form', { class: 'chat-input' }, input, send)
  const scroll = () => { log.scrollTop = log.scrollHeight }

  function intro() {
    return h('div', { class: 'turn' },
      h('div', { class: 'bubble assistant' }, 'Hi! Tell me what you need in plain English. I prepare each change for you to review, and nothing is saved, sent or booked until you confirm.'),
      h('div', { class: 'suggestions' }, SUGGESTIONS.map((text) => h('button', { type: 'button', disabled: !status.ai.available, onclick: () => { input.value = text; input.focus() } }, text))))
  }

  async function loadHistory() {
    mount(log, intro())
    if (!conversationId) return
    try {
      const { messages } = await api(`/assistant/conversations/${conversationId}`)
      for (const m of messages) log.append(m.role === 'user' ? h('div', { class: 'bubble user' }, m.content) : assistantTurn(m.content, m.data, status))
      scroll()
    } catch {
      conversationId = null
      sessionStorage.removeItem('ds:conversation')
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const message = input.value.trim()
    if (!message) return
    input.value = ''
    log.append(h('div', { class: 'bubble user' }, message))
    const pending = h('div', { class: 'status-line muted' }, h('span', { class: 'spinner' }), 'Understanding your request…')
    log.append(pending)
    scroll()
    send.disabled = true
    try {
      const outcome = await api('/assistant/message', { method: 'POST', body: { conversationId, message } })
      conversationId = outcome.conversationId
      sessionStorage.setItem('ds:conversation', conversationId)
      pending.replaceWith(assistantTurn(outcome.reply, outcome, status))
    } catch (e) {
      if (e.data?.conversationId) {
        conversationId = e.data.conversationId
        sessionStorage.setItem('ds:conversation', conversationId)
      }
      pending.replaceWith(assistantTurn(errorText(e), { status: 'failed' }, status))
    } finally {
      send.disabled = false
      scroll()
      input.focus()
    }
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      form.requestSubmit()
    }
  })

  mount(container,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'AI Assistant'), h('p', { class: 'muted' }, status.ai.available ? `Powered by ${status.ai.provider} (${status.ai.model}).` : 'Not connected.')),
      h('button', { onclick: () => { conversationId = null; sessionStorage.removeItem('ds:conversation'); loadHistory() } }, 'New conversation')),
    status.ai.available ? null : notConfiguredBanner('The assistant cannot understand requests until it is.'),
    h('div', { class: 'card chat' }, log, form))
  await loadHistory()
  const prefill = sessionStorage.getItem('ds:prefill')
  if (prefill && status.ai.available) {
    sessionStorage.removeItem('ds:prefill')
    input.value = prefill
    form.requestSubmit()
  }
}
