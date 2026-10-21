import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../server/db.js'
import { scoreMatch } from '../server/properties/service.js'
import { startApp } from './helpers.js'

const RAHUL = { full_name: 'Rahul Sharma', customer_type: 'buyer', phone: '9876543210', preferred_location: 'Baner, Pune', bedrooms: 2, budget_max: 5000000, property_type: 'apartment' }
const BANER = { title: '2 BHK in Baner', listing_type: 'sale', property_type: 'apartment', bedrooms: 2, price: 4800000, city: 'Pune', locality: 'Baner' }
const addLead = async (t, lead) => (await t.call('/api/leads', { method: 'POST', body: { lead } })).body.lead
const addProperty = (t, property) => t.call('/api/properties', { method: 'POST', body: { property } })

test('scoring: a fitting listing scores with reasons; a stated requirement that is not met excludes it', () => {
  const m = scoreMatch(RAHUL, { ...BANER, status: 'available' })
  assert.equal(m.score, 100)
  assert.equal(m.reasons.length, 4)
  assert.match(m.reasons.join(' | '), /Baner, Pune.*within their budget.*2 BHK.*Apartment/)
  const p = { ...BANER, status: 'available' }
  assert.equal(scoreMatch(RAHUL, { ...p, price: 5100000 }), null, 'over budget')
  assert.equal(scoreMatch(RAHUL, { ...p, city: 'Mumbai', locality: 'Andheri' }), null, 'wrong area')
  assert.equal(scoreMatch(RAHUL, { ...p, bedrooms: 3 }), null, 'wrong BHK')
  assert.equal(scoreMatch(RAHUL, { ...p, property_type: 'villa' }), null, 'wrong type')
  assert.equal(scoreMatch(RAHUL, { ...p, listing_type: 'rent' }), null, 'a buyer is not matched to rentals')
  assert.equal(scoreMatch(RAHUL, { ...p, status: 'sold' }), null, 'sold listings are not matched')
  assert.equal(scoreMatch({ ...RAHUL, customer_type: 'seller' }, p), null, 'sellers are not buyers')
  assert.equal(scoreMatch(RAHUL, { ...p, locality: 'Wakad' }).score, 90, 'same city, other locality: lower score')
})

test('missing preferences are reported as gaps, not guessed', () => {
  const m = scoreMatch({ full_name: 'A B', customer_type: 'buyer' }, { ...BANER, status: 'available' })
  assert.equal(m.score, 0)
  assert.deepEqual(m.gaps, ['no preferred location saved', 'no budget saved', 'no bedroom count saved'])
})

test('saving a property matches buyers automatically, ranked, and logs it once on each buyer', async () => {
  const t = await startApp()
  try {
    const rahul = await addLead(t, RAHUL)
    const wakad = await addLead(t, { ...RAHUL, full_name: 'Neha Kulkarni', phone: '9000000002', preferred_location: 'Pune' })
    await addLead(t, { ...RAHUL, full_name: 'Too Poor', phone: '9000000003', budget_max: 3000000 })
    await addLead(t, { ...RAHUL, full_name: 'Seller Sam', phone: '9000000004', customer_type: 'seller' })

    const res = await addProperty(t, BANER)
    assert.equal(res.status, 201)
    assert.equal(res.body.matching.matched, 2)
    const detail = (await t.call(`/api/properties/${res.body.property.id}`)).body
    assert.deepEqual(detail.matches.map((m) => m.name), ['Rahul Sharma', 'Neha Kulkarni'], 'best first; excluded buyers are absent')
    assert.ok(detail.matches[0].score > detail.matches[1].score)
    assert.equal(detail.matches[0].phone, undefined, 'contact details are not in the match list')

    const activity = (await t.call(`/api/leads/${rahul.id}`)).body.activities.filter((a) => a.type === 'property_matched')
    assert.equal(activity.length, 1)

    await t.call(`/api/properties/${res.body.property.id}`, { method: 'PATCH', body: { property: { notes: 'Freshly painted' } } })
    assert.equal((await t.call(`/api/leads/${rahul.id}`)).body.activities.filter((a) => a.type === 'property_matched').length, 1, 're-saving does not repeat the match entry')

    await t.call(`/api/properties/${res.body.property.id}/matches/${wakad.id}/dismiss`, { method: 'POST', body: {} })
    await t.call(`/api/properties/${res.body.property.id}`, { method: 'PATCH', body: { property: { notes: 'Again' } } })
    const after = (await t.call(`/api/properties/${res.body.property.id}`)).body.matches
    assert.equal(after.find((m) => m.name === 'Neha Kulkarni').status, 'dismissed', 'a dismissed match stays dismissed')

    await t.call(`/api/properties/${res.body.property.id}`, { method: 'PATCH', body: { property: { price: 6000000 } } })
    assert.equal((await t.call(`/api/properties/${res.body.property.id}`)).body.matches.length, 0, 'a price rise above every budget removes the matches')
  } finally { await t.close() }
})

test('a lead’s matching properties come from saved listings only', async () => {
  const t = await startApp()
  try {
    const rahul = await addLead(t, RAHUL)
    assert.deepEqual((await t.call(`/api/leads/${rahul.id}/matches`)).body.matches, [], 'no listings, no matches: nothing invented')
    await addProperty(t, BANER)
    await addProperty(t, { ...BANER, title: 'Villa', property_type: 'villa' })
    const { matches } = (await t.call(`/api/leads/${rahul.id}/matches`)).body
    assert.deepEqual(matches.map((m) => m.property.title), ['2 BHK in Baner'])
  } finally { await t.close() }
})

test('property input is validated and duplicates are refused', async () => {
  const t = await startApp()
  try {
    const bad = await addProperty(t, { title: '', listing_type: 'lease', price: -5, bedrooms: 50 })
    assert.equal(bad.status, 400)
    assert.deepEqual(Object.keys(bad.body.error.details.fields).sort(), ['bedrooms', 'city', 'listing_type', 'price', 'property_type', 'title'], 'every problem at once')
    const missing = await addProperty(t, { title: 'X' })
    assert.deepEqual(Object.keys(missing.body.error.details.fields).sort(), ['city', 'listing_type', 'price', 'property_type'])
    assert.equal((await addProperty(t, BANER)).status, 201)
    assert.equal((await addProperty(t, { ...BANER, title: '2 bhk in baner' })).status, 409)
    assert.equal((await t.call('/api/properties?status=gone')).status, 400)
    assert.equal((await t.call('/api/properties', { as: null })).status, 401)
  } finally { await t.close() }
})

test('sample listings are labelled as samples and load only once', async () => {
  const t = await startApp()
  try {
    const res = await t.call('/api/properties/samples', { method: 'POST', body: {} })
    assert.equal(res.status, 201)
    assert.ok(res.body.properties.every((p) => p.is_sample && p.title.startsWith('Sample')))
    assert.equal((await t.call('/api/properties/samples', { method: 'POST', body: {} })).status, 409)
  } finally { await t.close() }
})

test('properties and matches persist across restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dealsaathi-'))
  const file = join(dir, 'p.db')
  try {
    let t = await startApp({ db: openDatabase(file) })
    await addLead(t, RAHUL)
    const { property } = (await addProperty(t, BANER)).body
    await t.close(); t.db.close()
    t = await startApp({ db: openDatabase(file) })
    const detail = (await t.call(`/api/properties/${property.id}`)).body
    assert.equal(detail.property.title, '2 BHK in Baner')
    assert.equal(detail.matches.length, 1)
    await t.close(); t.db.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
