// Offers and rental applications (server/offers): buyer → their agent → the listing's owner, and back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startApp, fakeVs, signedInUser } from './helpers.js'
import { openDatabase } from '../server/db.js'

const BANER = { title: '2 BHK in Baner', listing_type: 'sale', property_type: 'apartment', bedrooms: 2, price: 4800000, city: 'Pune', locality: 'Baner', address: '12 Baner Road' }
const REQ = { customer_type: 'buyer', preferred_location: 'Baner, Pune', bedrooms: 2, budget_max: 5000000, property_type: 'apartment' }
const UNKNOWN = '00000000-0000-4000-8000-000000000000'

/** An agent serving Pune, a seller with a published listing, and a buyer with requirements and an open interest in it. */
async function market({ interest = true, listing = BANER } = {}) {
  const t = await startApp({ vs: fakeVs() })
  const agent = t.user
  await t.call('/api/me/profile', { method: 'PATCH', body: { serviceAreas: ['Pune'] } })
  const buyer = signedInUser(t.db, { name: 'Rahul Sharma', email: 'rahul@example.com', role: 'buyer' })
  const seller = signedInUser(t.db, { name: 'Sunita Rao', email: 'sunita@example.com', role: 'seller' })
  const property = (await t.call('/api/properties', { method: 'POST', body: { property: listing, publish: true }, as: seller })).body.property
  await t.call('/api/me/requirements', { method: 'PUT', body: { requirements: REQ, matchingConsent: true }, as: buyer })
  await t.idle()
  if (interest) assert.equal((await t.call('/api/me/interests', { method: 'POST', body: { propertyId: property.id }, as: buyer })).status, 201)
  await t.idle()
  return { t, agent, buyer, seller, property }
}
const as = (t, who) => (path, opts = {}) => t.call(path, { body: opts.method === 'POST' && opts.body === undefined ? {} : opts.body, ...opts, as: who })
const offerNotes = (t, user) => t.db.prepare("SELECT * FROM notifications WHERE user_id = ? AND kind = 'offer' ORDER BY id").all(user.id)

test('offer: submit → forward → counter → accept the counter → recorded as agreed; each side sees only its part', async () => {
  const { t, agent, buyer, seller, property } = await market()
  try {
    const b = as(t, buyer); const s = as(t, seller); const a = as(t, agent)
    const sub = await b('/api/me/offers', { method: 'POST', body: { propertyId: property.id, amount: 4500000, terms: 'Can close in 60 days' } })
    assert.equal(sub.status, 201)
    const id = sub.body.offer.id
    assert.equal(sub.body.offer.status, 'submitted')
    assert.equal(sub.body.offer.kind, 'offer')
    const again = await b('/api/me/offers', { method: 'POST', body: { propertyId: property.id, amount: 4400000 } })
    assert.equal(again.status, 200, 'a second submission returns the active offer')
    assert.equal(again.body.offer.id, id)
    assert.equal(again.body.offer.amount, 4500000)
    await t.idle()
    // The owner sees nothing until the agent forwards it.
    assert.deepEqual((await s('/api/listing-offers')).body.offers, [])
    assert.equal((await s(`/api/listing-offers/${id}/respond`, { method: 'POST', body: { action: 'accept' } })).status, 404)
    const mine = (await a('/api/offers')).body.offers
    assert.equal(mine.length, 1)
    assert.equal(mine[0].lead.name, 'Rahul Sharma')
    assert.equal(mine[0].owner.role, 'seller')
    assert.equal((await a(`/api/offers/${id}/forward`, { method: 'POST', body: { note: 'Serious buyer, loan pre-approved' } })).body.offer.status, 'forwarded')
    assert.equal((await a(`/api/offers/${id}/forward`, { method: 'POST' })).status, 409, 'forwarding twice is refused')
    await t.idle()
    // The owner sees the terms and the buyer's agent, never the buyer.
    const so = await s('/api/listing-offers')
    assert.equal(so.body.offers.length, 1)
    assert.equal(so.body.offers[0].buyerAgentName, 'Asha Broker')
    assert.doesNotMatch(so.text, /Rahul|rahul@example|lead/i)
    const counter = await s(`/api/listing-offers/${id}/respond`, { method: 'POST', body: { action: 'counter', amount: 4700000, note: 'Lowest is 47 L' } })
    assert.equal(counter.body.offer.status, 'countered')
    assert.equal((await s(`/api/listing-offers/${id}/respond`, { method: 'POST', body: { action: 'accept' } })).status, 409, 'only a forwarded offer can be answered')
    await t.idle()
    const seen = (await b('/api/me/offers')).body.offers[0]
    assert.equal(seen.status, 'countered')
    assert.equal(seen.counterAmount, 4700000)
    assert.equal(seen.ownerNote, 'Lowest is 47 L')
    const acc = await b(`/api/me/offers/${id}/accept-counter`, { method: 'POST' })
    assert.equal(acc.body.offer.status, 'accepted')
    assert.equal(acc.body.offer.amount, 4700000)
    assert.match(acc.body.offer.disclaimer, /not a sale or rental agreement, a payment or a transfer/)
    assert.equal((await b(`/api/me/offers/${id}/accept-counter`, { method: 'POST' })).status, 409)
    await t.idle()
    // My requests shows the offer and the next step; the listing itself is untouched (no automatic "sold").
    const req = (await b('/api/me/interests')).body.interests[0]
    assert.equal(req.offer.id, id)
    assert.equal(req.next.type, 'offer_accepted')
    assert.equal(req.canOffer, false)
    assert.equal(t.db.prepare('SELECT status FROM properties WHERE id = ?').get(property.id).status, 'available')
    // Only the request the offer was made on shows it (not an older, withdrawn request on the same listing).
    t.db.prepare("INSERT INTO property_interests (id, lead_id, buyer_user_id, property_id, status, created_at, updated_at, withdrawn_at) VALUES ('old', ?, ?, ?, 'withdrawn', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')").run(req.offer && t.db.prepare('SELECT lead_id FROM offers WHERE id = ?').get(id).lead_id, buyer.id, property.id)
    const all = (await b('/api/me/interests')).body.interests
    assert.equal(all.length, 2)
    assert.equal(all.find((x) => x.id === 'old').offer, null)
    assert.equal((await a(`/api/offers/${id}/close`, { method: 'POST', body: { outcome: 'won', note: 'Agreement to be signed at the registrar' } })).body.offer.status, 'closed_won')
    assert.equal((await a(`/api/offers/${id}/close`, { method: 'POST', body: { outcome: 'lost' } })).status, 409)
    await t.idle()
    // History and notifications: each change told once, to the right people, never to whoever made it.
    assert.deepEqual(t.db.prepare('SELECT to_status FROM offer_events WHERE offer_id = ? ORDER BY id').all(id).map((r) => r.to_status), ['submitted', 'forwarded', 'countered', 'accepted', 'closed_won'])
    assert.deepEqual(offerNotes(t, agent).map((n) => n.title), ['New offer on 2 BHK in Baner', 'Counter-offer on 2 BHK in Baner', 'Offer accepted in principle: 2 BHK in Baner'])
    assert.deepEqual(offerNotes(t, seller).map((n) => n.title), ['An offer was forwarded to you for 2 BHK in Baner', 'Offer accepted in principle: 2 BHK in Baner', 'Recorded as agreed: 2 BHK in Baner'])
    assert.deepEqual(offerNotes(t, buyer).map((n) => n.title), ['Counter-offer on 2 BHK in Baner', 'Recorded as agreed: 2 BHK in Baner'])
    for (const n of offerNotes(t, seller)) assert.doesNotMatch(`${n.title} ${n.body}`, /Rahul/)
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'offer' AND channel != 'in_app'").get().n, 0, 'no email or other channel')
    // Running every event again tells nobody twice.
    const before = t.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'offer'").get().n
    t.db.prepare("UPDATE domain_events SET status = 'pending', next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE type = 'offer.changed'").run()
    await t.events.drain()
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'offer'").get().n, before)
  } finally { await t.close() }
})

test('offer: revise after a counter goes back through the agent; withdraw ends it; a new offer may follow', async () => {
  const { t, agent, buyer, seller, property } = await market()
  try {
    const b = as(t, buyer); const s = as(t, seller); const a = as(t, agent)
    const id = (await b('/api/me/offers', { method: 'POST', body: { propertyId: property.id, amount: '4500000' } })).body.offer.id
    assert.equal((await b(`/api/me/offers/${id}/revise`, { method: 'POST', body: { amount: 4600000 } })).status, 409, 'revise only answers a counter')
    await a(`/api/offers/${id}/forward`, { method: 'POST' })
    await s(`/api/listing-offers/${id}/respond`, { method: 'POST', body: { action: 'counter', amount: 4800000 } })
    const rev = await b(`/api/me/offers/${id}/revise`, { method: 'POST', body: { amount: 4650000, terms: 'Final offer' } })
    assert.equal(rev.body.offer.status, 'submitted')
    assert.equal(rev.body.offer.amount, 4650000)
    assert.equal(rev.body.offer.counterAmount, null)
    assert.equal((await s(`/api/listing-offers/${id}/respond`, { method: 'POST', body: { action: 'accept' } })).status, 409, 'the owner waits for the agent to forward again')
    await a(`/api/offers/${id}/forward`, { method: 'POST' })
    assert.equal((await s(`/api/listing-offers/${id}/respond`, { method: 'POST', body: { action: 'counter', amount: 4650000 } })).status, 400, 'a counter at the same amount is an accept')
    assert.equal((await s(`/api/listing-offers/${id}/respond`, { method: 'POST', body: { action: 'reject', note: 'Too low' } })).body.offer.status, 'rejected')
    assert.equal((await b(`/api/me/offers/${id}/withdraw`, { method: 'POST' })).status, 409, 'a declined offer cannot be withdrawn')
    // After a decline the buyer may offer again: a new offer, the old one kept.
    const second = await b('/api/me/offers', { method: 'POST', body: { propertyId: property.id, amount: 4750000 } })
    assert.equal(second.status, 201)
    assert.notEqual(second.body.offer.id, id)
    assert.equal((await b(`/api/me/offers/${second.body.offer.id}/withdraw`, { method: 'POST' })).body.offer.status, 'withdrawn')
    assert.equal((await b(`/api/me/offers/${second.body.offer.id}/withdraw`, { method: 'POST' })).status, 200, 'withdrawing twice answers with its state')
    assert.equal((await a(`/api/offers/${second.body.offer.id}/forward`, { method: 'POST' })).status, 409)
    assert.deepEqual(t.db.prepare('SELECT status FROM offers ORDER BY created_at').all().map((r) => r.status), ['rejected', 'withdrawn'])
    // Not going ahead, from any active state, by the agent.
    const third = (await b('/api/me/offers', { method: 'POST', body: { propertyId: property.id, amount: 4700000 } })).body.offer.id
    assert.equal((await a(`/api/offers/${third}/close`, { method: 'POST', body: { outcome: 'won' } })).status, 409, 'only an accepted offer can be recorded as agreed')
    assert.equal((await a(`/api/offers/${third}/close`, { method: 'POST', body: { outcome: 'maybe' } })).status, 400)
    assert.equal((await a(`/api/offers/${third}/close`, { method: 'POST', body: { outcome: 'lost', note: 'Buyer chose another flat' } })).body.offer.status, 'closed_lost')
    assert.equal((await a('/api/offers?status=all')).body.offers.length, 3)
    assert.equal((await a('/api/offers')).body.offers.length, 0, 'active only by default')
    assert.equal((await a('/api/offers?status=bogus')).status, 400)
  } finally { await t.close() }
})

test('offer: concurrent moves settle once; the database allows one active offer per lead and listing', async () => {
  const { t, agent, buyer, seller, property } = await market()
  try {
    const b = as(t, buyer); const s = as(t, seller); const a = as(t, agent)
    const burst = await Promise.all(Array.from({ length: 5 }, () => b('/api/me/offers', { method: 'POST', body: { propertyId: property.id, amount: 4500000 } })))
    assert.equal(burst.filter((r) => r.status === 201).length, 1)
    assert.equal(new Set(burst.map((r) => r.body.offer.id)).size, 1)
    const id = burst[0].body.offer.id
    const fw = await Promise.all([a(`/api/offers/${id}/forward`, { method: 'POST' }), a(`/api/offers/${id}/forward`, { method: 'POST' })])
    assert.deepEqual(fw.map((r) => r.status).sort(), [200, 409])
    const race = await Promise.all([s(`/api/listing-offers/${id}/respond`, { method: 'POST', body: { action: 'accept' } }), b(`/api/me/offers/${id}/withdraw`, { method: 'POST' })])
    assert.equal(race.filter((r) => r.status === 200).length >= 1, true)
    const final = t.db.prepare('SELECT status FROM offers WHERE id = ?').get(id).status
    assert.ok(['accepted', 'withdrawn'].includes(final), final)
    // Each successful move is recorded exactly once (accept then withdraw may both succeed, in that order).
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM offer_events WHERE offer_id = ? AND to_status IN ('accepted', 'withdrawn')").get(id).n, race.filter((r) => r.status === 200).length)
    const row = t.db.prepare('SELECT * FROM offers WHERE id = ?').get(id)
    t.db.prepare("UPDATE offers SET status = 'submitted' WHERE id = ?").run(id)
    assert.throws(() => t.db.prepare("INSERT INTO offers (id, interest_id, lead_id, buyer_user_id, property_id, kind, amount, status, created_at, updated_at) VALUES ('x', ?, ?, ?, ?, 'offer', 1, 'submitted', 't', 't')").run(row.interest_id, row.lead_id, row.buyer_user_id, row.property_id), /UNIQUE/)
    assert.throws(() => t.db.prepare("UPDATE offers SET status = 'signed' WHERE id = ?").run(id), /CHECK/)
  } finally { await t.close() }
})

test('offer: needs requirements, an open interest, an assigned agent and an available listing; amounts are validated', async () => {
  const { t, agent, buyer, seller, property } = await market({ interest: false })
  try {
    const b = as(t, buyer)
    const nobody = signedInUser(t.db, { name: 'No Req', email: 'noreq@example.com', role: 'buyer' })
    assert.equal((await t.call('/api/me/offers', { method: 'POST', body: { propertyId: property.id, amount: 1 }, as: nobody })).body.error.code, 'no_requirements')
    assert.equal((await b('/api/me/offers', { method: 'POST', body: { propertyId: property.id, amount: 4500000 } })).body.error.code, 'interest_required')
    for (const amount of [0, -5, 1.5, 'abc', null, 1e12, '45,00,000']) assert.equal((await b('/api/me/offers', { method: 'POST', body: { propertyId: property.id, amount } })).status, 400, String(amount))
    assert.equal((await b('/api/me/offers', { method: 'POST', body: { propertyId: 'x', amount: 1 } })).status, 404)
    assert.equal((await b('/api/me/offers', { method: 'POST', body: { propertyId: property.id, amount: 1, terms: 'x'.repeat(501) } })).status, 400)
    await b('/api/me/interests', { method: 'POST', body: { propertyId: property.id } })
    // The listing leaves the market: no new offer.
    await t.call(`/api/properties/${property.id}`, { method: 'PATCH', body: { property: { status: 'under_offer' } }, as: seller })
    assert.equal((await b('/api/me/offers', { method: 'POST', body: { propertyId: property.id, amount: 4500000 } })).body.error.code, 'listing_unavailable')
    await t.call(`/api/properties/${property.id}`, { method: 'PATCH', body: { property: { status: 'available' } }, as: seller })
    // No agent assigned yet: refused (the agent passes offers on).
    t.db.prepare('UPDATE leads SET assigned_agent_id = NULL WHERE buyer_user_id = ?').run(buyer.id)
    assert.equal((await b('/api/me/offers', { method: 'POST', body: { propertyId: property.id, amount: 4500000 } })).body.error.code, 'no_agent')
    t.db.prepare('UPDATE leads SET assigned_agent_id = ? WHERE buyer_user_id = ?').run(agent.id, buyer.id)
    assert.equal((await b('/api/me/offers', { method: 'POST', body: { propertyId: property.id, amount: 4500000 } })).status, 201)
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM offers').get().n, 1)
  } finally { await t.close() }
})

test('offer: while an offer is active its interest cannot be withdrawn or closed', async () => {
  const { t, agent, buyer, property } = await market()
  try {
    const b = as(t, buyer)
    const interestId = (await b('/api/me/interests')).body.interests[0].id
    const id = (await b('/api/me/offers', { method: 'POST', body: { propertyId: property.id, amount: 4500000 } })).body.offer.id
    assert.equal((await b(`/api/me/interests/${interestId}/withdraw`, { method: 'POST' })).body.error.code, 'offer_active')
    assert.equal((await t.call(`/api/interests/${interestId}/close`, { method: 'POST', body: {}, as: agent })).body.error.code, 'offer_active')
    await b(`/api/me/offers/${id}/withdraw`, { method: 'POST' })
    assert.equal((await b(`/api/me/interests/${interestId}/withdraw`, { method: 'POST' })).status, 200)
  } finally { await t.close() }
})

test('offer: rental applications carry a move-in date; the next step points to the existing tenancy setup', async () => {
  const RENT = { ...BANER, title: '2 BHK to rent in Baner', listing_type: 'rent', price: 25000 }
  const { t, agent, buyer, seller, property } = await market({ listing: RENT })
  try {
    const b = as(t, buyer)
    assert.equal((await b('/api/me/offers', { method: 'POST', body: { propertyId: property.id, amount: 24000, moveInDate: '2026-13-40' } })).status, 400)
    const app = await b('/api/me/offers', { method: 'POST', body: { propertyId: property.id, amount: 24000, moveInDate: '2026-12-01', terms: 'Family of three' } })
    assert.equal(app.status, 201)
    assert.equal(app.body.offer.kind, 'application')
    assert.equal(app.body.offer.moveInDate, '2026-12-01')
    await t.call(`/api/offers/${app.body.offer.id}/forward`, { method: 'POST', body: {}, as: agent })
    assert.equal((await t.call(`/api/listing-offers/${app.body.offer.id}/respond`, { method: 'POST', body: { action: 'accept' }, as: seller })).body.offer.status, 'accepted')
    await t.idle()
    assert.deepEqual(offerNotes(t, buyer).map((n) => n.title), ['Rental application accepted in principle: 2 BHK to rent in Baner'])
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM tenancies').get().n, 0, 'no tenancy is created automatically')
  } finally { await t.close() }
})

test('offer: an agent who owns the listing answers through the same owner view, and is not told twice', async () => {
  const t = await startApp({ vs: fakeVs() })
  try {
    const agent = t.user
    await t.call('/api/me/profile', { method: 'PATCH', body: { serviceAreas: ['Pune'] } })
    const buyer = signedInUser(t.db, { name: 'Rahul Sharma', email: 'rahul@example.com', role: 'buyer' })
    const property = (await t.call('/api/properties', { method: 'POST', body: { property: BANER } })).body.property
    await t.call('/api/me/requirements', { method: 'PUT', body: { requirements: REQ, matchingConsent: true }, as: buyer })
    await t.idle()
    await t.call('/api/me/interests', { method: 'POST', body: { propertyId: property.id }, as: buyer })
    const id = (await t.call('/api/me/offers', { method: 'POST', body: { propertyId: property.id, amount: 4500000 }, as: buyer })).body.offer.id
    await t.call(`/api/offers/${id}/forward`, { method: 'POST', body: {} })
    assert.equal((await t.call('/api/listing-offers')).body.offers.length, 1)
    assert.equal((await t.call(`/api/listing-offers/${id}/respond`, { method: 'POST', body: { action: 'accept' } })).body.offer.status, 'accepted')
    await t.idle()
    assert.deepEqual(offerNotes(t, agent).map((n) => n.title), ['New offer on 2 BHK in Baner'], 'the agent made the other moves themselves')
  } finally { await t.close() }
})

test('offer: every endpoint is refused to the wrong role, other buyers, other agents and other sellers', async () => {
  const { t, agent, buyer, seller, property } = await market()
  try {
    const id = (await t.call('/api/me/offers', { method: 'POST', body: { propertyId: property.id, amount: 4500000 }, as: buyer })).body.offer.id
    const otherBuyer = signedInUser(t.db, { name: 'Priya Nair', email: 'priya@example.com', role: 'buyer' })
    const otherAgent = signedInUser(t.db, { name: 'Other Agent' })
    const otherSeller = signedInUser(t.db, { name: 'Other Seller', email: 'os@example.com', role: 'seller' })
    const ob = as(t, otherBuyer); const oa = as(t, otherAgent); const os = as(t, otherSeller)
    assert.deepEqual((await ob('/api/me/offers')).body.offers, [])
    for (const act of ['withdraw', 'accept-counter', 'revise']) assert.equal((await ob(`/api/me/offers/${id}/${act}`, { method: 'POST', body: { amount: 1 } })).status, 404, act)
    assert.deepEqual((await oa('/api/offers')).body.offers, [])
    for (const act of ['forward', 'close']) assert.equal((await oa(`/api/offers/${id}/${act}`, { method: 'POST', body: { outcome: 'lost' } })).status, 404, act)
    const leadId = t.db.prepare('SELECT lead_id FROM buyer_profiles WHERE user_id = ?').get(buyer.id).lead_id
    assert.equal((await oa(`/api/leads/${leadId}/offers`)).status, 404)
    assert.equal((await t.call(`/api/leads/${leadId}/offers`, { as: agent })).body.offers.length, 1)
    await t.call(`/api/offers/${id}/forward`, { method: 'POST', body: {}, as: agent })
    assert.deepEqual((await os('/api/listing-offers')).body.offers, [])
    assert.equal((await os(`/api/listing-offers/${id}/respond`, { method: 'POST', body: { action: 'accept' } })).status, 404)
    assert.deepEqual((await oa('/api/listing-offers')).body.offers, [], 'an agent who does not own the listing sees nothing')
    const b = as(t, buyer); const s = as(t, seller)
    for (const path of ['/api/offers', `/api/leads/${leadId}/offers`, '/api/listing-offers']) assert.equal((await b(path)).status, 403, `buyer ${path}`)
    for (const path of [`/api/offers/${id}/forward`, `/api/listing-offers/${id}/respond`]) assert.equal((await b(path, { method: 'POST' })).status, 403, `buyer ${path}`)
    for (const path of ['/api/me/offers', '/api/offers']) assert.equal((await s(path)).status, 403, `seller ${path}`)
    for (const path of ['/api/me/offers', `/api/offers/${id}/forward`, `/api/me/offers/${id}/withdraw`]) assert.equal((await s(path, { method: 'POST' })).status, 403, `seller ${path}`)
    assert.equal((await t.call('/api/me/offers', { method: 'POST', body: { propertyId: property.id, amount: 1 }, as: agent })).status, 403)
    for (const path of ['/api/me/offers', '/api/offers', '/api/listing-offers']) assert.equal((await t.call(path, { as: null })).status, 401)
    assert.equal((await b(`/api/me/offers/${UNKNOWN}/withdraw`, { method: 'POST' })).status, 404)
    assert.equal((await b('/api/me/offers/not-a-uuid/withdraw', { method: 'POST' })).status, 404)
    // A client-supplied buyer or lead id is ignored.
    const spoof = await ob('/api/me/offers', { method: 'POST', body: { propertyId: property.id, amount: 1, buyerUserId: buyer.id, leadId } })
    assert.equal(spoof.body.error.code, 'no_requirements')
    assert.equal(t.db.prepare('SELECT status FROM offers WHERE id = ?').get(id).status, 'forwarded')
  } finally { await t.close() }
})

test('migration 10 adds offers to a v9 database: a backup first, existing rows unchanged, the old app still runs on v10', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-m10-'))
  const file = join(dir, 'd.db')
  const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name)
  const snapshot = (db) => Object.fromEntries(tables(db).filter((n) => !['schema_version', 'offers', 'offer_events'].includes(n)).map((n) => [n, db.prepare(`SELECT * FROM "${n}" ORDER BY rowid`).all()]))
  try {
    const old = openDatabase(file, { upTo: 9 })
    const t = await startApp({ vs: fakeVs(), db: old })
    await t.call('/api/me/profile', { method: 'PATCH', body: { serviceAreas: ['Pune'] } })
    const buyer = signedInUser(old, { name: 'Rahul Sharma', email: 'rahul@example.com', role: 'buyer' })
    const property = (await t.call('/api/properties', { method: 'POST', body: { property: BANER } })).body.property
    await t.call('/api/me/requirements', { method: 'PUT', body: { requirements: REQ, matchingConsent: true }, as: buyer })
    await t.close()
    // A v9 interest row as the v9 release wrote it (this code needs v10, so it is written directly).
    const leadId = old.prepare('SELECT lead_id FROM buyer_profiles WHERE user_id = ?').get(buyer.id).lead_id
    old.prepare("INSERT INTO property_interests (id, lead_id, buyer_user_id, property_id, status, note, created_at, updated_at) VALUES ('i1', ?, ?, ?, 'open', 'kept', datetime('now'), datetime('now'))").run(leadId, buyer.id, property.id)
    assert.equal(old.prepare('SELECT version FROM schema_version').get().version, 9)
    const before = snapshot(old)
    assert.equal(before.property_interests.length, 1)
    old.close()
    const logs = []
    const db = openDatabase(file, { log: (l) => logs.push(l), upTo: 10 })
    assert.equal(db.prepare('SELECT version FROM schema_version').get().version, 10)
    assert.match(logs.join('\n'), /Backed up the database before migrating v9 → v10/)
    assert.deepEqual(snapshot(db), before)
    assert.equal(readdirSync(dir).filter((f) => /^d\.db\.pre-v10-\d+\.bak$/.test(f)).length, 1)
    const t2 = await startApp({ db, withUser: false })
    try { assert.equal((await t2.call('/api/me/offers', { method: 'POST', body: { propertyId: property.id, amount: 4500000 }, as: buyer })).status, 201) } finally { await t2.close() }
    db.close()
    // The previous code (schema 9) opens a v10 database without migrating or touching it.
    const back = openDatabase(file, { upTo: 9 })
    assert.equal(back.prepare('SELECT version FROM schema_version').get().version, 10)
    assert.equal(back.prepare('SELECT COUNT(*) AS n FROM offers').get().n, 1)
    back.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
