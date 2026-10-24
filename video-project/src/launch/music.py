#!/usr/bin/env python3
"""The launch film's soundtrack: an original 120 BPM groove and sound effects, synthesised and timed to the cut.

    python3 src/launch/music.py   ->  out/launch/music.wav, out/launch/sfx.wav

Reads out/launch/plan.json (sentence and word times) and out/launch/shots.json (cut times). The groove
builds through the hook, stops for a breath, drops on "launching", gets a hit on "How we built it" and on
the sign-off, and rings out over the closing graphic. No samples or third-party audio are used.
"""
import json, subprocess
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parent.parent.parent
import os  # noqa: E402
OUT = ROOT / 'out' / os.environ.get('FILM', 'launch')
SR = 48000
plan = json.loads((OUT / 'plan.json').read_text())
shots = json.loads((OUT / 'shots.json').read_text())['shots']
L = {l['id']: l for l in plan['lines']}
TOTAL = plan['total']
N = int(TOTAL * SR)
rng = np.random.default_rng(11)


def at(lid, word, n=0):
    return [w['s'] for w in L[lid]['spoken'] if w['w'] == word][n]


def maybe(lid, word):
    try:
        return at(lid, word)
    except (KeyError, IndexError):
        return None


HIT = at('reveal', 'launching')                    # the drop
BUILD = next(s['start'] for s in shots if s['kind'] in ('buildTitle', 'vsTitle'))
EXTRA_HITS = [s['start'] for s in shots if s['kind'] in ('getOnline', 'deployStats', 'recap')]
OUTRO = next(s['start'] for s in shots if s['kind'] == 'outro')
TAG = at('tagline', 'deal')
END_MUSIC = L['tagline']['end'] + 0.6
BEAT = 0.5
grid0 = HIT - BEAT * np.floor(HIT / BEAT)          # beats land exactly on the drop
hz = lambda m: 440.0 * 2 ** ((m - 69) / 12)
# A minor: Am - F - C - G, one chord per bar (2 s)
PROG = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]
ROOTS = [45, 41, 48, 43]


def chord_at(t):
    k = int(np.floor((t - grid0) / (4 * BEAT))) % 4
    return PROG[k], ROOTS[k]


def add(buf, t, sig):
    i = int(t * SR)
    if i >= len(buf) or i + len(sig) <= 0:
        return
    if i < 0:
        sig, i = sig[-i:], 0
    j = min(len(buf), i + len(sig))
    buf[i:j] += sig[:j - i]


def env(n, a=0.005, r=0.2):
    x = np.arange(n) / SR
    return np.clip(x / a, 0, 1) * np.exp(-x / r)


def kick():
    n = int(0.45 * SR); x = np.arange(n) / SR
    f = 48 + 110 * np.exp(-x * 38)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-x * 7.5) * 1.0


def clap():
    n = int(0.25 * SR); s = np.zeros(n)
    for d in (0, 0.011, 0.023):
        k = int(d * SR); m = n - k
        s[k:] += np.diff(rng.standard_normal(m + 1)) * np.exp(-np.arange(m) / SR * (60 if d < 0.02 else 18))
    return s * 0.35


def hat(open_=False):
    n = int((0.18 if open_ else 0.05) * SR)
    s = np.diff(np.diff(rng.standard_normal(n + 2)))
    return s * np.exp(-np.arange(n) / SR * (14 if open_ else 70)) * 0.12


def tone(freq, dur, harmonics=(1,), weights=(1,), a=0.004, r=0.2):
    n = int(dur * SR); x = np.arange(n) / SR
    s = sum(w * np.sin(2 * np.pi * freq * h * x) for h, w in zip(harmonics, weights))
    return s * env(n, a, r)


drums, bass, keys, pad, arp, sfx = (np.zeros(N + SR) for _ in range(6))

# ---------- groove ----------
nb = int((END_MUSIC - grid0) / BEAT) + 1
for b in range(-int(grid0 / BEAT) - 1, nb):
    t = grid0 + b * BEAT
    if t < 0 or t > END_MUSIC:
        continue
    pre = t < HIT
    if pre and t > HIT - 0.3:          # a breath of silence right before the drop
        continue
    build = BUILD <= t < OUTRO
    intro_level = np.clip(t / (HIT - 0.3), 0, 1) if pre else 1.0
    chord, root = chord_at(t)
    # kick: four on the floor after the drop; in the intro only on the last bars, rising
    if not pre or t > HIT - 4.3:
        add(drums, t, kick() * (0.55 + 0.45 * intro_level if pre else (0.85 if build else 1.0)))
    if not pre and b % 2 == 1 and not build:
        add(drums, t, clap())
    if not pre and build and b % 4 == 3:
        add(drums, t, clap() * 0.7)
    for k in range(2 if pre else 4):    # hats: 8ths in the intro, 16ths after
        tt = t + k * BEAT / (2 if pre else 4)
        add(drums, tt, hat(open_=(k == 2 and not pre)) * (0.5 + 0.5 * intro_level) * (1.0 if k % 2 else 0.7))
    # bass: 8th notes on the chord root, ducked right after each kick
    for k in range(2):
        tt = t + k * BEAT / 2
        f = hz(root - 12 + (12 if k == 1 and not pre else 0))
        s = tone(f, BEAT / 2 * 0.95, (1, 2, 3, 4), (1, .45, .25, .12), a=0.03 if k == 0 else 0.006, r=0.18)
        add(bass, tt, s * (0.35 + 0.25 * intro_level if pre else 0.62))
    # chord stabs on the off-beat after the drop
    if not pre:
        for m in chord:
            add(keys, t + BEAT / 2, tone(hz(m + 12), 0.22, (1, 2, 3), (1, .3, .12), r=0.09) * 0.16)
    # arp: 16ths over the chord, quiet; brighter after the drop
    pattern = [0, 1, 2, 1]
    for k in range(4):
        m = chord[pattern[k]] + 24
        add(arp, t + k * BEAT / 4, tone(hz(m), 0.2, (1, 2), (1, .2), r=0.07) * (0.05 + 0.04 * intro_level if pre else 0.09))

# pad: the chords held, swelling, through the whole film and the closing graphic
bar = 4 * BEAT
for k in range(int((TOTAL - grid0) / bar) + 2):
    t0 = grid0 + (k - 1) * bar
    chord, root = chord_at(t0 + 0.01)
    n = int((bar + 1.2) * SR); x = np.arange(n) / SR
    e = np.clip(x / 0.6, 0, 1) * np.clip((bar + 1.2 - x) / 0.8, 0, 1)
    s = sum(np.sin(2 * np.pi * hz(m) * x) + 0.4 * np.sin(2 * np.pi * hz(m) * 1.004 * x) for m in chord)
    level = 0.06 if t0 < HIT else (0.05 if t0 < END_MUSIC else 0.08)
    add(pad, t0, s * e * level)

# ---------- sound effects ----------
def whoosh(t, dur=0.5, level=0.22):
    n = int(dur * SR); x = np.arange(n) / SR
    noise = rng.standard_normal(n)
    # a moving band: mix of increasingly differentiated noise, swelling to the cut and away
    bright = np.sin(np.pi * x / dur)
    s = (noise * (1 - bright) * 0.3 + np.concatenate([[0], np.diff(noise)]) * bright * 0.5) * np.sin(np.pi * x / dur) ** 2
    add(sfx, t - dur * 0.6, s * level)


def impact(t, level=0.9):
    n = int(2.2 * SR); x = np.arange(n) / SR
    sub = np.sin(2 * np.pi * np.cumsum(70 * np.exp(-x * 3) + 32) / SR) * np.exp(-x * 2.2)
    crash = rng.standard_normal(n) * np.exp(-x * 3.5) * 0.25
    add(sfx, t, (sub + crash) * level)


def riser(t_end, dur=2.4, level=0.3):
    n = int(dur * SR); x = np.arange(n) / SR
    f = 200 + 1400 * (x / dur) ** 2
    s = (np.sin(2 * np.pi * np.cumsum(f) / SR) * 0.35 + np.concatenate([[0], np.diff(rng.standard_normal(n))]) * 0.4) * (x / dur) ** 2
    add(sfx, t_end - dur, s * level)


def pop_(t, level=0.08):
    n = int(0.09 * SR); x = np.arange(n) / SR
    add(sfx, t, np.sin(2 * np.pi * np.cumsum(1300 - 700 * x / 0.09) / SR) * np.exp(-x * 45) * level)


riser(HIT - 0.3)
impact(HIT, 1.0)
impact(BUILD + 0.05, 0.7); riser(BUILD + 0.02, 1.2, 0.18)
impact(OUTRO + 0.4, 0.6)
for h in EXTRA_HITS:
    impact(h + 0.05, 0.45)
impact(TAG - 0.05, 0.5)
for s in shots:
    if s['kind'] not in ('hook1', 'reveal', 'buildTitle', 'vsTitle', 'getOnline', 'deployStats', 'recap', 'outro'):
        whoosh(s['start'])
for w in ('calls', 'messages', 'follow'):
    if maybe('hook1', w) is not None:
        pop_(at('hook1', w))
for w in ('agents', 'buyers', 'sellers'):
    if maybe('hook2', w) is not None:
        pop_(at('hook2', w), 0.1)
for w in ('agents', 'buyers', 'sellers'):
    if maybe('reveal', w) is not None:
        pop_(at('reveal', w), 0.07)
for w in ('forwards', 'counter', 'accepts'):
    if maybe('offer', w) is not None:
        pop_(at('offer', w) - 0.3, 0.09)
for w in ('every', 'notifies', 'people'):
    if maybe('notify', w) is not None:
        pop_(at('notify', w), 0.07)
for w in ('gmail', 'slack', 'google'):
    if maybe('tools', w) is not None:
        pop_(at('tools', w), 0.08)
for w in ('claude', 'via', 'embarko'):
    if maybe('built', w) is not None:
        pop_(at('built', w), 0.09)
# a soft chime ringing over the closing graphic
n = int(4.0 * SR); x = np.arange(n) / SR
add(sfx, END_MUSIC - 0.1, (np.sin(2 * np.pi * 880 * x) + .5 * np.sin(2 * np.pi * 1320 * x) + .3 * np.sin(2 * np.pi * 1760 * x)) * np.exp(-x * 1.4) * 0.12)

# ---------- write stems, then shape them with ffmpeg ----------
fade_out = np.clip((TOTAL - np.arange(N + SR) / SR) / 3.0, 0, 1)
stems = {'drums': drums, 'bass': bass, 'keys': keys, 'pad': pad, 'arp': arp}
for name, buf in stems.items():
    buf *= fade_out
    raw = (buf[:N] / max(1e-6, np.abs(buf).max()) * 0.9).astype(np.float32) if name == 'drums' else buf[:N].astype(np.float32)
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'f32le', '-ar', str(SR), '-ac', '1', '-i', '-', str(OUT / f'stem-{name}.wav')], input=raw.tobytes(), check=True)
graph = ('[0]volume=0.85[d];[1]lowpass=f=900,volume=1.0[b];[2]aecho=0.7:0.6:120|240:0.3|0.2,volume=0.9[k];'
         '[3]lowpass=f=2400,aecho=0.8:0.7:300|600:0.35|0.25[p];[4]aecho=0.6:0.5:180:0.3,highpass=f=400[a];'
         '[d][b][k][p][a]amix=inputs=5:normalize=0,acompressor=threshold=-14dB:ratio=3:attack=10:release=150,alimiter=limit=0.9[o]')
subprocess.run(['ffmpeg', '-y', '-v', 'error'] + sum([['-i', str(OUT / f'stem-{n}.wav')] for n in stems], []) + ['-filter_complex', graph, '-map', '[o]', '-ac', '2', str(OUT / 'music.wav')], check=True)
sfx *= 1.0
subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'f32le', '-ar', str(SR), '-ac', '1', '-i', '-', '-af', 'aecho=0.6:0.5:90:0.25', str(OUT / 'sfx.wav')], input=sfx[:N].astype(np.float32).tobytes(), check=True)
print(f'music: {TOTAL:.1f} s, drop at {HIT:.2f} s, build hit at {BUILD:.2f} s, outro at {OUTRO:.2f} s')
