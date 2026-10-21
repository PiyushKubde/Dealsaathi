import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { startApp } from './helpers.js'

describe('lead management', () => {
  let t
  before(async () => {
    t = await startApp({ viasocket: false })
    await t.signIn()
  })
  after(() => t.close())

  test('rejects requests without a session', async () => {
    const res = await t.request('/leads', { auth: false })
    assert.equal(res.status, 401)
  })

  test('rejects state changes without the app header (CSRF guard)', async () => {
    const res = await t.request('/leads', { method: 'POST', body: { full_name: 'X' }, headers: { 'X-DealSaathi': '' } })
    assert.equal(res.status, 403)
  })

  test('validates required fields', async () => {
    const res = await t.request('/leads', { method: 'POST', body: { full_name: 'Rahul Sharma', category: 'buyer' } })
    assert.equal(res.status, 422)
    assert.ok(res.data.issues.some((i) => i.field === 'email'))
    const bad = await t.request('/leads', { method: 'POST', body: { full_name: 'R', category: 'alien', email: 'nope' } })
    assert.equal(bad.status, 422)
    const fields = bad.data.issues.map((i) => i.field)
    for (const f of ['full_name', 'category', 'email']) assert.ok(fields.includes(f), `expected an issue for ${f}`)
  })

  test('rejects an inverted budget', async () => {
    const res = await t.request('/leads', { method: 'POST', body: { full_name: 'Asha Rao', category: 'buyer', phone: '9000011111', budget_min: 9000000, budget_max: 5000000 } })
    assert.equal(res.status, 422)
  })

  let leadId
  test('creates a lead and returns it', async () => {
    const res = await t.request('/leads', {
      method: 'POST',
      body: { full_name: 'Rahul Sharma', category: 'buyer', phone: '+91 98765 43210', preferred_location: 'Baner, Pune', budget_max: '50,00,000' }
    })
    assert.equal(res.status, 201)
    leadId = res.data.lead.id
    assert.equal(res.data.lead.budget_max, 5000000)
    assert.equal(res.data.lead.status, 'new')
  })

  test('blocks duplicates by normalised phone and by email', async () => {
    const dup = await t.request('/leads', { method: 'POST', body: { full_name: 'R. Sharma', category: 'buyer', phone: '098765 43210' } })
    assert.equal(dup.status, 409)
    assert.equal(dup.data.existing.id, leadId)
    await t.request(`/leads/${leadId}`, { method: 'PATCH', body: { email: 'Rahul@Example.com' } })
    const dupEmail = await t.request('/leads', { method: 'POST', body: { full_name: 'Someone', category: 'tenant', email: 'rahul@example.com' } })
    assert.equal(dupEmail.status, 409)
  })

  test('updates and retrieves a lead', async () => {
    const res = await t.request(`/leads/${leadId}`, { method: 'PATCH', body: { status: 'interested', assigned_broker: 'Priya' } })
    assert.equal(res.status, 200)
    const got = await t.request(`/leads/${leadId}`)
    assert.equal(got.data.lead.status, 'interested')
    assert.equal(got.data.lead.assigned_broker, 'Priya')
    assert.equal(got.data.lead.email, 'rahul@example.com')
  })

  test('an update cannot remove both contact details', async () => {
    const res = await t.request(`/leads/${leadId}`, { method: 'PATCH', body: { email: null, phone: null } })
    assert.equal(res.status, 422)
  })

  test('searches and filters', async () => {
    await t.request('/leads', { method: 'POST', body: { full_name: 'Meena Iyer', category: 'tenant', email: 'meena@example.com', preferred_location: 'Wakad' } })
    assert.equal((await t.request('/leads?q=wakad')).data.leads.length, 1)
    assert.equal((await t.request('/leads?category=buyer')).data.leads.length, 1)
    assert.equal((await t.request('/leads?status=interested')).data.leads[0].full_name, 'Rahul Sharma')
  })

  test('another session cannot read without signing in, and unknown ids 404', async () => {
    assert.equal((await t.request('/leads/9999')).status, 404)
    assert.equal((await t.request('/leads/abc')).status, 400)
  })
})

describe('persistence', () => {
  test('a saved lead survives a restart on the same data directory', async () => {
    const first = await startApp({ viasocket: false })
    await first.signIn()
    await first.request('/leads', { method: 'POST', body: { full_name: 'Kiran Patil', category: 'seller', email: 'kiran@example.com' } })
    const dir = first.dir
    await first.close()
    const second = await startApp({ viasocket: false, dataDir: dir })
    await second.signIn()
    const { data } = await second.request('/leads')
    assert.deepEqual(data.leads.map((l) => l.full_name), ['Kiran Patil'])
    // Sample listings are seeded once, not again on restart.
    assert.equal(data && (await second.request('/status')).data.data.properties.sample, 8)
    await second.close()
  })

  test('wrong password is refused', async () => {
    const t = await startApp({ viasocket: false })
    const res = await t.request('/auth/login', { method: 'POST', body: { email: 'owner@example.com', password: 'wrong' } })
    assert.equal(res.status, 401)
    await t.close()
  })
})
