# DealSaathi demo video — editable project

A ~3-minute product demo (1920×1080, 16:9, 30 fps, H.264 + AAC, English captions), built with FFmpeg
from real recordings and evidence cards. No video framework is needed: everything here runs with what is
already installed (FFmpeg 6 with libass, Python 3 with NumPy, Node 22 with Playwright and Chromium).

**Current state:** `out/DealSaathi-Demo-DRAFT.mp4` is a draft. It has **no narration** (your voice has not
been recorded yet), temporary caption timing, a temporary music bed, three MISSING-asset slates for the
Embarko UI recordings, and a text-only closing card. It says DRAFT in the corner. `DealSaathi-Demo.mp4` is
written only when all of those are replaced. See `asset-manifest.md` for the exact list.

## Layout

```
narration.md          the script; its "> " lines are also the captions
timeline.json         scenes, segments, durations, zooms, overlays, replacement slots
asset-manifest.md     every asset, its source, and what is still missing
src/build.py          renders the video (segments → cross-fades → captions → audio mix)
src/cards.mjs         renders the cards and overlays from real files and evidence/
src/record.mjs        records the product clips with Chromium (staging + production landing page)
src/extract-evidence.py  copies the sanitised session-log excerpts into evidence/
assets/cards/         rendered cards (PNG)        assets/overlays/  text chips (PNG, transparent)
assets/supplied/      your files: closing.png
recordings/           recorded clips (not in git)  recordings/supplied/  your screen recordings
audio/voice/          your narration: scene1..5     audio/music.*  your music (optional)
captions/             captions.srt (generated), optional scene1..5.srt overrides
evidence/             Embarko API capture, session-log excerpts, redacted screenshot
out/                  renders and intermediate files (not in git)
```

## Render

```bash
cd video-project
python3 src/build.py           # full quality, about 15 minutes on 4 cores
python3 src/build.py --fast    # preview with the same timing, about 6 minutes
```

The script prints the scene plan, the segments, and why the result is still a draft if it is one.

## Replace the temporary timing with your voice

1. Record each scene of `narration.md` as its own file: `audio/voice/scene1.wav` to `scene5.wav`
   (MP3 or M4A also work). Keep about half a second of silence at each end.
2. Run `python3 src/build.py`.

What changes automatically:

- **Scene lengths** follow your takes: each scene becomes *your take + 0.6 s lead-in + 1.0 s tail*,
  and all its segments (and the overlays on them) are stretched or shortened in proportion.
- **Captions** are re-timed across each take, by text length.
- **Music** drops to a bed under your voice and ducks further while you speak (side-chain compression).
  The mix is normalised to −16 LUFS, suitable for LinkedIn, X and YouTube.

For frame-accurate captions, write `captions/scene<N>.srt` with times relative to the start of that
scene's voice file. It replaces the automatic timing for that scene. To change the caption text, edit the
`> ` lines in `narration.md`, and say the same words in your recording.

If you read the script in one take, cut it into the five files at the scene breaks (any audio editor).

## Replace placeholders and recordings

Drop files at the paths named in `asset-manifest.md` and re-run `build.py`. No other edit is needed:

- `recordings/supplied/*.mp4` take the place of the matching slate (`supplied` in `timeline.json`).
  A screenshot with the same name (`.png` or `.jpg`) works too; it is shown whole, without cropping.
  A recording is sped up or slowed down to fit its slot, never cropped. Change the slot's `dur` to give
  it more time.
- `assets/supplied/closing.png` replaces the closing card. It is fitted inside the frame with its
  proportions kept, so logos are not distorted.
- To re-record a product clip, run `src/record.mjs` (below), or replace the file in `recordings/`.

## Edit the timeline

`timeline.json` has one entry per segment:

- `card`: a PNG with a slow zoom (`zoom: [start, end]`).
- `clip`: a recording from `src_in` to `src_out`. The last `tail` seconds play at real speed and the rest
  is sped up to fit `dur`.
- `overlays`: `[png, from, to]` in seconds within the segment.
- `transition`: cross-fade length between all segments.

Total length is the sum of the scenes; the target is 2:45–3:10.

## Regenerate cards and recordings

```bash
node src/cards.mjs                      # all cards and overlays; or: node src/cards.mjs c08-deploy
python3 src/extract-evidence.py <session.jsonl>   # refresh evidence/session-excerpts.json
```

`src/record.mjs` signs in to **staging** with the demo accounts and records each clip. It needs
`DEMO_STATE` (the staging demo state file that holds the demo password; kept outside the repository,
mode 600) and `VIDEO_RUN` (a file it keeps to know which workflow steps already ran):

```bash
DEMO_STATE=/path/to/staging-state.json VIDEO_RUN=/path/to/video-run.json \
NODE_USE_ENV_PROXY=1 node src/record.mjs agent-dashboard,agent-integrations,prod-landing
```

The six workflow clips change staging data (they create a listing and move one offer through
its stages), so each runs once, in order. To record them again, set a new listing title in the
`VIDEO_RUN` file and use `--force`. The script never signs in to production: its only production
clip is the public landing page.

## Honesty rules this project follows

- Every screen is real: recordings of the running app, real repository files, real session-log lines,
  real Embarko API responses. Missing recordings are shown as labelled slates, never mocked up.
- Scene 4 shows the offer workflow, not the suggested single-request Calendar + Gmail + Slack
  coordinator, because that single request is not built (see `narration.md`).
- Product clips are labelled as staging with synthetic data.
- No secrets, tokens or real users' data appear. The Embarko token line is removed from the hosting
  prompt, and the e-mail addresses in the integrations screenshot are redacted.
