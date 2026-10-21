import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { parseBusy, textToHtml, zonedToUtc } from '../server/services/integrations.js'
import { addDays, todayIn } from '../server/services/rent.js'
import { APPS } from '../server/viasocket.js'
import { connectApp, startApp } from './helpers.js'

// viaSocket's action runner is mocked here. These tests cover DealSaathi's own handling of each answer;
// a real send or booking needs a connected test account (see README).

describe('follow-ups through Gmail (mocked runner)', () => {
  let t
  let leadId
  before(async () => {
    t = await startApp()
    await t.signIn()
    leadId = (await t.request('/leads', { method: 'POST', body: { full_name: 'Rahul Sharma', category: 'buyer', email: 'rahul@example.com', budget_max: 5000000 } })).data.lead.id
  })
  after(() => t.close())
  beforeEach(() => {
    t.mock.run.length = 0
    t.mock.calls.length = 0
  })

  const draft = async () => (await t.request('/messages', { method: 'POST', body: { kind: 'lead_followup', lead_id: leadId, subject: 'Hello', body: 'Hi Rahul,\n\nNew listings.' } })).data.message

  test('the AI draft is generated from the stored lead, as data', async () => {
    t.mock.ai.push({ subject: 'New 2BHKs in Baner', body: 'Hi Rahul, ...' })
    const res = await t.request(`/leads/${leadId}/followup-draft`, { method: 'POST', body: { purpose: 'new listings' } })
    assert.equal(res.status, 201)
    assert.equal(res.data.message.recipient, 'rahul@example.com')
    assert.equal(res.data.message.generated_by, 'ai')
    const call = t.mock.calls.find((c) => c.url.endsWith('/embed/ai/message'))
    assert.match(call.body.message, /<lead>\{"full_name":"Rahul Sharma"/)
    assert.ok(!call.body.message.includes('rahul@example.com'), 'contact details are not sent to the model')
  })

  test('refuses to send when Gmail is not connected and keeps the draft', async () => {
    const message = await draft()
    const res = await t.request(`/messages/${message.id}/send`, { method: 'POST' })
    assert.equal(res.status, 409)
    assert.equal(res.data.code, 'not_connected')
    assert.equal((await t.request(`/messages?lead_id=${leadId}`)).data.messages.find((m) => m.id === message.id).status, 'draft')
  })

  test('sends through the Send Email action and marks it sent only with a Gmail message id', async () => {
    connectApp(t.db, APPS.gmail.serviceId)
    const message = await draft()
    t.mock.run.push({ id: 'gmail-msg-1', labelIds: ['SENT'], threadId: 't1' })
    const res = await t.request(`/messages/${message.id}/send`, { method: 'POST' })
    assert.equal(res.status, 200)
    assert.equal(res.data.message.status, 'sent')
    assert.equal(res.data.message.provider_message_id, 'gmail-msg-1')
    const call = t.mock.calls.find((c) => c.url.startsWith('https://run.viasocket.test/func/'))
    assert.equal(call.url, 'https://run.viasocket.test/func/scriTEST0001')
    assert.equal(call.body.action_version_id, 'rowwj0sfmhub')
    assert.deepEqual(Object.keys(call.body.inputData).sort(), ['messageBody', 'subject', 'to'])
    assert.equal(call.body.inputData.to, 'rahul@example.com')
    assert.equal(call.body.inputData.messageBody, '<p>Hi Rahul,</p><p>New listings.</p>')
    assert.equal((await t.request(`/leads/${leadId}`)).data.lead.status, 'contacted')
    assert.equal((await t.request(`/messages/${message.id}/send`, { method: 'POST' })).status, 409, 'a sent message cannot be sent again')
  })

  test('an answer without a message id is recorded as unconfirmed, not sent', async () => {
    const message = await draft()
    t.mock.run.push({ ok: true })
    const res = await t.request(`/messages/${message.id}/send`, { method: 'POST' })
    assert.equal(res.data.message.status, 'unconfirmed')
  })

  test('a failed send is recorded as failed with the reason', async () => {
    const message = await draft()
    t.mock.run.push({ status: 400, body: { success: false, message: 'Invalid To header' } })
    const res = await t.request(`/messages/${message.id}/send`, { method: 'POST' })
    assert.equal(res.status, 502)
    const stored = (await t.request(`/messages?lead_id=${leadId}`)).data.messages.find((m) => m.id === message.id)
    assert.equal(stored.status, 'failed')
    assert.match(stored.error, /Invalid To header/)
  })

  test('the plain-text body is escaped before it becomes HTML', () => {
    assert.equal(textToHtml('<script>x</script>\nline'), '<p>&lt;script&gt;x&lt;/script&gt;<br>line</p>')
  })
})

describe('rent reminders', () => {
  test('drafts from the record, refuses paid rent, and sends only when Gmail is connected', async () => {
    const t = await startApp()
    await t.signIn()
    const today = todayIn('Asia/Kolkata')
    const overdue = (await t.request('/rent', { method: 'POST', body: { tenant_name: 'Arjun Mehta', tenant_email: 'arjun@example.com', property_label: 'Shop 4, Kharadi', amount: 85000, due_date: addDays(today, -5), payment_status: 'unpaid' } })).data.record
    const paid = (await t.request('/rent', { method: 'POST', body: { tenant_name: 'Kabir', property_label: 'Flat 7', amount: 22000, due_date: addDays(today, -2), payment_status: 'paid' } })).data.record
    assert.equal(overdue.bucket, 'overdue')
    const res = await t.request(`/rent/${overdue.id}/reminder`, { method: 'POST' })
    assert.equal(res.status, 201)
    assert.match(res.data.message.body, /₹85,000/)
    assert.match(res.data.message.body, /If you have already paid/)
    assert.equal(res.data.message.recipient, 'arjun@example.com')
    assert.equal((await t.request(`/rent/${paid.id}/reminder`, { method: 'POST' })).status, 409)
    assert.equal((await t.request(`/messages/${res.data.message.id}/send`, { method: 'POST' })).status, 409)
    connectApp(t.db, APPS.gmail.serviceId)
    t.mock.run.push({ id: 'gmail-2' })
    assert.equal((await t.request(`/messages/${res.data.message.id}/send`, { method: 'POST' })).data.message.status, 'sent')
    assert.equal((await t.request('/rent')).data.records.find((r) => r.id === overdue.id).reminder_status, 'sent')
    await t.close()
  })
})

describe('viewings on Google Calendar (mocked runner)', () => {
  let t
  let viewing
  const tomorrow = () => addDays(todayIn('Asia/Kolkata'), 1)
  before(async () => {
    t = await startApp()
    await t.signIn()
    const lead = (await t.request('/leads', { method: 'POST', body: { full_name: 'Rahul Sharma', category: 'buyer', email: 'rahul@example.com' } })).data.lead
    viewing = (await t.request('/viewings', { method: 'POST', body: { lead_id: lead.id, property_id: 1, start_date: tomorrow(), start_time: '16:00', time_zone: 'Asia/Kolkata' } })).data.viewing
  })
  after(() => t.close())

  test('a new viewing is a proposal and cannot be checked or booked without a calendar', async () => {
    assert.equal(viewing.status, 'proposed')
    assert.equal((await t.request(`/viewings/${viewing.id}/availability`, { method: 'POST' })).status, 409)
    assert.equal((await t.request(`/viewings/${viewing.id}/book`, { method: 'POST' })).status, 409)
  })

  test('availability comes from Get Free/Busy Information and is checked for overlap', async () => {
    connectApp(t.db, APPS.googleCalendar.serviceId, { settings: { calendar_id: 'cal-1', calendar_label: 'Work' } })
    // 16:00 IST is 10:30 UTC; a 10:00–11:00 UTC busy slot overlaps it.
    t.mock.run.push({ kind: 'calendar#freeBusy', calendars: { 'cal-1': { busy: [{ start: `${tomorrow()}T10:00:00Z`, end: `${tomorrow()}T11:00:00Z` }] } } })
    const res = await t.request(`/viewings/${viewing.id}/availability`, { method: 'POST' })
    assert.equal(res.data.viewing.availability.checked, true)
    assert.equal(res.data.viewing.availability.free, false)
    const call = t.mock.calls.filter((c) => c.url.includes('/func/')).at(-1)
    assert.equal(call.body.action_version_id, 'row0ce18xwwk')
    assert.deepEqual(call.body.inputData, { calendar_id: 'cal-1', date: tomorrow(), timeZone: 'Asia/Kolkata' })
  })

  test('an unexpected free/busy answer is reported as unknown availability', async () => {
    t.mock.run.push({ message: 'something else' })
    const res = await t.request(`/viewings/${viewing.id}/availability`, { method: 'POST' })
    assert.equal(res.data.viewing.availability.checked, false)
  })

  test('an answer without an event id is stored as booking_unverified', async () => {
    t.mock.run.push({ message: 'Invalid start_date format' })
    const res = await t.request(`/viewings/${viewing.id}/book`, { method: 'POST' })
    assert.equal(res.data.confirmed, false)
    assert.equal(res.data.viewing.status, 'booking_unverified')
  })

  test('books with Create Calendar Event and marks it booked only with an event id', async () => {
    t.mock.run.push({ id: 'evt-123', htmlLink: 'https://calendar.google.com/event?eid=1' })
    const res = await t.request(`/viewings/${viewing.id}/book`, { method: 'POST' })
    assert.equal(res.data.viewing.status, 'booked')
    assert.equal(res.data.viewing.calendar_event_id, 'evt-123')
    const call = t.mock.calls.filter((c) => c.url.includes('/func/')).at(-1)
    assert.equal(call.body.action_version_id, 'rown3bkuc5jc')
    const [y, m, d] = tomorrow().split('-')
    assert.equal(call.body.inputData.startdate, `${d}-${m}-${y}`)
    assert.equal(call.body.inputData.starttime, '16:00')
    assert.equal(call.body.inputData.meeting_duration, '01:00')
    assert.equal(call.body.inputData.attendees, 'rahul@example.com')
    assert.equal(call.body.inputData.calendar_id, 'cal-1')
    assert.equal((await t.request(`/viewings/${viewing.id}/book`, { method: 'POST' })).status, 409, 'cannot book twice')
  })
})

describe('connecting an app', () => {
  test('the auth_id from the popup is verified against viaSocket before it is stored', async () => {
    const t = await startApp()
    await t.signIn()
    const forged = await t.request('/integrations/connected', { method: 'POST', body: { serviceId: APPS.gmail.serviceId, authId: 'auth_forged_rowo0bqrhj5g' } })
    assert.equal(forged.status, 400)
    t.mock.routes.connections.push({ id: 'auth2abc_rowo0bqrhj5g', service_id: 'rowo0bqrhj5g' })
    const ok = await t.request('/integrations/connected', { method: 'POST', body: { serviceId: APPS.gmail.serviceId, authId: 'auth2abc_rowo0bqrhj5g' } })
    assert.equal(ok.status, 200)
    assert.ok(t.mock.calls.some((c) => c.url.endsWith('/embed/enable/rowo0bqrhj5g/auth2abc_rowo0bqrhj5g')))
    const status = (await t.request('/integrations')).data
    const gmail = status.apps.find((a) => a.key === 'gmail')
    assert.equal(gmail.connected, true)
    assert.ok(!JSON.stringify(status).includes('scriTEST0001'), 'the script_id never reaches the browser')
    assert.equal((await t.request('/integrations/connected', { method: 'POST', body: { serviceId: 'rowunknown', authId: 'x_x_x_x' } })).status, 400)
    await t.close()
  })

  test('the embed token endpoint refuses when viaSocket is not configured', async () => {
    const t = await startApp({ viasocket: false })
    await t.signIn()
    assert.equal((await t.request('/viasocket/token')).status, 503)
    await t.close()
  })
})

describe('calendar helpers', () => {
  test('converts local time to UTC', () => {
    assert.equal(zonedToUtc('2026-10-22', '16:00', 'Asia/Kolkata').toISOString(), '2026-10-22T10:30:00.000Z')
    assert.equal(zonedToUtc('2026-07-01', '09:00', 'America/New_York').toISOString(), '2026-07-01T13:00:00.000Z')
  })
  test('parseBusy returns null for unknown shapes', () => {
    assert.equal(parseBusy({}), null)
    assert.deepEqual(parseBusy({ calendars: { a: { busy: [] } } }), [])
  })
})

