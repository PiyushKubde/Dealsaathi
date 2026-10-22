// What each platform event does. Every handler is safe to run again: matching is an upsert, notifications and
// automation runs carry dedupe keys, and external sends are claimed before they are attempted.
import { getLead } from '../leads/service.js'
import { getProperty } from '../properties/service.js'
import { matchLead, matchProperty } from '../matching/engine.js'
import { claimExternal, finishExternal, notifyInApp } from '../notifications/service.js'
import { finishRun, getSetting, startRun } from '../automations/store.js'
import { describeInZone } from '../time.js'
import { createInterestHandler } from '../interests/service.js'
import { createOfferHandler } from '../offers/service.js'

const inr = (n) => (n >= 1e7 ? `₹${+(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `₹${+(n / 1e5).toFixed(2)} L` : `₹${Number(n).toLocaleString('en-IN')}`)
const userRow = (db, id) => (id ? db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(id) : null)
const retryable = (message) => Object.assign(new Error(message), { permanent: false })

/**
 * deps: { db, notifyThrough(user, config, { subject, text }) → { status, summary?, error? }, leadAlertMessage(lead, actor, via) }
 */
export function createHandlers({ db, notifyThrough, leadAlertMessage }) {
  const sellerWantsInApp = (id) => Boolean(db.prepare("SELECT notify_in_app FROM seller_profiles s JOIN users u ON u.id = s.user_id WHERE s.user_id = ? AND u.role = 'seller'").get(id)?.notify_in_app)
  const buyerWantsInApp = (id) => Boolean(db.prepare('SELECT notify_in_app FROM buyer_profiles WHERE user_id = ?').get(id)?.notify_in_app)
  const matchingOn = (agentId) => getSetting(db, agentId, 'buyer_matching').enabled

  /** New Lead Alert, for the lead's assigned agent only. */
  async function leadAlert(event, lead, kind) {
    const agentId = lead.assigned_agent_id
    if (!agentId) return { alert: 'unassigned', note: 'The lead waits in the unassigned pool; no agent was notified.' }
    if (kind === 'assigned' && event.agentId !== agentId) return { alert: 'skipped', note: 'The lead was reassigned again before this was processed.' }
    const agent = userRow(db, agentId)
    const actor = userRow(db, event.actorId)
    const out = {}
    if (event.actorId !== agentId) {
      const via = lead.buyer_user_id ? 'registered as a buyer' : kind === 'assigned' ? 'was assigned to you' : 'was added'
      out.inApp = notifyInApp(db, agentId, {
        kind: 'lead', title: `New lead: ${lead.full_name} (${lead.customer_type})`, body: `${lead.full_name} ${via}${lead.preferred_location ? `, looking in ${lead.preferred_location}` : ''}.`,
        link: `#/leads/${lead.id}`, subjectType: 'lead', subjectId: lead.id, dedupeKey: `lead:${lead.id}:${agentId}`, eventId: event.id
      }) ? 'created' : 'already_notified'
    }
    const setting = getSetting(db, agentId, 'new_lead_alert')
    if (!setting.enabled) return { ...out, alert: 'off' }
    const runId = startRun(db, { userId: agentId, key: 'new_lead_alert', trigger: kind === 'assigned' ? 'Lead assigned to you' : 'Lead created', subjectType: 'lead', subjectId: lead.id, dedupeKey: `new_lead_alert:${agentId}:${lead.id}` })
    if (!runId) return { ...out, alert: 'already_sent' }
    const sent = await notifyThrough(agent, setting.config, leadAlertMessage(lead, actor, event.payload?.via))
    finishRun(db, runId, sent)
    console.log(`[automation] new_lead_alert ${runId} ${sent.status}`)
    return { ...out, alert: sent.status, runId }
  }

  /** Records what matching did as a run of New Property Matching for the responsible agent. */
  function recordMatching(agentId, trigger, label, result) {
    if (!agentId) return
    const runId = startRun(db, { userId: agentId, key: 'buyer_matching', trigger })
    finishRun(db, runId, { status: 'succeeded', summary: `${label}: ${result.matched} match${result.matched === 1 ? '' : 'es'}${result.newMatches ? ` (${result.newMatches} new or changed)` : ''}${result.withdrawn ? `, ${result.withdrawn} withdrawn` : ''}${result.reason ? ` — ${result.reason}` : ''}` })
  }

  async function onLeadMatched(event) {
    const lead = getLead(db, Number(event.subjectId))
    if (!lead) return { skipped: 'lead deleted' }
    const result = matchLead(db, lead.id, { trigger: `evt${event.id}`, actorId: event.actorId })
    recordMatching(lead.assigned_agent_id, event.type === 'lead.created' ? 'Lead saved' : 'Requirements changed', lead.full_name, result)
    return { matching: result }
  }

  async function onPropertyChanged(event) {
    const property = getProperty(db, Number(event.subjectId))
    if (!property) return { skipped: 'listing deleted' }
    const result = matchProperty(db, property.id, { trigger: `evt${event.id}`, actorId: event.actorId })
    const label = { 'property.published': 'Listing published', 'property.changed': 'Listing changed', 'property.unpublished': 'Listing taken down' }[event.type]
    recordMatching(property.agent_id, label, property.title, result)
    // A seller's newly published listing: tell their agent (they did not publish it themselves).
    if (event.type === 'property.published' && property.agent_id && event.actorId !== property.agent_id) {
      notifyInApp(db, property.agent_id, { kind: 'listing', title: `New listing published: ${property.title}`, body: `${inr(property.price)} in ${[property.locality, property.city].filter(Boolean).join(', ')}.`, link: `#/properties/${property.id}`, subjectType: 'property', subjectId: property.id, dedupeKey: `listing_published:${property.id}`, eventId: event.id })
    }
    return { matching: result }
  }

  async function onMatchCreated(event) {
    const { leadId, propertyId, fingerprint: fp, trigger } = event.payload
    const lead = getLead(db, leadId)
    const property = getProperty(db, propertyId)
    const row = db.prepare('SELECT status, fingerprint FROM property_matches WHERE lead_id = ? AND property_id = ?').get(leadId, propertyId)
    if (!lead || !property || row?.status !== 'suggested' || row.fingerprint !== fp) return { skipped: 'the match changed or was withdrawn before it was announced' }
    const sent = []
    const key = `match:${leadId}:${propertyId}:${fp}`
    if (lead.buyer_user_id && !property.is_sample && buyerWantsInApp(lead.buyer_user_id)) {
      if (notifyInApp(db, lead.buyer_user_id, { kind: 'match', title: `New match: ${property.title}`, body: `${inr(property.price)}${property.listing_type === 'rent' ? '/month' : ''} in ${[property.locality, property.city].filter(Boolean).join(', ')} fits your requirements.`, link: '#/recommendations', subjectType: 'property', subjectId: propertyId, dedupeKey: key, eventId: event.id })) sent.push('buyer')
    }
    if (lead.assigned_agent_id && matchingOn(lead.assigned_agent_id)) {
      if (notifyInApp(db, lead.assigned_agent_id, { kind: 'match', title: `New match for ${lead.full_name}: ${property.title}`, link: `#/leads/${lead.id}`, subjectType: 'lead', subjectId: leadId, dedupeKey: key, eventId: event.id })) sent.push('buyer_agent')
    }
    // The listing's side learns that buyers match, never who they are.
    const listingKey = `listing_match:${propertyId}:${trigger}`
    if (property.agent_id && property.agent_id !== lead.assigned_agent_id && matchingOn(property.agent_id)) {
      if (notifyInApp(db, property.agent_id, { kind: 'listing_match', title: `Your listing ${property.title} matches buyer requirements`, link: `#/properties/${propertyId}`, subjectType: 'property', subjectId: propertyId, dedupeKey: listingKey, eventId: event.id })) sent.push('listing_agent')
    }
    if (property.owner_user_id && property.owner_user_id !== property.agent_id && sellerWantsInApp(property.owner_user_id)) {
      if (notifyInApp(db, property.owner_user_id, { kind: 'listing_match', title: `Buyers are matching your listing ${property.title}`, link: `#/my-listings/${propertyId}`, subjectType: 'property', subjectId: propertyId, dedupeKey: listingKey, eventId: event.id })) sent.push('seller')
    }
    return { notified: sent }
  }

  /** New Property Matching's external notice: one message per triggering change, to the buyer's agent. */
  async function onMatchDigest(event) {
    const agentId = event.agentId
    const setting = getSetting(db, agentId, 'buyer_matching')
    if (!setting.enabled || !['gmail', 'slack'].includes(setting.config.notify)) return { external: 'not_configured' }
    const live = event.payload.matches.map((m) => ({ ...m, lead: getLead(db, m.leadId), property: getProperty(db, m.propertyId), row: db.prepare('SELECT status, fingerprint, score FROM property_matches WHERE lead_id = ? AND property_id = ?').get(m.leadId, m.propertyId) }))
      .filter((m) => m.lead?.assigned_agent_id === agentId && m.property && m.row?.status === 'suggested' && m.row.fingerprint === m.fingerprint)
    if (!live.length) return { external: 'nothing_current' }
    const id = claimExternal(db, agentId, setting.config.notify, { kind: 'match_digest', title: `${live.length} new match${live.length === 1 ? '' : 'es'}`, dedupeKey: `match_digest:${event.payload.trigger}`, eventId: event.id })
    if (!id) return { external: 'already_sent' }
    const agent = userRow(db, agentId)
    const text = live.map((m) => `• ${m.lead.full_name} ↔ ${m.property.title} (${inr(m.property.price)}, ${[m.property.locality, m.property.city].filter(Boolean).join(', ')}) — score ${m.row.score}/100`).join('\n')
    const out = await notifyThrough(agent, { ...setting.config, channel: setting.config.notify }, { subject: `${live.length} new property match${live.length === 1 ? '' : 'es'} for your buyers`, text })
    finishExternal(db, id, out.status === 'succeeded' ? 'sent' : out.status, out.summary || out.error)
    const runId = startRun(db, { userId: agentId, key: 'buyer_matching', trigger: 'New matches found' })
    finishRun(db, runId, { status: out.status, summary: out.status === 'succeeded' ? out.summary : 'Match notice not sent', error: out.error ?? null })
    if (out.status === 'failed') throw retryable(`The match notice was not sent: ${out.error}`)
    return { external: out.status }
  }

  const viewingParties = (v) => {
    const lead = getLead(db, v.lead_id)
    const props = JSON.parse(v.property_ids).map((id) => getProperty(db, id)).filter(Boolean)
    return { lead, props, when: describeInZone(v.start_at, v.timezone) }
  }

  async function onViewing(event) {
    const v = db.prepare('SELECT * FROM viewings WHERE id = ?').get(event.subjectId)
    if (!v) return { skipped: 'viewing deleted' }
    const { lead, props, when } = viewingParties(v)
    const titles = props.map((p) => p.title).join(', ')
    const done = []
    const kind = event.type.split('.')[1]
    if (kind === 'requested') {
      notifyInApp(db, v.user_id, { kind: 'viewing', title: `Viewing requested: ${lead?.full_name}`, body: `${titles} — ${when}. Confirm it to book it in your calendar.`, link: '#/viewings', subjectType: 'viewing', subjectId: v.id, dedupeKey: `viewing:${v.id}:requested`, eventId: event.id })
      return { notified: ['agent'] }
    }
    const text = { booked: `Your viewing is booked for ${when}`, rescheduled: `Your viewing moved to ${when}`, cancelled: `The viewing on ${when} was cancelled`, completed: 'Tell us how the viewing went: it improves your matches' }[kind]
    if (lead?.buyer_user_id && text) {
      notifyInApp(db, lead.buyer_user_id, { kind: 'viewing', title: text, body: titles, link: '#/my-viewings', subjectType: 'viewing', subjectId: v.id, dedupeKey: `viewing:${v.id}:${kind}:${v.start_at}`, eventId: event.id })
      done.push('buyer')
    }
    if (['booked', 'rescheduled', 'cancelled'].includes(kind)) {
      for (const p of props) {
        if (p.owner_user_id && p.owner_user_id !== v.user_id && sellerWantsInApp(p.owner_user_id)) {
          notifyInApp(db, p.owner_user_id, { kind: 'viewing', title: `Viewing ${kind} for ${p.title}`, body: when, link: `#/my-listings/${p.id}`, subjectType: 'viewing', subjectId: v.id, dedupeKey: `viewing:${v.id}:${kind}:${v.start_at}:${p.id}`, eventId: event.id })
          done.push('seller')
        }
      }
    }
    return { notified: done }
  }

  async function onFeedback(event) {
    const row = db.prepare('SELECT * FROM feedback_requests WHERE id = ?').get(event.subjectId)
    if (!row) return { skipped: 'feedback deleted' }
    const lead = getLead(db, row.lead_id)
    notifyInApp(db, row.user_id, { kind: 'feedback', title: `Feedback received from ${lead?.full_name ?? 'a buyer'}`, link: '#/feedback', subjectType: 'feedback', subjectId: row.id, dedupeKey: `feedback:${row.id}`, eventId: event.id })
    return { notified: ['agent'] }
  }

  async function onRent(event) {
    const t = db.prepare('SELECT * FROM tenancies WHERE id = ?').get(Number(event.subjectId))
    if (!t) return { skipped: 'tenancy deleted' }
    const p = event.payload
    const done = []
    const tell = (userId, title, link) => { if (userId && notifyInApp(db, userId, { kind: 'rent', title, body: t.property_label, link, subjectType: 'tenancy', subjectId: t.id, dedupeKey: `${event.type}:${event.payload.key || event.id}:${userId}`, eventId: event.id })) done.push(userId === t.tenant_user_id ? 'tenant' : 'landlord') }
    if (event.type === 'rent.payment_recorded') {
      tell(t.landlord_user_id, `Rent payment of ${inr(p.amount)} recorded for ${p.period} (${p.source === 'razorpay' ? 'confirmed by Razorpay' : 'recorded manually'})`, '#/my-tenancies')
      tell(t.tenant_user_id, `Your rent payment of ${inr(p.amount)} for ${p.period} was recorded`, '#/my-tenancies')
    } else if (event.type === 'rent.reminder_sent') {
      tell(t.tenant_user_id, `Rent for ${p.period}: ${p.label}`, '#/my-tenancies')
    } else if (event.type === 'tenancy.linked') {
      // Only the person who was just linked is told.
      if (p.tenantNew) tell(t.tenant_user_id, 'A tenancy was linked to your account', '#/my-tenancies')
      if (p.landlordNew) tell(t.landlord_user_id, 'A tenancy on your property was linked to your account', '#/my-tenancies')
    }
    return { notified: done }
  }

  return {
    'lead.created': async (e) => {
      const lead = getLead(db, Number(e.subjectId))
      if (!lead) return { skipped: 'lead deleted' }
      const out = ['buyer', 'tenant'].includes(lead.customer_type) ? await onLeadMatched(e) : {}
      return { ...out, ...(await leadAlert(e, getLead(db, lead.id), 'created')) }
    },
    'lead.assigned': async (e) => {
      const lead = getLead(db, Number(e.subjectId))
      return lead ? leadAlert(e, lead, 'assigned') : { skipped: 'lead deleted' }
    },
    'lead.requirements_changed': onLeadMatched,
    'property.published': onPropertyChanged,
    'property.changed': onPropertyChanged,
    'property.unpublished': onPropertyChanged,
    'match.created': onMatchCreated,
    'match.digest': onMatchDigest,
    'viewing.requested': onViewing,
    'viewing.booked': onViewing,
    'viewing.rescheduled': onViewing,
    'viewing.cancelled': onViewing,
    'viewing.completed': onViewing,
    'feedback.submitted': onFeedback,
    'interest.created': createInterestHandler({ db, notifyInApp }),
    'offer.changed': createOfferHandler({ db, notifyInApp, buyerWantsInApp, sellerWantsInApp }),
    'rent.payment_recorded': onRent,
    'rent.reminder_sent': onRent,
    'tenancy.linked': onRent
  }
}
