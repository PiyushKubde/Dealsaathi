// Small DOM and API helpers. Text always goes in through textContent, never innerHTML,
// so names, notes and AI output cannot inject markup.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') el.className = value
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value)
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value)
    else if (key === 'value') el.value = value
    else if (value === true) el.setAttribute(key, '')
    else el.setAttribute(key, value)
  }
  append(el, children)
  return el
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue
    el.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
}

export function mount(target, ...children) {
  target.replaceChildren()
  append(target, children)
}

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message)
    this.status = status
    this.data = data
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  let response
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: { 'X-DealSaathi': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin'
    })
  } catch {
    throw new ApiError('Could not reach the DealSaathi server. Check your connection.', 0, {})
  }
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login') window.dispatchEvent(new Event('ds:unauthenticated'))
    throw new ApiError(data.error || `Request failed (${response.status}).`, response.status, data)
  }
  return data
}

export function toast(message, kind = 'info') {
  const el = h('div', { class: `toast ${kind}` }, message)
  document.getElementById('toasts').append(el)
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 4000)
}

export function errorText(error) {
  const issues = error?.data?.issues
  if (issues?.length) return `${error.message} ${issues.map((i) => `${labelFor(i.field)} ${i.message}`).join('; ')}.`
  return error?.message || String(error)
}

const FIELD_LABELS = {
  full_name: 'Name', email: 'Email', phone: 'Phone', category: 'Category', budget_min: 'Min budget', budget_max: 'Max budget',
  start_date: 'Date', start_time: 'Time', lead_id: 'Lead', property_id: 'Property', tenant_name: 'Tenant', property_label: 'Property',
  amount: 'Amount', due_date: 'Due date', time_zone: 'Time zone', title: 'Title', price: 'Price', city: 'City', subject: 'Subject', body: 'Message'
}
export const labelFor = (field) => FIELD_LABELS[field] || field || ''

export function inr(value) {
  if (value === null || value === undefined || value === '') return '—'
  const n = Number(value)
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2).replace(/\.?0+$/, '')} Cr`
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2).replace(/\.?0+$/, '')} L`
  return `₹${n.toLocaleString('en-IN')}`
}

export function budget(min, max) {
  if (min == null && max == null) return '—'
  if (min == null) return `up to ${inr(max)}`
  if (max == null) return `from ${inr(min)}`
  return `${inr(min)} – ${inr(max)}`
}

export function date(iso) {
  if (!iso) return '—'
  const d = iso.length === 10 ? new Date(`${iso}T00:00:00`) : new Date(iso)
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function dateTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
}

export const humanize = (value) => String(value || '').replace(/_/g, ' ')

export function badge(text, kind = '') {
  return h('span', { class: `badge ${kind}` }, text)
}

export const sampleBadge = () => h('span', { class: 'badge sample', title: 'Demonstration record, not real data' }, 'Sample')

const STATUS_KIND = {
  new: 'info', contacted: 'primary', interested: 'primary', viewing_scheduled: 'primary', negotiating: 'warn', won: 'ok', lost: '',
  proposed: 'warn', booking: 'info', booked: 'ok', booking_unverified: 'warn', booking_failed: 'danger', cancelled: '', completed: 'ok',
  draft: '', sending: 'info', sent: 'ok', unconfirmed: 'warn', failed: 'danger',
  overdue: 'danger', due_soon: 'warn', needs_verification: 'info', paid: 'ok', later: '',
  succeeded: 'ok', executing: 'info'
}
const STATUS_TEXT = {
  booking_unverified: 'booking not confirmed', booking_failed: 'booking failed', proposed: 'proposed · not booked',
  unconfirmed: 'sent · not confirmed', due_soon: 'due soon', needs_verification: 'status unknown', no_reminder: 'none yet'
}
export const statusBadge = (status) => badge(STATUS_TEXT[status] || humanize(status), STATUS_KIND[status] || '')

export function confirmDialog({ title, body, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const close = (value) => {
      wrap.remove()
      resolve(value)
    }
    const confirmBtn = h('button', { class: danger ? 'danger' : 'primary', onclick: () => close(true) }, confirmLabel)
    const wrap = h('div', { class: 'dialog-wrap', role: 'dialog', 'aria-modal': 'true', onclick: (e) => e.target === wrap && close(false) },
      h('div', { class: 'dialog' },
        h('h2', {}, title),
        typeof body === 'string' ? h('p', { class: 'muted' }, body) : body,
        h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, h('button', { onclick: () => close(false) }, 'Cancel'), confirmBtn)
      )
    )
    wrap.addEventListener('keydown', (e) => e.key === 'Escape' && close(false))
    document.body.append(wrap)
    confirmBtn.focus()
  })
}

export function openDrawer(content) {
  const close = () => {
    overlay.remove()
    document.removeEventListener('keydown', onKey)
  }
  const onKey = (e) => e.key === 'Escape' && close()
  const drawer = h('div', { class: 'drawer', role: 'dialog', 'aria-modal': 'true' })
  const overlay = h('div', { class: 'overlay', onclick: (e) => e.target === overlay && close() }, drawer)
  document.addEventListener('keydown', onKey)
  document.body.append(overlay)
  const render = (...children) => mount(drawer, h('div', { class: 'row between', style: { marginBottom: '14px' } },
    h('span'), h('button', { class: 'ghost small', onclick: close, 'aria-label': 'Close' }, 'Close ✕')), ...children)
  render(content)
  return { close, render, el: drawer }
}

/** Reads a form's named controls into an object; empty strings become null. */
export function formData(form) {
  const out = {}
  for (const el of form.elements) {
    if (!el.name) continue
    if (el.type === 'checkbox') out[el.name] = el.checked
    else out[el.name] = el.value.trim() === '' ? null : el.value.trim()
  }
  return out
}

/** Shows field-level validation messages next to the matching controls. */
export function showIssues(form, issues = []) {
  form.querySelectorAll('.field-error').forEach((el) => el.remove())
  for (const issue of issues) {
    const control = issue.field && form.elements[issue.field.split('.')[0]]
    const holder = control?.closest('label')
    if (holder) holder.append(h('span', { class: 'field-error' }, issue.message))
  }
}

export function field(label, control, { full = false, hint } = {}) {
  return h('label', { class: full ? 'full' : '' }, label, control, hint ? h('span', { class: 'small muted' }, hint) : null)
}

export function select(name, options, value, attrs = {}) {
  return h('select', { name, ...attrs }, options.map((o) => {
    const [v, text] = Array.isArray(o) ? o : [o, humanize(o)]
    return h('option', { value: v, selected: String(v) === String(value ?? '') }, text)
  }))
}

export function busy(button, promise) {
  const original = [...button.childNodes]
  button.disabled = true
  button.replaceChildren(h('span', { class: 'spinner' }), ' Working…')
  return promise.finally(() => {
    button.disabled = false
    button.replaceChildren(...original)
  })
}

export const ICONS = {
  dashboard: 'M3 13h8V3H3zm0 8h8v-6H3zm10 0h8V11h-8zm0-18v6h8V3z',
  assistant: 'M12 3C7 3 3 6.6 3 11c0 2.4 1.2 4.6 3.1 6.1L5 21l4.4-2.2c.8.2 1.7.3 2.6.3 5 0 9-3.6 9-8s-4-8-9-8z',
  leads: 'M16 11a4 4 0 1 0-4-4 4 4 0 0 0 4 4zM8 11a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm8 2c-2.7 0-8 1.3-8 4v3h16v-3c0-2.7-5.3-4-8-4zM8 13c-.3 0-.7 0-1.1.1A4.7 4.7 0 0 1 9 17v3H1v-3c0-2.2 4.4-4 7-4z',
  viewings: 'M7 2v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2zm-2 8h14v10H5z',
  properties: 'M12 3 2 11h3v9h6v-6h2v6h6v-9h3z',
  rent: 'M4 4h16v16H4zm4 4v2h8V8zm0 4v2h5v-2z',
  integrations: 'M10 3v4H8V3H6v4a4 4 0 0 0 3 3.9V14h2v-3.1A4 4 0 0 0 14 7V3h-2v4h-2zm3 13v5h-2v-5a5 5 0 0 1-4-4h2a3 3 0 0 0 6 0h2a5 5 0 0 1-4 4z'
}

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', ICONS[name])
  path.setAttribute('fill', 'currentColor')
  svg.append(path)
  return svg
}
