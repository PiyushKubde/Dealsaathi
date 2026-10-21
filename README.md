# DealSaathi

An AI assistant for real estate brokers and property managers. You type a request in plain English
("Add Rahul Sharma as a new buyer lead", "Find 2BHKs under ₹50 lakh in Pune"). DealSaathi works out
what you mean, asks for anything missing, shows you the exact change, and does it only after you confirm.

It covers five workflows: lead management, lead follow-ups, viewing scheduling, property matching
and rent reminders. AI, Gmail and Google Calendar go through [viaSocket](https://viasocket.com).

## Run it

```bash
cp .env.example .env      # then fill in the values (see below)
npm install
npm start                 # http://localhost:3000
npm test                  # unit + API tests, then the viaSocket check script
npm run lint
```

| Variable | Needed for |
| --- | --- |
| `DEALSAATHI_ADMIN_EMAIL`, `DEALSAATHI_ADMIN_PASSWORD` | Signing in. Without them nobody can sign in. |
| `VIASOCKET_ORG_ID`, `VIASOCKET_PROJECT_ID` | `53645` / `projwZ9V7Wb3` for this workspace. |
| `VIASOCKET_EMBED_SECRET` | Signing viaSocket embed tokens. **Server-side only.** Without it the AI assistant, AI drafts, Gmail and Google Calendar are off, and the app says so on every screen. |
| `VIASOCKET_AI_SERVICE`, `VIASOCKET_AI_MODEL` | Optional model choice (names from viaSocket's `ai.md`, e.g. `anthropic` / `claude-sonnet-4-6`). Empty uses viaSocket's default model. |
| `DEALSAATHI_TIMEZONE` | Default viewing time zone (`Asia/Kolkata`). |
| `DATA_DIR`, `PORT` | Set by the host on Embarko; default `./data` and `3000` locally. |

Get the viaSocket values from **viaSocket → Integrations → the embed → Install Code**.

## Architecture

- **One Node process** (Express) serves the API and the static front end (`public/`, plain ES modules,
  no build step). It reads `PORT`, binds `0.0.0.0`, and keeps its SQLite database under `DATA_DIR`,
  as Embarko requires.
- **SQLite** (`better-sqlite3`) holds leads, properties, viewings, rent records, messages, conversations,
  proposed actions, integrations and an audit log. Migrations live in `server/db.js`.
- **Sign-in:** one workspace owner from the environment. Passwords are hashed with scrypt. Sessions use an
  httpOnly SameSite cookie. Every state-changing request must carry an `X-DealSaathi` header (CSRF guard).
- **viaSocket client** (`server/viasocket.js`): signs the per-user embed token (HS256, claims `org_id`,
  `project_id`, `unique_identifier = dealsaathi-user-<id>`). It calls the embed API and runs app actions
  on the user's `script_id`. The secret, the token's signing and every `script_id` stay on the server.

### How the assistant works

1. `POST /api/assistant/message` sends your message to **viaSocket AI** (`/embed/ai/message`) with a system
   prompt and a strict `json_schema`. Each conversation gets its own thread (`chat-<uuid>`).
2. The model returns an *interpretation*: an intent (create/update/find lead, draft follow-up, schedule
   viewing, match properties, rent due, clarify, unsupported) plus the fields it extracted.
3. The backend re-checks that JSON with zod and throws away anything that doesn't fit. It then works out
   what's missing **itself** (it doesn't trust the model's opinion) and asks short follow-up questions.
   Partial details carry over between turns.
4. A change (create/update lead, save a viewing) becomes a **proposed action** in the `actions` table. It
   runs only on `POST /api/actions/:id/confirm`. The `proposed → executing` step is atomic, so a double click
   or a retried request can't run it twice.
5. Reads (lead search, property matching, rent due) run straight away. Sending an email and booking a
   calendar event each need their own explicit confirmation in the UI.

The model never calls tools and never runs anything. It only fills in a schema. The text you type and
stored records are wrapped as data (`<broker_message>`, `<context>`, `<lead>`), and the prompt tells the
model to ignore any instructions inside them.

## Workflows

| Workflow | What works | Depends on |
| --- | --- | --- |
| Lead management | Create, validate, dedupe (normalised email/phone), search, filter, edit, history. Through forms or the assistant. | nothing external |
| Lead follow-ups | AI draft from the stored lead (name, interest, budget and notes; contact details are not sent to the model), editable, then sent through the user's Gmail after confirmation. "Sent" means Gmail returned a message id; anything else is "unconfirmed" or "failed". | viaSocket secret for AI; Gmail connection to send |
| Viewing scheduling | Proposal (always labelled *not booked*), date and time-zone checks, a free/busy check against the chosen Google Calendar, booking with an explicit confirm. "Booked" only when Google returns an event id. | Google Calendar connection |
| Property matching | Hard filters (city, buy/rent, max budget, bedrooms, availability) and ranked soft criteria, with a reason or gap listed for each. Details a listing doesn't record are never assumed. | nothing external |
| Rent reminders | Overdue / due soon / unknown status, worked out only from the stored status and due date (an unknown status is **never** called overdue). Reminder drafts are written from the record and sent through Gmail after confirmation. | Gmail connection to send |

### Sample data

No live listing feed is connected. Eight **sample listings** are seeded so matching can be shown. Sample
leads and rent records load only when you ask (Integrations → Data). Every sample row has `is_sample = 1`
and a "Sample" badge everywhere it appears, and one click removes it all. Sample contacts use
`example.com` addresses.

## viaSocket integration decisions

The skill (`viasocket/SKILL.md`) is a pointer: it fetches the live skill and the app documents each time.
The ids below were copied from the Gmail (`rowo0bqrhj5g`) and Google Calendar (`rowkhibv5efp`) documents,
and `viasocket-check.mjs` confirms them against the live catalog.

- **Who connects:** the signed-in DealSaathi user, through `openViasocketConnection` (Connect buttons show
  the app's icon). The popup's `auth_id` is checked against `GET /embed/authentications` before it is stored.
  The app is enabled once (`findEnabledApp` first). Expired connections get a Reconnect button that passes
  `authId`.
- **Gmail → Send Email** (`rowwj0sfmhub`): `to` = the lead's or tenant's stored email, `subject` and
  `messageBody` = the reviewed draft (escaped HTML). Left out on purpose: `cc`, `bcc`, `replyTo`, `fromName`,
  `attachments`, `labelIds` (a one-to-one follow-up needs none) and `from` (the connected account's own
  address is used).
- **Google Calendar → Get Free/Busy Information** (`row0ce18xwwk`) and **Create Calendar Event**
  (`rown3bkuc5jc`): `calendar_id` is picked by the user from `list-options`. `timeZone` is the viewing's time
  zone, from the action's fixed list. Fixed in code: `status: "confirmed"`, `colorId: "4"` (the action's
  default), no `recurrence` (a viewing is one visit), `useDefault: true`, `visibility: "default"`,
  `transparency: "opaque"` (the broker is busy) and `guestsCanModify: false`. `attendees` is the lead's email.
- **Prebuilt UI:** mounted on the Integrations screen with `showEnabled: false`, because DealSaathi also
  enables apps through the Apps API for the same users. Published flows are recorded from `flow` events, and
  their URLs are kept server-side.
- **Not built:** scheduled or automatic sending. DealSaathi has no scheduler, so nothing is ever described
  as "scheduled". Users who want recurring automations can build them in the viaSocket builder.

## Tests

`npm test` runs 45 `node:test` tests and then `viasocket-check.mjs`. The AI and the action runner are
**mocked** in the tests (`test/helpers.js`). They prove DealSaathi's own behaviour: what it sends to
viaSocket, how it validates answers, confirmation, duplicate guards, and how it records success and
failure. They do not prove the model's accuracy or a real Gmail/Calendar call. Real calls need the secret
and a test connection made at
`https://flow.viasocket.com/integrations/53645/projwZ9V7Wb3/apps-api`.

## Deploying on Embarko

The app is ready to deploy as is: Node, `npm start`, `PORT`/`0.0.0.0`, data under `DATA_DIR`, no
Dockerfile. See <https://embarko.ai/docs/deploy>. Secrets go in the app's env vars (App setup), never in
the upload. Embarko doesn't back up data.
