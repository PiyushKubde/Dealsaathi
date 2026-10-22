// Notifications: what each person was told, and through which channel. Every notification has a dedupe key built
// from the fact it reports and its recipient, so the same unchanged fact never reaches the same person twice, however
// often the event behind it is processed.
import { now } from '../db.js'
import { AppError } from '../errors.js'

/** Creates an in-app notification. Returns its id, or null when this fact was already notified to this person. */
export function notifyInApp(db, userId, { kind, title, body = null, link = null, subjectType = null, subjectId = null, dedupeKey, eventId = null }) {
  if (!userId) return null
  const ts = now()
  const r = db.prepare(`INSERT INTO notifications (user_id, kind, title, body, link, subject_type, subject_id, channel, status, event_id, dedupe_key, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, 'in_app', 'unread', ?, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`)
    .run(userId, kind, title.slice(0, 200), body ? body.slice(0, 2000) : null, link, subjectType, subjectId == null ? null : String(subjectId), eventId, `in_app:${userId}:${dedupeKey}`, ts, ts)
  return r.changes ? Number(r.lastInsertRowid) : null
}

/**
 * Claims an external delivery (email, Slack) before it is attempted. Returns the row id, or null when this fact
 * was already delivered (or attempted) to this recipient: a retried event never sends twice. A delivery whose
 * attempt failed (nothing went out) may be claimed again; an unknown one may not.
 */
export function claimExternal(db, userId, channel, { kind, title, subjectType = null, subjectId = null, dedupeKey, eventId = null }) {
  const key = `${channel}:${userId}:${dedupeKey}`
  const ts = now()
  const r = db.prepare(`INSERT INTO notifications (user_id, kind, title, subject_type, subject_id, channel, status, event_id, dedupe_key, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, 'sending', ?, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`)
    .run(userId, kind, title.slice(0, 200), subjectType, subjectId == null ? null : String(subjectId), channel, eventId, key, ts, ts)
  if (r.changes) return Number(r.lastInsertRowid)
  const again = db.prepare("UPDATE notifications SET status = 'sending', updated_at = ? WHERE dedupe_key = ? AND status = 'failed'").run(ts, key)
  return again.changes ? db.prepare('SELECT id FROM notifications WHERE dedupe_key = ?').get(key).id : null
}

export function finishExternal(db, id, status, detail) {
  db.prepare('UPDATE notifications SET status = ?, detail = ?, updated_at = ? WHERE id = ?').run(status, detail ? String(detail).slice(0, 500) : null, now(), id)
}

const toPublic = (r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link, channel: r.channel, status: r.status, detail: r.detail, createdAt: r.created_at, readAt: r.read_at })

export function listNotifications(db, userId, { unreadOnly = false, limit = 50 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200)
  const rows = unreadOnly
    ? db.prepare("SELECT * FROM notifications WHERE user_id = ? AND channel = 'in_app' AND status = 'unread' ORDER BY id DESC LIMIT ?").all(userId, lim)
    : db.prepare("SELECT * FROM notifications WHERE user_id = ? AND channel = 'in_app' ORDER BY id DESC LIMIT ?").all(userId, lim)
  const unread = db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND channel = 'in_app' AND status = 'unread'").get(userId).n
  return { notifications: rows.map(toPublic), unread }
}

/** Deliveries through integrations made on this person's behalf (their sent log). */
export function listDeliveries(db, userId, limit = 50) {
  return db.prepare("SELECT * FROM notifications WHERE user_id = ? AND channel != 'in_app' ORDER BY id DESC LIMIT ?").all(userId, limit).map(toPublic)
}

export function markRead(db, userId, id) {
  const r = db.prepare("UPDATE notifications SET status = 'read', read_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND channel = 'in_app'").run(now(), now(), id, userId)
  if (!r.changes) throw new AppError(404, 'notification_not_found', 'No such notification.')
  return { read: true }
}

export function markAllRead(db, userId) {
  return { read: db.prepare("UPDATE notifications SET status = 'read', read_at = ?, updated_at = ? WHERE user_id = ? AND channel = 'in_app' AND status = 'unread'").run(now(), now(), userId).changes }
}
