import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, fakeVs, signedInUser, vsError, V } from './helpers.js'
import { addDays, todayIn, zonedToUtc } from '../server/time.js'

const LEAD = { full_name: 'Rahul Sharma', customer_type: 'buyer', email: 'rahul@example.com', phone: '9876543210', preferred_location: 'Baner, Pune', bedrooms: 2, budget_max: 5000000 }
const BANER = { title: '2 BHK in Baner', listing_type: 'sale', property_type: 'apartment', bedrooms: 2, price: 4800000, city: 'Pune', locality: 'Baner', address: '12 Baner Road' }
const TZ = 'Asia/Kolkata'
const day = addDays(todayIn(TZ), 2)
const at = (time, tz = TZ, d = day) => zonedToUtc(d, time, tz).toISOString()

async function setup({ confirmation = 'gmail', tz = TZ } = {}) {
  const vs = fakeVs()
  const t = await startApp({ vs })
  const conn = async (slug) => (await t.call('/api/integrations/connections', { method: 'POST', body: { serviceId: (await vs.serviceIdFor(slug)), authId: vs.connectApp(t.user.id, slug) } })).body.connection
  const calendar = await conn('google-calendar')
  const gmail = await conn('gmail')
  const cfg = { calendarConnectionId: calendar.id, calendarId: 'primary', timezone: tz, dayStart: '09:00', dayEnd: '12:00', durationMinutes: 60, confirmation, gmailConnectionId: gmail.id }
  const enabled = await t.call('/api/automations/viewing_scheduler', { method: 'PUT', body: { enabled: true, config: cfg } })
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body))
  const lead = (await t.call('/api/leads', { method: 'POST', body: { lead: LEAD } })).body.lead
  const property = (await t.call('/api/properties', { method: 'POST', body: { property: BANER } })).body.property
  return { t, vs, lead, property, calendar, gmail, cfg }
}
const runs = (vs, v) => vs.calls.filter((c) => c.name === 'runAction' && c.args[1] === v)
const draft = (t, body) => t.call('/api/viewings', { method: 'POST', body })
const book = (t, id, body = {}) => t.call(`/api/viewings/${id}/book`, { method: 'POST', body })

test('switching on checks the calendar is really in the broker’s Google Calendar list', async () => {
  const { t, cfg } = await setup()
  try {
    const bad = await t.call('/api/automations/viewing_scheduler', { method: 'PUT', body: { enabled: true, config: { ...cfg, calendarId: 'someone-else@example.com' } } })
    assert.equal(bad.status, 409)
    assert.match(bad.body.error.details.problems.join(' '), /not in your Google Calendar list/)
    assert.equal((await t.call('/api/automations/viewing_scheduler', { method: 'PUT', body: { enabled: true, config: { ...cfg, timezone: 'Mars/Olympus' } } })).status, 409)
    const card = (await t.call('/api/automations')).body.automations.find((a) => a.key === 'viewing_scheduler')
    assert.equal(card.status, 'enabled')
    assert.equal(card.config.calendarLabel, 'Asha (primary)', 'label read from Google, not the browser')
  } finally { await t.close() }
})

test('free slots come from the real free/busy answer, in working hours and the broker’s time zone', async () => {
  const { t, vs } = await setup()
  try {
    vs.state.busy = [{ start: at('10:00'), end: at('11:00') }]
    const res = await t.call(`/api/viewings/slots?date=${day}&durationMinutes=60`)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.slots.map((s) => s.label), ['09:00', '11:00'])
    assert.equal(res.body.slots[0].start, at('09:00'))
    assert.deepEqual(runs(vs, V.row7kcom7ds1)[0].args[2], { calendar_id: 'primary', date: day, timeZone: TZ })
    assert.equal((await t.call(`/api/viewings/slots?date=2020-01-01`)).status, 400, 'no past dates')
    assert.equal((await t.call(`/api/viewings/slots?date=${day}&durationMinutes=50`)).status, 400)
  } finally { await t.close() }
})

test('review → confirm: re-checks, creates the event with the documented inputs, emails the lead, records it all', async () => {
  const { t, vs, lead, property } = await setup()
  try {
    const d = await draft(t, { leadId: lead.id, propertyIds: [property.id], start: at('11:00'), durationMinutes: 90 })
    assert.equal(d.status, 201)
    assert.equal(d.body.viewing.status, 'draft')
    assert.equal(d.body.confirmationWillBeSent, true)
    assert.equal(runs(vs, V.rowuitv4m6uy).length, 0, 'nothing is booked before confirmation')

    const b = await book(t, d.body.viewing.id)
    assert.equal(b.status, 200)
    const v = b.body.viewing
    assert.equal(v.status, 'booked')
    assert.equal(v.eventId, 'evt1')
    assert.equal(runs(vs, V.row7kcom7ds1).length, 1, 'availability re-checked right before booking')
    const input = runs(vs, V.rowuitv4m6uy)[0].args[2]
    assert.equal(input.calendar_id, 'primary')
    assert.equal(input.startdate, day.split('-').reverse().join('-'), 'DD-MM-YYYY')
    assert.equal(input.starttime, '11:00')
    assert.equal(input.meeting_duration, '01:30')
    assert.equal(input.timeZone, TZ)
    assert.equal(input.transparency, 'opaque', 'the viewing blocks the slot')
    assert.equal(input.attendees, 'me@example.com', 'not inviting the lead: the calendar owner is the only attendee (the action requires one)')
    assert.ok(Object.values(input).every((x) => x !== ''), 'no required field is sent empty')
    assert.match(input.location, /12 Baner Road, Baner, Pune/)
    assert.match(input.summary, /Rahul Sharma – 2 BHK in Baner/)

    assert.equal(v.confirmationStatus, 'sent')
    const mail = runs(vs, V.rowogelpy0h6)[0].args[2]
    assert.equal(mail.to, 'rahul@example.com')
    assert.match(mail.messageBody, /11:00 am|11:00/)
    const [run] = (await t.call('/api/automations/viewing_scheduler/runs')).body.runs
    assert.equal(run.status, 'succeeded')
    assert.match(run.summary, /event evt1/)
    const acts = (await t.call(`/api/leads/${lead.id}`)).body.activities.map((a) => a.type)
    assert.ok(acts.includes('viewing_booked') && acts.includes('viewing_confirmation_sent'))

    const again = await book(t, d.body.viewing.id)
    assert.equal(again.body.alreadyBooked, true)
    assert.equal(runs(vs, V.rowuitv4m6uy).length, 1, 'never booked twice')
  } finally { await t.close() }
})

test('a slot taken since it was shown is refused at booking; two drafts for one slot book once', async () => {
  const { t, vs, lead, property } = await setup()
  try {
    const a = (await draft(t, { leadId: lead.id, propertyIds: [property.id], start: at('09:00') })).body.viewing
    const b = (await draft(t, { leadId: lead.id, propertyIds: [property.id], start: at('09:30') })).body.viewing
    vs.state.busy = [{ start: at('09:00'), end: at('09:30') }]
    const taken = await book(t, a.id)
    assert.equal(taken.status, 409)
    assert.equal(taken.body.error.code, 'slot_taken')
    assert.equal((await t.call(`/api/viewings/${a.id}`)).body.viewing.status, 'draft')
    vs.state.busy = []
    assert.equal((await book(t, a.id)).body.viewing.status, 'booked')
    const overlap = await book(t, b.id)
    assert.equal(overlap.status, 409, 'overlaps the broker’s own booking')
    assert.equal(runs(vs, V.rowuitv4m6uy).length, 1)
  } finally { await t.close() }
})

test('Google Calendar refusing is failed (retryable); no answer is unknown and needs the broker’s check', async () => {
  const { t, vs, lead, property } = await setup()
  try {
    const d = (await draft(t, { leadId: lead.id, propertyIds: [property.id], start: at('09:00') })).body.viewing
    vs.fail.runAction = undefined
    const origRun = vs.runAction
    let mode = 'refuse'
    vs.runAction = async (s, v, i) => {
      if (v === V.rowuitv4m6uy && mode === 'refuse') { mode = 'silent'; throw vsError('Invalid start_date format', 400) }
      if (v === V.rowuitv4m6uy && mode === 'silent') { mode = 'ok'; throw vsError('aborted', null) }
      return origRun(s, v, i)
    }
    const failed = (await book(t, d.id)).body.viewing
    assert.equal(failed.status, 'failed')
    assert.match(failed.error, /Invalid start_date format/)
    const unknown = (await book(t, d.id)).body.viewing
    assert.equal(unknown.status, 'unknown')
    const blocked = await book(t, d.id)
    assert.equal(blocked.status, 409)
    assert.equal(blocked.body.error.code, 'outcome_unknown')
    const ok = await book(t, d.id, { confirmNotInCalendar: true })
    assert.equal(ok.body.viewing.status, 'booked')
    const statuses = (await t.call('/api/automations/viewing_scheduler/runs')).body.runs.map((r) => r.status)
    assert.deepEqual(statuses, ['succeeded', 'unknown', 'failed'])
  } finally { await t.close() }
})

test('without a confirmation channel the viewing is booked and the confirmation says not configured', async () => {
  const { t, vs, lead, property } = await setup({ confirmation: 'none' })
  try {
    const d = (await draft(t, { leadId: lead.id, propertyIds: [property.id], start: at('09:00') })).body
    assert.equal(d.confirmationWillBeSent, false)
    const v = (await book(t, d.viewing.id)).body.viewing
    assert.equal(v.status, 'booked')
    assert.equal(v.confirmationStatus, 'not_configured')
    assert.equal(runs(vs, V.rowogelpy0h6).length, 0)
  } finally { await t.close() }
})

test('cancel deletes the calendar event first; a refused delete keeps the viewing booked', async () => {
  const { t, vs, lead, property } = await setup()
  try {
    const v = (await book(t, (await draft(t, { leadId: lead.id, propertyIds: [property.id], start: at('09:00') })).body.viewing.id)).body.viewing
    vs.fail.runAction = vsError('Calendar busy', 503)
    const refused = await t.call(`/api/viewings/${v.id}/cancel`, { method: 'POST', body: {} })
    assert.equal(refused.status, 502)
    assert.equal((await t.call(`/api/viewings/${v.id}`)).body.viewing.status, 'booked')
    const ok = await t.call(`/api/viewings/${v.id}/cancel`, { method: 'POST', body: {} })
    assert.equal(ok.body.viewing.status, 'cancelled')
    assert.deepEqual(runs(vs, V.row32ktr5oju).at(-1).args[2], { calendarId: 'primary', eventId: 'evt1', sendUpdates: 'none' })
    assert.equal(ok.body.leadNotified, 'sent', 'the lead was told, since they had a confirmation')
    assert.equal(vs.state.events.evt1, undefined)
  } finally { await t.close() }
})

test('reschedule re-checks the new slot and moves the event; the old slot does not block itself', async () => {
  const { t, vs, lead, property } = await setup()
  try {
    const v = (await book(t, (await draft(t, { leadId: lead.id, propertyIds: [property.id], start: at('09:00') })).body.viewing.id)).body.viewing
    vs.state.busy = [{ start: at('09:00'), end: at('10:00') }] // the event itself, now in the calendar
    const slots = (await t.call(`/api/viewings/slots?date=${day}&durationMinutes=60&except=${v.id}`)).body.slots.map((s) => s.label)
    assert.ok(slots.includes('09:30'), 'its own time does not count as busy')
    const moved = await t.call(`/api/viewings/${v.id}/reschedule`, { method: 'POST', body: { start: at('09:30') } })
    assert.equal(moved.status, 200)
    assert.equal(moved.body.viewing.localTime, '09:30')
    const input = runs(vs, V.rowo9a3brirh)[0].args[2]
    assert.deepEqual(input, { calendar_id: 'primary', eventId: 'evt1', startdate: day.split('-').reverse().join('-'), starttime: '09:30', meeting_duration: '01:00', timeZone: TZ })
    vs.state.busy = [{ start: at('11:00'), end: at('12:00') }]
    assert.equal((await t.call(`/api/viewings/${v.id}/reschedule`, { method: 'POST', body: { start: at('11:00') } })).status, 409)
  } finally { await t.close() }
})

test('time zones: a London broker’s 09:00 is written as 09:00 London time', async () => {
  const { t, vs, lead, property } = await setup({ tz: 'Europe/London' })
  try {
    const slots = (await t.call(`/api/viewings/slots?date=${day}&durationMinutes=60`)).body
    assert.equal(slots.timezone, 'Europe/London')
    assert.equal(slots.slots[0].start, at('09:00', 'Europe/London'))
    await book(t, (await draft(t, { leadId: lead.id, propertyIds: [property.id], start: at('09:00', 'Europe/London') })).body.viewing.id)
    const input = runs(vs, V.rowuitv4m6uy)[0].args[2]
    assert.equal(input.starttime, '09:00')
    assert.equal(input.timeZone, 'Europe/London')
  } finally { await t.close() }
})

test('the broker marks the outcome; the scheduler only reminds them once a viewing has ended', async () => {
  const { t, lead, property } = await setup()
  try {
    const v = (await book(t, (await draft(t, { leadId: lead.id, propertyIds: [property.id], start: at('09:00') })).body.viewing.id)).body.viewing
    assert.equal((await t.call(`/api/viewings/${v.id}/outcome`, { method: 'POST', body: { outcome: 'completed' } })).status, 409, 'not before it starts')
    t.db.prepare("UPDATE viewings SET start_at = '2020-01-01T04:00:00.000Z', end_at = '2020-01-01T05:00:00.000Z' WHERE id = ?").run(v.id)
    const { noticeEndedViewings } = await import('../server/viewings/service.js')
    assert.equal(noticeEndedViewings(t.db), 1)
    assert.equal(noticeEndedViewings(t.db), 0, 'one reminder per viewing')
    const rem = (await t.call('/api/reminders')).body.reminders
    assert.equal(rem.length, 1)
    assert.match(rem[0].detail, /mark whether it took place/)
    assert.equal((await t.call(`/api/viewings/${v.id}`)).body.viewing.status, 'booked', 'time passing does not mark it completed')
    const out = await t.call(`/api/viewings/${v.id}/outcome`, { method: 'POST', body: { outcome: 'no_show' } })
    assert.equal(out.body.viewing.status, 'no_show')
    assert.equal(out.body.feedback, null, 'no feedback for a no-show')
    assert.equal((await t.call('/api/reminders')).body.reminders.length, 0, 'the reminder is closed')
  } finally { await t.close() }
})

test('authorization, samples and setup: other brokers cannot touch it; sample listings and unconfigured brokers are refused', async () => {
  const { t, lead, property } = await setup()
  try {
    const v = (await draft(t, { leadId: lead.id, propertyIds: [property.id], start: at('09:00') })).body.viewing
    const other = signedInUser(t.db, { name: 'Other' })
    assert.equal((await t.call(`/api/viewings/${v.id}`, { as: other })).status, 404)
    assert.equal((await t.call(`/api/viewings/${v.id}/book`, { method: 'POST', body: {}, as: other })).status, 409, 'not set up for them')
    assert.equal((await t.call(`/api/viewings/${v.id}/cancel`, { method: 'POST', body: {}, as: other })).status, 404)
    assert.equal((await t.call('/api/viewings', { as: other })).body.viewings.length, 0)
    const sample = (await t.call('/api/properties/samples', { method: 'POST', body: {} })).body.properties[0]
    const s = await draft(t, { leadId: lead.id, propertyIds: [sample.id], start: at('09:00') })
    assert.equal(s.status, 400)
    assert.match(s.body.error.details.fields.properties, /sample listing/)
    assert.equal((await draft(t, { leadId: lead.id, propertyIds: [property.id], start: '2020-01-01T00:00:00Z' })).status, 400)
  } finally { await t.close() }
})

test('regression: Google Calendar requires attendees — an uninvited viewing books with the owner as attendee; unknown owner is refused before claiming', async () => {
  const { t, vs, lead, property } = await setup({ confirmation: 'none' })
  try {
    const d = (await draft(t, { leadId: lead.id, propertyIds: [property.id], start: at('10:00') })).body.viewing
    const ok = (await book(t, d.id)).body.viewing
    assert.equal(ok.status, 'booked', 'the real action refused an empty attendees list with Bad Request')
    assert.equal(runs(vs, V.rowuitv4m6uy).at(-1).args[2].attendees, 'me@example.com')
    // A connection whose label carries no email, on a non-email calendar id: refused cleanly, nothing claimed or sent.
    t.db.prepare("UPDATE connections SET label = 'Work account'").run()
    const d2 = (await draft(t, { leadId: lead.id, propertyIds: [property.id], start: at('11:00') })).body.viewing
    const before = runs(vs, V.rowuitv4m6uy).length
    const refused = await book(t, d2.id)
    assert.equal(refused.status, 409)
    assert.equal(refused.body.error.code, 'calendar_owner_unknown')
    assert.equal(runs(vs, V.rowuitv4m6uy).length, before, 'no calendar call')
    assert.equal(t.db.prepare('SELECT status FROM viewings WHERE id = ?').get(d2.id).status, 'draft', 'not stuck in booking')
  } finally { await t.close() }
})
