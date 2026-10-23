#!/usr/bin/env python3
"""Aligns your narration recording to narration.md and prepares it for build.py.

    python3 src/align-voice.py <recording>            # one take of the whole script
    python3 src/align-voice.py --scenes               # or: audio/voice/scene1..5.* already cut by you
    add --cut launch for the launch cut (narration-launch.md, audio/voice/launch/, captions/launch/)

Writes audio/voice/scene<N>.wav (one take is cut into scenes at the pauses between them) and
captions/scene<N>.words.json (each word's time in that file), which build.py uses to place each sentence,
cue the visuals to the words and time the captions.

Needs PocketSphinx (pip install pocketsphinx, about 30 MB with its English model). Forced alignment only
finds *where* the script's words are; it cannot tell whether you said different words. If you changed the
wording while recording, change the '> ' lines in narration.md to match first.
"""
import json, subprocess, sys, tempfile, wave
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from narr import ROOT, narration, spoken_words, VOICE, CAPTIONS, loudness, quiet_point

try:
    from pocketsphinx import Decoder
except ImportError:
    sys.exit('PocketSphinx is not installed: pip install pocketsphinx')

EXTRA_WORDS = {'saathi': 'S AA TH IY', "saathi's": 'S AA TH IY Z', 'embarko': 'EH M B AA R K OW', 'viewings': 'V Y UW IH NG Z'}


def to16k(src, dst):
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(src), '-ac', '1', '-ar', '16000', str(dst)], check=True)


def align(wav16, words):
    d = Decoder(samprate=16000, loglevel='FATAL', bestpath=False, beam=1e-80, wbeam=1e-60, pbeam=1e-80)  # wide beams: short files fail with the defaults
    for w, ph in EXTRA_WORDS.items():
        d.add_word(w, ph, True)
    d.set_align_text(' '.join(words))
    with wave.open(str(wav16), 'rb') as w:
        d.start_utt()
        while True:
            b = w.readframes(4096)
            if not b:
                break
            d.process_raw(b, False, False)
        d.end_utt()
    seg = [(s.start_frame / 100, s.end_frame / 100) for s in (d.seg() or []) if s.word not in ('<s>', '</s>', '<sil>', '(NULL)')]
    if len(seg) != len(words):
        sys.exit(f'alignment failed: {len(seg)} of {len(words)} words placed. Does the recording follow narration.md?')
    return seg


def duration(p):
    return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(p)], capture_output=True, text=True, check=True).stdout)


scenes = narration()
(ROOT / VOICE).mkdir(parents=True, exist_ok=True)
(ROOT / CAPTIONS).mkdir(parents=True, exist_ok=True)
args = [a for i, a in enumerate(sys.argv[1:]) if a != '--cut' and (i == 0 or sys.argv[i] != '--cut')]
tmp = Path(tempfile.mkdtemp())

def align_scene(sid, src, note):
    """Aligns one scene's file to that scene's lines and writes its word timings."""
    words, owner = [], []
    for li, line in enumerate(scenes[sid]):
        ws = spoken_words(line)
        words += ws
        owner += [li] * len(ws)
    to16k(src, tmp / 'a.wav')
    seg = align(tmp / 'a.wav', words)
    out = [{'word': w, 'line': o, 'start': round(a, 3), 'end': round(b, 3)} for w, o, (a, b) in zip(words, owner, seg)]
    (ROOT / f'{CAPTIONS}/scene{sid}.words.json').write_text(json.dumps({'source': note, 'words': out}, indent=0))
    return out


if args[:1] == ['--scenes']:
    for sid in scenes:
        src = next((ROOT / f'{VOICE}/scene{sid}{e}' for e in ('.wav', '.mp3', '.m4a') if (ROOT / f'{VOICE}/scene{sid}{e}').exists()), None)
        if not src:
            sys.exit(f'missing {VOICE}/scene{sid}.*')
        print(f'scene {sid}: {len(align_scene(sid, src, src.name))} words aligned in {src.name}')
    sys.exit(0)

# One take: align the whole script once to find the scenes, cut each at the quiet stretch between them,
# then align each scene again on its own (forced alignment is most accurate on short files).
take = Path(args[0])
words, owner = [], []
for sid, lines in scenes.items():
    for li, line in enumerate(lines):
        ws = spoken_words(line)
        words += ws
        owner += [(sid, li)] * len(ws)
to16k(take, tmp / 'take.wav')
seg = align(tmp / 'take.wav', words)
total = duration(take)
db = loudness(take)
spans = {}
for (sid, _), (a, b) in zip(owner, seg):
    s = spans.setdefault(sid, [a, b])
    s[0], s[1] = min(s[0], a), max(s[1], b)
ids = list(scenes)
bounds = [0.0]
for prev, nxt in zip(ids, ids[1:]):
    guess = (spans[prev][1] + spans[nxt][0]) / 2
    bounds.append(quiet_point(db, min(spans[prev][1], guess) - 1.5, max(spans[nxt][0], guess) + 0.5) or guess)
bounds.append(total)
for i, sid in enumerate(ids):
    start, end = bounds[i], bounds[i + 1]
    out = ROOT / f'{VOICE}/scene{sid}.wav'
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', f'{start:.3f}', '-to', f'{end:.3f}', '-i', str(take), '-ac', '1', '-ar', '48000', str(out)], check=True)
    try:
        n = len(align_scene(sid, out, f'{take.name} {start:.2f}–{end:.2f} s'))
    except (SystemExit, TypeError) as e:
        sys.exit(f'scene {sid} ({start:.2f}–{end:.2f} s) could not be aligned on its own: {e}')
    print(f'scene {sid}: {start:6.2f}–{end:6.2f} s of {take.name} → {VOICE}/scene{sid}.wav ({n} words)')
