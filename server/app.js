import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { createAssistant } from './assistant.js'
import {
  authMiddleware, createSession, ensureAdmin, login, loginRateLimiter, logout, requireAppHeader, requireLogin, sessionCookie
} from './auth.js'
import { audit, openDatabase } from './db.js'
import { SAMPLE_LEADS, SAMPLE_PROPERTIES, sampleRent } from './sample-data.js'
import { createIntegrationService } from './services/integrations.js'
import { HttpError, createLeadService } from './services/leads.js'
import { createMessageService } from './services/messages.js'
import { createPropertyService } from './services/properties.js'
import { createRentService } from './services/rent.js'
import { createViewingService } from './services/viewings.js'
import { ValidationError } from './validation.js'
import { APPS, CALENDAR_TIME_ZONES, ViaSocketError, createViaSocket } from './viasocket.js'

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')

const CSP = [
  "default-src 'self'",
  // Exactly the two viaSocket browser scripts; they load nothing else and frame embedfrontend.viasocket.com.
  "script-src 'self' https://flow.viasocket.com/connect.js https://embed.viasocket.com/prod-embedcomponent.js",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "connect-src 'self' https://*.viasocket.com https://flow.sokt.io/func/",
  'frame-src https://*.viasocket.com',
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'"
].join('; ')

const id = (value) => {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Invalid id.')
  return n
}

/** Wraps async route handlers so a rejected promise reaches the error handler. */
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

export function createApp(config, { fetchImpl } = {}) {
  const db = openDatabase(config.dataDir)
  const ownerId = ensureAdmin(db, config.admin)
  const viasocket = createViaSocket(config, { fetchImpl })
  const leads = createLeadService(db)
  const properties = createPropertyService(db)
  const rent = createRentService(db, { timeZone: config.timeZone })
  const integrations = createIntegrationService(db, viasocket)
  const viewings = createViewingService(db, { leads, properties, integrations, timeZone: config.timeZone })
  const messages = createMessageService(db, { leads, rent, integrations })
  const assistant = createAssistant(db, { viasocket, leads, properties, viewings, rent, messages, integrations, timeZone: config.timeZone })

  // Sample listings are seeded once so property matching has something to show; they are flagged and labelled.
  if (ownerId && !db.prepare('SELECT 1 FROM properties WHERE owner_id = ? LIMIT 1').get(ownerId)) {
    for (const p of SAMPLE_PROPERTIES) properties.create(ownerId, p, { isSample: true })
  }

  const app = express()
  app.set('trust proxy', 1)
  app.disable('x-powered-by')
  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY'
    })
    next()
  })
  app.use(express.json({ limit: '100kb' }))
  app.use(authMiddleware(db))

  const api = express.Router()
  api.use(requireAppHeader)

  api.get('/health', (_req, res) => res.json({ ok: true }))

  api.post('/auth/login', loginRateLimiter(), (req, res) => {
    if (!config.admin.email || !config.admin.password) {
      return res.status(503).json({ error: 'Sign-in is not set up: the server needs DEALSAATHI_ADMIN_EMAIL and DEALSAATHI_ADMIN_PASSWORD.' })
    }
    const user = login(db, req.body?.email, req.body?.password)
    if (!user) return res.status(401).json({ error: 'Email or password is incorrect.' })
    const { token } = createSession(db, user.id)
    res.set('Set-Cookie', sessionCookie(token, { production: config.production })).json({ user })
  })

  api.post('/auth/logout', (req, res) => {
    logout(db, req.sessionTokenHash)
    res.set('Set-Cookie', sessionCookie('', { production: config.production, clear: true })).json({ ok: true })
  })

  api.get('/auth/me', (req, res) => res.json({ user: req.user || null, loginConfigured: Boolean(config.admin.email && config.admin.password) }))

  api.use(requireLogin)

  api.get('/status', (req, res) => {
    const count = (table, sample) => db.prepare(`SELECT count(*) AS n FROM ${table} WHERE owner_id = ? AND is_sample = ?`).get(req.user.id, sample ? 1 : 0).n
    res.json({
      viasocket: { configured: viasocket.configured, orgId: config.viasocket.orgId || null, projectId: config.viasocket.projectId || null },
      ai: { available: viasocket.configured, provider: 'viaSocket AI', model: config.viasocket.aiModel || 'viaSocket default' },
      // From stored connections only; the Integrations screen re-checks them live with viaSocket.
      integrations: { gmail: integrations.gmailReady(req.user.id), calendar: integrations.calendarReady(req.user.id) },
      timeZone: config.timeZone,
      today: rent.today(),
      timeZones: CALENDAR_TIME_ZONES,
      data: {
        leads: { real: count('leads', false), sample: count('leads', true) },
        properties: { real: count('properties', false), sample: count('properties', true) },
        rent: { real: count('rent_records', false), sample: count('rent_records', true) }
      }
    })
  })

  api.get('/dashboard', (req, res) => {
    const uid = req.user.id
    const rentRows = rent.list(uid)
    res.json({
      recentLeads: leads.list(uid, { limit: 6 }),
      followUps: leads.needingFollowUp(uid),
      upcomingViewings: viewings.list(uid, { upcomingOnly: true }).slice(0, 6),
      rent: {
        overdue: rentRows.filter((r) => r.bucket === 'overdue'),
        dueSoon: rentRows.filter((r) => r.bucket === 'due_soon'),
        needsVerification: rentRows.filter((r) => r.bucket === 'needs_verification')
      },
      recentMatches: db
        .prepare(`SELECT chat_messages.data, chat_messages.created_at FROM chat_messages JOIN conversations c ON c.id = chat_messages.conversation_id
                   WHERE c.owner_id = ? AND chat_messages.role = 'assistant' AND chat_messages.data LIKE '%"kind":"properties"%'
                   ORDER BY chat_messages.id DESC LIMIT 3`)
        .all(uid)
        .map((row) => {
          const data = JSON.parse(row.data)
          return { created_at: row.created_at, criteria: data.extracted?.criteria, count: data.results?.items?.length || 0 }
        }),
      totals: {
        leads: db.prepare('SELECT count(*) n FROM leads WHERE owner_id = ?').get(uid).n,
        activeLeads: db.prepare("SELECT count(*) n FROM leads WHERE owner_id = ? AND status NOT IN ('won','lost')").get(uid).n
      }
    })
  })

  // Leads
  api.get('/leads', (req, res) => res.json({ leads: leads.list(req.user.id, req.query) }))
  api.post('/leads', (req, res) => res.status(201).json({ lead: leads.create(req.user.id, req.body) }))
  api.get('/leads/:id', (req, res) => {
    const lead = leads.get(req.user.id, id(req.params.id))
    res.json({
      lead,
      messages: messages.list(req.user.id, { leadId: lead.id }),
      viewings: viewings.list(req.user.id).filter((v) => v.lead_id === lead.id)
    })
  })
  api.patch('/leads/:id', (req, res) => res.json({ lead: leads.update(req.user.id, id(req.params.id), req.body) }))
  api.post('/leads/:id/followup-draft', route(async (req, res) => {
    if (!viasocket.configured) throw new HttpError(503, 'AI drafting is not available: viaSocket is not configured. Write the draft yourself instead.', { code: 'not_configured' })
    const lead = leads.get(req.user.id, id(req.params.id))
    res.status(201).json({ message: await assistant.draftFollowUp(req.user.id, lead, String(req.body?.purpose || '').slice(0, 300) || null) })
  }))

  // Properties
  api.get('/properties', (req, res) => res.json({ properties: properties.list(req.user.id, { includeSample: req.query.sample !== '0' }) }))
  api.post('/properties', (req, res) => res.status(201).json({ property: properties.create(req.user.id, req.body) }))
  api.patch('/properties/:id', (req, res) => res.json({ property: properties.update(req.user.id, id(req.params.id), req.body) }))
  api.post('/properties/match', (req, res) => res.json(properties.match(req.user.id, req.body)))

  // Viewings
  api.get('/viewings', (req, res) => res.json({ viewings: viewings.list(req.user.id) }))
  api.post('/viewings', (req, res) => res.status(201).json({ viewing: viewings.propose(req.user.id, req.body) }))
  api.post('/viewings/:id/availability', route(async (req, res) => res.json({ viewing: await viewings.checkAvailability(req.user.id, id(req.params.id)) })))
  api.post('/viewings/:id/book', route(async (req, res) => res.json(await viewings.book(req.user.id, id(req.params.id)))))
  api.patch('/viewings/:id/status', (req, res) => res.json({ viewing: viewings.setStatus(req.user.id, id(req.params.id), req.body?.status) }))

  // Rent
  api.get('/rent', (req, res) => res.json({ today: rent.today(), records: rent.list(req.user.id, { windowDays: Number(req.query.window) || 7 }) }))
  api.post('/rent', (req, res) => res.status(201).json({ record: rent.create(req.user.id, req.body) }))
  api.patch('/rent/:id', (req, res) => res.json({ record: rent.update(req.user.id, id(req.params.id), req.body) }))
  api.post('/rent/:id/reminder', (req, res) => res.status(201).json({ message: messages.draftRentReminder(req.user.id, id(req.params.id), req.user.name) }))

  // Messages (follow-ups and reminders)
  api.get('/messages', (req, res) => res.json({
    messages: messages.list(req.user.id, { leadId: req.query.lead_id && id(req.query.lead_id), rentId: req.query.rent_id && id(req.query.rent_id) })
  }))
  api.post('/messages', (req, res) => {
    const body = req.body || {}
    res.status(201).json({
      message: messages.createDraft(req.user.id, {
        kind: body.kind, leadId: body.lead_id ? id(body.lead_id) : null, rentId: body.rent_id ? id(body.rent_id) : null, subject: body.subject, body: body.body
      })
    })
  })
  api.patch('/messages/:id', (req, res) => res.json({ message: messages.updateDraft(req.user.id, id(req.params.id), req.body || {}) }))
  api.post('/messages/:id/send', route(async (req, res) => res.json({ message: await messages.send(req.user.id, id(req.params.id)) })))

  // Assistant
  api.post('/assistant/message', route(async (req, res) => {
    const body = req.body || {}
    res.json(await assistant.handle(req.user.id, {
      conversationId: typeof body.conversationId === 'string' ? body.conversationId : null,
      message: body.message,
      focusLeadId: body.focusLeadId ? id(body.focusLeadId) : null
    }))
  }))
  api.get('/assistant/conversations', (req, res) => res.json({ conversations: assistant.conversations(req.user.id) }))
  api.get('/assistant/conversations/:id', (req, res) => res.json(assistant.history(req.user.id, req.params.id)))
  api.post('/actions/:id/confirm', route(async (req, res) => res.json(await assistant.confirm(req.user.id, req.params.id))))
  api.post('/actions/:id/cancel', (req, res) => res.json(assistant.cancel(req.user.id, req.params.id)))
  api.get('/activity', (req, res) => res.json({
    events: db.prepare('SELECT event, detail, created_at FROM audit_log WHERE owner_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id)
  }))

  // Integrations (viaSocket)
  api.get('/integrations', route(async (req, res) => res.json(await integrations.status(req.user.id))))
  api.get('/viasocket/token', (req, res) => {
    if (!viasocket.configured) throw new HttpError(503, 'viaSocket is not configured on the server.', { code: 'not_configured' })
    res.set('Cache-Control', 'no-store').json({ token: viasocket.embedToken(req.user.id) })
  })
  api.post('/integrations/connected', route(async (req, res) => res.json(await integrations.connect(req.user.id, req.body?.serviceId, req.body?.authId))))
  api.delete('/integrations/:serviceId', (req, res) => {
    integrations.disconnectLocal(req.user.id, req.params.serviceId)
    res.json({ ok: true })
  })
  api.get('/integrations/calendar/calendars', route(async (req, res) => res.json({ calendars: await integrations.listCalendars(req.user.id) })))
  api.put('/integrations/calendar/calendar', (req, res) => {
    integrations.chooseCalendar(req.user.id, req.body || {})
    res.json({ ok: true })
  })

  api.get('/automations', (req, res) => res.json({
    automations: db.prepare('SELECT flow_id, title, status, updated_at FROM automations WHERE owner_id = ? ORDER BY updated_at DESC').all(req.user.id)
  }))
  api.post('/automations/events', (req, res) => {
    const e = req.body || {}
    const statuses = { initiated: 'drafted', published: 'active', updated: 'active', paused: 'paused', deleted: 'deleted' }
    if (typeof e.id !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(e.id) || !statuses[e.action]) throw new HttpError(400, 'Invalid flow event.')
    const webhook = typeof e.webhookurl === 'string' && /^https:\/\/[^\s]+$/.test(e.webhookurl) ? e.webhookurl.slice(0, 500) : null
    db.prepare(
      `INSERT INTO automations (owner_id, flow_id, title, status, webhook_url, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, flow_id) DO UPDATE SET title = coalesce(excluded.title, title), status = excluded.status,
         webhook_url = coalesce(excluded.webhook_url, webhook_url), updated_at = excluded.updated_at`
    ).run(req.user.id, e.id, typeof e.title === 'string' ? e.title.slice(0, 200) : null, statuses[e.action], webhook, new Date().toISOString())
    audit(db, req.user.id, 'automation_event', { flow_id: e.id, action: e.action })
    res.json({ ok: true })
  })

  // Sample data: loaded and removed only on request, always flagged.
  api.post('/sample-data', (req, res) => {
    const uid = req.user.id
    let added = 0
    for (const lead of SAMPLE_LEADS) {
      if (!leads.findDuplicate(uid, lead)) {
        leads.create(uid, lead, { isSample: true })
        added += 1
      }
    }
    if (!db.prepare('SELECT 1 FROM rent_records WHERE owner_id = ? AND is_sample = 1').get(uid)) {
      for (const record of sampleRent(rent.today())) {
        rent.create(uid, record, { isSample: true })
        added += 1
      }
    }
    if (!db.prepare('SELECT 1 FROM properties WHERE owner_id = ? AND is_sample = 1').get(uid)) {
      for (const p of SAMPLE_PROPERTIES) properties.create(uid, p, { isSample: true })
    }
    audit(db, uid, 'sample_data_loaded', { added })
    res.json({ added })
  })
  api.delete('/sample-data', (req, res) => {
    const uid = req.user.id
    db.transaction(() => {
      const sampleLeads = 'SELECT id FROM leads WHERE owner_id = ? AND is_sample = 1'
      const sampleRentIds = 'SELECT id FROM rent_records WHERE owner_id = ? AND is_sample = 1'
      const sampleProps = 'SELECT id FROM properties WHERE owner_id = ? AND is_sample = 1'
      db.prepare(`DELETE FROM messages WHERE owner_id = ? AND (lead_id IN (${sampleLeads}) OR rent_id IN (${sampleRentIds}))`).run(uid, uid, uid)
      db.prepare(`DELETE FROM viewings WHERE owner_id = ? AND (lead_id IN (${sampleLeads}) OR property_id IN (${sampleProps}))`).run(uid, uid, uid)
      db.prepare(`UPDATE rent_records SET property_id = NULL WHERE owner_id = ? AND property_id IN (${sampleProps})`).run(uid, uid)
      for (const table of ['leads', 'rent_records', 'properties']) db.prepare(`DELETE FROM ${table} WHERE owner_id = ? AND is_sample = 1`).run(uid)
    })()
    audit(db, uid, 'sample_data_removed')
    res.json({ ok: true })
  })

  api.use((_req, res) => res.status(404).json({ error: 'Not found.' }))

  // eslint-disable-next-line no-unused-vars
  api.use((error, req, res, _next) => {
    if (error instanceof ValidationError) return res.status(422).json({ error: error.message, issues: error.issues })
    if (error instanceof ViaSocketError) {
      return res.status(error.status).json({ error: error.message, code: error.code, conversationId: error.conversationId })
    }
    if (error instanceof HttpError) {
      return res.status(error.status).json({
        error: error.message, code: error.code, issues: error.issues, existing: error.existing, conversationId: error.conversationId
      })
    }
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON.' })
    // Log the error kind only: request bodies may hold lead or tenant details.
    console.error(`Unhandled error on ${req.method} ${req.path}: ${error.name}: ${error.message}`)
    res.status(500).json({ error: 'Something went wrong on the server. Nothing was changed.' })
  })

  app.use('/api', api)
  // Body-parser errors happen before the API router, so they are answered here.
  // eslint-disable-next-line no-unused-vars
  app.use((error, _req, res, _next) => {
    const status = error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : 500
    res.status(status).json({ error: status === 500 ? 'Something went wrong on the server.' : 'The request body could not be read.' })
  })
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: config.production ? '1h' : 0 }))
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')))

  return { app, db, services: { leads, properties, rent, viewings, messages, integrations, assistant, viasocket }, APPS }
}
