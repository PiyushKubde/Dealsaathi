// Role profiles, the buyer's requirements, and agent assignment.
//
// How an agent is assigned (never "every agent"):
//   1. A lead an agent adds is theirs.
//   2. A self-registered buyer who agrees to matching goes to an agent who serves their area (an agent profile's
//      service areas, matched against the buyer's preferred location) and is accepting leads; among several, the
//      one with the fewest open leads, then the longest-registered.
//   3. Nobody serves the area → the lead waits in the unassigned pool. No one is notified; any agent may claim it
//      (claiming is atomic: two agents cannot both get it). Contact details are hidden until it is claimed.
//   4. The assigned agent may transfer a lead to another agent.
// Sellers get an agent the same way, from their first listing's locality and city; their listings follow.
import { now, transaction } from '../db.js'
import { AppError, validationError } from '../errors.js'
import { assignLead, createLead, getLead, logActivity, updateLead } from '../leads/service.js'
import { cleanLeadFields } from '../leads/validate.js'
import { emit } from '../events/bus.js'
import { storedMatchesForLead } from '../matching/engine.js'
import { propertyView } from '../access.js'

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const bool = (v) => (v === true ? 1 : v === false ? 0 : null)

/** The agent for a location, by the rule above, or null. */
export function chooseAgent(db, location) {
  const wanted = norm(location)
  if (!wanted) return null
  const agents = db.prepare(`SELECT u.id, u.created_at, p.service_areas,
                               (SELECT COUNT(*) FROM leads l WHERE l.assigned_agent_id = u.id AND l.status NOT IN ('won','lost')) AS load
                             FROM users u JOIN agent_profiles p ON p.user_id = u.id WHERE u.role = 'agent' AND p.accepting_leads = 1`).all()
  const serving = agents.filter((a) => JSON.parse(a.service_areas || '[]').some((area) => {
    const n = norm(area)
    return n && (` ${wanted} `.includes(` ${n} `) || n === wanted)
  }))
  serving.sort((a, b) => a.load - b.load || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
  return serving[0]?.id ?? null
}

export function getProfile(db, user) {
  if (user.role === 'agent') {
    const p = db.prepare('SELECT * FROM agent_profiles WHERE user_id = ?').get(user.id)
    return { phone: p?.phone ?? null, agency: p?.agency ?? null, serviceAreas: JSON.parse(p?.service_areas || '[]'), acceptingLeads: Boolean(p?.accepting_leads ?? 1) }
  }
  if (user.role === 'seller') {
    const p = db.prepare('SELECT s.*, u.name AS agent_name, u.email AS agent_email FROM seller_profiles s LEFT JOIN users u ON u.id = s.assigned_agent_id WHERE s.user_id = ?').get(user.id)
    return { phone: p?.phone ?? null, notifyInApp: Boolean(p?.notify_in_app ?? 1), agent: p?.assigned_agent_id ? { name: p.agent_name, email: p.agent_email } : null }
  }
  const p = db.prepare('SELECT * FROM buyer_profiles WHERE user_id = ?').get(user.id)
  const lead = p?.lead_id ? getLead(db, p.lead_id) : null
  const agent = lead?.assigned_agent_id ? db.prepare('SELECT name, email FROM users WHERE id = ?').get(lead.assigned_agent_id) : null
  return {
    phone: p?.phone ?? null, matchingConsent: Boolean(p?.matching_consent), notifyInApp: Boolean(p?.notify_in_app ?? 1), allowAgentEmail: Boolean(p?.allow_agent_email),
    requirements: lead ? requirementsOf(lead) : null, agent: agent ? { name: agent.name, email: agent.email } : null
  }
}

const REQ_FIELDS = ['customer_type', 'property_type', 'bedrooms', 'preferred_location', 'budget_min', 'budget_max', 'property_interest']
const requirementsOf = (lead) => Object.fromEntries([...REQ_FIELDS, 'phone'].map((f) => [f, lead[f] ?? null]))

export function updateAgentProfile(db, user, input) {
  const errors = {}
  const areas = input?.serviceAreas === undefined ? undefined : (Array.isArray(input.serviceAreas) ? input.serviceAreas : String(input.serviceAreas || '').split(','))
    .map((a) => String(a).trim()).filter(Boolean)
  if (areas && (areas.length > 30 || areas.some((a) => a.length > 60))) errors.serviceAreas = 'Up to 30 areas, each under 60 characters.'
  const agency = input?.agency === undefined ? undefined : String(input.agency || '').trim().slice(0, 100) || null
  const phone = input?.phone === undefined ? undefined : String(input.phone || '').trim() || null
  if (phone && !/^[+\d][\d\s-]{6,19}$/.test(phone)) errors.phone = 'Enter a valid phone number.'
  if (Object.keys(errors).length) throw validationError(errors)
  const cur = db.prepare('SELECT * FROM agent_profiles WHERE user_id = ?').get(user.id)
  db.prepare('UPDATE agent_profiles SET phone = ?, agency = ?, service_areas = ?, accepting_leads = ?, updated_at = ? WHERE user_id = ?').run(
    phone === undefined ? cur.phone : phone, agency === undefined ? cur.agency : agency, areas === undefined ? cur.service_areas : JSON.stringify([...new Set(areas)]),
    bool(input?.acceptingLeads) ?? cur.accepting_leads, now(), user.id)
  return getProfile(db, user)
}

export function updateSellerProfile(db, user, input) {
  const phone = input?.phone === undefined ? undefined : String(input.phone || '').trim() || null
  if (phone && !/^[+\d][\d\s-]{6,19}$/.test(phone)) throw validationError({ phone: 'Enter a valid phone number.' })
  const cur = db.prepare('SELECT * FROM seller_profiles WHERE user_id = ?').get(user.id)
  db.prepare('UPDATE seller_profiles SET phone = ?, notify_in_app = ?, updated_at = ? WHERE user_id = ?').run(phone === undefined ? cur.phone : phone, bool(input?.notifyInApp) ?? cur.notify_in_app, now(), user.id)
  return getProfile(db, user)
}

/** The seller's agent: kept once chosen; chosen from this listing's area the first time. */
export function agentForSeller(db, sellerId, property) {
  const cur = db.prepare('SELECT assigned_agent_id FROM seller_profiles WHERE user_id = ?').get(sellerId)
  if (cur?.assigned_agent_id) return cur.assigned_agent_id
  const agentId = chooseAgent(db, [property.locality, property.city].filter(Boolean).join(' ')) || chooseAgent(db, property.city)
  if (agentId) db.prepare('UPDATE seller_profiles SET assigned_agent_id = ?, updated_at = ? WHERE user_id = ?').run(agentId, now(), sellerId)
  return agentId
}

/**
 * Saves a buyer's requirements and settings. The first save creates their lead (the record matching reads);
 * later saves update it, and lead.created / lead.requirements_changed queue the matching. Consent to matching
 * decides whether an agent is assigned and whether the requirements are matched at all.
 */
export function saveBuyerRequirements(db, user, input) {
  const req = input?.requirements && typeof input.requirements === 'object' ? input.requirements : {}
  const fields = Object.fromEntries(Object.entries(req).filter(([k]) => [...REQ_FIELDS, 'phone'].includes(k)))
  if ('customer_type' in fields && !['buyer', 'tenant'].includes(fields.customer_type)) throw validationError({ customer_type: 'Choose buying or renting.' })
  const { errors } = cleanLeadFields(fields)
  if (Object.keys(errors).length) throw validationError(errors)
  return transaction(db, () => {
    const prof = db.prepare('SELECT * FROM buyer_profiles WHERE user_id = ?').get(user.id)
    const consent = typeof input?.matchingConsent === 'boolean' ? input.matchingConsent : Boolean(prof.matching_consent)
    const consentChanged = consent !== Boolean(prof.matching_consent)
    db.prepare('UPDATE buyer_profiles SET matching_consent = ?, consent_at = ?, notify_in_app = ?, allow_agent_email = ?, phone = coalesce(?, phone), updated_at = ? WHERE user_id = ?').run(
      consent ? 1 : 0, consentChanged ? now() : prof.consent_at, bool(input?.notifyInApp) ?? prof.notify_in_app, bool(input?.allowAgentEmail) ?? prof.allow_agent_email,
      fields.phone ?? null, now(), user.id)
    let lead = prof.lead_id ? getLead(db, prof.lead_id) : null
    if (!lead) {
      const agentId = consent ? chooseAgent(db, fields.preferred_location) : null
      lead = createLead(db, { customer_type: 'buyer', ...fields, full_name: user.name, email: user.email, source: 'website' },
        { via: 'buyer', userId: user.id, assignTo: agentId, assignmentRule: 'service_area', buyerUserId: user.id })
      db.prepare('UPDATE buyer_profiles SET lead_id = ? WHERE user_id = ?').run(lead.id, user.id)
    } else {
      updateLead(db, lead.id, fields, { via: 'buyer', userId: user.id, buyerOwned: true })
      lead = getLead(db, lead.id)
      if (consentChanged) {
        logActivity(db, lead.id, 'consent_changed', consent ? 'The buyer agreed to matching' : 'The buyer withdrew consent to matching', null, 'buyer', user.id)
        emit(db, 'lead.requirements_changed', { subjectType: 'lead', subjectId: lead.id, actorId: user.id, agentId: lead.assigned_agent_id, payload: { fields: ['consent'], via: 'buyer' } })
      }
      if (consent && !lead.assigned_agent_id) {
        const agentId = chooseAgent(db, lead.preferred_location)
        if (agentId) lead = assignLead(db, lead.id, agentId, { rule: 'service_area', actorId: user.id })
      }
    }
    return getProfile(db, user)
  })
}

/** The buyer's recommendations: their stored matches, best first. Samples and other people's data never appear. */
export function buyerRecommendations(db, user) {
  const prof = db.prepare('SELECT lead_id, matching_consent FROM buyer_profiles WHERE user_id = ?').get(user.id)
  if (!prof?.lead_id) return { recommendations: [], state: 'no_requirements' }
  if (!prof.matching_consent) return { recommendations: [], state: 'no_consent' }
  const matches = storedMatchesForLead(db, prof.lead_id, { includeSamples: false })
  return { state: 'ok', recommendations: matches.map((m) => ({ property: propertyView(user, m.property), score: m.score, reasons: m.reasons, gaps: m.gaps, matchedAt: m.matchedAt })) }
}

/** Leads nobody is responsible for yet, as a claimable summary: requirements only, no contact details. */
export function unassignedPool(db) {
  const rows = db.prepare(`SELECT l.* FROM leads l LEFT JOIN buyer_profiles b ON b.lead_id = l.id
                           WHERE l.assigned_agent_id IS NULL AND l.status NOT IN ('won','lost') AND (l.buyer_user_id IS NULL OR b.matching_consent = 1)
                           ORDER BY l.created_at DESC LIMIT 100`).all()
  // A self-registered buyer agreed to share their details with the one agent assigned to them, not with every
  // agent: until claimed, they appear without any name.
  return rows.map((l) => ({ id: l.id, code: `L-${String(l.id).padStart(4, '0')}`, firstName: l.buyer_user_id ? null : l.full_name.split(' ')[0], customerType: l.customer_type, selfRegistered: Boolean(l.buyer_user_id),
    preferredLocation: l.preferred_location, bedrooms: l.bedrooms, budgetMax: l.budget_max, propertyType: l.property_type, createdAt: l.created_at }))
}

export function claimLead(db, agent, leadId) {
  const lead = getLead(db, leadId)
  if (!lead || lead.assigned_agent_id || ['won', 'lost'].includes(lead.status)) throw new AppError(409, 'already_assigned', 'This lead is no longer in the pool.')
  if (lead.buyer_user_id && !db.prepare('SELECT matching_consent FROM buyer_profiles WHERE user_id = ?').get(lead.buyer_user_id)?.matching_consent) throw new AppError(409, 'already_assigned', 'This lead is no longer in the pool.')
  return assignLead(db, leadId, agent.id, { rule: 'claimed_from_pool', actorId: agent.id, onlyIfUnassigned: true })
}

export function transferLead(db, agent, leadId, toAgentId) {
  const target = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'agent'").get(String(toAgentId || ''))
  if (!target) throw validationError({ agentId: 'Choose an agent.' })
  if (target.id === agent.id) throw validationError({ agentId: 'This lead is already yours.' })
  return assignLead(db, leadId, target.id, { rule: 'transferred', actorId: agent.id })
}

export const listAgents = (db) => db.prepare("SELECT u.id, u.name, p.agency FROM users u JOIN agent_profiles p ON p.user_id = u.id WHERE u.role = 'agent' ORDER BY u.name").all().map((r) => ({ ...r }))
