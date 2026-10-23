#!/usr/bin/env python3
"""Copies the few real excerpts the video shows out of the Claude Code session log, sanitised.

    python3 src/extract-evidence.py <session.jsonl>  ->  evidence/session-excerpts.json

Only fixed lines are read (the build prompt, the hosting prompt, and named tool calls with their output).
Tokens, e-mail addresses and claim codes are removed; the Embarko token line of the hosting prompt is dropped.
"""
import json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
log = Path(sys.argv[1]).read_text().split('\n')

def entry(n):
    return json.loads(log[n - 1])

def clean(s):
    s = re.sub(r'emb_[A-Za-z0-9]+', '[token removed]', s)
    s = re.sub(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}', '[email]', s)
    s = re.sub(r'code=[A-Za-z0-9_-]+', 'code=[removed]', s)
    return s

def user_text(n):
    o = entry(n)
    c = o['message']['content']
    return o['timestamp'], c if isinstance(c, str) else '\n'.join(x.get('text', '') for x in c if x.get('type') == 'text')

def tool(n):
    """The tool call on line n and its result."""
    o = entry(n)
    use = next(c for c in o['message']['content'] if c.get('type') == 'tool_use')
    for line in log[n:n + 40]:
        if not line:
            continue
        r = json.loads(line)
        if r.get('type') != 'user' or not isinstance(r['message'].get('content'), list):
            continue
        for c in r['message']['content']:
            if c.get('type') == 'tool_result' and c.get('tool_use_id') == use['id']:
                t = c.get('content')
                t = t if isinstance(t, str) else '\n'.join(x.get('text', '') for x in t)
                return o['timestamp'], use['input'].get('description', ''), clean(t)
    raise SystemExit(f'no result for line {n}')

ts, prompt = user_text(3)
ts_h, hosting = user_text(651)
hosting_lines = [l for l in hosting.split('\n') if 'token' not in l.lower() or 'DEPLOY_TOKEN' in l]
while hosting_lines and not hosting_lines[0].strip():
    hosting_lines.pop(0)

def pick(text, *needles):
    return [l for l in text.split('\n') if any(k in l for k in needles)]

steps = []
for n, keep in [(37, ['name: viasocket-integrations']), (83, ['"version": "0.7.0"', '"name": "viasocket-apps"']),
                (136, ['FAIL']), (142, ['PASS embed token']), (297, ['"status": "needs_info"', '"type": "create_lead"', 'DealSaathi is running']),
                (454, ['local:', 'remote:']), (615, ['building', 'live']), (665, ['building', '"status":"live"'])]:
    at, what, out = tool(n)
    lines = pick(out, *keep)
    if n in (615, 665):  # keep the poll lines and a short status, not the whole JSON
        lines = [l for l in out.split('\n') if re.match(r'^\d\d:\d\d:\d\d ', l)]
        lines.append(f'status: live · claimed: {"true" if "claimed\":true" in out else "false"} · deploy: success' if '"status":"live"' in out else '')
    steps.append({'line': n, 'at': at, 'what': what, 'output': [l.strip() for l in lines if l.strip()][:4]})

out = {
    'source': 'Claude Code session log of the DealSaathi build (JSONL transcript), lines as cited',
    'buildPrompt': {'line': 3, 'at': ts, 'characters': len(prompt), 'excerpt': clean(prompt[:1400])},
    'hostingPrompt': {'line': 651, 'at': ts_h, 'lines': [clean(l) for l in hosting_lines], 'note': 'first line (the Embarko deploy token) removed'},
    'steps': steps,
}
(ROOT / 'evidence' / 'session-excerpts.json').write_text(json.dumps(out, indent=1, ensure_ascii=False))
print(json.dumps(out, indent=1, ensure_ascii=False)[:4000])
