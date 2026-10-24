// Property listings and buyer matching. Matching is plain code, not AI: every result comes with the
// reasons it matched, and a buyer is left out (not ranked low) when a stated requirement is not met.
import { now, transaction } from '../db.js'
import { AppError, validationError } from '../errors.js'
import { PROPERTY_TYPES } from '../leads/validate.js'
import { emit } from '../events/bus.js'
import { canViewProperty, propertyView, requirePropertyEditor, requireRole } from '../access.js'

export const LISTING_TYPES = ['sale', 'rent']
export const PROPERTY_STATUSES = ['available', 'under_offer', 'sold', 'rented', 'off_market']
export const LISTING_STATES = ['draft', 'published', 'unpublished', 'archived']
/** Listing facts matching depends on: changing one of these on a published listing queues property.changed. */
const MATCH_FACTS = ['listing_type', 'property_type', 'bedrooms', 'price', 'city', 'locality', 'status']
const FIELDS = ['title', 'listing_type', 'property_type', 'bedrooms', 'price', 'city', 'locality', 'address', 'area_sqft', 'amenities', 'status', 'notes']
const TEXT_LIMITS = { title: 120, city: 80, locality: 80, address: 200, notes: 2000 }
const ENUMS = { listing_type: LISTING_TYPES, property_type: PROPERTY_TYPES, status: PROPERTY_STATUSES }

/** Checks the given fields; returns { value, errors }. '' or null clears an optional field. */
export function cleanPropertyFields(input) {
  const value = {}
  const errors = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { value, errors: { _: 'Expected an object.' } }
  for (const f of FIELDS) {
    if (!(f in input) || input[f] === undefined) continue
    let raw = input[f]
    if (typeof raw === 'string') raw = raw.trim()
    if (raw === '' || raw === null) { value[f] = null; continue }
    if (f === 'amenities') {
      const list = Array.isArray(raw) ? raw : String(raw).split(',')
      const clean = list.map((a) => String(a).trim()).filter(Boolean)
      if (clean.length > 20 || clean.some((a) => a.length > 40)) errors.amenities = 'Up to 20 amenities, each under 40 characters.'
      else value.amenities = clean.length ? clean : null
      continue
    }
    if (['bedrooms', 'price', 'area_sqft'].includes(f)) {
      const n = typeof raw === 'string' ? Number(raw.replace(/,/g, '')) : raw
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) errors[f] = 'Must be a whole number.'
      else if (f === 'bedrooms' && n > 20) errors[f] = 'Must be 20 or fewer.'
      else if (f === 'price' && (n < 1 || n > 100_000_000_000)) errors[f] = 'Enter the price in rupees.'
      else if (f === 'area_sqft' && n > 10_000_000) errors[f] = 'That area looks too large.'
      else value[f] = n
      continue
    }
    if (typeof raw !== 'string') { errors[f] = 'Must be text.'; continue }
    if (ENUMS[f]) {
      if (!ENUMS[f].includes(raw)) errors[f] = `Must be one of: ${ENUMS[f].join(', ')}.`
      else value[f] = raw
      continue
    }
    if (raw.length > TEXT_LIMITS[f]) errors[f] = `Must be ${TEXT_LIMITS[f]} characters or fewer.`
    else value[f] = raw
  }
  return { value, errors }
}

function checkComplete(p) {
  const errors = {}
  if (!p.title) errors.title = 'Give the listing a title.'
  if (!p.listing_type) errors.listing_type = 'For sale or for rent?'
  if (!p.property_type) errors.property_type = 'Choose the property type.'
  if (!p.price) errors.price = 'Enter the price (total for sale, monthly for rent).'
  if (!p.city) errors.city = 'Enter the city.'
  return errors
}

export function toProperty(row) {
  if (!row) return null
  return { ...row, amenities: row.amenities ? JSON.parse(row.amenities) : [], is_sample: Boolean(row.is_sample), code: `P-${String(row.id).padStart(4, '0')}` }
}

export const getProperty = (db, id) => toProperty(db.prepare('SELECT * FROM properties WHERE id = ?').get(id))
export function requireProperty(db, id) {
  const p = getProperty(db, id)
  if (!p) throw new AppError(404, 'property_not_found', 'No such property.')
  return p
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const inr = (n) => (n >= 1e7 ? `₹${+(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `₹${+(n / 1e5).toFixed(2)} L` : `₹${n.toLocaleString('en-IN')}`)
const TYPE_LABEL = { apartment: 'Apartment', independent_house: 'Independent house', villa: 'Villa', plot: 'Plot', commercial: 'Commercial', other: 'Other' }

/**
 * Does this lead want this property? Returns null when a stated requirement rules it out, else
 * { score 0–100, reasons[], gaps[] } where gaps name what the lead never told us.
 */
export function scoreMatch(lead, property) {
  const wants = lead.customer_type === 'buyer' ? 'sale' : lead.customer_type === 'tenant' ? 'rent' : null
  if (!wants || wants !== property.listing_type || property.status !== 'available') return null
  if ((property.listing_state ?? 'published') !== 'published') return null
  // What the lead has said no to (post-viewing feedback): that listing, and localities they rejected.
  if (lead.excludedPropertyIds?.includes(property.id)) return null
  const rejected = lead.excluded_localities ? JSON.parse(lead.excluded_localities) : []
  if (rejected.length && rejected.includes(String(property.locality || property.city || '').trim().toLowerCase())) return null
  let score = 0
  const reasons = []
  const gaps = []

  if (lead.preferred_location) {
    const wanted = norm(lead.preferred_location)
    const city = norm(property.city)
    const locality = norm(property.locality)
    const localityHit = locality && (wanted.includes(locality) || locality.includes(wanted))
    const cityHit = city && wanted.split(' ').some((w) => w && city.split(' ').includes(w))
    if (localityHit) { score += 35; reasons.push(`In ${property.locality}, ${property.city}: the area they asked for`) }
    else if (cityHit) { score += 25; reasons.push(`In ${property.city}, the city they asked for`) }
    else return null
  } else gaps.push('no preferred location saved')

  if (lead.budget_max != null) {
    if (property.price > lead.budget_max) return null
    score += 30
    reasons.push(`${inr(property.price)}${property.listing_type === 'rent' ? '/month' : ''}, within their budget of ${inr(lead.budget_max)}`)
    if (lead.budget_min != null && property.price < lead.budget_min) { score -= 10; reasons.push(`Below their minimum of ${inr(lead.budget_min)}`) }
  } else gaps.push('no budget saved')

  if (lead.bedrooms != null) {
    if (property.bedrooms == null) gaps.push('the listing has no bedroom count')
    else if (property.bedrooms === lead.bedrooms) { score += 25; reasons.push(`${property.bedrooms} BHK as wanted`) }
    else return null
  } else gaps.push('no bedroom count saved')

  if (lead.property_type) {
    if (lead.property_type !== property.property_type) return null
    score += 10
    reasons.push(`${TYPE_LABEL[property.property_type]} as wanted`)
  }
  return { score: Math.max(0, Math.min(100, score)), reasons, gaps }
}

/** The lead with the listings it has turned down, as scoreMatch reads them. */
export function withExclusions(db, lead) {
  return { ...lead, excludedPropertyIds: db.prepare('SELECT property_id FROM lead_property_exclusions WHERE lead_id = ?').all(lead.id).map((r) => r.property_id) }
}

/**
 * A listing's matched buyers, as this viewer may see them: an agent sees the buyers assigned to them by name;
 * everyone else's buyers (and, for a seller, all of them) only as a count.
 */
export function listPropertyMatches(db, propertyId, viewer) {
  const rows = db.prepare(`SELECT m.*, l.full_name, l.customer_type, l.phone, l.email, l.assigned_agent_id
                           FROM property_matches m JOIN leads l ON l.id = m.lead_id WHERE m.property_id = ? AND m.status != 'withdrawn' ORDER BY m.status = 'dismissed', m.score DESC`).all(propertyId)
  const mine = viewer?.role === 'agent' ? rows.filter((r) => r.assigned_agent_id === viewer.id) : []
  return {
    matches: mine.map((r) => ({ leadId: r.lead_id, leadCode: `L-${String(r.lead_id).padStart(4, '0')}`, name: r.full_name, customerType: r.customer_type, hasPhone: Boolean(r.phone), hasEmail: Boolean(r.email), score: r.score, status: r.status, ...JSON.parse(r.reasons) })),
    otherBuyers: rows.filter((r) => r.status === 'suggested').length - mine.filter((r) => r.status === 'suggested').length
  }
}

function queueStateEvents(db, before, after, actorId) {
  const wasLive = before?.listing_state === 'published'
  const isLive = after.listing_state === 'published'
  const base = { subjectType: 'property', subjectId: after.id, actorId, agentId: after.agent_id }
  if (!wasLive && isLive) return emit(db, 'property.published', { ...base, payload: {} })
  if (wasLive && !isLive) return emit(db, 'property.unpublished', { ...base, payload: { state: after.listing_state } })
  const changed = before ? MATCH_FACTS.filter((f) => before[f] !== after[f]) : []
  if (isLive && changed.length) return emit(db, 'property.changed', { ...base, payload: { fields: changed } })
  return null
}

/**
 * Creates a listing. An agent's listing is theirs and is published unless they save it as a draft; a seller's
 * listing starts as a draft and gets the seller's agent. Publishing queues property.published (matching runs
 * from the queue, not here).
 */
export function createProperty(db, input, { actor, isSample = false, publish } = {}) {
  requireRole(actor, 'agent', 'seller')
  const { value, errors } = cleanPropertyFields(input)
  const p = { status: 'available', ...value }
  Object.assign(errors, checkComplete(p))
  if (Object.keys(errors).length) throw validationError(errors)
  const live = publish ?? actor.role === 'agent'
  return transaction(db, () => {
    const dupe = db.prepare('SELECT id FROM properties WHERE owner_user_id = ? AND lower(title) = lower(?) AND lower(city) = lower(?) AND price = ? AND listing_type = ? AND listing_state != \'archived\'').get(actor.id, p.title, p.city, p.price, p.listing_type)
    if (dupe) throw new AppError(409, 'possible_duplicate', 'You already have a listing with the same title, city, price and type.', { propertyId: dupe.id })
    const ts = now()
    const agentId = actor.role === 'agent' ? actor.id : agentForSellerHook(db, actor.id, p)
    const cols = FIELDS.filter((f) => p[f] != null)
    const values = cols.map((f) => (f === 'amenities' ? JSON.stringify(p[f]) : p[f]))
    const extra = ['is_sample', 'created_by', 'owner_user_id', 'agent_id', 'listing_state', 'published_at', 'created_at', 'updated_at']
    const { lastInsertRowid } = db.prepare(`INSERT INTO properties (${[...cols, ...extra].join(', ')}) VALUES (${[...cols, ...extra].map(() => '?').join(', ')})`)
      .run(...values, isSample ? 1 : 0, actor.id, actor.id, agentId, live ? 'published' : 'draft', live ? ts : null, ts, ts)
    const property = getProperty(db, Number(lastInsertRowid))
    const eventId = queueStateEvents(db, null, property, actor.id)
    return { property, eventId }
  })
}

// Set by the profiles module (it imports this one): picks a seller's agent from the listing's area.
let agentForSellerHook = () => null
export const setAgentForSeller = (fn) => { agentForSellerHook = fn }

export function updateProperty(db, id, input, { actor } = {}) {
  const { value, errors } = cleanPropertyFields(input)
  if (Object.keys(errors).length) throw validationError(errors)
  return transaction(db, () => {
    const current = requireProperty(db, id)
    requirePropertyEditor(actor, current)
    if (current.listing_state === 'archived') throw new AppError(409, 'listing_archived', 'This listing is archived. Archived listings cannot be changed.')
    const merged = { ...current, ...value }
    const complete = checkComplete(merged)
    if (Object.keys(complete).length) throw validationError(complete)
    const changes = Object.entries(value)
    if (changes.length) {
      db.prepare(`UPDATE properties SET ${changes.map(([f]) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...changes.map(([f, v]) => (f === 'amenities' && v ? JSON.stringify(v) : v)), now(), id)
    }
    const property = getProperty(db, id)
    const eventId = queueStateEvents(db, current, property, actor.id)
    return { property, eventId }
  })
}

/** publish | unpublish | archive. Unpublishing or archiving withdraws its matches (through the queue). */
export function setListingState(db, actor, id, action) {
  const target = { publish: 'published', unpublish: 'unpublished', archive: 'archived' }[action]
  if (!target) throw validationError({ action: 'Choose publish, unpublish or archive.' })
  return transaction(db, () => {
    const current = requireProperty(db, id)
    requirePropertyEditor(actor, current)
    if (current.listing_state === 'archived') throw new AppError(409, 'listing_archived', 'This listing is archived.')
    if (current.listing_state === target) return { property: current, eventId: null }
    if (target === 'published' && current.status !== 'available') throw new AppError(409, 'not_available', `Set the listing back to available before publishing it (it is ${current.status.replace('_', ' ')}).`)
    db.prepare('UPDATE properties SET listing_state = ?, published_at = coalesce(published_at, ?), updated_at = ? WHERE id = ?').run(target, target === 'published' ? now() : null, now(), id)
    const property = getProperty(db, id)
    return { property, eventId: queueStateEvents(db, current, property, actor.id) }
  })
}

/** Deleting is for drafts that were never published (and samples); a listing buyers may have seen is archived instead. */
export function deleteProperty(db, actor, id) {
  return transaction(db, () => {
    const p = requireProperty(db, id)
    requirePropertyEditor(actor, p)
    if (p.published_at && !p.is_sample) throw new AppError(409, 'archive_instead', 'This listing was published, so it is archived rather than deleted (its matches, viewings and history are kept).')
    db.prepare('DELETE FROM properties WHERE id = ?').run(id)
    return p
  })
}

export function dismissMatch(db, agent, propertyId, leadId) {
  const lead = db.prepare('SELECT assigned_agent_id FROM leads WHERE id = ?').get(leadId)
  if (!lead || lead.assigned_agent_id !== agent.id) throw new AppError(404, 'match_not_found', 'No such match.')
  const r = db.prepare("UPDATE property_matches SET status = 'dismissed', updated_at = ? WHERE property_id = ? AND lead_id = ? AND status != 'withdrawn'").run(now(), propertyId, leadId)
  if (!r.changes) throw new AppError(404, 'match_not_found', 'No such match.')
  return { dismissed: true }
}

/** The listing as this viewer may see it, or a 404. */
export function viewProperty(db, viewer, id) {
  const p = getProperty(db, id)
  if (!canViewProperty(viewer, p)) throw new AppError(404, 'property_not_found', 'No such property.')
  return propertyView(viewer, p)
}

/**
 * Listings this viewer may see. scope 'mine': the listings they own or are the agent for (any state);
 * 'market': published listings (agents also see samples; buyers and sellers only real, available ones).
 */
export function listProperties(db, viewer, { scope = viewer.role === 'buyer' ? 'market' : 'mine', q, listing_type, city, status, limit = 100 } = {}) {
  const where = []
  const params = []
  if (scope === 'mine') {
    if (viewer.role === 'buyer') throw new AppError(403, 'forbidden', 'Buyers do not own listings.')
    where.push('(p.owner_user_id = ? OR p.agent_id = ?)'); params.push(viewer.id, viewer.id)
  } else {
    where.push("p.listing_state = 'published'")
    if (viewer.role !== 'agent') where.push("p.is_sample = 0 AND p.status = 'available'")
  }
  if (q && String(q).trim()) {
    const like = `%${String(q).trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    where.push("(lower(p.title) LIKE ? ESCAPE '\\' OR lower(coalesce(p.locality,'')) LIKE ? ESCAPE '\\' OR lower(p.city) LIKE ? ESCAPE '\\')")
    params.push(like, like, like)
  }
  if (listing_type) {
    if (!LISTING_TYPES.includes(listing_type)) throw validationError({ listing_type: 'Unknown listing type.' })
    where.push('p.listing_type = ?'); params.push(listing_type)
  }
  if (status) {
    if (!PROPERTY_STATUSES.includes(status)) throw validationError({ status: 'Unknown status.' })
    where.push('p.status = ?'); params.push(status)
  }
  if (city && String(city).trim()) { where.push('lower(p.city) = lower(?)'); params.push(String(city).trim()) }
  const rows = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM property_matches m WHERE m.property_id = p.id AND m.status = 'suggested') AS match_count
                           FROM properties p WHERE ${where.join(' AND ')} ORDER BY p.updated_at DESC, p.id DESC LIMIT ?`).all(...params, Math.min(Number(limit) || 100, 200))
  return rows.map((r) => ({ ...propertyView(viewer, toProperty(r)), match_count: r.match_count }))
}

/** A few clearly labelled sample listings so matching can be tried. Never presented as real inventory. */
export const SAMPLE_PROPERTIES = [
  { title: 'Sample · 2 BHK apartment, Baner', listing_type: 'sale', property_type: 'apartment', bedrooms: 2, price: 4800000, city: 'Pune', locality: 'Baner', area_sqft: 950, amenities: ['Lift', 'Parking'] },
  { title: 'Sample · 2 BHK apartment, Wakad', listing_type: 'sale', property_type: 'apartment', bedrooms: 2, price: 5600000, city: 'Pune', locality: 'Wakad', area_sqft: 1010, amenities: ['Gym'] },
  { title: 'Sample · 3 BHK villa, Kharadi', listing_type: 'sale', property_type: 'villa', bedrooms: 3, price: 14500000, city: 'Pune', locality: 'Kharadi', area_sqft: 2100, amenities: ['Garden', 'Parking'] },
  { title: 'Sample · 1 BHK flat for rent, Koramangala', listing_type: 'rent', property_type: 'apartment', bedrooms: 1, price: 28000, city: 'Bangalore', locality: 'Koramangala', area_sqft: 600, amenities: ['Furnished'] },
  { title: 'Sample · 2 BHK flat for rent, Andheri West', listing_type: 'rent', property_type: 'apartment', bedrooms: 2, price: 55000, city: 'Mumbai', locality: 'Andheri West', area_sqft: 800, amenities: ['Lift'] }
]

export function addSampleProperties(db, actor) {
  requireRole(actor, 'agent')
  if (db.prepare('SELECT COUNT(*) AS n FROM properties WHERE is_sample = 1').get().n) throw new AppError(409, 'samples_exist', 'Sample listings are already loaded.')
  return SAMPLE_PROPERTIES.map((p) => createProperty(db, { ...p, notes: 'Sample listing for trying DealSaathi. Not real inventory.' }, { actor, isSample: true }).property)
}
