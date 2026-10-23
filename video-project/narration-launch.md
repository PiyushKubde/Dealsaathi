# DealSaathi launch video — narration

A product launch: DealSaathi is the product, introduced first and shown working; Claude Code, the
ViaSocket SDK and Embarko are how it was built and shipped. About 2:35–2:50 at your pace.

`src/build.py` reads the lines that start with `>`: they become the captions. One line = one caption
group. Every claim below is shown on screen or backed by the evidence in `asset-manifest.md`.

## Scene 1 — The launch (0:00–0:20)

> Buying, selling or renting a home still runs on endless calls, messages and follow-ups.
> Agents juggle chat groups and spreadsheets, buyers wait for updates, and sellers rarely know who's interested.
> Today, we're launching DealSaathi: an AI-powered real estate workspace for agents, buyers and sellers.

## Scene 2 — Meet DealSaathi (0:20–1:20)

> Agents get one dashboard for their leads, listings, viewings and follow-ups.
> They can add a lead just by describing it in plain words, and DealSaathi's AI fills in the details.
> Sellers list a property in minutes, and it's matched against every buyer's saved requirements.
> Buyers see what fits them, tap "I'm interested", and make an offer.
> Their agent forwards it to the owner, the owner can counter, and the buyer accepts in principle.
> Every step notifies the right people, and the buyer's identity stays private from the seller.

## Scene 3 — Connected to the tools agents already use (1:20–1:40)

> Each agent connects their own Gmail, Slack and Google Calendar, for alerts, reminders, and viewings booked straight into their calendar.

## Scene 4 — How we built it (1:40–2:25)

> We built DealSaathi with Claude Code, starting from one detailed prompt and refining it along the way.
> The ViaSocket SDK gave us those integrations and the AI, without building each connection from scratch.
> And Embarko took it live: one hosting prompt, and Claude Code deployed it, with traffic and scheduled jobs in one dashboard.
> Every release since, up to the design you just saw, was built, tested and shipped the same way.

## Scene 5 — Live today (2:25–2:50)

> DealSaathi is live today. Sign up as a buyer or a seller, or bring your team of agents.
> Built with Claude Code, powered by the ViaSocket SDK, and hosted on Embarko.
> DealSaathi: find, show and agree on property, with your agent alongside.

## Recording tips

- One take of the whole script is fine: `src/align-voice.py` cuts it into scenes and times every word.
- Pause for a beat between scenes; the build adds breathing room between sentences on its own.
