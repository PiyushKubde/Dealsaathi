# DealSaathi

An AI assistant for real estate brokers. **Phase 2: lead management.** Type a lead in plain words,
let AI fill in a draft, check it, and save it to a database on your own computer.

- Leads are stored **only** in DealSaathi's own SQLite file (`data/dealsaathi.db` locally). Nothing is sent to a CRM, email or calendar.
- AI is provided by viaSocket (`viasocket-apps`), called from the server only.
- Follow-ups, viewings, property matching and rent reminders are **not built yet**.

## Run it on your computer

1. **Install Node.js 22.13 or newer** from https://nodejs.org (choose the "LTS" version). Check it in a terminal:
   `node -v`
2. **Open a terminal in this folder** and install the packages:
   ```bash
   npm install
   ```
3. **Create `.env`.** Copy `.env.example` to `.env` and fill in your values from
   viaSocket → Integrations → your embed → Install Code:
   ```
   VIASOCKET_ORG_ID=...
   VIASOCKET_PROJECT_ID=...
   VIASOCKET_EMBED_SECRET=...
   PORT=3000
   ```
   Keep `.env` private. It is excluded from Git.
4. **Create the database** (safe to run again; it never deletes leads):
   ```bash
   npm run db:init
   ```
5. **Start the app:**
   ```bash
   npm start
   ```
6. **Open http://localhost:3000** in your browser. Stop the app with `Ctrl + C` in the terminal.

Without the viaSocket values the app still opens: the dashboard, lead list and form work, and
**Add with AI** explains that AI is not configured.

## What needs what

| Feature                                   | Needs                                   |
| ----------------------------------------- | --------------------------------------- |
| Dashboard, lead list, search, filters     | Nothing extra                           |
| Add / edit / delete leads with the form   | Nothing extra                           |
| Add with AI                               | The three viaSocket values in `.env` and an internet connection |

## Hosting (Embarko)

The same code runs on Embarko. When hosted, the app:

- keeps its database in Embarko's persistent folder (`DATA_DIR`), so leads survive updates. **Embarko does not back it up.**
- listens on `0.0.0.0` and Embarko's `PORT`.
- stays **locked** until `APP_PASSWORD` (12+ characters) is set, then asks for that password. Leads hold people's
  contact details and AI uses your viaSocket account, so a public copy must not be open.

Set these in the app's **App setup** page on https://embarko.ai/app (never in the upload):
`APP_PASSWORD`, `VIASOCKET_ORG_ID`, `VIASOCKET_PROJECT_ID`, `VIASOCKET_EMBED_SECRET`.

## Checks

```bash
npm test       # automated tests (they use a fake AI and a temporary database)
npm run lint   # code style
```

The viaSocket check script (from the viaSocket skill) checks the integration code:
```bash
curl -fsSL https://flow.viasocket.com/viasocket-check.mjs -o viasocket-check.mjs && node viasocket-check.mjs server public
```

`GET http://localhost:3000/api/health` reports whether the database works and whether AI credentials are set.

## How it is organised

| Path                            | What it does                                                       |
| ------------------------------- | ------------------------------------------------------------------ |
| `server/index.js`               | Starts the app on `127.0.0.1:PORT` (this computer only)            |
| `server/app.js`                 | HTTP API, request checks, error answers                            |
| `server/db.js`                  | SQLite tables and transactions                                     |
| `server/init-db.js`             | `npm run db:init`                                                  |
| `server/leads/validate.js`      | Lead field rules                                                   |
| `server/leads/service.js`       | Saving, searching, editing, deleting leads; duplicates; activity   |
| `server/assistant/extract.js`   | AI prompt, JSON schema, checking the AI's answer                   |
| `server/assistant/service.js`   | Chat turns, drafts, confirm and cancel                             |
| `server/viasocket.js`           | The viaSocket client (server only)                                 |
| `server/auth.js`                | Access password for a hosted copy                                  |
| `public/`                       | The web pages                                                      |
| `test/`                         | Automated tests                                                    |
| `docs/action-mapping.md`        | Which values come from the broker, the AI or the code              |
| `viasocket-integrations/SKILL.md` | The viaSocket skill installer                                    |

## Limits of this phase

- One broker account. Locally there is no login (the server listens on this computer only); a hosted copy uses one shared access password.
- A budget is stored as a plain rupee amount. A tenant's monthly rent and a buyer's purchase budget look the same.
- AI chat history is also kept by viaSocket (per conversation thread), as its AI service does.
