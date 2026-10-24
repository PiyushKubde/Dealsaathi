# DealSaathi architecture: a three-sided marketplace

## Data model (schema v6; v7 to v10 add tables, v11 an index; see below and server/db.js)

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

## Buyer interest and My requests (`server/interests/`, schema v9)

"I'm interested" on a listing (its page and Recommendations) records a `property_interests` row on the buyer's
**own lead** (the one their saved requirements created): interest never creates a lead, so a buyer without saved
requirements is asked to save them first (409 `no_requirements`). The buyer is always the signed-in user; ids sent by
the client are ignored. Only listings the buyer may see and that are published and available are accepted (404
otherwise, as for the listing itself).

- **One open request per lead and listing**, enforced by a partial unique index: repeated or concurrent clicks return
  the same request (200, `created: false`) and queue nothing. Withdrawn and closed requests are kept as history; showing
  interest again opens a new one.
- **Statuses**: `open` → `withdrawn` (the buyer) or `closed` (their agent, with an optional reason the buyer sees).
- **Who is told**: `interest.created` notifies the buyer's **assigned agent**, in the app only, once per lead, listing and
  day (so withdrawing and re-expressing cannot flood them). The listing's owner and the listing's agent, when someone
  else, are not told and cannot see it. A request on an unassigned lead waits; the agent who claims the lead sees it.
- **Viewings are not copied**: a request shows the buyer's latest viewing of that listing from the viewings table, and
  the next step is worked out from the request, the listing's availability and that viewing.
- **Endpoints**: buyers `POST/GET /api/me/interests`, `POST /api/me/interests/:id/withdraw`; agents `GET /api/interests`
  (`?status=open|withdrawn|closed|all`), `GET /api/leads/:id/interests` (the lead's assigned agent only, 404 otherwise)
  and `POST /api/interests/:id/close`. Pages: buyer **My requests**, agent **Buyer interest** and the lead page.
- Offers build on an open request (next section).

## Offers and rental applications (`server/offers/`, schema v10)

An **offer** (sale listing) or **rental application** (rent listing, with an optional move-in date) is made from My
requests on an open interest. It needs the buyer's saved requirements, an assigned agent (who passes it on) and an
available listing with an owner in DealSaathi. At most one offer per lead and listing is active (partial unique index);
a repeated submission returns the active one. Every move is a conditional update from an allowed state, recorded in
`offer_events`, so a double click or a race changes nothing twice (409 otherwise).

| From | Move | By | To |
| --- | --- | --- | --- |
| — | submit | buyer | `submitted` |
| `submitted` | forward (optional note to the owner) | buyer's assigned agent | `forwarded` |
| `forwarded` | accept in principle / decline / counter (amount) | the listing's owner: a seller, or the agent who owns it | `accepted` / `rejected` / `countered` |
| `countered` | accept the counter / answer with a new amount | buyer | `accepted` / `submitted` (forwarded again by the agent) |
| any active | withdraw | buyer | `withdrawn` |
| `accepted` | record as agreed | buyer's agent | `closed_won` |
| any active | not going ahead | buyer's agent | `closed_lost` |

- **Privacy**: the owner sees only offers forwarded to them, with the amount, terms and the buyer's agent's name, never
  the buyer. Other agents and sellers get 404. The buyer's agent sees everything for their own leads.
- **Not a transaction**: "accepted" is accepted in principle. Every accepted or agreed offer carries the disclaimer that it
  is not a sale or rental agreement, a payment or a transfer; nothing marks the listing sold, takes money or creates a
  tenancy automatically (for rentals the agent sets up the tenancy in Rent as before).
- **Notifications** (`offer.changed`, in the app only, deduplicated per change and recipient, never to whoever made the
  change): the agent on submissions and the owner's or buyer's answers; the owner on forwarded offers and their outcome;
  the buyer on the owner's answers and the recorded outcome.
- While an offer is active, its interest cannot be withdrawn or closed.
- **Endpoints**: buyers `POST/GET /api/me/offers`, `POST /api/me/offers/:id/withdraw|accept-counter|revise`; the buyer's agent
  `GET /api/offers` (`?status=active|all|…`), `GET /api/leads/:id/offers`, `POST /api/offers/:id/forward|close`; owners
  (sellers and listing-owning agents) `GET /api/listing-offers`, `POST /api/listing-offers/:id/respond`.
- Not built: payments, deposits, e-signatures, agreements, or offers through the AI Assistant (its listing cards carry the
  same "I'm interested" button, which only the buyer's click sends).

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
- **Dates**: "today" and the allowed viewing dates follow the buyer's agent's calendar time zone (viewing
  scheduler setting; India when unset), the same zone the free times come from. An incomplete search (over 5,000
  candidates) says so in the step the buyer sees, not only to the model.
- **Deletion and retention**: a buyer can delete a conversation (`DELETE /api/agent/conversations/:id`): its
  messages, context, run records and unconfirmed requests go; viewing requests already sent stay (My viewings).
  Refused while a turn or a Confirm is running. Nothing expires on its own yet (a retention period is a business
  decision). viaSocket keeps its own copy of each AI step (one thread per step, buyer messages and cleaned listing
  data, never emails, phones or addresses); its SDK and docs offer no deletion and state no retention period.
- **Live check** (`scripts/live-agent-check.mjs`): the real viaSocket AI against a throwaway database of made-up listings
  and the Calendar stand-in; never confirms a request. Run only with approval: it makes real AI calls.
- **Records** (schema v8, new tables only): `agent_conversations` (with working context: listings and free times
  shown), `agent_messages`, `agent_runs` and `agent_steps` (tool names, outcomes, timings: no message text),
  `agent_actions`. The log gets one line per run and per confirmed action, with no content.


## Launch hardening (schema v11, an index only)

- **Security headers** on every answer (`securityHeaders` in `server/app.js`): a Content-Security-Policy that allows
  only this app's scripts plus viaSocket's Connect window (`flow.viasocket.com/connect.js`, its iframe on
  `*.viasocket.com`), no framing by other sites (`frame-ancestors 'none'`, `X-Frame-Options: DENY`), `nosniff`, a
  referrer policy (the feedback page keeps `no-referrer`), and HSTS when the request arrived over HTTPS.
- **Sign-in limits**: 10 failed sign-ins per IP address and 20 per account per 15 minutes. A successful sign-in
  clears only that account's count, never the address's. An unknown email is checked against a dummy hash, so it
  takes as long as a wrong password. Each sign-in and sign-up is counted before its password is hashed, so a
  burst of parallel requests cannot slip under the limits. The in-memory limit maps drop expired entries once they
  hold 5,000.
- **Passwords** are hashed with scrypt on libuv's thread pool for sign-in and sign-up, so a burst of sign-ins does
  not hold up other requests. Password reset (rare, rate limited) still hashes inline.
- **Statements**: `openDatabase` reuses prepared statements per SQL text (up to 1,000), since compiling SQL cost more
  than running a simple query. Matching builds leads and listings from the rows it already read.
- **Listings index** (`properties_published`): the market pages read published listings newest first and stop
  after a page instead of sorting every listing.
- **Measured** on a local copy with 5,000 listings and 5,000 buyers (one Node process): buyer market 90 → 480
  requests/s; matching one listing against every buyer 685 → 175 ms, one buyer against every listing 133 → 36 ms;
  other pages answered in 19 ms (p95) while 20 sign-ins ran, against 856 ms before.
