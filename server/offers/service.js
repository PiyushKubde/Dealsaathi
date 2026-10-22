// Offers (to buy) and rental applications (to rent), made on the buyer's open interest in a listing.
// The buyer's assigned agent receives each one and forwards it to the listing's owner (a seller, or the agent who
// listed it), who accepts in principle, rejects or counters; the buyer can accept a counter, revise or withdraw; the
// buyer's agent records the outcome. Every move is a conditional update from one allowed state, so a double click or
// a race changes nothing twice. The owner never sees who the buyer is, only their agent's name.
// "Accepted" is accepted in principle: no sale agreement, payment, signature or transfer happens in DealSaathi.
import { randomUUID } from 'node:crypto'
import { now, transaction } from '../db.js'
import { AppError, validationError } from '../errors.js'
import { requireRole } from '../access.js'
import { emit } from '../events/bus.js'
import { getLead, logActivity } from '../leads/service.js'
import { getProperty } from '../properties/service.js'

export const ACTIVE = ['submitted', 'forwarded', 'countered', 'accepted']
export const STATUSES = [...ACTIVE, 'rejected', 'withdrawn', 'closed_won', 'closed_lost']
const AMOUNT_MAX = 1e11
const NOTE_MAX = 500
export const DISCLAIMER = 'Accepted in principle only: this is not a sale or rental agreement, a payment or a transfer. Your agent guides the next steps, which happen outside DealSaathi.'

const text = (v, field, max = NOTE_MAX) => {
  if (v === null || v === undefined || v === '') return null
  if (typeof v !== 'string') throw validationError({ [field]: 'Must be text.' })
  const s = v.trim().replace(/\s+/g, ' ')
  if (s.length > max) throw validationError({ [field]: `At most ${max} characters.` })
  return s || null
}
const amountOf = (v, field = 'amount') => {
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v
  if (!Number.isInteger(n) || n < 1 || n > AMOUNT_MAX) throw validationError({ [field]: 'Enter an amount in rupees (a whole number).' })
  return n
}
const dateOf = (v) => {
  if (v === null || v === undefined || v === '') return null
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw validationError({ moveInDate: 'Use a date (YYYY-MM-DD).' })
  return v
}
const offerRow = (db, id) => db.prepare('SELECT * FROM offers WHERE id = ?').get(id)
const history = (db, id) => db.prepare('SELECT actor_role, from_status, to_status, amount, note, created_at FROM offer_events WHERE offer_id = ? ORDER BY id').all(id)
  .map((e) => ({ by: e.actor_role, from: e.from_status, to: e.to_status, amount: e.amount, note: e.note, at: e.created_at }))
const agentNameOf = (db, lead) => (lead?.assigned_agent_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(lead.assigned_agent_id)?.name ?? null : null)
const listing = (db, id) => {
  const p = getProperty(db, id)
  return p ? { id: p.id, title: p.title, area: [p.locality, p.city].filter(Boolean).join(', '), listing_type: p.listing_type, price: p.price, status: p.status, listing_state: p.listing_state } : { id, title: '(listing removed)' }
}
const base = (r) => ({ id: r.id, kind: r.kind, amount: r.amount, terms: r.terms, moveInDate: r.move_in_date, status: r.status, counterAmount: r.counter_amount, ownerNote: r.owner_note, createdAt: r.created_at, updatedAt: r.updated_at, disclaimer: r.status === 'accepted' || r.status === 'closed_won' ? DISCLAIMER : null })

/** What the buyer sees: their offer, the owner's answer and the history. */
export function buyerOfferView(db, r) {
  return { ...base(r), interestId: r.interest_id, property: listing(db, r.property_id), agentName: agentNameOf(db, getLead(db, r.lead_id)), history: history(db, r.id) }
}
/** What the buyer's agent sees: everything, with the buyer's name. */
function agentView(db, r) {
  const lead = getLead(db, r.lead_id)
  const p = getProperty(db, r.property_id)
  const owner = p?.owner_user_id ? db.prepare('SELECT name, role FROM users WHERE id = ?').get(p.owner_user_id) : null
  return { ...base(r), agentNote: r.agent_note, lead: { id: r.lead_id, name: lead?.full_name ?? null }, property: listing(db, r.property_id), owner: owner ? { name: owner.name, role: owner.role } : null, forwarded: Boolean(r.forwarded), history: history(db, r.id) }
}
/** What the listing's owner sees: the terms and the buyer's agent, never the buyer. */
function ownerView(db, r) {
  return { ...base(r), property: listing(db, r.property_id), buyerAgentName: agentNameOf(db, getLead(db, r.lead_id)), history: history(db, r.id) }
}

/**
 * Moves an offer from one of `from` to `to` and records it, all in one transaction. A concurrent or repeated move
 * finds the row changed and gets 409; nothing is written twice. `extra` sets other columns in the same update.
 */
function move(db, r, { from, to, actor, role, amount = null, note = null, extra = {} }) {
  if (!from.includes(r.status)) throw new AppError(409, 'offer_state', `This ${r.kind === 'application' ? 'application' : 'offer'} is ${r.status.replace('_', ' ')}, so that is not possible now.`)
  return transaction(db, () => {
    const ts = now()
    const sets = Object.keys(extra).map((k) => `${k} = ?`)
    const changed = db.prepare(`UPDATE offers SET status = ?, updated_at = ?${sets.length ? `, ${sets.join(', ')}` : ''} WHERE id = ? AND status = ? AND updated_at = ?`)
      .run(to, ts, ...Object.values(extra), r.id, r.status, r.updated_at).changes
    if (!changed) throw new AppError(409, 'offer_changed', 'Someone else just changed this. Reload to see its state.')
    const ev = db.prepare('INSERT INTO offer_events (offer_id, actor_id, actor_role, from_status, to_status, amount, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, actor.id, role, r.status, to, amount, note, ts)
    const what = r.kind === 'application' ? 'Rental application' : 'Offer'
    logActivity(db, r.lead_id, `offer_${to}`, `${what} on ${getProperty(db, r.property_id)?.title ?? 'a listing'}: ${to.replace('_', ' ')}${amount ? ` (₹${Number(amount).toLocaleString('en-IN')})` : ''}`, { offerId: r.id }, role === 'owner' ? 'listing_owner' : role, actor.id)
    emit(db, 'offer.changed', { subjectType: 'offer', subjectId: r.id, actorId: actor.id, payload: { from: r.status, to, eventId: Number(ev.lastInsertRowid) }, dedupeKey: `offer.changed:${ev.lastInsertRowid}` })
    return offerRow(db, r.id)
  })
}

// ---- Buyer

function buyerLead(db, buyer) {
  const prof = db.prepare('SELECT lead_id FROM buyer_profiles WHERE user_id = ?').get(buyer.id)
  const lead = prof?.lead_id ? getLead(db, prof.lead_id) : null
  if (!lead) throw new AppError(409, 'no_requirements', 'Save your requirements first, so your agent knows what you are looking for.')
  return lead
}
function ownOffer(db, buyer, id) {
  const r = db.prepare('SELECT * FROM offers WHERE id = ? AND buyer_user_id = ?').get(id, buyer.id)
  if (!r) throw new AppError(404, 'offer_not_found', 'No such offer.')
  return r
}

/**
 * The buyer makes an offer (sale) or applies (rent) on a listing they have an open interest in. Their agent must be
 * assigned (they forward it). A second submission while one is active returns that one: { offer, created: false }.
 */
export function submitOffer(db, buyer, input = {}) {
  requireRole(buyer, 'buyer')
  const propertyId = Number(input.propertyId)
  if (!Number.isInteger(propertyId) || propertyId < 1) throw new AppError(404, 'property_not_found', 'No such property.')
  const amount = amountOf(input.amount)
  const terms = text(input.terms, 'terms')
  const lead = buyerLead(db, buyer)
  const active = () => db.prepare(`SELECT * FROM offers WHERE lead_id = ? AND property_id = ? AND status IN (${ACTIVE.map(() => '?').join(',')})`).get(lead.id, propertyId, ...ACTIVE)
  const existing = active()
  if (existing) return { offer: buyerOfferView(db, existing), created: false }
  const interest = db.prepare("SELECT * FROM property_interests WHERE lead_id = ? AND property_id = ? AND status = 'open'").get(lead.id, propertyId)
  if (!interest) throw new AppError(409, 'interest_required', 'Press “I’m interested” on this listing first, so your agent knows.')
  const p = getProperty(db, propertyId)
  if (!p || p.listing_state !== 'published' || p.status !== 'available' || p.is_sample) throw new AppError(409, 'listing_unavailable', 'This listing is no longer available.')
  if (!lead.assigned_agent_id) throw new AppError(409, 'no_agent', 'No agent is assigned to you yet. Your agent passes offers to the owner, so wait until one picks up your requirements.')
  if (!p.owner_user_id) throw new AppError(409, 'no_owner', 'This listing has no owner in DealSaathi to send an offer to. Ask your agent.')
  const kind = p.listing_type === 'rent' ? 'application' : 'offer'
  const moveIn = kind === 'application' ? dateOf(input.moveInDate) : null
  const id = randomUUID()
  const ts = now()
  return transaction(db, () => {
    try {
      db.prepare("INSERT INTO offers (id, interest_id, lead_id, buyer_user_id, property_id, kind, amount, terms, move_in_date, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?)")
        .run(id, interest.id, lead.id, buyer.id, propertyId, kind, amount, terms, moveIn, ts, ts)
    } catch (error) {
      const other = /UNIQUE/i.test(String(error?.message)) ? active() : null
      if (other) return { offer: buyerOfferView(db, other), created: false }
      throw error
    }
    const ev = db.prepare("INSERT INTO offer_events (offer_id, actor_id, actor_role, from_status, to_status, amount, note, created_at) VALUES (?, ?, 'buyer', NULL, 'submitted', ?, ?, ?)").run(id, buyer.id, amount, terms, ts)
    logActivity(db, lead.id, 'offer_submitted', `${kind === 'application' ? 'Rental application' : 'Offer'} on ${p.title}: ₹${amount.toLocaleString('en-IN')}`, { offerId: id }, 'buyer', buyer.id)
    emit(db, 'offer.changed', { subjectType: 'offer', subjectId: id, actorId: buyer.id, agentId: lead.assigned_agent_id, payload: { from: null, to: 'submitted', eventId: Number(ev.lastInsertRowid) }, dedupeKey: `offer.changed:${ev.lastInsertRowid}` })
    return { offer: buyerOfferView(db, offerRow(db, id)), created: true }
  })
}

export function listBuyerOffers(db, buyer) {
  requireRole(buyer, 'buyer')
  return db.prepare('SELECT * FROM offers WHERE buyer_user_id = ? ORDER BY updated_at DESC LIMIT 200').all(buyer.id).map((r) => buyerOfferView(db, r))
}

export function withdrawOffer(db, buyer, id) {
  requireRole(buyer, 'buyer')
  const r = ownOffer(db, buyer, id)
  if (r.status === 'withdrawn') return { offer: buyerOfferView(db, r) }
  return { offer: buyerOfferView(db, move(db, r, { from: ACTIVE, to: 'withdrawn', actor: buyer, role: 'buyer' })) }
}

/** The buyer accepts the owner's counter: accepted in principle at the counter amount. */
export function acceptCounter(db, buyer, id) {
  requireRole(buyer, 'buyer')
  const r = ownOffer(db, buyer, id)
  return { offer: buyerOfferView(db, move(db, r, { from: ['countered'], to: 'accepted', actor: buyer, role: 'buyer', amount: r.counter_amount, extra: { amount: r.counter_amount } })) }
}

/** The buyer answers a counter with a new amount: back to their agent, who forwards it again. */
export function reviseOffer(db, buyer, id, input = {}) {
  requireRole(buyer, 'buyer')
  const r = ownOffer(db, buyer, id)
  const amount = amountOf(input.amount)
  const terms = input.terms === undefined ? r.terms : text(input.terms, 'terms')
  return { offer: buyerOfferView(db, move(db, r, { from: ['countered'], to: 'submitted', actor: buyer, role: 'buyer', amount, note: terms, extra: { amount, terms, counter_amount: null } })) }
}

// ---- The buyer's assigned agent

function agentOffer(db, agent, id) {
  requireRole(agent, 'agent')
  const r = db.prepare('SELECT o.* FROM offers o JOIN leads l ON l.id = o.lead_id WHERE o.id = ? AND l.assigned_agent_id = ?').get(id, agent.id)
  if (!r) throw new AppError(404, 'offer_not_found', 'No such offer.')
  return r
}

export function listAgentOffers(db, agent, { status = 'active', leadId = null } = {}) {
  requireRole(agent, 'agent')
  if (!['active', 'all', ...STATUSES].includes(status)) throw validationError({ status: 'Unknown status.' })
  const where = ['l.assigned_agent_id = ?']
  const params = [agent.id]
  if (status === 'active') { where.push(`o.status IN (${ACTIVE.map(() => '?').join(',')})`); params.push(...ACTIVE) } else if (status !== 'all') { where.push('o.status = ?'); params.push(status) }
  if (leadId != null) { where.push('o.lead_id = ?'); params.push(leadId) }
  return db.prepare(`SELECT o.* FROM offers o JOIN leads l ON l.id = o.lead_id WHERE ${where.join(' AND ')} ORDER BY o.updated_at DESC LIMIT 500`).all(...params).map((r) => agentView(db, r))
}

/** The buyer's agent passes the offer to the listing's owner. */
export function forwardOffer(db, agent, id, input = {}) {
  const r = agentOffer(db, agent, id)
  const note = text(input.note, 'note')
  const p = getProperty(db, r.property_id)
  if (!p?.owner_user_id) throw new AppError(409, 'no_owner', 'This listing has no owner in DealSaathi to forward to.')
  if (p.listing_state === 'archived' || ['sold', 'rented'].includes(p.status)) throw new AppError(409, 'listing_unavailable', 'This listing is no longer on the market.')
  return { offer: agentView(db, move(db, r, { from: ['submitted'], to: 'forwarded', actor: agent, role: 'agent', note, extra: { forwarded: 1, agent_note: note } })) }
}

/** The buyer's agent records the outcome: agreed (from accepted in principle) or not going ahead (from any active). */
export function closeOffer(db, agent, id, input = {}) {
  const r = agentOffer(db, agent, id)
  const note = text(input.note, 'note')
  if (input.outcome === 'won') return { offer: agentView(db, move(db, r, { from: ['accepted'], to: 'closed_won', actor: agent, role: 'agent', note })) }
  if (input.outcome === 'lost') return { offer: agentView(db, move(db, r, { from: ACTIVE, to: 'closed_lost', actor: agent, role: 'agent', note })) }
  throw validationError({ outcome: 'Choose won or lost.' })
}

// ---- The listing's owner (a seller, or the agent who owns the listing)

function ownerOffer(db, user, id) {
  requireRole(user, 'seller', 'agent')
  const r = db.prepare('SELECT o.* FROM offers o JOIN properties p ON p.id = o.property_id WHERE o.id = ? AND p.owner_user_id = ? AND o.forwarded = 1').get(id, user.id)
  if (!r) throw new AppError(404, 'offer_not_found', 'No such offer.')
  return r
}

/** Offers forwarded to this owner (only forwarded ones: the owner never sees what the agent has not passed on). */
export function listOwnerOffers(db, user) {
  requireRole(user, 'seller', 'agent')
  return db.prepare('SELECT o.* FROM offers o JOIN properties p ON p.id = o.property_id WHERE p.owner_user_id = ? AND o.forwarded = 1 ORDER BY o.updated_at DESC LIMIT 500').all(user.id).map((r) => ownerView(db, r))
}

/** accept (in principle), reject, or counter with an amount. */
export function respondToOffer(db, user, id, input = {}) {
  const r = ownerOffer(db, user, id)
  const note = text(input.note, 'note')
  const common = { from: ['forwarded'], actor: user, role: 'owner', note, extra: { owner_note: note } }
  if (input.action === 'accept') return { offer: ownerView(db, move(db, r, { ...common, to: 'accepted', amount: r.amount })) }
  if (input.action === 'reject') return { offer: ownerView(db, move(db, r, { ...common, to: 'rejected' })) }
  if (input.action === 'counter') {
    const counter = amountOf(input.amount, 'amount')
    if (counter === r.amount) throw validationError({ amount: 'A counter-offer needs a different amount. To agree, accept instead.' })
    return { offer: ownerView(db, move(db, r, { ...common, to: 'countered', amount: counter, extra: { owner_note: note, counter_amount: counter } })) }
  }
  throw validationError({ action: 'Choose accept, reject or counter.' })
}

// ---- Who is told

const WORDS = {
  submitted: (k, t) => `New ${k} on ${t}`,
  forwarded: (k, t) => `${k === 'offer' ? 'An offer' : 'A rental application'} was forwarded to you for ${t}`,
  countered: (k, t) => `Counter-offer on ${t}`,
  accepted: (k, t) => `${k === 'rental application' ? 'Rental application' : 'Offer'} accepted in principle: ${t}`,
  rejected: (k, t) => `${k === 'rental application' ? 'Rental application' : 'Offer'} declined: ${t}`,
  withdrawn: (k, t) => `${k === 'rental application' ? 'Rental application' : 'Offer'} withdrawn: ${t}`,
  closed_won: (k, t) => `Recorded as agreed: ${t}`,
  closed_lost: (k, t) => `Not going ahead: ${t}`
}

/**
 * offer.changed → in-app notifications only, never to the person who made the change, each carrying a dedupe key of
 * the change and the recipient. The owner is told only about offers that were forwarded to them.
 */
export function createOfferHandler({ db, notifyInApp, buyerWantsInApp, sellerWantsInApp }) {
  return async function onOffer(event) {
    const r = offerRow(db, event.subjectId)
    if (!r) return { skipped: 'offer deleted' }
    const { to, eventId } = event.payload
    const lead = getLead(db, r.lead_id)
    const p = getProperty(db, r.property_id)
    const ownerId = p?.owner_user_id ?? null
    const ownerRole = ownerId ? db.prepare('SELECT role FROM users WHERE id = ?').get(ownerId)?.role : null
    const kind = r.kind === 'application' ? 'rental application' : 'offer'
    const title = WORDS[to]?.(kind, p?.title ?? 'a listing') ?? `Offer ${to}`
    const amount = `₹${Number(r.status === 'countered' ? r.counter_amount : r.amount).toLocaleString('en-IN')}`
    const agentId = lead?.assigned_agent_id ?? null
    const toAgent = ['submitted', 'countered', 'accepted', 'rejected', 'withdrawn'].includes(to)
    const toBuyer = ['countered', 'accepted', 'rejected', 'closed_won', 'closed_lost'].includes(to)
    const toOwner = r.forwarded && ['forwarded', 'accepted', 'withdrawn', 'closed_won', 'closed_lost'].includes(to)
    const told = []
    const tell = (userId, who, link, body) => {
      if (!userId || userId === event.actorId) return
      if (notifyInApp(db, userId, { kind: 'offer', title, body, link, subjectType: 'offer', subjectId: r.id, dedupeKey: `offer:${r.id}:${eventId}`, eventId: event.id })) told.push(who)
    }
    if (toAgent && agentId) tell(agentId, 'agent', '#/offers', `${lead?.full_name ?? 'Your buyer'} · ${amount}`)
    if (toBuyer && buyerWantsInApp(r.buyer_user_id)) tell(r.buyer_user_id, 'buyer', '#/my-requests', `${amount}${to === 'accepted' || to === 'closed_won' ? `. ${DISCLAIMER}` : ''}`)
    if (toOwner && ownerId && ownerId !== agentId && (ownerRole !== 'seller' || sellerWantsInApp(ownerId))) {
      tell(ownerId, 'owner', ownerRole === 'seller' ? '#/listing-offers' : '#/offers', `${amount} · through ${agentNameOf(db, lead) ?? 'the buyer’s agent'}`)
    }
    return { notified: told }
  }
}
