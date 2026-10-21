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
    description: 'Tells you or your team the moment a new lead is added.',
    trigger: 'A lead is saved (form or AI assistant)',
    action: 'An email from your Gmail, or a message to a Slack channel, with the lead’s details',
    channels: ['gmail', 'slack']
  },
  {
    key: 'buyer_matching', name: 'New Property → Buyer Matching', available: true, defaultEnabled: true,
    description: 'Finds the saved buyers and tenants a new listing suits, and says why.',
    trigger: 'You save a property',
    action: 'Matches it against saved buyer and tenant preferences and lists who fits on the property page',
    channels: []
  },
  {
    key: 'property_recommendations', name: 'Property Recommendations', available: true, defaultEnabled: false,
    description: 'Prepares a personal email of matching listings for a lead; you approve it before it is sent.',
    trigger: 'You ask for recommendations on a lead’s page',
    action: 'A reviewed email of real matching listings, sent from your Gmail',
    channels: ['gmail']
  },
  {
    key: 'followup_reminders', name: 'Buyer Follow-Up Reminders', available: true, defaultEnabled: false,
    description: 'Reminds you when a lead’s follow-up date arrives or a lead has gone quiet.',
    trigger: 'A lead’s follow-up date arrives, or no activity is recorded for a set number of days (checked every 15 minutes)',
    action: 'A reminder in DealSaathi, and optionally an email or Slack message to you',
    channels: ['gmail', 'slack'], needsScheduler: true
  },
  {
    key: 'viewing_scheduler', name: 'Property Viewing Scheduler', available: false, defaultEnabled: false,
    description: 'Checks your Google Calendar, books a viewing you confirm, and sends the confirmation.',
    trigger: 'You request a viewing or approve a suggested slot',
    action: 'Google Calendar free/busy check, event creation after confirmation, and a confirmation message',
    channels: ['google-calendar'],
    blocker: 'Not built yet. It needs Google Calendar connected (Integrations) and DealSaathi’s viewing workflow, which is the next thing to build.'
  },
  {
    key: 'viewing_feedback', name: 'Post-Viewing Feedback', available: false, defaultEnabled: false,
    description: 'Asks the buyer for feedback after a viewing and updates their saved preferences.',
    trigger: 'A viewing ends and you confirm it took place',
    action: 'A feedback request, the recorded answer, and updated buyer preferences',
    channels: [],
    blocker: 'Not built yet. It depends on the Viewing Scheduler, and on a buyer messaging channel: WhatsApp Business with an approved template, or email.'
  },
  {
    key: 'rent_reminders', name: 'Rent and Payment Reminders', available: false, defaultEnabled: false,
    description: 'Reminds tenants before and after rent is due, and stops once payment is verified.',
    trigger: 'A rent due date approaches or passes',
    action: 'Reminders through a configured channel, stopped only by a verified or manually confirmed payment',
    channels: [],
    blocker: 'Not built yet. It needs tenancy records in DealSaathi; automatic payment verification also needs a Razorpay connection (otherwise payments are confirmed by hand).'
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
  const rows = db.prepare('SELECT s.user_id, s.config, u.name, u.email FROM automation_settings s JOIN users u ON u.id = s.user_id WHERE s.key = ? AND s.enabled = 1').all(key)
  return rows.map((r) => ({ user: { id: r.user_id, name: r.name, email: r.email }, config: JSON.parse(r.config) }))
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
