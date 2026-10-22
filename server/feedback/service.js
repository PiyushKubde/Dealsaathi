// Post-viewing feedback: after the broker marks a viewing as having taken place, the lead gets an email (Gmail
// via viaSocket) with a private link. The page shows only that viewing's listings and accepts one answer, which
// updates the lead's saved preferences.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { now, transaction } from '../db.js'
import { AppError, validationError } from '../errors.js'
import { getLead, logActivity } from '../leads/service.js'
import { getProperty } from '../properties/service.js'
import { emit } from '../events/bus.js'
import { gmailInput, readGmailResult, runOnce } from '../integrations/run.js'
import { finishRun, getSetting, startRun } from '../automations/store.js'
import { describeInZone, utcToZoned } from '../time.js'

export const VERDICTS = { liked: 'Liked it', too_expensive: 'Too expensive', wrong_location: 'Wrong location', wrong_size: 'Wrong size or layout', other_property: 'Interested in another property' }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const hash = (token) => createHash('sha256').update(token).digest('hex')
const inr = (n) => (n >= 1e7 ? `₹${+(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `₹${+(n / 1e5).toFixed(2)} L` : `₹${n.toLocaleString('en-IN')}`)

/** The public address the link points at: APP_BASE_URL, else the Embarko address, else this request's host. */
export function baseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '')
  if (process.env.APP_NAME && process.env.DATA_DIR) return `https://${process.env.APP_NAME}.embarko.app`
  return `${req.protocol}://${req.get('host')}`
}

function toPublic(db, row) {
  const v = db.prepare('SELECT * FROM viewings WHERE id = ?').get(row.viewing_id)
  const lead = getLead(db, row.lead_id)
  return {
    id: row.id, viewingId: row.viewing_id, leadId: row.lead_id, leadName: lead?.full_name ?? '(deleted lead)',
    viewedAt: v ? describeInZone(v.start_at, v.timezone) : null,
    properties: v ? JSON.parse(v.property_ids).map((id) => ({ id, title: getProperty(db, id)?.title ?? '(deleted listing)' })) : [],
    status: row.status, sendDetail: row.send_detail, expiresAt: row.expires_at,
    response: row.response ? JSON.parse(row.response) : null,
    preferenceChanges: row.preference_changes ? JSON.parse(row.preference_changes) : [],
    submittedAt: row.submitted_at, createdAt: row.created_at
  }
}

export function listFeedback(db, userId) {
  return db.prepare('SELECT * FROM feedback_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 200').all(userId).map((r) => toPublic(db, r))
}

async function sendLink(db, vs, user, row, token, link) {
  const cfg = getSetting(db, user.id, 'viewing_feedback').config
  const lead = getLead(db, row.lead_id)
  const v = db.prepare('SELECT * FROM viewings WHERE id = ?').get(row.viewing_id)
  const titles = JSON.parse(v.property_ids).map((id) => getProperty(db, id)?.title).filter(Boolean)
  const body = `Hi ${lead.full_name.split(' ')[0]},\n\nThank you for visiting ${titles.join(', ')} on ${describeInZone(v.start_at, v.timezone)}.\n\nCould you tell me what you thought? It takes under a minute:\n${link}\n\nYour answer helps me find better matches for you.\n\nBest regards,\n${user.name}`
  const ran = await runOnce(db, vs, user.id, cfg.gmailConnectionId, 'gmail_send_email', gmailInput({ to: lead.email, subject: 'How was your property viewing?', body, fromName: user.name }))
  if (ran.outcome !== 'answered') return { status: ran.outcome === 'unknown' ? 'send_unknown' : 'send_failed', detail: ran.reason }
  const read = readGmailResult(ran.result)
  if (!read.ok) return { status: read.unknown ? 'send_unknown' : 'send_failed', detail: read.reason }
  return { status: 'sent', detail: `Emailed ${lead.email} (Gmail message id ${read.messageId})` }
}

/**
 * After a viewing is marked completed: one feedback request per viewing, emailed when the Post-Viewing
 * Feedback automation is on. Returns what happened, in words the broker can act on.
 */
export async function onViewingCompleted(db, vs, user, viewingId, base) {
  const v = db.prepare('SELECT * FROM viewings WHERE id = ? AND user_id = ?').get(viewingId, user.id)
  if (!v || v.status !== 'completed') throw new AppError(409, 'viewing_not_completed', 'Feedback is requested only for a viewing that took place.')
  const lead = getLead(db, v.lead_id)
  // A registered buyer is asked in the app (the viewing.completed event notifies them); no email is needed.
  if (lead?.buyer_user_id) return { status: 'in_app', detail: 'This buyer has a DealSaathi account: they were asked for feedback in the app.' }
  const s = getSetting(db, user.id, 'viewing_feedback')
  if (!s.enabled || !s.config.gmailConnectionId) return { status: 'off', detail: 'Post-Viewing Feedback is off, so no feedback request was sent.' }
  if (!lead?.email || !EMAIL_RE.test(lead.email)) return { status: 'no_email', detail: 'The lead has no email address, so no feedback request was sent.' }
  if (db.prepare('SELECT 1 FROM feedback_requests WHERE viewing_id = ?').get(viewingId)) return { status: 'exists', detail: 'A feedback request already exists for this viewing.' }

  const token = randomBytes(32).toString('base64url')
  const id = randomUUID()
  const expires = new Date(Date.now() + (s.config.expiryDays ?? 14) * 86400000).toISOString()
  try {
    db.prepare(`INSERT INTO feedback_requests (id, viewing_id, lead_id, user_id, token_hash, status, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'created', ?, ?, ?)`)
      .run(id, viewingId, v.lead_id, user.id, hash(token), expires, now(), now())
  } catch {
    return { status: 'exists', detail: 'A feedback request already exists for this viewing.' }
  }
  return deliver(db, vs, user, id, token, base, 'Viewing marked completed')
}

async function deliver(db, vs, user, id, token, base, trigger) {
  const row = db.prepare('SELECT * FROM feedback_requests WHERE id = ?').get(id)
  const runId = startRun(db, { userId: user.id, key: 'viewing_feedback', trigger, subjectType: 'viewing', subjectId: row.viewing_id })
  const out = await sendLink(db, vs, user, row, token, `${base}/feedback/${token}`)
  transaction(db, () => {
    db.prepare('UPDATE feedback_requests SET status = ?, send_detail = ?, updated_at = ? WHERE id = ?').run(out.status, out.detail, now(), id)
    if (out.status === 'sent') logActivity(db, row.lead_id, 'feedback_requested', 'Feedback request emailed after the viewing', { feedbackId: id }, 'gmail', user.id)
    finishRun(db, runId, { status: out.status === 'sent' ? 'succeeded' : out.status === 'send_unknown' ? 'unknown' : 'failed', summary: out.status === 'sent' ? out.detail : 'Feedback request not sent', error: out.status === 'sent' ? null : out.detail })
  })
  return { status: out.status, detail: out.detail, request: toPublic(db, db.prepare('SELECT * FROM feedback_requests WHERE id = ?').get(id)) }
}

/** Sends a failed request again with a fresh link (the old one stops working). Unknown ones need a confirmation. */
export async function resendFeedback(db, vs, user, id, base, { confirm = false } = {}) {
  const row = db.prepare('SELECT * FROM feedback_requests WHERE id = ? AND user_id = ?').get(id, user.id)
  if (!row) throw new AppError(404, 'feedback_not_found', 'No such feedback request.')
  if (!['send_failed', 'send_unknown', 'created'].includes(row.status)) throw new AppError(409, 'feedback_closed', `This request is ${row.status}.`)
  if (row.status === 'send_unknown' && !confirm) throw new AppError(409, 'outcome_unknown', 'The last email got no answer; check your Gmail Sent folder first, then confirm to send again.')
  const token = randomBytes(32).toString('base64url')
  db.prepare('UPDATE feedback_requests SET token_hash = ?, updated_at = ? WHERE id = ?').run(hash(token), now(), id)
  return deliver(db, vs, user, id, token, base, 'Broker resent the feedback request')
}

function requestFor(db, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null
  return db.prepare('SELECT * FROM feedback_requests WHERE token_hash = ?').get(hash(token))
}

/** What the public page shows: the lead's first name, the date and the viewed listings. Nothing else. */
export function publicFeedback(db, token) {
  const row = requestFor(db, token)
  if (!row) throw new AppError(404, 'not_found', 'This feedback link is not valid.')
  const v = db.prepare('SELECT * FROM viewings WHERE id = ?').get(row.viewing_id)
  const lead = getLead(db, row.lead_id)
  const state = row.status === 'submitted' ? 'submitted' : row.expires_at < now() ? 'expired' : 'open'
  return {
    state,
    firstName: lead ? lead.full_name.split(' ')[0] : '',
    viewedOn: v ? utcToZoned(v.start_at, v.timezone).date : null,
    properties: v ? JSON.parse(v.property_ids).map((id) => getProperty(db, id)).filter(Boolean).map((p) => ({ id: p.id, title: p.title, area: [p.locality, p.city].filter(Boolean).join(', ') })) : [],
    verdicts: VERDICTS
  }
}

/** A price-too-high answer means the lead's limit is below that price: the next round lakh (or thousand) down. */
const below = (price) => (price >= 200000 ? Math.floor((price - 1) / 100000) * 100000 : Math.floor((price - 1) / 1000) * 1000)

/** Saves the one answer through the emailed link. */
export function submitFeedback(db, token, input) {
  const row = requestFor(db, token)
  if (!row) throw new AppError(404, 'not_found', 'This feedback link is not valid.')
  return applyFeedback(db, row, input, null)
}

/** A registered buyer answers in the app, for their own completed viewing. */
export function submitBuyerFeedback(db, buyer, viewingId, input) {
  const prof = db.prepare('SELECT lead_id FROM buyer_profiles WHERE user_id = ?').get(buyer.id)
  const v = prof?.lead_id ? db.prepare('SELECT * FROM viewings WHERE id = ? AND lead_id = ?').get(viewingId, prof.lead_id) : null
  if (!v) throw new AppError(404, 'viewing_not_found', 'No such viewing.')
  if (v.status !== 'completed') throw new AppError(409, 'viewing_not_completed', 'Feedback opens once your agent marks the viewing as having taken place.')
  let row = db.prepare('SELECT * FROM feedback_requests WHERE viewing_id = ?').get(v.id)
  if (!row) {
    const id = randomUUID()
    db.prepare(`INSERT INTO feedback_requests (id, viewing_id, lead_id, user_id, token_hash, status, send_detail, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'created', 'Answered in the app', ?, ?, ?) ON CONFLICT (viewing_id) DO NOTHING`)
      .run(id, v.id, v.lead_id, v.user_id, hash(randomBytes(32).toString('base64url')), new Date(Date.now() + 60 * 86400000).toISOString(), now(), now())
    row = db.prepare('SELECT * FROM feedback_requests WHERE viewing_id = ?').get(v.id)
  }
  return applyFeedback(db, row, input, buyer.id)
}

/** Saves the one answer and updates the lead's preferences from it. A second submission is refused. */
function applyFeedback(db, row, input, actorId) {
  const v = db.prepare('SELECT * FROM viewings WHERE id = ?').get(row.viewing_id)
  const viewed = new Set(JSON.parse(v.property_ids))
  const answers = Array.isArray(input?.responses) ? input.responses : []
  if (!answers.length) throw validationError({ responses: 'Choose an answer for at least one property.' })
  const seen = new Set()
  const clean = answers.map((a) => {
    const pid = Number(a?.propertyId)
    if (!viewed.has(pid) || seen.has(pid)) throw validationError({ responses: 'Answer only for the properties you viewed.' })
    if (!VERDICTS[a?.verdict]) throw validationError({ responses: 'Choose one of the listed answers.' })
    seen.add(pid)
    return { propertyId: pid, verdict: a.verdict }
  })
  const comments = typeof input?.comments === 'string' ? input.comments.trim().slice(0, 1000) : ''

  return transaction(db, () => {
    const claimed = db.prepare("UPDATE feedback_requests SET status = 'submitted', submitted_at = ?, updated_at = ? WHERE id = ? AND status != 'submitted' AND expires_at > ?").run(now(), now(), row.id, now())
    if (!claimed.changes) {
      const cur = db.prepare('SELECT status FROM feedback_requests WHERE id = ?').get(row.id)
      throw new AppError(409, cur.status === 'submitted' ? 'already_submitted' : 'expired', cur.status === 'submitted' ? 'Thank you: your feedback was already received.' : 'This feedback link has expired.')
    }
    const lead = getLead(db, row.lead_id)
    const changes = []
    let budgetMax = lead.budget_max
    const excluded = new Set(JSON.parse(lead.excluded_localities || '[]'))
    for (const { propertyId, verdict } of clean) {
      const p = getProperty(db, propertyId)
      if (!p || verdict === 'liked') continue
      db.prepare('INSERT INTO lead_property_exclusions (lead_id, property_id, reason, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (lead_id, property_id) DO UPDATE SET reason = excluded.reason')
        .run(lead.id, p.id, verdict, now())
      changes.push(`${p.title}: no longer recommended (${VERDICTS[verdict].toLowerCase()})`)
      if (verdict === 'too_expensive') {
        const cap = below(p.price)
        if (budgetMax == null || cap < budgetMax) { budgetMax = cap; changes.push(`Maximum budget lowered to ${inr(cap)} (below ${inr(p.price)})`) }
      }
      if (verdict === 'wrong_location') {
        const area = (p.locality || p.city || '').trim().toLowerCase()
        if (area && !excluded.has(area)) { excluded.add(area); changes.push(`${p.locality || p.city} left out of future matches`) }
      }
    }
    db.prepare('UPDATE leads SET budget_max = ?, excluded_localities = ?, updated_at = ? WHERE id = ?')
      .run(budgetMax, excluded.size ? JSON.stringify([...excluded]) : null, now(), lead.id)
    db.prepare('UPDATE feedback_requests SET response = ?, preference_changes = ? WHERE id = ?').run(JSON.stringify({ answers: clean, comments }), JSON.stringify(changes), row.id)
    const summary = clean.map((c) => `${getProperty(db, c.propertyId)?.title ?? 'a listing'}: ${VERDICTS[c.verdict]}`).join('; ')
    logActivity(db, lead.id, 'feedback_received', `Viewing feedback: ${summary}${comments ? ` (comment: “${comments.slice(0, 200)}”)` : ''}`, { feedbackId: row.id, changes }, 'feedback', actorId)
    if (changes.length) logActivity(db, lead.id, 'preferences_updated', `Preferences updated from feedback: ${changes.join('; ')}`, { feedbackId: row.id }, 'feedback', actorId)
    // Matches are recalculated from the queue, in the same way as any other requirements change.
    emit(db, 'feedback.submitted', { subjectType: 'feedback', subjectId: row.id, actorId, agentId: row.user_id, dedupeKey: `feedback.submitted:${row.id}` })
    emit(db, 'lead.requirements_changed', { subjectType: 'lead', subjectId: lead.id, actorId, agentId: lead.assigned_agent_id, payload: { fields: ['feedback'], via: 'feedback' }, dedupeKey: `lead.requirements_changed:feedback:${row.id}` })
    return { received: true, changes }
  })
}
