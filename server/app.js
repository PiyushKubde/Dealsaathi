import express from 'express'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { now } from './db.js'
import { AppError } from './errors.js'
import { createLead, deleteLead, leadStats, listActivities, listLeads, requireLead, updateLead } from './leads/service.js'
import { allow, requireAgentLead } from './access.js'
import { createEventProcessor, listEvents } from './events/bus.js'
import { createHandlers } from './events/handlers.js'
import { listDeliveries, listNotifications, markAllRead, markRead } from './notifications/service.js'
import { agentForSeller, buyerRecommendations, claimLead, getProfile, listAgents, saveBuyerRequirements, transferLead, unassignedPool, updateAgentProfile, updateSellerProfile } from './profiles/service.js'
import { storedMatchesForLead } from './matching/engine.js'
import { sendLiveTest, verifyAccess } from './integrations/run.js'
import { createMailer } from './mail.js'
import { requestPasswordReset, resetPassword, sendVerification, verificationState, verifyEmail } from './accounts.js'
import { acceptInvite, createInvite, previewInvite, revokeInvites, unlinkParty } from './rent/service.js'
import { cancelAction, confirmAction, handleMessage, loadConversation } from './assistant/service.js'
import { cancelAgentAction, confirmAgentAction, deleteAgentConversation, handleAgentMessage, loadAgentConversation } from './agent/runtime.js'
import { createAuth } from './auth.js'
import { createHash, timingSafeEqual } from 'node:crypto'
import { disconnect, listUserConnections, reconnectDetails, requireViasocket, saveConnection, viasocketError } from './integrations/service.js'
import { curatedApps, requireCuratedServiceId } from './integrations/apps.js'
import { GMAIL, cancelFollowup, draftFollowup, draftRecommendation, followupSetup, fromOptions, listFollowups, prepareFollowup, sendFollowup } from './followups/service.js'
import { createAutomationEngine } from './automations/engine.js'
import { listReminders, setReminderStatus } from './automations/reminders.js'
import { bookViewing, buyerCancel, buyerSlots, cancelViewing, draftViewing, freeSlots, getViewing, listBuyerViewings, listListingViewings, listViewings, requestViewing, rescheduleViewing, resendConfirmation, setOutcome } from './viewings/service.js'
import { baseUrl, listFeedback, onViewingCompleted, publicFeedback, resendFeedback, submitBuyerFeedback, submitFeedback } from './feedback/service.js'
import { checkDueNow, createTenancy, partyTenancies, partyTenancy, recordManualPayment, rentOverview, tenancyDetail, updateTenancy, waiveDue } from './rent/service.js'
import { addSampleProperties, createProperty, deleteProperty, dismissMatch, listProperties, listPropertyMatches, setAgentForSeller, setListingState, updateProperty, viewProperty } from './properties/service.js'

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
export function createApp({ db, ai, vs = { configured: false }, auth = createAuth({ db }), behindProxy = false, scheduler = { available: false, secret: null }, mailConnection = null, backups = { enabled: false, due: () => null }, backupToken = null }) {
  const mailer = createMailer({ db, vs, connectionId: mailConnection })
  const automations = createAutomationEngine({ db, vs, scheduler })
  setAgentForSeller(agentForSeller)
  // The processing path for platform events (see events/bus.js): kicked after each change, by the scheduler, and on start.
  const events = createEventProcessor({ db, handlers: createHandlers({ db, notifyThrough: automations.notifyThrough, leadAlertMessage: automations.leadAlertMessage }) })
  const app = express()
  app.locals.automations = automations
  app.locals.events = events
  app.locals.mailer = mailer
  // Any request that wrote something may have queued events: process them once the answer is on its way.
  app.use((req, res, next) => {
    if (req.method !== 'GET') res.on('finish', () => { if (res.statusCode < 400) events.kick() })
    next()
  })
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
  // Account links from email: verify the address, reset a forgotten password. Reachable without a session,
  // rate-limited per address so they cannot be used to flood mailboxes or guess tokens.
  const accountHits = new Map()
  const limitAccount = (req, max = 10) => {
    const key = `${req.path}:${req.ip || 'unknown'}`
    const e = accountHits.get(key)
    if (!e || e.reset < Date.now()) accountHits.set(key, { n: 1, reset: Date.now() + 15 * 60 * 1000 })
    else if (++e.n > max) throw new AppError(429, 'too_many_requests', 'Too many requests. Try again in 15 minutes.')
  }
  app.get('/api/session/mail', (req, res) => res.json(mailer.status()))
  app.post('/api/session/verify-email', (req, res) => { limitAccount(req, 20); res.json(verifyEmail(db, req.body?.token)) })
  app.post('/api/session/password/forgot', async (req, res) => { limitAccount(req, 5); res.status(202).json(await requestPasswordReset(db, mailer, req.body?.email, baseUrl(req))) })
  app.post('/api/session/password/reset', (req, res) => { limitAccount(req, 10); res.json(resetPassword(db, req.body?.token, req.body?.password)) })
  app.use('/api', (req, res, next) => auth.guard(req, res, next))
  app.get('/api/me/verification', (req, res) => res.json({ ...verificationState(db, req.user.id), mail: mailer.status() }))
  app.post('/api/me/verification/send', async (req, res) => res.json(await sendVerification(db, mailer, req.user, baseUrl(req))))
  // Tenancy invitations: the invited person accepts while signed in with the invited email and role.
  app.post('/api/invites/preview', (req, res) => { limitAccount(req, 30); res.json(previewInvite(db, req.user, req.body?.token)) })
  app.post('/api/invites/accept', (req, res) => { limitAccount(req, 30); res.json(acceptInvite(db, req.user, req.body?.token)) })

  app.get('/api/health', (req, res) => {
    let database = 'ok'
    try {
      db.prepare('SELECT 1').get()
    } catch {
      database = 'error'
    }
    res.status(database === 'ok' ? 200 : 503).json({ ok: database === 'ok', database, ai: ai.configured ? 'configured' : 'not_configured', viasocket: vs.configured ? 'configured' : 'not_configured', access: auth.mode, time: now() })
  })

  // ---- Who am I, my profile, my notifications (every role)
  app.get('/api/me', (req, res) => res.json({ user: req.user, profile: getProfile(db, req.user) }))
  app.patch('/api/me/profile', (req, res) => {
    if (req.user.role === 'agent') return res.json({ profile: updateAgentProfile(db, req.user, req.body || {}) })
    if (req.user.role === 'seller') return res.json({ profile: updateSellerProfile(db, req.user, req.body || {}) })
    res.json({ profile: saveBuyerRequirements(db, req.user, { ...req.body, requirements: {} }) })
  })
  app.get('/api/notifications', (req, res) => res.json(listNotifications(db, req.user.id, { unreadOnly: req.query.unread === '1', limit: req.query.limit })))
  app.post('/api/notifications/read-all', (req, res) => res.json(markAllRead(db, req.user.id)))
  app.post('/api/notifications/:id/read', (req, res) => res.json(markRead(db, req.user.id, parseId(req.params.id))))

  // ---- Buyers: requirements, recommendations, viewings, feedback
  app.put('/api/me/requirements', allow('buyer'), (req, res) => res.json({ profile: saveBuyerRequirements(db, req.user, req.body || {}) }))
  app.get('/api/me/recommendations', allow('buyer'), (req, res) => res.json(buyerRecommendations(db, req.user)))
  app.get('/api/me/viewings', allow('buyer'), (req, res) => res.json({ viewings: listBuyerViewings(db, req.user) }))
  const buyerHits = new Map()
  const limitBuyer = (req) => { // each slot lookup reads the agent's calendar: keep it to a human pace
    const e = buyerHits.get(req.user.id)
    if (!e || e.reset < Date.now()) buyerHits.set(req.user.id, { n: 1, reset: Date.now() + 15 * 60 * 1000 })
    else if (++e.n > 40) throw new AppError(429, 'too_many_requests', 'Too many availability checks. Try again in a few minutes.')
  }
  app.get('/api/me/viewing-slots', allow('buyer'), async (req, res) => { limitBuyer(req); res.json(await buyerSlots(db, vs, req.user, { propertyId: Number(req.query.propertyId), date: req.query.date })) })
  app.post('/api/me/viewings', allow('buyer'), async (req, res) => { limitBuyer(req); res.status(201).json(await requestViewing(db, vs, req.user, req.body || {})) })
  app.post('/api/me/viewings/:id/cancel', allow('buyer'), async (req, res) => res.json(await buyerCancel(db, vs, req.user, parseUuid(req.params.id, 'viewing'))))
  app.post('/api/me/viewings/:id/feedback', allow('buyer'), (req, res) => res.json(submitBuyerFeedback(db, req.user, parseUuid(req.params.id, 'viewing'), req.body || {})))
  // ---- The buyer's AI assistant (server/agent): a bounded loop over fixed, permission-checked tools. A viewing
  // request it prepares is sent only by the buyer's Confirm, and booked only when their agent confirms.
  app.post('/api/agent/messages', allow('buyer'), async (req, res) => {
    const { conversationId, message } = req.body || {}
    res.json(await handleAgentMessage(db, ai, vs, req.user, { conversationId: conversationId == null ? null : parseUuid(conversationId, 'conversation'), message }))
  })
  app.get('/api/agent/conversations/:id', allow('buyer'), (req, res) => res.json(loadAgentConversation(db, req.user, parseUuid(req.params.id, 'conversation'))))
  app.delete('/api/agent/conversations/:id', allow('buyer'), (req, res) => res.json(deleteAgentConversation(db, req.user, parseUuid(req.params.id, 'conversation'))))
  app.post('/api/agent/actions/:id/confirm', allow('buyer'), async (req, res) => res.json(await confirmAgentAction(db, vs, req.user, parseUuid(req.params.id, 'action'))))
  app.post('/api/agent/actions/:id/cancel', allow('buyer'), (req, res) => res.json(cancelAgentAction(db, req.user, parseUuid(req.params.id, 'action'))))
  // ---- Tenants and landlords: their tenancies (read), landlords record payments they received
  app.get('/api/me/tenancies', allow('buyer', 'seller'), (req, res) => res.json({ tenancies: partyTenancies(db, req.user) }))
  app.get('/api/me/tenancies/:id', allow('buyer', 'seller'), (req, res) => res.json(partyTenancy(db, req.user, parseId(req.params.id))))
  app.post('/api/me/rent/dues/:id/payments', allow('seller'), async (req, res) => res.json(await recordManualPayment(db, vs, req.user, parseId(req.params.id), req.body)))
  // ---- Sellers: viewings on their listings (no buyer details)
  app.get('/api/me/listing-viewings', allow('seller'), (req, res) => res.json({ viewings: listListingViewings(db, req.user) }))

  // ---- Agents: dashboard, the unassigned pool, the event log
  app.get('/api/dashboard', allow('agent'), (req, res) => res.json(leadStats(db, req.user.id)))
  app.get('/api/agents', allow('agent'), (req, res) => res.json({ agents: listAgents(db) }))
  app.get('/api/pool', allow('agent'), (req, res) => res.json({ leads: unassignedPool(db) }))
  app.post('/api/pool/:id/claim', allow('agent'), (req, res) => res.json({ lead: claimLead(db, req.user, parseId(req.params.id)) }))
  app.get('/api/events', allow('agent'), (req, res) => res.json({ events: listEvents(db, { agentId: req.user.id, status: ['failed', 'pending', 'done'].includes(req.query.status) ? req.query.status : null }) }))
  app.get('/api/deliveries', allow('agent'), (req, res) => res.json({ deliveries: listDeliveries(db, req.user.id) }))

  // Everything below about leads, the assistant, follow-ups, automations, integrations, agent viewings,
  // feedback and rent management is for agents only.
  for (const path of ['/api/leads', '/api/assistant', '/api/followups', '/api/automations', '/api/integrations', '/api/viewings', '/api/feedback', '/api/rent', '/api/reminders']) app.use(path, allow('agent'))

  app.get('/api/leads', (req, res) => {
    const { q, customer_type, status, location, follow_up, limit, offset } = req.query
    res.json(listLeads(db, { agentId: req.user.id, q, customer_type, status, location, follow_up: follow_up === '1', limit, offset }))
  })
  // Agents' own routes on one lead first check that it is theirs (else 404).
  app.use('/api/leads/:id', (req, res, next) => {
    try { requireAgentLead(db, req.user, parseId(req.params.id)); next() } catch (error) { next(error) }
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
    // lead.created is queued in the same transaction: matching and New Lead Alert run from the event queue.
    const lead = createLead(db, fields, { via: 'form', allowSameName: allowSameName === true, userId: req.user.id })
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
    res.json(confirmAction(db, parseUuid(req.params.id, 'action'), { fields, allowSameName: allowSameName === true, userId: req.user.id }))
  })
  app.post('/api/leads/:id/transfer', (req, res) => res.json({ lead: transferLead(db, req.user, parseId(req.params.id), req.body?.agentId) }))

  app.post('/api/assistant/actions/:id/cancel', (req, res) => {
    res.json(cancelAction(db, parseUuid(req.params.id, 'action'), req.user.id))
  })

  // ---- Listings. Saving or publishing queues property.* events; matching runs from the queue, for every role.
  app.get('/api/properties', (req, res) => {
    const { scope, q, listing_type, city, status } = req.query
    res.json({ properties: listProperties(db, req.user, { scope: ['mine', 'market'].includes(scope) ? scope : undefined, q, listing_type, city, status }) })
  })
  app.post('/api/properties', allow('agent', 'seller'), (req, res) => {
    const out = createProperty(db, req.body?.property, { actor: req.user, publish: typeof req.body?.publish === 'boolean' ? req.body.publish : undefined })
    res.status(201).json({ property: viewProperty(db, req.user, out.property.id) })
  })
  app.post('/api/properties/samples', allow('agent'), (req, res) => res.status(201).json({ properties: addSampleProperties(db, req.user) }))
  app.get('/api/properties/:id', (req, res) => {
    const property = viewProperty(db, req.user, parseId(req.params.id))
    const matches = req.user.role === 'buyer' ? null : listPropertyMatches(db, property.id, req.user)
    res.json({ property, ...(matches ? (property.mine || req.user.role === 'agent' ? matches : { matches: [], otherBuyers: matches.otherBuyers }) : {}) })
  })
  app.patch('/api/properties/:id', allow('agent', 'seller'), (req, res) => {
    const out = updateProperty(db, parseId(req.params.id), req.body?.property, { actor: req.user })
    res.json({ property: viewProperty(db, req.user, out.property.id) })
  })
  for (const action of ['publish', 'unpublish', 'archive']) {
    app.post(`/api/properties/:id/${action}`, allow('agent', 'seller'), (req, res) => {
      const out = setListingState(db, req.user, parseId(req.params.id), action)
      res.json({ property: viewProperty(db, req.user, out.property.id) })
    })
  }
  app.delete('/api/properties/:id', allow('agent', 'seller'), (req, res) => res.json({ deleted: true, property: deleteProperty(db, req.user, parseId(req.params.id)) }))
  app.post('/api/properties/:id/matches/:leadId/dismiss', allow('agent'), (req, res) => res.json(dismissMatch(db, req.user, parseId(req.params.id), parseId(req.params.leadId))))
  app.get('/api/leads/:id/matches', (req, res) => {
    res.json({ matches: storedMatchesForLead(db, parseId(req.params.id)).map(({ property, ...m }) => ({ property, ...m })) })
  })

  // ---- Integrations: only the curated apps, each connected through the official Connect popup
  // (https://flow.viasocket.com/documentation/skill/connect.md). There is no open app catalog.
  app.get('/api/integrations/apps', async (req, res) => {
    requireViasocket(vs)
    const [apps, { connections, live, error }] = await Promise.all([curatedApps(vs), listUserConnections(db, vs, req.user.id)])
    res.json({
      apps: apps.map(({ slug, name, purpose, usedBy, inUse, liveBlocked, serviceId, iconUrl, actions, error: appError }) => ({
        slug, name, purpose, usedBy, inUse, liveBlocked, serviceId, iconUrl, actions, error: appError,
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
  app.post('/api/integrations/connections/:id/verify', async (req, res) => { requireViasocket(vs); res.json(await verifyAccess(db, vs, req.user.id, parseId(req.params.id))) })
  app.post('/api/integrations/connections/:id/test', async (req, res) => {
    requireViasocket(vs)
    if (req.body?.confirm !== true) throw new AppError(400, 'confirm_required', 'Confirm the test: it sends a real email or message, or creates and deletes a real calendar event.')
    res.json(await sendLiveTest(db, vs, req.user, parseId(req.params.id), { slackChannelId: req.body?.slackChannelId, calendarId: req.body?.calendarId }))
  })

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
    const lead = requireLead(db, id)
    const consent = !lead.buyer_user_id || Boolean(db.prepare('SELECT allow_agent_email FROM buyer_profiles WHERE user_id = ?').get(lead.buyer_user_id)?.allow_agent_email)
    res.json({ ...followupSetup(db, req.user.id, id, await gmailId()), viasocket: vs.configured, ai: ai.configured, emailConsent: consent, followups: listFollowups(db, id) })
  })
  app.get('/api/followups/from-options', async (req, res) => res.json({ options: await fromOptions(db, vs, req.user.id, parseId(req.query.connectionId)) }))
  app.post('/api/leads/:id/followups/draft', async (req, res) => res.json(await draftFollowup(db, ai, req.user, parseId(req.params.id))))
  app.post('/api/leads/:id/recommendations/draft', (req, res) => res.json(draftRecommendation(db, req.user, parseId(req.params.id), req.body?.propertyIds)))
  app.post('/api/leads/:id/followups', async (req, res) => res.status(201).json(await prepareFollowup(db, vs, req.user, parseId(req.params.id), req.body)))
  app.post('/api/followups/:id/send', async (req, res) => res.json(await sendFollowup(db, vs, req.user, parseUuid(req.params.id, 'followup'))))
  app.post('/api/followups/:id/cancel', (req, res) => res.json(cancelFollowup(db, req.user, parseUuid(req.params.id, 'followup'))))
  app.post('/api/events/:id/retry', allow('agent'), (req, res) => {
    const id = parseId(req.params.id)
    const e = db.prepare('SELECT agent_id, actor_id FROM domain_events WHERE id = ?').get(id)
    if (!e || (e.agent_id !== req.user.id && e.actor_id !== req.user.id)) throw new AppError(404, 'event_not_found', 'No such event.')
    if (!events.retry(id)) throw new AppError(409, 'not_failed', 'Only an event that failed can be retried.')
    res.json({ retried: true })
  })

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
  app.post('/api/viewings', (req, res) => { requireAgentLead(db, req.user, Number(req.body?.leadId)); res.status(201).json(draftViewing(db, req.user, req.body)) })
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
  app.post('/api/rent/tenancies/:id/invites', (req, res) => {
    const inv = createInvite(db, req.user, parseId(req.params.id), req.body?.party)
    // The link is returned once, for the agent to pass on; it is not stored.
    res.status(201).json({ party: inv.party, email: inv.email, expiresAt: inv.expiresAt, link: `${baseUrl(req)}/#/invite/${inv.token}` })
  })
  app.post('/api/rent/tenancies/:id/invites/revoke', (req, res) => res.json(revokeInvites(db, req.user, parseId(req.params.id), req.body?.party)))
  app.post('/api/rent/tenancies/:id/unlink', (req, res) => res.json(unlinkParty(db, req.user, parseId(req.params.id), req.body?.party)))
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
  const bearerIs = (req, secret) => {
    const given = Buffer.from(createHash('sha256').update(req.get('authorization') || '').digest('hex'))
    const wanted = Buffer.from(createHash('sha256').update(`Bearer ${secret || ''}`).digest('hex'))
    return Boolean(secret) && timingSafeEqual(given, wanted)
  }
  // Off-host copies: the owner downloads the newest verified backup with BACKUP_TOKEN (at least 32 characters).
  const backupAllowed = (req) => typeof backupToken === 'string' && backupToken.length >= 32 && bearerIs(req, backupToken)
  app.get('/tasks/backups', (req, res) => {
    if (!backupAllowed(req)) return res.status(401).type('text').send('unauthorized')
    res.set('Cache-Control', 'no-store').json({ enabled: backups.enabled, backups: backups.enabled ? backups.list() : [] })
  })
  app.get('/tasks/backups/latest', (req, res) => {
    if (!backupAllowed(req)) return res.status(401).type('text').send('unauthorized')
    const last = backups.enabled ? backups.latest() : null
    if (!last) return res.status(404).type('text').send('no verified backup yet')
    res.set({ 'Cache-Control': 'no-store', 'X-Backup-Sha256': last.sha256, 'Content-Disposition': `attachment; filename="${last.file}"` })
    res.sendFile(last.path)
  })

  app.get('/tasks/automations', async (req, res) => {
    if (!bearerIs(req, scheduler.secret)) return res.status(401).type('text').send('unauthorized')
    const backup = backups.enabled ? backups.due() : null
    const before = await events.drain() // anything a crash or a failed attempt left in the queue
    const { reminders: t, viewingsEnded, rent } = await automations.runScheduled('Scheduled check')
    const after = await events.drain()
    const pending = db.prepare("SELECT COUNT(*) AS n FROM domain_events WHERE status IN ('pending','processing')").get().n
    const failed = db.prepare("SELECT COUNT(*) AS n FROM domain_events WHERE status = 'failed'").get().n
    res.type('text').send(`Events: ${before.done + after.done} processed, ${before.retry + after.retry} to retry, ${pending} waiting, ${failed} failed in total. ` +
      `Follow-ups: ${t.brokers} agent(s), ${t.created} new reminder(s), ${t.notified} notification(s) sent, ${t.failed} failed. ` +
      `Viewings ended: ${viewingsEnded}. Rent: ${rent.brokers} agent(s), ${rent.sent} reminder(s) sent, ${rent.failed} failed, ${rent.verified} payment(s) verified. ` +
      `Backup: ${!backups.enabled ? 'not configured' : !backup ? `up to date (${backups.latest()?.file ?? 'none'})` : backup.error ? `FAILED (${backup.error})` : `${backup.file} verified`}.`)
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
