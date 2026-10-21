# DealSaathi action mapping

Every external action DealSaathi can take, how it is chosen, where each input comes from, and its real status.
All viaSocket calls run on the server through `viasocket-apps` 0.7.0 (`server/viasocket.js`).

## Who picks the action

**The developer, in code, from a fixed allowlist.** The AI never names an app, action or id:

- Lead entry: the AI labels a message `create_lead | add_details | cancel | other`; code maps that to the one local
  action "save a lead", run only by a **Confirm and save** click.
- Follow-up email: the broker opens a lead and chooses **Follow-up email**; code runs exactly one action,
  Gmail · Send Email, after a **Send now** click.
- Automations: the broker builds them in viaSocket's own prebuilt UI; DealSaathi only lists, pauses and resumes them.

## Identity, tokens and secrets

| Thing | Where it lives |
| --- | --- |
| `VIASOCKET_EMBED_SECRET` | Server env only. Never in a response, file in Git, or log |
| Embed token | Signed per request for the signed-in broker (`viasocket.user(usr_…).token()`); sent to the browser only for the Connect popup and the prebuilt UI, as the skill allows |
| `userId` / `unique_identifier` | The broker's own `usr_…` id: random, stable, never the email |
| `auth_id` (a connection) | `connections` table, per broker; the browser sees a row id. Checked against `listConnections()` before it is stored. Sent to the browser only to reconnect that broker's own expired connection (`connect({ authId })`) |
| `script_id` (an enabled app or a flow) | `enabled_apps` table, server only. The Automations list gives the browser an opaque ref |

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
| Scheduled checks (follow-up due, inactivity, rent) | A viaSocket automation with a `cron` trigger calling a DealSaathi endpoint, or an Embarko schedule | automations.md | Needs a public URL (the Embarko app) and a per-schedule secret; not built |
