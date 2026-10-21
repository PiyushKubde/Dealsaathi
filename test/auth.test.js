import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createAuth } from '../server/auth.js'
import { databaseFile } from '../server/db.js'
import { startApp } from './helpers.js'

const PASSWORD = 'correct-horse-battery'
const LEAD = { full_name: 'Rahul Sharma', customer_type: 'buyer', phone: '9876543210' }

test('locally, with no password, the app is open', async () => {
  const t = await startApp({ auth: createAuth({ hosted: false }) })
  try {
    assert.equal((await t.call('/api/leads')).status, 200)
    assert.deepEqual((await t.call('/api/session')).body, { mode: 'open', hosted: false, signedIn: true })
  } finally { await t.close() }
})

test('hosted without APP_PASSWORD (or with a short one), everything but health is locked', async () => {
  for (const password of [undefined, 'short']) {
    const t = await startApp({ auth: createAuth({ hosted: true, password }) })
    try {
      const res = await t.call('/api/leads')
      assert.equal(res.status, 503)
      assert.equal(res.body.error.code, 'password_not_set')
      assert.equal((await t.call('/api/leads', { method: 'POST', body: { lead: LEAD } })).status, 503)
      assert.equal((await t.call('/api/assistant/messages', { method: 'POST', body: { message: 'hi' } })).status, 503)
      assert.equal((await t.call('/api/session/login', { method: 'POST', body: { password: 'anything' } })).status, 503)
      const health = await t.call('/api/health')
      assert.equal(health.status, 200)
      assert.equal(health.body.access, 'locked')
    } finally { await t.close() }
  }
})

test('with a password: refused until signed in, then allowed with the session cookie', async () => {
  const t = await startApp({ auth: createAuth({ hosted: true, password: PASSWORD }) })
  try {
    const before = await t.call('/api/leads')
    assert.equal(before.status, 401)
    assert.equal(before.body.error.code, 'login_required')
    assert.equal((await t.call('/api/dashboard')).status, 401)

    const wrong = await t.call('/api/session/login', { method: 'POST', body: { password: 'nope' } })
    assert.equal(wrong.status, 401)
    assert.equal(wrong.body.error.code, 'wrong_password')

    const res = await fetch(`${t.base}/api/session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) })
    assert.equal(res.status, 200)
    const setCookie = res.headers.get('set-cookie')
    assert.match(setCookie, /HttpOnly/)
    assert.match(setCookie, /SameSite=Strict/)
    assert.doesNotMatch(setCookie, new RegExp(PASSWORD), 'the password is not in the cookie')
    const cookie = setCookie.split(';')[0]

    const ok = await t.call('/api/leads', { method: 'POST', body: { lead: LEAD }, headers: { cookie } })
    assert.equal(ok.status, 201)
    assert.equal((await t.call('/api/session', { headers: { cookie } })).body.signedIn, true)

    const [name, value] = cookie.split('=')
    const tampered = `${name}=${String(Date.now() + 9e9)}.${value.split('.')[1]}`
    assert.equal((await t.call('/api/leads', { headers: { cookie: tampered } })).status, 401)
    assert.equal((await t.call('/api/leads', { headers: { cookie: `${name}=garbage` } })).status, 401)
  } finally { await t.close() }
})

test('a session signed with an old password no longer works', async () => {
  const a = await startApp({ auth: createAuth({ hosted: true, password: PASSWORD }) })
  const b = await startApp({ auth: createAuth({ hosted: true, password: 'a-different-password' }) })
  try {
    const res = await fetch(`${a.base}/api/session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) })
    const cookie = res.headers.get('set-cookie').split(';')[0]
    assert.equal((await b.call('/api/leads', { headers: { cookie } })).status, 401)
  } finally { await a.close(); await b.close() }
})

test('repeated wrong passwords are slowed down', async () => {
  const t = await startApp({ auth: createAuth({ hosted: true, password: PASSWORD }) })
  try {
    for (let i = 0; i < 10; i++) await t.call('/api/session/login', { method: 'POST', body: { password: `wrong-${i}` } })
    const blocked = await t.call('/api/session/login', { method: 'POST', body: { password: PASSWORD } })
    assert.equal(blocked.status, 429, 'even the right password waits once the limit is hit')
  } finally { await t.close() }
})

test('a malformed Origin header is refused, not a crash', async () => {
  const t = await startApp()
  try {
    const res = await t.call('/api/leads', { method: 'POST', body: { lead: LEAD }, headers: { Origin: 'null' } })
    assert.equal(res.status, 403)
  } finally { await t.close() }
})

test('the database lives under DATA_DIR when the host provides one', () => {
  assert.equal(databaseFile({ DATA_DIR: '/data' }), join('/data', 'dealsaathi.db'))
  assert.equal(databaseFile({}), 'data/dealsaathi.db')
  assert.equal(databaseFile({ DATABASE_FILE: '/x.db', DATA_DIR: '/data' }), '/x.db')
})
