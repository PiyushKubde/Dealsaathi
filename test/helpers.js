import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readConfig } from '../server/config.js'
import { createApp } from '../server/app.js'

export const ADMIN = { email: 'owner@example.com', password: 'test-password-123' }

/**
 * A stand-in for viaSocket's HTTP API. Tests queue answers for the AI endpoint and the action runner;
 * every request is recorded so a test can assert exactly what DealSaathi sent.
 */
export function mockViaSocket() {
  const calls = []
  const ai = []
  const run = []
  const routes = {
    connections: [],
    flows: []
  }
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  async function fetchImpl(url, options = {}) {
    const body = options.body ? JSON.parse(options.body) : undefined
    const call = { url: String(url), method: options.method || 'GET', headers: options.headers || {}, body }
    calls.push(call)
    const u = new URL(url)
    if (u.pathname === '/embed/ai/message') {
      const next = ai.shift()
      if (!next) throw new Error('No mocked AI answer queued')
      if (next.status) return json(next.body, next.status)
      return json({ success: true, data: { thread_id: body.thread_id, message_id: 'm1', content: next, finish_reason: 'completed' } })
    }
    if (u.pathname === '/embed/authentications') return json({ success: true, data: routes.connections })
    if (u.pathname.endsWith('/integrations')) return json({ success: true, data: { flows: routes.flows } })
    if (u.pathname.startsWith('/embed/enable/')) return json({ success: true, data: { script_id: 'scriTEST0001' } })
    if (u.pathname.startsWith('/embed/list-options/')) return json({ success: true, data: [{ label: 'Work calendar', value: 'cal-1' }] })
    if (u.pathname.startsWith('/func/')) {
      const next = run.shift()
      if (!next) throw new Error('No mocked action answer queued')
      if (next.status) return json(next.body, next.status)
      return json(next)
    }
    return json({ success: false, message: 'unmocked' }, 404)
  }
  return { fetchImpl, calls, ai, run, routes }
}

export async function startApp({ viasocket = true, dataDir, mock = mockViaSocket() } = {}) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'dealsaathi-test-'))
  const config = readConfig({
    DATA_DIR: dir,
    DEALSAATHI_ADMIN_EMAIL: ADMIN.email,
    DEALSAATHI_ADMIN_PASSWORD: ADMIN.password,
    DEALSAATHI_ADMIN_NAME: 'Test Broker',
    DEALSAATHI_TIMEZONE: 'Asia/Kolkata',
    VIASOCKET_ORG_ID: '53645',
    VIASOCKET_PROJECT_ID: 'projwZ9V7Wb3',
    VIASOCKET_EMBED_SECRET: viasocket ? 'test-secret-not-real' : '',
    VIASOCKET_API_URL: 'https://flow-api.viasocket.test',
    VIASOCKET_RUN_URL: 'https://run.viasocket.test'
  })
  const { app, db } = createApp(config, { fetchImpl: mock.fetchImpl })
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const base = `http://127.0.0.1:${server.address().port}`
  let cookie = ''

  async function request(pathname, { method = 'GET', body, headers = {}, auth = true } = {}) {
    const response = await fetch(`${base}/api${pathname}`, {
      method,
      headers: {
        'X-DealSaathi': '1',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(auth && cookie ? { cookie } : {}),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const setCookie = response.headers.get('set-cookie')
    if (setCookie) cookie = setCookie.split(';')[0]
    const data = await response.json().catch(() => null)
    return { status: response.status, data }
  }

  async function signIn() {
    const res = await request('/auth/login', { method: 'POST', body: ADMIN })
    if (res.status !== 200) throw new Error(`login failed: ${res.status}`)
  }

  return {
    base, db, dir, mock, request, signIn,
    close: () => new Promise((resolve) => server.close(() => { db.close(); resolve() }))
  }
}

/** An AI interpretation with every key present, as the strict schema requires. */
export function interpretation(overrides = {}) {
  const base = {
    intent: 'clarify',
    reply: 'OK',
    lead: {
      full_name: null, email: null, phone: null, source: null, category: null, property_interest: null, preferred_location: null,
      budget_min: null, budget_max: null, status: null, assigned_broker: null, notes: null
    },
    lead_reference: null,
    search: { query: null, status: null, category: null },
    followup_purpose: null,
    viewing: { property_reference: null, date: null, time: null, duration_minutes: null, time_zone: null, notes: null },
    property_criteria: { city: null, locality: null, listing_type: null, property_type: null, budget_min: null, budget_max: null, bedrooms: null, amenities: [] },
    rent_window_days: null
  }
  return {
    ...base,
    ...overrides,
    lead: { ...base.lead, ...(overrides.lead || {}) },
    search: { ...base.search, ...(overrides.search || {}) },
    viewing: { ...base.viewing, ...(overrides.viewing || {}) },
    property_criteria: { ...base.property_criteria, ...(overrides.property_criteria || {}) }
  }
}

export function connectApp(db, serviceId, { settings = {} } = {}) {
  db.prepare('INSERT OR REPLACE INTO integrations (owner_id, service_id, auth_id, script_id, settings) VALUES (1, ?, ?, ?, ?)').run(
    serviceId, `auth_TEST_${serviceId}`, 'scriTEST0001', JSON.stringify(settings)
  )
}
