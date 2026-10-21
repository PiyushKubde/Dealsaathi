import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../server/db.js'
import { startApp, leadCount, breakLeadInserts } from './helpers.js'

const RAHUL = { full_name: 'Rahul Sharma', customer_type: 'buyer', phone: '98765 43210', preferred_location: 'Pune', bedrooms: 2, budget_max: 5000000 }

test('create, read, search, filter, update and delete a lead', async () => {
  const t = await startApp()
  try {
    const created = await t.call('/api/leads', { method: 'POST', body: { lead: RAHUL } })
    assert.equal(created.status, 201)
    const lead = created.body.lead
    assert.equal(lead.code, 'L-0001')
    assert.equal(lead.status, 'new')
    assert.equal(lead.origin, 'local')
    assert.ok(lead.created_at && lead.updated_at)
    assert.equal(lead.phone_norm, undefined, 'internal columns are not exposed')

    await t.call('/api/leads', { method: 'POST', body: { lead: { full_name: 'Priya Nair', customer_type: 'tenant', email: 'priya@example.com', preferred_location: 'Bangalore' } } })

    const one = await t.call(`/api/leads/${lead.id}`)
    assert.equal(one.body.lead.full_name, 'Rahul Sharma')
    assert.equal(one.body.activities[0].type, 'created')

    assert.equal((await t.call('/api/leads?q=rahul')).body.total, 1)
    assert.equal((await t.call('/api/leads?q=43210')).body.total, 1, 'search by phone digits')
    assert.equal((await t.call('/api/leads?customer_type=tenant')).body.leads[0].full_name, 'Priya Nair')
    assert.equal((await t.call('/api/leads?location=pune')).body.total, 1)
    assert.equal((await t.call('/api/leads?q=%25')).body.total, 0, 'LIKE wildcards are escaped')
    assert.equal((await t.call('/api/leads?status=hot')).status, 400)

    const updated = await t.call(`/api/leads/${lead.id}`, { method: 'PATCH', body: { lead: { status: 'contacted', notes: 'Called, wants Baner' } } })
    assert.equal(updated.status, 200)
    assert.equal(updated.body.lead.status, 'contacted')
    assert.deepEqual(updated.body.changed.map((c) => c.field).sort(), ['notes', 'status'])
    const history = (await t.call(`/api/leads/${lead.id}`)).body.activities
    assert.equal(history.length, 2)

    const removed = await t.call(`/api/leads/${lead.id}`, { method: 'DELETE' })
    assert.equal(removed.body.deleted, true)
    assert.equal((await t.call(`/api/leads/${lead.id}`)).status, 404)
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM lead_activities WHERE lead_id = ?').get(lead.id).n, 0)
  } finally { await t.close() }
})

test('invalid input is refused with per-field messages and nothing is saved', async () => {
  const t = await startApp()
  try {
    const res = await t.call('/api/leads', { method: 'POST', body: { lead: { full_name: '', customer_type: 'investor', email: 'bad' } } })
    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'validation_failed')
    assert.ok(res.body.error.details.fields.customer_type)
    assert.ok(res.body.error.details.fields.email)
    assert.equal((await t.call('/api/leads', { method: 'POST', body: { lead: 'nope' } })).status, 400)
    assert.equal((await t.call('/api/leads', { method: 'POST', body: {} })).status, 400)
    assert.equal(leadCount(t.db), 0)
    assert.equal((await t.call('/api/leads/abc')).status, 404)
    const patch = await t.call('/api/leads/999', { method: 'PATCH', body: { lead: { status: 'won' } } })
    assert.equal(patch.status, 404)
  } finally { await t.close() }
})

test('removing the only contact detail on edit is refused', async () => {
  const t = await startApp()
  try {
    const { lead } = (await t.call('/api/leads', { method: 'POST', body: { lead: RAHUL } })).body
    const res = await t.call(`/api/leads/${lead.id}`, { method: 'PATCH', body: { lead: { phone: '' } } })
    assert.equal(res.status, 400)
    assert.equal((await t.call(`/api/leads/${lead.id}`)).body.lead.phone, '98765 43210')
  } finally { await t.close() }
})

test('duplicates: same phone or email is blocked, same name needs an explicit override', async () => {
  const t = await startApp()
  try {
    await t.call('/api/leads', { method: 'POST', body: { lead: { ...RAHUL, email: 'rahul@example.com' } } })
    const samePhone = await t.call('/api/leads', { method: 'POST', body: { lead: { full_name: 'R. Sharma', customer_type: 'buyer', phone: '+91 9876543210' } } })
    assert.equal(samePhone.status, 409)
    assert.equal(samePhone.body.error.details.duplicates[0].strong, true)
    const sameEmail = await t.call('/api/leads', { method: 'POST', body: { lead: { full_name: 'Someone', customer_type: 'seller', email: 'RAHUL@example.com' }, allowSameName: true } })
    assert.equal(sameEmail.status, 409, 'an override never bypasses a phone/email match')

    const sameName = { full_name: 'rahul  sharma', customer_type: 'seller', phone: '9000000001' }
    assert.equal((await t.call('/api/leads', { method: 'POST', body: { lead: sameName } })).status, 409)
    assert.equal((await t.call('/api/leads', { method: 'POST', body: { lead: sameName, allowSameName: true } })).status, 201)
    assert.equal(leadCount(t.db), 2)
  } finally { await t.close() }
})

test('a repeated form submission with the same Idempotency-Key saves once', async () => {
  const t = await startApp()
  try {
    const headers = { 'Idempotency-Key': 'form-1234-abcd' }
    const first = await t.call('/api/leads', { method: 'POST', body: { lead: RAHUL }, headers })
    const second = await t.call('/api/leads', { method: 'POST', body: { lead: RAHUL }, headers })
    assert.equal(first.status, 201)
    assert.equal(second.status, 201)
    assert.equal(second.body.replayed, true)
    assert.equal(second.body.lead.id, first.body.lead.id)
    assert.equal(leadCount(t.db), 1)
  } finally { await t.close() }
})

test('leads persist in the database file across restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dealsaathi-'))
  const file = join(dir, 'test.db')
  try {
    let t = await startApp({ db: openDatabase(file) })
    await t.call('/api/leads', { method: 'POST', body: { lead: RAHUL } })
    await t.close()
    t.db.close()

    t = await startApp({ db: openDatabase(file) })
    const { body } = await t.call('/api/leads')
    assert.equal(body.total, 1)
    assert.equal(body.leads[0].full_name, 'Rahul Sharma')
    await t.close()
    t.db.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a database failure answers 500 without internals, and nothing is saved', async () => {
  const t = await startApp()
  const original = console.error
  console.error = () => {}
  try {
    breakLeadInserts(t.db)
    const res = await t.call('/api/leads', { method: 'POST', body: { lead: RAHUL } })
    assert.equal(res.status, 500)
    assert.equal(res.body.error.code, 'internal_error')
    assert.doesNotMatch(res.text, /simulated|SQLITE|stack|at /i)
    assert.equal(leadCount(t.db), 0)
  } finally { console.error = original; await t.close() }
})

test('writes from another site or without JSON are refused', async () => {
  const t = await startApp()
  try {
    const cross = await t.call('/api/leads', { method: 'POST', body: { lead: RAHUL }, headers: { Origin: 'https://evil.example' } })
    assert.equal(cross.status, 403)
    const res = await fetch(`${t.base}/api/leads`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' })
    assert.equal(res.status, 415)
    const badJson = await fetch(`${t.base}/api/leads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' })
    assert.equal(badJson.status, 400)
    assert.equal(leadCount(t.db), 0)
  } finally { await t.close() }
})

test('health and dashboard come from real records', async () => {
  const t = await startApp()
  try {
    const health = await t.call('/api/health')
    assert.equal(health.body.ok, true)
    assert.equal(health.body.database, 'ok')
    assert.equal(health.body.ai, 'configured')
    assert.doesNotMatch(health.text, /secret/i)
    assert.equal((await t.call('/api/dashboard')).body.total, 0)
    await t.call('/api/leads', { method: 'POST', body: { lead: RAHUL } })
    const d = (await t.call('/api/dashboard')).body
    assert.equal(d.total, 1)
    assert.equal(d.byType.buyer, 1)
    assert.equal(d.followUp.total, 0, 'a brand-new lead does not need follow-up yet')
    t.db.prepare("UPDATE leads SET updated_at = '2020-01-01T00:00:00.000Z'").run()
    assert.equal((await t.call('/api/dashboard')).body.followUp.total, 1)
  } finally { await t.close() }
})
