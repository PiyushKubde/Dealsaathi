# Asset manifest

What the video is made of, where each piece came from, and what is still missing.
Nothing in the video is mocked up: every screen is a real recording or a card built from a real file,
API response or session-log line. The only made-up visuals are the clearly labelled MISSING-asset slates, shown when a screenshot is
absent, and the closing card's layout.

## Optional additions

Nothing required is missing. These would improve it:

| # | Asset | Scene | Put it at | Notes |
|---|---|---|---|---|
| 1 | Your own closing graphic | 5 | `assets/supplied/closing.png` | Replaces the closing card, which is now built from the official logo files (see below). |
| 2 | Screen recordings instead of screenshots | 2, 3 | `recordings/supplied/<same name>.mp4` | A recording with the same name as a screenshot below takes its place. |
| 3 | Music | all | `audio/music.wav` (or .mp3/.m4a) | A licensed instrumental track. The current bed is synthesised by `build.py` (no samples), so it is free to use, but plain. |
| 4 | Claude Code with the Embarko prompt pasted | 3 | `recordings/supplied/claude-code-deploy.mp4` | Add a segment for it in `timeline.json` (slate `m02`). For now, the session-log card shows the pasted prompt. |

## Your screenshots (23 Oct 2026, `recordings/supplied/`, not in git)

| File | Used for |
|---|---|
| `viasocket-home.png` | Scene 2: viasocket.com, "Copy setup prompt · Paste it into Cursor, Claude Code or Codex" |
| `embarko-home.png` | Scene 3: embarko.ai, on "This is Embarko…" |
| `embarko-dashboard.png` | Scene 3: the dealsaathi-app page in the Embarko console (Running, URL, traffic), then a close-up of the scheduled job. Your account name shows in its top-left corner. |

The "Host new app" page and copying the prompt (the first two steps of the requested Scene 3 order)
are not shown as screens: the embarko.ai screenshot and the hosting-prompt card from the session log
stand in for them.

## Brand files (`assets/brand/`)

`viasocket-logo.svg` (from viasocket.com/new-home/assets/logo.svg) and `embarko-icon.svg` (from
embarko.ai/assets/embarko-icon.svg), unaltered and scaled by height only. The Embarko lockup is the icon
plus the word "Embarko", as on embarko.ai. `assets/stills/dashboard.png` is a frame of the staging
dashboard recording.

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
| `buyer-recommendations.mp4` | The buyer's Recommendations page: a 100/100 match with its reasons (launch cut) | Staging, demo buyer, read-only |

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
| `c00-hook`, `c00-hook2`, `c00-launch`, `c12-closing-launch` | Launch cut: the opening hook, "Introducing DealSaathi", and the "Live now" closing with the official logos | — / `assets/brand/` |
| `c11-closing` | Closing card: DealSaathi, the ViaSocket and Embarko logos, "Build. Integrate. Deploy.", the dashboard | `assets/brand/`, `assets/stills/dashboard.png` |
| `m01`–`m06` | MISSING-asset slates, shown only when a screenshot or recording is absent | — |

## Evidence files (`evidence/`)

- **E1** `embarko.json`: read-only GET requests to the Embarko API on 23 Oct 2026 12:37 UTC (deployments,
  status, schedules, start-up log lines). E-mail addresses are scrubbed. No token is stored.
- **E2** `session-excerpts.json`: produced by `src/extract-evidence.py` from the Claude Code session log.
  Tokens, e-mail addresses and claim codes are removed.
- **E3** `screenshots/integrations-live-tests-redacted.png`: crop of your 22 Oct screenshot, with the
  e-mail addresses blurred and covered.

## Audio

- `audio/voice/launch/take-launch.m4a`: **your narration of the launch cut**, one take (1:40), uploaded on
  23 Oct 2026. Cut into scenes at the pauses and aligned word by word (all 283 words of
  `narration-launch.md`). Not in git.

- `audio/voice/take-2026-10-23.m4a`: **your narration**, one take (2:14), uploaded on 23 Oct 2026. Cut into
  `scene1..5.wav` and aligned word by word by `src/align-voice.py` (all 385 words of `narration.md`
  placed). Not in git.

- `audio/music-temp.wav`: music bed generated by `build.py` (synthesised chords and a soft arpeggio, no
  samples or third-party audio). Swap in a track of your choice as `audio/music.*`.

## Kept out of the video on purpose

The Embarko token (it appears in plaintext in the session log), the app's environment values, real users'
names, e-mails and leads in production, production user counts, the Embarko claim link, and the real
buyer's viewing that was booked during testing.
