// The three-sided marketplace: roles, ownership, assignment, two-way matching, notifications and the event queue.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, fakeVs, signedInUser, vsError } from './helpers.js'
import { addDays, todayIn, zonedToUtc } from '../server/time.js'

const BANER = { title: '2 BHK in Baner', listing_type: 'sale', property_type: 'apartment', bedrooms: 2, price: 4800000, city: 'Pune', locality: 'Baner', address: '12 Baner Road', notes: 'Owner prefers evenings' }
const REQ = { customer_type: 'buyer', preferred_location: 'Baner, Pune', bedrooms: 2, budget_max: 5000000, property_type: 'apartment' }

/** An app with one agent serving Pune, plus a buyer and a seller who registered themselves. */
async function market({ vs = fakeVs(), areas = ['Pune'] } = {}) {
  const t = await startApp({ vs })
  const agent = t.user
  await t.call('/api/me/profile', { method: 'PATCH', body: { serviceAreas: areas } })
  const buyer = signedInUser(t.db, { name: 'Rahul Sharma', email: 'rahul@example.com', role: 'buyer' })
  const seller = signedInUser(t.db, { name: 'Sunita Rao', email: 'sunita@example.com', role: 'seller' })
  return { t, vs, agent, buyer, seller }
}
const as = (t, who) => (path, opts = {}) => t.call(path, { ...opts, as: who })
const saveReq = (t, buyer, requirements = REQ, extra = { matchingConsent: true }) => t.call('/api/me/requirements', { method: 'PUT', body: { requirements, ...extra }, as: buyer })
const notes = (t, user, kind) => t.db.prepare(`SELECT * FROM notifications WHERE user_id = ? AND channel = 'in_app'${kind ? ' AND kind = ?' : ''}`).all(...[user.id, ...(kind ? [kind] : [])])

test('roles: each role reaches only its own pages and records, checked on the server', async () => {
  const { t, agent, buyer, seller } = await market()
  try {
    const b = as(t, buyer)
    const s = as(t, seller)
    for (const path of ['/api/leads', '/api/dashboard', '/api/automations', '/api/integrations/connections', '/api/rent', '/api/viewings', '/api/feedback', '/api/pool', '/api/events', '/api/assistant/conversations/00000000-0000-0000-0000-000000000000']) {
      assert.equal((await b(path)).status, 403, `buyer ${path}`)
      assert.equal((await s(path)).status, 403, `seller ${path}`)
    }
    assert.equal((await b('/api/leads', { method: 'POST', body: { lead: { full_name: 'X Y', customer_type: 'buyer', phone: '9000000000' } } })).status, 403)
    assert.equal((await b('/api/properties', { method: 'POST', body: { property: BANER } })).status, 403, 'buyers do not list properties')
    assert.equal((await s('/api/me/requirements', { method: 'PUT', body: { requirements: REQ } })).status, 403)
    assert.equal((await t.call('/api/me/requirements', { method: 'PUT', body: { requirements: REQ } })).status, 403, 'agents have no buyer requirements')
    assert.equal((await b('/api/me')).body.user.role, 'buyer')
    assert.equal((await s('/api/me')).body.user.role, 'seller')
    assert.equal((await t.call('/api/me')).body.user.id, agent.id)
  } finally { await t.close() }
})

test('agents see only their own leads; another agent gets 404 everywhere, even by id', async () => {
  const { t } = await market()
  try {
    const lead = (await t.call('/api/leads', { method: 'POST', body: { lead: { full_name: 'Neha K', customer_type: 'buyer', phone: '9000000001', email: 'neha@example.com' } } })).body.lead
    const other = signedInUser(t.db, { name: 'Other Agent' })
    const o = as(t, other)
    assert.equal((await o('/api/leads')).body.total, 0)
    for (const [path, method, body] of [[`/api/leads/${lead.id}`, 'GET'], [`/api/leads/${lead.id}`, 'PATCH', { lead: { notes: 'mine now' } }], [`/api/leads/${lead.id}`, 'DELETE'], [`/api/leads/${lead.id}/matches`, 'GET'], [`/api/leads/${lead.id}/followups`, 'GET'], [`/api/leads/${lead.id}/transfer`, 'POST', { agentId: other.id }]]) {
      assert.equal((await o(path, { method, body })).status, 404, `${method} ${path}`)
    }
    assert.equal((await o('/api/viewings', { method: 'POST', body: { leadId: lead.id } })).status, 404)
    assert.equal((await o('/api/dashboard')).body.total, 0)
    // The same email in another agent's book: refused without revealing that lead's details.
    const dup = await o('/api/leads', { method: 'POST', body: { lead: { full_name: 'Someone Else', customer_type: 'buyer', email: 'neha@example.com' } } })
    assert.equal(dup.status, 409)
    assert.doesNotMatch(dup.text, /Neha|9000000001/)
  } finally { await t.close() }
})

test('a new buyer is matched against existing listings, assigned to the agent serving the area, and both are told once', async () => {
  const { t, agent, buyer } = await market()
  try {
    const p = (await t.call('/api/properties', { method: 'POST', body: { property: BANER } })).body.property
    await t.call('/api/properties', { method: 'POST', body: { property: { ...BANER, title: 'Villa in Baner', property_type: 'villa' } } })
    await t.idle()
    const saved = await saveReq(t, buyer)
    assert.equal(saved.status, 200)
    await t.idle()
    const me = (await t.call('/api/me', { as: buyer })).body.profile
    assert.equal(me.agent.name, 'Asha Broker', 'assigned by service area')
    const recs = (await t.call('/api/me/recommendations', { as: buyer })).body
    assert.deepEqual(recs.recommendations.map((r) => r.property.title), ['2 BHK in Baner'])
    assert.match(recs.recommendations[0].reasons.join(' '), /Baner, Pune.*budget.*2 BHK/)
    assert.equal(recs.recommendations[0].property.address, null, 'buyers do not see the street address')
    assert.equal(recs.recommendations[0].property.notes, undefined)
    assert.equal(notes(t, buyer, 'match').length, 1)
    const lead = t.db.prepare('SELECT * FROM leads WHERE buyer_user_id = ?').get(buyer.id)
    assert.equal(lead.assigned_agent_id, agent.id)
    assert.equal(lead.assignment_rule, 'service_area')
    assert.equal(notes(t, agent, 'lead').length, 1, 'the assigned agent hears about the new buyer')
    assert.equal(notes(t, agent, 'match').length, 1)
    assert.equal((await t.call(`/api/leads/${lead.id}/matches`)).body.matches[0].property.id, p.id)

    // The same events processed again: no second match, no second notification.
    t.db.prepare("UPDATE domain_events SET status = 'pending', next_attempt_at = '2000-01-01T00:00:00.000Z'").run()
    await t.events.drain()
    assert.equal(notes(t, buyer).length, 1)
    assert.equal(notes(t, agent).length, 2)
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM property_matches').get().n, 1)
  } finally { await t.close() }
})

test('a seller’s listing: draft does not match; publishing matches existing buyers; the seller sees counts, never buyers', async () => {
  const { t, agent, buyer, seller } = await market()
  try {
    await saveReq(t, buyer)
    await t.idle()
    const s = as(t, seller)
    const created = await s('/api/properties', { method: 'POST', body: { property: BANER } })
    assert.equal(created.status, 201)
    const p = created.body.property
    assert.equal(p.listing_state, 'draft', 'a seller’s listing starts as a draft')
    assert.equal(p.agent_id, agent.id, 'the seller got the agent serving the area')
    await t.idle()
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM property_matches').get().n, 0, 'drafts never match')
    assert.equal((await t.call(`/api/properties/${p.id}`, { as: buyer })).status, 404, 'buyers cannot see drafts')

    assert.equal((await s(`/api/properties/${p.id}/publish`, { method: 'POST', body: {} })).status, 200)
    await t.idle()
    assert.equal(notes(t, buyer, 'match').length, 1, 'the existing buyer hears about the new listing')
    assert.equal(notes(t, seller, 'listing_match').length, 1)
    assert.doesNotMatch(JSON.stringify(notes(t, seller)), /Rahul/)
    const view = (await s(`/api/properties/${p.id}`)).body
    assert.deepEqual(view.matches, [])
    assert.equal(view.otherBuyers, 1)
    assert.equal(view.property.address, '12 Baner Road', 'the owner sees their own address')
    assert.equal(notes(t, agent, 'listing').length, 1, 'the seller’s agent is told the listing went live')

    // Another seller cannot touch it; a buyer cannot either.
    const other = signedInUser(t.db, { name: 'Other Seller', role: 'seller' })
    assert.equal((await t.call(`/api/properties/${p.id}`, { method: 'PATCH', body: { property: { price: 1 } }, as: other })).status, 403)
    assert.equal((await t.call(`/api/properties/${p.id}/archive`, { method: 'POST', body: {}, as: other })).status, 403)
    assert.equal((await t.call(`/api/properties/${p.id}`, { method: 'DELETE', as: other })).status, 403)
    assert.equal((await t.call(`/api/properties/${p.id}`, { method: 'PATCH', body: { property: { price: 1 } }, as: buyer })).status, 403)
    assert.equal((await t.call('/api/properties?scope=mine', { as: other })).body.properties.length, 0)
  } finally { await t.close() }
})

test('changes recalculate matches: a price rise withdraws, a fall back restores without a second notice, unpublish and archive withdraw', async () => {
  const { t, buyer, seller } = await market()
  try {
    await saveReq(t, buyer)
    const s = as(t, seller)
    const p = (await s('/api/properties', { method: 'POST', body: { property: BANER }, })).body.property
    await s(`/api/properties/${p.id}/publish`, { method: 'POST', body: {} })
    await t.idle()
    const recs = async () => (await t.call('/api/me/recommendations', { as: buyer })).body.recommendations.length
    assert.equal(await recs(), 1)
    await s(`/api/properties/${p.id}`, { method: 'PATCH', body: { property: { price: 5500000 } } })
    await t.idle()
    assert.equal(await recs(), 0)
    assert.match(t.db.prepare('SELECT withdrawn_reason FROM property_matches').get().withdrawn_reason, /no longer fits/i)
    await s(`/api/properties/${p.id}`, { method: 'PATCH', body: { property: { price: 4800000 } } })
    await t.idle()
    assert.equal(await recs(), 1)
    assert.equal(notes(t, buyer, 'match').length, 1, 'the same listing facts are never announced twice')
    await s(`/api/properties/${p.id}`, { method: 'PATCH', body: { property: { price: 4500000 } } })
    await t.idle()
    assert.equal(notes(t, buyer, 'match').length, 2, 'a price drop is a changed match, announced once')

    // The buyer narrows their budget: withdrawn from their side too.
    await saveReq(t, buyer, { ...REQ, budget_max: 4000000 })
    await t.idle()
    assert.equal(await recs(), 0)
    await saveReq(t, buyer, REQ)
    await t.idle()
    assert.equal(await recs(), 1)

    await s(`/api/properties/${p.id}/unpublish`, { method: 'POST', body: {} })
    await t.idle()
    assert.equal(await recs(), 0)
    await s(`/api/properties/${p.id}/publish`, { method: 'POST', body: {} })
    await t.idle()
    assert.equal(await recs(), 1)
    assert.equal((await s(`/api/properties/${p.id}`, { method: 'DELETE' })).status, 409, 'a published listing is archived, not deleted')
    await s(`/api/properties/${p.id}/archive`, { method: 'POST', body: {} })
    await t.idle()
    assert.equal(await recs(), 0)
    assert.equal((await s(`/api/properties/${p.id}`, { method: 'PATCH', body: { property: { price: 1 } } })).status, 409)
    // A sold listing generates nothing either.
    const q = (await t.call('/api/properties', { method: 'POST', body: { property: { ...BANER, title: 'Agent flat', status: 'sold' } } })).body.property
    await t.idle()
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM property_matches WHERE property_id = ?').get(q.id).n, 0)
  } finally { await t.close() }
})

test('consent: without it a buyer is not matched, not assigned and not in the pool; agents may email only buyers who allow it', async () => {
  const { t, buyer } = await market()
  try {
    await t.call('/api/properties', { method: 'POST', body: { property: BANER } })
    await saveReq(t, buyer, REQ, { matchingConsent: false })
    await t.idle()
    assert.equal((await t.call('/api/me/recommendations', { as: buyer })).body.state, 'no_consent')
    const lead = t.db.prepare('SELECT * FROM leads WHERE buyer_user_id = ?').get(buyer.id)
    assert.equal(lead.assigned_agent_id, null)
    assert.equal((await t.call('/api/pool')).body.leads.length, 0)
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM property_matches').get().n, 0)
    await saveReq(t, buyer, REQ, { matchingConsent: true, notifyInApp: false })
    await t.idle()
    assert.equal((await t.call('/api/me/recommendations', { as: buyer })).body.recommendations.length, 1)
    assert.equal(notes(t, buyer, 'match').length, 0, 'in-app notices off: recommendations still listed, no notice')
    const leadNow = t.db.prepare('SELECT * FROM leads WHERE buyer_user_id = ?').get(buyer.id)
    assert.ok(leadNow.assigned_agent_id)
    const vs = t.vs
    const gmail = (await t.call('/api/integrations/connections', { method: 'POST', body: { serviceId: await vs.serviceIdFor('gmail'), authId: vs.connectApp(t.user.id, 'gmail') } })).body.connection
    const blocked = await t.call(`/api/leads/${leadNow.id}/followups`, { method: 'POST', body: { connectionId: gmail.id, subject: 'Hello there', body: 'A message for you, about your search.' } })
    assert.equal(blocked.status, 409)
    assert.equal(blocked.body.error.code, 'no_email_consent')
    await saveReq(t, buyer, REQ, { allowAgentEmail: true })
    assert.equal((await t.call(`/api/leads/${leadNow.id}/followups`, { method: 'POST', body: { connectionId: gmail.id, subject: 'Hello there', body: 'A message for you, about your search.' } })).status, 201)
  } finally { await t.close() }
})

test('assignment: least-loaded agent serving the area; nobody serving it → the pool (no one notified) → claim once → transfer', async () => {
  const { t, agent, buyer } = await market({ areas: ['Pune'] })
  try {
    const second = signedInUser(t.db, { name: 'Bina Agent' })
    await t.call('/api/me/profile', { method: 'PATCH', body: { serviceAreas: ['Pune', 'Mumbai'] }, as: second })
    await t.call('/api/leads', { method: 'POST', body: { lead: { full_name: 'Load One', customer_type: 'buyer', phone: '9000000011' } } }) // Asha now has 1 open lead
    await saveReq(t, buyer)
    await t.idle()
    assert.equal(t.db.prepare('SELECT assigned_agent_id FROM leads WHERE buyer_user_id = ?').get(buyer.id).assigned_agent_id, second.id, 'the agent with fewer open leads')

    const far = signedInUser(t.db, { name: 'Far Buyer', role: 'buyer' })
    await saveReq(t, far, { ...REQ, preferred_location: 'Jaipur' })
    await t.idle()
    const farLead = t.db.prepare('SELECT * FROM leads WHERE buyer_user_id = ?').get(far.id)
    assert.equal(farLead.assigned_agent_id, null)
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'lead' AND subject_id = ?").get(String(farLead.id)).n, 0, 'an unassigned lead notifies nobody')
    const pool = (await t.call('/api/pool')).body.leads
    assert.equal(pool.length, 1)
    assert.equal(pool[0].firstName, null, 'a registered buyer is not named to every agent')
    assert.doesNotMatch(JSON.stringify(pool), /example\.com|Far/, 'no name or contact details before claiming')
    assert.equal((await t.call(`/api/leads/${farLead.id}`)).status, 404, 'unclaimed leads cannot be opened')
    const [a, b] = await Promise.all([t.call(`/api/pool/${farLead.id}/claim`, { method: 'POST', body: {} }), t.call(`/api/pool/${farLead.id}/claim`, { method: 'POST', body: {}, as: second })])
    assert.deepEqual([a.status, b.status].sort(), [200, 409], 'exactly one agent gets it')
    const owner = a.status === 200 ? agent : second
    const other = owner === agent ? second : agent
    const moved = await t.call(`/api/leads/${farLead.id}/transfer`, { method: 'POST', body: { agentId: other.id }, as: owner })
    assert.equal(moved.status, 200)
    await t.idle()
    assert.equal(notes(t, other, 'lead').filter((n) => n.subject_id === String(farLead.id)).length, 1, 'the new agent is told')
    assert.equal((await t.call(`/api/leads/${farLead.id}`, { as: owner })).status, 404, 'the old agent no longer sees it')
  } finally { await t.close() }
})

test('New Lead Alert goes only to the assigned agent’s own channel, never to other agents who switched it on', async () => {
  const vs = fakeVs()
  const { t, buyer } = await market({ vs })
  try {
    const other = signedInUser(t.db, { name: 'Other Agent' })
    const gmailOf = async (u) => (await t.call('/api/integrations/connections', { method: 'POST', body: { serviceId: await vs.serviceIdFor('gmail'), authId: vs.connectApp(u.id, 'gmail') }, as: u })).body.connection
    const mine = await gmailOf(t.user)
    const theirs = await gmailOf(other)
    assert.equal((await t.call('/api/automations/new_lead_alert', { method: 'PUT', body: { enabled: true, config: { channel: 'gmail', connectionId: mine.id, emailTo: 'asha-team@agency.in' } } })).status, 200)
    assert.equal((await t.call('/api/automations/new_lead_alert', { method: 'PUT', body: { enabled: true, config: { channel: 'gmail', connectionId: theirs.id, emailTo: 'other-team@agency.in' } }, as: other })).status, 200)
    await saveReq(t, buyer)
    await t.idle()
    const sends = vs.calls.filter((c) => c.name === 'runAction').map((c) => c.args[2].to)
    assert.deepEqual(sends, ['asha-team@agency.in'])
    await t.call('/api/leads', { method: 'POST', body: { lead: { full_name: 'Typed In', customer_type: 'seller', phone: '9000000021' } }, as: other })
    await t.idle()
    assert.deepEqual(vs.calls.filter((c) => c.name === 'runAction').map((c) => c.args[2].to), ['asha-team@agency.in', 'other-team@agency.in'])
  } finally { await t.close() }
})

test('match notices by Slack: one message per change listing every new match; a refused send is retried, never doubled', async () => {
  const vs = fakeVs()
  const { t, buyer } = await market({ vs })
  try {
    const slack = (await t.call('/api/integrations/connections', { method: 'POST', body: { serviceId: await vs.serviceIdFor('slack'), authId: vs.connectSlack(t.user.id) } })).body.connection
    assert.equal((await t.call('/api/automations/buyer_matching', { method: 'PUT', body: { enabled: true, config: { notify: 'slack', connectionId: slack.id, slackChannelId: 'C0LEADS' } } })).status, 200)
    await saveReq(t, buyer)
    await t.call('/api/leads', { method: 'POST', body: { lead: { full_name: 'Second Buyer', customer_type: 'buyer', phone: '9000000031', ...{ preferred_location: 'Pune', bedrooms: 2, budget_max: 6000000 } } } })
    await t.idle()
    vs.fail.runAction = vsError('Slack is down', 503)
    await t.call('/api/properties', { method: 'POST', body: { property: BANER } })
    await t.idle()
    const digest = t.db.prepare("SELECT * FROM domain_events WHERE type = 'match.digest'").get()
    assert.equal(digest.status, 'pending', 'a refused send is queued for a retry')
    assert.equal(digest.attempts, 1)
    assert.match(digest.last_error, /Slack is down/)
    // The retry time arrives: one message naming both buyers.
    t.db.prepare("UPDATE domain_events SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(digest.id)
    await t.events.drain()
    const posts = vs.calls.filter((c) => c.name === 'runAction')
    assert.equal(posts.length, 2, 'the failed attempt and the retry')
    assert.match(posts[1].args[2].markdown_content, /Rahul Sharma.*\n.*Second Buyer|Second Buyer.*\n.*Rahul Sharma/)
    assert.equal(t.db.prepare("SELECT status FROM domain_events WHERE id = ?").get(digest.id).status, 'done')
    t.db.prepare("UPDATE domain_events SET status = 'pending', next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(digest.id)
    await t.events.drain()
    assert.equal(vs.calls.filter((c) => c.name === 'runAction').length, 2, 'processing it again sends nothing more')
  } finally { await t.close() }
})

test('the queue recovers: a failing handler retries with backoff, gives up after 5 attempts, and a crashed claim is picked up again', async () => {
  const { t } = await market()
  try {
    const lead = (await t.call('/api/leads', { method: 'POST', body: { lead: { full_name: 'Retry Me', customer_type: 'buyer', phone: '9000000041', preferred_location: 'Pune' } } })).body.lead
    await t.idle()
    // A crash mid-processing leaves an event 'processing' with a lease: once the lease runs out it is processed again.
    t.db.prepare("UPDATE domain_events SET status = 'processing', locked_until = '2000-01-01T00:00:00.000Z'").run()
    await t.events.drain()
    assert.equal(t.db.prepare("SELECT status FROM domain_events WHERE subject_id = ?").get(String(lead.id)).status, 'done')

    // A handler that keeps failing: retried, then failed for good, then retried by the agent.
    const broken = t.db.prepare
    let breakIt = true
    t.db.prepare = function (sql) { if (breakIt && /FROM properties WHERE listing_state = 'published' AND status = 'available' AND listing_type/.test(sql)) throw new Error('disk I/O error (simulated)'); return broken.call(this, sql) }
    const origErr = console.log
    console.log = () => {}
    await t.call(`/api/leads/${lead.id}`, { method: 'PATCH', body: { lead: { budget_max: 7000000 } } })
    await t.idle()
    const ev = () => t.db.prepare("SELECT * FROM domain_events WHERE type = 'lead.requirements_changed'").get()
    assert.equal(ev().status, 'pending')
    assert.ok(ev().next_attempt_at > new Date().toISOString(), 'backoff: not retried at once')
    for (let i = 0; i < 4; i++) {
      t.db.prepare("UPDATE domain_events SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE type = 'lead.requirements_changed'").run()
      await t.events.drain()
    }
    console.log = origErr
    assert.equal(ev().status, 'failed')
    assert.equal(ev().attempts, 5)
    const failed = (await t.call('/api/events?status=failed')).body.events
    assert.equal(failed.length, 1)
    assert.match(failed[0].lastError, /simulated/)
    breakIt = false
    assert.equal((await t.call(`/api/events/${failed[0].id}/retry`, { method: 'POST', body: {} })).status, 200)
    await t.idle()
    assert.equal(ev().status, 'done')
    const outsider = signedInUser(t.db, { name: 'Outsider' })
    assert.equal((await t.call(`/api/events/${failed[0].id}/retry`, { method: 'POST', body: {}, as: outsider })).status, 404)
    t.db.prepare = broken
  } finally { await t.close() }
})

test('viewings: a buyer requests a free time in their agent’s calendar; the agent confirms; the seller sees it without the buyer; feedback updates matches', async () => {
  const vs = fakeVs()
  const { t, buyer, seller } = await market({ vs })
  try {
    const conn = async (slug) => (await t.call('/api/integrations/connections', { method: 'POST', body: { serviceId: await vs.serviceIdFor(slug), authId: vs.connectApp(t.user.id, slug) } })).body.connection
    const calendar = await conn('google-calendar')
    const b = as(t, buyer)
    await saveReq(t, buyer)
    const p = (await t.call('/api/properties', { method: 'POST', body: { property: BANER }, as: seller })).body.property
    assert.equal((await b(`/api/me/viewing-slots?propertyId=${p.id}&date=${addDays(todayIn('Asia/Kolkata'), 2)}`)).status, 409, 'the agent has not switched the scheduler on yet')
    assert.equal((await t.call('/api/automations/viewing_scheduler', { method: 'PUT', body: { enabled: true, config: { calendarConnectionId: calendar.id, calendarId: 'primary', confirmation: 'none' } } })).status, 200)
    const day = addDays(todayIn('Asia/Kolkata'), 2)
    assert.equal((await b(`/api/me/viewing-slots?propertyId=${p.id}&date=${day}`)).status, 400, 'a draft listing cannot be viewed')
    await t.call(`/api/properties/${p.id}/publish`, { method: 'POST', body: {}, as: seller })
    await t.idle()
    vs.state.busy = [{ start: zonedToUtc(day, '10:00', 'Asia/Kolkata').toISOString(), end: zonedToUtc(day, '11:00', 'Asia/Kolkata').toISOString() }]
    const slots = (await b(`/api/me/viewing-slots?propertyId=${p.id}&date=${day}`)).body
    assert.ok(!slots.slots.some((s) => s.label === '10:00'), 'busy times in the agent’s calendar are not offered')
    const busyStart = zonedToUtc(day, '10:00', 'Asia/Kolkata').toISOString()
    assert.equal((await b('/api/me/viewings', { method: 'POST', body: { propertyId: p.id, start: busyStart } })).status, 409)
    const req = await b('/api/me/viewings', { method: 'POST', body: { propertyId: p.id, start: slots.slots[0].start } })
    assert.equal(req.status, 201)
    assert.equal(req.body.viewing.status, 'requested')
    assert.ok(!vs.calls.some((c) => c.name === 'runAction' && c.args[2]?.summary), 'nothing is booked before the agent confirms')
    await t.idle()
    assert.equal(notes(t, t.user, 'viewing').length, 1)
    const agentList = (await t.call('/api/viewings')).body.viewings
    assert.equal(agentList[0].requestedByBuyer, true)
    assert.equal((await t.call(`/api/viewings/${agentList[0].id}/book`, { method: 'POST', body: {} })).body.viewing.status, 'booked')
    await t.idle()
    assert.equal((await b('/api/me/viewings')).body.viewings[0].status, 'booked')
    const sv = (await t.call('/api/me/listing-viewings', { as: seller })).body.viewings
    assert.equal(sv.length, 1)
    assert.doesNotMatch(JSON.stringify(sv), /Rahul|rahul@/)
    // Other buyers cannot see or cancel it.
    const nosy = signedInUser(t.db, { name: 'Nosy Buyer', role: 'buyer' })
    assert.equal((await t.call(`/api/me/viewings/${agentList[0].id}/cancel`, { method: 'POST', body: {}, as: nosy })).status, 404)

    t.db.prepare("UPDATE viewings SET start_at = '2020-01-01T04:30:00.000Z', end_at = '2020-01-01T05:30:00.000Z'").run()
    assert.equal((await b(`/api/me/viewings/${agentList[0].id}/feedback`, { method: 'POST', body: { responses: [{ propertyId: p.id, verdict: 'too_expensive' }] } })).status, 409, 'not until the agent marks it completed')
    const done = await t.call(`/api/viewings/${agentList[0].id}/outcome`, { method: 'POST', body: { outcome: 'completed' } })
    assert.equal(done.body.feedback.status, 'in_app')
    await t.idle()
    assert.ok(notes(t, buyer, 'viewing').some((n) => /how the viewing went/.test(n.title)))
    const fb = await b(`/api/me/viewings/${agentList[0].id}/feedback`, { method: 'POST', body: { responses: [{ propertyId: p.id, verdict: 'too_expensive' }], comments: 'Too pricey' } })
    assert.equal(fb.status, 200)
    await t.idle()
    assert.equal((await b('/api/me/recommendations')).body.recommendations.length, 0, 'the rejected listing is no longer recommended')
    assert.equal((await b('/api/me')).body.profile.requirements.budget_max, 4700000)
    assert.equal(notes(t, t.user, 'feedback').length, 1)
    assert.equal((await b(`/api/me/viewings/${agentList[0].id}/feedback`, { method: 'POST', body: { responses: [{ propertyId: p.id, verdict: 'liked' }] } })).status, 409, 'answered once')
  } finally { await t.close() }
})

test('tenancies: the tenant and landlord see their own tenancy; only the landlord or agent records payments; nobody else sees it', async () => {
  const { t, buyer, seller } = await market()
  try {
    const res = await t.call('/api/rent/tenancies', { method: 'POST', body: { tenancy: { tenant_name: 'Rahul Sharma', tenant_email: 'rahul@example.com', landlord_email: 'sunita@example.com', property_label: 'Flat 4B', rent_amount: 28000, due_day: 5, lease_start: todayIn('Asia/Kolkata') } } })
    assert.equal(res.status, 201)
    const { tenancy } = res.body
    assert.equal(tenancy.tenant_user_id, null, 'a typed email alone links nobody')
    // The agent invites both; each accepts while signed in with the invited email.
    for (const [party, who] of [['tenant', buyer], ['landlord', seller]]) {
      const link = (await t.call(`/api/rent/tenancies/${tenancy.id}/invites`, { method: 'POST', body: { party } })).body.link
      assert.equal((await t.call('/api/invites/accept', { method: 'POST', body: { token: link.split('/').pop() }, as: who })).status, 200)
    }
    await t.idle()
    assert.equal(notes(t, buyer, 'rent').filter((n) => /linked to your account/.test(n.title)).length, 1, 'the tenant is told once that the tenancy is linked')
    const mine = (await t.call('/api/me/tenancies', { as: buyer })).body.tenancies
    assert.equal(mine.length, 1)
    assert.equal(mine[0].tenancy.role, 'tenant')
    const dueId = mine[0].dues[0].id
    assert.equal((await t.call(`/api/me/rent/dues/${dueId}/payments`, { method: 'POST', body: { amount: 28000, paidOn: todayIn('Asia/Kolkata'), note: 'I paid, trust me' }, as: buyer })).status, 403, 'tenants cannot mark rent paid')
    const paid = await t.call(`/api/me/rent/dues/${dueId}/payments`, { method: 'POST', body: { amount: 28000, paidOn: todayIn('Asia/Kolkata'), note: 'Received by UPI, ref 8812' }, as: seller })
    assert.equal(paid.status, 200)
    assert.equal(paid.body.dues.find((d) => d.id === dueId).state, 'paid')
    await t.idle()
    assert.ok(notes(t, buyer, 'rent').some((n) => /payment of ₹28,000/.test(n.title)))
    const stranger = signedInUser(t.db, { name: 'Stranger', role: 'buyer' })
    assert.equal((await t.call('/api/me/tenancies', { as: stranger })).body.tenancies.length, 0)
    assert.equal((await t.call(`/api/me/tenancies/${tenancy.id}`, { as: stranger })).status, 404)
    const otherSeller = signedInUser(t.db, { name: 'Other Landlord', role: 'seller' })
    assert.equal((await t.call(`/api/me/rent/dues/${dueId}/payments`, { method: 'POST', body: { amount: 1, paidOn: todayIn('Asia/Kolkata'), note: 'not my flat' }, as: otherSeller })).status, 404)
    assert.match((await t.call(`/api/rent/tenancies/${tenancy.id}`)).body.events.map((e) => e.detail).join(' | '), /recorded by the landlord: Received by UPI/)
  } finally { await t.close() }
})

test('notifications are private, can be marked read, and an unknown id is refused', async () => {
  const { t, buyer } = await market()
  try {
    await t.call('/api/properties', { method: 'POST', body: { property: BANER } })
    await saveReq(t, buyer)
    await t.idle()
    const list = (await t.call('/api/notifications', { as: buyer })).body
    assert.equal(list.unread, 1)
    assert.equal((await t.call(`/api/notifications/${list.notifications[0].id}/read`, { method: 'POST', body: {} })).status, 404, 'the agent cannot mark the buyer’s notification')
    assert.equal((await t.call(`/api/notifications/${list.notifications[0].id}/read`, { method: 'POST', body: {}, as: buyer })).status, 200)
    assert.equal((await t.call('/api/notifications', { as: buyer })).body.unread, 0)
  } finally { await t.close() }
})

test('matching stays quick with a realistic volume (1,500 listings × 1,500 buyers)', async () => {
  const { t } = await market()
  try {
    const db = t.db
    const now = new Date().toISOString()
    const agentId = t.user.id
    const insP = db.prepare("INSERT INTO properties (title, listing_type, property_type, bedrooms, price, city, locality, status, owner_user_id, agent_id, listing_state, published_at, created_at, updated_at) VALUES (?, 'sale', 'apartment', ?, ?, 'Pune', ?, 'available', ?, ?, 'published', ?, ?, ?)")
    const insL = db.prepare("INSERT INTO leads (full_name, customer_type, phone, phone_norm, bedrooms, budget_max, preferred_location, status, assigned_agent_id, created_at, updated_at) VALUES (?, 'buyer', ?, ?, ?, ?, ?, 'new', ?, ?, ?)")
    const areas = ['Baner', 'Wakad', 'Kothrud', 'Hinjewadi', 'Aundh']
    db.exec('BEGIN')
    for (let i = 0; i < 1500; i++) {
      insP.run(`Flat ${i}`, 1 + (i % 4), 3000000 + (i % 10) * 100000, areas[i % 5], agentId, agentId, now, now, now)
      const phone = String(8000000000 + i)
      insL.run(`Buyer ${i}`, phone, phone, 1 + (i % 4), 4000000 + (i % 40) * 100000, `${areas[i % 5]}, Pune`, agentId, now, now)
    }
    db.exec('COMMIT')
    const { matchLead, matchProperty } = await import('../server/matching/engine.js')
    let t0 = performance.now()
    const a = matchProperty(db, 750)
    const propMs = performance.now() - t0
    t0 = performance.now()
    const b = matchLead(db, 750)
    const leadMs = performance.now() - t0
    assert.ok(a.matched > 0 && b.matched > 0)
    assert.ok(propMs < 1500, `listing → buyers took ${propMs.toFixed(0)} ms`)
    assert.ok(leadMs < 1500, `buyer → listings took ${leadMs.toFixed(0)} ms`)
    t0 = performance.now()
    const page = await t.call('/api/leads?limit=50&offset=100')
    assert.equal(page.body.leads.length, 50)
    assert.equal(page.body.total, 1500)
    assert.ok(performance.now() - t0 < 1000)
    // Ranking is stable: the same input gives the same order.
    const again = matchLead(db, 750)
    assert.equal(again.newMatches, 0)
    const order1 = db.prepare("SELECT property_id FROM property_matches WHERE lead_id = 750 AND status = 'suggested' ORDER BY score DESC, property_id").all().map((r) => r.property_id)
    assert.equal(order1.length, b.matched)
  } finally { await t.close() }
})

test('notifications across 2 agents, 2 buyers and 2 sellers: each person sees only what concerns them', async () => {
  const { t, agent, buyer, seller } = await market({ areas: ['Pune'] })
  try {
    const agent2 = signedInUser(t.db, { name: 'Bina Agent', email: 'bina@agency.in' })
    await t.call('/api/me/profile', { method: 'PATCH', body: { serviceAreas: ['Mumbai'] }, as: agent2 })
    const buyer2 = signedInUser(t.db, { name: 'Meera Iyer', email: 'meera@example.com', role: 'buyer' })
    const seller2 = signedInUser(t.db, { name: 'Kabir Shah', email: 'kabir@example.com', role: 'seller' })
    await saveReq(t, buyer) // Pune → Asha
    await saveReq(t, buyer2, { customer_type: 'buyer', preferred_location: 'Andheri, Mumbai', bedrooms: 2, budget_max: 9000000 }) // Mumbai → Bina
    const pune = (await t.call('/api/properties', { method: 'POST', body: { property: BANER }, as: seller })).body.property
    const mumbai = (await t.call('/api/properties', { method: 'POST', body: { property: { ...BANER, title: 'Andheri 2 BHK', city: 'Mumbai', locality: 'Andheri', price: 8500000, address: '5 Link Road' } }, as: seller2 })).body.property
    await t.call(`/api/properties/${pune.id}/publish`, { method: 'POST', body: {}, as: seller })
    await t.call(`/api/properties/${mumbai.id}/publish`, { method: 'POST', body: {}, as: seller2 })
    await t.idle()
    const text = (u) => JSON.stringify(notes(t, u))
    // Agents: their own buyers and listings only.
    assert.match(text(agent), /Rahul Sharma/)
    assert.doesNotMatch(text(agent), /Meera|Andheri|Kabir/)
    assert.match(text(agent2), /Meera Iyer/)
    assert.doesNotMatch(text(agent2), /Rahul|Baner|Sunita/)
    // Buyers: their own matches only, never another buyer.
    assert.match(text(buyer), /2 BHK in Baner/)
    assert.doesNotMatch(text(buyer), /Andheri|Meera/)
    assert.match(text(buyer2), /Andheri 2 BHK/)
    assert.doesNotMatch(text(buyer2), /Baner|Rahul/)
    // Sellers: that buyers match, never who; never the other seller's listing.
    assert.match(text(seller), /Buyers are matching your listing 2 BHK in Baner/)
    assert.doesNotMatch(text(seller), /Rahul|Meera|Andheri|rahul@/)
    assert.doesNotMatch(text(seller2), /Rahul|Meera|Baner|meera@/)
    // Nobody can read anyone else's notifications through the API.
    const theirs = notes(t, buyer2)[0].id
    for (const u of [agent, agent2, buyer, seller, seller2]) assert.equal((await t.call(`/api/notifications/${theirs}/read`, { method: 'POST', body: {}, as: u })).status, 404)
    for (const u of [buyer, buyer2, seller, seller2]) assert.equal((await t.call('/api/events', { as: u })).status, 403)
    // Agent 2's activity log holds nothing about agent 1's buyer.
    assert.doesNotMatch(JSON.stringify((await t.call('/api/events', { as: agent2 })).body.events), new RegExp(`"leadId":${t.db.prepare('SELECT id FROM leads WHERE buyer_user_id = ?').get(buyer.id).id}[,}]`))
  } finally { await t.close() }
})

test('Send test (stand-in for viaSocket): needs confirmation, records the provider’s ids, and fails honestly', async () => {
  const vs = fakeVs()
  const { t } = await market({ vs })
  try {
    const conn = async (slug) => (await t.call('/api/integrations/connections', { method: 'POST', body: { serviceId: await vs.serviceIdFor(slug), authId: slug === 'slack' ? vs.connectSlack(t.user.id) : vs.connectApp(t.user.id, slug) } })).body.connection
    const gmail = await conn('gmail')
    const cal = await conn('google-calendar')
    const slack = await conn('slack')
    assert.equal((await t.call(`/api/integrations/connections/${gmail.id}/test`, { method: 'POST', body: {} })).status, 400, 'nothing runs without confirmation')
    const g = (await t.call(`/api/integrations/connections/${gmail.id}/test`, { method: 'POST', body: { confirm: true } })).body
    assert.equal(g.status, 'sent')
    assert.equal(g.providerIds.messageId, 'msg_123')
    assert.equal(vs.calls.filter((c) => c.name === 'runAction').at(-1).args[2].to, t.user.email, 'only to the agent’s own address')
    const c = (await t.call(`/api/integrations/connections/${cal.id}/test`, { method: 'POST', body: { confirm: true } })).body
    assert.equal(c.status, 'sent')
    assert.match(c.detail, /created event evt\d+ .* and deleted it again/)
    assert.equal((await t.call(`/api/integrations/connections/${slack.id}/test`, { method: 'POST', body: { confirm: true } })).status, 400, 'Slack needs a channel')
    vs.fail.runAction = vsError('channel_not_found', 404)
    const s = (await t.call(`/api/integrations/connections/${slack.id}/test`, { method: 'POST', body: { confirm: true, slackChannelId: 'C0LEADS' } })).body
    assert.equal(s.status, 'failed')
    assert.match(s.detail, /channel_not_found/)
    const deliveries = (await t.call('/api/deliveries')).body.deliveries
    assert.ok(deliveries.some((d) => d.status === 'sent' && /msg_123/.test(d.detail)))
    assert.ok(deliveries.some((d) => d.status === 'failed' && /channel_not_found/.test(d.detail)))
    const other = signedInUser(t.db, { name: 'Other Agent' })
    assert.equal((await t.call(`/api/integrations/connections/${gmail.id}/test`, { method: 'POST', body: { confirm: true }, as: other })).status, 404, 'only the connection’s owner')
  } finally { await t.close() }
})
