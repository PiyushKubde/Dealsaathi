// Running one allowlisted viaSocket action on a broker's own connection, in the documented order:
// live connection check → enabled app (script_id, server only) → version id at run time → runAction.
// https://flow.viasocket.com/documentation/skill/actions-and-events.md
import { now } from '../db.js'
import { AppError } from '../errors.js'
import { cleanViasocketMessage, requireOwnConnection, requireViasocket, viasocketError } from './service.js'
import { claimExternal, finishExternal } from '../notifications/service.js'

/** The only actions DealSaathi runs. Code picks one of these by name; nothing else can be run. */
export const ACTIONS = {
  gmail_send_email: { slug: 'gmail', app: 'Gmail', actionId: 'rowogelpy0h6', version: 'V55', check: 'check the Gmail Sent folder' },
  slack_send_message: { slug: 'slack', app: 'Slack', actionId: 'row1jrbor', version: 'V107', check: 'check the Slack channel' },
  calendar_free_busy: { slug: 'google-calendar', app: 'Google Calendar', actionId: 'row7kcom7ds1', version: 'V3', check: 'try again' },
  calendar_create_event: { slug: 'google-calendar', app: 'Google Calendar', actionId: 'rowuitv4m6uy', version: 'V23', check: 'check your Google Calendar' },
  calendar_update_event: { slug: 'google-calendar', app: 'Google Calendar', actionId: 'rowo9a3brirh', version: 'V13', check: 'check your Google Calendar' },
  calendar_delete_event: { slug: 'google-calendar', app: 'Google Calendar', actionId: 'row32ktr5oju', version: 'V6', check: 'check your Google Calendar' },
  razorpay_create_link: { slug: 'razorpay', app: 'Razorpay', actionId: 'rowtl0joo241', version: 'V5', check: 'check your Razorpay payment links' },
  razorpay_list_links: { slug: 'razorpay', app: 'Razorpay', actionId: 'rowlcouozywu', version: 'V2', check: 'try again' },
  razorpay_cancel_link: { slug: 'razorpay', app: 'Razorpay', actionId: 'rowyqfuoa1gu', version: 'V2', check: 'check your Razorpay payment links' }
}

/** prepareRun + execute, for callers that turn a setup error into the same answer as a refusal. */
export async function runOnce(db, vs, userId, connectionId, actionKey, inputData) {
  const action = ACTIONS[actionKey]
  let prepared
  try {
    prepared = await prepareRun(db, vs, userId, connectionId, action)
  } catch (error) {
    return { outcome: 'failed', notSent: true, reason: error.message || `Could not prepare ${action.app}.` }
  }
  return execute(vs, prepared, inputData)
}

/** A Google Calendar event from Create/Update Event: { id, htmlLink, status } (a refusal comes as { message }). */
export function readCalendarEvent(result) {
  const core = unwrap(result)
  if (!core || typeof core !== 'object') return { ok: false, reason: 'Google Calendar returned no event details.' }
  const failure = explicitFailure(result, core)
  if (failure) return { ok: false, reason: failure }
  if (typeof core.id !== 'string' || !core.id) {
    if (typeof core.message === 'string') return { ok: false, reason: core.message.slice(0, 300) }
    return { ok: false, unknown: true, reason: 'viaSocket answered without a Google Calendar event id, so the booking cannot be confirmed. Check your calendar before trying again.' }
  }
  return { ok: true, eventId: core.id, link: typeof core.htmlLink === 'string' ? core.htmlLink : null, status: typeof core.status === 'string' ? core.status : null }
}

/** Free/busy: { timeMin, timeMax, calendars: { <id>: { busy: [{ start, end }], errors? } } }. */
export function readFreeBusy(result) {
  const core = unwrap(result)
  const calendars = core?.calendars
  if (!calendars || typeof calendars !== 'object') {
    return { ok: false, reason: typeof core?.message === 'string' ? core.message.slice(0, 300) : 'Google Calendar did not return availability.' }
  }
  const entries = Object.values(calendars)
  const errors = entries.flatMap((c) => (Array.isArray(c?.errors) ? c.errors : []))
  if (errors.length) return { ok: false, reason: `Google Calendar could not read this calendar (${String(errors[0]?.reason || 'error')}).` }
  const busy = entries.flatMap((c) => (Array.isArray(c?.busy) ? c.busy : []))
    .map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }))
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start)
  const timeMin = Date.parse(core.timeMin)
  const timeMax = Date.parse(core.timeMax)
  return { ok: true, busy, timeMin: Number.isFinite(timeMin) ? timeMin : null, timeMax: Number.isFinite(timeMax) ? timeMax : null }
}

/** Razorpay payment link: { id, short_url, status, amount, amount_paid } (amounts in paise). */
export function readPaymentLink(result) {
  const core = unwrap(result)
  if (!core || typeof core !== 'object') return { ok: false, reason: 'Razorpay returned no payment link.' }
  const failure = explicitFailure(result, core)
  if (failure) return { ok: false, reason: failure }
  if (typeof core.id !== 'string' || !core.id.startsWith('plink_')) return { ok: false, unknown: true, reason: 'viaSocket answered without a Razorpay payment link id.' }
  return { ok: true, id: core.id, url: typeof core.short_url === 'string' ? core.short_url : null, status: core.status, amount: core.amount, amountPaid: core.amount_paid ?? 0 }
}

/** List Payment Links by reference: the links Razorpay holds for that reference. */
export function readPaymentLinkList(result) {
  const core = unwrap(result)
  const list = Array.isArray(core) ? core : Array.isArray(core?.payment_links) ? core.payment_links : Array.isArray(core?.items) ? core.items : null
  if (!list) {
    const failure = core && typeof core === 'object' ? explicitFailure(result, core) : null
    return { ok: false, reason: failure || 'Razorpay did not return a list of payment links.' }
  }
  return {
    ok: true,
    links: list.filter((l) => l && typeof l.id === 'string').map((l) => ({ id: l.id, status: String(l.status || ''), amount: Number(l.amount) || 0, amountPaid: Number(l.amount_paid) || 0, referenceId: l.reference_id ?? null }))
  }
}

export async function serviceIdOf(vs, slug, app) {
  try {
    return await vs.serviceIdFor(slug)
  } catch (error) {
    throw viasocketError(error, `find ${app} in the catalog`)
  }
}

export async function versionIdOf(vs, serviceId, action) {
  try {
    return await vs.versionIdFor(serviceId, action.actionId, action.version)
  } catch (error) {
    throw viasocketError(error, `read ${action.app}’s action`)
  }
}

/** The user's own connection to this app, checked live: it must still exist on viaSocket and not be expired. */
export async function requireActiveConnection(db, vs, userId, connectionId, { slug, app }) {
  requireViasocket(vs)
  const serviceId = await serviceIdOf(vs, slug, app)
  const row = requireOwnConnection(db, userId, connectionId)
  if (row.service_id !== serviceId) throw new AppError(400, `not_${slug.replace(/-/g, '_')}`, `Choose a connected ${app} account.`)
  let live
  try {
    live = await vs.listConnections(userId)
  } catch (error) {
    throw viasocketError(error, `check your ${app} connection`)
  }
  const match = live.find((c) => c.id === row.auth_id)
  if (!match) throw new AppError(409, 'connection_missing', `This ${app} connection no longer exists on viaSocket. Connect ${app} again on the Integrations page.`)
  if (match.isExpired) throw new AppError(409, 'connection_expired', `This ${app} connection has expired. Reconnect it on the Integrations page.`)
  return row
}

/**
 * The script_id that runs actions on this connection: DealSaathi's stored one if viaSocket still has it,
 * else the user's existing enabled flow for this app and connection, else a new enable(). A paused one is
 * resumed with setFlowStatus(1), never enabled again (DealSaathi pauses them only when disconnecting).
 */
export async function scriptIdFor(db, vs, userId, connection) {
  const flows = await vs.listFlows(userId)
  const stored = db.prepare('SELECT script_id FROM enabled_apps WHERE user_id = ? AND auth_id = ?').get(userId, connection.auth_id)
  const known = stored && flows.find((f) => f.id === stored.script_id)
  const flow = known && known.status !== 'deleted'
    ? known
    : flows.find((f) => f.serviceId === connection.service_id && f.authId === connection.auth_id && f.status !== 'deleted')
  if (flow?.status === 'paused') await vs.setFlowStatus(userId, flow.id, 1)
  let scriptId = flow?.id
  if (!scriptId) scriptId = (await vs.enable(userId, connection.service_id, connection.auth_id)).scriptId
  if (stored?.script_id !== scriptId) {
    db.prepare(`INSERT INTO enabled_apps (user_id, auth_id, service_id, script_id, created_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (user_id, auth_id) DO UPDATE SET script_id = excluded.script_id, service_id = excluded.service_id`)
      .run(userId, connection.auth_id, connection.service_id, scriptId, now())
  }
  return scriptId
}

/** Everything needed before the action runs. Throws an AppError; at this point nothing has been sent. */
export async function prepareRun(db, vs, userId, connectionId, action) {
  const connection = await requireActiveConnection(db, vs, userId, connectionId, action)
  try {
    const scriptId = await scriptIdFor(db, vs, userId, connection)
    const versionId = await versionIdOf(vs, connection.service_id, action)
    return { connection, scriptId, versionId, action }
  } catch (error) {
    throw viasocketError(error, `prepare ${action.app}`)
  }
}

/**
 * Runs it. { outcome: 'failed' } when viaSocket or the app refused, { outcome: 'unknown' } when no answer
 * came back (it may have gone through), else the raw result for the action's own reader.
 */
export async function execute(vs, prepared, inputData) {
  try {
    return { outcome: 'answered', result: await vs.runAction(prepared.scriptId, prepared.versionId, inputData) }
  } catch (error) {
    if (error?.status === null || error?.status === undefined) return { outcome: 'unknown', reason: `No answer from viaSocket, so it is not known whether ${prepared.action.app} acted: ${prepared.action.check} before trying again.` }
    return { outcome: 'failed', reason: cleanViasocketMessage(error), status: error.status }
  }
}

const unwrap = (result) => (result && typeof result === 'object' && result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? result.data : result)

function explicitFailure(result, core) {
  if (core?.success === false || result?.success === false || core?.ok === false || core?.error) {
    const reason = typeof core.message === 'string' ? core.message : typeof core.error === 'string' ? core.error : core.error?.message
    return String(reason || 'The app reported a failure.').slice(0, 300)
  }
  return null
}

/** Gmail's answer: the sample shape is { id, labelIds, threadId }; a live one may wrap it in data. */
export function readGmailResult(result) {
  const core = unwrap(result)
  if (!core || typeof core !== 'object') return { ok: false, reason: 'Gmail returned no message details.' }
  const failure = explicitFailure(result, core)
  if (failure) return { ok: false, reason: failure }
  const messageId = typeof core.id === 'string' ? core.id : null
  if (!messageId) return { ok: false, unknown: true, reason: 'viaSocket answered without a Gmail message id, so the send cannot be confirmed. Check the Gmail Sent folder before sending again.' }
  return { ok: true, messageId, threadId: typeof core.threadId === 'string' ? core.threadId : null, labelIds: Array.isArray(core.labelIds) ? core.labelIds.filter((l) => typeof l === 'string').slice(0, 10) : [] }
}

/** Slack's answer: chat.postMessage answers { ok, channel, ts }; a live one may wrap it in data. */
export function readSlackResult(result) {
  const core = unwrap(result)
  if (!core || typeof core !== 'object') return { ok: false, reason: 'Slack returned no message details.' }
  const failure = explicitFailure(result, core)
  if (failure) return { ok: false, reason: failure }
  const ts = typeof core.ts === 'string' ? core.ts : typeof core.message?.ts === 'string' ? core.message.ts : null
  if (!ts) return { ok: false, unknown: true, reason: 'viaSocket answered without a Slack message timestamp, so the post cannot be confirmed. Check the channel before trying again.' }
  return { ok: true, ts, channel: typeof core.channel === 'string' ? core.channel : null }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** Plain text → safe HTML paragraphs: nothing typed or stored is treated as markup. */
export function bodyToHtml(text) {
  return String(text).trim().split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('')
}

/** Gmail · Send Email inputData (keys decided in docs/action-mapping.md). */
export function gmailInput({ to, subject, body, from, fromName }) {
  return { to, subject, messageBody: bodyToHtml(body), ...(from ? { from } : {}), ...(fromName ? { fromName } : {}) }
}

/** Slack · Send Message inputData: one channel the broker picked, plain markdown text; nothing else. */
export function slackInput({ channelId, text }) {
  return { destination: { messageto: 'channel', channel_id: [channelId] }, markdown_content: text }
}

/** The broker's Slack channels (Send Message's destination.channel_id picker). */
export async function slackChannels(db, vs, userId, connectionId) {
  const action = ACTIONS.slack_send_message
  const connection = await requireActiveConnection(db, vs, userId, connectionId, action)
  const versionId = await versionIdOf(vs, connection.service_id, action)
  try {
    const { options } = await vs.listOptions(userId, versionId, { fieldKey: 'destination.channel_id', authId: connection.auth_id, existingFields: { destination: { messageto: 'channel' } } })
    return options.map((o) => ({ label: String(o.label), value: String(o.value) }))
  } catch (error) {
    throw viasocketError(error, 'list your Slack channels')
  }
}

/** Gmail's From addresses (Send Email's "from" picker). */
export async function gmailFromOptions(db, vs, userId, connectionId) {
  const action = ACTIONS.gmail_send_email
  const connection = await requireActiveConnection(db, vs, userId, connectionId, action)
  const versionId = await versionIdOf(vs, connection.service_id, action)
  try {
    const { options } = await vs.listOptions(userId, versionId, { fieldKey: 'from', authId: connection.auth_id, existingFields: {} })
    return options.map((o) => ({ label: String(o.label), value: String(o.value) }))
  } catch (error) {
    throw viasocketError(error, 'list your Gmail sender addresses')
  }
}

/** The options a PICK key of an allowlisted action offers for the broker's own connection. */
export async function pickOptions(db, vs, userId, connectionId, actionKey, fieldKey, existingFields = {}) {
  const action = ACTIONS[actionKey]
  const connection = await requireActiveConnection(db, vs, userId, connectionId, action)
  const versionId = await versionIdOf(vs, connection.service_id, action)
  try {
    const { options } = await vs.listOptions(userId, versionId, { fieldKey, authId: connection.auth_id, existingFields })
    return options.map((o) => ({ label: String(o.label), value: String(o.value) }))
  } catch (error) {
    throw viasocketError(error, `list your ${action.app} options`)
  }
}

/**
 * Checks that a "connected" account really works now, with a read-only call through it: Gmail lists its sender
 * addresses, Slack its channels, Google Calendar its calendars. The result is saved on the connection.
 */
export async function verifyAccess(db, vs, userId, connectionId) {
  const row = db.prepare('SELECT * FROM connections WHERE id = ? AND user_id = ?').get(connectionId, userId)
  if (!row) throw new AppError(404, 'connection_not_found', 'No such connection.')
  const probes = {
    gmail: () => gmailFromOptions(db, vs, userId, connectionId),
    slack: () => slackChannels(db, vs, userId, connectionId),
    'google-calendar': () => pickOptions(db, vs, userId, connectionId, 'calendar_free_busy', 'calendar_id')
  }
  let slug = null
  for (const s of ['gmail', 'slack', 'google-calendar', 'razorpay', 'whatsapp_business_cloud']) {
    try { if ((await vs.serviceIdFor(s)) === row.service_id) { slug = s; break } } catch { /* try the next */ }
  }
  let status
  let detail
  if (!probes[slug]) {
    status = 'not_checked'
    detail = 'DealSaathi does not run actions through this app yet, so it was not exercised.'
  } else {
    try {
      const options = await probes[slug]()
      status = 'ok'
      const noun = { gmail: ['sender address', 'sender addresses'], slack: ['channel', 'channels'], 'google-calendar': ['calendar', 'calendars'] }[slug]
      detail = `Access confirmed: ${options.length} ${noun[options.length === 1 ? 0 : 1]} readable through this connection.`
    } catch (error) {
      status = 'failed'
      detail = String(error?.message || error).slice(0, 300)
    }
  }
  db.prepare('UPDATE connections SET verified_at = ?, verify_status = ?, verify_detail = ? WHERE id = ?').run(new Date().toISOString(), status, detail, connectionId)
  return { status, detail, checkedAt: new Date().toISOString() }
}

/**
 * A real test through one of the agent's own connections, started by the agent and confirmed by them first:
 *   Gmail            sends one email to the agent's own address
 *   Slack            posts one message to the channel they pick
 *   Google Calendar  creates a 15-minute event tomorrow at 09:00 (India time) in the chosen calendar, then deletes it
 * The provider's own ids are recorded (Deliveries); nothing is called a success without them.
 */
export async function sendLiveTest(db, vs, user, connectionId, { slackChannelId, calendarId } = {}) {
  const row = db.prepare('SELECT * FROM connections WHERE id = ? AND user_id = ?').get(connectionId, user.id)
  if (!row) throw new AppError(404, 'connection_not_found', 'No such connection.')
  let slug = null
  for (const s of ['gmail', 'slack', 'google-calendar']) {
    try { if ((await vs.serviceIdFor(s)) === row.service_id) { slug = s; break } } catch { /* try the next */ }
  }
  if (!slug) throw new AppError(409, 'not_testable', 'Only Gmail, Slack and Google Calendar connections can be tested here.')
  const stampText = new Date().toISOString()
  // Email and Slack tests appear in the delivery log; every result is also kept on the connection.
  const record = (status, detail) => {
    if (slug === 'google-calendar') return
    const id = claimExternal(db, user.id, slug, { kind: `live_test_${slug}`, title: `Live test: ${slug}`, dedupeKey: `live_test:${connectionId}:${stampText}` })
    if (id) finishExternal(db, id, status, detail)
  }
  let out
  if (slug === 'gmail') {
    const ran = await runOnce(db, vs, user.id, connectionId, 'gmail_send_email', gmailInput({ to: user.email, subject: 'DealSaathi test email', body: `This is a test from DealSaathi (${stampText}). You asked for it on the Integrations page; no action is needed.`, fromName: user.name }))
    const read = ran.outcome === 'answered' ? readGmailResult(ran.result) : { ok: false, unknown: ran.outcome === 'unknown', reason: ran.reason }
    out = read.ok ? { status: 'sent', detail: `Gmail accepted the email to ${user.email}: message id ${read.messageId}`, providerIds: { messageId: read.messageId } } : { status: read.unknown ? 'unknown' : 'failed', detail: read.reason }
  } else if (slug === 'slack') {
    if (typeof slackChannelId !== 'string' || !/^[A-Za-z0-9_-]{2,40}$/.test(slackChannelId)) throw new AppError(400, 'validation_failed', 'Choose a Slack channel for the test message.')
    const ran = await runOnce(db, vs, user.id, connectionId, 'slack_send_message', slackInput({ channelId: slackChannelId, text: `DealSaathi test message (${stampText}), sent by ${user.name} from the Integrations page.` }))
    const read = ran.outcome === 'answered' ? readSlackResult(ran.result) : { ok: false, unknown: ran.outcome === 'unknown', reason: ran.reason }
    out = read.ok ? { status: 'sent', detail: `Slack accepted the message: ts ${read.ts}`, providerIds: { ts: read.ts } } : { status: read.unknown ? 'unknown' : 'failed', detail: read.reason }
  } else {
    const calendars = await pickOptions(db, vs, user.id, connectionId, 'calendar_free_busy', 'calendar_id')
    const cal = calendars.find((c) => c.value === calendarId) || calendars.find((c) => c.value === 'primary') || calendars[0]
    if (!cal) throw new AppError(409, 'no_calendar', 'This Google account lists no calendar to test with.')
    const tomorrow = new Date(Date.now() + 5.5 * 3600 * 1000 + 86400000).toISOString().slice(0, 10)
    const [y, m, d] = tomorrow.split('-')
    const created = await runOnce(db, vs, user.id, connectionId, 'calendar_create_event', {
      calendar_id: cal.value, summary: 'DealSaathi test event (deleted automatically)', description: `Created and removed by a DealSaathi test at ${stampText}.`,
      attendees: '', timeZone: 'Asia/Kolkata', startdate: `${d}-${m}-${y}`, starttime: '09:00', meeting_duration: '00:15', location: '', status: 'confirmed', transparency: 'transparent'
    })
    const ev = created.outcome === 'answered' ? readCalendarEvent(created.result) : { ok: false, unknown: created.outcome === 'unknown', reason: created.reason }
    if (!ev.ok) out = { status: ev.unknown ? 'unknown' : 'failed', detail: `Creating the test event: ${ev.reason}` }
    else {
      const del = await runOnce(db, vs, user.id, connectionId, 'calendar_delete_event', { calendarId: cal.value, eventId: ev.eventId, sendUpdates: 'none' })
      const deleted = del.outcome === 'answered' && !(del.result?.success === false || del.result?.error)
      out = { status: deleted ? 'sent' : 'failed', detail: `Google Calendar created event ${ev.eventId} in ${cal.label}${deleted ? ' and deleted it again' : `, but deleting it failed (${del.reason || 'refused'}): remove it from the calendar yourself`}`, providerIds: { eventId: ev.eventId } }
    }
  }
  record(out.status, out.detail)
  db.prepare('UPDATE connections SET verified_at = ?, verify_status = ?, verify_detail = ? WHERE id = ?').run(now(), out.status === 'sent' ? 'ok' : 'failed', `Live test: ${out.detail}`.slice(0, 300), connectionId)
  return { app: slug, ...out, at: now() }
}
