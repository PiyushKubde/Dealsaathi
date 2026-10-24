#!/usr/bin/env python3
"""Re-sequences the recorded launch narration into the launch film's order.

    python3 src/launch/voice_plan.py   ->  out/launch/voice.wav, out/launch/plan.json

Each sentence of the take (audio/voice/launch/scene<N>.wav + captions/launch/scene<N>.words.json) is cut
at the quiet before and after it and placed on the film's timeline with the gap listed below. plan.json
holds every sentence's start and end and each displayed word's time, which the renderer and the music
use to cut and animate on the voice.
"""
import json, re, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.argv += ['--cut', 'launch']  # before narr is imported: it picks narration-launch.md from this
import numpy as np  # noqa: E402
from narr import ROOT, spoken_words, loudness, quiet_point, narration  # noqa: E402

import os  # noqa: E402
FILM = os.environ.get('FILM', 'launch')  # launch (1:44) or showcase (~3 min, both takes)
OUT = ROOT / 'out' / FILM
OUT.mkdir(parents=True, exist_ok=True)
SR = 48000

# (id, scene, line, gap before it in seconds). The film: hook, reveal, product, integrations, live today,
# then a short "how we built it" and the sign-off. One recorded sentence is left out to keep the pace.
SEQUENCE = [
    ('hook1', 1, 0, 0.7), ('hook2', 1, 1, 0.4), ('reveal', 1, 2, 0.9),
    ('dash', 2, 0, 1.6), ('ai', 2, 1, 0.35), ('seller', 2, 2, 0.35), ('buyer', 2, 3, 0.35), ('offer', 2, 4, 0.35), ('notify', 2, 5, 0.35),
    ('tools', 3, 0, 0.5), ('live', 5, 0, 0.6),
    ('claude', 4, 0, 2.0), ('viasocket', 4, 1, 0.4), ('embarko', 4, 2, 0.4),
    ('built', 5, 1, 0.9), ('tagline', 5, 2, 0.4),
]
END_HOLD = 3.8 if os.environ.get('FILM', 'launch') == 'launch' else 5.0
# The showcase uses both recordings: 'L' = the launch take (narration-launch.md), 'W' = the walkthrough
# take (narration.md). ('beat', name, seconds) is a music-only moment for a title or a stat.
SHOWCASE = [
    ('hook1', 'L', 1, 0, 0.7), ('hook2', 'L', 1, 1, 0.4), ('reveal', 'L', 1, 2, 0.9),
    ('dash', 'L', 2, 0, 1.6), ('ai', 'L', 2, 1, 0.35),
    ('beat', 'essentials', 7.5),
    ('beat', 'vsTitle', 4.0),
    ('w_claude', 'W', 2, 0, 0.3), ('w_sdk', 'W', 2, 1, 0.45), ('tools', 'L', 3, 0, 0.5), ('w_goal', 'W', 2, 2, 0.6), ('w_half', 'W', 2, 3, 0.45),
    ('beat', 'getOnline', 3.4),
    ('w_online', 'W', 3, 0, 0.3), ('w_embarko', 'W', 3, 1, 0.35), ('w_workflow', 'W', 3, 2, 0.45), ('w_url', 'W', 3, 3, 0.45), ('w_dash', 'W', 3, 4, 0.45),
    ('beat', 'deployStats', 7.0),
    ('live', 'L', 5, 0, 0.5), ('w_action', 'W', 4, 0, 0.6), ('w_seller', 'W', 4, 1, 0.35), ('w_forward', 'W', 4, 2, 0.45), ('w_accept', 'W', 4, 3, 0.35),
    ('notify', 'W', 4, 4, 0.45), ('w_one', 'W', 4, 6, 0.45),
    ('beat', 'recap', 6.0),
    ('built', 'L', 5, 1, 0.6), ('tagline', 'L', 5, 2, 0.4),
]

def parse(path):
    import re as _re
    out, cur = {}, None
    for ln in (ROOT / path).read_text().split('\n'):
        m = _re.match(r'^## Scene (\d+)', ln)
        if m:
            cur = int(m.group(1)); out[cur] = []
        elif cur and ln.startswith('> '):
            out[cur].append(ln[2:].strip())
    return out


SOURCES = {'L': (parse('narration-launch.md'), 'audio/voice/launch', 'captions/launch'), 'W': (parse('narration.md'), 'audio/voice', 'captions')}
if FILM == 'launch':
    SEQUENCE = [(lid, 'L', sid, li, gap) for lid, sid, li, gap in SEQUENCE]
else:
    SEQUENCE = SHOWCASE
beats = []
pieces, plan, t = [], [], 0.0
cache = {}
for entry in SEQUENCE:
    if entry[0] == 'beat':
        beats.append({'id': entry[1], 'start': round(t + 0.2, 3), 'end': round(t + entry[2], 3)})
        t += entry[2]
        continue
    lid, src, sid, li, gap = entry
    lines, vdir, cdir = SOURCES[src]
    key = (src, sid)
    if key not in cache:
        wav = ROOT / f'{vdir}/scene{sid}.wav'
        words = json.loads((ROOT / f'{cdir}/scene{sid}.words.json').read_text())['words']
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(wav), '-ac', '1', '-ar', str(SR), '-f', 's16le', '-'], capture_output=True, check=True).stdout
        cache[key] = (np.frombuffer(raw, np.int16).astype(np.float32) / 32768, words, loudness(wav))
    audio, words, db = cache[key]
    ws = [w for w in words if w['line'] == li]
    others = [w for w in words if w['line'] != li]
    before = max([w['end'] for w in others if w['end'] <= ws[0]['start']] or [0.0])
    after = min([w['start'] for w in others if w['start'] >= ws[-1]['end']] or [len(audio) / SR])
    a = quiet_point(db, max(before, ws[0]['start'] - 0.35), ws[0]['start'] + 0.02) or max(0, ws[0]['start'] - 0.12)
    b = quiet_point(db, ws[-1]['end'] - 0.02, min(after, ws[-1]['end'] + 0.45)) or ws[-1]['end'] + 0.15
    a, b = min(a, ws[0]['start'] - 0.04), max(b, ws[-1]['end'] + 0.06)
    t += gap
    seg = audio[int(a * SR):int(b * SR)].copy()
    fi, fo = int(0.06 * SR), int(0.12 * SR)
    seg[:fi] *= np.linspace(0, 1, fi)
    seg[-fo:] *= np.linspace(1, 0, fo)
    pieces.append((t, seg))
    # displayed words, each timed from the spoken words it covers
    disp, k = [], 0
    for token in lines[sid][li].split():
        n = len(spoken_words(token))
        if n == 0:
            continue
        span = ws[k:k + n]
        k += n
        disp.append({'w': token, 's': round(t + span[0]['start'] - a, 3), 'e': round(t + span[-1]['end'] - a, 3)})
    plan.append({'id': lid, 'text': lines[sid][li], 'start': round(t + ws[0]['start'] - a, 3), 'end': round(t + ws[-1]['end'] - a, 3), 'words': disp,
                 'spoken': [{'w': w['word'], 's': round(t + w['start'] - a, 3)} for w in ws]})
    t += len(seg) / SR
total = t + END_HOLD
mix = np.zeros(int(total * SR) + SR, np.float32)
for at, seg in pieces:
    i = int(at * SR)
    mix[i:i + len(seg)] += seg
mix = mix[:int(total * SR)]
subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'f32le', '-ar', str(SR), '-ac', '1', '-i', '-', str(OUT / 'voice.wav')], input=mix.tobytes(), check=True)
(OUT / 'plan.json').write_text(json.dumps({'total': round(total, 3), 'lines': plan, 'beats': beats}, indent=1))
print(f'voice plan: {total:.1f} s, {len(plan)} sentences')
for p in plan:
    print(f'  {p["id"]:10} {p["start"]:6.2f}–{p["end"]:6.2f}  {p["text"][:60]}')
