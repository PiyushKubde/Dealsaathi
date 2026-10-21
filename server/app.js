import express from 'express'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { now } from './db.js'
import { AppError } from './errors.js'
import { createLead, deleteLead, leadStats, listActivities, listLeads, requireLead, updateLead } from './leads/service.js'
import { cancelAction, confirmAction, handleMessage, loadConversation } from './assistant/service.js'
import { createAuth } from './auth.js'
import { createHash, timingSafeEqual } from 'node:crypto'
import { disconnect, listUserConnections, reconnectDetails, requireViasocket, saveConnection, viasocketError } from './integrations/service.js'
import { curatedApps, requireCuratedServiceId } from './integrations/apps.js'
import { GMAIL, cancelFollowup, draftFollowup, draftRecommendation, followupSetup, fromOptions, listFollowups, prepareFollowup, sendFollowup } from './followups/service.js'
import { createAutomationEngine } from './automations/engine.js'
import { listReminders, setReminderStatus } from './automations/reminders.js'
import { bookViewing, cancelViewing, draftViewing, freeSlots, getViewing, listViewings, rescheduleViewing, resendConfirmation, setOutcome } from './viewings/service.js'
import { baseUrl, listFeedback, onViewingCompleted, publicFeedback, resendFeedback, submitFeedback } from './feedback/service.js'
import { checkDueNow, createTenancy, recordManualPayment, rentOverview, tenancyDetail, updateTenancy, waiveDue } from './rent/service.js'
import { addSampleProperties, createProperty, deleteProperty, dismissMatch, listProperties, listPropertyMatches, matchPropertiesFor, requireProperty, updateProperty } from './properties/service.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// The official browser half of viasocket-apps (connect()), served as-is from the installed package.
const VIASOCKET_BROWSER = fileURLToPath(import.meta.resolve('viasocket-apps/browser'))

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
 * The app, with its database, AI, viaSocket gateway and access control passed in so tests can supply their own.
 * `ai` is { configured, send(params, { userId }) }; `vs` comes from createViasocketGateway(); `auth` from createAuth().
 * `behindProxy`: hosted behind a TLS proxy, so trust its X-Forwarded-* headers.
 * `scheduler` is { available, secret }: the host's scheduler (Embarko) calls /tasks/automations with the secret.
 */
export function createApp({ db, ai, vs = { configured: false }, auth = createAuth({ db }), behindProxy = false, scheduler = { available: false, secret: null } }) {
  const automations = createAutomationEngine({ db, vs, scheduler })
  const app = express()
  app.locals.automations = automations
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

  app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })
  app.get('/api/session', (req, res) => res.json(auth.status(req)))
  app.post('/api/session/register', (req, res) => auth.register(req, res))
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
    res.status(database === 'ok' ? 200 : 503).json({ ok: database === 'ok', database, ai: ai.configured ? 'configured' : 'not_configured', viasocket: vs.configured ? 'configured' : 'not_configured', access: auth.mode, time: now() })
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
    const lead = createLead(db, fields, { via: 'form', allowSameName: allowSameName === true, userId: req.user.id })
    automations.onLeadCreated(lead, req.user, 'form') // trigger: New Lead Alert (runs after the save, in the background)
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
    res.json(updateLead(db, parseId(req.params.id), fields, { via: 'form', allowSameName: allowSameName === true, userId: req.user.id }))
  })

  app.delete('/api/leads/:id', (req, res) => {
    const lead = deleteLead(db, parseId(req.params.id))
    res.json({ deleted: true, lead })
  })

  app.post('/api/assistant/messages', async (req, res) => {
    const { conversationId, message } = req.body || {}
    const cid = conversationId == null ? null : parseUuid(conversationId, 'conversation')
    res.json(await handleMessage(db, ai, { conversationId: cid, message, userId: req.user.id }))
  })

  app.get('/api/assistant/conversations/:id', (req, res) => {
    res.json(loadConversation(db, parseUuid(req.params.id, 'conversation'), req.user.id))
  })

  app.post('/api/assistant/actions/:id/confirm', (req, res) => {
    const { fields, allowSameName } = req.body || {}
    const result = confirmAction(db, parseUuid(req.params.id, 'action'), { fields, allowSameName: allowSameName === true, userId: req.user.id })
    if (!result.alreadySaved && result.lead) automations.onLeadCreated(result.lead, req.user, 'assistant')
    res.json(result)
  })

  app.post('/api/assistant/actions/:id/cancel', (req, res) => {
    res.json(cancelAction(db, parseUuid(req.params.id, 'action'), req.user.id))
  })

  // ---- Properties and matching. Saving a property recomputes its buyer matches in the same transaction.
  app.get('/api/properties', (req, res) => {
    const { q, listing_type, city, status } = req.query
    res.json({ properties: listProperties(db, { q, listing_type, city, status }) })
  })
  // Trigger: New Property → Buyer Matching, in the same transaction as the save (unless the broker turned it off).
  app.post('/api/properties', (req, res) => {
    const match = automations.matchingEnabledFor(req.user.id)
    const out = createProperty(db, req.body?.property, { userId: req.user.id, match })
    automations.recordMatching(req.user.id, out.property, out.matching)
    res.status(201).json(out)
  })
  app.post('/api/properties/samples', (req, res) => res.status(201).json({ properties: addSampleProperties(db, req.user.id) }))
  app.get('/api/properties/:id', (req, res) => {
    const id = parseId(req.params.id)
    res.json({ property: requireProperty(db, id), matches: listPropertyMatches(db, id) })
  })
  app.patch('/api/properties/:id', (req, res) => {
    const match = automations.matchingEnabledFor(req.user.id)
    const out = updateProperty(db, parseId(req.params.id), req.body?.property, { userId: req.user.id, match })
    automations.recordMatching(req.user.id, out.property, out.matching)
    res.json(out)
  })
  app.delete('/api/properties/:id', (req, res) => res.json({ deleted: true, property: deleteProperty(db, parseId(req.params.id)) }))
  app.post('/api/properties/:id/matches/:leadId/dismiss', (req, res) => res.json(dismissMatch(db, parseId(req.params.id), parseId(req.params.leadId))))
  app.get('/api/leads/:id/matches', (req, res) => {
    const lead = requireLead(db, parseId(req.params.id))
    res.json({ matches: matchPropertiesFor(db, lead).map(({ property, match }) => ({ property, ...match })) })
  })

  // ---- Integrations: only the curated apps, each connected through the official Connect popup
  // (https://flow.viasocket.com/documentation/skill/connect.md). There is no open app catalog.
  app.get('/api/integrations/apps', async (req, res) => {
    requireViasocket(vs)
    const [apps, { connections, live, error }] = await Promise.all([curatedApps(vs), listUserConnections(db, vs, req.user.id)])
    res.json({
      apps: apps.map(({ slug, name, purpose, usedBy, inUse, serviceId, iconUrl, actions, error: appError }) => ({
        slug, name, purpose, usedBy, inUse, serviceId, iconUrl, actions, error: appError,
        connections: connections.filter((c) => serviceId && c.serviceId === serviceId)
      })),
      live,
      error: error ?? null
    })
  })

  // The signed-in user's embed token, for the Connect popup only (the documented exception to "tokens stay
  // on the server"). Signed per request for this user; never stored or logged.
  app.get('/api/integrations/token', async (req, res) => {
    requireViasocket(vs)
    try {
      res.json({ embedToken: await vs.token(req.user.id) })
    } catch (error) {
      throw viasocketError(error, 'sign your token')
    }
  })

  app.get('/api/integrations/connections', async (req, res) => res.json(await listUserConnections(db, vs, req.user.id)))
  app.post('/api/integrations/connections', async (req, res) => {
    const { serviceId, authId } = req.body || {}
    requireViasocket(vs)
    await requireCuratedServiceId(vs, serviceId)
    res.status(201).json({ connection: await saveConnection(db, vs, req.user.id, { serviceId, authId }) })
  })
  app.post('/api/integrations/connections/:id/reconnect', async (req, res) => res.json(await reconnectDetails(db, vs, req.user.id, parseId(req.params.id))))
  app.delete('/api/integrations/connections/:id', async (req, res) => res.json(await disconnect(db, vs, req.user.id, parseId(req.params.id))))

  // ---- Emails to a lead through the broker's Gmail: follow-ups and property recommendations
  const gmailId = async () => {
    if (!vs.configured) return null
    try {
      return await vs.serviceIdFor(GMAIL.slug)
    } catch {
      return null
    }
  }
  app.get('/api/leads/:id/followups', async (req, res) => {
    const id = parseId(req.params.id)
    res.json({ ...followupSetup(db, req.user.id, id, await gmailId()), viasocket: vs.configured, ai: ai.configured, followups: listFollowups(db, id) })
  })
  app.get('/api/followups/from-options', async (req, res) => res.json({ options: await fromOptions(db, vs, req.user.id, parseId(req.query.connectionId)) }))
  app.post('/api/leads/:id/followups/draft', async (req, res) => res.json(await draftFollowup(db, ai, req.user, parseId(req.params.id))))
  app.post('/api/leads/:id/recommendations/draft', (req, res) => res.json(draftRecommendation(db, req.user, parseId(req.params.id), req.body?.propertyIds)))
  app.post('/api/leads/:id/followups', async (req, res) => res.status(201).json(await prepareFollowup(db, vs, req.user, parseId(req.params.id), req.body)))
  app.post('/api/followups/:id/send', async (req, res) => res.json(await sendFollowup(db, vs, req.user, parseUuid(req.params.id, 'followup'))))
  app.post('/api/followups/:id/cancel', (req, res) => res.json(cancelFollowup(db, req.user, parseUuid(req.params.id, 'followup'))))

  // ---- Real estate automations: DealSaathi's own seven, configured here and run by this server
  const automationKey = (key) => {
    if (!/^[a-z_]{3,40}$/.test(key)) throw new AppError(404, 'automation_not_found', 'No such automation.')
    return key
  }
  app.get('/api/automations', async (req, res) => res.json({ automations: await automations.cards(req.user) }))
  app.put('/api/automations/:key', async (req, res) => res.json({ automation: await automations.configure(req.user, automationKey(req.params.key), req.body || {}) }))
  app.get('/api/automations/:key/runs', (req, res) => res.json({ runs: automations.runs(req.user, automationKey(req.params.key)) }))
  app.post('/api/automations/runs/:id/retry', async (req, res) => res.json({ run: await automations.retry(req.user, parseUuid(req.params.id, 'run')) }))
  app.post('/api/automations/followup_reminders/run', async (req, res) => res.json({ result: await automations.runRemindersNow(req.user) }))
  app.get('/api/automations/slack-channels', async (req, res) => res.json({ options: await automations.slackChannels(req.user, parseId(req.query.connectionId)) }))
  // ---- Viewings (Property Viewing Scheduler)
  app.get('/api/viewings', (req, res) => res.json({ viewings: listViewings(db, req.user.id, { leadId: req.query.leadId ? parseId(req.query.leadId) : null }) }))
  app.get('/api/viewings/calendars', async (req, res) => res.json({ options: await automations.calendars(req.user, parseId(req.query.connectionId)) }))
  app.get('/api/viewings/slots', async (req, res) => res.json(await freeSlots(db, vs, req.user, {
    date: req.query.date, durationMinutes: req.query.durationMinutes ? Number(req.query.durationMinutes) : undefined, except: req.query.except ? parseUuid(req.query.except, 'viewing') : null
  })))
  app.post('/api/viewings', (req, res) => res.status(201).json(draftViewing(db, req.user, req.body)))
  app.get('/api/viewings/:id', (req, res) => res.json({ viewing: getViewing(db, req.user.id, parseUuid(req.params.id, 'viewing')) }))
  app.post('/api/viewings/:id/book', async (req, res) => res.json(await bookViewing(db, vs, req.user, parseUuid(req.params.id, 'viewing'), { confirmNotInCalendar: req.body?.confirmNotInCalendar === true })))
  app.post('/api/viewings/:id/cancel', async (req, res) => res.json(await cancelViewing(db, vs, req.user, parseUuid(req.params.id, 'viewing'), { notifyLead: req.body?.notifyLead !== false })))
  app.post('/api/viewings/:id/reschedule', async (req, res) => res.json(await rescheduleViewing(db, vs, req.user, parseUuid(req.params.id, 'viewing'), req.body || {})))
  app.post('/api/viewings/:id/confirmation', async (req, res) => res.json(await resendConfirmation(db, vs, req.user, parseUuid(req.params.id, 'viewing'))))
  // The broker says whether it took place; a completed viewing triggers Post-Viewing Feedback.
  app.post('/api/viewings/:id/outcome', async (req, res) => {
    const id = parseUuid(req.params.id, 'viewing')
    setOutcome(db, req.user, id, req.body?.outcome)
    const feedback = req.body?.outcome === 'completed' ? await onViewingCompleted(db, vs, req.user, id, baseUrl(req)) : null
    res.json({ viewing: getViewing(db, req.user.id, id), feedback })
  })

  // ---- Feedback (Post-Viewing Feedback)
  app.get('/api/feedback', (req, res) => res.json({ requests: listFeedback(db, req.user.id) }))
  app.post('/api/feedback/:id/resend', async (req, res) => res.json(await resendFeedback(db, vs, req.user, parseUuid(req.params.id, 'feedback'), baseUrl(req), { confirm: req.body?.confirm === true })))

  // The buyer's side: no sign-in, only the token. It reveals nothing but that viewing's listings.
  const publicHits = new Map()
  const limitPublic = (req) => {
    const ip = req.ip || 'unknown'
    const e = publicHits.get(ip)
    if (!e || e.reset < Date.now()) publicHits.set(ip, { n: 1, reset: Date.now() + 15 * 60 * 1000 })
    else if (++e.n > 60) throw new AppError(429, 'too_many_requests', 'Too many requests. Try again later.')
  }
  app.get('/api/public/feedback/:token', (req, res) => { limitPublic(req); res.setHeader('Referrer-Policy', 'no-referrer'); res.json(publicFeedback(db, req.params.token)) })
  app.post('/api/public/feedback/:token', (req, res) => { limitPublic(req); res.json(submitFeedback(db, req.params.token, req.body)) })

  // ---- Tenancies and rent (Rent and Payment Reminders)
  app.get('/api/rent', (req, res) => res.json(rentOverview(db, req.user.id)))
  app.post('/api/rent/tenancies', (req, res) => res.status(201).json(createTenancy(db, req.user, req.body?.tenancy)))
  app.get('/api/rent/tenancies/:id', (req, res) => res.json(tenancyDetail(db, req.user.id, parseId(req.params.id))))
  app.patch('/api/rent/tenancies/:id', (req, res) => res.json(updateTenancy(db, req.user, parseId(req.params.id), req.body?.tenancy)))
  app.post('/api/rent/dues/:id/payments', async (req, res) => res.json(await recordManualPayment(db, vs, req.user, parseId(req.params.id), req.body)))
  app.post('/api/rent/dues/:id/waive', async (req, res) => res.json(await waiveDue(db, vs, req.user, parseId(req.params.id), req.body?.note)))
  app.post('/api/rent/dues/:id/check', async (req, res) => res.json(await checkDueNow(db, vs, req.user, parseId(req.params.id))))
  app.post('/api/automations/rent_reminders/run', async (req, res) => res.json({ result: await automations.runRentNow(req.user) }))

  app.get('/api/reminders', (req, res) => res.json({ reminders: listReminders(db, req.user.id, req.query.status) }))
  app.post('/api/reminders/:id', (req, res) => res.json({ reminder: setReminderStatus(db, req.user.id, parseId(req.params.id), req.body?.status) }))

  app.use('/api', (req, res, next) => next(new AppError(404, 'not_found', 'No such endpoint.')))

  // The host's scheduler (Embarko schedules, every 15 minutes): runs Buyer Follow-Up Reminders for every broker
  // who switched them on. Only a caller holding the scheduler's secret gets in.
  app.get('/tasks/automations', async (req, res) => {
    const given = Buffer.from(createHash('sha256').update(req.get('authorization') || '').digest('hex'))
    const wanted = Buffer.from(createHash('sha256').update(`Bearer ${scheduler.secret || ''}`).digest('hex'))
    if (!scheduler.secret || !timingSafeEqual(given, wanted)) return res.status(401).type('text').send('unauthorized')
    const { reminders: t, viewingsEnded, rent } = await automations.runScheduled('Scheduled check')
    res.type('text').send(`Follow-ups: ${t.brokers} broker(s), ${t.created} new reminder(s), ${t.notified} notification(s) sent, ${t.failed} failed. ` +
      `Viewings ended: ${viewingsEnded}. Rent: ${rent.brokers} broker(s), ${rent.sent} reminder(s) sent, ${rent.failed} failed, ${rent.verified} payment(s) verified.`)
  })

  // The buyer's feedback page: a standalone page with no app code. The token in its URL is never sent on as a referrer.
  app.get('/feedback/:token', (req, res) => {
    res.set({ 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' })
    res.sendFile(join(ROOT, 'public', 'feedback.html'))
  })

  app.get('/vendor/viasocket-apps-browser.js', (req, res) => res.type('text/javascript').sendFile(VIASOCKET_BROWSER))
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
