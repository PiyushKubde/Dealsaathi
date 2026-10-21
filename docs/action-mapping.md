# DealSaathi action mapping

What the assistant may do, who picks it, and where every value comes from.
Phase 2 has **one** action, and it is local: no viaSocket app action, CRM, email or calendar is called.

## Who picks the action

**The developer, in code.** The AI only labels the broker's message with one intent from a fixed list
(`create_lead`, `add_details`, `cancel`, `other`); `server/assistant/service.js` maps that label to what
happens. The AI is given no tools, so it cannot call anything. An unknown label is refused as a malformed
answer. Only a **Confirm and save** click on the review card runs the action; typing "yes" in the chat does not.

| AI intent     | What the code does                                                       | Needs confirmation |
| ------------- | ------------------------------------------------------------------------ | ------------------ |
| `create_lead` | Starts a draft (or adds to the open draft if the name matches)           | Yes, to save       |
| `add_details` | Adds the new details to the open draft (starts one if there is none)     | Yes, to save       |
| `cancel`      | Cancels the open draft; nothing is saved                                 | No (nothing saved) |
| `other`       | Declines: "Right now I can only add new leads"                           | n/a                |

## The AI call (viaSocket)

| What            | Value                                                                                   |
| --------------- | --------------------------------------------------------------------------------------- |
| Package call    | `viasocket.user(userId).ai.send({ threadId, message, prompt, responseType, jsonSchema })` from `viasocket-apps` 0.7.0 |
| Docs            | https://flow.viasocket.com/documentation/ai.md                                          |
| Runs where      | Server only (`server/index.js`). The browser never sees the secret or any token          |
| `userId`        | Code: `DEALSAATHI_USER_ID`, default `local-broker-1` (one local broker; a stable id, not an email) |
| `threadId`      | Code: `lead-<conversation uuid>`, one per chat conversation                              |
| `message`       | Code wraps the **broker's words** (fenced and marked as data) plus the open draft        |
| `prompt`        | Code: `EXTRACTION_PROMPT` in `server/assistant/extract.js`                               |
| `responseType`  | Code: `json_schema`                                                                      |
| `jsonSchema`    | Code: `EXTRACTION_SCHEMA` (strict; every field nullable)                                  |
| `model`/`service` | Left out on purpose: viaSocket's default model                                         |
| `tools`         | Left out on purpose: the AI may not act                                                  |

Result handling: `content` is checked by hand (`parseExtraction`) even though the schema is strict.
A wrong shape gives **502 `ai_malformed`**; a failed call gives 503 with `ai_auth`, `ai_busy`,
`ai_unreachable` or `ai_failed`. Nothing is prepared or saved in either case.

## Action `create_lead` → local SQLite insert

| Field                | Required | Supplied by                                       | Validation                                      |
| -------------------- | -------- | ------------------------------------------------- | ----------------------------------------------- |
| `full_name`          | Yes      | AI from the message → broker confirms/edits       | 2–100 chars; every word must appear in what the broker typed, or it is left unknown |
| `customer_type`      | Yes      | AI → broker                                       | buyer / seller / tenant / landlord; left unknown and flagged when unclear |
| `phone` *or* `email` | One of them | AI → broker                                    | Must literally appear in the broker's messages (else left unknown); phone 10–15 digits; email format |
| `preferred_location` | No       | AI → broker                                       | ≤ 120 chars                                     |
| `property_type`      | No       | AI (only when stated) → broker                    | apartment / independent_house / villa / plot / commercial / other |
| `property_interest`  | No       | AI → broker                                       | ≤ 200 chars                                     |
| `bedrooms`           | No       | AI → broker                                       | Whole number 0–20                               |
| `budget_min`, `budget_max` | No | AI (lakh/crore → rupees) → broker               | Whole rupees ≥ 0; min ≤ max; "around X" is flagged |
| `source`             | No       | AI (only when stated) → broker                    | walk_in / referral / website / phone_call / social_media / property_portal / other |
| `notes`              | No       | AI (only when stated) → broker                    | ≤ 2000 chars                                    |
| `status`             | No       | Code default `new` → broker may change            | One of the status list                          |
| `assigned_broker`    | No       | Broker only                                       | ≤ 100 chars                                     |
| `id`, `created_at`, `updated_at` | — | Code (SQLite autoincrement, ISO timestamps) | Shown as `L-0001`                                |

Anything not stated stays **unknown** (`null`), never guessed.

**Confirmation:** the review card shows every field, tags AI-filled ones, highlights missing ones, lists the
AI's doubts and any duplicates. The broker edits and presses **Confirm and save**. The server validates the
edited values again before inserting.

**Duplicates:** the same phone or email as an existing lead is blocked. The same name only is a warning the
broker can override with **Save anyway**.

**Result handling:** the insert and the "draft completed" mark happen in one transaction. Success returns the
row read back from the database. A second Confirm returns that same lead (`alreadySaved: true`), so no second
row is made. A database error rolls back, answers 500 "nothing was saved" and keeps the draft open to retry.
The saved lead is labelled **local database**; it is never described as a CRM record.
