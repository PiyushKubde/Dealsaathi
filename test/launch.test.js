// Launch hardening: browser security headers, sign-in limits that cannot be reset or dodged, password hashing
// off the main thread, reused prepared statements and the listings index (migration 11).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../server/db.js'
import { createApp } from '../server/app.js'
import { createAuth, createUser, sweepExpired, verifyPassword } from '../server/auth.js'
import { startApp } from './helpers.js'

const login = (t, email, password, headers = {}) => t.call('/api/session/login', { method: 'POST', body: { email, password }, as: null, headers })

test('every page and API answer carries the browser security headers; the feedback page keeps its stricter referrer rule', async () => {
  const t = await startApp()
  try {
    for (const path of ['/', '/api/session', '/api/health', '/app.js']) {
      const res = await fetch(t.base + path)
      const csp = res.headers.get('content-security-policy')
      assert.match(csp, /frame-ancestors 'none'/, path)
      assert.match(csp, /script-src 'self' https:\/\/flow\.viasocket\.com/, path)
      assert.match(csp, /object-src 'none'/, path)
      assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/, `${path}: no inline scripts`)
      assert.equal(res.headers.get('x-frame-options'), 'DENY', path)
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path)
      assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', path)
      assert.equal(res.headers.get('strict-transport-security'), null, `${path}: HSTS only over HTTPS`)
      await res.arrayBuffer()
    }
    const feedback = await fetch(`${t.base}/feedback/some-token`)
    assert.equal(feedback.headers.get('referrer-policy'), 'no-referrer')
    assert.match(feedback.headers.get('content-security-policy'), /frame-ancestors 'none'/)
    await feedback.arrayBuffer()
  } finally { await t.close() }
})

test('HSTS is sent when the proxy says the request came over HTTPS', async () => {
  const db = openDatabase(':memory:')
  const app = createApp({ db, ai: { configured: false }, auth: createAuth({ db }), behindProxy: true })
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/health`, { headers: { 'x-forwarded-proto': 'https' } })
    assert.equal(res.headers.get('strict-transport-security'), 'max-age=31536000')
    await res.arrayBuffer()
  } finally { await new Promise((r) => server.close(r)) }
})

test('signing in to your own account does not reset the failed-attempt count for your address', async () => {
  const t = await startApp()
  try {
    const victim = createUser(t.db, { name: 'Victim Broker', email: 'victim@example.com', password: 'victim-password-1', role: 'agent' })
    for (let i = 0; i < 9; i++) assert.equal((await login(t, victim.email, `guess-${i}-xxxx`)).status, 401)
    assert.equal((await login(t, t.user.email, 'test-password-123')).status, 200, 'the attacker signs in to their own account')
    assert.equal((await login(t, victim.email, 'guess-9-xxxx')).status, 401)
    assert.equal((await login(t, victim.email, 'victim-password-1')).status, 429, 'the limit still holds after the own sign-in')
  } finally { await t.close() }
})

test('guesses at one account from many addresses hit the per-account limit; other accounts are unaffected', async () => {
  const db = openDatabase(':memory:')
  const app = createApp({ db, ai: { configured: false }, auth: createAuth({ db }), behindProxy: true })
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (email, password, ip) => fetch(`${base}/api/session/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ email, password }) })
  try {
    const user = createUser(db, { name: 'Target Broker', email: 'target@example.com', password: 'target-password-1', role: 'agent' })
    assert.equal((await post(user.email, 'target-password-1', '10.0.0.200')).status, 200)
    for (let i = 0; i < 20; i++) assert.equal((await post(user.email, `guess-${i}-xxxx`, `10.0.1.${i}`)).status, 401)
    assert.equal((await post(user.email, 'target-password-1', '10.0.2.1')).status, 429, 'a fresh address does not get round the account limit')
    assert.equal((await post('someone-else@example.com', 'whatever-123', '10.0.2.1')).status, 401, 'other accounts are unaffected')
  } finally { await new Promise((r) => server.close(r)) }
})

test('parallel guesses and parallel signups cannot slip past the limits while passwords are being hashed', async () => {
  const t = await startApp()
  try {
    const guesses = await Promise.all(Array.from({ length: 30 }, (_, i) => login(t, t.user.email, `guess-${i}-xxxx`)))
    const counts = guesses.reduce((c, r) => ({ ...c, [r.status]: (c[r.status] || 0) + 1 }), {})
    assert.deepEqual(counts, { 401: 10, 429: 20 })
  } finally { await t.close() }
  const t2 = await startApp() // a fresh address: the guesses above have locked this one out of sign-up too
  try {
    const signups = await Promise.all(Array.from({ length: 25 }, (_, i) => t2.call('/api/session/register', { method: 'POST', body: { name: 'Burst Buyer', email: `burst${i}@example.com`, password: 'burst-password-1', role: 'buyer' }, as: null })))
    assert.equal(signups.filter((r) => r.status === 200).length, 20)
    assert.ok(signups.filter((r) => r.status !== 200).every((r) => r.body.error.code === 'too_many_signups'))
  } finally { await t2.close() }
})

test('a sign-up refused after counting hands its place back', async () => {
  const t = await startApp()
  try {
    const body = (i) => ({ name: 'Race Buyer', email: 'race@example.com', password: 'race-password-1', role: 'buyer', i })
    // Two sign-ups for one email at once: one account, one email_taken, and only one signup counted.
    const both = await Promise.all([0, 1].map((i) => t.call('/api/session/register', { method: 'POST', body: body(i), as: null })))
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 409])
    const more = []
    for (let i = 0; i < 19; i++) more.push((await t.call('/api/session/register', { method: 'POST', body: { name: 'More Buyer', email: `more${i}@example.com`, password: 'more-password-1', role: 'buyer' }, as: null })).status)
    assert.deepEqual(more, Array(19).fill(200), '19 more fit under the limit of 20')
  } finally { await t.close() }
})

test('an unknown email and a wrong password get the same answer', async () => {
  const t = await startApp()
  try {
    const unknown = await login(t, 'nobody@example.com', 'some-password-1')
    const wrong = await login(t, t.user.email, 'some-password-1')
    assert.equal(unknown.status, 401)
    assert.deepEqual(unknown.body, wrong.body)
  } finally { await t.close() }
})

test('sign-up hashes on the thread pool: the stored hash is the usual scrypt format, sign-in works, and other requests keep flowing meanwhile', async () => {
  const t = await startApp()
  try {
    const res = await t.call('/api/session/register', { method: 'POST', body: { name: 'New Agent', email: 'new@example.com', password: 'new-password-123', role: 'agent' }, as: null })
    assert.equal(res.status, 200)
    const row = t.db.prepare('SELECT password_hash FROM users WHERE email = ?').get('new@example.com')
    assert.match(row.password_hash, /^scrypt\$/)
    assert.ok(verifyPassword('new-password-123', row.password_hash), 'readable by the synchronous check (password reset, older code)')
    assert.equal((await t.call('/api/session/register', { method: 'POST', body: { name: 'New Agent', email: 'new@example.com', password: 'new-password-123', role: 'agent' }, as: null })).body.error.code, 'email_taken')
    // Eight sign-ins at once, and a health check sent alongside: the check is answered before the sign-ins finish.
    const order = []
    const logins = Array.from({ length: 8 }, () => login(t, 'new@example.com', 'new-password-123').then((r) => { order.push('login'); return r.status }))
    const health = fetch(`${t.base}/api/health`).then(async (r) => { await r.arrayBuffer(); order.push('health') })
    const statuses = await Promise.all(logins)
    await health
    assert.deepEqual(statuses, Array(8).fill(200))
    assert.ok(order.indexOf('health') < order.length - 1, `health was answered while sign-ins were running (${order.join(',')})`)
  } finally { await t.close() }
})

test('rate-limit maps drop expired entries once they grow', () => {
  const map = new Map()
  for (let i = 0; i < 10; i++) map.set(`old${i}`, { resetAt: Date.now() - 1000 })
  map.set('live', { resetAt: Date.now() + 60000 })
  sweepExpired(map, 100)
  assert.equal(map.size, 11, 'nothing is swept below the threshold')
  sweepExpired(map, 5)
  assert.deepEqual([...map.keys()], ['live'])
  const hits = new Map([['a', { reset: Date.now() - 1 }], ['b', { reset: Date.now() + 1000 }]])
  sweepExpired(hits, 1, 'reset')
  assert.deepEqual([...hits.keys()], ['b'])
})

test('prepared statements are reused per SQL text', () => {
  const db = openDatabase(':memory:')
  const a = db.prepare('SELECT COUNT(*) AS n FROM users')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users'), a)
  assert.notEqual(db.prepare('SELECT COUNT(*) AS n FROM leads'), a)
  assert.equal(a.get().n, 0)
  db.close()
})

test('migration 11 adds the listings index to a v10 database: a backup first, data unchanged, the v10 app still opens it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-m11-'))
  const file = join(dir, 'd.db')
  const snapshot = (db) => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_version' ORDER BY name").all()
    .map((r) => [r.name, db.prepare(`SELECT * FROM "${r.name}" ORDER BY rowid`).all()]))
  try {
    const old = openDatabase(file, { upTo: 10 })
    const t = await startApp({ db: old })
    assert.equal((await t.call('/api/properties', { method: 'POST', body: { property: { title: '2 BHK in Baner', listing_type: 'sale', property_type: 'apartment', bedrooms: 2, price: 4800000, city: 'Pune', locality: 'Baner', address: '12 Baner Road' } } })).status, 201)
    await t.close()
    const before = snapshot(old)
    old.close()
    const logs = []
    const db = openDatabase(file, { log: (l) => logs.push(l) })
    assert.equal(db.prepare('SELECT version FROM schema_version').get().version, 11)
    assert.match(logs.join('\n'), /Backed up the database before migrating v10 → v11/)
    assert.equal(readdirSync(dir).filter((f) => /^d\.db\.pre-v11-\d+\.bak$/.test(f)).length, 1)
    assert.deepEqual(snapshot(db), before)
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM properties p WHERE p.listing_state = 'published' AND p.is_sample = 0 AND p.status = 'available' ORDER BY p.updated_at DESC, p.id DESC LIMIT 100").all().map((r) => r.detail).join(' | ')
    assert.match(plan, /properties_published/)
    assert.doesNotMatch(plan, /TEMP B-TREE/, 'no sort of every listing')
    db.close()
    const back = openDatabase(file, { upTo: 10 })
    assert.equal(back.prepare('SELECT version FROM schema_version').get().version, 11)
    assert.equal(back.prepare('SELECT COUNT(*) AS n FROM properties').get().n, 1)
    back.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
