import { api, busy, date, errorText, field, formData, h, inr, mount, openDrawer, sampleBadge, select, showIssues, statusBadge, toast } from '../lib.js'
import { draftCard, sampleBanner } from './shared.js'

const dueText = (r) => {
  if (r.bucket === 'paid') return 'paid'
  if (r.days_until_due < 0) return `${-r.days_until_due} day${r.days_until_due === -1 ? '' : 's'} past due`
  if (r.days_until_due === 0) return 'due today'
  return `in ${r.days_until_due} day${r.days_until_due === 1 ? '' : 's'}`
}

export async function openReminder(record, { onChange } = {}) {
  const drawer = openDrawer(h('p', { class: 'muted' }, 'Preparing reminder…'))
  try {
    const [{ message }, status] = await Promise.all([api(`/rent/${record.id}/reminder`, { method: 'POST' }), api('/status')])
    drawer.render(h('div', { class: 'stack' },
      h('h1', {}, `Reminder for ${record.tenant_name}`),
      h('p', { class: 'small muted' }, 'Written only from this rent record. Review it before sending.'),
      record.bucket === 'needs_verification' ? h('div', { class: 'banner info' }, 'This record has no payment status. Check whether the tenant has paid before sending a reminder.') : null,
      draftCard(message, { gmailReady: status.integrations.gmail, onSent: onChange })))
  } catch (e) {
    drawer.render(h('div', { class: 'banner danger' }, errorText(e)))
  }
}

export function rentTable(records, { onChange } = {}) {
  if (!records.length) return h('div', { class: 'empty' }, 'No rent records in this view.')
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['Tenant', 'Property', 'Amount', 'Due', 'Payment', 'Last payment', 'Reminder', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, records.map((r) => h('tr', {},
      h('td', {}, h('div', { class: 'row' }, h('strong', {}, r.tenant_name), r.is_sample ? sampleBadge() : null)),
      h('td', { class: 'small' }, r.property_label),
      h('td', {}, inr(r.amount)),
      h('td', { class: 'small' }, date(r.due_date), h('br'), h('span', { class: 'muted' }, dueText(r))),
      h('td', {}, statusBadge(r.bucket), h('div', { class: 'small muted' }, `recorded: ${r.payment_status}`)),
      h('td', { class: 'small' }, r.last_payment_date ? `${inr(r.last_payment_amount)} on ${date(r.last_payment_date)}` : 'none recorded'),
      h('td', {}, statusBadge(r.reminder_status === 'none' ? 'no_reminder' : r.reminder_status)),
      h('td', {}, r.bucket === 'paid' ? null : h('div', { class: 'row' },
        h('button', { class: 'small', onclick: () => openReminder(r, { onChange }) }, 'Reminder'),
        h('button', { class: 'small ghost', onclick: () => editRent(r, { onChange }) }, 'Edit'))))))))
}

function rentForm(record = {}, { onSaved }) {
  const submit = h('button', { class: 'primary', type: 'submit' }, record.id ? 'Save' : 'Add record')
  const notice = h('div')
  const form = h('form', { class: 'form-grid', novalidate: true },
    field('Tenant name *', h('input', { name: 'tenant_name', value: record.tenant_name })),
    field('Tenant email', h('input', { name: 'tenant_email', type: 'email', value: record.tenant_email }), { hint: 'Needed to email a reminder.' }),
    field('Tenant phone', h('input', { name: 'tenant_phone', value: record.tenant_phone })),
    field('Property *', h('input', { name: 'property_label', value: record.property_label, placeholder: 'Flat 302, Green Valley' })),
    field('Rent amount (₹) *', h('input', { name: 'amount', type: 'number', min: 1, value: record.amount })),
    field('Due date *', h('input', { name: 'due_date', type: 'date', value: record.due_date })),
    field('Payment status', select('payment_status', [['unknown', 'Unknown'], ['unpaid', 'Unpaid'], ['partial', 'Partly paid'], ['paid', 'Paid']], record.payment_status || 'unknown'),
      { hint: 'Only mark paid or unpaid when you have checked.' }),
    field('Last payment date', h('input', { name: 'last_payment_date', type: 'date', value: record.last_payment_date })),
    field('Last payment amount (₹)', h('input', { name: 'last_payment_amount', type: 'number', min: 0, value: record.last_payment_amount })),
    field('Notes', h('textarea', { name: 'notes', rows: 2 }, record.notes || ''), { full: true }),
    h('div', { class: 'full' }, notice),
    h('div', { class: 'full' }, submit))
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const data = formData(form)
    mount(notice)
    busy(submit, (async () => {
      try {
        await api(record.id ? `/rent/${record.id}` : '/rent', { method: record.id ? 'PATCH' : 'POST', body: data })
        toast('Rent record saved.')
        onSaved()
      } catch (e) {
        showIssues(form, e.data?.issues)
        mount(notice, h('div', { class: 'banner danger' }, errorText(e)))
      }
    })())
  })
  return form
}

function editRent(record, { onChange }) {
  const drawer = openDrawer(h('div', { class: 'stack' }, h('h1', {}, record.id ? 'Edit rent record' : 'New rent record'),
    rentForm(record, { onSaved: () => { drawer.close(); onChange?.() } })))
}

export async function renderRent(container, ctx) {
  const windowSelect = select('window', [['7', 'Next 7 days'], ['14', 'Next 14 days'], ['30', 'Next 30 days']], '7', { 'aria-label': 'Due window' })
  const body = h('div', { class: 'stack' })
  async function load() {
    const { records, today } = await api(`/rent?window=${windowSelect.value}`)
    const group = (bucket) => records.filter((r) => r.bucket === bucket)
    const samples = records.some((r) => r.is_sample)
    mount(body,
      samples ? sampleBanner('Records marked “Sample” are demonstration data, not real tenants or payments.') : null,
      h('div', { class: 'grid cols-4' },
        [['overdue', 'Overdue'], ['due_soon', 'Due soon'], ['needs_verification', 'Status unknown'], ['paid', 'Recorded paid']].map(([bucket, label]) =>
          h('div', { class: 'card stat' }, h('span', { class: 'muted small' }, label), h('span', { class: 'value' }, group(bucket).length)))),
      h('p', { class: 'small muted' }, `Today is ${date(today)}. “Status unknown” means no payment status is recorded, so DealSaathi does not treat it as overdue.`),
      h('div', { class: 'card' }, h('h2', { style: { marginBottom: '10px' } }, 'Needs attention'),
        rentTable([...group('overdue'), ...group('due_soon'), ...group('needs_verification')], { onChange: load })),
      h('div', { class: 'card' }, h('h2', { style: { marginBottom: '10px' } }, 'All records'), rentTable(records, { onChange: load })))
  }
  windowSelect.addEventListener('change', load)
  mount(container,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Rent tracking'), h('p', { class: 'muted' }, 'Upcoming and overdue rent, from the records you keep here.')),
      h('div', { class: 'row' }, windowSelect, h('button', { class: 'primary', onclick: () => editRent({}, { onChange: load }) }, '+ Rent record'))),
    body)
  await load()
}
