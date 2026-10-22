// "I'm interested" and My requests (server/interests): on the buyer's own lead, told only to their assigned agent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startApp, fakeVs, signedInUser } from './helpers.js'
import { openDatabase } from '../server/db.js'
import { MAX_OPEN } from '../server/interests/service.js'
import { addDays, todayIn } from '../server/time.js'

const BANER = { title: '2 BHK in Baner', listing_type: 'sale', property_type: 'apartment', bedrooms: 2, price: 4800000, city: 'Pune', locality: 'Baner', address: '12 Baner Road', notes: 'Owner prefers evenings' }
const REQ = { customer_type: 'buyer', preferred_location: 'Baner, Pune', bedrooms: 2, budget_max: 5000000, property_type: 'apartment' }
const UNKNOWN = '00000000-0000-4000-8000-000000000000'

/** One agent serving Pune with a published listing, and a buyer who saved requirements (so has a lead). */
async function market({ vs = fakeVs(), areas = ['Pune'], requirements = true } = {}) {
  const t = await startApp({ vs })
  const agent = t.user
  await t.call('/api/me/profile', { method: 'PATCH', body: { serviceAreas: areas } })
  const buyer = signedInUser(t.db, { name: 'Rahul Sharma', email: 'rahul@example.com', role: 'buyer' })
  const seller = signedInUser(t.db, { name: 'Sunita Rao', email: 'sunita@example.com', role: 'seller' })
  const property = (await t.call('/api/properties', { method: 'POST', body: { property: BANER } })).body.property
  if (requirements) await t.call('/api/me/requirements', { method: 'PUT', body: { requirements: REQ, matchingConsent: true }, as: buyer })
  await t.idle()
  return { t, vs, agent, buyer, seller, property }
}
const as = (t, who) => (path, opts = {}) => t.call(path, { ...opts, as: who })
const interestNotes = (t, user) => t.db.prepare("SELECT * FROM notifications WHERE user_id = ? AND channel = 'in_app' AND kind = 'interest'").all(user.id)
const interest = (t, buyer, propertyId, note) => t.call('/api/me/interests', { method: 'POST', body: { propertyId, ...(note ? { note } : {}) }, as: buyer })

test('interest: created on the buyer\'s own lead, the assigned agent is told once in the app, nobody else', async () => {
  const { t, agent, buyer, seller, property } = await market()
  try {
    const leads = t.db.prepare('SELECT COUNT(*) AS n FROM leads').get().n
    const r = await interest(t, buyer, property.id, '  Is parking   included? ')
    assert.equal(r.status, 201)
    assert.equal(r.body.created, true)
    const i = r.body.interest
    assert.equal(i.status, 'open')
    assert.equal(i.note, 'Is parking included?')
    assert.equal(i.property.title, '2 BHK in Baner')
    assert.equal(i.property.address, undefined, 'no street address in the request')
    assert.equal(i.agentName, 'Asha Broker')
    assert.equal(i.next.type, 'request_viewing')
    await t.idle()
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM leads').get().n, leads, 'no lead created')
    const row = t.db.prepare('SELECT * FROM property_interests WHERE id = ?').get(i.id)
    assert.equal(row.buyer_user_id, buyer.id)
    assert.equal(row.lead_id, t.db.prepare('SELECT lead_id FROM buyer_profiles WHERE user_id = ?').get(buyer.id).lead_id)
    const n = interestNotes(t, agent)
    assert.equal(n.length, 1)
    assert.match(n[0].title, /Rahul Sharma is interested in 2 BHK in Baner/)
    assert.equal(n[0].body, 'Is parking included?')
    assert.equal(n[0].link, `#/leads/${row.lead_id}`)
    assert.equal(interestNotes(t, buyer).length + interestNotes(t, seller).length, 0)
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'interest' AND channel != 'in_app'").get().n, 0, 'no email, Slack or WhatsApp')
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM lead_activities WHERE lead_id = ? AND type = 'interest_created'").get(row.lead_id).n, 1)
    const mine = (await t.call('/api/me/interests', { as: buyer })).body.interests
    assert.deepEqual(mine.map((x) => x.id), [i.id])
  } finally { await t.close() }
})

test('interest: repeated and concurrent clicks give one request and one notification; the database refuses a second open one', async () => {
  const { t, agent, buyer, property } = await market()
  try {
    const first = await interest(t, buyer, property.id)
    const again = await interest(t, buyer, property.id)
    assert.equal(again.status, 200)
    assert.equal(again.body.created, false)
    assert.equal(again.body.interest.id, first.body.interest.id)
    const burst = await Promise.all(Array.from({ length: 6 }, () => interest(t, buyer, property.id)))
    assert.ok(burst.every((r) => r.status === 200 && r.body.interest.id === first.body.interest.id))
    await t.idle()
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM property_interests').get().n, 1)
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM domain_events WHERE type = 'interest.created'").get().n, 1)
    assert.equal(interestNotes(t, agent).length, 1)
    const row = t.db.prepare('SELECT * FROM property_interests').get()
    assert.throws(() => t.db.prepare("INSERT INTO property_interests (id, lead_id, buyer_user_id, property_id, status, created_at, updated_at) VALUES ('x', ?, ?, ?, 'open', 't', 't')").run(row.lead_id, row.buyer_user_id, row.property_id), /UNIQUE/)
    assert.throws(() => t.db.prepare("UPDATE property_interests SET status = 'pending'").run(), /CHECK/)
  } finally { await t.close() }
})

test('interest: withdraw, withdraw again, show interest again (history kept, agent not flooded), closed by the agent', async () => {
  const { t, agent, buyer, property } = await market()
  try {
    const id = (await interest(t, buyer, property.id)).body.interest.id
    await t.idle()
    const w = await t.call(`/api/me/interests/${id}/withdraw`, { method: 'POST', body: {}, as: buyer })
    assert.equal(w.status, 200)
    assert.equal(w.body.interest.status, 'withdrawn')
    assert.equal(w.body.interest.next.type, 'express_again')
    const w2 = await t.call(`/api/me/interests/${id}/withdraw`, { method: 'POST', body: {}, as: buyer })
    assert.equal(w2.status, 200, 'withdrawing twice answers with its state')
    assert.equal(w2.body.interest.status, 'withdrawn')
    // Showing interest again opens a new request; the withdrawn one stays in the history.
    const again = await interest(t, buyer, property.id)
    assert.equal(again.status, 201)
    assert.notEqual(again.body.interest.id, id)
    await t.idle()
    assert.deepEqual(t.db.prepare('SELECT status FROM property_interests ORDER BY created_at').all().map((r) => r.status), ['withdrawn', 'open'])
    assert.equal(interestNotes(t, agent).length, 1, 'one notification per lead, listing and day')
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM domain_events WHERE type = 'interest.withdrawn'").get().n, 1)
    // The agent closes it; the buyer sees why, cannot withdraw it, and may show interest again.
    const c = await t.call(`/api/interests/${again.body.interest.id}/close`, { method: 'POST', body: { reason: 'Seller accepted another buyer' } })
    assert.equal(c.status, 200)
    assert.equal(c.body.interest.status, 'closed')
    const list = (await t.call('/api/me/interests', { as: buyer })).body.interests
    const closed = list.find((x) => x.id === again.body.interest.id)
    assert.equal(closed.status, 'closed')
    assert.equal(closed.closedReason, 'Seller accepted another buyer')
    assert.equal(closed.next.type, 'closed')
    assert.equal((await t.call(`/api/me/interests/${closed.id}/withdraw`, { method: 'POST', body: {}, as: buyer })).status, 409)
    assert.equal((await t.call(`/api/interests/${id}/close`, { method: 'POST', body: {} })).status, 409, 'a withdrawn request cannot be closed')
    assert.equal((await t.call(`/api/interests/${closed.id}/close`, { method: 'POST', body: {} })).status, 200, 'closing twice answers with its state')
    assert.equal((await interest(t, buyer, property.id)).status, 201)
  } finally { await t.close() }
})

test('interest: needs saved requirements (no lead is ever created here), and a lead that is gone is not replaced', async () => {
  const { t, buyer, property } = await market({ requirements: false })
  try {
    const leads = t.db.prepare('SELECT COUNT(*) AS n FROM leads').get().n
    const r = await interest(t, buyer, property.id)
    assert.equal(r.status, 409)
    assert.equal(r.body.error.code, 'no_requirements')
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM leads').get().n, leads)
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM property_interests').get().n, 0)
    // A profile still pointing at a lead that no longer exists (deleted): refused the same way, nothing created.
    await t.call('/api/me/requirements', { method: 'PUT', body: { requirements: REQ, matchingConsent: true }, as: buyer })
    await t.idle()
    const leadId = t.db.prepare('SELECT lead_id FROM buyer_profiles WHERE user_id = ?').get(buyer.id).lead_id
    t.db.exec('PRAGMA foreign_keys = OFF')
    t.db.prepare('DELETE FROM leads WHERE id = ?').run(leadId)
    t.db.exec('PRAGMA foreign_keys = ON')
    const gone = await interest(t, buyer, property.id)
    assert.equal(gone.status, 409)
    assert.equal(gone.body.error.code, 'no_requirements')
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM leads WHERE buyer_user_id = ?').get(buyer.id).n, 0, 'no replacement lead')
  } finally { await t.close() }
})

test('interest: hidden or unavailable listings are refused; one that later leaves the market shows as unavailable', async () => {
  const { t, buyer, seller, property } = await market()
  try {
    const draft = (await t.call('/api/properties', { method: 'POST', body: { property: { ...BANER, title: 'Draft in Baner' }, publish: false } })).body.property
    const sample = (await t.call('/api/properties/samples', { method: 'POST', body: {} })).body.properties[0]
    assert.ok(sample?.id, 'a sample listing exists')
    const sold = (await t.call('/api/properties', { method: 'POST', body: { property: { ...BANER, title: 'Sold in Baner' } } })).body.property
    await t.call(`/api/properties/${sold.id}`, { method: 'PATCH', body: { property: { status: 'sold' } } })
    for (const [what, id] of [['draft', draft.id], ['sold', sold.id], ['missing', 999999], ['bad id', 'abc'], ['sample', sample.id]]) {
      const r = await interest(t, buyer, id)
      assert.equal(r.status, 404, what)
      assert.equal(r.body.error.code, 'property_not_found', what)
    }
    assert.equal((await interest(t, buyer, property.id, 'x'.repeat(301))).status, 400, 'note too long')
    assert.equal((await interest(t, buyer, property.id, { evil: 1 })).status, 400, 'note must be text')
    const id = (await interest(t, buyer, property.id)).body.interest.id
    await t.call(`/api/properties/${property.id}`, { method: 'PATCH', body: { property: { status: 'under_offer' } } })
    const shown = (await t.call('/api/me/interests', { as: buyer })).body.interests.find((x) => x.id === id)
    assert.equal(shown.property.available, false)
    assert.equal(shown.property.title, '2 BHK in Baner')
    assert.equal(shown.next.type, 'unavailable')
    assert.equal(seller.role, 'seller')
  } finally { await t.close() }
})

test('interest: buyers, agents and sellers reach only what is theirs; the listing owner and its agent learn nothing', async () => {
  const { t, agent, buyer, seller } = await market()
  try {
    // A seller's listing, handled by a second agent: the buyer's agent (by service area) is the first one.
    const listingAgent = signedInUser(t.db, { name: 'Listing Agent' })
    const theirs = (await t.call('/api/properties', { method: 'POST', body: { property: { ...BANER, title: 'Their 2 BHK in Baner' } }, as: listingAgent })).body.property
    const own = (await t.call('/api/properties', { method: 'POST', body: { property: { ...BANER, title: 'Seller 2 BHK in Baner' }, publish: true }, as: seller })).body.property
    const otherBuyer = signedInUser(t.db, { name: 'Priya Nair', email: 'priya@example.com', role: 'buyer' })
    await t.call('/api/me/requirements', { method: 'PUT', body: { requirements: REQ, matchingConsent: true }, as: otherBuyer })
    await t.idle()
    const a = (await interest(t, buyer, theirs.id)).body.interest
    const b = (await interest(t, buyer, own.id)).body.interest
    const p = (await interest(t, otherBuyer, theirs.id)).body.interest
    await t.idle()
    // Only the buyers' assigned agent is told and sees them.
    assert.equal(interestNotes(t, agent).length, 3)
    assert.equal(interestNotes(t, listingAgent).length, 0)
    assert.equal(interestNotes(t, seller).length, 0)
    assert.deepEqual((await t.call('/api/interests')).body.interests.map((x) => x.id).sort(), [a.id, b.id, p.id].sort())
    const la = as(t, listingAgent)
    assert.deepEqual((await la('/api/interests')).body.interests, [])
    assert.equal((await la(`/api/interests/${a.id}/close`, { method: 'POST', body: {} })).status, 404)
    const leadId = t.db.prepare('SELECT lead_id FROM buyer_profiles WHERE user_id = ?').get(buyer.id).lead_id
    assert.equal((await la(`/api/leads/${leadId}/interests`)).status, 404)
    assert.equal((await t.call(`/api/leads/${leadId}/interests`)).body.interests.length, 2)
    // Buyers see and change only their own.
    const ob = as(t, otherBuyer)
    assert.deepEqual((await ob('/api/me/interests')).body.interests.map((x) => x.id), [p.id])
    assert.equal((await ob(`/api/me/interests/${a.id}/withdraw`, { method: 'POST', body: {} })).status, 404)
    assert.equal(t.db.prepare('SELECT status FROM property_interests WHERE id = ?').get(a.id).status, 'open')
    assert.equal((await ob(`/api/me/interests/${UNKNOWN}/withdraw`, { method: 'POST', body: {} })).status, 404)
    assert.equal((await ob('/api/me/interests/not-a-uuid/withdraw', { method: 'POST', body: {} })).status, 404)
    // A client-supplied buyer or lead id is ignored: the request is always the signed-in buyer's.
    const spoof = await ob('/api/me/interests', { method: 'POST', body: { propertyId: own.id, buyerUserId: buyer.id, leadId } })
    assert.equal(spoof.status, 201)
    assert.equal(t.db.prepare('SELECT buyer_user_id FROM property_interests WHERE id = ?').get(spoof.body.interest.id).buyer_user_id, otherBuyer.id)
    // Roles: every interest endpoint is refused to the wrong role.
    const s = as(t, seller)
    for (const [path, method] of [['/api/me/interests', 'GET'], ['/api/me/interests', 'POST'], [`/api/me/interests/${a.id}/withdraw`, 'POST'], ['/api/interests', 'GET'], [`/api/interests/${a.id}/close`, 'POST'], [`/api/leads/${leadId}/interests`, 'GET']]) {
      assert.equal((await s(path, { method, body: method === 'POST' ? { propertyId: own.id } : undefined })).status, 403, `seller ${method} ${path}`)
    }
    for (const [path, method] of [['/api/interests', 'GET'], [`/api/interests/${a.id}/close`, 'POST'], [`/api/leads/${leadId}/interests`, 'GET']]) {
      assert.equal((await t.call(path, { method, body: method === 'POST' ? {} : undefined, as: buyer })).status, 403, `buyer ${method} ${path}`)
    }
    for (const [path, method] of [['/api/me/interests', 'GET'], ['/api/me/interests', 'POST']]) {
      assert.equal((await t.call(path, { method, body: method === 'POST' ? { propertyId: own.id } : undefined })).status, 403, `agent ${method} ${path}`)
    }
    for (const [path, method] of [['/api/me/interests', 'GET'], ['/api/interests', 'GET']]) assert.equal((await t.call(path, { method, as: null })).status, 401)
    // The seller's own pages carry no buyer interest or identity.
    const sellerView = await s(`/api/properties/${own.id}`)
    assert.doesNotMatch(sellerView.text, /Rahul|Priya|interest/i)
    assert.doesNotMatch((await s('/api/me/listing-viewings')).text, /Rahul|Priya/)
    assert.doesNotMatch((await s('/api/notifications')).text, /Rahul|Priya|interested/)
    assert.doesNotMatch((await la(`/api/properties/${theirs.id}`)).text, /interested/i)
  } finally { await t.close() }
})

test('interest: an unassigned buyer\'s request waits for an agent, who sees it after claiming the lead', async () => {
  const { t, agent, buyer } = await market({ areas: ['Mumbai'] })
  try {
    const listing = (await t.call('/api/properties', { method: 'POST', body: { property: { ...BANER, title: 'Baner flat' } } })).body.property
    const r = await interest(t, buyer, listing.id)
    assert.equal(r.status, 201)
    assert.equal(r.body.interest.agentName, null)
    assert.equal(r.body.interest.next.type, 'await_assignment')
    await t.idle()
    assert.equal(interestNotes(t, agent).length, 0)
    assert.deepEqual((await t.call('/api/interests')).body.interests, [])
    const leadId = t.db.prepare('SELECT lead_id FROM buyer_profiles WHERE user_id = ?').get(buyer.id).lead_id
    assert.equal((await t.call(`/api/pool/${leadId}/claim`, { method: 'POST', body: {} })).status, 200)
    assert.equal((await t.call('/api/interests')).body.interests.length, 1)
    assert.equal((await t.call(`/api/leads/${leadId}/interests`)).body.interests[0].lead.name, 'Rahul Sharma')
  } finally { await t.close() }
})

test('interest: the listing\'s viewing status is shown from the viewings table, not copied', async () => {
  const vs = fakeVs()
  const { t, buyer, property } = await market({ vs })
  try {
    const cal = (await t.call('/api/integrations/connections', { method: 'POST', body: { serviceId: await vs.serviceIdFor('google-calendar'), authId: vs.connectApp(t.user.id, 'google-calendar') } })).body.connection
    await t.call('/api/automations/viewing_scheduler', { method: 'PUT', body: { enabled: true, config: { calendarConnectionId: cal.id, calendarId: 'primary', confirmation: 'none' } } })
    const id = (await interest(t, buyer, property.id)).body.interest.id
    const day = addDays(todayIn('Asia/Kolkata'), 2)
    const slots = (await t.call(`/api/me/viewing-slots?propertyId=${property.id}&date=${day}`, { as: buyer })).body.slots
    const v = await t.call('/api/me/viewings', { method: 'POST', body: { propertyId: property.id, start: slots[0].start }, as: buyer })
    assert.equal(v.status, 201)
    const shown = (await t.call('/api/me/interests', { as: buyer })).body.interests.find((x) => x.id === id)
    assert.equal(shown.viewing.id, v.body.viewing.id)
    assert.equal(shown.viewing.status, 'requested')
    assert.equal(shown.next.type, 'await_viewing')
    assert.equal((await t.call('/api/interests')).body.interests[0].viewing.status, 'requested')
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM viewings').get().n, 1, 'no viewing created by the interest')
  } finally { await t.close() }
})

test('interest: a buyer can have at most MAX_OPEN open requests; a repeat click on an open one still answers', async () => {
  const { t, buyer, property } = await market()
  try {
    const first = (await interest(t, buyer, property.id)).body.interest
    const row = t.db.prepare('SELECT * FROM property_interests').get()
    const ins = t.db.prepare("INSERT INTO properties (title, listing_type, property_type, bedrooms, price, city, locality, status, listing_state, is_sample, created_at, updated_at) VALUES (?, 'sale', 'apartment', 2, 4800000, 'Pune', 'Baner', 'available', 'published', 0, datetime('now'), datetime('now'))")
    for (let n = 1; n < MAX_OPEN; n++) {
      const pid = Number(ins.run(`Filler ${n}`).lastInsertRowid)
      t.db.prepare("INSERT INTO property_interests (id, lead_id, buyer_user_id, property_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', datetime('now'), datetime('now'))").run(`f${n}`, row.lead_id, buyer.id, pid)
    }
    const extra = Number(ins.run('One too many').lastInsertRowid)
    const r = await interest(t, buyer, extra)
    assert.equal(r.status, 409)
    assert.equal(r.body.error.code, 'too_many_interests')
    assert.equal((await interest(t, buyer, property.id)).body.interest.id, first.id, 'an existing open request is still returned')
    await t.call(`/api/me/interests/${first.id}/withdraw`, { method: 'POST', body: {}, as: buyer })
    assert.equal((await interest(t, buyer, extra)).status, 201, 'room again after a withdrawal')
  } finally { await t.close() }
})

test('interest: the agent list filters by status and rejects unknown ones', async () => {
  const { t, buyer, property } = await market()
  try {
    const id = (await interest(t, buyer, property.id)).body.interest.id
    await t.call(`/api/me/interests/${id}/withdraw`, { method: 'POST', body: {}, as: buyer })
    assert.equal((await t.call('/api/interests')).body.interests.length, 0, 'open by default')
    assert.equal((await t.call('/api/interests?status=withdrawn')).body.interests.length, 1)
    assert.equal((await t.call('/api/interests?status=all')).body.interests.length, 1)
    assert.equal((await t.call('/api/interests?status=bogus')).status, 400)
  } finally { await t.close() }
})

test('migration 9 adds property_interests to a v8 database built by the app: a backup first, existing data unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-m9-'))
  const file = join(dir, 'd.db')
  const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name)
  const snapshot = (db) => Object.fromEntries(tables(db).filter((n) => n !== 'schema_version').map((n) => [n, db.prepare(`SELECT * FROM "${n}" ORDER BY rowid`).all()]))
  try {
    // Representative v8 data, made through the real app on a v8 database: an agent, a buyer with requirements and a
    // requested viewing, a seller's listing, matches, events, notifications and an assistant conversation.
    const vs = fakeVs()
    const old = openDatabase(file, { upTo: 8 })
    const t = await startApp({ vs, db: old })
    await t.call('/api/me/profile', { method: 'PATCH', body: { serviceAreas: ['Pune'] } })
    const buyer = signedInUser(old, { name: 'Rahul Sharma', email: 'rahul@example.com', role: 'buyer' })
    const seller = signedInUser(old, { name: 'Sunita Rao', email: 'sunita@example.com', role: 'seller' })
    const property = (await t.call('/api/properties', { method: 'POST', body: { property: BANER } })).body.property
    await t.call('/api/properties', { method: 'POST', body: { property: { ...BANER, title: 'Seller flat in Baner' }, publish: true }, as: seller })
    await t.call('/api/me/requirements', { method: 'PUT', body: { requirements: REQ, matchingConsent: true }, as: buyer })
    const cal = (await t.call('/api/integrations/connections', { method: 'POST', body: { serviceId: await vs.serviceIdFor('google-calendar'), authId: vs.connectApp(t.user.id, 'google-calendar') } })).body.connection
    await t.call('/api/automations/viewing_scheduler', { method: 'PUT', body: { enabled: true, config: { calendarConnectionId: cal.id, calendarId: 'primary', confirmation: 'none' } } })
    const slots = (await t.call(`/api/me/viewing-slots?propertyId=${property.id}&date=${addDays(todayIn('Asia/Kolkata'), 2)}`, { as: buyer })).body.slots
    assert.equal((await t.call('/api/me/viewings', { method: 'POST', body: { propertyId: property.id, start: slots[0].start }, as: buyer })).status, 201)
    old.prepare("INSERT INTO agent_conversations (id, user_id, created_at, updated_at) VALUES ('c1', ?, datetime('now'), datetime('now'))").run(buyer.id)
    old.prepare("INSERT INTO agent_messages (conversation_id, role, content, created_at) VALUES ('c1', 'user', 'kept message', datetime('now'))").run()
    await t.close()
    assert.equal(old.prepare('SELECT version FROM schema_version').get().version, 8)
    assert.equal(tables(old).includes('property_interests'), false)
    const before = snapshot(old)
    for (const n of ['users', 'leads', 'properties', 'viewings', 'domain_events', 'notifications', 'agent_messages', 'property_matches']) assert.ok(before[n].length > 0, `representative data: ${n}`)
    old.close()

    const logs = []
    const db = openDatabase(file, { log: (l) => logs.push(l) })
    assert.equal(db.prepare('SELECT version FROM schema_version').get().version, 9)
    assert.match(logs.join('\n'), /Backed up the database before migrating v8 → v9/)
    assert.deepEqual(snapshot(db).property_interests, [])
    const after = snapshot(db)
    delete after.property_interests
    assert.deepEqual(after, before, 'every existing row is unchanged')
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'property_interests_one_open'").get())
    // The backup holds the v8 database exactly as it was.
    const bak = readdirSync(dir).filter((f) => /^d\.db\.pre-v9-\d+\.bak$/.test(f))
    assert.equal(bak.length, 1)
    const copy = openDatabase(join(dir, bak[0]), { upTo: 8 })
    assert.equal(copy.prepare('SELECT version FROM schema_version').get().version, 8)
    assert.deepEqual(snapshot(copy), before)
    copy.close()
    // The migrated database works: the existing buyer shows interest on their existing lead.
    const t2 = await startApp({ db, withUser: false })
    try {
      const r = await t2.call('/api/me/interests', { method: 'POST', body: { propertyId: property.id }, as: buyer })
      assert.equal(r.status, 201)
      assert.equal(r.body.interest.viewing.status, 'requested', 'the existing viewing is shown')
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM leads').get().n, before.leads.length)
    } finally { await t2.close() }
    db.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
