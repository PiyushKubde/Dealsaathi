import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, fakeVs, signedInUser, vsError, V } from './helpers.js'
import { addDays, todayIn, zonedToUtc } from '../server/time.js'

const LEAD = { full_name: 'Rahul Sharma', customer_type: 'buyer', email: 'rahul@example.com', phone: '9876543210', preferred_location: 'Pune', bedrooms: 2, budget_max: 6000000, notes: 'Private broker note' }
const BANER = { title: '2 BHK in Baner', listing_type: 'sale', property_type: 'apartment', bedrooms: 2, price: 4800000, city: 'Pune', locality: 'Baner', address: '12 Baner Road' }
const WAKAD = { ...BANER, title: '2 BHK in Wakad', locality: 'Wakad', price: 5500000, address: '7 Wakad Main' }
const day = addDays(todayIn('Asia/Kolkata'), 2)

async function setup({ feedback = true, lead = LEAD } = {}) {
  const vs = fakeVs()
  const t = await startApp({ vs })
  const conn = async (slug) => (await t.call('/api/integrations/connections', { method: 'POST', body: { serviceId: await vs.serviceIdFor(slug), authId: vs.connectApp(t.user.id, slug) } })).body.connection
  const calendar = await conn('google-calendar')
  const gmail = await conn('gmail')
  await t.call('/api/automations/viewing_scheduler', { method: 'PUT', body: { enabled: true, config: { calendarConnectionId: calendar.id, calendarId: 'primary', confirmation: 'none' } } })
  if (feedback) assert.equal((await t.call('/api/automations/viewing_feedback', { method: 'PUT', body: { enabled: true, config: { gmailConnectionId: gmail.id, expiryDays: 14 } } })).status, 200)
  const l = (await t.call('/api/leads', { method: 'POST', body: { lead } })).body.lead
  const p1 = (await t.call('/api/properties', { method: 'POST', body: { property: BANER } })).body.property
  const p2 = (await t.call('/api/properties', { method: 'POST', body: { property: WAKAD } })).body.property
  const v = (await t.call('/api/viewings', { method: 'POST', body: { leadId: l.id, propertyIds: [p1.id, p2.id], start: zonedToUtc(day, '10:00', 'Asia/Kolkata').toISOString() } })).body.viewing
  await t.call(`/api/viewings/${v.id}/book`, { method: 'POST', body: {} })
  t.db.prepare("UPDATE viewings SET start_at = '2020-01-01T04:30:00.000Z', end_at = '2020-01-01T05:30:00.000Z' WHERE id = ?").run(v.id)
  return { t, vs, lead: l, p1, p2, viewing: v }
}
const complete = (t, id) => t.call(`/api/viewings/${id}/outcome`, { method: 'POST', body: { outcome: 'completed' } })
const tokenFrom = (vs) => /\/feedback\/([A-Za-z0-9_-]{40,60})/.exec(vs.calls.filter((c) => c.name === 'runAction' && c.args[1] === V.rowogelpy0h6).at(-1).args[2].messageBody)?.[1]

test('completing a viewing emails one private feedback link; only its hash is stored', async () => {
  const { t, vs, viewing } = await setup()
  try {
    const res = await complete(t, viewing.id)
    assert.equal(res.body.viewing.status, 'completed')
    assert.equal(res.body.feedback.status, 'sent')
    const token = tokenFrom(vs)
    assert.ok(token, 'the email carries the link')
    const mail = vs.calls.filter((c) => c.name === 'runAction' && c.args[1] === V.rowogelpy0h6).at(-1).args[2]
    assert.equal(mail.to, 'rahul@example.com')
    const rows = t.db.prepare('SELECT * FROM feedback_requests').all()
    assert.equal(rows.length, 1)
    assert.doesNotMatch(JSON.stringify(rows), new RegExp(token), 'the raw token is never stored')
    assert.equal((await complete(t, viewing.id)).status, 409, 'a viewing is completed once')
    const list = (await t.call('/api/feedback')).body.requests
    assert.equal(list[0].status, 'sent')
    assert.equal((await t.call('/api/feedback', { as: signedInUser(t.db, { name: 'Other' }) })).body.requests.length, 0)
  } finally { await t.close() }
})

test('the public page reveals only the first name, the date and the viewed listings', async () => {
  const { t, vs, viewing } = await setup()
  try {
    await complete(t, viewing.id)
    const token = tokenFrom(vs)
    const page = await fetch(`${t.base}/feedback/${token}`)
    assert.equal(page.status, 200)
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer')
    assert.doesNotMatch(await page.text(), /app\.js/, 'the app’s code is not loaded')
    const res = await t.call(`/api/public/feedback/${token}`, { as: null })
    assert.equal(res.status, 200)
    assert.deepEqual(Object.keys(res.body).sort(), ['firstName', 'properties', 'state', 'verdicts', 'viewedOn'])
    assert.equal(res.body.firstName, 'Rahul')
    assert.deepEqual(res.body.properties.map((p) => Object.keys(p).sort()), [['area', 'id', 'title'], ['area', 'id', 'title']])
    assert.doesNotMatch(res.text, /rahul@example\.com|9876543210|Private broker note|Asha|6000000|4800000|12 Baner Road/)
    assert.equal((await t.call('/api/public/feedback/not-a-real-token-at-all-not-a-real-token-xx', { as: null })).status, 404)
    assert.equal((await t.call('/api/leads', { as: null })).status, 401, 'the token opens nothing else')
  } finally { await t.close() }
})

test('the answer updates preferences: budget below a too-expensive price, a rejected area left out, rejected listings dropped', async () => {
  const { t, vs, lead, p1, p2, viewing } = await setup()
  try {
    await complete(t, viewing.id)
    const token = tokenFrom(vs)
    assert.equal((await t.call(`/api/leads/${lead.id}/matches`)).body.matches.length, 2)
    const bad = await t.call(`/api/public/feedback/${token}`, { method: 'POST', body: { responses: [{ propertyId: 9999, verdict: 'liked' }] }, as: null })
    assert.equal(bad.status, 400, 'only the viewed listings')
    assert.equal((await t.call(`/api/public/feedback/${token}`, { method: 'POST', body: { responses: [{ propertyId: p1.id, verdict: 'hacked' }] }, as: null })).status, 400)

    const ok = await t.call(`/api/public/feedback/${token}`, { method: 'POST', as: null, body: { responses: [{ propertyId: p1.id, verdict: 'wrong_location' }, { propertyId: p2.id, verdict: 'too_expensive' }], comments: 'Prefer Kothrud' } })
    assert.equal(ok.status, 200)
    const after = (await t.call(`/api/leads/${lead.id}`)).body
    assert.equal(after.lead.budget_max, 5400000, 'below ₹55 L, rounded to the lakh')
    assert.deepEqual(JSON.parse(after.lead.excluded_localities), ['baner'])
    assert.ok(after.activities.some((a) => a.type === 'preferences_updated'))
    assert.match(after.activities.find((a) => a.type === 'feedback_received').summary, /Prefer Kothrud/)
    assert.equal((await t.call(`/api/leads/${lead.id}/matches`)).body.matches.length, 0, 'future matches recalculated')
    assert.equal((await t.call(`/api/properties/${p1.id}`)).body.matches.length, 0, 'stored matches recalculated too')

    const twice = await t.call(`/api/public/feedback/${token}`, { method: 'POST', as: null, body: { responses: [{ propertyId: p1.id, verdict: 'liked' }] } })
    assert.equal(twice.status, 409)
    assert.equal(twice.body.error.code, 'already_submitted')
    const req = (await t.call('/api/feedback')).body.requests[0]
    assert.equal(req.status, 'submitted')
    assert.equal(req.preferenceChanges.length >= 3, true)
  } finally { await t.close() }
})

test('feedback off, or a lead without email: no request is sent, and the broker is told why', async () => {
  const off = await setup({ feedback: false })
  try {
    const res = await complete(off.t, off.viewing.id)
    assert.equal(res.body.feedback.status, 'off')
    assert.equal(off.t.db.prepare('SELECT COUNT(*) AS n FROM feedback_requests').get().n, 0)
  } finally { await off.t.close() }
  const noMail = await setup({ lead: { ...LEAD, email: null } })
  try {
    assert.equal((await complete(noMail.t, noMail.viewing.id)).body.feedback.status, 'no_email')
  } finally { await noMail.t.close() }
})

test('a failed send can be resent with a fresh link; the old link stops working; an unknown one needs confirmation', async () => {
  const { t, vs, viewing } = await setup()
  try {
    vs.fail.runAction = vsError('Gmail quota', 429)
    const res = await complete(t, viewing.id)
    assert.equal(res.body.feedback.status, 'send_failed')
    const id = res.body.feedback.request.id
    const first = /\/feedback\/([A-Za-z0-9_-]+)/.exec(vs.calls.filter((c) => c.name === 'runAction').at(-1).args[2].messageBody)[1]
    const again = await t.call(`/api/feedback/${id}/resend`, { method: 'POST', body: {} })
    assert.equal(again.body.status, 'sent')
    const second = tokenFrom(vs)
    assert.notEqual(first, second)
    assert.equal((await t.call(`/api/public/feedback/${first}`, { as: null })).status, 404)
    assert.equal((await t.call(`/api/public/feedback/${second}`, { as: null })).status, 200)
    assert.equal((await t.call(`/api/feedback/${id}/resend`, { method: 'POST', body: {} })).status, 409, 'a sent request is not resent')
  } finally { await t.close() }
})

test('an expired link shows as expired and accepts nothing', async () => {
  const { t, vs, p1, viewing } = await setup()
  try {
    await complete(t, viewing.id)
    const token = tokenFrom(vs)
    t.db.prepare("UPDATE feedback_requests SET expires_at = '2020-01-01T00:00:00.000Z'").run()
    assert.equal((await t.call(`/api/public/feedback/${token}`, { as: null })).body.state, 'expired')
    assert.equal((await t.call(`/api/public/feedback/${token}`, { method: 'POST', as: null, body: { responses: [{ propertyId: p1.id, verdict: 'liked' }] } })).status, 409)
  } finally { await t.close() }
})

test('Gmail removed on viaSocket after switching on: the request is recorded as failed, nothing is sent, and it can be resent later', async () => {
  const { t, vs, viewing } = await setup()
  try {
    const keep = vs.state.connections[t.user.id]
    vs.state.connections[t.user.id] = keep.filter((c) => !/gmail/i.test(JSON.stringify(c)))
    const before = vs.calls.filter((c) => c.name === 'runAction' && c.args[1] === V.rowogelpy0h6).length
    const res = await complete(t, viewing.id)
    assert.equal(res.body.viewing.status, 'completed', 'the viewing outcome is saved regardless')
    assert.equal(res.body.feedback.status, 'send_failed')
    assert.match(res.body.feedback.detail, /Gmail/)
    assert.equal(vs.calls.filter((c) => c.name === 'runAction' && c.args[1] === V.rowogelpy0h6).length, before)
    vs.state.connections[t.user.id] = keep
    assert.equal((await t.call(`/api/feedback/${res.body.feedback.request.id}/resend`, { method: 'POST', body: {} })).body.status, 'sent')
  } finally { await t.close() }
})
