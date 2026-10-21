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
export function signedInUser(db, { name = 'Asha Broker', email = `asha${Math.random().toString(36).slice(2, 8)}@example.com` } = {}) {
  const user = createUser(db, { name, email, password: 'test-password-123' })
  return { ...user, cookie: sessionCookie(createSession(db, user.id)) }
}

/**
 * The real app on a random port. By default every call is made as a signed-in user;
 * pass { as: otherUser } or { as: null } (no session) per call.
 */
export async function startApp({ ai = fakeAi(), vs = { configured: false }, db = openDatabase(':memory:'), auth, withUser = true, scheduler } = {}) {
  const app = createApp({ db, ai, vs, auth: auth || createAuth({ db }), scheduler })
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
  const idle = () => app.locals.automations.idle()
  return { db, ai, vs, user, base, call, idle, engine: app.locals.automations, close: async () => { await idle(); await new Promise((r) => server.close(r)) } }
}

/** An error shaped like viasocket-apps' ViaSocketError. */
export const vsError = (message, status) => Object.assign(new Error(message), { name: 'ViaSocketError', status })

/**
 * A stand-in for the viaSocket gateway. `state.connections[userId]` and `state.flows[userId]` play
 * viaSocket's records; `calls` logs every call; `fail[method]` makes the next call to it throw.
 */
const SERVICES = { gmail: 'rowo0bqrhj5g', slack: 'rowbu58rc', 'google-calendar': 'rowkhibv5efp', whatsapp_business_cloud: 'row3icnwu2su' }
const VERSIONS = { rowogelpy0h6: 'rowwj0sfmhub', row1jrbor: 'rowslackv107' }

export function fakeVs({ gmailServiceId = 'rowo0bqrhj5g' } = {}) {
  const state = {
    connections: {}, flows: {},
    options: [{ label: 'me@example.com', value: 'me@example.com' }],
    slackChannels: [{ label: '#leads', value: 'C0LEADS' }, { label: '#team', value: 'C0TEAM' }],
    runResult: { id: 'msg_123', threadId: 'thr_1', labelIds: ['SENT'] },
    slackResult: { ok: true, channel: 'C0LEADS', ts: '1761000000.000100' }
  }
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
      return { options: params.fieldKey === 'destination.channel_id' ? state.slackChannels : state.options, offset: null }
    },
    async runAction(scriptId, actionVersionId, inputData) { step('runAction', [scriptId, actionVersionId, inputData]); return actionVersionId === VERSIONS.row1jrbor ? state.slackResult : state.runResult }
  }
  /** Pretend the user finished the Connect popup for Gmail. */
  vs.connectGmail = (userId, authId = `auth${Math.random().toString(36).slice(2, 8)}_${gmailServiceId}`, extra = {}) => {
    state.connections[userId] = [...(state.connections[userId] || []), { id: authId, service_id: gmailServiceId, service_name: 'Gmail', iconUrl: 'https://icons.example/gmail.svg', connection_label: '{"Email":"me@example.com"}', isExpired: false, ...extra }]
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
