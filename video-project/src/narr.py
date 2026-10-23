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
