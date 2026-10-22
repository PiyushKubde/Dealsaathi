// The agent's fixed tool set. Each tool wraps an existing, permission-checked function and runs as the signed-in
// user. The model only proposes a tool and arguments; validate() decides what is allowed, run() does the work.
// No tool sends a message, takes a payment or books a calendar slot: the one consequential tool only prepares a
// viewing request, which the user's own Confirm click sends (see runtime.js confirmAgentAction).
import { randomUUID } from 'node:crypto'
import { now } from '../db.js'
import { AppError } from '../errors.js'
import { getSetting } from '../automations/store.js'
import { getLead } from '../leads/service.js'
import { PROPERTY_TYPES } from '../leads/validate.js'
import { buyerRecommendations, getProfile } from '../profiles/service.js'
import { listProperties, scoreMatch, viewProperty, withExclusions } from '../properties/service.js'
import { addDays, todayIn } from '../time.js'
import { buyerSlots } from '../viewings/service.js'
import { inr, parseRequest, toRupees } from './parse.js'

/** Bad arguments from the model: reported back to it, never shown as a server error. */
export class ToolInputError extends Error {
  constructor(message) { super(message); this.code = 'invalid_arguments' }
}

export const ACTION_TTL_MS = 30 * 60 * 1000
const CALENDAR_READS = { max: 20, windowMs: 15 * 60 * 1000 }
const calendarReads = new Map() // userId → times: each check reads the agent's real calendar through viaSocket
function calendarRead(userId) {
  const t = Date.now()
  const list = (calendarReads.get(userId) || []).filter((x) => t - x < CALENDAR_READS.windowMs)
  if (list.length >= CALENDAR_READS.max) throw new AppError(429, 'too_many_requests', 'Too many calendar checks in a short time. Try again in a few minutes.')
  list.push(t)
  calendarReads.set(userId, list)
}
const UNITS = ['rupees', 'thousand', 'lakh', 'crore']
const TZ = 'Asia/Kolkata'
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w.length > 2)

const int = (v, name, min, max) => {
  if (v === null || v === undefined) return null
  if (!Number.isInteger(v) || v < min || v > max) throw new ToolInputError(`${name} must be a whole number from ${min} to ${max}.`)
  return v
}
const oneOf = (v, name, list) => {
  if (v === null || v === undefined) return null
  if (!list.includes(v)) throw new ToolInputError(`${name} must be one of: ${list.join(', ')}.`)
  return v
}
const rupees = (amount, unit, name) => {
  if (amount === null || amount === undefined) return null
  if (!UNITS.includes(unit)) throw new ToolInputError(`${name}: give the unit (${UNITS.join(', ')}) with the amount.`)
  const value = toRupees(amount, unit)
  if (value === null) throw new ToolInputError(`${name} is not a sensible amount.`)
  return value
}

/** A listing as the model and the page see it: no address, owner or notes (propertyView already removed them). */
function card(p, match = null) {
  return {
    id: p.id, title: String(p.title).slice(0, 120), listing_type: p.listing_type, property_type: p.property_type, bedrooms: p.bedrooms ?? null,
    price: p.price, price_text: `${inr(p.price)}${p.listing_type === 'rent' ? '/month' : ''}`, area_sqft: p.area_sqft ?? null,
    locality: p.locality ?? null, city: p.city, amenities: Array.isArray(p.amenities) ? p.amenities.slice(0, 6).map((a) => String(a).slice(0, 40)) : [],
    ...(match ? { score: match.score, reasons: match.reasons, gaps: match.gaps } : {})
  }
}

function buyerLead(db, user) {
  const prof = db.prepare('SELECT lead_id FROM buyer_profiles WHERE user_id = ?').get(user.id)
  const lead = prof?.lead_id ? getLead(db, prof.lead_id) : null
  return lead ? withExclusions(db, lead) : null
}

/**
 * What the buyer has asked for, field by field: the newest of their messages (ctx.userMessages, newest first) that
 * states or explicitly lifts it ("any number of bedrooms"). Fields they never mentioned are undefined; for those
 * the saved requirements or the criteria already in use may be used, never a value the model made up.
 */
const FIELDS = ['bedrooms', 'budget_max', 'budget_min', 'property_type', 'listing_type']
function stated(ctx) {
  const out = {}
  for (const text of ctx.userMessages) {
    const h = parseRequest(text)
    for (const f of FIELDS) {
      if (f in out) continue
      if (h.cleared.includes(f)) out[f] = null
      else if (h[f] !== null && h[f] !== undefined) out[f] = h[f]
    }
  }
  return out
}
function fallbackValues(ctx) {
  const saved = ctx.savedRequirements || {}
  const used = ctx.state.criteria || {}
  const savedType = saved.customer_type === 'tenant' ? 'rent' : saved.customer_type === 'buyer' ? 'sale' : null
  return Object.fromEntries(FIELDS.map((f) => [f, new Set([f === 'listing_type' ? savedType : saved[f], used[f]].filter((v) => v !== null && v !== undefined))]))
}
const show = (key, v) => (v === null ? 'any' : key.startsWith('budget') ? inr(v) : v)
const placeWords = (ctx) => new Set([...ctx.userMessages.flatMap(words), ...words(ctx.savedRequirements?.preferred_location), ...words(ctx.state.criteria?.location)])

function describeCriteria(c) {
  return [c.bedrooms ? `${c.bedrooms} BHK` : null, c.property_type ? c.property_type.replace('_', ' ') : null, c.location,
    c.budget_min ? `from ${inr(c.budget_min)}` : null, c.budget_max ? `up to ${inr(c.budget_max)}` : null, c.listing_type === 'rent' ? 'to rent' : 'to buy'].filter(Boolean).join(' · ')
}

function rank(pool, criteria) {
  return pool.map((p) => ({ p, m: scoreMatch(criteria, p) })).filter((x) => x.m)
    .sort((a, b) => b.m.score - a.m.score || a.p.price - b.p.price || a.p.id - b.p.id)
}

export const TOOLS = {
  get_my_requirements: {
    roles: ['buyer'],
    description: 'The buyer\'s saved requirements, whether matching is on, and whether their agent takes viewing requests.',
    fields: [],
    validate: () => ({}),
    run(ctx) {
      const prof = getProfile(ctx.db, ctx.user)
      const lead = buyerLead(ctx.db, ctx.user)
      const takesRequests = lead?.assigned_agent_id ? getSetting(ctx.db, lead.assigned_agent_id, 'viewing_scheduler').enabled : false
      const r = prof.requirements
      return {
        saved_requirements: r ? { ...r, phone: undefined, budget_max_text: r.budget_max ? inr(r.budget_max) : null, budget_min_text: r.budget_min ? inr(r.budget_min) : null } : null,
        matching_on: prof.matchingConsent, agent_name: prof.agent?.name ?? null, agent_takes_viewing_requests: Boolean(takesRequests)
      }
    },
    label: () => 'Read your saved requirements'
  },

  search_listings: {
    roles: ['buyer'],
    description: 'Search published, available listings and rank them against the buyer\'s criteria with DealSaathi\'s matching rules. Needs a location.',
    fields: ['location', 'bedrooms', 'budget_max_amount', 'budget_max_unit', 'budget_min_amount', 'budget_min_unit', 'listing_type', 'property_type', 'limit'],
    validate(a, ctx) {
      const location = typeof a.location === 'string' ? a.location.trim().replace(/\s+/g, ' ') : ''
      if (location.length < 2 || location.length > 80) throw new ToolInputError('location is required (the area or city the buyer named). If they have not said where, ask them.')
      const c = {
        location, bedrooms: int(a.bedrooms, 'bedrooms', 1, 10),
        budget_max: rupees(a.budget_max_amount, a.budget_max_unit, 'budget_max'), budget_min: rupees(a.budget_min_amount, a.budget_min_unit, 'budget_min'),
        listing_type: oneOf(a.listing_type, 'listing_type', ['sale', 'rent']), property_type: oneOf(a.property_type, 'property_type', PROPERTY_TYPES)
      }
      const limit = int(a.limit, 'limit', 1, 10) ?? 5
      if (c.budget_min && c.budget_max && c.budget_min > c.budget_max) throw new ToolInputError('budget_min is above budget_max.')
      // Grounding: what the buyer said wins, exactly; a field they never mentioned may come from their saved
      // requirements or the search already in use, or be left out. Anything else goes back to the model to ask.
      const said = stated(ctx)
      const fallback = fallbackValues(ctx)
      for (const key of FIELDS) {
        if (key in said) {
          if (c[key] === said[key]) continue
          if (said[key] === null) throw new ToolInputError(`${key}: the buyer said any, so leave it null.`)
          throw new ToolInputError(`${key}: the buyer asked for ${show(key, said[key])}${c[key] === null ? '; include it, or ask before dropping it' : `, not ${show(key, c[key])}; use exactly that, or ask before changing it`}.`)
        }
        if (c[key] !== null && !fallback[key].has(c[key])) {
          throw new ToolInputError(`${key} ${show(key, c[key])} is not something the buyer asked for or saved. Leave it null or ask them.`)
        }
      }
      const extra = words(location).filter((w) => !placeWords(ctx).has(w))
      if (extra.length) throw new ToolInputError(`location "${location}" adds words the buyer did not say (${extra.join(', ')}). Use the place exactly as the buyer named it.`)
      return { ...c, limit }
    },
    run(ctx, c) {
      const lead = buyerLead(ctx.db, ctx.user)
      const listingType = c.listing_type || (lead?.customer_type === 'tenant' ? 'rent' : 'sale')
      const base = { customer_type: listingType === 'rent' ? 'tenant' : 'buyer', preferred_location: c.location, bedrooms: c.bedrooms, budget_max: c.budget_max, budget_min: c.budget_min, property_type: c.property_type }
      const criteria = { ...base, excludedPropertyIds: lead?.excludedPropertyIds || [], excluded_localities: lead?.excluded_localities || null }
      // listProperties(market) for a buyer: published, available, real listings only.
      const pool = listProperties(ctx.db, ctx.user, { scope: 'market', listing_type: listingType, limit: 200 })
      const ranked = rank(pool, criteria)
      const withoutFeedback = rank(pool, base).length
      const used = { ...c, listing_type: listingType, limit: undefined }
      let relaxations = null
      if (ranked.length < 3) {
        relaxations = {}
        // How many would fit (in total) if the buyer relaxed one thing: for the model to offer, never to apply.
        if (c.budget_max) relaxations.would_fit_with_budget_10_percent_higher = rank(pool, { ...criteria, budget_max: Math.round(c.budget_max * 1.1) }).length
        if (c.bedrooms) relaxations.would_fit_with_any_bedroom_count = rank(pool, { ...criteria, bedrooms: null }).length
        if (c.property_type) relaxations.would_fit_with_any_property_type = rank(pool, { ...criteria, property_type: null }).length
        relaxations.would_fit_in_any_location = rank(pool, { ...criteria, preferred_location: null }).length
      }
      return {
        criteria_used: { ...used, summary: describeCriteria(used), budget_max_text: c.budget_max ? inr(c.budget_max) : null },
        considered: pool.length, matched: ranked.length, left_out_by_your_feedback: Math.max(0, withoutFeedback - ranked.length),
        listings: ranked.slice(0, c.limit).map(({ p, m }) => card(p, m)),
        relaxations,
        how_ranked: 'Location 35 (area) or 25 (city), within budget 30, exact bedrooms 25, property type 10. Over budget, other bedroom counts or another place are left out.'
      }
    },
    label: (c, r) => `Searched published listings (${describeCriteria(r.criteria_used)}): ${r.matched} of ${r.considered} fit`
  },

  get_listing: {
    roles: ['buyer'],
    description: 'One listing the buyer may see, by id.',
    fields: ['property_id'],
    validate: (a) => {
      const id = int(a.property_id, 'property_id', 1, 1e9)
      if (!id) throw new ToolInputError('property_id is required.')
      return { property_id: id }
    },
    run: (ctx, a) => ({ listing: card(viewProperty(ctx.db, ctx.user, a.property_id)) }),
    label: (a, r) => `Opened ${r.listing.title}`
  },

  get_my_recommendations: {
    roles: ['buyer'],
    description: 'The buyer\'s stored matches for their saved requirements, best first.',
    fields: [],
    validate: () => ({}),
    run(ctx) {
      const r = buyerRecommendations(ctx.db, ctx.user)
      return { state: r.state, listings: r.recommendations.slice(0, 5).map((x) => card(x.property, x)) }
    },
    label: (a, r) => `Read your recommendations: ${r.listings.length}`
  },

  get_viewing_slots: {
    roles: ['buyer'],
    description: 'Free times in the buyer\'s agent\'s real Google Calendar on one date, for a listing. Read only.',
    fields: ['property_id', 'date'],
    validate(a) {
      const id = int(a.property_id, 'property_id', 1, 1e9)
      if (!id) throw new ToolInputError('property_id is required.')
      if (typeof a.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(a.date)) throw new ToolInputError('date must be YYYY-MM-DD. If the buyer has not said which day, ask them.')
      const today = todayIn(TZ)
      if (a.date < today || a.date > addDays(today, 60)) throw new ToolInputError(`date must be from ${today} to ${addDays(today, 60)}.`)
      return { property_id: id, date: a.date }
    },
    async run(ctx, a) {
      const listing = card(viewProperty(ctx.db, ctx.user, a.property_id))
      calendarRead(ctx.user.id)
      const r = await buyerSlots(ctx.db, ctx.vs, ctx.user, { propertyId: a.property_id, date: a.date })
      const slots = r.slots.map((s) => ({ start: s.start, label: s.label }))
      ctx.state.offers = [{ property_id: a.property_id, title: listing.title, date: a.date, timezone: r.timezone, agent_name: r.agentName, slots, at: now() }, ...(ctx.state.offers || [])].slice(0, 3)
      return { property_id: a.property_id, title: listing.title, agent_name: r.agentName, date: a.date, timezone: r.timezone, free_times: slots.slice(0, 16), total_free: slots.length }
    },
    label: (a, r) => `Checked ${r.agent_name}'s calendar on ${a.date}: ${r.total_free} free time${r.total_free === 1 ? '' : 's'}`
  },

  propose_viewing_request: {
    roles: ['buyer'],
    consequential: true,
    description: 'Prepare a viewing request for one free time you showed the buyer (up to 3 listings in one visit). Nothing is sent: the buyer must press Confirm, and the agent then confirms before it is booked.',
    fields: ['property_ids', 'start'],
    validate(a, ctx) {
      if (!Array.isArray(a.property_ids) || !a.property_ids.length) throw new ToolInputError('property_ids is required (1 to 3 listings).')
      const ids = [...new Set(a.property_ids)]
      if (ids.length > 3 || ids.some((id) => !Number.isInteger(id) || id < 1)) throw new ToolInputError('property_ids must be 1 to 3 listing ids.')
      if (typeof a.start !== 'string') throw new ToolInputError('start is required: one of the free times you showed (its start value).')
      const offer = (ctx.state.offers || []).find((o) => ids.includes(o.property_id) && o.slots.some((s) => s.start === a.start) && Date.now() - Date.parse(o.at) < ACTION_TTL_MS)
      if (!offer) throw new ToolInputError('start must be one of the free times shown to the buyer in the last 30 minutes for one of these listings. Check the calendar first.')
      return { property_ids: ids, start: a.start, offer }
    },
    run(ctx, a) {
      const listings = a.property_ids.map((id) => card(viewProperty(ctx.db, ctx.user, id)))
      const dup = ctx.db.prepare("SELECT id FROM agent_actions WHERE user_id = ? AND status = 'awaiting_confirmation' AND params = ?").get(ctx.user.id, JSON.stringify({ propertyIds: a.property_ids, start: a.start, timezone: a.offer.timezone }))
      if (dup) return { action_id: dup.id, already_prepared: true }
      const id = randomUUID()
      const slot = a.offer.slots.find((s) => s.start === a.start)
      ctx.db.prepare(`INSERT INTO agent_actions (id, conversation_id, user_id, type, params, status, expires_at, created_at, updated_at)
                      VALUES (?, ?, ?, 'request_viewing', ?, 'awaiting_confirmation', ?, ?, ?)`)
        .run(id, ctx.conversationId, ctx.user.id, JSON.stringify({ propertyIds: a.property_ids, start: a.start, timezone: a.offer.timezone }), new Date(Date.now() + ACTION_TTL_MS).toISOString(), now(), now())
      return { action_id: id, listings: listings.map((l) => l.title), when: `${a.offer.date} ${slot.label} (${a.offer.timezone})`, agent_name: a.offer.agent_name }
    },
    label: () => 'Prepared a viewing request for you to confirm'
  }
}

/** The tools a role may use: a buyer gets all of the above; other roles get none in this milestone. */
export const toolsFor = (role) => Object.entries(TOOLS).filter(([, t]) => t.roles.includes(role)).map(([name]) => name)

/** Maps a service error to what the model may read: its code and the user-facing message, nothing internal. */
export function toolError(error) {
  if (error instanceof ToolInputError) return { code: error.code, message: error.message }
  if (error instanceof AppError) return { code: error.code, message: error.message }
  return { code: 'tool_failed', message: 'This step failed unexpectedly.' }
}
