// Domain events: the platform's processing queue. An event is written in the same transaction as the change it
// records (a lead saved, a listing published, a viewing booked…), so it exists if and only if the change does.
// The processor then runs its handler, retrying with backoff; handlers are idempotent and every side effect they
// cause (a notification, an email) carries its own dedupe key, so running an event twice never acts twice.
import { now } from '../db.js'

export const MAX_ATTEMPTS = 5
const LEASE_MS = 5 * 60 * 1000
const backoffMs = (attempts) => Math.min(30_000 * 2 ** (attempts - 1), 60 * 60 * 1000)

/**
 * Queues an event. Returns its id, or null when an event with the same dedupe key already exists
 * (the fact was already recorded). Call inside the transaction that makes the change.
 */
export function emit(db, type, { subjectType, subjectId, actorId = null, agentId = null, payload = {}, dedupeKey = null, delayMs = 0 }) {
  const ts = now()
  const r = db.prepare(`INSERT INTO domain_events (type, subject_type, subject_id, actor_id, agent_id, payload, dedupe_key, status, next_attempt_at, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`)
    .run(type, subjectType, String(subjectId), actorId, agentId, JSON.stringify(payload), dedupeKey, new Date(Date.now() + delayMs).toISOString(), ts)
  return r.changes ? Number(r.lastInsertRowid) : null
}

const toEvent = (r) => ({
  id: r.id, type: r.type, subjectType: r.subject_type, subjectId: r.subject_id, actorId: r.actor_id, agentId: r.agent_id,
  payload: JSON.parse(r.payload || '{}'), status: r.status, attempts: r.attempts, nextAttemptAt: r.next_attempt_at,
  lastError: r.last_error, result: r.result ? JSON.parse(r.result) : null, createdAt: r.created_at, processedAt: r.processed_at
})

/**
 * The processor. `handlers` maps an event type to async (event, ctx) => result. Processing is serialised in this
 * process (one drain at a time); a claim is an atomic UPDATE, and an event left 'processing' by a crash is
 * picked up again once its lease runs out. A handler may throw { permanent: true } to fail without retrying.
 */
export function createEventProcessor({ db, handlers, log = (line) => console.log(line) }) {
  let running = null
  let again = false

  function claimable(limit) {
    const ts = now()
    return db.prepare(`SELECT * FROM domain_events WHERE (status = 'pending' AND next_attempt_at <= ?) OR (status = 'processing' AND locked_until < ?)
                       ORDER BY id LIMIT ?`).all(ts, ts, limit)
  }

  async function processOne(row) {
    const ts = now()
    const claimed = db.prepare(`UPDATE domain_events SET status = 'processing', attempts = attempts + 1, locked_until = ?
                                WHERE id = ? AND ((status = 'pending' AND next_attempt_at <= ?) OR (status = 'processing' AND locked_until < ?))`)
      .run(new Date(Date.now() + LEASE_MS).toISOString(), row.id, ts, ts)
    if (claimed.changes !== 1) return null
    const event = toEvent({ ...row, attempts: row.attempts + 1 })
    const handler = handlers[event.type]
    if (!handler) {
      db.prepare("UPDATE domain_events SET status = 'skipped', result = ?, locked_until = NULL, processed_at = ? WHERE id = ?").run(JSON.stringify({ note: 'No handler for this event type (recorded for the audit trail).' }), now(), row.id)
      return 'skipped'
    }
    try {
      const result = await handler(event)
      db.prepare("UPDATE domain_events SET status = 'done', result = ?, last_error = NULL, locked_until = NULL, processed_at = ? WHERE id = ?").run(JSON.stringify(result ?? {}), now(), row.id)
      return 'done'
    } catch (error) {
      const message = String(error?.message || error).slice(0, 500)
      const final = error?.permanent || event.attempts >= MAX_ATTEMPTS
      db.prepare('UPDATE domain_events SET status = ?, last_error = ?, locked_until = NULL, next_attempt_at = ?, processed_at = ? WHERE id = ?')
        .run(final ? 'failed' : 'pending', message, new Date(Date.now() + backoffMs(event.attempts)).toISOString(), final ? now() : null, row.id)
      log(`[event] ${event.type} #${event.id} attempt ${event.attempts} ${final ? 'failed permanently' : 'will retry'}: ${message}`)
      return final ? 'failed' : 'retry'
    }
  }

  /** Processes everything due now, including events created by the handlers it runs. */
  async function drainOnce(limit = 500) {
    const totals = { done: 0, failed: 0, retry: 0, skipped: 0 }
    for (let round = 0; round < 20; round++) {
      const rows = claimable(limit)
      if (!rows.length) break
      for (const row of rows) {
        const out = await processOne(row)
        if (out) totals[out]++
      }
    }
    return totals
  }

  async function drain() {
    if (running) { again = true; return running }
    running = (async () => {
      const totals = { done: 0, failed: 0, retry: 0, skipped: 0 }
      do {
        again = false
        const t = await drainOnce()
        for (const k in totals) totals[k] += t[k]
      } while (again)
      return totals
    })().finally(() => { running = null })
    return running
  }

  return {
    drain,
    /** Starts processing soon, after the current request has answered. */
    kick() { setImmediate(() => { drain().catch((e) => log(`[event] drain error: ${e?.message}`)) }) },
    /** Waits until nothing due is left (tests, shutdown). */
    async idle() {
      for (let i = 0; i < 50; i++) {
        if (running) await running
        if (!claimable(1).length) return
        await drain()
      }
    },
    /** Puts a permanently failed event back in the queue (an operator's retry). */
    retry(id) {
      return db.prepare("UPDATE domain_events SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL WHERE id = ? AND status = 'failed'").run(now(), id).changes === 1
    }
  }
}

export function listEvents(db, { agentId, limit = 100, status = null }) {
  const rows = status
    ? db.prepare('SELECT * FROM domain_events WHERE (agent_id = ? OR actor_id = ?) AND status = ? ORDER BY id DESC LIMIT ?').all(agentId, agentId, status, limit)
    : db.prepare('SELECT * FROM domain_events WHERE agent_id = ? OR actor_id = ? ORDER BY id DESC LIMIT ?').all(agentId, agentId, limit)
  return rows.map(toEvent)
}

export const getEvent = (db, id) => { const r = db.prepare('SELECT * FROM domain_events WHERE id = ?').get(id); return r ? toEvent(r) : null }
