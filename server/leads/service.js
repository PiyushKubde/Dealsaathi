// Lead records in the local SQLite database. Nothing here talks to an external CRM.
import { now, transaction } from '../db.js'
import { AppError, validationError } from '../errors.js'
import {
  LEAD_FIELDS, STATUSES, CUSTOMER_TYPES, checkCompleteLead, cleanLeadFields, leadCode,
  normalizeEmail, normalizeName, normalizePhone
} from './validate.js'

const FIELD_LABELS = {
  full_name: 'Name', email: 'Email', phone: 'Phone', source: 'Source', customer_type: 'Customer type',
  property_type: 'Property type', property_interest: 'Interested in', bedrooms: 'Bedrooms',
  preferred_location: 'Location', budget_min: 'Min budget', budget_max: 'Max budget', status: 'Status',
  assigned_broker: 'Assigned broker', notes: 'Notes'
}

/** Leads following up needs: still New or Contacted and untouched for this many days. */
export const FOLLOW_UP_AFTER_DAYS = 3

function toLead(row) {
  if (!row) return null
  const { email_norm, phone_norm, ...lead } = row // eslint-disable-line no-unused-vars
  return { ...lead, code: leadCode(row.id), origin: 'local' }
}

export function getLead(db, id) {
  return toLead(db.prepare('SELECT * FROM leads WHERE id = ?').get(id))
}

export function requireLead(db, id) {
  const lead = getLead(db, id)
  if (!lead) throw new AppError(404, 'lead_not_found', `No lead with id ${id}.`)
  return lead
}

/**
 * Existing leads that look like the same person. `strong` matches (same email or phone) block saving;
 * a name-only match is a warning the broker may override.
 */
export function findDuplicates(db, { full_name, email, phone }, excludeId = null) {
  const found = new Map()
  const add = (rows, reason, strong) => {
    for (const row of rows) {
      if (row.id === excludeId) continue
      const entry = found.get(row.id) || { lead: toLead(row), reasons: [], strong: false }
      entry.reasons.push(reason)
      entry.strong ||= strong
      found.set(row.id, entry)
    }
  }
  const emailNorm = normalizeEmail(email)
  const phoneNorm = normalizePhone(phone)
  if (emailNorm) add(db.prepare('SELECT * FROM leads WHERE email_norm = ?').all(emailNorm), 'same email', true)
  if (phoneNorm) add(db.prepare('SELECT * FROM leads WHERE phone_norm = ?').all(phoneNorm), 'same phone', true)
  if (full_name) {
    const rows = db.prepare("SELECT * FROM leads WHERE lower(trim(full_name)) = ?").all(normalizeName(full_name))
    add(rows, 'same name', false)
  }
  return [...found.values()]
}

function logActivity(db, leadId, type, summary, details, via) {
  db.prepare('INSERT INTO lead_activities (lead_id, type, summary, details, via, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(leadId, type, summary, details ? JSON.stringify(details) : null, via, now())
}

/**
 * Validates and saves a new lead. Throws 400 for invalid fields, 409 for a duplicate
 * (a name-only match passes when allowSameName is true).
 */
export function createLead(db, input, { via = 'form', allowSameName = false } = {}) {
  const { value, errors } = cleanLeadFields(input)
  const lead = { status: 'new', ...value }
  Object.assign(errors, checkCompleteLead(lead))
  if (Object.keys(errors).length) throw validationError(errors)

  return transaction(db, () => {
    const duplicates = findDuplicates(db, lead)
    const blocking = duplicates.filter((d) => d.strong || !allowSameName)
    if (blocking.length) {
      throw new AppError(409, 'possible_duplicate', 'This lead may already exist.', { duplicates })
    }
    const ts = now()
    const cols = LEAD_FIELDS.filter((f) => lead[f] != null)
    const row = { ...Object.fromEntries(cols.map((f) => [f, lead[f]])) }
    const names = [...cols, 'email_norm', 'phone_norm', 'created_at', 'updated_at']
    const values = [...cols.map((f) => row[f]), normalizeEmail(lead.email), normalizePhone(lead.phone), ts, ts]
    const { lastInsertRowid } = db
      .prepare(`INSERT INTO leads (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
      .run(...values)
    const id = Number(lastInsertRowid)
    logActivity(db, id, 'created', 'Lead created', { fields: row }, via)
    return getLead(db, id)
  })
}

const display = (v) => (v == null || v === '' ? '—' : String(v))

/** Applies the given changes. Returns { lead, changed } where changed lists the fields that differ. */
export function updateLead(db, id, input, { via = 'form', allowSameName = false } = {}) {
  const { value, errors } = cleanLeadFields(input)
  if (Object.keys(errors).length) throw validationError(errors)

  return transaction(db, () => {
    const current = requireLead(db, id)
    const changes = Object.entries(value).filter(([f, v]) => (current[f] ?? null) !== (v ?? null))
    if (!changes.length) return { lead: current, changed: [] }

    const merged = { ...current, ...Object.fromEntries(changes) }
    const completeErrors = checkCompleteLead(merged)
    if (Object.keys(completeErrors).length) throw validationError(completeErrors)

    const touchesIdentity = changes.some(([f]) => ['full_name', 'email', 'phone'].includes(f))
    if (touchesIdentity) {
      const probe = {
        full_name: changes.some(([f]) => f === 'full_name') ? merged.full_name : null,
        email: changes.some(([f]) => f === 'email') ? merged.email : null,
        phone: changes.some(([f]) => f === 'phone') ? merged.phone : null
      }
      const blocking = findDuplicates(db, probe, id).filter((d) => d.strong || !allowSameName)
      if (blocking.length) throw new AppError(409, 'possible_duplicate', 'Another lead already has these details.', { duplicates: blocking })
    }

    const sets = changes.map(([f]) => `${f} = ?`)
    const params = changes.map(([, v]) => v)
    if (changes.some(([f]) => f === 'email')) { sets.push('email_norm = ?'); params.push(normalizeEmail(merged.email)) }
    if (changes.some(([f]) => f === 'phone')) { sets.push('phone_norm = ?'); params.push(normalizePhone(merged.phone)) }
    sets.push('updated_at = ?')
    params.push(now())
    db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...params, id)

    const diff = changes.map(([f, v]) => ({ field: f, from: current[f] ?? null, to: v ?? null }))
    const statusChange = diff.find((d) => d.field === 'status')
    const summary = statusChange && diff.length === 1
      ? `Status changed: ${display(statusChange.from)} → ${display(statusChange.to)}`
      : `Updated ${diff.map((d) => FIELD_LABELS[d.field]).join(', ')}`
    logActivity(db, id, statusChange ? 'status_changed' : 'updated', summary, { changes: diff }, via)
    return { lead: getLead(db, id), changed: diff }
  })
}

/** Removes a lead and its activity history. */
export function deleteLead(db, id) {
  return transaction(db, () => {
    const lead = requireLead(db, id)
    db.prepare('DELETE FROM leads WHERE id = ?').run(id)
    return lead
  })
}

export function listActivities(db, id) {
  return db.prepare('SELECT * FROM lead_activities WHERE lead_id = ? ORDER BY created_at DESC, id DESC').all(id)
    .map((a) => ({ ...a, details: a.details ? JSON.parse(a.details) : null }))
}

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

/** Search and filter. Every filter is optional; q matches name, email, phone, location, interest and notes. */
export function listLeads(db, { q, customer_type, status, location, budget_max, follow_up, limit = 50, offset = 0 } = {}) {
  const where = []
  const params = []
  if (q && String(q).trim()) {
    const like = `%${escapeLike(String(q).trim().toLowerCase())}%`
    const digits = String(q).replace(/\D/g, '')
    const parts = ['lower(full_name) LIKE ? ESCAPE \'\\\'', 'email_norm LIKE ? ESCAPE \'\\\'', 'lower(coalesce(preferred_location, \'\')) LIKE ? ESCAPE \'\\\'',
      'lower(coalesce(property_interest, \'\')) LIKE ? ESCAPE \'\\\'', 'lower(coalesce(notes, \'\')) LIKE ? ESCAPE \'\\\'']
    params.push(like, like, like, like, like)
    if (digits.length >= 3) { parts.push('phone_norm LIKE ?'); params.push(`%${digits}%`) }
    where.push(`(${parts.join(' OR ')})`)
  }
  if (customer_type) {
    if (!CUSTOMER_TYPES.includes(customer_type)) throw validationError({ customer_type: 'Unknown customer type.' })
    where.push('customer_type = ?'); params.push(customer_type)
  }
  if (status) {
    if (!STATUSES.includes(status)) throw validationError({ status: 'Unknown status.' })
    where.push('status = ?'); params.push(status)
  }
  if (location && String(location).trim()) {
    where.push("lower(coalesce(preferred_location, '')) LIKE ? ESCAPE '\\'")
    params.push(`%${escapeLike(String(location).trim().toLowerCase())}%`)
  }
  if (budget_max != null && budget_max !== '') {
    const n = Number(budget_max)
    if (!Number.isFinite(n) || n < 0) throw validationError({ budget_max: 'Must be a number.' })
    where.push('(budget_max IS NULL OR budget_max <= ?)'); params.push(n)
  }
  if (follow_up) {
    where.push("status IN ('new','contacted') AND updated_at <= ?")
    params.push(new Date(Date.now() - FOLLOW_UP_AFTER_DAYS * 86400000).toISOString())
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200)
  const off = Math.max(Number(offset) || 0, 0)
  const total = db.prepare(`SELECT COUNT(*) AS n FROM leads ${clause}`).get(...params).n
  const rows = db.prepare(`SELECT * FROM leads ${clause} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`).all(...params, lim, off)
  return { total, leads: rows.map(toLead) }
}

export function leadStats(db) {
  const total = db.prepare('SELECT COUNT(*) AS n FROM leads').get().n
  const byStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM leads GROUP BY status').all().map((r) => [r.status, r.n]))
  const byType = Object.fromEntries(db.prepare('SELECT customer_type, COUNT(*) AS n FROM leads GROUP BY customer_type').all().map((r) => [r.customer_type, r.n]))
  const followUp = listLeads(db, { follow_up: true, limit: 5 })
  const recent = listLeads(db, { limit: 5 }).leads
  return { total, byStatus, byType, followUp: { total: followUp.total, leads: followUp.leads }, recent, followUpAfterDays: FOLLOW_UP_AFTER_DAYS }
}

export { FIELD_LABELS }
