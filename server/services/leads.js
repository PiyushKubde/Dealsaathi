import { audit, nowIso } from '../db.js'
import { leadUpdateSchema, normalizeEmail, normalizePhone, parseOrThrow, validateLeadCreate } from '../validation.js'

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message)
    this.status = status
    Object.assign(this, extra)
  }
}

const COLUMNS = [
  'full_name', 'email', 'phone', 'source', 'category', 'property_interest', 'preferred_location',
  'budget_min', 'budget_max', 'status', 'assigned_broker', 'notes'
]

export function createLeadService(db) {
  const byId = db.prepare('SELECT * FROM leads WHERE id = ? AND owner_id = ?')

  function findDuplicate(ownerId, { email, phone }, excludeId = 0) {
    const emailNorm = normalizeEmail(email)
    const phoneNorm = normalizePhone(phone)
    if (!emailNorm && !phoneNorm) return null
    return (
      db
        .prepare(
          `SELECT * FROM leads WHERE owner_id = ? AND id != ?
             AND ((email_norm IS NOT NULL AND email_norm = ?) OR (phone_norm IS NOT NULL AND phone_norm = ?))
           LIMIT 1`
        )
        .get(ownerId, excludeId, emailNorm, phoneNorm) || null
    )
  }

  return {
    validateCreate: validateLeadCreate,
    validateUpdate: (input) => parseOrThrow(leadUpdateSchema, input),
    findDuplicate,

    list(ownerId, { q, status, category, limit = 200 } = {}) {
      const where = ['owner_id = ?']
      const params = [ownerId]
      if (q) {
        where.push('(full_name LIKE ? OR email LIKE ? OR phone LIKE ? OR preferred_location LIKE ? OR property_interest LIKE ?)')
        const like = `%${q}%`
        params.push(like, like, like, like, like)
      }
      if (status) {
        where.push('status = ?')
        params.push(status)
      }
      if (category) {
        where.push('category = ?')
        params.push(category)
      }
      params.push(Math.min(Number(limit) || 200, 500))
      return db.prepare(`SELECT * FROM leads WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`).all(...params)
    },

    get(ownerId, id) {
      const lead = byId.get(id, ownerId)
      if (!lead) throw new HttpError(404, 'Lead not found.')
      return lead
    },

    /** Finds leads whose name contains the reference, for the assistant's "this lead" / "Rahul" lookups. */
    findByReference(ownerId, reference) {
      if (!reference) return []
      const asId = Number(String(reference).replace(/^#/, ''))
      if (Number.isInteger(asId) && asId > 0) {
        const lead = byId.get(asId, ownerId)
        if (lead) return [lead]
      }
      const ref = String(reference).trim()
      const exact = db.prepare('SELECT * FROM leads WHERE owner_id = ? AND lower(full_name) = lower(?)').all(ownerId, ref)
      if (exact.length) return exact
      return db
        .prepare('SELECT * FROM leads WHERE owner_id = ? AND (full_name LIKE ? OR email = lower(?)) ORDER BY updated_at DESC LIMIT 5')
        .all(ownerId, `%${ref}%`, ref)
    },

    create(ownerId, input, { isSample = false } = {}) {
      const lead = validateLeadCreate(input)
      const duplicate = findDuplicate(ownerId, lead)
      if (duplicate) {
        throw new HttpError(409, `A lead with this email or phone already exists: ${duplicate.full_name} (#${duplicate.id}).`, {
          code: 'duplicate',
          existing: duplicate
        })
      }
      const info = db
        .prepare(
          `INSERT INTO leads (owner_id, ${COLUMNS.join(', ')}, email_norm, phone_norm, is_sample)
           VALUES (?, ${COLUMNS.map(() => '?').join(', ')}, ?, ?, ?)`
        )
        .run(ownerId, ...COLUMNS.map((key) => lead[key] ?? null), normalizeEmail(lead.email), normalizePhone(lead.phone), isSample ? 1 : 0)
      audit(db, ownerId, 'lead_created', { lead_id: info.lastInsertRowid })
      return byId.get(info.lastInsertRowid, ownerId)
    },

    update(ownerId, id, input) {
      const existing = this.get(ownerId, id)
      const changes = parseOrThrow(leadUpdateSchema, input)
      const merged = { ...existing, ...Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)) }
      // Re-check the merged record so an edit cannot remove both contact details or invert the budget.
      validateLeadCreate(Object.fromEntries(COLUMNS.map((key) => [key, merged[key]])))
      const duplicate = findDuplicate(ownerId, merged, id)
      if (duplicate) {
        throw new HttpError(409, `Another lead already uses this email or phone: ${duplicate.full_name} (#${duplicate.id}).`, {
          code: 'duplicate',
          existing: duplicate
        })
      }
      const keys = COLUMNS.filter((key) => changes[key] !== undefined)
      if (keys.length) {
        db.prepare(
          `UPDATE leads SET ${keys.map((key) => `${key} = ?`).join(', ')}, email_norm = ?, phone_norm = ?, updated_at = ?
            WHERE id = ? AND owner_id = ?`
        ).run(...keys.map((key) => changes[key]), normalizeEmail(merged.email), normalizePhone(merged.phone), nowIso(), id, ownerId)
        audit(db, ownerId, 'lead_updated', { lead_id: id, fields: keys })
      }
      return this.get(ownerId, id)
    },

    /** Leads that need a follow-up: active, and untouched for `days` days. Derived only from stored timestamps. */
    needingFollowUp(ownerId, days = 3) {
      const cutoff = new Date(Date.now() - days * 86400_000).toISOString()
      return db
        .prepare(
          `SELECT leads.*, (SELECT max(sent_at) FROM messages WHERE messages.lead_id = leads.id AND messages.status = 'sent') AS last_contacted_at
             FROM leads
            WHERE owner_id = ? AND status IN ('new','contacted','interested','negotiating')
              AND coalesce((SELECT max(sent_at) FROM messages WHERE messages.lead_id = leads.id AND messages.status = 'sent'), leads.updated_at) < ?
            ORDER BY leads.updated_at ASC LIMIT 20`
        )
        .all(ownerId, cutoff)
    }
  }
}
