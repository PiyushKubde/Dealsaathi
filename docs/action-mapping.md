# DealSaathi action mapping

Every external action DealSaathi can take, how it is chosen, where each input comes from, and its real status.
All viaSocket calls run on the server through `viasocket-apps` 0.7.0 (`server/viasocket.js`).

## Who picks the action

**The developer, in code, from a fixed allowlist** (`ACTIONS` in `server/integrations/run.js`: Gmail · Send Email
and Slack · Send Message). The AI never names an app, action or id:

- Lead entry: the AI labels a message `create_lead | add_details | cancel | other`; code maps that to the one local
  action "save a lead", run only by a **Confirm and save** click.
- Emails to a lead (follow-up, property recommendation): the broker opens a lead; code runs Gmail · Send Email
  only after a **Send now** click.
- Real Estate Automations: each of DealSaathi's own automations has one fixed trigger and one fixed action (below).
  The broker chooses the channel and recipient in DealSaathi's settings panel; there is no workflow builder.

## Identity, tokens and secrets

| Thing | Where it lives |
| --- | --- |
| `VIASOCKET_EMBED_SECRET` | Server env only. Never in a response, file in Git, or log |
| Embed token | Signed per request for the signed-in broker (`viasocket.user(usr_…).token()`); sent to the browser only for the Connect popup, as the skill allows |
| `userId` / `unique_identifier` | The broker's own `usr_…` id: random, stable, never the email |
| `auth_id` (a connection) | `connections` table, per broker; the browser sees a row id. Checked against `listConnections()` before it is stored. Sent to the browser only to reconnect that broker's own expired connection (`connect({ authId })`) |
| `script_id` (an enabled app) | `enabled_apps` table, server only. Never sent to the browser |
| Scheduler secret (`CRON_SECRET`) | Created by Embarko, read from env, compared in constant time; never stored or logged |

## Gmail · Send Email (lead follow-up)

| | |
| --- | --- |
| App | Gmail, slug `gmail`, service `rowo0bqrhj5g` (resolved at run time) |
| Action | `rowogelpy0h6`, version `V55` (`catalog.versionIdFor` at run time) |
| Connection | The broker's own Gmail, connected in DealSaathi with `connect({ actions: ['rowogelpy0h6'] })` |
| Order | `listConnections` (live check) → `listFlows` / `enable` (once per connection) → `versionIdFor` → `runAction` |

| `inputData` key | Source | Rule |
| --- | --- | --- |
| `to` | Saved data: the lead's email | Never typed and never AI. A lead without a valid email cannot be followed up |
| `subject` | The broker, on screen (optionally an AI draft they edit) | 1–200 characters, one line (no header injection) |
| `messageBody` | The broker, on screen (optionally an AI draft they edit) | 1–10,000 characters; sent as escaped HTML paragraphs, so nothing typed becomes markup |
| `from` | `PICK`: the broker picks from `listOptions('from')`, or leaves it out for the account default | Re-checked against the live options before saving |
| `fromName` | Saved data: the signed-in broker's name | |
| `cc`, `bcc`, `replyTo`, `attachments`, `labelIds` | Left out on purpose | One-to-one follow-up; replies go to the sending account; Gmail adds the SENT label itself |

The AI draft uses the lead's saved preferences only (no phone or email is sent to the AI) and is never sent without review.

**Confirmation:** the broker reviews To, From, Subject and Message, then presses **Send now**. Only one request can
move a follow-up from *awaiting confirmation* to *sending*, so a double click sends once.

**Result handling:**
- **Sent:** only when Gmail returns a message id. It is shown with its labels, and logged on the lead's activity history.
- **Failed:** viaSocket or Gmail refused the send. The reason is shown and logged, and the follow-up is never resent automatically.
- **Unknown:** no answer, or an answer without a message id. The broker is told to check the Gmail Sent folder before resending.
- **Back to review:** a failure before the action runs (connection gone, enable failed), so nothing was sent.
- **Refused:** a paused Gmail flow is reported, not silently resumed.

**Live status:** built and tested with a fake viaSocket. Not yet run against a real Gmail, because no Gmail test connection exists in project `projm6Hpqgvs`.

## Slack · Send Message (alerts and reminders)

| | |
| --- | --- |
| App | Slack, slug `slack` (resolved at run time) |
| Action | `row1jrbor`, version `V107` |
| Connection | The broker's own Slack, connected in DealSaathi with `connect({ actions: ['row1jrbor'] })` |

| `inputData` key | Source | Rule |
| --- | --- | --- |
| `destination.messageto` | Constant `"channel"` | DealSaathi posts to one channel |
| `destination.channel_id` | `PICK`: the broker picks from `listOptions('destination.channel_id')` in the settings panel | Re-checked against the live list when the automation is switched on; the label is read from Slack |
| `markdown_content` | Product data: the lead's saved details, or the list of new reminders | Facts only; missing ones say "not given" |
| `destination.thread_*`, `userId`, `tagged_users`, `buttons`, `schedule_type`, `delay_value`, `post_at`, `bot_details`, `preview` | Left out on purpose | Posted now, to one channel, as the connected Slack user |

**Result:** sent only when Slack returns a message `ts`; refused → failed (retryable for lead alerts); no answer or no `ts` → unknown (not retried).

## The seven Real Estate Automations

| Automation | Trigger (real) | Action | Settings (per broker) | Duplicates | Status |
| --- | --- | --- | --- | --- | --- |
| New Lead Alert | Lead saved by the form or a confirmed AI draft (after the database commit) | Gmail · Send Email to 1–5 addresses, or Slack · Send Message to a picked channel | Channel, own connection, recipients or channel | One run per broker per lead (`dedupe_key`) | Built; needs a connection |
| New Property → Buyer Matching | Property saved, in the same transaction | Local matching with reasons | On/off (default on). Automatic sending to buyers is shown as unavailable (needs WhatsApp Business) | One activity entry per new match | Working |
| Property Recommendations | Broker ticks matching, non-sample listings and asks to email them | Gmail · Send Email, after the broker approves the email | The Gmail account; approval always required | Single-send guard per email | Built; needs Gmail |
| Buyer Follow-Up Reminders | Embarko schedule, every 15 minutes, or "Run check now" | Reminder rows and lead activity; optional Gmail or Slack summary | Days without activity (1–90), notify none/Gmail/Slack | One reminder per lead, reason and anchor (follow-up date or last activity time) | Built; scheduler only when hosted |
| Property Viewing Scheduler | | | | | **Needs setup:** not built (Google Calendar) |
| Post-Viewing Feedback | | | | | **Needs setup:** not built (depends on viewings and a buyer channel) |
| Rent and Payment Reminders | | | | | **Needs setup:** not built (tenancies; Razorpay or manual verification) |

An automation can be switched on only when its settings are complete and its connection is live on viaSocket.
If a connection later disappears, the card shows **Needs setup** and its runs fail with the reason; nothing is sent.
Every run is stored (`automation_runs`) with trigger, status, summary and error. A run cut off by a restart becomes **unknown**.

## Catalog actions checked for the next workflows (not built yet)

| Workflow | App · action (live catalog) | Ids | Blocker |
| --- | --- | --- | --- |
| Send listings on WhatsApp | WhatsApp Business Cloud (Meta) · Send Template Message | slug `whatsapp_business_cloud`, service `row3icnwu2su`; WABA, phone and template are pickers | A Meta WhatsApp Business account with an **approved template** for property messages, connected by the broker |
| (rejected) | Built-in WhatsApp · Send WhatsApp Message (NoAuth) | `rowax61bwd33` V18 | Its 97 templates belong to viaSocket's own business account (support, webinars, billing). Using them would send from viaSocket's number with viaSocket's text |
| Reply tracking | WhatsApp Business Cloud (Meta) · Message Notification trigger | | Same account; replies only, never "opened" |
| Slack alerts and summaries | Slack · Send Message | slug `slack`, `rowbu58rc`, V107; channel is a picker | A Slack workspace connected by the broker |
| Viewings | Google Calendar · Get Free/Busy Information, Create Calendar Event; New Upcoming Event trigger | slug `google-calendar`, `rowkhibv5efp` | A Google Calendar connected by the broker; the client's availability from a real reply |
| Itinerary travel times | Google Map · Get a Distance Matrix | slug `Google-Map`, `rowa0ibichgc` (Basic sign-in) | A Google Maps API key, connected by the broker; otherwise ordering is labelled approximate |
| Rent payment status | Razorpay · Create Payment Link; Any Payment Link Gets Paid trigger | slug `razorpay`, `row2n5tu2hd9` | A Razorpay account connected by the property manager; otherwise payments are verified manually |
| Scheduled checks | Embarko schedule `GET /tasks/automations` every 15 minutes | embarko.json | Built for Follow-Up Reminders; rent will use the same route |
