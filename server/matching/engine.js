// Continuous matching, in both directions:
//   matchLead(lead)         a buyer's requirements were saved or changed → every eligible listing
//   matchProperty(property) a listing was published or changed          → every eligible buyer requirement
// Both store each match with its score, reasons and a fingerprint of the listing facts it was based on. A match
// that stops fitting is withdrawn (with the reason), not deleted. Only a new match, or one whose listing facts
// changed, queues a match.created event; notifications key on (lead, listing, fingerprint), so an unchanged match
// is never announced twice, whichever direction finds it again.
import { createHash, randomUUID } from 'node:crypto'
import { now, transaction } from '../db.js'
import { getLead, logActivity } from '../leads/service.js'
import { getProperty, scoreMatch, withExclusions } from '../properties/service.js'
import { emit } from '../events/bus.js'

const ACTIVE_LEAD = "customer_type IN ('buyer','tenant') AND status NOT IN ('won','lost')"
const ELIGIBLE_PROPERTY = "listing_state = 'published' AND status = 'available'"

/** The listing facts a match depends on. A different fingerprint is a materially different match. */
export function fingerprint(p) {
  const facts = [p.listing_type, p.property_type, p.bedrooms ?? null, p.price, String(p.city || '').toLowerCase().trim(), String(p.locality || '').toLowerCase().trim(), p.status, p.listing_state ?? 'published']
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 16)
}

/** Why a lead takes part in matching, or why it does not. */
export function leadEligibility(db, lead) {
  if (!lead) return { ok: false, reason: 'the lead was deleted' }
  if (!['buyer', 'tenant'].includes(lead.customer_type)) return { ok: false, reason: 'the lead is not a buyer or tenant' }
  if (['won', 'lost'].includes(lead.status)) return { ok: false, reason: `the lead is ${lead.status}` }
  if (lead.buyer_user_id) {
    const prof = db.prepare('SELECT matching_consent FROM buyer_profiles WHERE user_id = ?').get(lead.buyer_user_id)
    if (!prof?.matching_consent) return { ok: false, reason: 'the buyer has not agreed to matching' }
  }
  return { ok: true }
}

export function propertyEligibility(p) {
  if (!p) return { ok: false, reason: 'the listing was deleted' }
  if ((p.listing_state ?? 'published') !== 'published') return { ok: false, reason: `the listing is ${p.listing_state}` }
  if (p.status !== 'available') return { ok: false, reason: `the listing is ${p.status.replace('_', ' ')}` }
  return { ok: true }
}

/** Upserts one match. Returns 'new' (first time, or back after being withdrawn), 'changed', or 'same'. */
function upsert(db, property, lead, match) {
  const fp = fingerprint(property)
  const ts = now()
  const row = db.prepare('SELECT status, fingerprint, withdrawn_reason FROM property_matches WHERE property_id = ? AND lead_id = ?').get(property.id, lead.id)
  const reasons = JSON.stringify(match)
  if (!row) {
    db.prepare("INSERT INTO property_matches (property_id, lead_id, score, reasons, status, fingerprint, created_at, updated_at) VALUES (?, ?, ?, ?, 'suggested', ?, ?, ?)")
      .run(property.id, lead.id, match.score, reasons, fp, ts, ts)
    return { kind: 'new', fp }
  }
  if (row.status === 'withdrawn') {
    const wasDismissed = String(row.withdrawn_reason || '').startsWith('dismissed')
    db.prepare('UPDATE property_matches SET status = ?, score = ?, reasons = ?, fingerprint = ?, withdrawn_reason = NULL, updated_at = ? WHERE property_id = ? AND lead_id = ?')
      .run(wasDismissed ? 'dismissed' : 'suggested', match.score, reasons, fp, ts, property.id, lead.id)
    return { kind: wasDismissed ? 'same' : 'new', fp }
  }
  db.prepare('UPDATE property_matches SET score = ?, reasons = ?, fingerprint = ?, updated_at = ? WHERE property_id = ? AND lead_id = ?').run(match.score, reasons, fp, ts, property.id, lead.id)
  // A dismissed match stays dismissed; a match stored before fingerprints existed is not re-announced.
  if (row.status === 'dismissed' || row.fingerprint == null || row.fingerprint === fp) return { kind: 'same', fp }
  return { kind: 'changed', fp }
}

/** A match that stopped fitting. A dismissed one remembers it was dismissed, so it comes back dismissed. */
function withdraw(db, propertyId, leadId, reason) {
  return db.prepare(`UPDATE property_matches SET withdrawn_reason = CASE WHEN status = 'dismissed' THEN 'dismissed: ' || ? ELSE ? END,
                     status = 'withdrawn', updated_at = ? WHERE property_id = ? AND lead_id = ? AND status IN ('suggested','dismissed')`)
    .run(reason.slice(0, 200), reason.slice(0, 200), now(), propertyId, leadId).changes
}

/**
 * Queues one match.created per new or changed match, and one match.digest per responsible agent (the agent
 * notification goes out once per triggering change, listing every match it found).
 */
function queueMatchEvents(db, found, { trigger, actorId, direction }) {
  const byAgent = new Map()
  for (const { lead, property, fp, kind } of found) {
    emit(db, 'match.created', {
      subjectType: 'lead', subjectId: lead.id, actorId, agentId: lead.assigned_agent_id,
      payload: { leadId: lead.id, propertyId: property.id, fingerprint: fp, kind, direction, trigger },
      dedupeKey: `match.created:${lead.id}:${property.id}:${fp}`
    })
    if (lead.assigned_agent_id) {
      if (!byAgent.has(lead.assigned_agent_id)) byAgent.set(lead.assigned_agent_id, [])
      byAgent.get(lead.assigned_agent_id).push({ leadId: lead.id, propertyId: property.id, fingerprint: fp })
    }
  }
  for (const [agentId, matches] of byAgent) {
    emit(db, 'match.digest', { subjectType: 'agent', subjectId: agentId, actorId, agentId, payload: { direction, trigger, matches }, dedupeKey: `match.digest:${trigger}:${agentId}` })
  }
}

const sortMatches = (a, b) => b.match.score - a.match.score || a.property.price - b.property.price || a.property.id - b.property.id

/** Buyer → listings. `trigger` identifies the change (an event id) for digests and audit. */
export function matchLead(db, leadId, { trigger = randomUUID(), actorId = null } = {}) {
  return transaction(db, () => {
    const raw = getLead(db, leadId)
    const eligible = leadEligibility(db, raw)
    const active = db.prepare("SELECT property_id FROM property_matches WHERE lead_id = ? AND status IN ('suggested','dismissed')").all(leadId).map((r) => r.property_id)
    if (!eligible.ok) {
      let withdrawn = 0
      for (const pid of active) withdrawn += withdraw(db, pid, leadId, `No longer matched: ${eligible.reason}`)
      return { matched: 0, newMatches: 0, withdrawn, reason: eligible.reason }
    }
    const lead = withExclusions(db, raw)
    // Pre-filter in SQL on what a requirement rules out outright; scoreMatch decides the rest.
    const wants = lead.customer_type === 'buyer' ? 'sale' : 'rent'
    const params = [wants]
    let budget = ''
    if (lead.budget_max != null) { budget = ' AND price <= ?'; params.push(lead.budget_max) }
    const props = db.prepare(`SELECT * FROM properties WHERE ${ELIGIBLE_PROPERTY} AND listing_type = ?${budget}`).all(...params).map((r) => getProperty(db, r.id))
    const hits = props.map((property) => ({ property, match: scoreMatch(lead, property) })).filter((m) => m.match).sort(sortMatches)
    const keep = new Set(hits.map((h) => h.property.id))
    let withdrawn = 0
    for (const pid of active) if (!keep.has(pid)) withdrawn += withdraw(db, pid, leadId, 'No longer fits the buyer’s requirements')
    const fresh = []
    for (const { property, match } of hits) {
      const { kind, fp } = upsert(db, property, lead, match)
      if (kind === 'same') continue
      fresh.push({ lead: raw, property, fp, kind })
      if (kind === 'new') logActivity(db, lead.id, 'property_matched', `Matches ${property.is_sample ? 'sample ' : ''}property ${property.title} (${match.score}/100)`, { propertyId: property.id, reasons: match.reasons }, 'matching', actorId)
    }
    queueMatchEvents(db, fresh, { trigger, actorId, direction: 'buyer_requirements' })
    return { matched: hits.length, newMatches: fresh.length, withdrawn }
  })
}

/** Listing → buyers. */
export function matchProperty(db, propertyId, { trigger = randomUUID(), actorId = null } = {}) {
  return transaction(db, () => {
    const property = getProperty(db, propertyId)
    const eligible = propertyEligibility(property)
    const active = db.prepare("SELECT lead_id FROM property_matches WHERE property_id = ? AND status IN ('suggested','dismissed')").all(propertyId).map((r) => r.lead_id)
    if (!eligible.ok) {
      let withdrawn = 0
      for (const lid of active) withdrawn += withdraw(db, propertyId, lid, `No longer matched: ${eligible.reason}`)
      return { matched: 0, newMatches: 0, withdrawn, reason: eligible.reason }
    }
    const wants = property.listing_type === 'sale' ? 'buyer' : 'tenant'
    const leads = db.prepare(`SELECT * FROM leads WHERE ${ACTIVE_LEAD} AND customer_type = ? AND (budget_max IS NULL OR budget_max >= ?)`).all(wants, property.price)
      .map((r) => getLead(db, r.id)).filter((l) => leadEligibility(db, l).ok).map((l) => withExclusions(db, l))
    const hits = leads.map((lead) => ({ lead, match: scoreMatch(lead, property) })).filter((m) => m.match)
      .sort((a, b) => b.match.score - a.match.score || a.lead.id - b.lead.id)
    const keep = new Set(hits.map((h) => h.lead.id))
    let withdrawn = 0
    for (const lid of active) if (!keep.has(lid)) withdrawn += withdraw(db, propertyId, lid, 'The listing no longer fits this buyer')
    const fresh = []
    for (const { lead, match } of hits) {
      const { kind, fp } = upsert(db, property, lead, match)
      if (kind === 'same') continue
      fresh.push({ lead, property, fp, kind })
      if (kind === 'new') logActivity(db, lead.id, 'property_matched', `Matches ${property.is_sample ? 'sample ' : ''}property ${property.title} (${match.score}/100)`, { propertyId: property.id, reasons: match.reasons }, 'matching', actorId)
    }
    queueMatchEvents(db, fresh, { trigger, actorId, direction: 'listing' })
    return { matched: hits.length, newMatches: fresh.length, withdrawn }
  })
}

/** A lead's current (suggested) matches, best first: what recommendations are built from. */
export function storedMatchesForLead(db, leadId, { includeSamples = true, limit = 50 } = {}) {
  const rows = db.prepare(`SELECT m.*, p.is_sample FROM property_matches m JOIN properties p ON p.id = m.property_id
                           WHERE m.lead_id = ? AND m.status = 'suggested' AND p.listing_state = 'published' AND p.status = 'available'
                           ${includeSamples ? '' : 'AND p.is_sample = 0'} ORDER BY m.score DESC, p.price ASC, p.id ASC LIMIT ?`).all(leadId, limit)
  return rows.map((r) => ({ property: getProperty(db, r.property_id), ...JSON.parse(r.reasons), score: r.score, status: r.status, matchedAt: r.created_at, updatedAt: r.updated_at }))
}
