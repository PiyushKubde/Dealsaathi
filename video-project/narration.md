# DealSaathi demo — narration

Read in your own voice. `src/build.py` reads the lines that start with `>` below: they become the
captions, so keep this file and your recording in step. One line = one caption (long lines are split).

Timings are the planned scene windows. When you add your recording (see README.md), each scene is
stretched or shortened to fit your take and the captions are re-timed to it.

Changes from the original script, so that every claim matches what the product really does:

- **Scene 2:** the build started from one detailed prompt but was refined with many follow-up prompts in
  the same session, so the line says so.
- **Scene 4:** the suggested "AI Property Visit Coordinator" (one request that checks the calendar,
  books, e-mails and posts to Slack) is not built as one action. DealSaathi does book viewings into
  Google Calendar and has working Gmail and Slack connections, each verified with a live test, but not
  as that single request. The scene shows instead the strongest workflow that works end to end and
  that could be recorded without touching real users: the offer workflow across seller, buyer and agent.
  It was recorded on the staging copy of the same release, with synthetic demo accounts.

## Scene 1 — The idea and DealSaathi (0:00–0:20)

> What if you could build an AI-powered application starting from a single prompt, connect real-world integrations without building them from scratch, and deploy it with ease?
> Meet DealSaathi, built using Claude Code and the ViaSocket SDK, and deployed on Embarko.
> Let me show you how it all comes together.

## Scene 2 — Building with Claude Code and ViaSocket (0:20–1:10)

> I started with a single, detailed prompt in Claude Code, describing the application I wanted to build, and refined it with follow-up prompts along the way.
> With the ViaSocket SDK and skill available in the development workflow, Claude could build DealSaathi and integrate the capabilities it needed, without us having to build every integration from scratch.
> The goal is to spend less time wiring services together, and more time building the product itself.
> But building the app is only half the job. Now, let's get it live.

## Scene 3 — Hosting on Embarko (1:10–1:50)

> Now that the application is built, we need to get it online.
> This is Embarko, a hosting platform designed to make deploying applications straightforward.
> We follow its hosting workflow, provide the required configuration, and let our AI coding agent handle the deployment steps.
> Once the deployment succeeds, DealSaathi is accessible through its own live URL.
> Embarko also gives us a dashboard to monitor traffic, performance, and scheduled jobs.

## Scene 4 — DealSaathi in action: the offer workflow (1:50–2:40)

> Now let's see DealSaathi in action.
> A seller lists a four-bedroom villa. A buyer finds it, taps "I'm interested", and makes an offer.
> The buyer's agent forwards the offer to the owner, who makes a counter-offer.
> The buyer accepts in principle, and the agent records the outcome.
> Every step notifies the right people, and the buyer's identity stays private from the seller.
> Behind the scenes, the ViaSocket SDK connects each agent's own Gmail, Slack and Google Calendar, and each one passed a live test.
> One workflow, three roles, and far less back-and-forth.

## Scene 5 — The result and closing (2:40–3:05)

> And that's DealSaathi: built with Claude Code, integrated using the ViaSocket SDK, and deployed on Embarko.
> We've gone from an idea to a working, integrated application that's running live.
> Less time building integrations and dealing with infrastructure. More time building useful products.
> If you're building your next AI application, give the ViaSocket SDK and Embarko a try.

## Recording tips

- Record each scene as its own file: `audio/voice/scene1.wav` … `scene5.wav` (WAV, MP3 or M4A).
- Leave about half a second of silence at the start and end of each file; the build adds its own
  lead-in, so no need for more.
- Aim for the scene windows above. A scene longer than planned simply makes the video longer; the target
  is 2:45–3:10 overall.
