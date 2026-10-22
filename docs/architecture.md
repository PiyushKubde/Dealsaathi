# DealSaathi architecture: a three-sided marketplace

## Data model (schema v6; v7 and v8 add tables, see below and server/db.js)

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

## The buyer's AI Assistant (agent runtime, `server/agent/`)

One loop per buyer message (`POST /api/agent/messages`, buyers only). Each step sends viaSocket AI (the existing
`ai.send`, default model, `json_schema`) a compact JSON context and receives **one decision**: call a tool, ask, or
answer. The server validates the decision and runs the tool **in-process as the signed-in buyer**; the model never
gets SQL, HTTP, shell or other users' data.

- **Tools** (`tools.js`) wrap existing functions: `get_my_requirements` (profile), `search_listings` (every
  published, available, real listing that could match: the validated budget, bedrooms and type narrow it in SQL,
  `canViewProperty` decides visibility, `scoreMatch` ranks, the buyer's feedback exclusions apply; above 5,000
  candidates it reports itself incomplete instead of silently truncating), `get_listing` (`viewProperty`),
  `get_my_recommendations` (`buyerRecommendations`), `get_viewing_slots` (`buyerSlots`: the agent's real free/busy,
  read only) and `propose_viewing_request` (prepares an `agent_actions` row; sends nothing).
- **Criteria guard**: for budget, bedrooms, type and buy/rent, the buyer's newest message that states (or explicitly
  lifts, e.g. "any number of bedrooms") a requirement wins, exactly: the model may neither change nor drop it. A field
  the buyer never mentioned may come from their saved requirements or the search already in use, or be left out. The
  place may only use words the buyer said or saved. Anything else is refused back to the model, so it must ask.
- **Approval**: only the buyer's Confirm (`POST /api/agent/actions/:id/confirm`) runs `requestViewing`, once (atomic
  claim; a repeat returns the first result; an identical request already sent is reused). That creates a *request*;
  the agent's own confirmation books it in Google Calendar, exactly as from the listing page.
  Success is written in the same transaction as the viewing request, and every write is tied to the Confirm's own
  claim. A Confirm still "executing" after 2 minutes (a crash or restart) is settled from the database on the buyer's
  next visit: completed if the matching request exists, back to Confirm if none does (nothing is retried on its own),
  or `needs_review` when it cannot be told.
- **Limits**: 6 decisions, 4 tool calls and 2 errors per message; 30 s per AI call and 20 s per tool, both cut to the
  time left of 60 s per message (the conversation lock lasts the turn plus 30 s); no identical call twice; one message at
  a time per conversation; 20 messages per 10 minutes and 20 calendar checks per 15 minutes per buyer; prepared requests
  expire after 30 minutes. A sentence stating a booking as done is rejected ("booked only after…" is fine). Listings
  from earlier turns are shown again only while still on the market. The claim check works per clause: a real
  condition ("only after", "once", "until") or negation ("not yet") allows it; "can"/"will" do not.
- **Untrusted listing text** (`untrusted.js`): seller titles and amenities with text addressed to an AI or contact
  details (phone numbers, emails, links) reach the model only as a cleaned copy, flagged as such; the page shows the
  real listing with a warning. Server-written replies use cleaned titles, and model replies containing contact
  details or links are refused.
- **Live check** (`scripts/live-agent-check.mjs`): the real viaSocket AI against a throwaway database of made-up listings
  and the Calendar stand-in; never confirms a request. Run only with approval: it makes real AI calls.
- **Records** (schema v8, new tables only): `agent_conversations` (with working context: listings and free times
  shown), `agent_messages`, `agent_runs` and `agent_steps` (tool names, outcomes, timings: no message text),
  `agent_actions`. The log gets one line per run and per confirmed action, with no content.

