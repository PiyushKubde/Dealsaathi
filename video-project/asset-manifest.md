# Asset manifest

What the video is made of, where each piece came from, and what is still missing.
Nothing in the video is mocked up: every screen is a real recording or a card built from a real file,
API response or session-log line. The only made-up visuals are the clearly labelled MISSING-asset slates
and the placeholder closing card.

## Still needed (the draft shows a placeholder for each)

| # | Asset | Scene | Put it at | What to record |
|---|---|---|---|---|
| 1 | **Your narration** | all | `audio/voice/scene1.wav` … `scene5.wav` | Read `narration.md`, one file per scene. |
| 2 | **Closing graphic** with the DealSaathi dashboard and ViaSocket × Embarko logos | 5 | `assets/supplied/closing.png` (1920×1080 ideally; any size is fitted without distortion) | The supplied brand graphic. The draft has a text-only card and no logos, because no logo files were supplied. |
| 3 | **Embarko "Host new app" page**, copying the deployment prompt | 3 | `recordings/supplied/embarko-host-new-app.mp4` | Screen recording in your browser, signed in to Embarko. |
| 4 | **Claude Code with the prompt pasted, deploy running** | 3 | `recordings/supplied/claude-code-deploy.mp4` | Screen recording. Hide or crop the deploy token. |
| 5 | **Embarko dashboard for dealsaathi-app**: Running status, production URL, traffic, scheduled jobs | 3 | `recordings/supplied/embarko-dashboard.mp4` | Screen recording of the app's page in the Embarko console. |
| 6 | *(optional)* **Claude Code building DealSaathi** | 2 | `recordings/supplied/claude-code-build.mp4` | Replaces the starting-prompt card if supplied. The session-log cards already show the real steps. |
| 7 | *(optional)* **Music** | all | `audio/music.wav` (or .mp3/.m4a) | A licensed instrumental track. Otherwise the generated temporary bed is used. |

Items 3–5 could not be recorded from here: the Embarko console needs your browser sign-in, and no
Embarko UI recording was supplied. The Embarko facts the video shows instead (deployments, status,
scheduled job, start-up log) come from Embarko's API (item E1 below).

## Real recordings (made for this video, `recordings/`, regenerate with `src/record.mjs`)

Recorded on 23 Oct 2026 with Chromium at a native 1920×1080 (a 1440×810 window drawn at 4/3 zoom; the
cursor is drawn in, as screen capture does not include it). Not committed to git; re-run `record.mjs`.

| File | What | Where |
|---|---|---|
| `agent-dashboard.mp4` | Agent dashboard (redesigned UI, commit 436fbee) | **Staging**, demo agent "Asha Verma (Demo Agent)" |
| `agent-integrations.mp4` | Integrations page: Gmail, Slack, Google Calendar, WhatsApp, Razorpay. Staging shows "Not connected" | Staging, read-only |
| `prod-landing.mp4` | Signed-out landing and sign-in page | **Production**, `https://dealsaathi-app.embarko.app`, no account, no user data |
| `seller-listing.mp4` | Seller lists "Demo · 4 BHK villa in Scheme 54" and publishes it | Staging, demo seller |
| `buyer-offer.mp4` | Buyer opens it, presses "I'm interested", makes an ₹88 L offer | Staging, demo buyer |
| `agent-forward.mp4` | Buyer's agent forwards the offer to the owner | Staging, demo agent |
| `seller-counter.mp4` | Owner counters at ₹90 L | Staging, demo seller |
| `buyer-accept.mp4` | Buyer accepts the counter: "Accepted in principle" with the disclaimer | Staging, demo buyer |
| `agent-close.mp4` | Agent records it as agreed, then the Notifications page | Staging, demo agent |

The offer workflow really ran. Afterwards the staging API reported for that offer:
`buyer:submitted@8800000 > agent:forwarded > owner:countered@9000000 > buyer:accepted@9000000 > agent:closed_won`.

**Why staging:** staging runs the same release as production (commit 436fbee, schema v10), and using it
kept real production users' data out of the video. No AI request and no e-mail was sent (staging has
system e-mail off and the Assistant was not used). Every product clip in scenes 1, 4 and 5 carries an
on-screen label saying so.

## Cards (`assets/cards/`, regenerate with `src/cards.mjs`)

| Card | Content | Source |
|---|---|---|
| `c01-title` | Title | — |
| `c02-prompt` | The starting prompt, first lines, with its time and length | Session log line 3 (`evidence/session-excerpts.json`) |
| `c03-steps` | Six real tool calls and their output: skill fetched, SDK installed (0.7.0), official check script "0 FAIL, 0 WARN", embed token PASS, first AI request, commit pushed | Session log lines 37, 83, 136, 142, 297, 454 |
| `c04-skill` | `viasocket-integrations/SKILL.md` lines 1–3, 9–18 | Repository file |
| `c05-sdk` | `server/viasocket.js` lines 2–4, 9–15, 45–47, 61 | Repository file |
| `c06-actions` | `public/app.js` 903–909 (Connect popup) and `server/integrations/run.js` 1–2, 163–166 (`runAction`) | Repository files |
| `c07-hosting-prompt` | Embarko's hosting prompt as pasted into Claude Code; **the token line is removed** | Session log line 651 |
| `c08-deploy` | First deploy under the account (18:04:22 building → 18:04:34 live, claimed) and the latest deployments v17–v20 | Session log line 665; Embarko API (E1) |
| `c09-running` | Status live, start-up log (user counts removed), scheduled job `*/15 * * * *`, last run ok 200 | Embarko API (E1) |
| `c10-live-tests` | Gmail and Slack live tests passed; Google Calendar test confirmed later that day | Your screenshot of 22 Oct 2026 (`evidence/screenshots/`, **e-mail addresses redacted**), and the session log |
| `c11-closing` | **Placeholder** closing card, text only | — (replace with asset 2) |
| `m01`–`m04` | **MISSING-asset slates** | — (replace with assets 3–6) |

## Evidence files (`evidence/`)

- **E1** `embarko.json`: read-only GET requests to the Embarko API on 23 Oct 2026 12:37 UTC (deployments,
  status, schedules, start-up log lines). E-mail addresses are scrubbed. No token is stored.
- **E2** `session-excerpts.json`: produced by `src/extract-evidence.py` from the Claude Code session log.
  Tokens, e-mail addresses and claim codes are removed.
- **E3** `screenshots/integrations-live-tests-redacted.png`: crop of your 22 Oct screenshot, with the
  e-mail addresses blurred and covered.

## Audio

- `audio/music-temp.wav`: **temporary** music bed generated by `build.py` (synthesised chords and a soft
  arpeggio, no samples). It is meant for timing only; swap in a licensed track (asset 7).
- No voice is in the draft.

## Kept out of the video on purpose

The Embarko token (it appears in plaintext in the session log), the app's environment values, real users'
names, e-mails and leads in production, production user counts, the Embarko claim link, and the real
buyer's viewing that was booked during testing.
