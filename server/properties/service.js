// Property listings and buyer matching. Matching is plain code, not AI: every result comes with the
// reasons it matched, and a buyer is left out (not ranked low) when a stated requirement is not met.
import { now, transaction } from '../db.js'
import { AppError, validationError } from '../errors.js'
import { PROPERTY_TYPES } from '../leads/validate.js'
import { logActivity } from '../leads/service.js'

export const LISTING_TYPES = ['sale', 'rent']
export const PROPERTY_STATUSES = ['available', 'under_offer', 'sold', 'rented', 'off_market']
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

function toProperty(row) {
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

/** Ranked buyers (or tenants) for one property, best first. */
export function matchLeadsFor(db, property) {
  const leads = db.prepare("SELECT * FROM leads WHERE customer_type IN ('buyer','tenant') AND status NOT IN ('won','lost')").all()
  return leads.map((lead) => ({ lead, match: scoreMatch(lead, property) })).filter((m) => m.match).sort((a, b) => b.match.score - a.match.score)
}

/** Ranked available properties for one lead, best first. */
export function matchPropertiesFor(db, lead, { limit = 20 } = {}) {
  const props = db.prepare("SELECT * FROM properties WHERE status = 'available'").all().map(toProperty)
  return props.map((property) => ({ property, match: scoreMatch(lead, property) })).filter((m) => m.match).sort((a, b) => b.match.score - a.match.score).slice(0, limit)
}

/**
 * The "property saved" trigger: recomputes this property's matches in the same transaction as the save.
 * A match a broker dismissed stays dismissed; a buyer who no longer fits is removed; each buyer newly
 * matched gets one activity entry (re-saving the property does not repeat it).
 */
function refreshMatches(db, property, userId) {
  const found = matchLeadsFor(db, property)
  const keep = new Set(found.map((m) => m.lead.id))
  const existing = new Map(db.prepare('SELECT lead_id, status FROM property_matches WHERE property_id = ?').all(property.id).map((r) => [r.lead_id, r.status]))
  for (const leadId of existing.keys()) if (!keep.has(leadId)) db.prepare('DELETE FROM property_matches WHERE property_id = ? AND lead_id = ?').run(property.id, leadId)
  const ts = now()
  let added = 0
  for (const { lead, match } of found) {
    const isNew = !existing.has(lead.id)
    db.prepare(`INSERT INTO property_matches (property_id, lead_id, score, reasons, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'suggested', ?, ?)
                ON CONFLICT (property_id, lead_id) DO UPDATE SET score = excluded.score, reasons = excluded.reasons, updated_at = excluded.updated_at`)
      .run(property.id, lead.id, match.score, JSON.stringify(match), ts, ts)
    if (isNew) {
      added++
      logActivity(db, lead.id, 'property_matched', `Matches ${property.is_sample ? 'sample ' : ''}property ${property.title} (${match.score}/100)`, { propertyId: property.id, reasons: match.reasons }, 'matching', userId)
    }
  }
  return { matched: found.length, newMatches: added }
}

export function listPropertyMatches(db, propertyId) {
  return db.prepare(`SELECT m.*, l.full_name, l.customer_type, l.preferred_location, l.budget_max, l.bedrooms, l.phone, l.email
                     FROM property_matches m JOIN leads l ON l.id = m.lead_id WHERE m.property_id = ? ORDER BY m.status = 'dismissed', m.score DESC`).all(propertyId)
    .map((r) => ({ leadId: r.lead_id, leadCode: `L-${String(r.lead_id).padStart(4, '0')}`, name: r.full_name, customerType: r.customer_type, hasPhone: Boolean(r.phone), hasEmail: Boolean(r.email), score: r.score, status: r.status, ...JSON.parse(r.reasons) }))
}

export function createProperty(db, input, { userId = null, isSample = false, match = true } = {}) {
  const { value, errors } = cleanPropertyFields(input)
  const p = { status: 'available', ...value }
  Object.assign(errors, checkComplete(p))
  if (Object.keys(errors).length) throw validationError(errors)
  return transaction(db, () => {
    const dupe = db.prepare('SELECT id FROM properties WHERE lower(title) = lower(?) AND lower(city) = lower(?) AND price = ? AND listing_type = ?').get(p.title, p.city, p.price, p.listing_type)
    if (dupe) throw new AppError(409, 'possible_duplicate', 'A listing with the same title, city, price and type already exists.', { propertyId: dupe.id })
    const ts = now()
    const cols = FIELDS.filter((f) => p[f] != null)
    const values = cols.map((f) => (f === 'amenities' ? JSON.stringify(p[f]) : p[f]))
    const { lastInsertRowid } = db.prepare(`INSERT INTO properties (${[...cols, 'is_sample', 'created_by', 'created_at', 'updated_at'].join(', ')}) VALUES (${[...cols, 1, 2, 3, 4].map(() => '?').join(', ')})`)
      .run(...values, isSample ? 1 : 0, userId, ts, ts)
    const property = getProperty(db, Number(lastInsertRowid))
    return { property, matching: match ? refreshMatches(db, property, userId) : null }
  })
}

export function updateProperty(db, id, input, { userId = null, match = true } = {}) {
  const { value, errors } = cleanPropertyFields(input)
  if (Object.keys(errors).length) throw validationError(errors)
  return transaction(db, () => {
    const current = requireProperty(db, id)
    const merged = { ...current, ...value }
    const complete = checkComplete(merged)
    if (Object.keys(complete).length) throw validationError(complete)
    const changes = Object.entries(value)
    if (changes.length) {
      db.prepare(`UPDATE properties SET ${changes.map(([f]) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...changes.map(([f, v]) => (f === 'amenities' && v ? JSON.stringify(v) : v)), now(), id)
    }
    const property = getProperty(db, id)
    return { property, matching: match ? refreshMatches(db, property, userId) : null }
  })
}

export function deleteProperty(db, id) {
  return transaction(db, () => {
    const p = requireProperty(db, id)
    db.prepare('DELETE FROM properties WHERE id = ?').run(id)
    return p
  })
}

export function dismissMatch(db, propertyId, leadId) {
  const r = db.prepare("UPDATE property_matches SET status = 'dismissed', updated_at = ? WHERE property_id = ? AND lead_id = ?").run(now(), propertyId, leadId)
  if (!r.changes) throw new AppError(404, 'match_not_found', 'No such match.')
  return { dismissed: true }
}

export function listProperties(db, { q, listing_type, city, status, limit = 100 } = {}) {
  const where = []
  const params = []
  if (q && String(q).trim()) {
    const like = `%${String(q).trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    where.push("(lower(title) LIKE ? ESCAPE '\\' OR lower(coalesce(locality,'')) LIKE ? ESCAPE '\\' OR lower(city) LIKE ? ESCAPE '\\')")
    params.push(like, like, like)
  }
  if (listing_type) {
    if (!LISTING_TYPES.includes(listing_type)) throw validationError({ listing_type: 'Unknown listing type.' })
    where.push('listing_type = ?'); params.push(listing_type)
  }
  if (status) {
    if (!PROPERTY_STATUSES.includes(status)) throw validationError({ status: 'Unknown status.' })
    where.push('status = ?'); params.push(status)
  }
  if (city && String(city).trim()) { where.push('lower(city) = lower(?)'); params.push(String(city).trim()) }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const rows = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM property_matches m WHERE m.property_id = p.id AND m.status = 'suggested') AS match_count
                           FROM properties p ${clause} ORDER BY p.updated_at DESC LIMIT ?`).all(...params, Math.min(Number(limit) || 100, 200))
  return rows.map((r) => ({ ...toProperty(r), match_count: r.match_count }))
}

/** A few clearly labelled sample listings so matching can be tried. Never presented as real inventory. */
export const SAMPLE_PROPERTIES = [
  { title: 'Sample · 2 BHK apartment, Baner', listing_type: 'sale', property_type: 'apartment', bedrooms: 2, price: 4800000, city: 'Pune', locality: 'Baner', area_sqft: 950, amenities: ['Lift', 'Parking'] },
  { title: 'Sample · 2 BHK apartment, Wakad', listing_type: 'sale', property_type: 'apartment', bedrooms: 2, price: 5600000, city: 'Pune', locality: 'Wakad', area_sqft: 1010, amenities: ['Gym'] },
  { title: 'Sample · 3 BHK villa, Kharadi', listing_type: 'sale', property_type: 'villa', bedrooms: 3, price: 14500000, city: 'Pune', locality: 'Kharadi', area_sqft: 2100, amenities: ['Garden', 'Parking'] },
  { title: 'Sample · 1 BHK flat for rent, Koramangala', listing_type: 'rent', property_type: 'apartment', bedrooms: 1, price: 28000, city: 'Bangalore', locality: 'Koramangala', area_sqft: 600, amenities: ['Furnished'] },
  { title: 'Sample · 2 BHK flat for rent, Andheri West', listing_type: 'rent', property_type: 'apartment', bedrooms: 2, price: 55000, city: 'Mumbai', locality: 'Andheri West', area_sqft: 800, amenities: ['Lift'] }
]

export function addSampleProperties(db, userId) {
  if (db.prepare('SELECT COUNT(*) AS n FROM properties WHERE is_sample = 1').get().n) throw new AppError(409, 'samples_exist', 'Sample listings are already loaded.')
  return SAMPLE_PROPERTIES.map((p) => createProperty(db, { ...p, notes: 'Sample listing for trying DealSaathi. Not real inventory.' }, { userId, isSample: true }).property)
}
