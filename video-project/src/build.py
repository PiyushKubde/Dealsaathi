#!/usr/bin/env python3
"""Builds the DealSaathi demo video from timeline.json and narration.md with FFmpeg.

    python3 src/build.py            # full render
    python3 src/build.py --fast     # quicker, lower-quality preview (same timing)
    python3 src/build.py --plan     # print the timing only
    python3 src/build.py --audio-only   # re-mix the sound over the last render's picture (same timing)
    python3 src/build.py --cut launch   # the launch cut: narration-launch.md + timeline-launch.json

Inputs it looks for (all optional; see README.md):
  audio/voice/scene1..5.(wav|mp3|m4a)   your narration, one file per scene -> scene lengths and captions follow it
  audio/music.(wav|mp3|m4a)             your music; otherwise a quiet temporary bed is generated
  captions/scene1..5.words.json         word timings from src/align-voice.py -> each sentence is placed with a
                                        short breath after it, visuals with a "cue" start on that phrase, and
                                        captions follow the words
  captions/scene1..5.srt                hand-timed captions for a scene (times relative to the voice file)
  any "supplied" path in timeline.json  a real recording that replaces the placeholder or card

Output: DealSaathi-Demo.mp4 only when every voice file is present and no placeholder slate or placeholder
closing card is used; otherwise out/DealSaathi-Demo-DRAFT.mp4 with a DRAFT label. captions/captions.srt is
written either way.
"""
import json, math, re, subprocess, sys, wave
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from narr import spoken_words, TIMELINE, VOICE, CAPTIONS, NAME, CUT, loudness, quiet_point

ROOT = Path(__file__).resolve().parent.parent
FAST = '--fast' in sys.argv
TL = json.loads(TIMELINE.read_text())
W, H, FPS, T = TL['width'], TL['height'], TL['fps'], TL['transition']
OUT = ROOT / 'out'
SEG = OUT / 'segments'
SEG.mkdir(parents=True, exist_ok=True)
LEAD, TAIL = 0.6, 1.0  # seconds of picture before a scene's voice starts / after it ends
GAP = TL.get('line_gap', 0.8)  # breath added after each sentence when word timings exist


def run(args):
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode:
        sys.exit(f'ffmpeg failed: {" ".join(map(str, args))[:400]}\n{r.stderr[-2500:]}')
    return r.stdout


def duration(path):
    return float(run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)]).strip())


def find(stem):
    for ext in ('.wav', '.mp3', '.m4a', '.aac', '.flac'):
        p = ROOT / f'{stem}{ext}'
        if p.exists():
            return p
    return None


# ---------- narration ----------
def narration():
    from narr import narration as n
    return n()


def chunks(text, limit=84):
    """Splits a narration line into captions of at most ~two 42-character lines: whole sentences or clauses
    where they fit, long ones cut into balanced pieces."""
    clauses = [c.strip() for c in re.findall(r'[^.?!,;:]+[.?!,;:]*', text) if c.strip()]
    out, cur = [], ''
    for c in clauses:
        if not cur:
            cur = c
        elif len(cur) + 1 + len(c) <= limit and not cur.endswith(('.', '?', '!')):
            cur = f'{cur} {c}'
        else:
            out.append(cur)
            cur = c
    if cur:
        out.append(cur)
    final = []
    for c in out:
        if len(c) <= limit:
            final.append(c)
            continue
        words, n = c.split(), math.ceil(len(c) / limit)
        size = len(c) / n
        piece = ''
        for w in words:
            if piece and len(piece) >= size * 0.92 and len(final) >= 0 and len(piece) + len(w) > size:
                final.append(piece)
                piece = w
            else:
                piece = f'{piece} {w}'.strip()
        final.append(piece)
    # never leave a short orphan: fold it into its neighbour when the two still fit
    merged = []
    for c in final:
        if merged and (len(c) < 22 or len(merged[-1]) < 22) and len(merged[-1]) + 1 + len(c) <= limit + 8:
            merged[-1] = f'{merged[-1]} {c}'
        else:
            merged.append(c)
    return merged


def wrap2(text, width=44):
    if len(text) <= width:
        return text
    words, best = text.split(), None
    for i in range(1, len(words)):
        a, b = ' '.join(words[:i]), ' '.join(words[i:])
        score = max(len(a), len(b))
        if a.count('"') % 2 or any(a.endswith(x) for x in ('Claude', 'ViaSocket', 'Google', 'AI-powered', 'the', 'a', 'an')):
            score += 30  # do not break inside a quote, a product name or after an article
        if best is None or score < best[0]:
            best = (score, a, b)
    return f'{best[1]}\n{best[2]}'


def srt_time(t):
    ms = int(round(t * 1000))
    return f'{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}'


def parse_srt(path):
    items = []
    for block in re.split(r'\n\s*\n', path.read_text().strip()):
        lines = block.strip().split('\n')
        m = re.match(r'(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)', lines[1] if len(lines) > 1 else '')
        if not m:
            continue
        g = list(map(int, m.groups()))
        items.append((g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000, g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000, '\n'.join(lines[2:])))
    return items


# ---------- plan ----------
def line_layout(sid, voice, breaks):
    """With captions/scene<N>.words.json: the take cut into pieces at each sentence (and at any phrase in
    the scene's "breaks"), placed with a breath after each, and every word's time in the scene.
    None without word timings."""
    wj = ROOT / f'{CAPTIONS}/scene{sid}.words.json'
    if not voice or not wj.exists():
        return None
    words = json.loads(wj.read_text())['words']
    vd = duration(voice)
    seq = [w['word'] for w in words]
    pause_before = {i: GAP for i in range(1, len(words)) if words[i]['line'] != words[i - 1]['line']}
    for phrase, sec in breaks.items():
        want = spoken_words(phrase)
        hit = next((i for i in range(1, len(seq) - len(want) + 1) if seq[i:i + len(want)] == want), None)
        if hit is None:
            sys.exit(f'break "{phrase}" is not in the narration of scene {sid}')
        pause_before[hit] = max(pause_before.get(hit, 0), sec)
    starts = sorted(pause_before)
    db = loudness(voice)  # cut in the quiet between words, not at a guessed midpoint
    cuts = [0.0] + [quiet_point(db, words[i - 1]['end'] - 0.3, words[i]['start'] + 0.3) or (words[i - 1]['end'] + words[i]['start']) / 2 for i in starts] + [vd]
    first = [0] + starts
    pieces, at = [], LEAD
    for k in range(len(first)):
        pieces.append((cuts[k], cuts[k + 1], at))
        at += cuts[k + 1] - cuts[k] + (pause_before[first[k + 1]] if k + 1 < len(first) else 0)
    timed = []
    for i, w in enumerate(words):
        k = max(j for j in range(len(first)) if first[j] <= i)
        a, _, p0 = pieces[k]
        timed.append(dict(w, s=p0 + w['start'] - a, e=p0 + w['end'] - a))
    return {'pieces': pieces, 'voice_end': at, 'words': timed}


def cue_time(words, phrase):
    want, seq = spoken_words(phrase), [w['word'] for w in words]
    for i in range(len(seq) - len(want) + 1):
        if seq[i:i + len(want)] == want:
            return words[i]['s']
    sys.exit(f'cue "{phrase}" is not in the narration of this scene')


lines_by_scene = narration()
plan, draft_reasons = [], []
t = 0.0
for sc in TL['scenes']:
    sid = sc['id']
    voice = find(f'{VOICE}/scene{sid}')
    layout = line_layout(sid, voice, sc.get('breaks', {}))
    planned = sum(s['dur'] for s in sc['segments'])
    if layout:
        target = layout['voice_end'] + TAIL + sc.get('hold', 0)
    else:
        target = duration(voice) + LEAD + TAIL if voice else planned
    k = target / planned
    if not voice:
        draft_reasons.append(f'no voice for scene {sid}')
    segs = []
    for s in sc['segments']:
        s = dict(s, dur=s['dur'] * k, _planned=s['dur'])
        sup = None
        if s.get('supplied'):  # a recording, or a screenshot with the same name (.png/.jpg)
            base = ROOT / s['supplied']
            sup = next((c for c in [base] + [base.with_suffix(x) for x in ('.mp4', '.mov', '.webm', '.png', '.jpg', '.jpeg')] if c.exists()), None)
            if sup:
                s = dict(s, supplied=str(sup.relative_to(ROOT)))
        if sup:
            s = dict(s, type='closing' if s['type'] == 'closing' else ('still' if sup.suffix.lower() in ('.png', '.jpg', '.jpeg') else 'supplied'), src=s['supplied'])
        elif s['type'] == 'closing':
            s = dict(s, type='card')  # the closing card built from the official logo files
        if '/m0' in s['src'] and s['type'] == 'card':
            draft_reasons.append(f'placeholder slate {Path(s["src"]).name}')
        segs.append(s)
    if layout and any(s.get('cue') for s in segs[1:]):
        # Segments with a cue start just before that phrase is said; the others share the time in between
        # in proportion to their planned lengths.
        n = len(segs)
        bound = [0.0] + [None] * (n - 1) + [target]
        for j in range(1, n):
            if segs[j].get('cue'):
                bound[j] = max(0.5, cue_time(layout['words'], segs[j]['cue']) - 0.35)
        j = 0
        while j < n:
            m = next(i for i in range(j + 1, n + 1) if bound[i] is not None)
            span_planned = sum(s['_planned'] for s in segs[j:m])
            for i in range(j + 1, m):
                bound[i] = bound[i - 1] + (bound[m] - bound[j]) * segs[i - 1]['_planned'] / span_planned
            j = m
        for j, s in enumerate(segs):
            s['dur'] = bound[j + 1] - bound[j]
            if s['dur'] < 1.2:
                sys.exit(f'scene {sid}: segment {j} ({Path(s["src"]).name}) would last {s["dur"]:.2f} s; move its cue or the one after it')
    plan.append({'id': sid, 'start': t, 'length': target, 'voice': voice, 'layout': layout, 'segments': segs})
    t += target
TOTAL = t
draft = bool(draft_reasons)
print(f'plan: {TOTAL:.1f} s total' + ''.join(f'\n  scene {p["id"]}: {p["start"]:6.1f}–{p["start"] + p["length"]:6.1f} s  voice: {(p["voice"].name + (" (sentences placed from word timings)" if p["layout"] else "")) if p["voice"] else "none (temporary timing)"}' for p in plan))


if '--mark-rendered' in sys.argv:  # the picture in out/video.mp4 was rendered from this exact timing
    (OUT / 'video.json').write_text(json.dumps({'cut': NAME, 'total': round(TOTAL, 3), 'segments': [[str(s['src']), round(s['dur'], 3)] for p in plan for s in p['segments']]}))
    sys.exit(0)
if '--plan' in sys.argv:  # print the scene and segment timing only
    for p in plan:
        for s in p['segments']:
            print(f'    scene {p["id"]} {Path(s["src"]).name:34} {s["dur"]:5.2f} s{"  cue: " + s["cue"] if s.get("cue") else ""}')
    sys.exit(0)


# ---------- segments ----------
def zoom_filter(z0, z1, d):
    """Slow centred zoom from z0 to z1 over d seconds, drawn at 2× then scaled down so it stays smooth."""
    if abs(z1 - z0) < 1e-6 and abs(z0 - 1) < 1e-6:
        return f'scale={W}:{H}:flags=lanczos'
    return (f"scale={W * 2}:{H * 2}:flags=lanczos,"
            f"zoompan=z='{z0}+({z1}-{z0})*on/{max(1, int(d * FPS))}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={W}x{H}:fps={FPS}")


def render_segment(i, s, d):
    out = SEG / f'{i:02}.mp4'
    z0, z1 = s.get('zoom', [1.0, 1.0])
    args = ['ffmpeg', '-y', '-loglevel', 'error']
    if s['type'] in ('card', 'still', 'closing'):
        if s['type'] == 'card':
            base = f'[0:v]{zoom_filter(z0, z1, d)},trim=duration={d:.3f},setpts=PTS-STARTPTS'
        elif s['type'] == 'still':  # a screenshot: optional close-up crop, shown whole over a blurred copy of itself
            cx, cy, cw, ch = s.get('crop', [0, 0, 1, 1])
            crop = f"crop=iw*{cw}:ih*{ch}:iw*{cx}:ih*{cy}," if s.get('crop') else ''
            base = (f'[0:v]{crop}format=rgb24,split[fg][bg];[bg]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},boxblur=40:2,eq=brightness=-0.06[bb];'
                    f'[fg]scale={W}:{H}:force_original_aspect_ratio=decrease:flags=lanczos[ff];[bb][ff]overlay=(W-w)/2:(H-h)/2,{zoom_filter(z0, z1, d)},trim=duration={d:.3f},setpts=PTS-STARTPTS')
        else:  # the supplied closing graphic: proportions kept, centred on the closing background
            base = f'[0:v]scale={W}:{H}:force_original_aspect_ratio=decrease:flags=lanczos,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=0xf7f5ef,trim=duration={d:.3f},setpts=PTS-STARTPTS'
        args += ['-loop', '1', '-framerate', str(FPS), '-t', f'{d:.3f}', '-i', str(ROOT / s['src'])]
    elif s['type'] == 'supplied':  # a user recording: fitted to the slot by speed, never cropped
        src_d = duration(ROOT / s['src'])
        sp = src_d / d
        args += ['-i', str(ROOT / s['src'])]
        base = f'[0:v]setpts=PTS/{sp:.4f},fps={FPS},scale={W}:{H}:force_original_aspect_ratio=decrease:flags=lanczos,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black,trim=duration={d:.3f},setpts=PTS-STARTPTS'
    else:  # clip with an optional real-speed tail
        a, b = s['src_in'], s['src_out']
        tail = min(s.get('tail', 0), b - a, d * 0.9)
        fast_src, fast_out = (b - a) - tail, d - tail
        sp = fast_src / fast_out if fast_out > 0.05 and fast_src > 0 else 1
        args += ['-i', str(ROOT / s['src'])]
        parts = []
        if fast_src > 0.05:
            parts.append(f'[0:v]trim={a:.3f}:{b - tail:.3f},setpts=(PTS-STARTPTS)/{sp:.4f}[p0]')
        parts.append(f'[0:v]trim={b - tail:.3f}:{b:.3f},setpts=PTS-STARTPTS[p1]')
        cat = f'{"[p0]" if fast_src > 0.05 else ""}[p1]concat=n={2 if fast_src > 0.05 else 1}:v=1:a=0,fps={FPS},tpad=stop_mode=clone:stop_duration=30'
        zoom = '' if abs(z1 - z0) < 1e-6 and z0 == 1 else f",scale=w='{W}*({z0}+({z1}-{z0})*t/{d:.3f})':h=-2:eval=frame:flags=bicubic,crop={W}:{H}"
        base = ';'.join(parts) + f';{cat}{zoom},scale={W}:{H},trim=duration={d:.3f},setpts=PTS-STARTPTS'
    graph, last = base + '[b]', 'b'
    for j, (png, a, b) in enumerate(s.get('overlays', [])):
        kf = s['dur'] / s['_planned']  # overlay times are written against the planned length
        a, b = a * kf, min(b * kf, d)
        args += ['-loop', '1', '-framerate', str(FPS), '-t', f'{d:.3f}', '-i', str(ROOT / png)]
        n = 1 + j
        graph += (f';[{n}:v]format=rgba,fade=in:st={a:.3f}:d=0.35:alpha=1,fade=out:st={max(a, b - 0.35):.3f}:d=0.35:alpha=1[o{j}]'
                  f';[{last}][o{j}]overlay=0:0:shortest=1[v{j}]')
        last = f'v{j}'
    args += ['-filter_complex', graph, '-map', f'[{last}]', '-t', f'{d:.3f}', '-r', str(FPS), '-an',
             '-c:v', 'libx264', '-preset', 'ultrafast' if FAST else 'fast', '-crf', '24' if FAST else '15', '-pix_fmt', 'yuv420p', str(out)]
    run(args)
    return out


video = OUT / 'video.mp4'
stamp = OUT / 'video.json'
want = {'cut': NAME, 'total': round(TOTAL, 3), 'segments': [[str(s['src']), round(s['dur'], 3)] for p in plan for s in p['segments']]}
# --audio-only: keep the picture from the last render when its timing is unchanged (for music or voice tweaks)
reuse = '--audio-only' in sys.argv and video.exists() and stamp.exists() and json.loads(stamp.read_text()) == want
if '--audio-only' in sys.argv and not reuse:
    print('picture timing changed (or no earlier render): rendering the picture too')
if not reuse:
    flat = []
    for p in plan:
        for s in p['segments']:
            flat.append(s)
    files, offsets, acc = [], [], 0.0
    for i, s in enumerate(flat):
        last = i == len(flat) - 1
        d = s['dur'] + (0 if last else T)  # each segment runs T longer so the cross-fade does not eat its time
        print(f'  segment {i:02} {s["type"]:8} {Path(s["src"]).name:34} {s["dur"]:5.2f} s')
        files.append(render_segment(i, s, d))
        offsets.append(acc)
        acc += s['dur']

    # ---------- join with cross-fades ----------
    args = ['ffmpeg', '-y', '-loglevel', 'error']
    for f in files:
        args += ['-i', str(f)]
    graph, last = '', '0:v'
    for i in range(1, len(files)):
        graph += f'[{last}][{i}:v]xfade=transition=fade:duration={T}:offset={offsets[i]:.3f}[x{i}];'
        last = f'x{i}'
    args += ['-filter_complex', graph.rstrip(';'), '-map', f'[{last}]', '-c:v', 'libx264', '-preset', 'ultrafast' if FAST else 'fast', '-crf', '24' if FAST else '15', '-pix_fmt', 'yuv420p', '-r', str(FPS), str(video)]
    run(args)

    stamp.write_text(json.dumps(want))

# ---------- captions ----------
cues = []
for p in plan:
    sid, lines = p['id'], lines_by_scene.get(p['id'], [])
    manual = ROOT / f'{CAPTIONS}/scene{sid}.srt'
    v0 = p['start'] + LEAD
    if manual.exists():
        cues += [(v0 + a, v0 + b, txt) for a, b, txt in parse_srt(manual)]
        continue
    if p['layout']:  # each caption runs from its first word to its last
        words, i, scene_cues = p['layout']['words'], 0, []
        for li, line in enumerate(lines):
            for c in chunks(line):
                n = len(spoken_words(c))
                ws = words[i:i + n]
                i += n
                scene_cues.append([p['start'] + ws[0]['s'] - 0.08, p['start'] + ws[-1]['e'] + 0.45, wrap2(c)])
        for a, b in zip(scene_cues, scene_cues[1:]):
            a[1] = min(a[1], b[0] - 0.06)
        cues += [tuple(c) for c in scene_cues]
        continue
    window = (p['length'] - LEAD - TAIL) if p['voice'] else p['length'] - LEAD - 0.8
    caps = [c for line in lines for c in chunks(line)]
    weight = [len(c) + 12 for c in caps]  # a little per-caption overhead for pauses
    tt = v0
    for c, w in zip(caps, weight):
        d = window * w / sum(weight)
        cues.append((tt, tt + d - 0.12, wrap2(c)))
        tt += d
srt = '\n'.join(f'{i + 1}\n{srt_time(a)} --> {srt_time(b)}\n{txt}\n' for i, (a, b, txt) in enumerate(cues))
(ROOT / CAPTIONS).mkdir(parents=True, exist_ok=True)
(ROOT / CAPTIONS / 'captions.srt').write_text(srt)
style = ('FontName=Inter,FontSize=15,PrimaryColour=&H00FFFFFF,OutlineColour=&H66101010,BackColour=&H8C0B1410,'
         'BorderStyle=4,Outline=0,Shadow=0,MarginV=24,MarginL=60,MarginR=60,Bold=0,Spacing=0.2')

# ---------- audio ----------
music = find('audio/music')
if not music:
    music = ROOT / 'audio/music-temp.wav'
    import numpy as np
    sr, n = 48000, int((TOTAL + 2) * 48000)
    tt = np.arange(n) / sr
    hz = lambda m: 440 * 2 ** ((m - 69) / 12)
    prog = [[57, 60, 64, 67], [53, 57, 60, 64], [48, 52, 55, 59], [55, 59, 62, 66]]  # Am7 Fmaj7 Cmaj7 G(add#11)
    bar = 6.0
    pad = np.zeros(n)
    for ci in range(int(TOTAL / bar) + 2):
        chord = prog[ci % 4]
        s0 = ci * bar - 1.5
        env = np.clip((tt - s0) / 1.5, 0, 1) * np.clip((s0 + bar + 3.0 - tt) / 1.5, 0, 1)
        env = np.sin(env * np.pi / 2) ** 2
        for m in chord:
            f = hz(m)
            pad += env * (np.sin(2 * np.pi * f * tt) + 0.25 * np.sin(2 * np.pi * 2 * f * tt + 0.3) + 0.5 * np.sin(2 * np.pi * (f * 1.003) * tt))
        bass = hz(chord[0] - 12)
        pad += 1.4 * env * np.sin(2 * np.pi * bass * tt)
    pluck = np.zeros(n)
    step = 60 / 92 / 2
    for k in range(int(TOTAL / step)):
        chord = prog[int(k * step / bar) % 4]
        m = chord[[0, 2, 1, 3, 2, 1, 3, 2][k % 8]] + 12
        s0 = int(k * step * sr)
        ln = int(0.9 * sr)
        if s0 + ln >= n:
            break
        x = np.arange(ln) / sr
        pluck[s0:s0 + ln] += np.exp(-x * 5.5) * np.sin(2 * np.pi * hz(m) * x) * (0.55 if k % 2 else 0.75)
    beat = 60 / 92
    kick = np.zeros(n)
    shaker = np.zeros(n)
    rng = np.random.default_rng(7)
    for k in range(int(TOTAL / beat)):
        s0 = int(k * beat * sr)
        ln = int(0.35 * sr)
        if s0 + ln >= n:
            break
        x = np.arange(ln) / sr
        if k % 2 == 0:  # a soft kick on beats 1 and 3
            kick[s0:s0 + ln] += np.sin(2 * np.pi * (48 * x + 70 * (1 - np.exp(-x * 30)) / 30)) * np.exp(-x * 9)
        h0 = s0 + int(beat / 2 * sr)  # a light shaker on the off-beats
        hl = int(0.08 * sr)
        if h0 + hl < n:
            noise = np.diff(rng.standard_normal(hl + 1))
            shaker[h0:h0 + hl] += noise * np.exp(-np.arange(hl) / sr * 45)
    chime = np.zeros(n)
    for p in plan[1:]:  # a gentle chime where each scene starts
        s0 = int(max(0, p['start'] - 0.15) * sr)
        ln = int(2.2 * sr)
        x = np.arange(min(ln, n - s0)) / sr
        chime[s0:s0 + len(x)] += (np.sin(2 * np.pi * 880 * x) + 0.5 * np.sin(2 * np.pi * 1320 * x) + 0.25 * np.sin(2 * np.pi * 1760 * x)) * np.exp(-x * 2.2) * np.clip(x / 0.01, 0, 1)
    intro = np.clip(tt / 6.0, 0.35, 1)  # the beat builds in over the first seconds
    mix = (pad / np.abs(pad).max() * 0.50 + pluck / np.abs(pluck).max() * 0.24 + kick / np.abs(kick).max() * 0.30 * intro
           + shaker / np.abs(shaker).max() * 0.07 * intro + (chime / np.abs(chime).max() * 0.22 if chime.any() else 0))
    fade = np.clip(tt / 2.5, 0, 1) * np.clip((TOTAL - tt) / 4.0, 0, 1)
    mix = (mix * fade * 0.6 * 32767).astype(np.int16)
    with wave.open(str(music), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes(mix.tobytes())
    print('music: generated a temporary bed (audio/music-temp.wav); add audio/music.* to use your own')

# Each scene's voice as one track that starts with the scene: sentences placed per the layout, else the
# whole file after LEAD. The gaps between sentences are filled with the recording's own room tone (its
# quietest stretch, looped), so the background never drops to dead silence; cuts fade over 0.1-0.15 s; then
# one gentle chain runs over the whole track: rumble and hiss filters, light denoise, a little warmth and
# presence, soft compression and a de-esser.
CLEAN = ('highpass=f=70,lowpass=f=14000,afftdn=nf=-45:nr=6,equalizer=f=250:t=q:w=1.2:g=-2,equalizer=f=4000:t=q:w=1.5:g=1.5,'
         'acompressor=threshold=-20dB:ratio=2:attack=15:release=250:makeup=1.5,deesser=i=0.3')
for p in plan:
    if not p['voice']:
        continue
    track = OUT / f'voice-scene{p["id"]}.wav'
    if p['layout']:
        import numpy as np
        db = loudness(p['voice'])
        win = 60  # 0.6 s of room tone, from the quietest part of the take
        means = np.convolve(db, np.ones(win) / win, 'valid')
        r0 = int(np.argmin(means)) / 100
        n = len(p['layout']['pieces'])
        parts = [f'[0:a]aformat=sample_rates=48000:channel_layouts=mono,asplit={n + 1}' + ''.join(f'[c{i}]' for i in range(n + 1))]
        parts.append(f'[c{n}]atrim={r0:.3f}:{r0 + win / 100:.3f},asetpts=PTS-STARTPTS,afade=t=in:d=0.05,afade=t=out:st={win / 100 - 0.05:.3f}:d=0.05,'
                     f'aloop=loop=-1:size={int(win / 100 * 48000)},atrim=0:{p["length"]:.3f},volume=0.8[room]')
        for i, (a, b, at) in enumerate(p['layout']['pieces']):
            ms = int(at * 1000)
            parts.append(f'[c{i}]atrim={a:.3f}:{b:.3f},asetpts=PTS-STARTPTS,afade=t=in:d=0.10,afade=t=out:st={max(0, b - a - 0.14):.3f}:d=0.14,adelay={ms}[p{i}]')
        parts.append('[room]' + ''.join(f'[p{i}]' for i in range(n)) + f'amix=inputs={n + 1}:normalize=0,apad=whole_dur={p["length"]:.3f},{CLEAN},afade=t=in:d=0.3,afade=t=out:st={max(0, p["length"] - 0.4):.3f}:d=0.4[o]')
    else:
        ms = int(LEAD * 1000)
        parts = [f'[0:a]aformat=sample_rates=48000:channel_layouts=mono,{CLEAN},adelay={ms},apad=whole_dur={p["length"]:.3f}[o]']
    run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(p['voice']), '-filter_complex', ';'.join(parts), '-map', '[o]', '-t', f'{p["length"]:.3f}', '-ar', '48000', str(track)])
    p['track'] = track

audio = OUT / 'audio.m4a'
args = ['ffmpeg', '-y', '-loglevel', 'error', '-i', str(music)]
voices = [p for p in plan if p['voice']]
for p in voices:
    args += ['-i', str(p['track'])]
music_chain = f'[0:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:{TOTAL:.3f},afade=t=out:st={max(0, TOTAL - 4):.3f}:d=4,volume={0.6 if voices else 0.30}[m]'
if voices:
    parts = [music_chain]
    for i, p in enumerate(voices):
        ms = int(p['start'] * 1000)
        parts.append(f'[{i + 1}:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay={ms}|{ms}[v{i}]')
    parts.append(''.join(f'[v{i}]' for i in range(len(voices))) + f'amix=inputs={len(voices)}:normalize=0,apad=whole_dur={TOTAL:.3f},asplit=2[vo][sc]')
    parts.append('[m][sc]sidechaincompress=threshold=0.02:ratio=7:attack=35:release=500[md]')  # the music steps back while you speak and returns in the pauses
    parts.append('[vo][md]amix=inputs=2:weights=1 1:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[a]')
else:
    parts = [music_chain, '[m]loudnorm=I=-26:TP=-3[a]']
args += ['-filter_complex', ';'.join(parts), '-map', '[a]', '-t', f'{TOTAL:.3f}', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', str(audio)]
run(args)

# ---------- final ----------
final = OUT / f'{NAME}-DRAFT.mp4' if draft else ROOT / f'{NAME}.mp4'
vf = f"subtitles=filename='{ROOT / CAPTIONS / 'captions.srt'}':fontsdir=/usr/share/fonts/opentype/inter:force_style='{style}'"
args = ['ffmpeg', '-y', '-loglevel', 'error', '-i', str(video), '-i', str(audio)]
if draft:
    args += ['-loop', '1', '-framerate', str(FPS), '-i', str(ROOT / 'assets/overlays/o-draft.png')]
    fc = f'[0:v]{vf}[s];[s][2:v]overlay=0:0:shortest=1,format=yuv420p[v]'
else:
    fc = f'[0:v]{vf},format=yuv420p[v]'
args += ['-filter_complex', fc, '-map', '[v]', '-map', '1:a', '-t', f'{TOTAL:.3f}', '-r', str(FPS),
         '-c:v', 'libx264', '-preset', 'veryfast' if FAST else 'slow', '-crf', '23' if FAST else '18', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
         '-c:a', 'copy', '-movflags', '+faststart', str(final)]
run(args)
print(f'\nwrote {final.relative_to(ROOT)} ({duration(final):.2f} s)')
if draft:
    print('DRAFT, because: ' + '; '.join(dict.fromkeys(draft_reasons)))
