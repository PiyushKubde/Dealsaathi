// Follow-up reminders the Buyer Follow-Up Reminders automation created. Each broker sees only their own.
import { now } from '../db.js'
import { AppError } from '../errors.js'

export function listReminders(db, userId, status = 'open') {
  const wanted = ['open', 'done', 'dismissed', 'all'].includes(status) ? status : 'open'
  const rows = db.prepare(`SELECT r.*, l.full_name, l.customer_type FROM reminders r JOIN leads l ON l.id = r.lead_id
                           WHERE r.user_id = ? ${wanted === 'all' ? '' : 'AND r.status = ?'} ORDER BY r.created_at DESC LIMIT 100`)
    .all(...(wanted === 'all' ? [userId] : [userId, wanted]))
  return rows.map((r) => ({ id: r.id, leadId: r.lead_id, leadName: r.full_name, customerType: r.customer_type, reason: r.reason, detail: r.detail, status: r.status, createdAt: r.created_at }))
}

export function setReminderStatus(db, userId, id, status) {
  if (!['done', 'dismissed', 'open'].includes(status)) throw new AppError(400, 'validation_failed', 'Status must be done, dismissed or open.')
  const r = db.prepare('UPDATE reminders SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(status, now(), id, userId)
  if (!r.changes) throw new AppError(404, 'reminder_not_found', 'No such reminder.')
  return listReminders(db, userId, 'all').find((x) => x.id === id)
}
