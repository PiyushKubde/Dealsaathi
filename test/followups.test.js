import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, fakeVs, fakeAi, signedInUser, vsError } from './helpers.js'
import { bodyToHtml, buildSendEmailInput, readGmailResult } from '../server/followups/service.js'

const LEAD = { full_name: 'Rahul Sharma', customer_type: 'buyer', email: 'rahul@example.com', phone: '9876543210', preferred_location: 'Pune' }
const DRAFT = { subject: 'Your 2 BHK search in Pune', body: 'Hi Rahul,\n\nA quick follow-up.\n\nBest,\nAsha' }

async function setup({ vs = fakeVs(), ai, lead = LEAD } = {}) {
  const t = await startApp({ vs, ai })
  const authId = vs.connectGmail(t.user.id)
  const connection = (await t.call('/api/integrations/connections', { method: 'POST', body: { serviceId: 'rowo0bqrhj5g', authId } })).body.connection
  const created = (await t.call('/api/leads', { method: 'POST', body: { lead } })).body.lead
  return { t, vs, authId, connection, lead: created }
}
const prepare = (t, leadId, body) => t.call(`/api/leads/${leadId}/followups`, { method: 'POST', body })
const send = (t, id, as) => t.call(`/api/followups/${id}/send`, { method: 'POST', body: {}, as })

test('setup shows the lead’s saved address and only my Gmail connections', async () => {
  const { t, lead, connection } = await setup()
  try {
    const other = signedInUser(t.db, { name: 'Other' })
    const mine = (await t.call(`/api/leads/${lead.id}/followups`)).body
    assert.equal(mine.recipient, 'rahul@example.com')
    assert.deepEqual(mine.connections.map((c) => c.id), [connection.id])
    assert.deepEqual((await t.call(`/api/leads/${lead.id}/followups`, { as: other })).body.connections, [])
  } finally { await t.close() }
})

test('prepare → review → confirm: Send Email runs once with the documented inputData, then is recorded', async () => {
  const { t, vs, lead, connection, authId } = await setup()
  try {
    const prep = await prepare(t, lead.id, { connectionId: connection.id, ...DRAFT, from: 'me@example.com' })
    assert.equal(prep.status, 201)
    assert.equal(prep.body.followup.status, 'awaiting_confirmation')
    assert.equal(prep.body.followup.recipient, 'rahul@example.com')
    assert.ok(!vs.calls.some((c) => c.name === 'runAction'), 'nothing is sent before confirmation')
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM lead_activities WHERE type LIKE 'followup%'").get().n, 0)

    const res = await send(t, prep.body.followup.id)
    assert.equal(res.status, 200)
    assert.equal(res.body.followup.status, 'sent')
    assert.deepEqual(res.body.followup.result, { messageId: 'msg_123', threadId: 'thr_1', labelIds: ['SENT'] })

    const enable = vs.calls.find((c) => c.name === 'enable')
    assert.deepEqual(enable.args, [t.user.id, 'rowo0bqrhj5g', authId], 'enabled with this user’s own connection')
    assert.deepEqual(vs.calls.find((c) => c.name === 'versionIdFor').args, ['rowo0bqrhj5g', 'rowogelpy0h6', 'V55'])
    const run = vs.calls.find((c) => c.name === 'runAction')
    assert.equal(run.args[0], 'scriSECRET1')
    assert.equal(run.args[1], 'rowwj0sfmhub')
    assert.deepEqual(run.args[2], {
      to: 'rahul@example.com',
      subject: 'Your 2 BHK search in Pune',
      messageBody: '<p>Hi Rahul,</p><p>A quick follow-up.</p><p>Best,<br>Asha</p>',
      from: 'me@example.com',
      fromName: 'Asha Broker'
    })
    assert.doesNotMatch(res.text, /scriSECRET/, 'the script id stays on the server')

    const activity = (await t.call(`/api/leads/${lead.id}`)).body.activities[0]
    assert.equal(activity.type, 'followup_sent')
    assert.equal(activity.via, 'gmail')
    assert.equal(activity.user_name, 'Asha Broker')
    assert.equal(activity.details.messageId, 'msg_123')

    const again = await send(t, prep.body.followup.id)
    assert.equal(again.body.alreadySent, true)
    assert.equal(vs.calls.filter((c) => c.name === 'runAction').length, 1, 'a second click sends nothing')

    const second = await prepare(t, lead.id, { connectionId: connection.id, ...DRAFT })
    await send(t, second.body.followup.id)
    assert.equal(vs.calls.filter((c) => c.name === 'enable').length, 1, 'the app is enabled once and reused')
    assert.equal(vs.calls.filter((c) => c.name === 'runAction').at(-1).args[2].from, undefined, 'no From chosen: left out')
  } finally { await t.close() }
})

test('two confirm clicks at the same moment send one email', async () => {
  const { t, vs, lead, connection } = await setup()
  try {
    const prep = await prepare(t, lead.id, { connectionId: connection.id, ...DRAFT })
    const results = await Promise.all([send(t, prep.body.followup.id), send(t, prep.body.followup.id), send(t, prep.body.followup.id)])
    const sent = results.filter((r) => r.status === 200 && r.body.followup.status === 'sent' && !r.body.alreadySent)
    assert.equal(sent.length, 1, 'exactly one click sends')
    for (const r of results.filter((x) => !sent.includes(x))) {
      assert.ok(r.status === 409 || r.body.alreadySent === true, 'the others are told it is in progress or already sent')
    }
    assert.equal(vs.calls.filter((c) => c.name === 'runAction').length, 1)
  } finally { await t.close() }
})

test('input is validated before anything is prepared', async () => {
  const { t, vs, lead, connection } = await setup()
  try {
    const empty = await prepare(t, lead.id, { connectionId: connection.id, subject: '', body: '' })
    assert.equal(empty.status, 400)
    assert.deepEqual(Object.keys(empty.body.error.details.fields).sort(), ['body', 'subject'])
    assert.equal((await prepare(t, lead.id, { connectionId: connection.id, subject: 'Hi\r\nBcc: x@evil.com', body: 'x' })).status, 400, 'no header injection through the subject')
    assert.equal((await prepare(t, lead.id, { connectionId: connection.id, ...DRAFT, body: 'x'.repeat(10001) })).status, 400)
    const badFrom = await prepare(t, lead.id, { connectionId: connection.id, ...DRAFT, from: 'ceo@bank.com' })
    assert.equal(badFrom.status, 400)
    assert.ok(badFrom.body.error.details.fields.from)
    assert.equal((await prepare(t, lead.id, { connectionId: 9999, ...DRAFT })).status, 404)
    assert.equal((await prepare(t, 9999, { connectionId: connection.id, ...DRAFT })).status, 404)

    const noEmail = (await t.call('/api/leads', { method: 'POST', body: { lead: { full_name: 'Phone Only', customer_type: 'seller', phone: '9000000001' } } })).body.lead
    const res = await prepare(t, noEmail.id, { connectionId: connection.id, ...DRAFT })
    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'lead_has_no_email')
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM followups').get().n, 0)
    assert.ok(!vs.calls.some((c) => c.name === 'runAction'))
  } finally { await t.close() }
})

test('the recipient is always the lead’s saved email, whatever the browser sends', async () => {
  const { t, vs, lead, connection } = await setup()
  try {
    const prep = await prepare(t, lead.id, { connectionId: connection.id, ...DRAFT, to: 'someone@else.com', recipient: 'x@evil.com' })
    assert.equal(prep.body.followup.recipient, 'rahul@example.com')
    await send(t, prep.body.followup.id)
    assert.equal(vs.calls.find((c) => c.name === 'runAction').args[2].to, 'rahul@example.com')
  } finally { await t.close() }
})

test('another user cannot use my Gmail connection or send my follow-up', async () => {
  const { t, vs, lead, connection } = await setup()
  try {
    const other = signedInUser(t.db, { name: 'Other' })
    assert.equal((await t.call(`/api/leads/${lead.id}/followups`, { method: 'POST', body: { connectionId: connection.id, ...DRAFT }, as: other })).status, 404)
    const prep = await prepare(t, lead.id, { connectionId: connection.id, ...DRAFT })
    assert.equal((await send(t, prep.body.followup.id, other)).status, 404)
    assert.ok(!vs.calls.some((c) => c.name === 'runAction'))
  } finally { await t.close() }
})

test('an expired or revoked Gmail connection blocks sending with a clear message', async () => {
  const { t, vs, lead, connection } = await setup()
  try {
    vs.state.connections[t.user.id][0].isExpired = true
    const expired = await prepare(t, lead.id, { connectionId: connection.id, ...DRAFT })
    assert.equal(expired.status, 409)
    assert.equal(expired.body.error.code, 'connection_expired')
    vs.state.connections[t.user.id] = []
    assert.equal((await prepare(t, lead.id, { connectionId: connection.id, ...DRAFT })).body.error.code, 'connection_missing')
  } finally { await t.close() }
})

test('Gmail refusing the email is recorded as failed, with its reason, and is never marked sent', async () => {
  const { t, vs, lead, connection } = await setup()
  try {
    const prep = await prepare(t, lead.id, { connectionId: connection.id, ...DRAFT })
    vs.fail.runAction = vsError('Invalid To header', 400)
    const res = await send(t, prep.body.followup.id)
    assert.equal(res.status, 200)
    assert.equal(res.body.followup.status, 'failed')
    assert.match(res.body.followup.error, /Invalid To header/)
    assert.equal(res.body.followup.sentAt, null)
    const activity = (await t.call(`/api/leads/${lead.id}`)).body.activities[0]
    assert.equal(activity.type, 'followup_failed')
    assert.match(activity.summary, /failed: Invalid To header/)
    assert.equal((await send(t, prep.body.followup.id)).status, 409, 'a failed one is not resent: prepare a new one')
  } finally { await t.close() }
})

test('no answer from viaSocket is recorded as unknown, not sent and not failed', async () => {
  const { t, vs, lead, connection } = await setup()
  try {
    const prep = await prepare(t, lead.id, { connectionId: connection.id, ...DRAFT })
    vs.fail.runAction = vsError('The operation was aborted', null)
    const res = await send(t, prep.body.followup.id)
    assert.equal(res.body.followup.status, 'unknown')
    assert.match(res.body.followup.error, /check the Gmail Sent folder/)
    assert.equal((await t.call(`/api/leads/${lead.id}`)).body.activities[0].type, 'followup_unknown')
  } finally { await t.close() }
})

test('an answer without a Gmail message id is unknown; an explicit failure body is failed', async () => {
  const { t, vs, lead, connection } = await setup()
  try {
    vs.state.runResult = { ok: true }
    const a = await send(t, (await prepare(t, lead.id, { connectionId: connection.id, ...DRAFT })).body.followup.id)
    assert.equal(a.body.followup.status, 'unknown')
    vs.state.runResult = { success: false, message: 'Daily sending quota exceeded' }
    const b = await send(t, (await prepare(t, lead.id, { connectionId: connection.id, ...DRAFT })).body.followup.id)
    assert.equal(b.body.followup.status, 'failed')
    assert.match(b.body.followup.error, /quota/)
  } finally { await t.close() }
})

test('a failure before the action runs puts the follow-up back for review: nothing was sent', async () => {
  const { t, vs, lead, connection } = await setup()
  try {
    const prep = await prepare(t, lead.id, { connectionId: connection.id, ...DRAFT })
    vs.fail.enable = vsError('enable failed', 500)
    const res = await send(t, prep.body.followup.id)
    assert.equal(res.status, 502)
    assert.equal(t.db.prepare('SELECT status FROM followups WHERE id = ?').get(prep.body.followup.id).status, 'awaiting_confirmation')
    assert.ok(!vs.calls.some((c) => c.name === 'runAction'))
    assert.equal((await send(t, prep.body.followup.id)).body.followup.status, 'sent', 'retry works once viaSocket is back')
  } finally { await t.close() }
})

test('a paused Gmail app is reported, not silently resumed', async () => {
  const { t, vs, lead, connection } = await setup()
  try {
    await send(t, (await prepare(t, lead.id, { connectionId: connection.id, ...DRAFT })).body.followup.id)
    vs.state.flows[t.user.id][0].status = 'paused'
    const prep = await prepare(t, lead.id, { connectionId: connection.id, ...DRAFT })
    const res = await send(t, prep.body.followup.id)
    assert.equal(res.status, 409)
    assert.equal(res.body.error.code, 'sending_paused')
    assert.ok(!vs.calls.some((c) => c.name === 'setFlowStatus'))
  } finally { await t.close() }
})

test('cancel before sending; a cancelled follow-up cannot be sent', async () => {
  const { t, vs, lead, connection } = await setup()
  try {
    const prep = await prepare(t, lead.id, { connectionId: connection.id, ...DRAFT })
    assert.equal((await t.call(`/api/followups/${prep.body.followup.id}/cancel`, { method: 'POST', body: {} })).body.followup.status, 'cancelled')
    assert.equal((await send(t, prep.body.followup.id)).status, 409)
    assert.ok(!vs.calls.some((c) => c.name === 'runAction'))
  } finally { await t.close() }
})

test('AI drafts from the lead record only, per user, and nothing is stored', async () => {
  const ai = fakeAi({ subject: 'Following up on Pune', body: 'Hi Rahul,\nShall we talk this week?\nAsha' })
  const { t, lead } = await setup({ ai })
  try {
    const res = await t.call(`/api/leads/${lead.id}/followups/draft`, { method: 'POST', body: {} })
    assert.equal(res.status, 200)
    assert.equal(res.body.subject, 'Following up on Pune')
    assert.equal(ai.users[0], t.user.id)
    assert.match(ai.calls[0].message, /"name":"Rahul Sharma"/)
    assert.doesNotMatch(ai.calls[0].message, /rahul@example\.com|9876543210/, 'contact details are not sent to the AI')
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM followups').get().n, 0)
  } finally { await t.close() }
})

test('helpers: HTML escaping, input building, and reading Gmail answers', () => {
  assert.equal(bodyToHtml('<b>hi</b> & "you"'), '<p>&lt;b&gt;hi&lt;/b&gt; &amp; &quot;you&quot;</p>')
  assert.deepEqual(Object.keys(buildSendEmailInput({ recipient: 'a@b.co', subject: 's', body: 'b' })), ['to', 'subject', 'messageBody'])
  assert.deepEqual(readGmailResult({ id: 'm', labelIds: ['SENT'], threadId: 't' }), { ok: true, messageId: 'm', threadId: 't', labelIds: ['SENT'] })
  assert.equal(readGmailResult({ data: { id: 'm2' } }).messageId, 'm2')
  assert.equal(readGmailResult(null).ok, false)
})
