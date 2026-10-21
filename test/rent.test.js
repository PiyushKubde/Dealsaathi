import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, fakeVs, signedInUser, vsError, V } from './helpers.js'
import { addDays, todayIn } from '../server/time.js'
import { runRentChecks } from '../server/rent/service.js'
import { getSetting } from '../server/automations/store.js'

const today = todayIn('Asia/Kolkata')
const TEN = { tenant_name: 'Priya Nair', tenant_email: 'priya@example.com', tenant_phone: '9000000010', property_label: 'Flat 4B, Koramangala', rent_amount: 28000, due_day: 5, lease_start: '2025-01-01' }

async function setup({ razorpay = false } = {}) {
  const vs = fakeVs()
  const t = await startApp({ vs })
  const conn = async (slug) => (await t.call('/api/integrations/connections', { method: 'POST', body: { serviceId: await vs.serviceIdFor(slug), authId: vs.connectApp(t.user.id, slug) } })).body.connection
  const gmail = await conn('gmail')
  const rzp = razorpay ? await conn('razorpay') : null
  // Settings saved switched off (the scheduler is not available in tests); "Run check now" runs them.
  const cfg = { gmailConnectionId: gmail.id, beforeDays: 3, onDue: true, afterDays: '3,7', ...(rzp ? { razorpayConnectionId: rzp.id } : {}) }
  await t.call('/api/automations/rent_reminders', { method: 'PUT', body: { enabled: false, config: cfg } })
  return { t, vs, gmail, rzp }
}
const addTenancy = async (t, body = TEN) => t.call('/api/rent/tenancies', { method: 'POST', body: { tenancy: body } })
const runNow = (t) => t.call('/api/automations/rent_reminders/run', { method: 'POST', body: {} })
const emails = (vs) => vs.calls.filter((c) => c.name === 'runAction' && c.args[1] === V.rowogelpy0h6)
/** Puts the current due at `days` from today (negative = overdue). */
function moveDue(t, tenancyId, days) {
  const due = t.db.prepare('SELECT * FROM rent_dues WHERE tenancy_id = ? ORDER BY due_date LIMIT 1').get(tenancyId)
  t.db.prepare('UPDATE rent_dues SET due_date = ? WHERE id = ?').run(addDays(today, days), due.id)
  t.db.prepare('DELETE FROM rent_dues WHERE tenancy_id = ? AND id != ?').run(tenancyId, due.id)
  return due.id
}

test('a tenancy is validated and creates this month’s obligation (no backlog), never twice', async () => {
  const { t } = await setup()
  try {
    const bad = await addTenancy(t, { tenant_name: '', rent_amount: 0, due_day: 31, lease_start: '2025-02-30', tenant_email: 'nope' })
    assert.equal(bad.status, 400)
    assert.deepEqual(Object.keys(bad.body.error.details.fields).sort(), ['due_day', 'lease_start', 'property_label', 'rent_amount', 'tenant_email', 'tenant_name'])
    const res = await addTenancy(t)
    assert.equal(res.status, 201)
    const { tenancy, dues } = res.body
    assert.equal(tenancy.tracking_from, `${today.slice(0, 7)}-01`, 'tracked from this month, not the 2025 lease start')
    assert.ok(dues.length >= 1 && dues.length <= 2)
    assert.ok(dues.every((d) => d.amount === 28000 && d.dueDate.endsWith('-05')))
    await runNow(t)
    await runNow(t)
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM rent_dues').get().n, dues.length, 'running again creates nothing new')
  } finally { await t.close() }
})

test('reminders: the latest stage that has arrived is sent once; earlier missed stages are not sent in a burst', async () => {
  const { t, vs } = await setup()
  try {
    const { tenancy } = (await addTenancy(t)).body
    const dueId = moveDue(t, tenancy.id, -8) // 8 days overdue: before_3, on_due, after_3 and after_7 have all arrived
    const res = await runNow(t)
    assert.equal(res.body.result.sent, 1)
    const sent = t.db.prepare('SELECT stage, status FROM rent_reminders WHERE due_id = ?').all(dueId).map((r) => ({ ...r }))
    assert.deepEqual(sent, [{ stage: 'after_7', status: 'sent' }])
    const mail = emails(vs)[0].args[2]
    assert.equal(mail.to, 'priya@example.com')
    assert.match(mail.subject, /overdue/)
    assert.match(mail.messageBody, /₹28,000/)
    assert.doesNotMatch(mail.messageBody, /pay securely/, 'no payment link without Razorpay')
    await runNow(t)
    assert.equal(emails(vs).length, 1, 'never twice for one stage')
    const [run] = (await t.call('/api/automations/rent_reminders/runs')).body.runs
    assert.equal(run.status, 'succeeded')
  } finally { await t.close() }
})

test('Razorpay: a link is created for what is owed; only Razorpay’s paid status marks the rent paid, once', async () => {
  const { t, vs } = await setup({ razorpay: true })
  try {
    const { tenancy } = (await addTenancy(t)).body
    const dueId = moveDue(t, tenancy.id, 0)
    await runNow(t)
    const create = vs.calls.find((c) => c.name === 'runAction' && c.args[1] === V.rowtl0joo241).args[2]
    assert.equal(create.amount, 2800000, 'paise')
    assert.equal(create.currency, 'INR')
    assert.equal(create.reference_id, `ds-rent-${dueId}-1`)
    assert.deepEqual(create.customer, { name: 'Priya Nair', email: 'priya@example.com', contact: '9000000010' })
    assert.equal(create.accept_partial, false)
    assert.match(emails(vs)[0].args[2].messageBody, /rzp\.io\/r\/ds-rent-/)
    let due = t.db.prepare('SELECT * FROM rent_dues WHERE id = ?').get(dueId)
    assert.equal(due.status, 'open', 'a created link is not a payment')

    await runNow(t)
    assert.equal(t.db.prepare('SELECT status FROM rent_dues WHERE id = ?').get(dueId).status, 'open', 'still unpaid while Razorpay says created')
    vs.state.paymentLinks[`ds-rent-${dueId}-1`].status = 'paid'
    vs.state.paymentLinks[`ds-rent-${dueId}-1`].amount_paid = 2800000
    const res = await runNow(t)
    assert.equal(res.body.result.verified, 1)
    due = t.db.prepare('SELECT * FROM rent_dues WHERE id = ?').get(dueId)
    assert.equal(due.status, 'paid')
    assert.equal(due.verification_source, 'razorpay')
    await runNow(t)
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM rent_payments WHERE due_id = ?').get(dueId).n, 1, 'one payment record, however often it is checked')
    t.db.prepare('UPDATE rent_dues SET due_date = ? WHERE id = ?').run(addDays(today, -7), dueId)
    const before = emails(vs).length
    await runNow(t)
    assert.equal(emails(vs).length, before, 'no reminders once paid')
  } finally { await t.close() }
})

test('a partial Razorpay payment is recorded as partial; reminders continue for the rest', async () => {
  const { t, vs } = await setup({ razorpay: true })
  try {
    const { tenancy } = (await addTenancy(t)).body
    const dueId = moveDue(t, tenancy.id, 0)
    await runNow(t)
    Object.assign(vs.state.paymentLinks[`ds-rent-${dueId}-1`], { status: 'partially_paid', amount_paid: 1000000 })
    t.db.prepare('UPDATE rent_dues SET due_date = ? WHERE id = ?').run(addDays(today, -3), dueId)
    await runNow(t)
    const due = t.db.prepare('SELECT * FROM rent_dues WHERE id = ?').get(dueId)
    assert.equal(due.status, 'partially_paid')
    assert.equal(due.amount_paid, 10000)
    assert.match(emails(vs).at(-1).args[2].messageBody, /₹18,000/, 'the reminder asks for what is left')
  } finally { await t.close() }
})

test('a manual payment needs a verification note, is audited, and cancels the open link', async () => {
  const { t, vs } = await setup({ razorpay: true })
  try {
    const { tenancy } = (await addTenancy(t)).body
    const dueId = moveDue(t, tenancy.id, 0)
    await runNow(t)
    const pay = (body) => t.call(`/api/rent/dues/${dueId}/payments`, { method: 'POST', body })
    const bad = await pay({ amount: 99999, paidOn: addDays(today, 1), note: '' })
    assert.deepEqual(Object.keys(bad.body.error.details.fields).sort(), ['amount', 'note', 'paidOn'])
    const ok = await pay({ amount: 28000, paidOn: today, note: 'HDFC statement, UTR 4471' })
    assert.equal(ok.status, 200)
    const due = ok.body.dues.find((d) => d.id === dueId)
    assert.equal(due.status, 'paid')
    assert.equal(due.verificationSource, 'manual')
    assert.match(ok.body.events.map((e) => e.detail).join(' | '), /recorded by the broker: HDFC statement, UTR 4471/)
    assert.ok(vs.calls.some((c) => c.name === 'runAction' && c.args[1] === V.rowyqfuoa1gu), 'the payment link is cancelled')
    assert.equal((await pay({ amount: 1, paidOn: today, note: 'again again' })).status, 409)
  } finally { await t.close() }
})

test('opt-out, no email, paused and ended tenancies get no reminders; an ended lease creates no new rent', async () => {
  const { t, vs } = await setup()
  try {
    const optOut = (await addTenancy(t, { ...TEN, tenant_name: 'Opted Out', reminders_opt_out: true })).body.tenancy
    const noMail = (await addTenancy(t, { ...TEN, tenant_name: 'No Mail', tenant_email: '' })).body.tenancy
    const paused = (await addTenancy(t, { ...TEN, tenant_name: 'Paused' })).body.tenancy
    for (const x of [optOut, noMail, paused]) moveDue(t, x.id, 0)
    await t.call(`/api/rent/tenancies/${paused.id}`, { method: 'PATCH', body: { tenancy: { status: 'paused' } } })
    const res = await runNow(t)
    assert.equal(res.body.result.sent, 0)
    assert.equal(emails(vs).length, 0)
    const skipped = t.db.prepare("SELECT detail FROM rent_reminders WHERE status = 'skipped'").all().map((r) => r.detail).sort()
    assert.deepEqual(skipped, ['No tenant email on the tenancy', 'Tenant opted out of reminders'])

    const ended = (await addTenancy(t, { ...TEN, tenant_name: 'Ended', lease_start: '2025-01-01', lease_end: addDays(today, 1) })).body.tenancy
    t.db.prepare('UPDATE tenancies SET lease_end = ? WHERE id = ?').run(addDays(today, -1), ended.id)
    await runNow(t)
    assert.equal(t.db.prepare('SELECT status FROM tenancies WHERE id = ?').get(ended.id).status, 'ended')
  } finally { await t.close() }
})

test('a refused reminder is recorded as failed with the reason; no answer is unknown; neither is marked sent', async () => {
  const { t, vs } = await setup()
  try {
    const a = (await addTenancy(t)).body.tenancy
    const dueId = moveDue(t, a.id, 0)
    vs.fail.runAction = vsError('Daily limit exceeded', 429)
    const res = await runNow(t)
    assert.equal(res.body.result.failed, 1)
    const r = t.db.prepare('SELECT status, detail FROM rent_reminders WHERE due_id = ?').get(dueId)
    assert.equal(r.status, 'failed')
    assert.match(r.detail, /Daily limit/)
    assert.equal((await t.call('/api/automations/rent_reminders/runs')).body.runs[0].status, 'failed')

    const b = (await addTenancy(t, { ...TEN, tenant_name: 'Second Tenant', tenant_email: 'second@example.com' })).body.tenancy
    const silentId = moveDue(t, b.id, 0)
    vs.fail.runAction = vsError('aborted', null)
    await runNow(t)
    const u = t.db.prepare('SELECT status FROM rent_reminders WHERE due_id = ?').get(silentId)
    assert.equal(u.status, 'unknown', 'no answer is not a send')
    const sends = emails(vs).length
    await runNow(t)
    assert.equal(emails(vs).length, sends, 'an unknown reminder is not sent again, which could reach the tenant twice')
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM rent_reminders WHERE status = 'sent'").get().n, 0)
  } finally { await t.close() }
})

test('a Gmail connection removed on viaSocket: the reminder fails with the reason and nothing is sent', async () => {
  const { t, vs } = await setup()
  try {
    const a = (await addTenancy(t)).body.tenancy
    const dueId = moveDue(t, a.id, 0)
    vs.state.connections[t.user.id] = []
    const now = await runNow(t)
    assert.equal(now.status, 409, '“Run check now” refuses until Gmail is connected again')
    assert.match(now.body.error.details.problems.join(' '), /Gmail/)
    // The 15-minute scheduler, for a broker who switched it on before the connection went away.
    await runRentChecks(t.db, vs, { trigger: 'Scheduled (Embarko)', onlyUser: t.user, onlyConfig: getSetting(t.db, t.user.id, 'rent_reminders').config, force: true })
    assert.equal(emails(vs).length, 0)
    const r = t.db.prepare('SELECT status, detail FROM rent_reminders WHERE due_id = ?').get(dueId)
    assert.equal(r.status, 'failed')
    assert.match(r.detail, /Gmail/)
    const auto = (await t.call('/api/automations')).body.automations.find((x) => x.key === 'rent_reminders')
    assert.equal(auto.status, 'needs_setup')
  } finally { await t.close() }
})

test('rent is private to the broker who manages it', async () => {
  const { t } = await setup()
  try {
    const { tenancy, dues } = (await addTenancy(t)).body
    const other = signedInUser(t.db, { name: 'Other' })
    assert.equal((await t.call(`/api/rent/tenancies/${tenancy.id}`, { as: other })).status, 404)
    assert.equal((await t.call(`/api/rent/dues/${dues[0].id}/payments`, { method: 'POST', body: { amount: 1, paidOn: today, note: 'stolen money' }, as: other })).status, 404)
    assert.equal((await t.call('/api/rent', { as: other })).body.tenancies.length, 0)
    const overview = (await t.call('/api/rent')).body
    assert.equal(overview.tenancies.length, 1)
  } finally { await t.close() }
})
