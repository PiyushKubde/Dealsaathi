# DealSaathi architecture: a three-sided marketplace

## Data model (schema v6)

```
users (role: buyer | seller | agent)
 ├─ agent_profiles   (service_areas, accepting_leads)
 ├─ buyer_profiles   (lead_id → leads, matching_consent, notify_in_app, allow_agent_email)
 └─ seller_profiles  (assigned_agent_id → users)

leads ── assigned_agent_id → users (agent)        a buyer's requirements are their own lead row
      ── buyer_user_id     → users (buyer)        (leads.buyer_user_id), so matching reads one table
properties ── owner_user_id → users (seller or agent)
           ── agent_id      → users (agent responsible)
           ── listing_state: draft | published | unpublished | archived
property_matches (property, lead) score, reasons, status (suggested | dismissed | withdrawn), fingerprint
domain_events    type, subject, actor, agent, payload, dedupe_key, status, attempts, next_attempt_at, lease
notifications    user, kind, channel (in_app | gmail | slack | whatsapp), status, dedupe_key
viewings ── user_id (agent), lead_id, requested_by (buyer) ─ feedback_requests
tenancies ── user_id (agent), tenant_user_id, landlord_user_id ─ rent_dues ─ rent_payments, rent_reminders, rent_events
automation_settings / automation_runs (per agent)
```

Existing data (schema 5 and older) migrates in place: every existing account becomes an agent, each lead is assigned to
the agent who created it (or the only account), listings become published and owned by their creator, matches keep
their status. A full copy of the database is written next to it (`*.pre-v6-<time>.bak`) before migrating.

## Roles and access

`server/access.js` holds the rules; every route applies them. Another person's record answers **404** (its
existence is not revealed); a role that never has access answers **403**.

| | Buyer | Seller | Agent |
| --- | --- | --- | --- |
| Leads | own requirements only | — | assigned to them; pool summary (no names/contacts) |
| Listings | published + available, no address/notes | own (any state); counts of matching buyers | all published; own/responsible in full |
| Matches | own recommendations | anonymous counts | own buyers by name; others as a count |
| Viewings | request / cancel own; feedback | dates on own listings, no buyer | full management, in their own calendar |
| Tenancies | as tenant: read | as landlord: read + record rent received | manage |
| Automations, integrations | — | — | own |

## Agent assignment

1. A lead an agent adds is theirs (`created_by_agent`).
2. A buyer who registers and agrees to matching goes to an agent whose service areas appear in their preferred
   location and who accepts leads; ties go to the fewest open leads, then the longest-registered (`service_area`).
3. No such agent: the lead waits in the pool. **Nobody is notified.** Agents see requirements only and claim
   atomically (`claimed_from_pool`).
4. The responsible agent may transfer a lead (`transferred`); the new agent is notified.
5. A seller gets an agent the same way from their first listing's locality/city; their listings follow.

## The event queue

Every platform change writes a `domain_events` row **in the same transaction** as the change (so an event exists if
and only if the change does). The processor:

- runs right after the request that wrote it, on server start (recovering anything left behind), and on the
  15-minute Embarko schedule (`/tasks/automations`);
- claims each event with an atomic update and a 5-minute lease; a crashed claim is picked up when the lease ends;
- retries a failed handler with exponential backoff (30 s, 1 min, 2 min, …) up to 5 attempts, then marks it
  **failed**; the agent can retry it from the Activity log;
- relies on idempotent handlers: matching is an upsert, notifications and automation runs have dedupe keys, and
  external sends are claimed before they are attempted (a failed claim may be re-sent; an unknown one is not).

| Event | Written when | Handler |
| --- | --- | --- |
| `lead.created` | an agent, the assistant or a buyer creates a lead | match the lead; New Lead Alert for the assigned agent |
| `lead.assigned` | claim, transfer, late assignment | New Lead Alert for the new agent |
| `lead.requirements_changed` | budget, location, BHK, type, status, consent or feedback changes | re-match the lead |
| `property.published` / `changed` / `unpublished` | publication or a match-relevant fact changes | re-match the listing; withdraw if no longer eligible |
| `match.created` | a new or materially changed match is stored | in-app notices: buyer, buyer's agent; anonymous notice to the listing's agent and seller |
| `match.digest` | one per responsible agent per change | optional Gmail/Slack message listing all new matches |
| `viewing.requested` / `booked` / `rescheduled` / `cancelled` / `completed` | viewing lifecycle | notify agent / buyer / seller |
| `feedback.submitted` | a buyer answers | notify the agent (re-matching is queued separately) |
| `rent.payment_recorded`, `rent.reminder_sent`, `tenancy.linked` | rent lifecycle | notify tenant / landlord |

## Matching

`server/matching/engine.js`. A listing is eligible when published and available; a lead when it is a buyer or
tenant, not won/lost, and (for a registered buyer) has consented. `scoreMatch` excludes on any stated requirement
that is not met (location, budget, BHK, type, rejected listings/areas) and explains the rest; unknowns are listed as
gaps, never guessed. A stored match carries a **fingerprint** of the listing facts it rests on; only a new match, or one
whose facts changed, is announced, so the same unchanged match never reaches anyone twice. A match that stops fitting
is **withdrawn** with the reason; a dismissed match stays dismissed.
