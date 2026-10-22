// Test harness: a fresh in-memory database, a fake AI and the real HTTP app on a random port.
import { openDatabase } from '../server/db.js'
import { createApp } from '../server/app.js'
import { createAuth, createSession, createUser, sessionCookie } from '../server/auth.js'

/** A stand-in for viaSocket AI: answers from a queue and records every call. */
export function fakeAi(...answers) {
  const ai = {
    configured: true,
    calls: [],
    queue: [...answers],
    async send(params, opts) {
      ai.calls.push(params)
      ai.users = [...(ai.users || []), opts?.userId]
      const next = ai.queue.shift()
      if (next === undefined) throw new Error('fake AI: no answer queued')
      if (next instanceof Error) throw next
      return { threadId: params.threadId, messageId: 'm1', content: next, finishReason: 'completed' }
    }
  }
  return ai
}

/** An answer in the shape the extraction schema asks for. */
export function extraction(intent, lead = {}, uncertain = []) {
  const base = {
    full_name: null, customer_type: null, email: null, phone: null, location: null, property_type: null,
    property_interest: null, bedrooms: null, budget_min_inr: null, budget_max_inr: null, source: null, notes: null
  }
  return { intent, lead: { ...base, ...lead }, uncertain }
}

/** A user with a live session; `cookie` goes in a request's Cookie header. */
export function signedInUser(db, { name = 'Asha Broker', email = `asha${Math.random().toString(36).slice(2, 8)}@example.com`, role = 'agent' } = {}) {
  const user = createUser(db, { name, email, password: 'test-password-123', role })
  return { ...user, cookie: sessionCookie(createSession(db, user.id)) }
}

/**
 * The real app on a random port. By default every call is made as a signed-in user;
 * pass { as: otherUser } or { as: null } (no session) per call.
 */
export async function startApp({ ai = fakeAi(), vs = { configured: false }, db = openDatabase(':memory:'), auth, withUser = true, scheduler, mailConnection, backups } = {}) {
  const app = createApp({ db, ai, vs, auth: auth || createAuth({ db }), scheduler, mailConnection, backups })
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const user = withUser ? signedInUser(db) : null
  const call = async (path, { method = 'GET', body, headers = {}, as } = {}) => {
    const who = as === undefined ? user : as
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(who ? { cookie: who.cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null, text, headers: res.headers }
  }
  // Waits until background work is done: queued platform events (processed after each write) and automation sends.
  const idle = async () => {
    await new Promise((r) => setImmediate(r))
    for (let i = 0; i < 5; i++) { await app.locals.events.idle(); await app.locals.automations.idle() }
  }
  return { db, ai, vs, user, base, call, idle, events: app.locals.events, engine: app.locals.automations, close: async () => { await idle(); await new Promise((r) => server.close(r)) } }
}

/** An error shaped like viasocket-apps' ViaSocketError. */
export const vsError = (message, status, body) => Object.assign(new Error(message), { name: 'ViaSocketError', status, ...(body !== undefined ? { body } : {}) })

/**
 * A stand-in for the viaSocket gateway. `state.connections[userId]` and `state.flows[userId]` play
 * viaSocket's records; `calls` logs every call; `fail[method]` makes the next call to it throw.
 */
const SERVICES = { gmail: 'rowo0bqrhj5g', slack: 'rowbu58rc', 'google-calendar': 'rowkhibv5efp', whatsapp_business_cloud: 'row3icnwu2su', razorpay: 'row2n5tu2hd9' }
const VERSIONS = {
  rowogelpy0h6: 'rowwj0sfmhub', row1jrbor: 'rowslackv107',
  row7kcom7ds1: 'vcalfreebusy', rowuitv4m6uy: 'vcalcreate', rowo9a3brirh: 'vcalupdate', row32ktr5oju: 'vcaldelete',
  rowtl0joo241: 'vrzpcreate', rowlcouozywu: 'vrzplist', rowyqfuoa1gu: 'vrzpcancel'
}
export const V = VERSIONS

export function fakeVs({ gmailServiceId = 'rowo0bqrhj5g' } = {}) {
  const state = {
    connections: {}, flows: {},
    options: [{ label: 'me@example.com', value: 'me@example.com' }],
    slackChannels: [{ label: '#leads', value: 'C0LEADS' }, { label: '#team', value: 'C0TEAM' }],
    runResult: { id: 'msg_123', threadId: 'thr_1', labelIds: ['SENT'] },
    slackResult: { ok: true, channel: 'C0LEADS', ts: '1761000000.000100' },
    calendars: [{ label: 'Asha (primary)', value: 'primary' }],
    busy: [],               // [{ start, end }] ISO strings, what Free/Busy answers
    events: {},             // eventId → event, as Create Event made them
    paymentLinks: {}        // reference_id → link, as Razorpay holds them
  }
  let events = 0
  const calls = []
  const fail = {}
  const step = (name, args) => {
    calls.push({ name, args })
    if (fail[name]) { const e = fail[name]; delete fail[name]; throw e }
  }
  let scripts = 0
  const vs = {
    configured: true, state, calls, fail,
    async versions(serviceId) {
      step('versions', [serviceId])
      const slug = Object.keys(SERVICES).find((k) => SERVICES[k] === serviceId)
      return slug ? { service: { service_id: serviceId, name: slug, description: '', icon_url: `https://icons.example/${slug}.svg`, auth_type: 'Auth2.0', requires_auth: true }, actions: [], triggers: [] } : null
    },
    async serviceIdFor(slug) { step('serviceIdFor', [slug]); if (!SERVICES[slug]) throw vsError('unknown slug', null); return slug === 'gmail' ? gmailServiceId : SERVICES[slug] },
    async versionIdFor(serviceId, event, version) { step('versionIdFor', [serviceId, event, version]); return VERSIONS[event] || 'rowunknownv' },
    async token(userId) { step('token', [userId]); return `signed-token-for-${userId}` },
    async listConnections(userId) { step('listConnections', [userId]); return state.connections[userId] || [] },
    async revokeConnection(userId, authId) { step('revokeConnection', [userId, authId]); state.connections[userId] = (state.connections[userId] || []).filter((c) => c.id !== authId) },
    async listFlows(userId) { step('listFlows', [userId]); return state.flows[userId] || [] },
    async enable(userId, serviceId, authId) {
      step('enable', [userId, serviceId, authId])
      const scriptId = `scriSECRET${++scripts}`
      state.flows[userId] = [...(state.flows[userId] || []), { id: scriptId, title: serviceId, status: 'active', serviceId, authId, webhook: `https://flow.sokt.io/func/${scriptId}` }]
      return { scriptId, webhookUrl: `https://flow.sokt.io/func/${scriptId}`, serviceId, authId }
    },
    async setFlowStatus(userId, scriptId, status) {
      step('setFlowStatus', [userId, scriptId, status])
      const f = (state.flows[userId] || []).find((x) => x.id === scriptId)
      if (f) f.status = status === 1 ? 'active' : status === 2 ? 'paused' : 'deleted'
      return { id: scriptId, status: f?.status }
    },
    async listOptions(userId, actionVersionId, params) {
      step('listOptions', [userId, actionVersionId, params])
      const options = params.fieldKey === 'destination.channel_id' ? state.slackChannels : params.fieldKey === 'calendar_id' ? (state.calendarsByAuth?.[params.authId] ?? state.calendars) : state.options
      return { options, offset: null }
    },
    async runAction(scriptId, actionVersionId, inputData) {
      step('runAction', [scriptId, actionVersionId, inputData])
      if (actionVersionId === VERSIONS.row1jrbor) return state.slackResult
      if (actionVersionId === VERSIONS.row7kcom7ds1) {
        return { kind: 'calendar#freeBusy', timeMin: `${inputData.date}T00:00:00.000Z`, timeMax: `${inputData.date}T23:59:59.000Z`, calendars: { 'me@example.com': { busy: state.busy } } }
      }
      if (actionVersionId === VERSIONS.rowuitv4m6uy) {
        // Like the real Create Calendar Event V23: every field its schema marks required must be non-empty
        // (an empty attendees list was answered "Bad Request" in production).
        const missing = ['calendar_id', 'summary', 'description', 'attendees', 'timeZone', 'starttime', 'startdate', 'meeting_duration', 'location'].filter((k) => !String(inputData[k] ?? '').trim())
        if (missing.length) throw vsError('Bad Request', 400)
        const id = `evt${++events}`
        state.events[id] = { id, ...inputData }
        return { id, status: 'confirmed', htmlLink: `https://calendar.google.com/event?eid=${id}` }
      }
      if (actionVersionId === VERSIONS.rowo9a3brirh) { Object.assign(state.events[inputData.eventId] || {}, inputData); return { id: inputData.eventId, status: 'confirmed' } }
      if (actionVersionId === VERSIONS.row32ktr5oju) { delete state.events[inputData.eventId]; return {} }
      if (actionVersionId === VERSIONS.rowtl0joo241) {
        const link = { id: `plink_${Object.keys(state.paymentLinks).length + 1}`, short_url: `https://rzp.io/r/${inputData.reference_id}`, status: 'created', amount: inputData.amount, amount_paid: 0, reference_id: inputData.reference_id }
        state.paymentLinks[inputData.reference_id] = link
        return link
      }
      if (actionVersionId === VERSIONS.rowlcouozywu) return { payment_links: Object.values(state.paymentLinks).filter((l) => l.reference_id === inputData.reference_id) }
      if (actionVersionId === VERSIONS.rowyqfuoa1gu) {
        const link = Object.values(state.paymentLinks).find((l) => l.id === inputData.payment_link_id)
        if (link) link.status = 'cancelled'
        return link || {}
      }
      return state.runResult
    }
  }
  /** Pretend the user finished the Connect popup for Gmail. */
  vs.connectGmail = (userId, authId = `auth${Math.random().toString(36).slice(2, 8)}_${gmailServiceId}`, extra = {}) => {
    state.connections[userId] = [...(state.connections[userId] || []), { id: authId, service_id: gmailServiceId, service_name: 'Gmail', iconUrl: 'https://icons.example/gmail.svg', connection_label: '{"Email":"me@example.com"}', isExpired: false, ...extra }]
    return authId
  }
  /** Pretend the user finished the Connect popup for another curated app. */
  vs.connectApp = (userId, slug) => {
    const authId = `auth${Math.random().toString(36).slice(2, 8)}_${SERVICES[slug]}`
    state.connections[userId] = [...(state.connections[userId] || []), { id: authId, service_id: SERVICES[slug], service_name: slug, connection_label: `{"Email":"me@example.com"}`, isExpired: false }]
    return authId
  }
  /** Pretend the user finished the Connect popup for Slack. */
  vs.connectSlack = (userId, authId = `auth${Math.random().toString(36).slice(2, 8)}_rowbu58rc`) => {
    state.connections[userId] = [...(state.connections[userId] || []), { id: authId, service_id: 'rowbu58rc', service_name: 'Slack', connection_label: '{"team":"acme"}', isExpired: false }]
    return authId
  }
  return vs
}

export const leadCount = (db) => db.prepare('SELECT COUNT(*) AS n FROM leads').get().n

/** Makes every insert into leads fail, as a broken disk would. */
export function breakLeadInserts(db) {
  db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON leads BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;")
  return () => db.exec('DROP TRIGGER fail_insert')
}
