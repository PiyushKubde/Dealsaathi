# DealSaathi

A three-sided real-estate marketplace for **buyers**, **sellers** and **agents**, built on viaSocket.
See [docs/architecture.md](docs/architecture.md) for roles, assignment, matching and the event queue.

| Role | Signs up as | Can do |
| --- | --- | --- |
| Buyer (or tenant) | Buyer — open signup | Ask the AI Assistant in their own words (searches real listings, explains matches, checks free times, prepares a viewing request they confirm), save requirements (with consent to matching), see recommendations with reasons, browse listings, say "I'm interested", make an offer or rental application and follow it in My requests, request viewings in their agent's calendar, give feedback, see their tenancy and rent |
| Seller (or landlord) | Seller — open signup | Create draft listings, publish / unpublish / archive them, see how many buyers match (never who), see viewings of their listings, see their rentals and record rent received |
| Agent | Agent — needs the team access code on the hosted copy | Their assigned leads (plus a claimable pool), their buyers' interest in listings, offers (forward, record the outcome), AI lead entry, all published listings, matches, viewings, feedback, rent management, integrations, the seven automations, the activity log |

Every rule is enforced on the server (`server/access.js`); pages only hide what a role cannot use.

| Area | What works | Status |
| --- | --- | --- |
| Accounts and roles | Signup with a role, role profiles, role dashboards, sessions (HttpOnly, SameSite=Strict), open signup capped per IP, email verification and password reset (one-time links) | Working; emails need `SYSTEM_MAIL_CONNECTION` |
| Backups | Daily verified copies, pruning, restore with `RESTORE_FROM`, download with `BACKUP_TOKEN` | Working; off-host copies are manual |
| Assignment | Agent-added leads are theirs; registered buyers go to the least-loaded agent serving their area; otherwise a pool agents claim from; transfer between agents | Working |
| Matching | Both directions, continuous, from the event queue; stored with reasons, fingerprints and status (suggested / dismissed / withdrawn) | Working |
| Event queue | Every platform change writes a domain event in the same transaction; processed after the request, on start-up and every 15 minutes, with retries and dedupe | Working |
| Notifications | In-app, per person, deduplicated; external (Gmail / Slack) only through an agent's own connection | In-app working; external needs connections |
| Integrations | Gmail, Slack, Google Calendar through the official Connect popup, with a read-only **Check access**. Razorpay and WhatsApp are blocked for live use | See [Integrations](#integrations-status) |
| Viewings, feedback, tenancies, rent | Agent-run; buyers request and give feedback in the app; tenants and landlords see their tenancy | Built; Calendar / Gmail needed for external steps |

| Automation | Trigger (platform event) | Acts through | Status |
| --- | --- | --- | --- |
| New Lead Alert | `lead.created`, `lead.assigned` — only the **assigned** agent | In-app; optional Gmail · Send Email or Slack · Send Message | Built; external needs the agent's Gmail or Slack |
| New Property Matching | `property.published` / `changed` / `unpublished`, `lead.requirements_changed` | Matching for everyone; in-app notices; optional one Gmail/Slack digest per change | Working; external optional |
| Property Recommendations | Stored matches (buyers, in-app); agent approval (email) | In-app; Gmail · Send Email after approval, only to buyers who allow agent email | In-app working; email needs Gmail; WhatsApp unavailable |
| Buyer Follow-Up Reminders | Scheduler (15 min): due follow-up dates, no human activity | In-app reminder + notice; optional Gmail/Slack | Built; scheduler only when hosted |
| Property Viewing Scheduler | Agent schedules, or a buyer requests; agent confirms | Google Calendar · Free/Busy, Create / Update / Delete Event | Built; needs the agent's Google Calendar |
| Post-Viewing Feedback | `viewing.completed` | In-app for registered buyers; private emailed link otherwise; answers queue re-matching | Built; email needs Gmail |
| Rent and Payment Reminders | Scheduler (15 min) | Gmail · Send Email; Razorpay links only with `RAZORPAY_LIVE=1` | Built; Razorpay off for live use |

## Integrations status

| App | Live execution | Why |
| --- | --- | --- |
| Gmail, Slack, Google Calendar | Allowed, through each agent's own connection | Each run first checks the connection is live on viaSocket; **Check access** runs a read-only call |
| Razorpay | **Blocked** until the server sets `RAZORPAY_LIVE=1` | Real money: enable only after a real payment link test passes |
| WhatsApp Business | **Not used** | Needs a WhatsApp Business account with an approved message template |

## Run it on your computer

1. **Install Node.js 22.13 or newer** from https://nodejs.org ("LTS"). Check with `node -v`.
2. In this folder: `npm install`
3. **Create `.env`** from `.env.example` with the values from viaSocket → Integrations → your embed → Install Code:
   ```
   VIASOCKET_ORG_ID=...
   VIASOCKET_PROJECT_ID=...
   VIASOCKET_EMBED_SECRET=...
   PORT=3000
   ```
   Keep `.env` private; it is excluded from Git.
4. `npm run db:init` (safe to run again; it never deletes data)
5. `npm start`, then open **http://localhost:3000** and create your account. Stop with `Ctrl + C`.

Without the viaSocket values the app still opens and leads and properties work; AI, integrations and
automations say they are not configured.

## Hosting (Embarko)

When hosted, the app keeps its database in Embarko's persistent `DATA_DIR` (**not backed up**), listens on
`0.0.0.0:PORT`, and stays **locked** until `APP_PASSWORD` is set. On a hosted copy `APP_PASSWORD` is the
**team access code**: a broker types it once, when creating their own account; after that they sign in with
their own email and password.

Set in the app's **App setup** page on https://embarko.ai/app (never in the upload):
`APP_PASSWORD`, `VIASOCKET_ORG_ID`, `VIASOCKET_PROJECT_ID`, `VIASOCKET_EMBED_SECRET`.

`embarko.json` declares one schedule: `GET /tasks/automations` every 15 minutes (Asia/Kolkata). Embarko creates
`CRON_SECRET` for the app and sends it as `Authorization: Bearer …`; the route refuses any other caller. Without
`CRON_SECRET` (for example on your own computer) the scheduler is off and Follow-Up Reminders run only with
**Run check now**.

## Checks

```bash
npm test           # unit, API, database and migration tests: a fake viaSocket and AI, temporary databases
npm run test:e2e   # browser journeys for all three roles (Playwright; PLAYWRIGHT_MODULE=<node_modules path>)
npm run lint
curl -fsSL https://flow.viasocket.com/viasocket-check.mjs -o viasocket-check.mjs && node viasocket-check.mjs server public scripts
```

### Live checks (real viaSocket, real Gmail)

The skill's test-connection step, for proving Gmail · Send Email works before a broker uses it:

1. Open viaSocket's Apps API test screen for this project,
   `https://flow.viasocket.com/integrations/<VIASOCKET_ORG_ID>/<VIASOCKET_PROJECT_ID>/apps-api`, choose **Gmail**,
   click **Connect** and sign in with a **test** Gmail account.
2. `node --env-file=.env scripts/live-gmail-check.js` (read-only: finds the connection, lists the real From options)
3. `node --env-file=.env scripts/live-gmail-check.js --send --to <a test inbox you own>` sends **one** real email and
   prints viaSocket's real result.

## How it is organised

| Path | What it does |
| --- | --- |
| `server/index.js` | Starts the app (`127.0.0.1` locally, `0.0.0.0` when hosted) |
| `server/app.js` | HTTP API, request checks, error answers |
| `server/db.js` | SQLite tables (migrations) and transactions |
| `server/auth.js` | Accounts (scrypt passwords), sessions, the hosted access code |
| `server/viasocket.js` | The viaSocket client and the one gateway every viaSocket call goes through (server only) |
| `server/integrations/service.js` | Catalog search, connection save (checked against viaSocket), status, reconnect, disconnect |
| `server/followups/service.js` | Gmail · Send Email follow-ups: validation, confirmation, sending, result recording |
| `server/automations/store.js` | The seven automations, each broker's settings, run history |
| `server/automations/engine.js` | Triggers, settings checks and execution for each automation |
| `server/automations/reminders.js` | Follow-up reminders |
| `server/integrations/apps.js` | The curated list of apps on the Integrations page |
| `server/integrations/run.js` | Runs one allowlisted viaSocket action on a broker's own connection |
| `embarko.json` | The hosted app's schedule |
| `server/access.js` | Roles and ownership rules, used by every route |
| `server/profiles/service.js` | Role profiles, buyer requirements, agent assignment, the unassigned pool |
| `server/events/bus.js`, `server/events/handlers.js` | The domain event queue (retries, leases, dedupe) and what each event does |
| `server/matching/engine.js` | Two-way matching: stored matches, fingerprints, withdrawal |
| `server/notifications/service.js` | In-app notifications and external delivery claims |
| `server/properties/service.js` | Listings: ownership, publish / unpublish / archive, scoring |
| `server/viewings/service.js` | Free times, booking, moving, cancelling and outcomes of viewings |
| `server/interests/service.js` | Buyer interest ("I'm interested"), My requests, the agent's view and closing |
| `server/offers/service.js` | Offers and rental applications: buyer → agent → owner, counters, outcome (in principle only) |
| `server/feedback/service.js` | Feedback links (only a hash is stored), the public answer, preference updates |
| `server/rent/service.js` | Tenancies, monthly rent, reminder stages, payment links, payment verification, audit |
| `server/time.js` | Time zone conversions for viewings and rent |
| `public/feedback.html`, `public/feedback.js` | The buyer's feedback page: standalone, loads no app code |
| `server/leads/` | Lead rules, storage, duplicates, activity |
| `server/assistant/` | AI lead extraction and the confirm/cancel flow |
| `server/agent/` | The buyer's AI Assistant: bounded agent loop (`runtime.js`), fixed tools over existing services (`tools.js`), decision format (`prompt.js`), budget/BHK parsing (`parse.js`) |
| `public/` | The web pages (the Connect popup uses `/vendor/viasocket-apps-browser.js`, served from the installed package) |
| `scripts/live-gmail-check.js` | The live Gmail check above |
| `scripts/live-agent-check.mjs` | Live check of the buyer AI Assistant: real viaSocket AI, made-up data, Calendar stand-in, nothing confirmed |
| `test/` | Automated tests |
| `docs/action-mapping.md` | Every viaSocket action: ids, where each input comes from, confirmation, status |

## Known limits

- Email verification and password reset need a system Gmail account (`SYSTEM_MAIL_CONNECTION`, see
  [docs/operations.md](docs/operations.md)). A tenancy is shown to a tenant or landlord only after they accept the
  agent's invitation, or when their verified email matches.
- Backups are written daily on the same host; download them off the host with `BACKUP_TOKEN`
  ([docs/operations.md](docs/operations.md)).
- Matching runs in the server process; the queue is in SQLite. One server instance only.
- viaSocket's slug lookup does not find `gmail` today (reported to viaSocket). DealSaathi then finds the slug in
  `catalog.list()`, which does list it; the check script still reports it.
- Budgets are plain rupee amounts: a tenant's monthly rent and a buyer's price look alike.
- Rent is marked paid only when Razorpay reports the payment link paid (`List Payment Links`, checked by the scheduler
  or "Check Razorpay"), or when the broker records a payment with a note saying how it was verified. A created or
  opened link changes nothing.
- Rent reminders are not sent between 21:00 and 09:00 India time; only the latest reminder stage that has arrived is
  sent, so a tenancy added late does not get a burst of old reminders.
- A viewing can be booked only at a time Google Calendar reports free when the broker confirms (checked again then).
  Attendance is recorded by the broker; DealSaathi does not guess it from the calendar.
