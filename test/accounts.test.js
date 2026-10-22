// Email verification, password reset, and who may see a tenancy (invitation or verified email only).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, fakeVs, signedInUser, V } from './helpers.js'
import { todayIn } from '../server/time.js'
import { openDatabase } from '../server/db.js'

/** An app whose system email goes through the first agent's (fake) Gmail connection. */
async function setup({ mail = true } = {}) {
  const vs = fakeVs()
  const holder = { id: null }
  const t = await startApp({ vs, mailConnection: () => holder.id })
  if (mail) {
    const gmail = (await t.call('/api/integrations/connections', { method: 'POST', body: { serviceId: await vs.serviceIdFor('gmail'), authId: vs.connectApp(t.user.id, 'gmail') } })).body.connection
    holder.id = gmail.id
  }
  return { t, vs, holder }
}
const mails = (vs) => vs.calls.filter((c) => c.name === 'runAction' && c.args[1] === V.rowogelpy0h6).map((c) => c.args[2])
const linkToken = (mail, path) => new RegExp(`#/${path}/([A-Za-z0-9_-]{40,60})`).exec(mail.messageBody)?.[1]
const register = (t, body) => t.call('/api/session/register', { method: 'POST', body: { password: 'a-long-password-1', ...body }, as: null })
const cookieOf = (res) => ({ cookie: res.headers.get('set-cookie').split(';')[0] })
const TEN = { tenant_name: 'Rahul Sharma', tenant_email: 'rahul@example.com', landlord_email: 'sunita@example.com', property_label: 'Flat 4B', rent_amount: 28000, due_day: 5, lease_start: todayIn('Asia/Kolkata') }

test('without a system email account, verification and reset say so instead of pretending', async () => {
  const { t } = await setup({ mail: false })
  try {
    const send = await t.call('/api/me/verification/send', { method: 'POST', body: {} })
    assert.equal(send.status, 503)
    assert.equal(send.body.error.code, 'mail_unavailable')
    assert.equal((await t.call('/api/session/password/forgot', { method: 'POST', body: { email: t.user.email }, as: null })).status, 503)
    assert.equal((await t.call('/api/session/mail', { as: null })).body.available, false)
  } finally { await t.close() }
})

test('email verification: one emailed link, single use, older links stop working, rate limited', async () => {
  const { t, vs } = await setup()
  try {
    const r = await register(t, { name: 'Rahul Sharma', email: 'rahul@example.com', role: 'buyer' })
    const me = cookieOf(r)
    assert.equal(r.body.user.emailVerified, false)
    assert.equal((await t.call('/api/me/verification/send', { method: 'POST', body: {}, as: me })).status, 200)
    const first = linkToken(mails(vs).at(-1), 'verify-email')
    assert.equal(mails(vs).at(-1).to, 'rahul@example.com')
    await t.call('/api/me/verification/send', { method: 'POST', body: {}, as: me })
    const second = linkToken(mails(vs).at(-1), 'verify-email')
    assert.equal((await t.call('/api/session/verify-email', { method: 'POST', body: { token: first }, as: null })).status, 400, 'a replaced link no longer works')
    assert.equal((await t.call('/api/session/verify-email', { method: 'POST', body: { token: second }, as: null })).body.verified, true)
    assert.equal((await t.call('/api/session/verify-email', { method: 'POST', body: { token: second }, as: null })).status, 400, 'single use')
    assert.equal((await t.call('/api/session', { as: me })).body.user.emailVerified, true)
    assert.equal((await t.call('/api/me/verification/send', { method: 'POST', body: {}, as: me })).status, 409)
    assert.doesNotMatch(JSON.stringify(t.db.prepare('SELECT * FROM auth_tokens').all()), new RegExp(second), 'only hashes are stored')
    // Rate limit: at most 5 verification emails an hour.
    const other = cookieOf(await register(t, { name: 'Spam Target', email: 'target@example.com', role: 'seller' }))
    const codes = []
    for (let i = 0; i < 6; i++) codes.push((await t.call('/api/me/verification/send', { method: 'POST', body: {}, as: other })).status)
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 429])
  } finally { await t.close() }
})

test('password reset: same answer for unknown emails, 30-minute single-use link, signs out everywhere', async () => {
  const { t, vs } = await setup()
  try {
    const r = await register(t, { name: 'Sunita Rao', email: 'sunita@example.com', role: 'seller' })
    const oldSession = cookieOf(r)
    const before = mails(vs).length
    const unknown = await t.call('/api/session/password/forgot', { method: 'POST', body: { email: 'nobody@example.com' }, as: null })
    const known = await t.call('/api/session/password/forgot', { method: 'POST', body: { email: 'Sunita@Example.com' }, as: null })
    assert.equal(unknown.status, 202)
    assert.deepEqual(unknown.body, known.body, 'no account discovery')
    assert.equal(mails(vs).length, before + 1, 'only the real account gets an email')
    const token = linkToken(mails(vs).at(-1), 'reset-password')
    assert.equal((await t.call('/api/session/password/reset', { method: 'POST', body: { token, password: 'short' }, as: null })).status, 400)
    assert.equal((await t.call('/api/session/password/reset', { method: 'POST', body: { token, password: 'a-brand-new-password' }, as: null })).status, 200, 'a refused password does not use up the link')
    assert.equal((await t.call('/api/me', { as: oldSession })).status, 401, 'every old session ends')
    assert.equal((await t.call('/api/session/password/reset', { method: 'POST', body: { token, password: 'another-password-1' }, as: null })).status, 400, 'single use')
    assert.equal((await t.call('/api/session/login', { method: 'POST', body: { email: 'sunita@example.com', password: 'a-long-password-1' }, as: null })).status, 401)
    const login = await t.call('/api/session/login', { method: 'POST', body: { email: 'sunita@example.com', password: 'a-brand-new-password' }, as: null })
    assert.equal(login.status, 200)
    assert.equal(login.body.user.emailVerified, true, 'the emailed link proved the address')
    // An expired reset link is refused.
    await t.call('/api/session/password/forgot', { method: 'POST', body: { email: 'sunita@example.com' }, as: null })
    const late = linkToken(mails(vs).at(-1), 'reset-password')
    t.db.prepare("UPDATE auth_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE purpose = 'reset_password' AND used_at IS NULL").run()
    assert.equal((await t.call('/api/session/password/reset', { method: 'POST', body: { token: late, password: 'yet-another-pass-1' }, as: null })).status, 400)
    for (let i = 0; i < 6; i++) await t.call('/api/session/password/forgot', { method: 'POST', body: { email: 'x@example.com' }, as: null })
    assert.equal((await t.call('/api/session/password/forgot', { method: 'POST', body: { email: 'x@example.com' }, as: null })).status, 429, 'rate limited per address')
  } finally { await t.close() }
})

test('a tenancy is never shared by a typed email alone: an unverified look-alike account sees nothing', async () => {
  const { t } = await setup()
  try {
    // Someone registers with the tenant's email before the agent adds the tenancy, and never verifies it.
    const impostor = cookieOf(await register(t, { name: 'Not Rahul', email: 'rahul@example.com', role: 'buyer' }))
    const { tenancy, dues } = (await t.call('/api/rent/tenancies', { method: 'POST', body: { tenancy: TEN } })).body
    assert.equal(tenancy.tenant_user_id, null)
    assert.equal((await t.call('/api/me/tenancies', { as: impostor })).body.tenancies.length, 0)
    assert.equal((await t.call(`/api/me/tenancies/${tenancy.id}`, { as: impostor })).status, 404)
    assert.equal((await t.call('/api/rent', { as: impostor })).status, 403)
    assert.equal((await t.call(`/api/rent/tenancies/${tenancy.id}`, { as: impostor })).status, 403)
    assert.equal((await t.call(`/api/me/rent/dues/${dues[0].id}/payments`, { method: 'POST', body: { amount: 1, paidOn: todayIn('Asia/Kolkata'), note: 'sneaky' }, as: impostor })).status, 403)
  } finally { await t.close() }
})

test('invitations: only the invited email and role can accept, once; the link reveals nothing to anyone else', async () => {
  const { t } = await setup()
  try {
    const rahul = cookieOf(await register(t, { name: 'Rahul Sharma', email: 'rahul@example.com', role: 'buyer' }))
    const wrongEmail = cookieOf(await register(t, { name: 'Other Buyer', email: 'other@example.com', role: 'buyer' }))
    const buyerNamedAsLandlord = cookieOf(await register(t, { name: 'Sunita as Buyer', email: 'sunita@example.com', role: 'buyer' }))
    const { tenancy, dues } = (await t.call('/api/rent/tenancies', { method: 'POST', body: { tenancy: TEN } })).body
    assert.equal(tenancy.tenant_user_id, null, 'an unverified account with the same email is not linked automatically')
    const inv = await t.call(`/api/rent/tenancies/${tenancy.id}/invites`, { method: 'POST', body: { party: 'tenant' } })
    assert.equal(inv.status, 201)
    const token = /#\/invite\/(.+)$/.exec(inv.body.link)[1]
    assert.doesNotMatch(JSON.stringify(t.db.prepare('SELECT * FROM tenancy_invites').all()), new RegExp(token), 'only the hash is kept')

    const preview = (await t.call('/api/invites/preview', { method: 'POST', body: { token }, as: wrongEmail })).body
    assert.equal(preview.propertyLabel, null, 'a wrong account does not learn the property')
    assert.equal(preview.sentTo, 'r•••@example.com')
    assert.equal((await t.call('/api/invites/accept', { method: 'POST', body: { token }, as: wrongEmail })).status, 403)
    assert.equal((await t.call('/api/invites/accept', { method: 'POST', body: { token }, as: null })).status, 401)
    assert.equal((await t.call('/api/invites/accept', { method: 'POST', body: { token: 'x'.repeat(43) }, as: rahul })).status, 404)
    // A landlord invitation cannot be taken by a buyer account, even with the invited email.
    const landlordInv = await t.call(`/api/rent/tenancies/${tenancy.id}/invites`, { method: 'POST', body: { party: 'landlord' } })
    const landlordToken = /#\/invite\/(.+)$/.exec(landlordInv.body.link)[1]
    assert.equal((await t.call('/api/invites/accept', { method: 'POST', body: { token: landlordToken }, as: buyerNamedAsLandlord })).status, 403)

    assert.equal((await t.call('/api/invites/preview', { method: 'POST', body: { token }, as: rahul })).body.propertyLabel, 'Flat 4B')
    assert.equal((await t.call('/api/invites/accept', { method: 'POST', body: { token }, as: rahul })).status, 200)
    assert.equal((await t.call('/api/invites/accept', { method: 'POST', body: { token }, as: rahul })).status, 409, 'single use')
    const mine = (await t.call('/api/me/tenancies', { as: rahul })).body.tenancies
    assert.equal(mine.length, 1)
    assert.equal(mine[0].dues[0].id, dues[0].id)
    assert.equal((await t.call('/api/me/tenancies', { as: wrongEmail })).body.tenancies.length, 0)
    assert.equal((await t.call(`/api/me/rent/dues/${dues[0].id}/payments`, { method: 'POST', body: { amount: 28000, paidOn: todayIn('Asia/Kolkata'), note: 'I paid already' }, as: rahul })).status, 403, 'a tenant cannot mark rent paid')

    // A new invitation replaces the old one; changing the email on the tenancy removes the link and voids invitations.
    const again = /#\/invite\/(.+)$/.exec((await t.call(`/api/rent/tenancies/${tenancy.id}/invites`, { method: 'POST', body: { party: 'landlord' } })).body.link)[1]
    assert.equal((await t.call('/api/invites/preview', { method: 'POST', body: { token: landlordToken }, as: rahul })).body.state, 'revoked')
    await t.call(`/api/rent/tenancies/${tenancy.id}`, { method: 'PATCH', body: { tenancy: { tenant_email: 'new.tenant@example.com', landlord_email: 'other.landlord@example.com' } } })
    assert.equal((await t.call('/api/me/tenancies', { as: rahul })).body.tenancies.length, 0)
    assert.equal((await t.call('/api/invites/preview', { method: 'POST', body: { token: again }, as: rahul })).body.state, 'revoked')
    const detail = (await t.call(`/api/rent/tenancies/${tenancy.id}`)).body
    assert.equal(detail.parties.tenant.linked, false)
    assert.match(detail.events.map((e) => e.detail).join(' | '), /Invitation accepted by the tenant/)
  } finally { await t.close() }
})

test('verified email links a tenancy; landlords and tenants of different tenancies never see each other’s rent or payments', async () => {
  const { t, vs } = await setup()
  try {
    const landlordA = cookieOf(await register(t, { name: 'Sunita Rao', email: 'sunita@example.com', role: 'seller' }))
    const landlordB = cookieOf(await register(t, { name: 'Bina Owner', email: 'bina@example.com', role: 'seller' }))
    const tenantB = cookieOf(await register(t, { name: 'Tara Tenant', email: 'tara@example.com', role: 'buyer' }))
    const a = (await t.call('/api/rent/tenancies', { method: 'POST', body: { tenancy: TEN } })).body
    const b = (await t.call('/api/rent/tenancies', { method: 'POST', body: { tenancy: { ...TEN, tenant_name: 'Tara Tenant', tenant_email: 'tara@example.com', landlord_email: 'bina@example.com', property_label: 'Villa 9', rent_amount: 90000 } } })).body
    // Sunita verifies her email: tenancy A (which names her) is linked to her, B is not.
    await t.call('/api/me/verification/send', { method: 'POST', body: {}, as: landlordA })
    const v = await t.call('/api/session/verify-email', { method: 'POST', body: { token: linkToken(mails(vs).at(-1), 'verify-email') }, as: null })
    assert.equal(v.body.tenanciesLinked, 1)
    const seen = (await t.call('/api/me/tenancies', { as: landlordA })).body.tenancies
    assert.deepEqual(seen.map((x) => x.tenancy.propertyLabel), ['Flat 4B'])
    assert.doesNotMatch(JSON.stringify(seen), /Villa 9|90000|tara@/)
    // Bina has not verified and has no invitation: nothing.
    assert.equal((await t.call('/api/me/tenancies', { as: landlordB })).body.tenancies.length, 0)
    // Cross-access by id, both directions.
    assert.equal((await t.call(`/api/me/tenancies/${b.tenancy.id}`, { as: landlordA })).status, 404)
    assert.equal((await t.call(`/api/me/rent/dues/${b.dues[0].id}/payments`, { method: 'POST', body: { amount: 1000, paidOn: todayIn('Asia/Kolkata'), note: 'not my tenancy' }, as: landlordA })).status, 404)
    assert.equal((await t.call(`/api/me/tenancies/${a.tenancy.id}`, { as: tenantB })).status, 404)
    const paid = await t.call(`/api/me/rent/dues/${a.dues[0].id}/payments`, { method: 'POST', body: { amount: 28000, paidOn: todayIn('Asia/Kolkata'), note: 'UPI ref 8812' }, as: landlordA })
    assert.equal(paid.status, 200)
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM rent_payments').get().n, 1)
    // Another agent cannot reach either tenancy.
    const otherAgent = signedInUser(t.db, { name: 'Other Agent' })
    assert.equal((await t.call(`/api/rent/tenancies/${a.tenancy.id}`, { as: otherAgent })).status, 404)
    assert.equal((await t.call(`/api/rent/tenancies/${a.tenancy.id}/invites`, { method: 'POST', body: { party: 'tenant' }, as: otherAgent })).status, 404)
    assert.equal((await t.call('/api/rent', { as: otherAgent })).body.tenancies.length, 0)
  } finally { await t.close() }
})

test('migration 7 removes tenancy links that were made from an unverified email, and records why', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'ds-m7-'))
  try {
    const file = join(dir, 'x.db')
    const old = openDatabase(file, { upTo: 6 })
    const ts = new Date().toISOString()
    old.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('usr_a', 'a@example.com', 'Agent', 'x', 'agent', ?), ('usr_b', 'b@example.com', 'Buyer', 'x', 'buyer', ?)").run(ts, ts)
    old.prepare("INSERT INTO tenancies (user_id, property_label, tenant_name, tenant_email, tenant_user_id, rent_amount, due_day, lease_start, tracking_from, created_at, updated_at) VALUES ('usr_a', 'Flat', 'B', 'b@example.com', 'usr_b', 1000, 5, '2026-10-01', '2026-10-01', ?, ?)").run(ts, ts)
    old.close()
    const db = openDatabase(file)
    const t = db.prepare('SELECT tenant_user_id FROM tenancies').get()
    assert.equal(t.tenant_user_id, null)
    assert.match(db.prepare("SELECT detail FROM rent_events WHERE type = 'parties_unlinked'").get().detail, /unverified email/)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2, 'accounts are kept')
    db.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
