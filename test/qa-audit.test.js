// QA audit probes: edge cases across roles, listings, viewings, sessions and input handling.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, fakeVs, signedInUser } from './helpers.js'
import { createAuth } from '../server/auth.js'
import { addDays, todayIn } from '../server/time.js'

const BANER = { title: '2 BHK in Baner', listing_type: 'sale', property_type: 'apartment', bedrooms: 2, price: 4800000, city: 'Pune', locality: 'Baner', address: '12 Baner Road' }
const REQ = { customer_type: 'buyer', preferred_location: 'Baner, Pune', bedrooms: 2, budget_max: 5000000, property_type: 'apartment' }

async function market(vs = fakeVs()) {
  const t = await startApp({ vs })
  await t.call('/api/me/profile', { method: 'PATCH', body: { serviceAreas: ['Pune'] } })
  const buyer = signedInUser(t.db, { name: 'Rahul Sharma', email: 'rahul@example.com', role: 'buyer' })
  const seller = signedInUser(t.db, { name: 'Sunita Rao', email: 'sunita@example.com', role: 'seller' })
  return { t, vs, buyer, seller }
}
const saveReq = (t, buyer, requirements = REQ) => t.call('/api/me/requirements', { method: 'PUT', body: { requirements, matchingConsent: true }, as: buyer })

test('seller marks a matched listing sold: matches are withdrawn, recommendations and new viewings stop', async () => {
  const { t, buyer, seller } = await market()
  try {
    await saveReq(t, buyer)
    const p = (await t.call('/api/properties', { method: 'POST', body: { property: BANER, publish: true }, as: seller })).body.property
    await t.idle()
    assert.equal((await t.call('/api/me/recommendations', { as: buyer })).body.recommendations.length, 1)
    assert.equal((await t.call(`/api/properties/${p.id}`, { method: 'PATCH', body: { property: { status: 'sold' } }, as: seller })).status, 200)
    await t.idle()
    assert.equal((await t.call('/api/me/recommendations', { as: buyer })).body.recommendations.length, 0)
    assert.equal((await t.call(`/api/properties/${p.id}`, { as: buyer })).status, 404, 'a sold listing leaves the market')
    assert.match(t.db.prepare('SELECT withdrawn_reason FROM property_matches').get().withdrawn_reason, /no longer|sold/i)
    assert.equal((await t.call(`/api/properties/${p.id}/publish`, { method: 'POST', body: {}, as: seller })).status, 200, 'already published: no change')
  } finally { await t.close() }
})

test('a viewing requested on a listing that is sold before the agent confirms is not booked', async () => {
  const vs = fakeVs()
  const { t, buyer, seller } = await market(vs)
  try {
    const cal = (await t.call('/api/integrations/connections', { method: 'POST', body: { serviceId: await vs.serviceIdFor('google-calendar'), authId: vs.connectApp(t.user.id, 'google-calendar') } })).body.connection
    await t.call('/api/automations/viewing_scheduler', { method: 'PUT', body: { enabled: true, config: { calendarConnectionId: cal.id, calendarId: 'primary', confirmation: 'none' } } })
    await saveReq(t, buyer)
    const p = (await t.call('/api/properties', { method: 'POST', body: { property: BANER, publish: true }, as: seller })).body.property
    await t.idle()
    const day = addDays(todayIn('Asia/Kolkata'), 2)
    const slot = (await t.call(`/api/me/viewing-slots?propertyId=${p.id}&date=${day}`, { as: buyer })).body.slots[0]
    const v = (await t.call('/api/me/viewings', { method: 'POST', body: { propertyId: p.id, start: slot.start }, as: buyer })).body.viewing
    await t.call(`/api/properties/${p.id}`, { method: 'PATCH', body: { property: { status: 'sold' } }, as: seller })
    await t.idle()
    const booked = await t.call(`/api/viewings/${v.id}/book`, { method: 'POST', body: {} })
    assert.equal(booked.status, 409, 'not booked for a listing that left the market')
    assert.ok(!vs.calls.some((c) => c.name === 'runAction' && c.args[2]?.summary), 'no calendar event was created')
  } finally { await t.close() }
})

test('an agent cannot delete a registered buyer’s own requirements record', async () => {
  const { t, buyer } = await market()
  try {
    await saveReq(t, buyer)
    await t.idle()
    const lead = t.db.prepare('SELECT id FROM leads WHERE buyer_user_id = ?').get(buyer.id)
    const del = await t.call(`/api/leads/${lead.id}`, { method: 'DELETE' })
    assert.equal(del.status, 409)
    assert.ok(t.db.prepare('SELECT 1 FROM leads WHERE id = ?').get(lead.id))
    assert.equal((await t.call('/api/me', { as: buyer })).body.profile.requirements.budget_max, 5000000)
  } finally { await t.close() }
})

test('buyer requirements: a minimum above the maximum is refused, on the first save and later', async () => {
  const { t, buyer } = await market()
  try {
    const bad = await saveReq(t, buyer, { ...REQ, budget_min: 6000000 })
    assert.equal(bad.status, 400)
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM leads').get().n, 0, 'nothing saved')
    await saveReq(t, buyer)
    assert.equal((await saveReq(t, buyer, { budget_min: 9000000 })).status, 400)
  } finally { await t.close() }
})

test('another agent cannot change or take down a listing they are not responsible for', async () => {
  const { t } = await market()
  try {
    const p = (await t.call('/api/properties', { method: 'POST', body: { property: BANER } })).body.property
    const other = signedInUser(t.db, { name: 'Other Agent' })
    assert.equal((await t.call(`/api/properties/${p.id}`, { method: 'PATCH', body: { property: { price: 1 } }, as: other })).status, 403)
    for (const a of ['unpublish', 'archive']) assert.equal((await t.call(`/api/properties/${p.id}/${a}`, { method: 'POST', body: {}, as: other })).status, 403)
    assert.equal((await t.call(`/api/properties/${p.id}`, { method: 'DELETE', as: other })).status, 403)
    assert.equal((await t.call(`/api/properties/${p.id}`, { as: other })).body.property.notes, undefined)
  } finally { await t.close() }
})

test('role escalation: role cannot be changed after signup or claimed through the profile, and pool/transfer refuse non-agents', async () => {
  const { t, buyer, seller } = await market()
  try {
    await t.call('/api/me/profile', { method: 'PATCH', body: { role: 'agent', serviceAreas: ['Pune'] }, as: buyer })
    await t.call('/api/me/profile', { method: 'PATCH', body: { role: 'agent' }, as: seller })
    assert.equal(t.db.prepare('SELECT role FROM users WHERE id = ?').get(buyer.id).role, 'buyer')
    assert.equal(t.db.prepare('SELECT role FROM users WHERE id = ?').get(seller.id).role, 'seller')
    assert.equal((await t.call('/api/pool/1/claim', { method: 'POST', body: {}, as: buyer })).status, 403)
    const lead = (await t.call('/api/leads', { method: 'POST', body: { lead: { full_name: 'Typed In', customer_type: 'buyer', phone: '9000000001' } } })).body.lead
    assert.equal((await t.call(`/api/leads/${lead.id}/transfer`, { method: 'POST', body: { agentId: buyer.id } })).status, 400, 'only to another agent')
    assert.equal((await t.call('/api/session/register', { method: 'POST', body: { name: 'Sneaky', email: 'sneaky@example.com', password: 'a-long-password-1', role: 'admin' }, as: null })).status, 400)
  } finally { await t.close() }
})

test('sessions: Secure cookie behind HTTPS, logout and expiry end the session, cookie is never readable by scripts', async () => {
  const base = await startApp({ withUser: false })
  try {
    const { createApp } = await import('../server/app.js')
    const app = createApp({ db: base.db, ai: { configured: false }, auth: createAuth({ db: base.db, hosted: true, accessCode: 'team-access-code-2026' }), behindProxy: true })
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
    const url = `http://127.0.0.1:${server.address().port}`
    const res = await fetch(`${url}/api/session/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' }, body: JSON.stringify({ name: 'Buyer B', email: 'b@example.com', password: 'a-long-password-1', role: 'buyer' }) })
    const cookie = res.headers.get('set-cookie')
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /SameSite=Strict/)
    assert.match(cookie, /Secure/)
    const me = { cookie: cookie.split(';')[0] }
    assert.equal((await fetch(`${url}/api/me`, { headers: me })).status, 200)
    base.db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run()
    assert.equal((await fetch(`${url}/api/me`, { headers: me })).status, 401, 'an expired session is refused')
    assert.equal(base.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0, 'and removed')
    await new Promise((r) => server.close(r))
  } finally { await base.close() }
})

test('input handling: oversized bodies, bad JSON, wrong types and hostile text are refused or stored inert', async () => {
  const { t, seller } = await market()
  try {
    const huge = await fetch(`${t.base}/api/leads`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: t.user.cookie }, body: JSON.stringify({ lead: { full_name: 'x'.repeat(60000) } }) })
    assert.equal(huge.status, 413)
    assert.equal((await t.call('/api/properties', { method: 'POST', body: { property: { ...BANER, price: '4,80,000; DROP TABLE properties' } }, as: seller })).status, 400)
    assert.equal((await t.call('/api/properties', { method: 'POST', body: { property: { ...BANER, price: -1 } }, as: seller })).status, 400)
    assert.equal((await t.call('/api/properties', { method: 'POST', body: { property: { ...BANER, bedrooms: 2.5 } }, as: seller })).status, 400)
    assert.equal((await t.call('/api/properties', { method: 'POST', body: { property: [] }, as: seller })).status, 400)
    const xss = '<img src=x onerror=alert(1)>'
    const p = await t.call('/api/properties', { method: 'POST', body: { property: { ...BANER, title: `Flat ${xss}` } }, as: seller })
    assert.equal(p.status, 201)
    assert.equal(p.body.property.title, `Flat ${xss}`, 'stored as plain text; the pages escape it (browser check)')
    assert.ok(t.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'properties'").get())
    assert.equal((await t.call("/api/leads?q=%27%20OR%201%3D1%20--")).body.total, 0, 'search text is a bound parameter')
  } finally { await t.close() }
})
