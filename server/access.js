// Who may do what. Every route checks here on the server; the pages only hide what a role cannot use.
//   Agent  — the leads assigned to them (plus the unassigned pool, without contact details, to claim from),
//            any published listing, and the listings they own or are responsible for.
//   Buyer  — their own requirements (their lead), their matches, viewings, feedback and tenancies as tenant.
//   Seller — their own listings, anonymous match counts, viewings on their listings, tenancies as landlord.
import { AppError } from './errors.js'

export function requireRole(user, ...roles) {
  if (!user || !roles.includes(user.role)) throw new AppError(403, 'forbidden', `This is only for ${roles.map((r) => `${r}s`).join(' and ')}.`)
}

/** Express middleware: only these roles get past. */
export const allow = (...roles) => (req, res, next) => {
  try { requireRole(req.user, ...roles); next() } catch (error) { next(error) }
}

/** A lead this agent is responsible for. Anything else answers 404, so existence is not revealed. */
export function requireAgentLead(db, user, leadId) {
  requireRole(user, 'agent')
  const row = db.prepare('SELECT id, assigned_agent_id FROM leads WHERE id = ?').get(leadId)
  if (!row || row.assigned_agent_id !== user.id) throw new AppError(404, 'lead_not_found', `No lead with id ${leadId}.`)
  return row
}

export const canSeeAllPropertyFields = (user, p) => Boolean(user && p && (p.owner_user_id === user.id || p.agent_id === user.id))

/** May this person see this listing at all? Published and available ones are visible to every signed-in role. */
export function canViewProperty(user, p) {
  if (!user || !p) return false
  if (canSeeAllPropertyFields(user, p)) return true
  if (p.listing_state !== 'published') return false
  if (user.role === 'agent') return true
  if (p.is_sample) return false
  return p.status === 'available'
}

/** Only the listing's owner, or the agent responsible for it, may change it. */
export function requirePropertyEditor(user, p) {
  if (!p || !canViewProperty(user, p)) throw new AppError(404, 'property_not_found', 'No such property.')
  if (!canSeeAllPropertyFields(user, p)) throw new AppError(403, 'forbidden', 'Only the listing’s owner or its agent can change it.')
}

/** What a viewer who is not the owner or the listing's agent sees: no street address, notes or owner. */
export function propertyView(user, p) {
  if (!p) return null
  if (canSeeAllPropertyFields(user, p)) return { ...p, mine: true }
  const { address, notes, owner_user_id, created_by, ...rest } = p // eslint-disable-line no-unused-vars
  return { ...rest, address: user?.role === 'agent' ? address : null, mine: false }
}
