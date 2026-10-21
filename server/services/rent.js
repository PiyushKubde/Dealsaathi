import { audit, nowIso } from '../db.js'
import { parseOrThrow, rentSchema } from '../validation.js'
import { HttpError } from './leads.js'

/** Today's date (YYYY-MM-DD) in a given IANA time zone. */
export function todayIn(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

export function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

const daysBetween = (from, to) => Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400_000)

/**
 * Classifies a rent record from its stored status and due date only.
 * A record whose payment status is `unknown` is never called overdue: it needs verification.
 */
export function classifyRent(record, today, windowDays = 7) {
  const days = daysBetween(today, record.due_date)
  if (record.payment_status === 'paid') return { bucket: 'paid', days_until_due: days }
  if (record.payment_status === 'unknown') {
    return { bucket: days <= windowDays ? 'needs_verification' : 'later', days_until_due: days }
  }
  if (days < 0) return { bucket: 'overdue', days_until_due: days }
  if (days <= windowDays) return { bucket: 'due_soon', days_until_due: days }
  return { bucket: 'later', days_until_due: days }
}

export function createRentService(db, { timeZone }) {
  const byId = db.prepare('SELECT * FROM rent_records WHERE id = ? AND owner_id = ?')
  const withClass = (row, today, windowDays) => ({ ...row, is_sample: Boolean(row.is_sample), ...classifyRent(row, today, windowDays) })

  return {
    today: () => todayIn(timeZone),

    list(ownerId, { windowDays = 7 } = {}) {
      const today = todayIn(timeZone)
      return db
        .prepare('SELECT * FROM rent_records WHERE owner_id = ? ORDER BY due_date ASC')
        .all(ownerId)
        .map((row) => withClass(row, today, windowDays))
    },

    /** Records that need attention within the window: overdue, due soon, or due but with unverified status. */
    attention(ownerId, { windowDays = 7, includeOverdue = true } = {}) {
      return this.list(ownerId, { windowDays }).filter(
        (r) => r.bucket === 'due_soon' || r.bucket === 'needs_verification' || (includeOverdue && r.bucket === 'overdue')
      )
    },

    get(ownerId, id) {
      const row = byId.get(id, ownerId)
      if (!row) throw new HttpError(404, 'Rent record not found.')
      return withClass(row, todayIn(timeZone), 7)
    },

    create(ownerId, input, { isSample = false } = {}) {
      const r = parseOrThrow(rentSchema, input)
      const info = db
        .prepare(
          `INSERT INTO rent_records (owner_id, tenant_name, tenant_email, tenant_phone, property_id, property_label, amount,
             due_date, payment_status, last_payment_date, last_payment_amount, notes, is_sample)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(ownerId, r.tenant_name, r.tenant_email, r.tenant_phone, r.property_id, r.property_label, r.amount, r.due_date,
          r.payment_status, r.last_payment_date, r.last_payment_amount, r.notes, isSample ? 1 : 0)
      if (!isSample) audit(db, ownerId, 'rent_record_created', { rent_id: info.lastInsertRowid })
      return this.get(ownerId, info.lastInsertRowid)
    },

    update(ownerId, id, input) {
      const existing = this.get(ownerId, id)
      const r = parseOrThrow(rentSchema, { ...existing, ...input })
      db.prepare(
        `UPDATE rent_records SET tenant_name=?, tenant_email=?, tenant_phone=?, property_id=?, property_label=?, amount=?,
           due_date=?, payment_status=?, last_payment_date=?, last_payment_amount=?, notes=?, updated_at=?
         WHERE id=? AND owner_id=?`
      ).run(r.tenant_name, r.tenant_email, r.tenant_phone, r.property_id, r.property_label, r.amount, r.due_date,
        r.payment_status, r.last_payment_date, r.last_payment_amount, r.notes, nowIso(), id, ownerId)
      audit(db, ownerId, 'rent_record_updated', { rent_id: id })
      return this.get(ownerId, id)
    },

    setReminderStatus(ownerId, id, status) {
      db.prepare('UPDATE rent_records SET reminder_status = ?, updated_at = ? WHERE id = ? AND owner_id = ?').run(status, nowIso(), id, ownerId)
    }
  }
}
