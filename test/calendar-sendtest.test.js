// Google Calendar Send test: which calendar it writes to, what it sends, and how upstream failures are reported.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, fakeVs, vsError, googleEventBody, googleRejects } from './helpers.js'
import { CREATE_EVENT_EXPLICIT, CREATE_EVENT_REQUIRED } from '../server/integrations/run.js'
import { saveSetting } from '../server/automations/store.js'

const HOLIDAY = 'en.indian#holiday@group.v.calendar.google.com'
const MAIN = 'piyush.test@gmail.com'

async function setup({ calendarsByAuth } = {}) {
  const vs = fakeVs()
  const t = await startApp({ vs })
  const connect = async () => {
    const authId = vs.connectApp(t.user.id, 'google-calendar')
    const connection = (await t.call('/api/integrations/connections', { method: 'POST', body: { serviceId: await vs.serviceIdFor('google-calendar'), authId } })).body.connection
    return { ...connection, authId }
  }
  const a = await connect()
  const b = await connect()
  vs.state.calendarsByAuth = calendarsByAuth?.(a, b) ?? {
    [a.authId]: [{ label: 'Holidays in India', value: HOLIDAY }, { label: MAIN, value: MAIN }],
    [b.authId]: [{ label: 'Other main', value: 'other.owner@gmail.com' }]
  }
  // The scheduler's calendar is saved directly: the enable-time check is covered elsewhere and is not under test here.
  const schedule = (config) => saveSetting(t.db, t.user.id, 'viewing_scheduler', { enabled: false, config })
  const sendTest = (conn, extra = {}) => t.call(`/api/integrations/connections/${conn.id}/test`, { method: 'POST', body: { confirm: true, ...extra } })
  const creates = () => vs.calls.filter((c) => c.name === 'runAction' && c.args[1] === 'vcalcreate').map((c) => c.args[2])
  return { t, vs, a, b, schedule, sendTest, creates }
}

test('Send test uses the scheduler’s main calendar, not the holiday calendar listed first, and sends every required field', async () => {
  const { t, vs, a, schedule, sendTest, creates } = await setup()
  try {
    schedule({ calendarConnectionId: a.id, calendarId: MAIN, calendarLabel: MAIN })
    const res = await sendTest(a)
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'sent')
    assert.equal(res.body.calendar, 'scheduler')
    const [input] = creates()
    assert.equal(input.calendar_id, MAIN, 'the selected calendar, passed as the plain id string the action expects')
    for (const k of CREATE_EVENT_REQUIRED) assert.ok(typeof input[k] === 'string' && input[k].trim(), `${k} is present`)
    assert.match(input.startdate, /^\d{2}-\d{2}-\d{4}$/)
    assert.match(input.starttime, /^\d{2}:\d{2}$/)
    assert.match(input.meeting_duration, /^\d{2}:\d{2}$/)
    assert.equal(input.timeZone, 'Asia/Kolkata')
    const del = vs.calls.filter((c) => c.name === 'runAction' && c.args[1] === 'vcaldelete').at(-1).args[2]
    assert.equal(del.calendarId, MAIN, 'deleted from the same calendar')
    assert.doesNotMatch(res.body.detail, /@/, 'the detail names no calendar id or address')
  } finally { await t.close() }
})

test('Send test with no, invalid or stale scheduler calendar writes to Google’s "primary", never the first listed calendar', async () => {
  const { t, vs, a, schedule, sendTest, creates } = await setup()
  try {
    const cases = [
      null,
      { calendarConnectionId: a.id, calendarId: '' },
      { calendarConnectionId: a.id, calendarId: 'has spaces "and quotes"' },
      { calendarConnectionId: a.id, calendarId: 'removed.calendar@group.calendar.google.com' },
      { calendarConnectionId: a.id, calendarId: 'primary' }
    ]
    for (const cfg of cases) {
      schedule(cfg || {})
      const before = vs.calls.filter((c) => c.name === 'listOptions').length
      const res = await sendTest(a)
      assert.equal(res.body.status, 'sent', JSON.stringify(cfg))
      assert.equal(res.body.calendar, 'primary')
      assert.equal(creates().at(-1).calendar_id, 'primary', JSON.stringify(cfg))
      if (!cfg || cfg.calendarId === '' || cfg.calendarId === 'primary' || /\s/.test(cfg.calendarId)) assert.equal(vs.calls.filter((c) => c.name === 'listOptions').length, before, 'no list call is needed for primary')
    }
    assert.ok(!creates().some((i) => i.calendar_id === HOLIDAY))
  } finally { await t.close() }
})

test('a calendar belonging to a different connection is never used: refused when asked for, ignored from the scheduler', async () => {
  const { t, a, b, schedule, sendTest, creates } = await setup()
  try {
    const asked = await sendTest(a, { calendarId: 'other.owner@gmail.com' })
    assert.equal(asked.status, 409)
    assert.equal(asked.body.error.code, 'calendar_not_in_connection')
    assert.equal(creates().length, 0, 'nothing was created')
    assert.equal((await sendTest(a, { calendarId: 'bad id with spaces' })).status, 400)
    assert.equal(creates().length, 0)

    schedule({ calendarConnectionId: b.id, calendarId: 'other.owner@gmail.com' })
    const res = await sendTest(a)
    assert.equal(res.body.status, 'sent')
    assert.equal(creates().at(-1).calendar_id, 'primary', 'the scheduler’s calendar on connection B is not used for A')

    // The scheduler points at A, but its saved id is one of B’s calendars (e.g. after reconnecting): not used.
    schedule({ calendarConnectionId: a.id, calendarId: 'other.owner@gmail.com' })
    await sendTest(a)
    assert.equal(creates().at(-1).calendar_id, 'primary')
  } finally { await t.close() }
})

test('upstream 404 on create and 502 on listing calendars are reported with status and reason, without addresses, ids or tokens', async () => {
  const { t, vs, a, schedule, sendTest, creates } = await setup()
  const logs = []
  const orig = console.log
  console.log = (...args) => { logs.push(args.join(' ')) }
  try {
    schedule({ calendarConnectionId: a.id, calendarId: MAIN })
    const token = 'ya29.a0AfH6SMBsecretsecretsecret'
    vs.fail.runAction = vsError('Request failed with status code 404', 404, {
      status: 404,
      data: { response: { status: 404, data: { error: { code: 404, message: `Not Found: calendar ${MAIN} for ${token}`, errors: [{ domain: 'global', reason: 'notFound', message: 'Not Found' }] } } } }
    })
    const res = await sendTest(a)
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'failed')
    assert.match(res.body.detail, /HTTP 404/)
    assert.match(res.body.detail, /reason notFound/)
    assert.equal(creates().length, 1, 'only the one create call; nothing retried or deleted')
    assert.ok(!vs.calls.some((c) => c.name === 'runAction' && c.args[1] === 'vcaldelete'))

    const stored = t.db.prepare('SELECT verify_detail FROM connections WHERE id = ?').get(a.id).verify_detail
    for (const text of [res.body.detail, JSON.stringify(res.body), stored, ...logs]) {
      assert.doesNotMatch(text, /@|piyush|ya29|holiday|DealSaathi test event|Created and removed/, `no sensitive data in: ${text}`)
    }
    assert.ok(logs.some((l) => /HTTP 404, reason notFound/.test(l)), 'one diagnostic log line with status and reason')

    vs.fail.listOptions = vsError('viaSocket responded 502 for POST https://flow.viasocket.com/embed/list-options/vcalfreebusy', 502, { error: { status: 'UNAVAILABLE', message: `backend for ${MAIN} failed` } })
    const listFail = await sendTest(a)
    assert.equal(listFail.status, 502)
    assert.match(listFail.body.error.message, /502/)
    assert.match(listFail.body.error.message, /UNAVAILABLE/)
    assert.doesNotMatch(JSON.stringify(listFail.body) + logs.join('\n'), /@|https?:|piyush/)
    assert.equal(creates().length, 1, 'no create call when the calendar list could not be checked')
  } finally {
    console.log = orig
    await t.close()
  }
})

test('regression: V23 turns a left-out optional field into the text "undefined" (production 400): the Send test sends them all', async () => {
  const { t, vs, a, sendTest, creates } = await setup()
  try {
    const res = await sendTest(a)
    assert.equal(res.body.status, 'sent')
    const input = creates().at(-1)
    for (const [k, v] of Object.entries(CREATE_EVENT_EXPLICIT)) assert.equal(input[k], v, `${k} sent explicitly`)
    assert.equal(input.recurrence, undefined, 'never a recurrence: every allowed value repeats the event')
    const body = googleEventBody(input)
    assert.deepEqual(googleRejects(body), [])
    assert.doesNotMatch(JSON.stringify(body), /"undefined"/, 'no field reaches Google as the text "undefined"')
    assert.deepEqual([body.start.dateTime.slice(10), body.end.dateTime.slice(10)], ['T09:00:00', 'T09:15:00'])

    // The production payload (before this fix) reproduces production's exact answer, and the code is labelled as
    // viaSocket's HTTP client code, not as Google's reason.
    const before = Object.fromEntries(Object.entries(input).filter(([k]) => !(k in CREATE_EVENT_EXPLICIT)))
    assert.deepEqual(googleRejects(googleEventBody(before)), ['colorId', 'visibility', 'guestsCanModify', 'reminders.useDefault'])
    const answer = await vs.runAction('s', 'vcalcreate', before)
    assert.deepEqual(answer, { success: false, message: 'Bad Request', code: 'ERR_BAD_REQUEST', status: 400 })
    vs.state.calendars = [{ label: 'x', value: 'primary' }]
    const original = vs.runAction
    vs.runAction = async (sid, ver, data) => (ver === 'vcalcreate' ? answer : original(sid, ver, data))
    const failed = await sendTest(a)
    assert.equal(failed.body.status, 'failed')
    assert.match(failed.body.detail, /Bad Request \(HTTP 400, viaSocket runtime code ERR_BAD_REQUEST\)$/)
    assert.doesNotMatch(failed.body.detail, /reason ERR_BAD_REQUEST/)
  } finally { await t.close() }
})
