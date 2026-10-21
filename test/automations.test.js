import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, fakeVs, signedInUser, vsError } from './helpers.js'
import { markInterruptedRuns } from '../server/automations/store.js'

const LEAD = { full_name: 'Rahul Sharma', customer_type: 'buyer', email: 'rahul@example.com', phone: '9876543210', preferred_location: 'Baner, Pune', bedrooms: 2, budget_max: 5000000 }
const BANER = { title: '2 BHK in Baner', listing_type: 'sale', property_type: 'apartment', bedrooms: 2, price: 4800000, city: 'Pune', locality: 'Baner' }
const SCHED = { available: true, secret: 'cron-secret-for-tests' }

const cards = async (t, as) => Object.fromEntries((await t.call('/api/automations', { as })).body.automations.map((a) => [a.key, a]))
const put = (t, key, body, as) => t.call(`/api/automations/${key}`, { method: 'PUT', body, as })
async function gmailFor(t, user = t.user) {
  const authId = t.vs.connectGmail(user.id)
  return (await t.call('/api/integrations/connections', { method: 'POST', body: { serviceId: 'rowo0bqrhj5g', authId }, as: user })).body.connection
}
async function slackFor(t, user = t.user) {
  const authId = t.vs.connectSlack(user.id)
  return (await t.call('/api/integrations/connections', { method: 'POST', body: { serviceId: 'rowbu58rc', authId }, as: user })).body.connection
}
const addLead = async (t, lead = LEAD, as) => (await t.call('/api/leads', { method: 'POST', body: { lead }, as })).body.lead
const runsOf = async (t, key) => (await t.call(`/api/automations/${key}/runs`)).body.runs

test('seven cards; nothing is Enabled unless its setup is complete; unbuilt ones say why and cannot be switched on', async () => {
  const t = await startApp({ vs: fakeVs() })
  try {
    const c = await cards(t)
    assert.deepEqual(Object.keys(c), ['new_lead_alert', 'buyer_matching', 'property_recommendations', 'followup_reminders', 'viewing_scheduler', 'viewing_feedback', 'rent_reminders'])
    assert.equal(c.buyer_matching.status, 'enabled', 'matching needs no integration and is on by default')
    for (const key of ['new_lead_alert', 'property_recommendations', 'followup_reminders']) assert.equal(c[key].status, 'needs_setup', key)
    for (const key of ['viewing_scheduler', 'viewing_feedback', 'rent_reminders']) {
      assert.equal(c[key].status, 'needs_setup')
      assert.equal(c[key].available, false)
      assert.match(c[key].problems[0], /Not built yet/)
      assert.equal((await put(t, key, { enabled: true })).status, 409)
    }
    assert.equal(c.new_lead_alert.lastRun, null, 'no fake run history')
  } finally { await t.close() }
})

test('New Lead Alert cannot be enabled without a real connection and recipient', async () => {
  const t = await startApp({ vs: fakeVs() })
  try {
    const none = await put(t, 'new_lead_alert', { enabled: true, config: { channel: 'gmail' } })
    assert.equal(none.status, 409)
    assert.equal(none.body.error.code, 'needs_setup')
    assert.ok(none.body.error.details.problems.length >= 2)
    const gmail = await gmailFor(t)
    assert.equal((await put(t, 'new_lead_alert', { enabled: true, config: { channel: 'gmail', connectionId: gmail.id, emailTo: 'not-an-email' } })).status, 409)
    const ok = await put(t, 'new_lead_alert', { enabled: true, config: { channel: 'gmail', connectionId: gmail.id, emailTo: 'team@agency.in, me@agency.in' } })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.automation.status, 'enabled')
    assert.equal(ok.body.automation.config.emailTo, 'team@agency.in, me@agency.in')

    const off = await put(t, 'new_lead_alert', { enabled: false })
    assert.equal(off.body.automation.status, 'disabled', 'switched off, setup kept')
  } finally { await t.close() }
})

test('settings and connections are per broker: another broker cannot use mine', async () => {
  const t = await startApp({ vs: fakeVs() })
  try {
    const gmail = await gmailFor(t)
    await put(t, 'new_lead_alert', { enabled: true, config: { channel: 'gmail', connectionId: gmail.id, emailTo: 'me@agency.in' } })
    const other = signedInUser(t.db, { name: 'Other Broker' })
    const theirs = await put(t, 'new_lead_alert', { enabled: true, config: { channel: 'gmail', connectionId: gmail.id, emailTo: 'x@agency.in' } }, other)
    assert.equal(theirs.status, 409)
    assert.match(theirs.body.error.details.problems.join(' '), /not connected to your DealSaathi account/)
    assert.equal((await cards(t, other)).new_lead_alert.status, 'needs_setup')
    assert.equal((await cards(t)).new_lead_alert.status, 'enabled')
  } finally { await t.close() }
})

test('a saved lead triggers one Gmail alert with only the facts on record, and the run is recorded', async () => {
  const t = await startApp({ vs: fakeVs() })
  try {
    const gmail = await gmailFor(t)
    await put(t, 'new_lead_alert', { enabled: true, config: { channel: 'gmail', connectionId: gmail.id, emailTo: 'team@agency.in' } })
    const lead = await addLead(t, { full_name: 'Neha Kulkarni', customer_type: 'tenant', phone: '9000000001' })
    await t.idle()
    const run = t.vs.calls.filter((c) => c.name === 'runAction')
    assert.equal(run.length, 1)
    const input = run[0].args[2]
    assert.equal(input.to, 'team@agency.in')
    assert.equal(input.subject, 'New lead: Neha Kulkarni (Tenant)')
    assert.match(input.messageBody, /Phone: 9000000001/)
    assert.match(input.messageBody, /Email: not given/)
    assert.match(input.messageBody, /Budget: not given/)
    assert.equal(input.fromName, 'Asha Broker')
    const [r] = await runsOf(t, 'new_lead_alert')
    assert.equal(r.status, 'succeeded')
    assert.match(r.summary, /message id msg_123/)
    assert.equal(r.subjectId, String(lead.id))

    t.engine.onLeadCreated(lead, t.user, 'form')
    await t.idle()
    assert.equal(t.vs.calls.filter((c) => c.name === 'runAction').length, 1, 'the same lead never alerts twice')
  } finally { await t.close() }
})

test('Slack alert posts to the channel picked from the broker’s own workspace', async () => {
  const t = await startApp({ vs: fakeVs() })
  try {
    const slack = await slackFor(t)
    const channels = await t.call(`/api/automations/slack-channels?connectionId=${slack.id}`)
    assert.deepEqual(channels.body.options.map((o) => o.value), ['C0LEADS', 'C0TEAM'])
    assert.equal((await put(t, 'new_lead_alert', { enabled: true, config: { channel: 'slack', connectionId: slack.id, slackChannelId: 'C0NOTMINE' } })).status, 409, 'a channel id not in the list is refused')
    const ok = await put(t, 'new_lead_alert', { enabled: true, config: { channel: 'slack', connectionId: slack.id, slackChannelId: 'C0LEADS', slackChannelLabel: 'spoofed' } })
    assert.equal(ok.body.automation.config.slackChannelLabel, '#leads', 'label read from Slack, not the browser')
    await addLead(t)
    await t.idle()
    const run = t.vs.calls.find((c) => c.name === 'runAction')
    assert.equal(run.args[1], 'rowslackv107')
    assert.deepEqual(run.args[2].destination, { messageto: 'channel', channel_id: ['C0LEADS'] })
    assert.match(run.args[2].markdown_content, /^\*New lead: Rahul Sharma \(Buyer\)\*/)
    assert.deepEqual(Object.keys(run.args[2]).sort(), ['destination', 'markdown_content'], 'nothing else is sent')
    assert.match((await runsOf(t, 'new_lead_alert'))[0].summary, /#leads/)
  } finally { await t.close() }
})

test('a refused alert is recorded as failed and can be retried; an unknown one cannot', async () => {
  const t = await startApp({ vs: fakeVs() })
  try {
    const gmail = await gmailFor(t)
    await put(t, 'new_lead_alert', { enabled: true, config: { channel: 'gmail', connectionId: gmail.id, emailTo: 'team@agency.in' } })
    t.vs.fail.runAction = vsError('Quota exceeded', 429)
    await addLead(t)
    await t.idle()
    const [failed] = await runsOf(t, 'new_lead_alert')
    assert.equal(failed.status, 'failed')
    assert.match(failed.error, /Quota exceeded/)
    assert.equal(failed.retryable, true)
    const retried = await t.call(`/api/automations/runs/${failed.id}/retry`, { method: 'POST', body: {} })
    assert.equal(retried.body.run.status, 'succeeded')

    t.vs.fail.runAction = vsError('aborted', null)
    await addLead(t, { ...LEAD, full_name: 'Another Lead', email: 'a@example.com', phone: '9000000009' })
    await t.idle()
    const [unknown] = await runsOf(t, 'new_lead_alert')
    assert.equal(unknown.status, 'unknown')
    assert.equal((await t.call(`/api/automations/runs/${unknown.id}/retry`, { method: 'POST', body: {} })).status, 409)
    const other = signedInUser(t.db, { name: 'Other' })
    assert.equal((await t.call(`/api/automations/runs/${failed.id}/retry`, { method: 'POST', body: {}, as: other })).status, 404)
  } finally { await t.close() }
})

test('a connection revoked after enabling: the card says Needs setup and the alert fails without sending', async () => {
  const t = await startApp({ vs: fakeVs() })
  try {
    const gmail = await gmailFor(t)
    await put(t, 'new_lead_alert', { enabled: true, config: { channel: 'gmail', connectionId: gmail.id, emailTo: 'team@agency.in' } })
    t.vs.state.connections[t.user.id] = []
    assert.equal((await cards(t)).new_lead_alert.status, 'needs_setup')
    await addLead(t)
    await t.idle()
    const [r] = await runsOf(t, 'new_lead_alert')
    assert.equal(r.status, 'failed')
    assert.match(r.error, /no longer exists/)
    assert.ok(!t.vs.calls.some((c) => c.name === 'runAction'))
  } finally { await t.close() }
})

test('Buyer Matching can be switched off; each save is recorded', async () => {
  const t = await startApp({ vs: fakeVs() })
  try {
    await addLead(t)
    const on = (await t.call('/api/properties', { method: 'POST', body: { property: BANER } })).body
    assert.equal(on.matching.matched, 1)
    await put(t, 'buyer_matching', { enabled: false })
    const off = (await t.call('/api/properties', { method: 'POST', body: { property: { ...BANER, title: 'Another Baner flat' } } })).body
    assert.equal(off.matching, null)
    assert.equal((await t.call(`/api/properties/${off.property.id}`)).body.matches.length, 0)
    const runs = await runsOf(t, 'buyer_matching')
    assert.deepEqual(runs.map((r) => r.status), ['skipped', 'succeeded'])
    assert.match(runs[1].summary, /1 matching buyer/)
  } finally { await t.close() }
})

test('Property Recommendations: off → refused; on → real, matching, non-sample listings only, approved, sent, recorded', async () => {
  const t = await startApp({ vs: fakeVs() })
  try {
    const gmail = await gmailFor(t)
    const lead = await addLead(t)
    const real = (await t.call('/api/properties', { method: 'POST', body: { property: BANER } })).body.property
    const far = (await t.call('/api/properties', { method: 'POST', body: { property: { ...BANER, title: 'Mumbai flat', city: 'Mumbai', locality: 'Andheri' } } })).body.property
    const samples = (await t.call('/api/properties/samples', { method: 'POST', body: {} })).body.properties
    const draft = (await t.call(`/api/leads/${lead.id}/recommendations/draft`, { method: 'POST', body: { propertyIds: [real.id] } })).body
    assert.match(draft.body, /2 BHK in Baner\n {3}2 BHK apartment · Baner, Pune · ₹48 L/)

    const off = await t.call(`/api/leads/${lead.id}/followups`, { method: 'POST', body: { kind: 'recommendation', propertyIds: [real.id], connectionId: gmail.id, subject: draft.subject, body: draft.body } })
    assert.equal(off.status, 409)
    assert.equal(off.body.error.code, 'automation_off')

    await put(t, 'property_recommendations', { enabled: true, config: { connectionId: gmail.id } })
    const prep = (body) => t.call(`/api/leads/${lead.id}/followups`, { method: 'POST', body: { kind: 'recommendation', connectionId: gmail.id, subject: draft.subject, body: draft.body, ...body } })
    assert.match((await prep({ propertyIds: [far.id] })).body.error.details.fields.properties, /does not match/)
    assert.match((await prep({ propertyIds: [samples[0].id] })).body.error.details.fields.properties, /sample listing/)
    assert.equal((await prep({ propertyIds: [] })).status, 400)

    const ok = await prep({ propertyIds: [real.id] })
    assert.equal(ok.status, 201)
    assert.equal(ok.body.followup.kind, 'recommendation')
    assert.ok(!t.vs.calls.some((c) => c.name === 'runAction'), 'nothing is sent before approval')
    const sent = await t.call(`/api/followups/${ok.body.followup.id}/send`, { method: 'POST', body: {} })
    assert.equal(sent.body.followup.status, 'sent')
    const [run] = await runsOf(t, 'property_recommendations')
    assert.equal(run.status, 'succeeded')
    const act = (await t.call(`/api/leads/${lead.id}`)).body.activities[0]
    assert.equal(act.type, 'recommendation_sent')
    assert.deepEqual(act.details.propertyIds, [real.id])
  } finally { await t.close() }
})

test('a failed recommendation is never shown as sent', async () => {
  const t = await startApp({ vs: fakeVs() })
  try {
    const gmail = await gmailFor(t)
    const lead = await addLead(t)
    const real = (await t.call('/api/properties', { method: 'POST', body: { property: BANER } })).body.property
    await put(t, 'property_recommendations', { enabled: true, config: { connectionId: gmail.id } })
    const prep = await t.call(`/api/leads/${lead.id}/followups`, { method: 'POST', body: { kind: 'recommendation', propertyIds: [real.id], connectionId: gmail.id, subject: 'Hi', body: 'Listings' } })
    t.vs.fail.runAction = vsError('Recipient address rejected', 400)
    const res = await t.call(`/api/followups/${prep.body.followup.id}/send`, { method: 'POST', body: {} })
    assert.equal(res.body.followup.status, 'failed')
    assert.equal((await runsOf(t, 'property_recommendations'))[0].status, 'failed')
  } finally { await t.close() }
})

test('Follow-Up Reminders need the scheduler to be switched on; “Run check now” works without it', async () => {
  const t = await startApp({ vs: fakeVs() })
  try {
    const res = await put(t, 'followup_reminders', { enabled: true, config: { inactiveDays: 3, notify: 'none' } })
    assert.equal(res.status, 409)
    assert.match(res.body.error.details.problems.join(' '), /scheduler runs only on the hosted DealSaathi/)
    await put(t, 'followup_reminders', { enabled: false, config: { inactiveDays: 3, notify: 'none' } })
    const lead = await addLead(t)
    t.db.prepare("UPDATE lead_activities SET created_at = '2020-01-01T00:00:00.000Z'").run()
    t.db.prepare("UPDATE leads SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(lead.id)
    const now = await t.call('/api/automations/followup_reminders/run', { method: 'POST', body: {} })
    assert.equal(now.body.result.created, 1)
  } finally { await t.close() }
})

test('the scheduler route: secret required; reminders for due and quiet leads, never repeated; one notification', async () => {
  const t = await startApp({ vs: fakeVs(), scheduler: SCHED })
  try {
    const gmail = await gmailFor(t)
    const ok = await put(t, 'followup_reminders', { enabled: true, config: { inactiveDays: 5, notify: 'gmail', connectionId: gmail.id, emailTo: 'me@agency.in' } })
    assert.equal(ok.body.automation.status, 'enabled')

    const quiet = await addLead(t)
    const due = await addLead(t, { ...LEAD, full_name: 'Due Today', email: 'due@example.com', phone: '9000000002', follow_up_on: '2020-01-01' })
    const fresh = await addLead(t, { ...LEAD, full_name: 'Fresh Lead', email: 'fresh@example.com', phone: '9000000003' })
    await addLead(t, { ...LEAD, full_name: 'Seller', email: 's@example.com', phone: '9000000004', customer_type: 'seller' })
    t.db.prepare("UPDATE lead_activities SET created_at = '2020-01-01T00:00:00.000Z' WHERE lead_id IN (?, ?)").run(quiet.id, due.id)
    t.db.prepare("UPDATE leads SET created_at = '2020-01-01T00:00:00.000Z' WHERE id IN (?, ?)").run(quiet.id, due.id)

    const cron = (auth) => fetch(`${t.base}/tasks/automations`, { headers: auth ? { authorization: auth } : {} })
    assert.equal((await cron()).status, 401)
    assert.equal((await cron('Bearer wrong')).status, 401)
    const first = await cron(`Bearer ${SCHED.secret}`)
    assert.equal(first.status, 200)
    assert.match(await first.text(), /3 new reminder\(s\), 1 notification\(s\) sent/)
    const reminders = (await t.call('/api/reminders')).body.reminders
    assert.deepEqual(reminders.map((r) => `${r.leadName}:${r.reason}`).sort(), ['Due Today:follow_up_date', 'Due Today:no_activity', 'Rahul Sharma:no_activity'])
    assert.ok(!reminders.some((r) => r.leadId === fresh.id))
    const mail = t.vs.calls.filter((c) => c.name === 'runAction')
    assert.equal(mail.length, 1, 'one email for the batch')
    assert.equal(mail[0].args[2].subject, '3 leads to follow up')

    const second = await cron(`Bearer ${SCHED.secret}`)
    assert.match(await second.text(), /0 new reminder/)
    assert.equal(t.vs.calls.filter((c) => c.name === 'runAction').length, 1, 'nothing is sent again')

    const id = reminders[0].id
    assert.equal((await t.call(`/api/reminders/${id}`, { method: 'POST', body: { status: 'done' } })).body.reminder.status, 'done')
    const other = signedInUser(t.db, { name: 'Other' })
    assert.equal((await t.call('/api/reminders', { as: other })).body.reminders.length, 0)
    assert.equal((await t.call(`/api/reminders/${id}`, { method: 'POST', body: { status: 'dismissed' }, as: other })).status, 404)
    assert.equal((await cards(t)).followup_reminders.lastCheck.trigger, 'Scheduled check')
  } finally { await t.close() }
})

test('a notification that fails still keeps the reminders, and the run says what failed', async () => {
  const t = await startApp({ vs: fakeVs(), scheduler: SCHED })
  try {
    const gmail = await gmailFor(t)
    await put(t, 'followup_reminders', { enabled: true, config: { inactiveDays: 1, notify: 'gmail', connectionId: gmail.id, emailTo: 'me@agency.in' } })
    const lead = await addLead(t)
    t.db.prepare("UPDATE lead_activities SET created_at = '2020-01-01T00:00:00.000Z'").run()
    t.db.prepare("UPDATE leads SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(lead.id)
    t.vs.fail.runAction = vsError('Gmail rate limit', 429)
    await fetch(`${t.base}/tasks/automations`, { headers: { authorization: `Bearer ${SCHED.secret}` } })
    assert.equal((await t.call('/api/reminders')).body.reminders.length, 1)
    const [run] = await runsOf(t, 'followup_reminders')
    assert.equal(run.status, 'failed')
    assert.match(run.summary, /notification was not sent/)
  } finally { await t.close() }
})

test('runs cut off by a restart become unknown, never succeeded', async () => {
  const t = await startApp({ vs: fakeVs() })
  try {
    t.db.prepare("INSERT INTO automation_runs (id, user_id, key, trigger, status, started_at) VALUES ('r1', ?, 'new_lead_alert', 'Lead saved', 'running', '2020-01-01T00:00:00.000Z')").run(t.user.id)
    assert.equal(markInterruptedRuns(t.db), 1)
    assert.equal(t.db.prepare("SELECT status FROM automation_runs WHERE id = 'r1'").get().status, 'unknown')
  } finally { await t.close() }
})
