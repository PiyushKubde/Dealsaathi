"""Shared by build.py and align-voice.py: the narration lines and how their words are spelled for alignment."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Spoken forms of words the recogniser would otherwise not know or would split differently.
SPOKEN = [('dealsaathi', 'deal saathi'), ('viasocket', 'via socket'), ('ai-powered', 'a i powered'), ('back-and-forth', 'back and forth'),
          ('real-world', 'real world'), ('follow-up', 'follow up'), ('counter-offer', 'counter offer'), ('four-bedroom', 'four bedroom')]


def narration():
    """{scene id: [line, ...]} from the '> ' lines of narration.md."""
    scenes, cur = {}, None
    for line in (ROOT / 'narration.md').read_text().split('\n'):
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
