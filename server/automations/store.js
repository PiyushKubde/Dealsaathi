// DealSaathi's curated automations: their definitions, each broker's settings, and every run.
import { randomUUID } from 'node:crypto'
import { now } from '../db.js'

/**
 * The seven automations. `available: false` ones are not built: their card says what is missing, and they
 * cannot be enabled. `channels` are the integrations an automation can act through.
 */
export const AUTOMATIONS = [
  {
    key: 'new_lead_alert', name: 'New Lead Alert', available: true, defaultEnabled: false,
    description: 'Tells you when a lead becomes yours: one you add, a buyer who registers in your service area, or one assigned or transferred to you. Other agents’ leads never reach you.',
    trigger: 'Platform event: lead created or assigned to you (processed from the event queue)',
    action: 'An in-app notification, plus an email from your Gmail or a Slack message if you choose',
    channels: ['gmail', 'slack']
  },
  {
    key: 'buyer_matching', name: 'New Property Matching', available: true, defaultEnabled: true,
    description: 'Matching runs for the whole platform whenever a listing is published or changed, or a buyer saves requirements. This controls how you hear about new matches for your buyers and listings.',
    trigger: 'Platform events: listing published or changed, buyer requirements saved or changed',
    action: 'In-app notices for new matches; optionally one Gmail or Slack message per change listing every new match for your buyers',
    channels: ['gmail', 'slack']
  },
  {
    key: 'property_recommendations', name: 'Property Recommendations', available: true, defaultEnabled: false,
    description: 'Buyers see their matches in the app as they are found. For your leads you can pick listings and send an email you approve first (only to buyers who allow agent email). WhatsApp delivery needs a WhatsApp Business account with an approved template and is not available yet.',
    trigger: 'Stored matches (in-app, automatic); your approval (email)',
    action: 'In-app recommendations for buyers; a reviewed email from your Gmail',
    channels: ['gmail']
  },
  {
    key: 'followup_reminders', name: 'Buyer Follow-Up Reminders', available: true, defaultEnabled: false,
    description: 'Reminds you about your own assigned leads when a follow-up date arrives or nobody has contacted them for a set number of days (automatic entries such as matches do not count as contact).',
    trigger: 'A lead’s follow-up date arrives, or no activity is recorded for a set number of days (checked every 15 minutes)',
    action: 'A reminder in DealSaathi, and optionally an email or Slack message to you',
    channels: ['gmail', 'slack'], needsScheduler: true
  },
  {
    key: 'viewing_scheduler', name: 'Property Viewing Scheduler', available: true, defaultEnabled: false,
    description: 'You, or a buyer assigned to you, pick a time your Google Calendar shows free; you confirm, and it is booked in your calendar with an optional confirmation email.',
    trigger: 'You schedule a viewing, or one of your buyers requests one; you confirm it',
    action: 'Google Calendar free/busy check, a re-check, the calendar event, and a Gmail confirmation to the lead',
    channels: ['google-calendar', 'gmail']
  },
  {
    key: 'viewing_feedback', name: 'Post-Viewing Feedback', available: true, defaultEnabled: false,
    description: 'After you mark a viewing as having taken place, asks the buyer for feedback (in the app for registered buyers, by a private emailed link otherwise) and updates their requirements and matches.',
    trigger: 'You mark a viewing completed (DealSaathi reminds you when a viewing has ended)',
    action: 'A private feedback link by Gmail; the answer updates the buyer’s saved preferences and future matches',
    channels: ['gmail']
  },
  {
    key: 'rent_reminders', name: 'Rent and Payment Reminders', available: true, defaultEnabled: false,
    description: 'Reminds tenants before and after rent is due, and stops once payment is verified. Linked tenants and landlords see their tenancy in the app; only you manage it.',
    trigger: 'Rent due dates approaching or passing (checked every 15 minutes)',
    action: 'Gmail reminders with an optional Razorpay payment link; stopped only by Razorpay’s paid status or a payment you record',
    channels: ['gmail', 'razorpay'], needsScheduler: true
  }
]

export const automation = (key) => AUTOMATIONS.find((a) => a.key === key)

export function getSetting(db, userId, key) {
  const row = db.prepare('SELECT enabled, config, updated_at FROM automation_settings WHERE user_id = ? AND key = ?').get(userId, key)
  if (!row) return { enabled: Boolean(automation(key)?.defaultEnabled), config: {}, updatedAt: null }
  return { enabled: Boolean(row.enabled), config: JSON.parse(row.config), updatedAt: row.updated_at }
}

export function saveSetting(db, userId, key, { enabled, config }) {
  db.prepare(`INSERT INTO automation_settings (user_id, key, enabled, config, updated_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT (user_id, key) DO UPDATE SET enabled = excluded.enabled, config = excluded.config, updated_at = excluded.updated_at`)
    .run(userId, key, enabled ? 1 : 0, JSON.stringify(config || {}), now())
  return getSetting(db, userId, key)
}

/** Users who switched this automation on. */
export function usersWithEnabled(db, key) {
  const rows = db.prepare("SELECT s.user_id, s.config, u.name, u.email, u.role FROM automation_settings s JOIN users u ON u.id = s.user_id WHERE s.key = ? AND s.enabled = 1 AND u.role = 'agent'").all(key)
  return rows.map((r) => ({ user: { id: r.user_id, name: r.name, email: r.email, role: r.role }, config: JSON.parse(r.config) }))
}

/**
 * Starts a run. With a dedupeKey, a second start for the same event returns null: the run already happened
 * (or is happening), so nothing is sent twice.
 */
export function startRun(db, { userId, key, trigger, subjectType = null, subjectId = null, dedupeKey = null }) {
  const id = randomUUID()
  const r = db.prepare(`INSERT INTO automation_runs (id, user_id, key, trigger, subject_type, subject_id, status, dedupe_key, started_at)
                        VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`)
    .run(id, userId, key, trigger, subjectType, subjectId == null ? null : String(subjectId), dedupeKey, now())
  return r.changes ? id : null
}

export function finishRun(db, id, { status, summary = null, error = null, details = null }) {
  db.prepare('UPDATE automation_runs SET status = ?, summary = ?, error = ?, details = ?, finished_at = ? WHERE id = ?')
    .run(status, summary, error, details ? JSON.stringify(details) : null, now(), id)
}

const toRun = (r) => (!r ? null : {
  id: r.id, key: r.key, trigger: r.trigger, subjectType: r.subject_type, subjectId: r.subject_id, status: r.status,
  summary: r.summary, error: r.error, startedAt: r.started_at, finishedAt: r.finished_at, retryable: r.status === 'failed' && r.key === 'new_lead_alert'
})

export function listRuns(db, userId, key, limit = 20) {
  return db.prepare('SELECT * FROM automation_runs WHERE user_id = ? AND key = ? ORDER BY started_at DESC LIMIT ?').all(userId, key, limit).map(toRun)
}

export const getRun = (db, userId, id) => toRun(db.prepare('SELECT * FROM automation_runs WHERE id = ? AND user_id = ?').get(id, userId))
export const lastRun = (db, userId, key) => toRun(db.prepare('SELECT * FROM automation_runs WHERE user_id = ? AND key = ? ORDER BY started_at DESC LIMIT 1').get(userId, key))

/** Runs still "running" after a restart were cut off: their outcome is unknown, never assumed. */
export function markInterruptedRuns(db, olderThanMs = 10 * 60 * 1000) {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString()
  return db.prepare("UPDATE automation_runs SET status = 'unknown', error = 'The server stopped while this was running, so its outcome is unknown.', finished_at = ? WHERE status = 'running' AND started_at < ?")
    .run(now(), cutoff).changes
}
