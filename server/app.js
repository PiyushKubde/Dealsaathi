import express from 'express'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { now } from './db.js'
import { AppError } from './errors.js'
import { createLead, deleteLead, leadStats, listActivities, listLeads, requireLead, updateLead } from './leads/service.js'
import { cancelAction, confirmAction, handleMessage, loadConversation } from './assistant/service.js'
import { createAuth } from './auth.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const parseId = (value) => {
  const id = Number(value)
  if (!Number.isInteger(id) || id < 1) throw new AppError(404, 'lead_not_found', 'No such lead.')
  return id
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const parseUuid = (value, what) => {
  if (!UUID_RE.test(String(value))) throw new AppError(404, `${what}_not_found`, `No such ${what}.`)
  return String(value)
}

const sameHost = (origin, host) => {
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * The app, with its database, AI client and access control passed in so tests can supply their own.
 * `ai` is { configured: boolean, send(params): Promise<AiReply> }; `auth` comes from createAuth().
 * `behindProxy`: hosted behind a TLS proxy, so trust its X-Forwarded-* headers.
 */
export function createApp({ db, ai, auth = createAuth({ hosted: false }), behindProxy = false }) {
  const app = express()
  app.disable('x-powered-by')
  if (behindProxy) app.set('trust proxy', 1)
  app.use(express.json({ limit: '50kb' }))

  // Writes only from this app's own pages: a JSON body (forms on other sites cannot send one) and a same-site Origin.
  app.use('/api', (req, res, next) => {
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
      const origin = req.get('origin')
      if (origin && !sameHost(origin, req.get('host'))) return next(new AppError(403, 'forbidden_origin', 'Requests from other sites are not allowed.'))
      if (req.method !== 'DELETE' && !req.is('application/json')) return next(new AppError(415, 'json_required', 'Send JSON.'))
    }
    next()
  })

  app.get('/api/session', (req, res) => res.json(auth.status(req)))
  app.post('/api/session/login', (req, res) => auth.login(req, res))
  app.post('/api/session/logout', (req, res) => auth.logout(req, res))
  app.use('/api', (req, res, next) => auth.guard(req, res, next))

  app.get('/api/health', (req, res) => {
    let database = 'ok'
    try {
      db.prepare('SELECT 1').get()
    } catch {
      database = 'error'
    }
    res.status(database === 'ok' ? 200 : 503).json({ ok: database === 'ok', database, ai: ai.configured ? 'configured' : 'not_configured', access: auth.mode, time: now() })
  })

  app.get('/api/dashboard', (req, res) => res.json(leadStats(db)))

  app.get('/api/leads', (req, res) => {
    const { q, customer_type, status, location, follow_up, limit, offset } = req.query
    res.json(listLeads(db, { q, customer_type, status, location, follow_up: follow_up === '1', limit, offset }))
  })

  // The form sends an Idempotency-Key per opened form: a double click or a retry returns the first answer.
  app.post('/api/leads', (req, res) => {
    const key = req.get('idempotency-key')
    if (key && !/^[A-Za-z0-9-]{8,64}$/.test(key)) throw new AppError(400, 'validation_failed', 'Bad Idempotency-Key.')
    if (key) {
      const seen = db.prepare("SELECT status, response FROM idempotency_keys WHERE key = ? AND scope = 'create_lead'").get(key)
      if (seen) return res.status(seen.status).json({ ...JSON.parse(seen.response), replayed: true })
    }
    const { lead: fields, allowSameName } = req.body || {}
    const lead = createLead(db, fields, { via: 'form', allowSameName: allowSameName === true })
    const body = { lead }
    if (key) db.prepare('INSERT INTO idempotency_keys (key, scope, status, response, created_at) VALUES (?, ?, 201, ?, ?)').run(key, 'create_lead', JSON.stringify(body), now())
    res.status(201).json(body)
  })

  app.get('/api/leads/:id', (req, res) => {
    const id = parseId(req.params.id)
    res.json({ lead: requireLead(db, id), activities: listActivities(db, id) })
  })

  app.patch('/api/leads/:id', (req, res) => {
    const { lead: fields, allowSameName } = req.body || {}
    res.json(updateLead(db, parseId(req.params.id), fields, { via: 'form', allowSameName: allowSameName === true }))
  })

  app.delete('/api/leads/:id', (req, res) => {
    const lead = deleteLead(db, parseId(req.params.id))
    res.json({ deleted: true, lead })
  })

  app.post('/api/assistant/messages', async (req, res) => {
    const { conversationId, message } = req.body || {}
    const cid = conversationId == null ? null : parseUuid(conversationId, 'conversation')
    res.json(await handleMessage(db, ai, { conversationId: cid, message }))
  })

  app.get('/api/assistant/conversations/:id', (req, res) => {
    res.json(loadConversation(db, parseUuid(req.params.id, 'conversation')))
  })

  app.post('/api/assistant/actions/:id/confirm', (req, res) => {
    const { fields, allowSameName } = req.body || {}
    res.json(confirmAction(db, parseUuid(req.params.id, 'action'), { fields, allowSameName: allowSameName === true }))
  })

  app.post('/api/assistant/actions/:id/cancel', (req, res) => {
    res.json(cancelAction(db, parseUuid(req.params.id, 'action')))
  })

  app.use('/api', (req, res, next) => next(new AppError(404, 'not_found', 'No such endpoint.')))

  app.use(express.static(join(ROOT, 'public'), { index: 'index.html' }))

  // Answers carry a code and a plain message; internals (stack, SQL, secrets) stay out of the response.
  app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
    if (error?.type === 'entity.parse.failed') error = new AppError(400, 'bad_json', 'The request body is not valid JSON.')
    if (error?.type === 'entity.too.large') error = new AppError(413, 'too_large', 'The request is too large.')
    if (!(error instanceof AppError)) {
      console.error(`[error] ${req.method} ${req.path}: ${error?.name || 'Error'}: ${error?.message}`)
      error = new AppError(500, 'internal_error', 'Something went wrong on the server. Please try again.')
    }
    res.status(error.status).json({ error: { code: error.code, message: error.message, details: error.details ?? null } })
  })

  return app
}
