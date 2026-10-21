import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createAuth, hashPassword, verifyPassword } from '../server/auth.js'
import { databaseFile } from '../server/db.js'
import { startApp } from './helpers.js'

const CODE = 'team-access-code-2026'
const LEAD = { full_name: 'Rahul Sharma', customer_type: 'buyer', phone: '9876543210' }
const register = (t, body) => t.call('/api/session/register', { method: 'POST', body, as: null })
const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0]

test('every API call needs a signed-in user', async () => {
  const t = await startApp()
  try {
    for (const path of ['/api/leads', '/api/dashboard', '/api/integrations/connections', '/api/automations/flows']) {
      const res = await t.call(path, { as: null })
      assert.equal(res.status, 401, path)
      assert.equal(res.body.error.code, 'login_required')
    }
    assert.equal((await t.call('/api/health', { as: null })).status, 200)
    assert.equal((await t.call('/api/leads')).status, 200, 'the harness user is signed in')
  } finally { await t.close() }
})

test('register → stable usr_ id (not the email) → sign out revokes the session → sign in again', async () => {
  const t = await startApp({ withUser: false })
  try {
    const res = await register(t, { name: 'Priya Desai', email: 'Priya@Example.com', password: 'a-long-password' })
    assert.equal(res.status, 200)
    assert.match(res.body.user.id, /^usr_[0-9a-f]{18}$/)
    assert.equal(res.body.user.email, 'priya@example.com')
    const setCookie = res.headers.get('set-cookie')
    assert.match(setCookie, /HttpOnly/)
    assert.match(setCookie, /SameSite=Strict/)
    const me = { cookie: cookieOf(res) }
    assert.equal((await t.call('/api/session', { as: me })).body.user.id, res.body.user.id)
    assert.equal((await t.call('/api/leads', { method: 'POST', body: { lead: LEAD }, as: me })).status, 201)

    await t.call('/api/session/logout', { method: 'POST', body: {}, as: me })
    assert.equal((await t.call('/api/leads', { as: me })).status, 401, 'the old cookie no longer works')

    const wrong = await t.call('/api/session/login', { method: 'POST', body: { email: 'priya@example.com', password: 'nope-nope-nope' }, as: null })
    assert.equal(wrong.status, 401)
    const login = await t.call('/api/session/login', { method: 'POST', body: { email: 'PRIYA@example.com', password: 'a-long-password' }, as: null })
    assert.equal(login.status, 200)
    assert.equal(login.body.user.id, res.body.user.id, 'the same id on every sign-in')
  } finally { await t.close() }
})

test('registration validates fields and refuses a second account for one email', async () => {
  const t = await startApp({ withUser: false })
  try {
    const bad = await register(t, { name: 'P', email: 'nope', password: 'short' })
    assert.equal(bad.status, 400)
    assert.deepEqual(Object.keys(bad.body.error.details.fields).sort(), ['email', 'name', 'password'])
    assert.equal((await register(t, { name: 'Priya', email: 'p@example.com', password: 'a-long-password' })).status, 200)
    assert.equal((await register(t, { name: 'Other', email: 'P@example.com', password: 'a-long-password' })).status, 409)
  } finally { await t.close() }
})

test('a forged or garbage session cookie is refused', async () => {
  const t = await startApp()
  try {
    assert.equal((await t.call('/api/leads', { as: { cookie: 'ds_session=forged-token-value' } })).status, 401)
    assert.equal((await t.call('/api/leads', { as: { cookie: `ds_session=${'x'.repeat(500)}` } })).status, 401)
  } finally { await t.close() }
})

test('hosted without APP_PASSWORD (or with a short one), everything but health is locked', async () => {
  for (const accessCode of [undefined, 'short']) {
    const t = await startApp({ withUser: false, auth: undefined })
    const locked = await startApp({ withUser: true, auth: createAuth({ db: t.db, hosted: true, accessCode }), db: t.db })
    try {
      assert.equal((await locked.call('/api/leads')).status, 503, 'even a valid session is locked out')
      assert.equal((await locked.call('/api/leads')).body.error.code, 'password_not_set')
      assert.equal((await register(locked, { name: 'X Y', email: 'x@example.com', password: 'a-long-password', accessCode: 'anything' })).status, 503)
      assert.equal((await locked.call('/api/health')).body.access, 'locked')
    } finally { await t.close(); await locked.close() }
  }
})

test('hosted: creating an account needs the team access code; signing in does not', async () => {
  const base = await startApp({ withUser: false })
  const t = await startApp({ withUser: false, db: base.db, auth: createAuth({ db: base.db, hosted: true, accessCode: CODE }) })
  try {
    const noCode = await register(t, { name: 'Priya', email: 'p@example.com', password: 'a-long-password' })
    assert.equal(noCode.status, 401)
    assert.equal(noCode.body.error.code, 'wrong_access_code')
    assert.equal((await register(t, { name: 'Priya', email: 'p@example.com', password: 'a-long-password', accessCode: 'wrong-code-here' })).status, 401)
    const ok = await register(t, { name: 'Priya', email: 'p@example.com', password: 'a-long-password', accessCode: CODE })
    assert.equal(ok.status, 200)
    assert.equal((await t.call('/api/session/login', { method: 'POST', body: { email: 'p@example.com', password: 'a-long-password' }, as: null })).status, 200)
    assert.equal((await t.call('/api/session', { as: null })).body.registrationNeedsCode, true)
  } finally { await base.close(); await t.close() }
})

test('repeated wrong passwords are slowed down', async () => {
  const t = await startApp()
  try {
    for (let i = 0; i < 10; i++) await t.call('/api/session/login', { method: 'POST', body: { email: t.user.email, password: `wrong-${i}-xxxx` }, as: null })
    const blocked = await t.call('/api/session/login', { method: 'POST', body: { email: t.user.email, password: 'test-password-123' }, as: null })
    assert.equal(blocked.status, 429, 'even the right password waits once the limit is hit')
  } finally { await t.close() }
})

test('passwords are stored as scrypt hashes, never in clear', async () => {
  const t = await startApp()
  try {
    const row = t.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(t.user.id)
    assert.match(row.password_hash, /^scrypt\$/)
    assert.doesNotMatch(row.password_hash, /test-password-123/)
    const h = hashPassword('secret-value-1')
    assert.equal(verifyPassword('secret-value-1', h), true)
    assert.equal(verifyPassword('secret-value-2', h), false)
    const sessions = t.db.prepare('SELECT token_hash FROM sessions').all()
    assert.ok(sessions.every((s) => /^[0-9a-f]{64}$/.test(s.token_hash)), 'only session hashes are stored')
  } finally { await t.close() }
})

test('a malformed Origin header is refused, not a crash', async () => {
  const t = await startApp()
  try {
    assert.equal((await t.call('/api/leads', { method: 'POST', body: { lead: LEAD }, headers: { Origin: 'null' } })).status, 403)
  } finally { await t.close() }
})

test('the database lives under DATA_DIR when the host provides one', () => {
  assert.equal(databaseFile({ DATA_DIR: '/data' }), join('/data', 'dealsaathi.db'))
  assert.equal(databaseFile({}), 'data/dealsaathi.db')
  assert.equal(databaseFile({ DATABASE_FILE: '/x.db', DATA_DIR: '/data' }), '/x.db')
})
