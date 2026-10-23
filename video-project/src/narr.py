"""Shared by build.py and align-voice.py: the narration lines and how their words are spelled for alignment."""
import re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Which cut: the default walkthrough (narration.md, timeline.json) or a named one, e.g. --cut launch
# (narration-launch.md, timeline-launch.json, audio/voice/launch/, captions/launch/).
CUT = sys.argv[sys.argv.index('--cut') + 1] if '--cut' in sys.argv else ''
NARRATION = ROOT / (f'narration-{CUT}.md' if CUT else 'narration.md')
TIMELINE = ROOT / (f'timeline-{CUT}.json' if CUT else 'timeline.json')
VOICE = f'audio/voice/{CUT}' if CUT else 'audio/voice'
CAPTIONS = f'captions/{CUT}' if CUT else 'captions'
NAME = f'DealSaathi-{CUT.capitalize()}' if CUT else 'DealSaathi-Demo'

# Spoken forms of words the recogniser would otherwise not know or would split differently.
SPOKEN = [('dealsaathi', 'deal saathi'), ('viasocket', 'via socket'), ('ai-powered', 'a i powered'), ('back-and-forth', 'back and forth'),
          ('real-world', 'real world'), ('follow-up', 'follow up'), ('counter-offer', 'counter offer'), ('four-bedroom', 'four bedroom')]


def narration():
    """{scene id: [line, ...]} from the '> ' lines of the narration file."""
    scenes, cur = {}, None
    for line in NARRATION.read_text().split('\n'):
        m = re.match(r'^## Scene (\d+)', line)
        if m:
            cur = int(m.group(1))
            scenes[cur] = []
        elif cur and line.startswith('> '):
            scenes[cur].append(line[2:].strip())
    return scenes


def spoken_words(text):
    """The words of `text` as they are said: lower case, letters only, abbreviations spelled out."""
    t = ' ' + text.lower() + ' '
    for a, b in SPOKEN:
        t = t.replace(a, b)
    t = re.sub(r'\bai\b', 'a i', t)
    t = re.sub(r'\bsdk\b', 's d k', t)
    t = re.sub(r'\burl\b', 'u r l', t)
    return re.sub(r"[^a-z' ]", ' ', t).split()


def loudness(path):
    """The recording's level in dB, one value per 10 ms (mono, 16 kHz)."""
    import subprocess, numpy as np
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], capture_output=True, check=True).stdout
    x = np.frombuffer(raw, np.int16).astype(float) / 32768
    n = len(x) // 160
    e = np.sqrt((x[:n * 160].reshape(n, 160) ** 2).mean(axis=1)) + 1e-9
    return np.convolve(20 * np.log10(e), np.ones(5) / 5, 'same')


def quiet_point(db, a, b):
    """The middle of the longest quiet stretch between a and b seconds, or the quietest moment; None if a >= b."""
    import numpy as np
    i0, i1 = max(0, int(a * 100)), min(len(db), int(b * 100))
    if i1 - i0 < 3:
        return None
    win = db[i0:i1]
    thr = float(np.percentile(db, 10)) + 12  # pauses in speech, with room for breath and room noise
    best, run = None, None
    for i, quiet in enumerate(win < thr):
        if quiet and run is None:
            run = i
        if (not quiet or i == len(win) - 1) and run is not None:
            end = i if not quiet else i + 1
            if best is None or end - run > best[1] - best[0]:
                best = (run, end)
            run = None
    if best:
        return (i0 + (best[0] + best[1]) / 2) / 100
    return (i0 + int(np.argmin(win))) / 100
