# DealSaathi

An AI assistant for real estate brokers, built on viaSocket.

| Area | What works | Status |
| --- | --- | --- |
| Accounts | Each broker signs up with their own login and gets a stable id (`usr_…`), which is also their identity on viaSocket | Working |
| Leads | Add with AI (viaSocket AI) or a form, review, confirm, edit, delete, duplicate checks, follow-up date, activity history | Working |
| Properties | Listings with buyer matching on save; clearly labelled sample listings | Working (local data) |
| Integrations | A fixed list of the apps DealSaathi uses (Gmail, Slack, Google Calendar, WhatsApp Business), connected through the official **Connect** popup (`viasocket-apps/browser` `connect()`), live status, reconnect, disconnect | Working; each broker signs in to their own apps |
| Real Estate Automations | Seven DealSaathi automations with native settings, on/off, run history and retry. No viaSocket builder or app catalog is shown | 4 built, 3 marked *Needs setup* (see below) |

| Automation | Trigger | Acts through | Status |
| --- | --- | --- | --- |
| New Lead Alert | A lead is saved | Gmail · Send Email or Slack · Send Message | Built; needs Gmail or Slack connected |
| New Property → Buyer Matching | A property is saved | DealSaathi | Working |
| Property Recommendations | The broker picks listings on a lead's page | Gmail · Send Email, after approval | Built; needs Gmail connected |
| Buyer Follow-Up Reminders | Embarko scheduler, every 15 minutes (`/tasks/automations`) | DealSaathi reminders; optional Gmail or Slack | Built; scheduler only on the hosted app |
| Property Viewing Scheduler | | Google Calendar | Not built |
| Post-Viewing Feedback | | | Not built |
| Rent and Payment Reminders | | | Not built |

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
npm test       # automated tests: a fake viaSocket and AI, temporary databases
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
| `server/properties/service.js` | Listings and buyer matching |
| `server/leads/` | Lead rules, storage, duplicates, activity |
| `server/assistant/` | AI lead extraction and the confirm/cancel flow |
| `public/` | The web pages (the Connect popup uses `/vendor/viasocket-apps-browser.js`, served from the installed package) |
| `scripts/live-gmail-check.js` | The live Gmail check above |
| `test/` | Automated tests |
| `docs/action-mapping.md` | Every viaSocket action: ids, where each input comes from, confirmation, status |

## Known limits

- One shared lead and property book for everyone signed in to one DealSaathi; connections, automations, AI threads
  and follow-ups are per broker.
- viaSocket's slug lookup does not find `gmail` today (reported to viaSocket). DealSaathi then finds the slug in
  `catalog.list()`, which does list it; the check script still reports it.
- Budgets are plain rupee amounts: a tenant's monthly rent and a buyer's price look alike.
