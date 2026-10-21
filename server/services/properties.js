import { z } from 'zod'
import { audit, nowIso } from '../db.js'
import { parseOrThrow, propertySchema } from '../validation.js'
import { HttpError } from './leads.js'

export const matchCriteriaSchema = z.object({
  city: z.string().trim().max(80).nullable().optional(),
  locality: z.string().trim().max(120).nullable().optional(),
  listing_type: z.enum(['sale', 'rent']).nullable().optional(),
  property_type: z.string().trim().max(40).nullable().optional(),
  budget_min: z.coerce.number().min(0).nullable().optional(),
  budget_max: z.coerce.number().min(0).nullable().optional(),
  bedrooms: z.coerce.number().int().min(0).max(20).nullable().optional(),
  amenities: z.array(z.string().trim().max(40)).max(20).nullable().optional(),
  include_sample: z.boolean().optional().default(true)
})

const formatInr = (value) => {
  if (value >= 1e7) return `₹${(value / 1e7).toFixed(2).replace(/\.?0+$/, '')} Cr`
  if (value >= 1e5) return `₹${(value / 1e5).toFixed(2).replace(/\.?0+$/, '')} lakh`
  return `₹${value.toLocaleString('en-IN')}`
}

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()
const contains = (hay, needle) => String(hay || '').toLowerCase().includes(String(needle || '').trim().toLowerCase())

function hydrate(row) {
  return row && { ...row, amenities: JSON.parse(row.amenities || '[]'), available: Boolean(row.available), is_sample: Boolean(row.is_sample) }
}

/**
 * Filters and ranks stored properties against the criteria. Hard requirements (city, listing type,
 * maximum budget, availability) exclude a property; the rest add to its score. Each result explains
 * itself, and a detail the record does not hold is reported as unknown, never assumed.
 */
export function matchProperties(properties, criteria) {
  const results = []
  for (const property of properties) {
    if (!property.available) continue
    const reasons = []
    const gaps = []
    let score = 0

    if (criteria.city) {
      if (!same(property.city, criteria.city)) continue
      reasons.push(`In ${property.city}`)
    }
    if (criteria.listing_type) {
      if (property.listing_type !== criteria.listing_type) continue
      reasons.push(property.listing_type === 'rent' ? 'Available to rent' : 'Available to buy')
    }
    if (!criteria.listing_type && property.listing_type === 'rent') {
      gaps.push('This is a rental: its price is monthly rent')
      score -= 2
    }
    if (criteria.budget_max != null) {
      if (property.price > criteria.budget_max) continue
      reasons.push(`${formatInr(property.price)} is within the ${formatInr(criteria.budget_max)} budget`)
      score += 2
    }
    if (criteria.budget_min != null) {
      if (property.price < criteria.budget_min) gaps.push(`Priced below the stated minimum of ${formatInr(criteria.budget_min)}`)
      else score += 1
    }
    if (criteria.locality) {
      if (contains(property.locality, criteria.locality) || contains(property.address, criteria.locality)) {
        reasons.push(`In ${property.locality || criteria.locality}`)
        score += 3
      } else {
        gaps.push(`Not in ${criteria.locality}${property.locality ? ` (it is in ${property.locality})` : ''}`)
      }
    }
    if (criteria.property_type) {
      if (same(property.property_type, criteria.property_type)) {
        reasons.push(`Is a ${property.property_type}`)
        score += 2
      } else {
        gaps.push(`Is a ${property.property_type}, not a ${criteria.property_type}`)
      }
    }
    if (criteria.bedrooms != null) {
      // A listing without a recorded bedroom count cannot be shown to meet an explicit bedroom requirement.
      if (property.bedrooms == null) continue
      if (property.bedrooms === criteria.bedrooms) {
        reasons.push(`${property.bedrooms} bedrooms, as requested`)
        score += 3
      } else if (property.bedrooms > criteria.bedrooms) {
        reasons.push(`${property.bedrooms} bedrooms (more than the ${criteria.bedrooms} requested)`)
        score += 1
      } else {
        continue
      }
    }
    for (const amenity of criteria.amenities || []) {
      if (property.amenities.some((have) => contains(have, amenity) || contains(amenity, have))) {
        reasons.push(`Lists ${amenity}`)
        score += 1
      } else {
        gaps.push(`${amenity} is not listed for this property`)
      }
    }
    results.push({ property, score, reasons, gaps })
  }
  return results.sort((a, b) => b.score - a.score || a.property.price - b.property.price)
}

export function createPropertyService(db) {
  const byId = db.prepare('SELECT * FROM properties WHERE id = ? AND owner_id = ?')
  return {
    list(ownerId, { includeSample = true } = {}) {
      return db
        .prepare(`SELECT * FROM properties WHERE owner_id = ? ${includeSample ? '' : 'AND is_sample = 0'} ORDER BY is_sample ASC, updated_at DESC`)
        .all(ownerId)
        .map(hydrate)
    },
    get(ownerId, id) {
      const row = hydrate(byId.get(id, ownerId))
      if (!row) throw new HttpError(404, 'Property not found.')
      return row
    },
    create(ownerId, input, { isSample = false } = {}) {
      const p = parseOrThrow(propertySchema, input)
      const info = db
        .prepare(
          `INSERT INTO properties (owner_id, title, listing_type, property_type, city, locality, address, price, bedrooms,
             area_sqft, amenities, available, description, is_sample)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(ownerId, p.title, p.listing_type, p.property_type, p.city, p.locality, p.address, p.price, p.bedrooms, p.area_sqft,
          JSON.stringify(p.amenities), p.available ? 1 : 0, p.description, isSample ? 1 : 0)
      if (!isSample) audit(db, ownerId, 'property_created', { property_id: info.lastInsertRowid })
      return this.get(ownerId, info.lastInsertRowid)
    },
    update(ownerId, id, input) {
      const existing = this.get(ownerId, id)
      if (existing.is_sample) throw new HttpError(400, 'Sample properties are read-only. Add your own listing instead.')
      const p = parseOrThrow(propertySchema, { ...existing, ...input })
      db.prepare(
        `UPDATE properties SET title=?, listing_type=?, property_type=?, city=?, locality=?, address=?, price=?, bedrooms=?,
           area_sqft=?, amenities=?, available=?, description=?, updated_at=? WHERE id=? AND owner_id=?`
      ).run(p.title, p.listing_type, p.property_type, p.city, p.locality, p.address, p.price, p.bedrooms, p.area_sqft,
        JSON.stringify(p.amenities), p.available ? 1 : 0, p.description, nowIso(), id, ownerId)
      return this.get(ownerId, id)
    },
    match(ownerId, input) {
      const criteria = parseOrThrow(matchCriteriaSchema, input)
      const pool = this.list(ownerId, { includeSample: criteria.include_sample })
      return { criteria, searched: pool.length, results: matchProperties(pool, criteria) }
    }
  }
}

export { formatInr }
