// A buyer's interest in a listing ("I'm interested"), on the lead their requirements already created: interest never
// creates a lead. The buyer is always the signed-in user; the agent is the lead's assigned agent, who alone is told
// (in the app) and alone sees it. The listing's owner and its agent, when they are someone else, learn nothing from
// this feature. Viewings stay in the viewings table: a request shows the buyer's latest viewing of the listing.
import { randomUUID } from 'node:crypto'
import { now, transaction } from '../db.js'
import { AppError, validationError } from '../errors.js'
import { canViewProperty, requireAgentLead, requireRole } from '../access.js'
import { emit } from '../events/bus.js'
import { getLead, logActivity } from '../leads/service.js'
import { getProperty, viewProperty } from '../properties/service.js'
import { describeInZone } from '../time.js'
import { buyerOfferView } from '../offers/service.js'

export const STATUSES = ['open', 'withdrawn', 'closed']
const NOTE_MAX = 300
export const MAX_OPEN = 50 // open requests per buyer: enough for a real search, a bound on misuse
const REASON_MAX = 200

const textOrNull = (v, max, field) => {
  if (v === null || v === undefined || v === '') return null
  if (typeof v !== 'string') throw validationError({ [field]: 'Must be text.' })
  const s = v.trim().replace(/\s+/g, ' ')
  if (s.length > max) throw validationError({ [field]: `At most ${max} characters.` })
  return s || null
}

/** The signed-in buyer's own lead, or a 409 telling them to save requirements first (as viewing requests do). */
function buyerLead(db, buyer) {
  const prof = db.prepare('SELECT lead_id FROM buyer_profiles WHERE user_id = ?').get(buyer.id)
  const lead = prof?.lead_id ? getLead(db, prof.lead_id) : null
  if (!lead) throw new AppError(409, 'no_requirements', 'Save your requirements first, so your agent knows what you are looking for.')
  return lead
}

/**
 * The newest viewing of this listing on this lead. A buyer sees only what My viewings shows them (not an agent's
 * unsent draft); the agent sees every one.
 */
function latestViewing(db, leadId, propertyId, { forBuyer }) {
  const rows = db.prepare(`SELECT id, status, start_at, timezone, property_ids, requested_by FROM viewings WHERE lead_id = ?
                           ${forBuyer ? "AND (status != 'draft' OR requested_by IS NOT NULL)" : ''} ORDER BY created_at DESC, start_at DESC LIMIT 100`).all(leadId)
  const v = rows.find((r) => JSON.parse(r.property_ids).includes(propertyId))
  if (!v) return null
  const feedbackGiven = db.prepare('SELECT status FROM feedback_requests WHERE viewing_id = ?').get(v.id)?.status === 'submitted'
  return { id: v.id, status: v.status === 'draft' ? 'requested' : v.status, when: describeInZone(v.start_at, v.timezone), startAt: v.start_at, feedbackGiven }
}

const OFFER_ACTIVE = ['submitted', 'forwarded', 'countered', 'accepted']
/** The newest offer made on this request, if any (an active offer always belongs to the open request). */
const latestOffer = (db, row) => db.prepare('SELECT * FROM offers WHERE interest_id = ? ORDER BY created_at DESC, updated_at DESC LIMIT 1').get(row.id)
const activeOffer = (db, row) => db.prepare(`SELECT id FROM offers WHERE lead_id = ? AND property_id = ? AND status IN (${OFFER_ACTIVE.map(() => '?').join(',')})`).get(row.lead_id, row.property_id, ...OFFER_ACTIVE)
const OFFER_NEXT = {
  submitted: 'Your agent has your offer and will pass it to the owner.',
  forwarded: 'The owner is reviewing your offer.',
  countered: 'The owner made a counter-offer: accept it, answer with a new amount, or withdraw.',
  accepted: 'Accepted in principle. Your agent guides the next steps; nothing is final until an agreement is signed outside DealSaathi.',
  closed_won: 'Your agent recorded this as agreed. Any agreement and payment happen outside DealSaathi.'
}

/** What the buyer can do next with this request, worked out from its state, the listing, any offer and the viewing. */
function nextStep(row, { available, viewing, agentAssigned, offer }) {
  if (offer && OFFER_NEXT[offer.status]) return { type: `offer_${offer.status}`, label: OFFER_NEXT[offer.status] }
  if (row.status === 'closed') return { type: 'closed', label: 'Your agent closed this request.' }
  if (!available) return { type: 'unavailable', label: 'This listing is no longer available.' }
  if (row.status === 'withdrawn') return { type: 'express_again', label: 'You withdrew this request. You can show interest again.' }
  if (!agentAssigned) return { type: 'await_assignment', label: 'An agent will pick up your request soon.' }
  if (viewing?.status === 'requested') return { type: 'await_viewing', label: 'Your viewing request is waiting for your agent.' }
  if (viewing && ['booked', 'booking'].includes(viewing.status) && viewing.startAt > now()) return { type: 'viewing_booked', label: `Viewing booked for ${viewing.when}.` }
  if (viewing?.status === 'completed' && !viewing.feedbackGiven) return { type: 'give_feedback', label: 'Tell your agent how the viewing went.' }
  return { type: 'request_viewing', label: 'Request a viewing, make an offer, or wait for your agent to contact you.' }
}

function listingSummary(db, viewer, propertyId) {
  const p = getProperty(db, propertyId)
  const available = Boolean(p) && canViewProperty(viewer, p) && p.listing_state === 'published' && p.status === 'available'
  return {
    available,
    property: p
      ? { id: p.id, title: p.title, area: [p.locality, p.city].filter(Boolean).join(', '), listing_type: p.listing_type, price: p.price, bedrooms: p.bedrooms ?? null, available }
      : { id: propertyId, title: '(listing removed)', available: false }
  }
}

function forBuyer(db, buyer, row) {
  const lead = getLead(db, row.lead_id)
  const agent = lead?.assigned_agent_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(lead.assigned_agent_id) : null
  const { available, property } = listingSummary(db, buyer, row.property_id)
  const viewing = latestViewing(db, row.lead_id, row.property_id, { forBuyer: true })
  const o = latestOffer(db, row)
  const offer = o ? buyerOfferView(db, o) : null
  const owner = getProperty(db, row.property_id)?.owner_user_id
  return {
    id: row.id, status: row.status, note: row.note, closedReason: row.closed_reason, createdAt: row.created_at, updatedAt: row.updated_at,
    withdrawnAt: row.withdrawn_at, closedAt: row.closed_at, property, agentName: agent?.name ?? null, viewing, offer,
    canOffer: row.status === 'open' && available && Boolean(agent) && Boolean(owner) && !(offer && OFFER_ACTIVE.includes(offer.status)),
    next: nextStep(row, { available, viewing, agentAssigned: Boolean(agent), offer: offer && (OFFER_ACTIVE.includes(offer.status) || offer.status === 'closed_won') ? offer : null })
  }
}

function forAgent(db, agent, row) {
  const lead = getLead(db, row.lead_id)
  const p = getProperty(db, row.property_id)
  return {
    id: row.id, status: row.status, note: row.note, closedReason: row.closed_reason, createdAt: row.created_at, updatedAt: row.updated_at,
    withdrawnAt: row.withdrawn_at, closedAt: row.closed_at,
    lead: { id: row.lead_id, name: lead?.full_name ?? null },
    property: p ? { id: p.id, title: p.title, area: [p.locality, p.city].filter(Boolean).join(', '), listing_type: p.listing_type, price: p.price, status: p.status, listing_state: p.listing_state } : { id: row.property_id, title: '(listing removed)' },
    viewing: latestViewing(db, row.lead_id, row.property_id, { forBuyer: false })
  }
}

const ORDER = "ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, updated_at DESC, created_at DESC"

/**
 * "I'm interested". Returns { interest, created }: a second click (or a retry) while the request is open returns the
 * same request and queues nothing. After a withdrawal or a closure a new request is opened; the earlier one is kept.
 */
export function expressInterest(db, buyer, input = {}) {
  requireRole(buyer, 'buyer')
  const propertyId = Number(input.propertyId)
  if (!Number.isInteger(propertyId) || propertyId < 1) throw new AppError(404, 'property_not_found', 'No such property.')
  const note = textOrNull(input.note, NOTE_MAX, 'note')
  const lead = buyerLead(db, buyer)
  const listing = viewProperty(db, buyer, propertyId) // 404 for anything this buyer may not see
  if (listing.listing_state !== 'published' || listing.status !== 'available' || listing.is_sample) throw new AppError(409, 'listing_unavailable', 'This listing is no longer available.')
  const open = () => db.prepare("SELECT * FROM property_interests WHERE lead_id = ? AND property_id = ? AND status = 'open'").get(lead.id, propertyId)
  return transaction(db, () => {
    const existing = open()
    if (existing) return { interest: forBuyer(db, buyer, existing), created: false }
    if (db.prepare("SELECT COUNT(*) AS n FROM property_interests WHERE buyer_user_id = ? AND status = 'open'").get(buyer.id).n >= MAX_OPEN) {
      throw new AppError(409, 'too_many_interests', `You already have ${MAX_OPEN} open requests. Withdraw some in My requests first.`)
    }
    const id = randomUUID()
    const ts = now()
    try {
      db.prepare("INSERT INTO property_interests (id, lead_id, buyer_user_id, property_id, status, note, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?)")
        .run(id, lead.id, buyer.id, propertyId, note, ts, ts)
    } catch (error) {
      // Another connection opened the same request first (the partial unique index): answer with that one.
      const other = /UNIQUE/i.test(String(error?.message)) ? open() : null
      if (other) return { interest: forBuyer(db, buyer, other), created: false }
      throw error
    }
    logActivity(db, lead.id, 'interest_created', `The buyer is interested in ${listing.title}`, { interestId: id, propertyId }, 'buyer', buyer.id)
    emit(db, 'interest.created', { subjectType: 'interest', subjectId: id, actorId: buyer.id, agentId: lead.assigned_agent_id ?? null, dedupeKey: `interest.created:${id}` })
    return { interest: forBuyer(db, buyer, db.prepare('SELECT * FROM property_interests WHERE id = ?').get(id)), created: true }
  })
}

export function listBuyerInterests(db, buyer) {
  requireRole(buyer, 'buyer')
  return db.prepare(`SELECT * FROM property_interests WHERE buyer_user_id = ? ${ORDER} LIMIT 200`).all(buyer.id).map((r) => forBuyer(db, buyer, r))
}

/** Withdraws the buyer's own open request. Withdrawing one already withdrawn answers with its state. */
export function withdrawInterest(db, buyer, id) {
  requireRole(buyer, 'buyer')
  const row = db.prepare('SELECT * FROM property_interests WHERE id = ? AND buyer_user_id = ?').get(id, buyer.id)
  if (!row) throw new AppError(404, 'interest_not_found', 'No such request.')
  if (row.status === 'withdrawn') return { interest: forBuyer(db, buyer, row) }
  if (row.status === 'closed') throw new AppError(409, 'interest_closed', 'Your agent already closed this request.')
  if (activeOffer(db, row)) throw new AppError(409, 'offer_active', 'You have an active offer on this listing. Withdraw the offer first.')
  return transaction(db, () => {
    const ts = now()
    const changed = db.prepare("UPDATE property_interests SET status = 'withdrawn', withdrawn_at = ?, updated_at = ? WHERE id = ? AND status = 'open'").run(ts, ts, row.id).changes
    if (changed) {
      const lead = getLead(db, row.lead_id)
      logActivity(db, row.lead_id, 'interest_withdrawn', `The buyer withdrew their interest in ${getProperty(db, row.property_id)?.title ?? 'a listing'}`, { interestId: row.id, propertyId: row.property_id }, 'buyer', buyer.id)
      emit(db, 'interest.withdrawn', { subjectType: 'interest', subjectId: row.id, actorId: buyer.id, agentId: lead?.assigned_agent_id ?? null, dedupeKey: `interest.withdrawn:${row.id}` })
    }
    return { interest: forBuyer(db, buyer, db.prepare('SELECT * FROM property_interests WHERE id = ?').get(row.id)) }
  })
}

/** Every request on the leads this agent is assigned to (open ones by default). */
export function listAgentInterests(db, agent, { status = 'open' } = {}) {
  requireRole(agent, 'agent')
  if (status !== 'all' && !STATUSES.includes(status)) throw validationError({ status: 'Unknown status.' })
  const rows = db.prepare(`SELECT i.* FROM property_interests i JOIN leads l ON l.id = i.lead_id
                           WHERE l.assigned_agent_id = ? ${status === 'all' ? '' : 'AND i.status = ?'} ORDER BY CASE i.status WHEN 'open' THEN 0 ELSE 1 END, i.updated_at DESC LIMIT 500`)
    .all(...(status === 'all' ? [agent.id] : [agent.id, status]))
  return rows.map((r) => forAgent(db, agent, r))
}

/** The requests on one lead, for its assigned agent only (404 otherwise, like the lead itself). */
export function leadInterests(db, agent, leadId) {
  requireAgentLead(db, agent, leadId)
  return db.prepare(`SELECT * FROM property_interests WHERE lead_id = ? ${ORDER} LIMIT 200`).all(leadId).map((r) => forAgent(db, agent, r))
}

/** The assigned agent closes an open request (handled, not a fit…). Closing one already closed answers with it. */
export function closeInterest(db, agent, id, input = {}) {
  requireRole(agent, 'agent')
  const reason = textOrNull(input.reason, REASON_MAX, 'reason')
  const row = db.prepare('SELECT i.* FROM property_interests i JOIN leads l ON l.id = i.lead_id WHERE i.id = ? AND l.assigned_agent_id = ?').get(id, agent.id)
  if (!row) throw new AppError(404, 'interest_not_found', 'No such request.')
  if (row.status === 'closed') return { interest: forAgent(db, agent, row) }
  if (row.status === 'withdrawn') throw new AppError(409, 'interest_not_open', 'The buyer already withdrew this request.')
  if (activeOffer(db, row)) throw new AppError(409, 'offer_active', 'This buyer has an active offer on the listing. Record its outcome in Offers first.')
  return transaction(db, () => {
    const ts = now()
    const changed = db.prepare("UPDATE property_interests SET status = 'closed', closed_reason = ?, closed_at = ?, updated_at = ? WHERE id = ? AND status = 'open'").run(reason, ts, ts, row.id).changes
    if (changed) {
      logActivity(db, row.lead_id, 'interest_closed', `Interest in ${getProperty(db, row.property_id)?.title ?? 'a listing'} closed${reason ? `: ${reason}` : ''}`, { interestId: row.id, propertyId: row.property_id }, 'agent', agent.id)
      emit(db, 'interest.closed', { subjectType: 'interest', subjectId: row.id, actorId: agent.id, agentId: agent.id, dedupeKey: `interest.closed:${row.id}` })
    }
    return { interest: forAgent(db, agent, db.prepare('SELECT * FROM property_interests WHERE id = ?').get(row.id)) }
  })
}

/**
 * The event handler: tells the buyer's assigned agent, in the app only. One notification per lead, listing and day,
 * so withdrawing and re-expressing interest cannot flood the agent. Nobody else is told: not the listing's owner,
 * not the listing's agent when that is someone else. An unassigned lead's agent sees the request once they claim it.
 */
export function createInterestHandler({ db, notifyInApp }) {
  return async function onInterest(event) {
    const row = db.prepare('SELECT * FROM property_interests WHERE id = ?').get(event.subjectId)
    if (!row) return { skipped: 'request deleted' }
    if (row.status !== 'open') return { skipped: `request ${row.status}` }
    const lead = getLead(db, row.lead_id)
    if (!lead?.assigned_agent_id) return { skipped: 'no agent assigned yet' }
    const p = getProperty(db, row.property_id)
    const day = row.created_at.slice(0, 10)
    const id = notifyInApp(db, lead.assigned_agent_id, {
      kind: 'interest', title: `${lead.full_name} is interested in ${p?.title ?? 'a listing'}`, body: row.note || null, link: `#/leads/${lead.id}`,
      subjectType: 'interest', subjectId: row.id, dedupeKey: `interest:${lead.id}:${row.property_id}:${day}`, eventId: event.id
    })
    return { notified: id ? ['agent'] : [], ...(id ? {} : { deduplicated: true }) }
  }
}
