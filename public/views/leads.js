import {
  api, budget, busy, date, errorText, field, formData, h, humanize, mount, openDrawer, sampleBadge, select, showIssues, statusBadge, toast
} from '../lib.js'
import { draftCard } from './shared.js'

const CATEGORIES = ['buyer', 'seller', 'tenant', 'landlord']
const STATUSES = ['new', 'contacted', 'interested', 'viewing_scheduled', 'negotiating', 'won', 'lost']

export function leadForm(lead = {}, { onSaved } = {}) {
  const isEdit = Boolean(lead.id)
  const submit = h('button', { class: 'primary', type: 'submit' }, isEdit ? 'Save changes' : 'Add lead')
  const notice = h('div')
  const form = h('form', { class: 'form-grid', novalidate: true },
    field('Full name *', h('input', { name: 'full_name', value: lead.full_name, required: true, maxlength: 120 })),
    field('Category *', select('category', [['', 'Choose…'], ...CATEGORIES], lead.category)),
    field('Email', h('input', { name: 'email', type: 'email', value: lead.email })),
    field('Phone', h('input', { name: 'phone', type: 'tel', value: lead.phone }), { hint: 'Email or phone is required.' }),
    field('Lead source', h('input', { name: 'source', value: lead.source, placeholder: 'Website, referral, 99acres…' })),
    field('Status', select('status', STATUSES, lead.status || 'new')),
    field('Property interest', h('input', { name: 'property_interest', value: lead.property_interest, placeholder: '2BHK apartment' })),
    field('Preferred location', h('input', { name: 'preferred_location', value: lead.preferred_location, placeholder: 'Baner, Pune' })),
    field('Min budget (₹)', h('input', { name: 'budget_min', type: 'number', min: 0, value: lead.budget_min })),
    field('Max budget (₹)', h('input', { name: 'budget_max', type: 'number', min: 0, value: lead.budget_max })),
    field('Assigned broker', h('input', { name: 'assigned_broker', value: lead.assigned_broker })),
    field('Notes', h('textarea', { name: 'notes', rows: 3 }, lead.notes || ''), { full: true }),
    h('div', { class: 'full' }, notice),
    h('div', { class: 'full row' }, submit)
  )
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const data = formData(form)
    if (data.category === null) delete data.category
    mount(notice)
    busy(submit, (async () => {
      try {
        const saved = isEdit
          ? (await api(`/leads/${lead.id}`, { method: 'PATCH', body: data })).lead
          : (await api('/leads', { method: 'POST', body: data })).lead
        showIssues(form, [])
        toast(isEdit ? 'Lead updated.' : `Lead #${saved.id} saved.`)
        onSaved?.(saved)
      } catch (e) {
        showIssues(form, e.data?.issues)
        mount(notice, h('div', { class: 'banner danger' }, h('div', {}, errorText(e),
          e.data?.existing ? h('div', {}, h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); openLead(e.data.existing.id) } }, `Open ${e.data.existing.full_name}`)) : null)))
      }
    })())
  })
  return form
}

export async function openLead(id, { onChange } = {}) {
  const drawer = openDrawer(h('div', { class: 'row muted' }, h('span', { class: 'spinner' }), 'Loading lead…'))
  const status = await api('/status')
  async function load() {
    const { lead, messages, viewings } = await api(`/leads/${id}`)
    const purpose = h('input', { placeholder: 'What is it about? e.g. new 2BHK listings in Baner', maxlength: 300 })
    const draftBtn = h('button', { class: 'small', disabled: !status.ai.available }, 'Draft with AI')
    const draftArea = h('div', { class: 'stack' })
    draftBtn.onclick = () => busy(draftBtn, (async () => {
      try {
        const { message } = await api(`/leads/${lead.id}/followup-draft`, { method: 'POST', body: { purpose: purpose.value } })
        mount(draftArea, draftCard(message, { gmailReady: status.integrations.gmail, onSent: load }))
      } catch (e) {
        toast(errorText(e), 'error')
      }
    })())
    const manual = h('button', { class: 'small ghost', onclick: async () => {
      try {
        const { message } = await api('/messages', { method: 'POST', body: { kind: 'lead_followup', lead_id: lead.id, subject: `Following up, ${lead.full_name.split(' ')[0]}`, body: `Hi ${lead.full_name.split(' ')[0]},\n\n` } })
        mount(draftArea, draftCard(message, { gmailReady: status.integrations.gmail, onSent: load }))
      } catch (e) {
        toast(errorText(e), 'error')
      }
    } }, 'Write it myself')

    drawer.render(
      h('div', { class: 'stack' },
        h('div', { class: 'row' }, h('h1', {}, lead.full_name), statusBadge(lead.status), lead.is_sample ? sampleBadge() : null),
        h('p', { class: 'muted small' }, `Lead #${lead.id} · ${humanize(lead.category)} · added ${date(lead.created_at)} · updated ${date(lead.updated_at)}`),
        h('div', { class: 'card' }, h('h2', { style: { marginBottom: '12px' } }, 'Details'), leadForm(lead, { onSaved: () => { onChange?.(); load() } })),
        h('div', { class: 'card stack' },
          h('h2', {}, 'Follow-up'),
          status.ai.available ? null : h('p', { class: 'small muted' }, 'AI drafting needs viaSocket to be configured. You can still write a draft yourself.'),
          h('div', { class: 'row' }, purpose, draftBtn, manual),
          draftArea),
        h('div', { class: 'card stack' },
          h('h2', {}, 'Follow-up history'),
          messages.length
            ? messages.map((m) => draftCard(m, { gmailReady: status.integrations.gmail, onSent: load }))
            : h('div', { class: 'empty' }, 'No follow-ups yet.')),
        h('div', { class: 'card stack' },
          h('h2', {}, 'Viewings'),
          viewings.length
            ? h('div', { class: 'list' }, viewings.map((v) => h('div', { class: 'list-item' },
                h('div', {}, h('div', { class: 'title' }, v.property_title || v.property_label), h('div', { class: 'small muted' }, `${date(v.start_date)} at ${v.start_time} (${v.time_zone})`)),
                statusBadge(v.status))))
            : h('div', { class: 'empty' }, 'No viewings for this lead.'))
      )
    )
  }
  try {
    await load()
  } catch (e) {
    drawer.render(h('div', { class: 'banner danger' }, errorText(e)))
  }
}

export async function renderLeads(container, ctx) {
  const q = h('input', { type: 'search', placeholder: 'Search name, email, phone, location…', 'aria-label': 'Search leads' })
  const status = select('status', [['', 'All statuses'], ...STATUSES], '', { 'aria-label': 'Filter by status' })
  const category = select('category', [['', 'All categories'], ...CATEGORIES], '', { 'aria-label': 'Filter by category' })
  const tableHolder = h('div')

  async function load() {
    const params = new URLSearchParams()
    if (q.value.trim()) params.set('q', q.value.trim())
    if (status.value) params.set('status', status.value)
    if (category.value) params.set('category', category.value)
    const { leads } = await api(`/leads?${params}`)
    mount(tableHolder, leads.length
      ? h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Name', 'Contact', 'Category', 'Interest', 'Budget', 'Status', 'Broker', 'Updated'].map((t) => h('th', {}, t)))),
          h('tbody', {}, leads.map((lead) => h('tr', { class: 'clickable', tabindex: 0, onclick: () => openLead(lead.id, { onChange: load }), onkeydown: (e) => e.key === 'Enter' && openLead(lead.id, { onChange: load }) },
            h('td', {}, h('div', { class: 'row' }, h('strong', {}, lead.full_name), lead.is_sample ? sampleBadge() : null)),
            h('td', { class: 'small' }, lead.email || '', lead.email && lead.phone ? h('br') : null, lead.phone || ''),
            h('td', {}, humanize(lead.category)),
            h('td', { class: 'small' }, [lead.property_interest, lead.preferred_location].filter(Boolean).join(' · ') || '—'),
            h('td', { class: 'small' }, budget(lead.budget_min, lead.budget_max)),
            h('td', {}, statusBadge(lead.status)),
            h('td', { class: 'small' }, lead.assigned_broker || '—'),
            h('td', { class: 'small muted' }, date(lead.updated_at)))))))
      : h('div', { class: 'empty' }, q.value || status.value || category.value ? 'No leads match these filters.' : 'No leads yet. Add one, or ask the assistant: “Add Rahul Sharma as a new buyer lead”.'))
  }

  let timer
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250) })
  status.addEventListener('change', load)
  category.addEventListener('change', load)

  const newLead = () => {
    const drawer = openDrawer(h('div', { class: 'stack' }, h('h1', {}, 'New lead'), leadForm({}, { onSaved: (lead) => { drawer.close(); load(); openLead(lead.id, { onChange: load }) } })))
  }

  mount(container,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Leads'), h('p', { class: 'muted' }, 'Every buyer, seller, tenant and landlord you are working with.')),
      h('div', { class: 'row' }, h('button', { onclick: () => ctx.navigate('assistant') }, 'Ask the assistant'), h('button', { class: 'primary', onclick: newLead }, '+ New lead'))),
    h('div', { class: 'card' }, h('div', { class: 'toolbar' }, q, status, category), tableHolder)
  )
  await load()
}
