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
| Property Viewing Scheduler | The broker confirms a free time on the Viewings page | Google Calendar · Free/Busy, Create, Update, Delete Event; Gmail · Send Email for the optional confirmation | Calendar account and calendar (picker), time zone, length, working hours, confirmation none/Gmail | One booked viewing per broker per start time (partial unique index); a booking is claimed before the event is created; an unknown outcome is retried only after the broker confirms it is not in the calendar | Built; needs Google Calendar |
| Post-Viewing Feedback | The broker marks a viewing as taken place | Gmail · Send Email with `/feedback/<token>` | Gmail account, link lifetime (1–60 days) | One request per viewing (unique); one answer per request; a resend rotates the token | Built; needs Gmail |
| Rent and Payment Reminders | Embarko schedule, every 15 minutes, or "Run check now" | Gmail · Send Email; Razorpay · Create / List / Cancel Payment Link | Gmail account, days before, on the day, days after (e.g. `3,7`), optional Razorpay account | One obligation per tenancy and month; one reminder per obligation and stage (`dedupe_key`); one link per attempt (`reference_id`); one payment record per Razorpay link and amount | Built; scheduler only when hosted |

An automation can be switched on only when its settings are complete and its connection is live on viaSocket.
If a connection later disappears, the card shows **Needs setup** and its runs fail with the reason; nothing is sent.
Every run is stored (`automation_runs`) with trigger, status, summary and error. A run cut off by a restart becomes **unknown**.

## Google Calendar (Property Viewing Scheduler)

Slug `google-calendar`, service `rowkhibv5efp`. Each broker connects their own Google account.

| Action | Id · version | Inputs DealSaathi sends | Success requires |
| --- | --- | --- | --- |
| Get Free/Busy Information | `row7kcom7ds1` V3 | `calendar_id` (picked by the broker from the action's own picker), `date` (DD-MM-YYYY), `timeZone` | A `calendars.<id>.busy` list. Only the `timeMin`–`timeMax` range it covers is offered |
| Create Calendar Event | `rowuitv4m6uy` V23 | `calendar_id`, `summary`, `description` (properties, note), `location`, `startdate`, `starttime`, `meeting_duration` (HH:MM), `timeZone` (one of the action's 20), `attendees` (the lead's email only when the broker ticks "invite"; otherwise empty), `transparency: opaque` | An event `id` in the answer |
| Update Calendar Event | `rowo9a3brirh` V13 | The event id and the new start/duration | The same event `id` |
| Delete Calendar Event | `row32ktr5oju` V6 | The event id | No error. If the delete is refused, the viewing stays booked and the broker is told |

The free/busy check runs again just before the event is created. A viewing is **booked** only with an event id.

## Feedback links

The link is `https://<app>/feedback/<32 random bytes, base64url>`. Only its SHA-256 is stored. The page and its API
(`/api/public/feedback/:token`, rate limited) show the lead's first name, the viewing date and the viewed listings'
title and area: no email, phone, notes, prices, address or broker data. *Too expensive* lowers the buyer's maximum
budget to the lakh below that price; *wrong location* leaves that locality out of matching; any answer other than
*liked* removes that listing from the buyer's recommendations.

## Razorpay (Rent and Payment Reminders)

Slug `razorpay`, service `row2n5tu2hd9`. Optional: without it, reminders are sent without a link and payments are
recorded by the broker.

| Action | Id · version | Inputs | Use |
| --- | --- | --- | --- |
| Create Payment Link | `rowtl0joo241` V5 | `amount` (paise, what is still owed), `currency: INR`, `accept_partial: false`, `description`, `customer` {name, email, contact}, `reference_id: ds-rent-<obligation>-<attempt>`, `link_type: standard`, `add_customer: true`, `notes`; Razorpay's own notification is not requested (DealSaathi emails the link) | A `plink_…` id and `short_url`; the reference is claimed before the call |
| List Payment Links | `rowlcouozywu` V2 | `search_mode: reference_id`, the reference | `status` and `amount_paid`: **paid** or **partially_paid** are the only ways Razorpay marks rent paid |
| Cancel Payment Link | `rowyqfuoa1gu` V2 | The link id | When the broker records a payment or waives the month |

## Catalog actions checked for later workflows (not built)

| Workflow | App · action (live catalog) | Ids | Blocker |
| --- | --- | --- | --- |
| Send listings on WhatsApp | WhatsApp Business Cloud (Meta) · Send Template Message | slug `whatsapp_business_cloud`, service `row3icnwu2su`; WABA, phone and template are pickers | A Meta WhatsApp Business account with an **approved template** for property messages, connected by the broker |
| (rejected) | Built-in WhatsApp · Send WhatsApp Message (NoAuth) | `rowax61bwd33` V18 | Its 97 templates belong to viaSocket's own business account (support, webinars, billing). Using them would send from viaSocket's number with viaSocket's text |
| Reply tracking | WhatsApp Business Cloud (Meta) · Message Notification trigger | | Same account; replies only, never "opened" |
| Slack alerts and summaries | Slack · Send Message | slug `slack`, `rowbu58rc`, V107; channel is a picker | A Slack workspace connected by the broker |
| Itinerary travel times | Google Map · Get a Distance Matrix | slug `Google-Map`, `rowa0ibichgc` (Basic sign-in) | A Google Maps API key, connected by the broker; otherwise ordering is labelled approximate |
| Instant rent confirmation | Razorpay · Any Payment Link Gets Paid trigger | slug `razorpay` | Needs a viaSocket flow per broker; the 15-minute List Payment Links check is used instead |
| Scheduled checks | Embarko schedule `GET /tasks/automations` every 15 minutes | embarko.json | Built: follow-up reminders, ended viewings, rent reminders and payment checks |
