#!/usr/bin/env python3
"""Aligns your narration recording to narration.md and prepares it for build.py.

    python3 src/align-voice.py <recording>            # one take of the whole script
    python3 src/align-voice.py --scenes               # or: audio/voice/scene1..5.* already cut by you

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
from narr import ROOT, narration, spoken_words

try:
    from pocketsphinx import Decoder
except ImportError:
    sys.exit('PocketSphinx is not installed: pip install pocketsphinx')

EXTRA_WORDS = {'saathi': 'S AA TH IY', 'embarko': 'EH M B AA R K OW'}


def to16k(src, dst):
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(src), '-ac', '1', '-ar', '16000', str(dst)], check=True)


def align(wav16, words):
    d = Decoder(samprate=16000, loglevel='FATAL', bestpath=False)
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
    seg = [(s.start_frame / 100, s.end_frame / 100) for s in d.seg() if s.word not in ('<s>', '</s>', '<sil>', '(NULL)')]
    if len(seg) != len(words):
        sys.exit(f'alignment failed: {len(seg)} of {len(words)} words placed. Does the recording follow narration.md?')
    return seg


def duration(p):
    return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(p)], capture_output=True, text=True, check=True).stdout)


scenes = narration()
(ROOT / 'audio/voice').mkdir(parents=True, exist_ok=True)
(ROOT / 'captions').mkdir(exist_ok=True)
tmp = Path(tempfile.mkdtemp())

if sys.argv[1:2] == ['--scenes']:
    jobs = []
    for sid in scenes:
        src = next((ROOT / f'audio/voice/scene{sid}{e}' for e in ('.wav', '.mp3', '.m4a') if (ROOT / f'audio/voice/scene{sid}{e}').exists()), None)
        if not src:
            sys.exit(f'missing audio/voice/scene{sid}.*')
        jobs.append((sid, src))
    for sid, src in jobs:
        words, owner = [], []
        for li, line in enumerate(scenes[sid]):
            ws = spoken_words(line)
            words += ws
            owner += [li] * len(ws)
        to16k(src, tmp / 'a.wav')
        seg = align(tmp / 'a.wav', words)
        out = [{'word': w, 'line': o, 'start': a, 'end': b} for w, o, (a, b) in zip(words, owner, seg)]
        (ROOT / f'captions/scene{sid}.words.json').write_text(json.dumps({'source': src.name, 'words': out}, indent=0))
        print(f'scene {sid}: {len(out)} words aligned in {src.name}')
    sys.exit(0)

take = Path(sys.argv[1])
words, owner = [], []
for sid, lines in scenes.items():
    for li, line in enumerate(lines):
        ws = spoken_words(line)
        words += ws
        owner += [(sid, li)] * len(ws)
to16k(take, tmp / 'take.wav')
seg = align(tmp / 'take.wav', words)
total = duration(take)
spans = {}
for (sid, _), (a, b) in zip(owner, seg):
    s = spans.setdefault(sid, [a, b])
    s[0], s[1] = min(s[0], a), max(s[1], b)
ids = list(scenes)
for i, sid in enumerate(ids):
    # cut half-way through the pause between scenes, never into a word
    start = 0.0 if i == 0 else (spans[ids[i - 1]][1] + spans[sid][0]) / 2
    end = total if i == len(ids) - 1 else (spans[sid][1] + spans[ids[i + 1]][0]) / 2
    out = ROOT / f'audio/voice/scene{sid}.wav'
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', f'{start:.3f}', '-to', f'{end:.3f}', '-i', str(take), '-ac', '1', '-ar', '48000', str(out)], check=True)
    ws = [{'word': w, 'line': o[1], 'start': round(a - start, 3), 'end': round(b - start, 3)} for w, o, (a, b) in zip(words, owner, seg) if o[0] == sid]
    (ROOT / f'captions/scene{sid}.words.json').write_text(json.dumps({'source': f'{take.name} {start:.2f}–{end:.2f} s', 'words': ws}, indent=0))
    print(f'scene {sid}: {start:6.2f}–{end:6.2f} s of {take.name} → audio/voice/scene{sid}.wav ({len(ws)} words)')
