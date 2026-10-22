// Property viewings booked in the broker's own Google Calendar through viaSocket (Get Free/Busy, Create Event,
// Update Event, Delete Event), with an optional Gmail confirmation to the lead.
//
// Create Calendar Event V23 inputData, every key decided:
//   calendar_id      PICK: the broker's calendar, chosen in the automation's settings
//   summary          product data: "Property viewing: <lead> – <listing>"
//   description      product data: the listings and their addresses
//   attendees        REQUIRED (non-empty) by the action: the lead's saved email when the broker invites them, otherwise
//                    the calendar owner's own address (the organiser: no invitation goes to anyone). An empty value
//                    was answered "Bad Request" in production.
//   timeZone         the broker's setting (one of the action's 20 zones)
//   startdate/starttime/meeting_duration  the slot the broker picked, written in that zone (DD-MM-YYYY, HH:MM, HH:MM)
//   location         REQUIRED: the listings' address, locality and city (never empty)
//   status           constant "confirmed"
//   transparency     constant "opaque" (Busy), so the viewing blocks the slot in later free/busy checks
//   colorId, recurrence, useDefault, visibility, guestsCanModify: left out on purpose (defaults)
import { randomUUID } from 'node:crypto'
import { now, transaction } from '../db.js'
import { AppError, validationError } from '../errors.js'
import { getLead, logActivity, requireLead } from '../leads/service.js'
import { getProperty } from '../properties/service.js'
import { CREATE_EVENT_EXPLICIT, gmailInput, readCalendarEvent, readFreeBusy, readGmailResult, runOnce } from '../integrations/run.js'
import { finishRun, getSetting, startRun } from '../automations/store.js'
import { addDays, describeInZone, hhmm, todayIn, utcToZoned, zonedToUtc } from '../time.js'
import { emit } from '../events/bus.js'

const SLOT_STEP_MIN = 30
const LEAD_TIME_MS = 30 * 60 * 1000 // no slot that starts in the next 30 minutes
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/** The viewing settings, or a 409 saying what is missing. */
export function viewingSettings(db, userId) {
  const s = getSetting(db, userId, 'viewing_scheduler')
  if (!s.enabled || !s.config.calendarConnectionId || !s.config.calendarId) {
    throw new AppError(409, 'needs_setup', 'Switch on the Property Viewing Scheduler on the Automations page first (it needs your Google Calendar).')
  }
  return { timezone: 'Asia/Kolkata', dayStart: '09:00', dayEnd: '19:00', durationMinutes: 60, confirmation: 'none', ...s.config }
}

function toPublic(db, row) {
  if (!row) return null
  const lead = getLead(db, row.lead_id)
  const ids = JSON.parse(row.property_ids)
  const local = utcToZoned(row.start_at, row.timezone)
  const fb = db.prepare('SELECT status, submitted_at FROM feedback_requests WHERE viewing_id = ?').get(row.id)
  return {
    id: row.id, leadId: row.lead_id, leadName: lead?.full_name ?? '(deleted lead)', leadEmail: lead?.email ?? null,
    properties: ids.map((id) => { const p = getProperty(db, id); return p ? { id, title: p.title, locality: p.locality, city: p.city } : { id, title: '(deleted listing)' } }),
    startAt: row.start_at, endAt: row.end_at, timezone: row.timezone, localDate: local.date, localTime: local.time,
    durationMinutes: Math.round((Date.parse(row.end_at) - Date.parse(row.start_at)) / 60000),
    when: describeInZone(row.start_at, row.timezone), location: row.location, inviteLead: Boolean(row.invite_lead), note: row.note,
    status: row.status, eventId: row.event_id, eventLink: row.event_link, error: row.error,
    confirmationStatus: row.confirmation_status, confirmationDetail: row.confirmation_detail,
    ended: Date.parse(row.end_at) <= Date.now(), outcomeAt: row.outcome_at,
    feedback: fb ? { status: fb.status, submittedAt: fb.submitted_at } : null,
    requestedByBuyer: Boolean(row.requested_by), createdAt: row.created_at, updatedAt: row.updated_at
  }
}

const own = (db, userId, id) => {
  const row = db.prepare('SELECT * FROM viewings WHERE id = ? AND user_id = ?').get(id, userId)
  if (!row) throw new AppError(404, 'viewing_not_found', 'No such viewing.')
  return row
}

export const getViewing = (db, userId, id) => toPublic(db, own(db, userId, id))

export function listViewings(db, userId, { leadId } = {}) {
  const rows = leadId
    ? db.prepare('SELECT * FROM viewings WHERE user_id = ? AND lead_id = ? ORDER BY start_at DESC').all(userId, leadId)
    : db.prepare("SELECT * FROM viewings WHERE user_id = ? AND (status != 'draft' OR requested_by IS NOT NULL) ORDER BY start_at DESC LIMIT 200").all(userId)
  return rows.map((r) => toPublic(db, r))
}

/** Asks Google Calendar for the day's busy times. Throws with the reason when it cannot. */
async function busyTimes(db, vs, userId, cfg, date) {
  const ran = await runOnce(db, vs, userId, cfg.calendarConnectionId, 'calendar_free_busy', { calendar_id: cfg.calendarId, date, timeZone: cfg.timezone })
  if (ran.outcome !== 'answered') throw new AppError(502, 'calendar_unavailable', `Could not read your Google Calendar: ${ran.reason}`)
  const fb = readFreeBusy(ran.result)
  if (!fb.ok) throw new AppError(502, 'calendar_unavailable', fb.reason)
  return fb
}

const overlaps = (a0, a1, b0, b1) => a0 < b1 && b0 < a1

/** DealSaathi's own live bookings for this broker (they may not show in the calendar yet). */
const localBookings = (db, userId, exceptId) =>
  db.prepare("SELECT id, start_at, end_at FROM viewings WHERE user_id = ? AND status IN ('booking','booked') AND id != ?").all(userId, exceptId || '')
    .map((v) => ({ start: Date.parse(v.start_at), end: Date.parse(v.end_at) }))

function checkDate(date, cfg) {
  const today = todayIn(cfg.timezone)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw validationError({ date: 'Choose a date.' })
  if (date < today) throw validationError({ date: 'Choose today or a later date.' })
  if (date > addDays(today, 90)) throw validationError({ date: 'Choose a date within the next 90 days.' })
}

function checkDuration(minutes) {
  const n = Number(minutes)
  if (!Number.isInteger(n) || n < 15 || n > 240 || n % 15) throw validationError({ durationMinutes: 'Choose a length from 15 minutes to 4 hours, in 15-minute steps.' })
  return n
}

/**
 * Free slots on one day, from the broker's real Google Calendar: inside their working hours, not in the
 * past, not overlapping a busy time or one of their DealSaathi bookings. `except` ignores one viewing
 * (when rescheduling it).
 */
export async function freeSlots(db, vs, user, { date, durationMinutes, except = null }) {
  const cfg = viewingSettings(db, user.id)
  checkDate(date, cfg)
  const minutes = checkDuration(durationMinutes ?? cfg.durationMinutes)
  const fb = await busyTimes(db, vs, user.id, cfg, date)
  const exceptRow = except ? own(db, user.id, except) : null
  const ownBusy = exceptRow ? { start: Date.parse(exceptRow.start_at), end: Date.parse(exceptRow.end_at) } : null
  const busy = [
    ...fb.busy.filter((b) => !(ownBusy && b.start === ownBusy.start && b.end === ownBusy.end)),
    ...localBookings(db, user.id, except)
  ]
  const dayStart = zonedToUtc(date, cfg.dayStart, cfg.timezone).getTime()
  const dayEnd = zonedToUtc(date, cfg.dayEnd, cfg.timezone).getTime()
  const slots = []
  for (let s = dayStart; s + minutes * 60000 <= dayEnd; s += SLOT_STEP_MIN * 60000) {
    const e = s + minutes * 60000
    if (s < Date.now() + LEAD_TIME_MS) continue
    if (fb.timeMin != null && fb.timeMax != null && (s < fb.timeMin || e > fb.timeMax)) continue // not covered by the check
    if (busy.some((b) => overlaps(s, e, b.start, b.end))) continue
    slots.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString(), label: utcToZoned(s, cfg.timezone).time })
  }
  return { date, timezone: cfg.timezone, durationMinutes: minutes, workingHours: `${cfg.dayStart}–${cfg.dayEnd}`, busyCount: fb.busy.length, slots, checkedAt: now() }
}

function checkProperties(db, propertyIds) {
  if (!Array.isArray(propertyIds) || !propertyIds.length) throw validationError({ properties: 'Choose at least one property.' })
  if (propertyIds.length > 5) throw validationError({ properties: 'Choose up to 5 properties for one viewing.' })
  return [...new Set(propertyIds.map(Number))].map((id) => {
    const p = Number.isInteger(id) && getProperty(db, id)
    if (!p) throw validationError({ properties: 'One of the properties no longer exists.' })
    if (p.is_sample) throw validationError({ properties: `${p.title} is a sample listing, not a real property, so it cannot be viewed.` })
    if (p.listing_state !== 'published' || p.status !== 'available') throw validationError({ properties: `${p.title} is not on the market, so it cannot be viewed.` })
    return p
  })
}

const locationOf = (props) => props.map((p) => [p.address, p.locality, p.city].filter(Boolean).join(', ')).join(' | ').slice(0, 300)

/** The listings must still be on the market when the viewing is booked or moved (they may have sold since). */
function stillOnMarket(db, row) {
  try {
    checkProperties(db, JSON.parse(row.property_ids))
  } catch (error) {
    throw new AppError(409, 'listing_unavailable', `${error.details?.fields?.properties || 'A listing in this viewing is no longer available.'} Cancel this viewing, or create a new one without it.`)
  }
}

/** A viewing to review before booking. Nothing is sent to Google Calendar yet. */
export function draftViewing(db, user, input, { requestedBy = null } = {}) {
  const cfg = viewingSettings(db, user.id)
  const lead = requireLead(db, Number(input?.leadId))
  if (lead.assigned_agent_id !== user.id) throw new AppError(404, 'lead_not_found', 'No such lead.')
  const props = checkProperties(db, input?.propertyIds)
  const minutes = checkDuration(input?.durationMinutes ?? cfg.durationMinutes)
  const start = Date.parse(input?.start)
  if (!Number.isFinite(start)) throw validationError({ start: 'Choose a time slot.' })
  if (start < Date.now() + LEAD_TIME_MS) throw validationError({ start: 'Choose a slot at least 30 minutes from now.' })
  const inviteLead = input?.inviteLead === true
  if (inviteLead && !(lead.email && EMAIL_RE.test(lead.email))) throw validationError({ inviteLead: 'This lead has no email address to invite.' })
  const note = typeof input?.note === 'string' ? input.note.trim().slice(0, 500) : null
  const id = randomUUID()
  const ts = now()
  transaction(db, () => {
    db.prepare(`INSERT INTO viewings (id, user_id, lead_id, property_ids, calendar_connection_id, calendar_id, start_at, end_at, timezone, location, invite_lead, note, status, requested_by, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`)
      .run(id, user.id, lead.id, JSON.stringify(props.map((p) => p.id)), cfg.calendarConnectionId, cfg.calendarId, new Date(start).toISOString(),
        new Date(start + minutes * 60000).toISOString(), cfg.timezone, locationOf(props), inviteLead ? 1 : 0, note || null, requestedBy, ts, ts)
    if (requestedBy) {
      logActivity(db, lead.id, 'viewing_requested', `The buyer requested a viewing on ${describeInZone(new Date(start).toISOString(), cfg.timezone)}`, { viewingId: id }, 'buyer', requestedBy)
      emit(db, 'viewing.requested', { subjectType: 'viewing', subjectId: id, actorId: requestedBy, agentId: user.id, dedupeKey: `viewing.requested:${id}` })
    }
  })
  return { viewing: getViewing(db, user.id, id), confirmationWillBeSent: cfg.confirmation === 'gmail' && Boolean(lead.email) }
}

/** The calendar owner's address: the connection's account email (viaSocket's label), else an email calendar id. */
export function calendarOwnerEmail(db, connectionId, calendarId) {
  const label = db.prepare('SELECT label FROM connections WHERE id = ?').get(connectionId)?.label || ''
  return label.split(',').map((x) => x.trim()).find((x) => EMAIL_RE.test(x)) || (EMAIL_RE.test(calendarId || '') ? calendarId : null)
}

function eventInput(db, row) {
  const owner = calendarOwnerEmail(db, row.calendar_connection_id, row.calendar_id)
  const lead = getLead(db, row.lead_id)
  const props = JSON.parse(row.property_ids).map((id) => getProperty(db, id)).filter(Boolean)
  const local = utcToZoned(row.start_at, row.timezone)
  const minutes = Math.round((Date.parse(row.end_at) - Date.parse(row.start_at)) / 60000)
  return {
    calendar_id: row.calendar_id,
    summary: `Property viewing: ${lead.full_name} – ${props.map((p) => p.title).join(', ')}`.slice(0, 250),
    description: [`Viewing with ${lead.full_name}.`, '', 'Properties:', ...props.map((p) => `• ${p.title} (${[p.address, p.locality, p.city].filter(Boolean).join(', ')})`),
      ...(row.note ? ['', `Note: ${row.note}`] : []), '', 'Booked with DealSaathi.'].join('\n'),
    attendees: row.invite_lead && lead.email ? lead.email : owner,
    timeZone: row.timezone,
    startdate: local.dmy,
    starttime: local.time,
    meeting_duration: hhmm(minutes),
    location: row.location || 'Address shared by your agent',
    status: 'confirmed',
    transparency: 'opaque',
    ...CREATE_EVENT_EXPLICIT
  }
}

/** Gmail confirmation (or update/cancellation) to the lead, when the broker set Gmail as the channel. */
async function notifyLead(db, vs, user, row, cfg, kind) {
  const lead = getLead(db, row.lead_id)
  if (cfg.confirmation !== 'gmail' || !cfg.gmailConnectionId) return { status: 'not_configured', detail: 'No confirmation channel is set (Automations → Property Viewing Scheduler).' }
  if (!lead?.email || !EMAIL_RE.test(lead.email)) return { status: 'not_configured', detail: 'The lead has no email address, so no confirmation was sent.' }
  const props = JSON.parse(row.property_ids).map((id) => getProperty(db, id)).filter(Boolean)
  const when = describeInZone(row.start_at, row.timezone)
  const minutes = Math.round((Date.parse(row.end_at) - Date.parse(row.start_at)) / 60000)
  const subject = kind === 'cancelled' ? `Viewing cancelled: ${when}` : kind === 'rescheduled' ? `Viewing moved to ${when}` : `Your property viewing: ${when}`
  const lines = props.map((p) => `• ${p.title}, ${[p.address, p.locality, p.city].filter(Boolean).join(', ')}`)
  const body = kind === 'cancelled'
    ? `Hi ${lead.full_name.split(' ')[0]},\n\nThe viewing planned for ${when} has been cancelled:\n\n${lines.join('\n')}\n\nReply to this email if you would like a new time.\n\nBest regards,\n${user.name}`
    : `Hi ${lead.full_name.split(' ')[0]},\n\n${kind === 'rescheduled' ? 'Your viewing has moved. The new time is' : 'Your property viewing is booked for'} ${when} (about ${minutes} minutes):\n\n${lines.join('\n')}\n\nReply to this email if you need to change the time.\n\nBest regards,\n${user.name}`
  const ran = await runOnce(db, vs, user.id, cfg.gmailConnectionId, 'gmail_send_email', gmailInput({ to: lead.email, subject, body, fromName: user.name }))
  if (ran.outcome !== 'answered') return { status: ran.outcome === 'unknown' ? 'unknown' : 'failed', detail: ran.reason }
  const read = readGmailResult(ran.result)
  if (!read.ok) return { status: read.unknown ? 'unknown' : 'failed', detail: read.reason }
  return { status: 'sent', detail: `Emailed ${lead.email} (Gmail message id ${read.messageId})` }
}

async function recheck(db, vs, user, row, cfg, except = null) {
  const date = utcToZoned(row.start_at, row.timezone).date
  const fb = await busyTimes(db, vs, user.id, cfg, date)
  const s = Date.parse(row.start_at)
  const e = Date.parse(row.end_at)
  const ownBusy = except ? { start: Date.parse(except.start_at), end: Date.parse(except.end_at) } : null
  const conflict = fb.busy.filter((b) => !(ownBusy && b.start === ownBusy.start && b.end === ownBusy.end)).some((b) => overlaps(s, e, b.start, b.end))
    || localBookings(db, user.id, except?.id ?? row.id).some((b) => overlaps(s, e, b.start, b.end))
  if (conflict) throw new AppError(409, 'slot_taken', 'That time is no longer free in your calendar. Choose another slot.')
}

/**
 * Books a reviewed viewing: re-checks the calendar for that slot, then creates the event. It is booked only
 * when Google Calendar returns an event id. A failed booking can be retried; an unknown one only after the
 * broker confirms it is not in their calendar (so it is never created twice).
 */
export async function bookViewing(db, vs, user, id, { confirmNotInCalendar = false } = {}) {
  const cfg = viewingSettings(db, user.id)
  const row = own(db, user.id, id)
  if (row.status === 'booked') return { alreadyBooked: true, viewing: toPublic(db, row) }
  if (row.status === 'unknown' && !confirmNotInCalendar) throw new AppError(409, 'outcome_unknown', 'The last booking attempt got no answer. Check your Google Calendar first; if the viewing is not there, confirm and book again.')
  if (!['draft', 'failed', 'unknown'].includes(row.status)) throw new AppError(409, 'viewing_closed', `This viewing is ${row.status}.`)
  if (Date.parse(row.start_at) < Date.now() + LEAD_TIME_MS) throw new AppError(409, 'slot_past', 'This slot is too soon or has passed. Choose another time.')
  stillOnMarket(db, row)

  await recheck(db, vs, user, row, cfg)
  // Built before the claim, so a missing owner address can never leave the viewing stuck in 'booking'.
  const input = eventInput(db, row)
  if (!input.attendees) throw new AppError(409, 'calendar_owner_unknown', 'DealSaathi cannot tell which email owns this Google Calendar connection. Reconnect Google Calendar on the Integrations page, or invite the lead to this viewing.')
  try {
    const claimed = db.prepare("UPDATE viewings SET status = 'booking', error = NULL, updated_at = ? WHERE id = ? AND status IN ('draft','failed','unknown')").run(now(), id)
    if (claimed.changes !== 1) throw new AppError(409, 'viewing_busy', 'This viewing is already being booked.')
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(409, 'slot_taken', 'You already have a viewing booked at this time.')
  }

  const runId = startRun(db, { userId: user.id, key: 'viewing_scheduler', trigger: 'Broker confirmed a viewing', subjectType: 'viewing', subjectId: id })
  const ran = await runOnce(db, vs, user.id, row.calendar_connection_id, 'calendar_create_event', input)
  const read = ran.outcome === 'answered' ? readCalendarEvent(ran.result) : { ok: false, unknown: ran.outcome === 'unknown', reason: ran.reason }
  const lead = getLead(db, row.lead_id)
  if (!read.ok) {
    const status = read.unknown && !ran.notSent ? 'unknown' : 'failed'
    transaction(db, () => {
      db.prepare('UPDATE viewings SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(status, read.reason, now(), id)
      logActivity(db, row.lead_id, `viewing_${status}`, `Viewing on ${describeInZone(row.start_at, row.timezone)} ${status === 'failed' ? 'was not booked' : 'may not be booked'}: ${read.reason}`, { viewingId: id }, 'calendar', user.id)
      finishRun(db, runId, { status, summary: `Viewing with ${lead.full_name} not booked`, error: read.reason })
    })
    return { viewing: getViewing(db, user.id, id) }
  }
  transaction(db, () => {
    db.prepare("UPDATE viewings SET status = 'booked', event_id = ?, event_link = ?, error = NULL, updated_at = ? WHERE id = ?").run(read.eventId, read.link, now(), id)
    logActivity(db, row.lead_id, 'viewing_booked', `Viewing booked in Google Calendar for ${describeInZone(row.start_at, row.timezone)}`, { viewingId: id, eventId: read.eventId }, 'calendar', user.id)
    emit(db, 'viewing.booked', { subjectType: 'viewing', subjectId: id, actorId: user.id, agentId: user.id, payload: { eventId: read.eventId }, dedupeKey: `viewing.booked:${id}:${row.start_at}` })
  })
  console.log(`[viewing] ${id} booked calendar_event=${read.eventId}`)
  const note = await notifyLead(db, vs, user, row, cfg, 'booked')
  db.prepare('UPDATE viewings SET confirmation_status = ?, confirmation_detail = ?, updated_at = ? WHERE id = ?').run(note.status, note.detail, now(), id)
  if (note.status === 'sent') logActivity(db, row.lead_id, 'viewing_confirmation_sent', `Viewing confirmation emailed to ${lead.email}`, { viewingId: id }, 'gmail', user.id)
  finishRun(db, runId, { status: 'succeeded', summary: `Booked ${lead.full_name} for ${describeInZone(row.start_at, row.timezone)} (event ${read.eventId}); confirmation: ${note.status.replace('_', ' ')}` })
  return { viewing: getViewing(db, user.id, id) }
}

/** Retries a confirmation that failed (never one whose outcome is unknown). */
export async function resendConfirmation(db, vs, user, id) {
  const cfg = viewingSettings(db, user.id)
  const row = own(db, user.id, id)
  if (row.status !== 'booked') throw new AppError(409, 'viewing_not_booked', 'Only a booked viewing has a confirmation to send.')
  if (row.confirmation_status === 'sent') throw new AppError(409, 'already_sent', 'The confirmation was already sent.')
  if (row.confirmation_status === 'unknown') throw new AppError(409, 'outcome_unknown', 'The last confirmation got no answer; check your Gmail Sent folder instead of sending it again.')
  const note = await notifyLead(db, vs, user, row, cfg, 'booked')
  db.prepare('UPDATE viewings SET confirmation_status = ?, confirmation_detail = ?, updated_at = ? WHERE id = ?').run(note.status, note.detail, now(), id)
  return { viewing: getViewing(db, user.id, id) }
}

/** Cancels: deletes the calendar event first (if there is one); the viewing is cancelled only when that works. */
export async function cancelViewing(db, vs, user, id, { notifyLead: tell = true, actorId = null } = {}) {
  const row = own(db, user.id, id)
  if (row.status === 'cancelled') return { viewing: toPublic(db, row) }
  if (['completed', 'no_show'].includes(row.status)) throw new AppError(409, 'viewing_closed', 'This viewing already took place (or was missed).')
  if (row.status === 'booking') throw new AppError(409, 'viewing_busy', 'This viewing is being booked right now.')
  const cfg = getSetting(db, user.id, 'viewing_scheduler').config
  const runId = startRun(db, { userId: user.id, key: 'viewing_scheduler', trigger: 'Broker cancelled a viewing', subjectType: 'viewing', subjectId: id })
  if (row.status === 'booked' && row.event_id) {
    const ran = await runOnce(db, vs, user.id, row.calendar_connection_id, 'calendar_delete_event', { calendarId: row.calendar_id, eventId: row.event_id, sendUpdates: row.invite_lead ? 'all' : 'none' })
    const failed = ran.outcome === 'failed' || (ran.outcome === 'answered' && (ran.result?.success === false || ran.result?.error))
    if (ran.outcome !== 'answered' || failed) {
      const reason = ran.reason || String(ran.result?.message || ran.result?.error || 'Google Calendar refused')
      db.prepare('UPDATE viewings SET error = ?, updated_at = ? WHERE id = ?').run(`Cancel failed: ${reason}`, now(), id)
      finishRun(db, runId, { status: ran.outcome === 'unknown' ? 'unknown' : 'failed', summary: 'Viewing not cancelled in Google Calendar', error: reason })
      throw new AppError(502, 'cancel_failed', `The calendar event could not be removed, so the viewing is still booked: ${reason}`)
    }
  }
  const wasBooked = row.status === 'booked'
  transaction(db, () => {
    db.prepare("UPDATE viewings SET status = 'cancelled', outcome_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), id)
    logActivity(db, row.lead_id, 'viewing_cancelled', `Viewing on ${describeInZone(row.start_at, row.timezone)} cancelled${wasBooked ? ' and removed from Google Calendar' : ''}`, { viewingId: id }, 'calendar', actorId ?? user.id)
    emit(db, 'viewing.cancelled', { subjectType: 'viewing', subjectId: id, actorId: actorId ?? user.id, agentId: user.id, dedupeKey: `viewing.cancelled:${id}` })
  })
  let note = null
  if (wasBooked && tell && row.confirmation_status === 'sent') note = await notifyLead(db, vs, user, row, { timezone: 'Asia/Kolkata', ...cfg }, 'cancelled')
  finishRun(db, runId, { status: 'succeeded', summary: `Viewing cancelled${note ? `; lead notified: ${note.status.replace('_', ' ')}` : ''}` })
  return { viewing: getViewing(db, user.id, id), leadNotified: note?.status ?? null }
}

/** Moves a booked viewing: re-checks the new slot, then updates the calendar event; saved only when that works. */
export async function rescheduleViewing(db, vs, user, id, { start, durationMinutes }) {
  const cfg = viewingSettings(db, user.id)
  const row = own(db, user.id, id)
  if (row.status !== 'booked' || !row.event_id) throw new AppError(409, 'viewing_not_booked', 'Only a booked viewing can be moved.')
  const s = Date.parse(start)
  if (!Number.isFinite(s) || s < Date.now() + LEAD_TIME_MS) throw validationError({ start: 'Choose a slot at least 30 minutes from now.' })
  const minutes = checkDuration(durationMinutes ?? Math.round((Date.parse(row.end_at) - Date.parse(row.start_at)) / 60000))
  stillOnMarket(db, row)
  const moved = { ...row, start_at: new Date(s).toISOString(), end_at: new Date(s + minutes * 60000).toISOString() }
  await recheck(db, vs, user, moved, cfg, row)
  const local = utcToZoned(moved.start_at, row.timezone)
  const runId = startRun(db, { userId: user.id, key: 'viewing_scheduler', trigger: 'Broker moved a viewing', subjectType: 'viewing', subjectId: id })
  const ran = await runOnce(db, vs, user.id, row.calendar_connection_id, 'calendar_update_event', {
    calendar_id: row.calendar_id, eventId: row.event_id, startdate: local.dmy, starttime: local.time, meeting_duration: hhmm(minutes), timeZone: row.timezone
  })
  const read = ran.outcome === 'answered' ? readCalendarEvent(ran.result) : { ok: false, unknown: ran.outcome === 'unknown', reason: ran.reason }
  if (!read.ok) {
    finishRun(db, runId, { status: read.unknown ? 'unknown' : 'failed', summary: 'Viewing not moved', error: read.reason })
    throw new AppError(502, 'reschedule_failed', `The calendar event was not moved, so the viewing keeps its old time: ${read.reason}`)
  }
  try {
    transaction(db, () => {
      db.prepare("UPDATE viewings SET start_at = ?, end_at = ?, ended_noticed_at = NULL, updated_at = ? WHERE id = ?").run(moved.start_at, moved.end_at, now(), id)
      logActivity(db, row.lead_id, 'viewing_rescheduled', `Viewing moved to ${describeInZone(moved.start_at, row.timezone)}`, { viewingId: id }, 'calendar', user.id)
      emit(db, 'viewing.rescheduled', { subjectType: 'viewing', subjectId: id, actorId: user.id, agentId: user.id, dedupeKey: `viewing.rescheduled:${id}:${moved.start_at}` })
    })
  } catch {
    throw new AppError(409, 'slot_taken', 'You already have another viewing at that time.')
  }
  const note = row.confirmation_status === 'sent' ? await notifyLead(db, vs, user, moved, cfg, 'rescheduled') : null
  finishRun(db, runId, { status: 'succeeded', summary: `Viewing moved to ${describeInZone(moved.start_at, row.timezone)}${note ? `; lead notified: ${note.status.replace('_', ' ')}` : ''}` })
  return { viewing: getViewing(db, user.id, id), leadNotified: note?.status ?? null }
}

/** The broker says whether a viewing took place. The clock alone never decides. */
export function setOutcome(db, user, id, outcome) {
  if (!['completed', 'no_show'].includes(outcome)) throw validationError({ outcome: 'Choose completed or no-show.' })
  const row = own(db, user.id, id)
  if (row.status !== 'booked') throw new AppError(409, 'viewing_not_booked', `This viewing is ${row.status}.`)
  if (Date.parse(row.start_at) > Date.now()) throw new AppError(409, 'not_started', 'This viewing has not started yet.')
  transaction(db, () => {
    db.prepare('UPDATE viewings SET status = ?, outcome_at = ?, updated_at = ? WHERE id = ?').run(outcome, now(), now(), id)
    db.prepare("UPDATE reminders SET status = 'done', updated_at = ? WHERE dedupe_key = ?").run(now(), `viewing:${id}`)
    logActivity(db, row.lead_id, `viewing_${outcome}`, `Viewing on ${describeInZone(row.start_at, row.timezone)} ${outcome === 'completed' ? 'took place' : 'did not happen (no-show)'}`, { viewingId: id }, 'calendar', user.id)
    if (outcome === 'completed') emit(db, 'viewing.completed', { subjectType: 'viewing', subjectId: id, actorId: user.id, agentId: user.id, dedupeKey: `viewing.completed:${id}` })
  })
  return own(db, user.id, id)
}

/**
 * Scheduler: booked viewings whose end time has passed get one reminder for the broker to say whether they
 * took place. Nothing is marked completed here.
 */
export function noticeEndedViewings(db) {
  const rows = db.prepare("SELECT * FROM viewings WHERE status = 'booked' AND end_at <= ? AND ended_noticed_at IS NULL").all(now())
  for (const v of rows) {
    transaction(db, () => {
      db.prepare('UPDATE viewings SET ended_noticed_at = ? WHERE id = ?').run(now(), v.id)
      db.prepare(`INSERT INTO reminders (user_id, lead_id, reason, detail, status, dedupe_key, created_at, updated_at) VALUES (?, ?, 'viewing_outcome', ?, 'open', ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`)
        .run(v.user_id, v.lead_id, `The viewing on ${describeInZone(v.start_at, v.timezone)} has ended: mark whether it took place`, `viewing:${v.id}`, now(), now())
    })
  }
  return rows.length
}

// ---- The buyer's side. A registered buyer books through the agent assigned to them, in that agent's calendar.

function buyerContext(db, buyer) {
  const prof = db.prepare('SELECT lead_id, matching_consent FROM buyer_profiles WHERE user_id = ?').get(buyer.id)
  const lead = prof?.lead_id ? getLead(db, prof.lead_id) : null
  if (!lead) throw new AppError(409, 'no_requirements', 'Save your requirements first.')
  if (!lead.assigned_agent_id) throw new AppError(409, 'no_agent', 'No agent is assigned to you yet, so viewings cannot be booked. An agent will pick up your requirements soon.')
  const agent = db.prepare("SELECT id, name, email, role FROM users WHERE id = ? AND role = 'agent'").get(lead.assigned_agent_id)
  if (!agent) throw new AppError(409, 'no_agent', 'Your agent is no longer available.')
  const s = getSetting(db, agent.id, 'viewing_scheduler')
  if (!s.enabled) throw new AppError(409, 'agent_calendar_off', `${agent.name} does not take viewing requests in DealSaathi yet. Contact them directly.`)
  return { lead, agent: { ...agent } }
}

/** Free times in the assigned agent's real calendar, for one listing the buyer can see. */
export async function buyerSlots(db, vs, buyer, { propertyId, date }) {
  const { agent } = buyerContext(db, buyer)
  checkProperties(db, [propertyId])
  const out = await freeSlots(db, vs, agent, { date })
  return { ...out, agentName: agent.name }
}

/** A requested viewing: free in the agent's calendar now, booked only when the agent confirms (re-checked then). */
export async function requestViewing(db, vs, buyer, input) {
  const { lead, agent } = buyerContext(db, buyer)
  const ids = Array.isArray(input?.propertyIds) ? input.propertyIds : [input?.propertyId]
  const start = Date.parse(input?.start)
  const cfg = viewingSettings(db, agent.id)
  if (!Number.isFinite(start)) throw validationError({ start: 'Choose a time slot.' })
  const date = utcToZoned(new Date(start).toISOString(), cfg.timezone).date
  const free = await freeSlots(db, vs, agent, { date })
  if (!free.slots.some((sl) => Date.parse(sl.start) === start)) throw new AppError(409, 'slot_taken', 'That time is no longer free. Choose another slot.')
  const open = db.prepare("SELECT COUNT(*) AS n FROM viewings WHERE lead_id = ? AND status = 'draft' AND requested_by IS NOT NULL").get(lead.id).n
  if (open >= 5) throw new AppError(409, 'too_many_requests', 'You already have 5 viewing requests waiting for your agent.')
  const note = typeof input?.note === 'string' ? input.note.trim().slice(0, 300) : null
  const { viewing } = draftViewing(db, agent, { leadId: lead.id, propertyIds: ids, start: new Date(start).toISOString(), inviteLead: Boolean(lead.email), note }, { requestedBy: buyer.id })
  return { viewing: buyerView(db, db.prepare('SELECT * FROM viewings WHERE id = ?').get(viewing.id)) }
}

function buyerView(db, row) {
  const agent = db.prepare('SELECT name FROM users WHERE id = ?').get(row.user_id)
  const fb = db.prepare('SELECT status FROM feedback_requests WHERE viewing_id = ?').get(row.id)
  return {
    id: row.id, when: describeInZone(row.start_at, row.timezone), startAt: row.start_at, status: row.status === 'draft' ? 'requested' : row.status,
    agentName: agent?.name ?? null, durationMinutes: Math.round((Date.parse(row.end_at) - Date.parse(row.start_at)) / 60000),
    properties: JSON.parse(row.property_ids).map((id) => { const p = getProperty(db, id); return p ? { id, title: p.title, area: [p.locality, p.city].filter(Boolean).join(', ') } : { id, title: '(listing removed)' } }),
    feedbackGiven: fb?.status === 'submitted'
  }
}

export function listBuyerViewings(db, buyer) {
  const prof = db.prepare('SELECT lead_id FROM buyer_profiles WHERE user_id = ?').get(buyer.id)
  if (!prof?.lead_id) return []
  return db.prepare("SELECT * FROM viewings WHERE lead_id = ? AND (status != 'draft' OR requested_by IS NOT NULL) ORDER BY start_at DESC LIMIT 100").all(prof.lead_id).map((r) => buyerView(db, r))
}

/** The buyer's own viewing, or a 404. */
export function buyerViewing(db, buyer, id) {
  const prof = db.prepare('SELECT lead_id FROM buyer_profiles WHERE user_id = ?').get(buyer.id)
  const row = prof?.lead_id ? db.prepare('SELECT * FROM viewings WHERE id = ? AND lead_id = ?').get(id, prof.lead_id) : null
  if (!row) throw new AppError(404, 'viewing_not_found', 'No such viewing.')
  return row
}

/** The buyer withdraws a request, or cancels a booked viewing (the agent's calendar event is removed first). */
export async function buyerCancel(db, vs, buyer, id) {
  const row = buyerViewing(db, buyer, id)
  const agent = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(row.user_id)
  await cancelViewing(db, vs, { ...agent }, id, { actorId: buyer.id })
  return { viewing: buyerView(db, db.prepare('SELECT * FROM viewings WHERE id = ?').get(id)) }
}

/** Viewings on a seller's listings: when and the state only; never who the buyer is. */
export function listListingViewings(db, seller) {
  const mine = new Set(db.prepare('SELECT id FROM properties WHERE owner_user_id = ?').all(seller.id).map((r) => r.id))
  if (!mine.size) return []
  return db.prepare("SELECT * FROM viewings WHERE status IN ('booked','completed','no_show','cancelled') ORDER BY start_at DESC LIMIT 500").all()
    .filter((v) => JSON.parse(v.property_ids).some((id) => mine.has(id)))
    .map((v) => ({ id: v.id, when: describeInZone(v.start_at, v.timezone), status: v.status, properties: JSON.parse(v.property_ids).filter((id) => mine.has(id)).map((id) => ({ id, title: getProperty(db, id)?.title })) }))
}
