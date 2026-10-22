// Tenancies, monthly rent obligations, payments and reminders.
//
// A due is paid only from (a) Razorpay's own payment-link status read through viaSocket (List Payment Links), or
// (b) a payment the broker records, with a note saying how they verified it. Creating or opening a link never
// counts. Reminders go by Gmail (viaSocket Send Email) at the broker's stages, once each, outside quiet hours.
//
// Create Payment Link V5 inputData, every key decided:
//   link_type "standard" (constant) · amount: what is still owed, in paise (product data) · currency "INR"
//   description, reference_id "ds-rent-<due>-<attempt>" (product data) · add_customer true + customer {name, email,
//   contact} from the tenancy · accept_partial false (one link settles the month) · notes { dealsaathi_due }
//   expiry_mode/expire_by_*, configure_sections, notifications, callback: left out on purpose (DealSaathi sends the
//   reminders itself and verifies by reading the link's status, so no callback is needed)
import { now, transaction } from '../db.js'
import { AppError, validationError } from '../errors.js'
import { getProperty } from '../properties/service.js'
import { gmailInput, readGmailResult, readPaymentLink, readPaymentLinkList, runOnce } from '../integrations/run.js'
import { finishRun, getSetting, startRun, usersWithEnabled } from '../automations/store.js'
import { addDays, daysBetween, todayIn, utcToZoned } from '../time.js'
import { emit } from '../events/bus.js'

/**
 * Razorpay takes real money, so live payment links stay off until the operator has run the real-service checks
 * and sets RAZORPAY_LIVE=1 on the server. Until then rent is verified only by payments recorded by people.
 */
export const paymentsLive = () => process.env.RAZORPAY_LIVE === '1'

export const RENT_TIMEZONE = 'Asia/Kolkata'
const QUIET = { from: 21, to: 9 } // no reminders from 9 pm to 9 am, India time
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const inr = (n) => `₹${Number(n).toLocaleString('en-IN')}`

function event(db, tenancyId, dueId, type, detail, userId = null) {
  db.prepare('INSERT INTO rent_events (tenancy_id, due_id, type, detail, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(tenancyId, dueId, type, detail, userId, now())
}

const validDate = (s) => DATE_RE.test(s || '') && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s

function cleanTenancy(db, input, current = {}) {
  const errors = {}
  const v = { ...current }
  const text = (k, max, required) => {
    if (!(k in input)) return
    const raw = typeof input[k] === 'string' ? input[k].trim() : input[k] == null ? '' : null
    if (raw === null) errors[k] = 'Must be text.'
    else if (!raw) { if (required) errors[k] = 'Required.'; else v[k] = null }
    else if (raw.length > max) errors[k] = `Must be ${max} characters or fewer.`
    else v[k] = raw
  }
  text('tenant_name', 100, true)
  text('tenant_phone', 20)
  text('reference', 60)
  text('notes', 1000)
  text('property_label', 150)
  if ('landlord_email' in input) {
    const e = typeof input.landlord_email === 'string' ? input.landlord_email.trim().toLowerCase() : ''
    if (e && !EMAIL_RE.test(e)) errors.landlord_email = 'Enter a valid email address.'
    else v.landlord_email = e || null
  }
  if ('tenant_email' in input) {
    const e = typeof input.tenant_email === 'string' ? input.tenant_email.trim() : ''
    if (e && !EMAIL_RE.test(e)) errors.tenant_email = 'Enter a valid email address.'
    else v.tenant_email = e || null
  }
  if ('property_id' in input) {
    if (input.property_id == null || input.property_id === '') v.property_id = null
    else {
      const p = getProperty(db, Number(input.property_id))
      if (!p) errors.property_id = 'That property does not exist.'
      else { v.property_id = p.id; if (!input.property_label) v.property_label = p.title }
    }
  }
  if ('rent_amount' in input) {
    const n = Number(input.rent_amount)
    if (!Number.isInteger(n) || n < 1 || n > 100_000_000) errors.rent_amount = 'Enter the monthly rent in whole rupees.'
    else v.rent_amount = n
  }
  if ('due_day' in input) {
    const n = Number(input.due_day)
    if (!Number.isInteger(n) || n < 1 || n > 28) errors.due_day = 'Choose a day from 1 to 28 (every month has it).'
    else v.due_day = n
  }
  for (const k of ['lease_start', 'lease_end']) {
    if (!(k in input)) continue
    if (!input[k]) { if (k === 'lease_start') errors[k] = 'Required.'; else v[k] = null; continue }
    if (!validDate(input[k])) errors[k] = 'Use a real date (YYYY-MM-DD).'
    else v[k] = input[k]
  }
  if ('reminders_opt_out' in input) v.reminders_opt_out = input.reminders_opt_out === true ? 1 : 0
  if (!v.tenant_name) errors.tenant_name ||= 'Required.'
  if (!v.property_label) errors.property_label ||= 'Choose a property or describe it.'
  if (!v.rent_amount) errors.rent_amount ||= 'Required.'
  if (!v.due_day) errors.due_day ||= 'Required.'
  if (!v.lease_start) errors.lease_start ||= 'Required.'
  if (v.lease_start && v.lease_end && v.lease_end < v.lease_start) errors.lease_end = 'The lease cannot end before it starts.'
  if (Object.keys(errors).length) throw validationError(errors)
  return v
}

/**
 * Links the tenancy to the tenant's and landlord's DealSaathi accounts, by the emails the agent entered (a seller
 * listing's owner is its landlord when no landlord email is given). Linked people see the tenancy in the app;
 * they never manage it.
 */
function linkParties(db, id, actorId) {
  const t = db.prepare('SELECT * FROM tenancies WHERE id = ?').get(id)
  const tenant = t.tenant_email ? db.prepare("SELECT id FROM users WHERE email = ? AND role = 'buyer'").get(t.tenant_email.toLowerCase()) : null
  let landlord = t.landlord_email ? db.prepare("SELECT id FROM users WHERE email = ? AND role = 'seller'").get(t.landlord_email) : null
  if (!landlord && !t.landlord_email && t.property_id) landlord = db.prepare("SELECT u.id FROM properties p JOIN users u ON u.id = p.owner_user_id WHERE p.id = ? AND u.role = 'seller'").get(t.property_id)
  const tenantId = tenant?.id ?? null
  const landlordId = landlord?.id ?? null
  if (tenantId === t.tenant_user_id && landlordId === t.landlord_user_id) return
  db.prepare('UPDATE tenancies SET tenant_user_id = ?, landlord_user_id = ? WHERE id = ?').run(tenantId, landlordId, id)
  event(db, id, null, 'parties_linked', `Linked accounts: tenant ${tenantId ? 'linked' : 'not linked'}, landlord ${landlordId ? 'linked' : 'not linked'}`, actorId)
  emit(db, 'tenancy.linked', { subjectType: 'tenancy', subjectId: id, actorId, agentId: t.user_id, payload: { key: `${tenantId}:${landlordId}` }, dedupeKey: `tenancy.linked:${id}:${tenantId}:${landlordId}` })
}

const ownTenancy = (db, userId, id) => {
  const t = db.prepare('SELECT * FROM tenancies WHERE id = ? AND user_id = ?').get(id, userId)
  if (!t) throw new AppError(404, 'tenancy_not_found', 'No such tenancy.')
  return t
}

/** Obligations from the month tracking began up to the next due date ahead. Re-running never duplicates one. */
export function generateDues(db, t, today = todayIn(RENT_TIMEZONE)) {
  if (t.status !== 'active') return 0
  const horizon = addDays(today, 31)
  let [y, m] = t.tracking_from.slice(0, 7).split('-').map(Number)
  let added = 0
  for (let i = 0; i < 36; i++) {
    const period = `${y}-${String(m).padStart(2, '0')}`
    const due = `${period}-${String(t.due_day).padStart(2, '0')}`
    if (due > horizon) break
    if (due >= t.tracking_from && due >= t.lease_start && (!t.lease_end || due <= t.lease_end)) {
      const r = db.prepare('INSERT INTO rent_dues (tenancy_id, period, due_date, amount, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (tenancy_id, period) DO NOTHING')
        .run(t.id, period, due, t.rent_amount, now(), now())
      added += r.changes
    }
    m++; if (m > 12) { m = 1; y++ }
  }
  return added
}

export function createTenancy(db, user, input) {
  const v = cleanTenancy(db, input || {})
  const today = todayIn(RENT_TIMEZONE)
  // Rent is tracked from the month the tenancy is added (or its start, if later): no backlog of past months.
  const trackingFrom = v.lease_start > `${today.slice(0, 7)}-01` ? v.lease_start : `${today.slice(0, 7)}-01`
  return transaction(db, () => {
    const { lastInsertRowid } = db.prepare(`INSERT INTO tenancies (user_id, property_id, property_label, tenant_name, tenant_email, tenant_phone, reference, rent_amount, due_day, lease_start, lease_end, tracking_from, reminders_opt_out, notes, created_at, updated_at)
                                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(user.id, v.property_id ?? null, v.property_label, v.tenant_name, v.tenant_email ?? null, v.tenant_phone ?? null, v.reference ?? null, v.rent_amount, v.due_day, v.lease_start, v.lease_end ?? null, trackingFrom, v.reminders_opt_out ?? 0, v.notes ?? null, now(), now())
    const id = Number(lastInsertRowid)
    event(db, id, null, 'tenancy_created', `Tenancy added: ${v.tenant_name}, ${inr(v.rent_amount)}/month due on day ${v.due_day}`, user.id)
    db.prepare('UPDATE tenancies SET landlord_email = ? WHERE id = ?').run(v.landlord_email ?? null, id)
    linkParties(db, id, user.id)
    generateDues(db, ownTenancy(db, user.id, id), today)
    return tenancyDetail(db, user.id, id)
  })
}

export function updateTenancy(db, user, id, input) {
  const current = ownTenancy(db, user.id, id)
  const v = cleanTenancy(db, input || {}, current)
  const status = input?.status ?? current.status
  if (!['active', 'paused', 'ended'].includes(status)) throw validationError({ status: 'Status must be active, paused or ended.' })
  return transaction(db, () => {
    db.prepare(`UPDATE tenancies SET property_id = ?, property_label = ?, tenant_name = ?, tenant_email = ?, tenant_phone = ?, reference = ?, rent_amount = ?, due_day = ?,
                lease_start = ?, lease_end = ?, status = ?, reminders_opt_out = ?, notes = ?, updated_at = ? WHERE id = ?`)
      .run(v.property_id ?? null, v.property_label, v.tenant_name, v.tenant_email ?? null, v.tenant_phone ?? null, v.reference ?? null, v.rent_amount, v.due_day,
        v.lease_start, v.lease_end ?? null, status, v.reminders_opt_out ?? 0, v.notes ?? null, now(), id)
    if (status !== current.status) event(db, id, null, 'status_changed', `Tenancy ${status === 'active' ? 'reactivated' : status}`, user.id)
    if (v.rent_amount !== current.rent_amount) event(db, id, null, 'rent_changed', `Rent changed from ${inr(current.rent_amount)} to ${inr(v.rent_amount)} (for months not yet generated)`, user.id)
    db.prepare('UPDATE tenancies SET landlord_email = ? WHERE id = ?').run(v.landlord_email ?? null, id)
    linkParties(db, id, user.id)
    generateDues(db, ownTenancy(db, user.id, id))
    return tenancyDetail(db, user.id, id)
  })
}

/** upcoming | due_today | overdue | partially_paid | paid | waived | cancelled */
export function dueState(due, today = todayIn(RENT_TIMEZONE)) {
  if (['paid', 'waived', 'cancelled'].includes(due.status)) return due.status
  const timing = due.due_date > today ? 'upcoming' : due.due_date === today ? 'due_today' : 'overdue'
  return due.status === 'partially_paid' ? (timing === 'upcoming' ? 'partially_paid' : `partially_paid_${timing}`) : timing
}

function duePublic(db, d, today) {
  return {
    id: d.id, period: d.period, dueDate: d.due_date, amount: d.amount, amountPaid: d.amount_paid, outstanding: Math.max(0, d.amount - d.amount_paid),
    status: d.status, state: dueState(d, today), paidAt: d.paid_at, verificationSource: d.verification_source,
    paymentLink: d.payment_link_url ? { url: d.payment_link_url, status: d.payment_link_status } : null, paymentLinkError: d.payment_link_error,
    payments: db.prepare('SELECT amount, paid_on, source, note, created_at FROM rent_payments WHERE due_id = ? ORDER BY created_at').all(d.id),
    reminders: db.prepare('SELECT stage, channel, recipient, status, detail, created_at FROM rent_reminders WHERE due_id = ? ORDER BY created_at').all(d.id)
  }
}

export function tenancyDetail(db, userId, id) {
  const t = ownTenancy(db, userId, id)
  const today = todayIn(RENT_TIMEZONE)
  return {
    tenancy: { ...t, reminders_opt_out: Boolean(t.reminders_opt_out) },
    dues: db.prepare('SELECT * FROM rent_dues WHERE tenancy_id = ? ORDER BY due_date DESC').all(id).map((d) => duePublic(db, d, today)),
    events: db.prepare('SELECT type, detail, created_at FROM rent_events WHERE tenancy_id = ? ORDER BY created_at DESC, id DESC LIMIT 100').all(id)
  }
}

/** Every tenancy of this broker, with its current month and anything outstanding. */
export function rentOverview(db, userId) {
  const today = todayIn(RENT_TIMEZONE)
  const tenancies = db.prepare('SELECT * FROM tenancies WHERE user_id = ? ORDER BY status, tenant_name').all(userId)
  const open = db.prepare(`SELECT d.*, t.tenant_name, t.property_label FROM rent_dues d JOIN tenancies t ON t.id = d.tenancy_id
                           WHERE t.user_id = ? AND d.status IN ('open','partially_paid') ORDER BY d.due_date`).all(userId)
  const items = open.map((d) => ({ ...duePublic(db, d, today), tenancyId: d.tenancy_id, tenantName: d.tenant_name, propertyLabel: d.property_label }))
  return {
    today,
    tenancies: tenancies.map((t) => ({ id: t.id, tenantName: t.tenant_name, propertyLabel: t.property_label, rentAmount: t.rent_amount, dueDay: t.due_day, status: t.status, leaseEnd: t.lease_end, optOut: Boolean(t.reminders_opt_out) })),
    overdue: items.filter((d) => d.state.endsWith('overdue')),
    dueSoon: items.filter((d) => !d.state.endsWith('overdue')),
    totals: { outstanding: items.reduce((a, d) => a + d.outstanding, 0), overdue: items.filter((d) => d.state.endsWith('overdue')).reduce((a, d) => a + d.outstanding, 0) }
  }
}

/** A due the agent manages, or (landlordMay) one on a tenancy where this seller is the linked landlord. */
function partyDue(db, user, dueId, { landlordMay = false } = {}) {
  const d = db.prepare('SELECT d.*, t.user_id, t.tenant_name, t.landlord_user_id FROM rent_dues d JOIN tenancies t ON t.id = d.tenancy_id WHERE d.id = ?').get(dueId)
  const ok = d && ((user.role === 'agent' && d.user_id === user.id) || (landlordMay && user.role === 'seller' && d.landlord_user_id === user.id))
  if (!ok) throw new AppError(404, 'due_not_found', 'No such rent due.')
  return d
}

/** The tenancies a buyer is the tenant of, or a seller the landlord of: what they may see, nothing they may manage. */
export function partyTenancies(db, user) {
  const col = user.role === 'seller' ? 'landlord_user_id' : user.role === 'buyer' ? 'tenant_user_id' : null
  if (!col) throw new AppError(403, 'forbidden', 'Only tenants and landlords have tenancies here.')
  return db.prepare(`SELECT id FROM tenancies WHERE ${col} = ? ORDER BY status, created_at DESC`).all(user.id).map((r) => partyTenancy(db, user, r.id))
}

export function partyTenancy(db, user, id) {
  const col = user.role === 'seller' ? 'landlord_user_id' : 'tenant_user_id'
  const t = db.prepare(`SELECT * FROM tenancies WHERE id = ? AND ${col} = ?`).get(id, user.id)
  if (!t) throw new AppError(404, 'tenancy_not_found', 'No such tenancy.')
  const today = todayIn(RENT_TIMEZONE)
  const agent = db.prepare('SELECT name, email FROM users WHERE id = ?').get(t.user_id)
  const dues = db.prepare('SELECT * FROM rent_dues WHERE tenancy_id = ? ORDER BY due_date DESC LIMIT 24').all(id).map((d) => {
    const p = duePublic(db, d, today)
    return { id: p.id, period: p.period, dueDate: p.dueDate, amount: p.amount, amountPaid: p.amountPaid, outstanding: p.outstanding, state: p.state, verificationSource: p.verificationSource,
      paymentLink: p.paymentLink?.status === 'created' && user.role === 'buyer' ? p.paymentLink : null,
      payments: p.payments.map((x) => ({ amount: x.amount, paidOn: x.paid_on, source: x.source })), canRecord: user.role === 'seller' && ['open', 'partially_paid'].includes(d.status) }
  })
  return { tenancy: { id: t.id, propertyLabel: t.property_label, rentAmount: t.rent_amount, dueDay: t.due_day, leaseStart: t.lease_start, leaseEnd: t.lease_end, status: t.status,
    tenantName: t.tenant_name, agent: agent ? { name: agent.name, email: agent.email } : null, role: user.role === 'seller' ? 'landlord' : 'tenant' }, dues }
}

function ownDue(db, userId, dueId) {
  const d = db.prepare('SELECT d.*, t.user_id, t.tenant_name FROM rent_dues d JOIN tenancies t ON t.id = d.tenancy_id WHERE d.id = ?').get(dueId)
  if (!d || d.user_id !== userId) throw new AppError(404, 'due_not_found', 'No such rent due.')
  return d
}

function applyPayment(db, due, amount, { source, externalId = null, paidOn, userId = null, note = null, recordedBy = 'the broker' }) {
  const total = due.amount_paid + amount
  const status = total >= due.amount ? 'paid' : 'partially_paid'
  db.prepare('INSERT INTO rent_payments (due_id, amount, paid_on, source, external_id, recorded_by, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(due.id, amount, paidOn, source, externalId, userId, note, now())
  const t = db.prepare('SELECT user_id FROM tenancies WHERE id = ?').get(due.tenancy_id)
  emit(db, 'rent.payment_recorded', { subjectType: 'tenancy', subjectId: due.tenancy_id, actorId: userId, agentId: t?.user_id, payload: { dueId: due.id, amount, period: due.period, source, key: `${due.id}:${source}:${externalId ?? now()}` } })
  db.prepare('UPDATE rent_dues SET amount_paid = ?, status = ?, paid_at = ?, verification_source = ?, updated_at = ? WHERE id = ?')
    .run(total, status, status === 'paid' ? now() : null, source, now(), due.id)
  event(db, due.tenancy_id, due.id, source === 'manual' ? 'payment_recorded' : 'payment_verified',
    `${inr(amount)} for ${due.period} ${source === 'manual' ? `recorded by ${recordedBy}${note ? `: ${note}` : ''}` : 'confirmed by Razorpay'}${status === 'paid' ? ' (paid in full)' : ` (${inr(due.amount - total)} still owed)`}`, userId)
  return status
}

/**
 * The broker records a payment they verified themselves (bank statement, receipt). Requires a note saying how;
 * it is kept in the audit trail. An open payment link is cancelled so the tenant cannot pay twice.
 */
export async function recordManualPayment(db, vs, user, dueId, input) {
  const due = partyDue(db, user, dueId, { landlordMay: true })
  if (['paid', 'waived', 'cancelled'].includes(due.status)) throw new AppError(409, 'due_closed', `This rent is already ${due.status}.`)
  const amount = Number(input?.amount)
  const outstanding = due.amount - due.amount_paid
  const errors = {}
  if (!Number.isInteger(amount) || amount < 1) errors.amount = 'Enter the amount received, in whole rupees.'
  else if (amount > outstanding) errors.amount = `That is more than the ${inr(outstanding)} still owed.`
  if (!validDate(input?.paidOn) || input.paidOn > todayIn(RENT_TIMEZONE)) errors.paidOn = 'Enter the date it was received (not in the future).'
  const note = typeof input?.note === 'string' ? input.note.trim().slice(0, 300) : ''
  if (note.length < 5) errors.note = 'Say how you verified it (e.g. “HDFC statement, UTR 1234”).'
  if (Object.keys(errors).length) throw validationError(errors)
  const status = transaction(db, () => applyPayment(db, due, amount, { source: 'manual', paidOn: input.paidOn, userId: user.id, note, recordedBy: user.role === 'seller' ? 'the landlord' : 'the broker' }))
  const agent = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(due.user_id)
  if (status === 'paid' && due.payment_link_id && due.payment_link_status === 'created' && agent) await cancelLink(db, vs, { ...agent }, due, 'Paid by other means')
  return user.role === 'agent' ? tenancyDetail(db, user.id, due.tenancy_id) : partyTenancy(db, user, due.tenancy_id)
}

export async function waiveDue(db, vs, user, dueId, note) {
  const due = ownDue(db, user.id, dueId)
  if (['paid', 'waived', 'cancelled'].includes(due.status)) throw new AppError(409, 'due_closed', `This rent is already ${due.status}.`)
  const reason = typeof note === 'string' ? note.trim().slice(0, 300) : ''
  if (reason.length < 5) throw validationError({ note: 'Say why this month is waived.' })
  transaction(db, () => {
    db.prepare("UPDATE rent_dues SET status = 'waived', updated_at = ? WHERE id = ?").run(now(), due.id)
    event(db, due.tenancy_id, due.id, 'waived', `${due.period} waived by the broker: ${reason}`, user.id)
  })
  if (due.payment_link_id && due.payment_link_status === 'created') await cancelLink(db, vs, user, due, 'Rent waived')
  return tenancyDetail(db, user.id, due.tenancy_id)
}

async function cancelLink(db, vs, user, due, why) {
  const cfg = getSetting(db, user.id, 'rent_reminders').config
  if (!cfg.razorpayConnectionId) return
  const ran = await runOnce(db, vs, user.id, cfg.razorpayConnectionId, 'razorpay_cancel_link', { payment_link_id: due.payment_link_id })
  const ok = ran.outcome === 'answered' && readPaymentLink(ran.result).ok
  db.prepare('UPDATE rent_dues SET payment_link_status = ?, updated_at = ? WHERE id = ?').run(ok ? 'cancelled' : due.payment_link_status, now(), due.id)
  event(db, due.tenancy_id, due.id, ok ? 'link_cancelled' : 'link_cancel_failed', ok ? `Payment link cancelled (${why})` : `Could not cancel the payment link: ${ran.reason || 'Razorpay refused'}. Cancel it in Razorpay.`, user.id)
}

/** Creates the Razorpay link for what is still owed, once per attempt. Returns the link or null. */
async function ensurePaymentLink(db, vs, user, cfg, due, t) {
  if (!cfg.razorpayConnectionId || !paymentsLive()) return null
  if (due.payment_link_id && due.payment_link_status === 'created') return due.payment_link_url
  const attempt = due.link_attempt + 1
  const ref = `ds-rent-${due.id}-${attempt}`
  // Claim the reference first: two runs at once cannot both create a link for this due.
  const claim = db.prepare('UPDATE rent_dues SET link_attempt = ?, payment_link_ref = ?, updated_at = ? WHERE id = ? AND link_attempt = ?').run(attempt, ref, now(), due.id, due.link_attempt)
  if (!claim.changes) return null
  const owed = due.amount - due.amount_paid
  const ran = await runOnce(db, vs, user.id, cfg.razorpayConnectionId, 'razorpay_create_link', {
    link_type: 'standard', amount: owed * 100, currency: 'INR', description: `Rent ${due.period}: ${t.property_label}`.slice(0, 200), reference_id: ref,
    add_customer: true, customer: { name: t.tenant_name, ...(t.tenant_email ? { email: t.tenant_email } : {}), ...(t.tenant_phone ? { contact: t.tenant_phone } : {}) },
    accept_partial: false, notes: { dealsaathi_due: String(due.id) }
  })
  const read = ran.outcome === 'answered' ? readPaymentLink(ran.result) : { ok: false, reason: ran.reason }
  if (!read.ok) {
    db.prepare('UPDATE rent_dues SET payment_link_error = ?, updated_at = ? WHERE id = ?').run(read.reason, now(), due.id)
    event(db, t.id, due.id, 'link_failed', `Payment link not created: ${read.reason}`, user.id)
    return null
  }
  db.prepare("UPDATE rent_dues SET payment_link_id = ?, payment_link_url = ?, payment_link_status = 'created', payment_link_error = NULL, updated_at = ? WHERE id = ?").run(read.id, read.url, now(), due.id)
  event(db, t.id, due.id, 'link_created', `Razorpay payment link created for ${inr(owed)} (${read.id})`, user.id)
  return read.url
}

/** Reads the link's status from Razorpay. Only "paid" / "partially_paid" with amount_paid there changes the due. */
export async function verifyPayment(db, vs, user, cfg, due) {
  if (!cfg.razorpayConnectionId || !due.payment_link_ref) return { checked: false }
  const ran = await runOnce(db, vs, user.id, cfg.razorpayConnectionId, 'razorpay_list_links', { search_mode: 'reference_id', reference_id: due.payment_link_ref })
  const read = ran.outcome === 'answered' ? readPaymentLinkList(ran.result) : { ok: false, reason: ran.reason }
  if (!read.ok) return { checked: false, error: read.reason }
  const link = read.links.find((l) => l.id === due.payment_link_id) || read.links.find((l) => l.referenceId === due.payment_link_ref)
  if (!link) return { checked: true, changed: false }
  const paidRupees = Math.floor(link.amountPaid / 100)
  // What Razorpay says was paid on this link, minus what DealSaathi already credited from it.
  const credited = db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM rent_payments WHERE due_id = ? AND source = 'razorpay' AND external_id LIKE ?").get(due.id, `${link.id}:%`).n
  let changed = false
  if (['paid', 'partially_paid'].includes(link.status) && paidRupees > credited) {
    try {
      transaction(db, () => applyPayment(db, due, Math.min(paidRupees - credited, due.amount - due.amount_paid), { source: 'razorpay', externalId: `${link.id}:${link.amountPaid}`, paidOn: todayIn(RENT_TIMEZONE) }))
      changed = true
    } catch (error) {
      if (!/UNIQUE/i.test(error.message)) throw error // already recorded by a parallel run
    }
  }
  if (link.status !== due.payment_link_status) {
    db.prepare('UPDATE rent_dues SET payment_link_status = ?, updated_at = ? WHERE id = ?').run(link.status, now(), due.id)
    if (['expired', 'cancelled'].includes(link.status)) event(db, due.tenancy_id, due.id, 'link_closed', `Payment link ${link.status} in Razorpay; a new one will be made for the next reminder`, null)
  }
  return { checked: true, changed, status: link.status }
}

/** The reminder stages for a due, with the date each one applies from. */
export function stagesFor(due, cfg) {
  const stages = []
  const before = Number(cfg.beforeDays ?? 3)
  if (before > 0) stages.push({ key: `before_${before}`, date: addDays(due.due_date, -before), label: `due in ${before} day${before === 1 ? '' : 's'}` })
  if (cfg.onDue !== false) stages.push({ key: 'on_due', date: due.due_date, label: 'due today' })
  for (const n of (cfg.afterDays ?? [3, 7])) stages.push({ key: `after_${n}`, date: addDays(due.due_date, n), label: `${n} day${n === 1 ? '' : 's'} overdue` })
  return stages.sort((a, b) => (a.date < b.date ? -1 : 1))
}

const inQuietHours = (at = new Date()) => {
  const h = Number(utcToZoned(at, RENT_TIMEZONE).time.slice(0, 2))
  return h >= QUIET.from || h < QUIET.to
}

async function remind(db, vs, user, cfg, due, t, stage, link) {
  const outstanding = due.amount - due.amount_paid
  const key = `${due.id}:${stage.key}`
  // Claimed before sending: a second run (or a crash mid-send) can never send this stage again.
  const claim = db.prepare(`INSERT INTO rent_reminders (due_id, stage, channel, recipient, status, detail, dedupe_key, created_at) VALUES (?, ?, 'gmail', ?, 'unknown', 'sending', ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`)
    .run(due.id, stage.key, t.tenant_email, key, now())
  if (!claim.changes) return null
  const overdueBy = daysBetween(due.due_date, todayIn(RENT_TIMEZONE))
  const subject = overdueBy > 0 ? `Rent for ${due.period} is overdue` : overdueBy === 0 ? `Rent for ${due.period} is due today` : `Rent for ${due.period} is due on ${due.due_date}`
  const body = [`Hi ${t.tenant_name.split(' ')[0]},`, '',
    `This is a reminder that ${inr(outstanding)} rent for ${t.property_label} ${overdueBy > 0 ? `was due on ${due.due_date}` : overdueBy === 0 ? 'is due today' : `is due on ${due.due_date}`}.`,
    ...(link ? ['', `You can pay securely here: ${link}`] : []), '',
    'If you have already paid, please reply with the payment details so I can confirm it.', '', `Best regards,`, user.name].join('\n')
  const ran = await runOnce(db, vs, user.id, cfg.gmailConnectionId, 'gmail_send_email', gmailInput({ to: t.tenant_email, subject, body, fromName: user.name }))
  const read = ran.outcome === 'answered' ? readGmailResult(ran.result) : { ok: false, unknown: ran.outcome === 'unknown', reason: ran.reason }
  const status = read.ok ? 'sent' : read.unknown ? 'unknown' : 'failed'
  const detail = read.ok ? `Gmail message id ${read.messageId}` : read.reason
  db.prepare('UPDATE rent_reminders SET status = ?, detail = ? WHERE dedupe_key = ?').run(status, detail, key)
  event(db, t.id, due.id, `reminder_${status}`, `Reminder (${stage.label}) to ${t.tenant_email}: ${status}${read.ok ? '' : ` (${detail})`}`, null)
  if (status === 'sent') emit(db, 'rent.reminder_sent', { subjectType: 'tenancy', subjectId: t.id, agentId: user.id, payload: { dueId: due.id, period: due.period, label: stage.label, key }, dedupeKey: `rent.reminder_sent:${key}` })
  return status
}

/**
 * The scheduled rent check for one broker: end expired leases, create the coming month's dues, verify payments
 * with Razorpay, then send at most one reminder per due (its latest stage that has arrived and was not sent).
 */
async function checkBroker(db, vs, user, cfg, { force = false } = {}) {
  const today = todayIn(RENT_TIMEZONE)
  const totals = { tenancies: 0, newDues: 0, verified: 0, sent: 0, failed: 0, skipped: 0 }
  for (const t of db.prepare("SELECT * FROM tenancies WHERE user_id = ? AND status = 'active'").all(user.id)) {
    if (t.lease_end && t.lease_end < today) {
      transaction(db, () => {
        db.prepare("UPDATE tenancies SET status = 'ended', updated_at = ? WHERE id = ?").run(now(), t.id)
        event(db, t.id, null, 'lease_ended', `Lease ended on ${t.lease_end}: no new rent is created and reminders stop`, null)
      })
      continue
    }
    totals.tenancies++
    totals.newDues += generateDues(db, t, today)
    for (let due of db.prepare("SELECT * FROM rent_dues WHERE tenancy_id = ? AND status IN ('open','partially_paid') ORDER BY due_date").all(t.id)) {
      const v = await verifyPayment(db, vs, user, cfg, due)
      if (v.changed) { totals.verified++; due = db.prepare('SELECT * FROM rent_dues WHERE id = ?').get(due.id) }
      if (due.status === 'paid') continue
      const stage = stagesFor(due, cfg).filter((s) => s.date <= today).at(-1)
      if (!stage) continue
      if (db.prepare('SELECT 1 FROM rent_reminders WHERE dedupe_key = ?').get(`${due.id}:${stage.key}`)) continue
      if (t.reminders_opt_out || !t.tenant_email) {
        const why = t.reminders_opt_out ? 'Tenant opted out of reminders' : 'No tenant email on the tenancy'
        const r = db.prepare(`INSERT INTO rent_reminders (due_id, stage, channel, recipient, status, detail, dedupe_key, created_at) VALUES (?, ?, 'gmail', NULL, 'skipped', ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`)
          .run(due.id, stage.key, why, `${due.id}:${stage.key}`, now())
        if (r.changes) totals.skipped++
        continue
      }
      if (!force && inQuietHours()) continue
      const link = await ensurePaymentLink(db, vs, user, cfg, db.prepare('SELECT * FROM rent_dues WHERE id = ?').get(due.id), t)
      const status = await remind(db, vs, user, cfg, due, t, stage, link)
      if (status === 'sent') totals.sent++
      else if (status) totals.failed++
    }
  }
  return totals
}

/** Trigger: the scheduler, every 15 minutes (or "Run check now" for one broker). */
export async function runRentChecks(db, vs, { trigger, onlyUser = null, onlyConfig = null, force = false }) {
  const targets = onlyUser ? [{ user: onlyUser, config: onlyConfig }] : usersWithEnabled(db, 'rent_reminders')
  const all = { brokers: 0, sent: 0, failed: 0, verified: 0, newDues: 0, skipped: 0 }
  for (const { user, config } of targets) {
    all.brokers++
    const t = await checkBroker(db, vs, user, config, { force })
    for (const k of ['sent', 'failed', 'verified', 'newDues', 'skipped']) all[k] += t[k]
    if (t.sent || t.failed || t.verified || t.newDues) {
      const runId = startRun(db, { userId: user.id, key: 'rent_reminders', trigger })
      finishRun(db, runId, {
        status: t.failed ? 'failed' : 'succeeded',
        summary: `${t.sent} reminder(s) sent, ${t.verified} payment(s) verified by Razorpay, ${t.newDues} new due(s)${t.skipped ? `, ${t.skipped} skipped` : ''}`,
        error: t.failed ? `${t.failed} reminder(s) not sent: see the tenancy’s reminder history` : null
      })
    }
  }
  return all
}

/** "Check payment status now" for one due. */
export async function checkDueNow(db, vs, user, dueId) {
  const due = ownDue(db, user.id, dueId)
  const cfg = getSetting(db, user.id, 'rent_reminders').config
  if (!cfg.razorpayConnectionId) throw new AppError(409, 'needs_setup', 'Connect Razorpay and choose it in Rent and Payment Reminders to check payments automatically.')
  if (!due.payment_link_ref) throw new AppError(409, 'no_link', 'This month has no Razorpay payment link yet.')
  const v = await verifyPayment(db, vs, user, cfg, due)
  if (v.error) throw new AppError(502, 'razorpay_unavailable', `Could not read the payment link: ${v.error}`)
  return { ...tenancyDetail(db, user.id, due.tenancy_id), check: v }
}
