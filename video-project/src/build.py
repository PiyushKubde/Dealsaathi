#!/usr/bin/env python3
"""Builds the DealSaathi demo video from timeline.json and narration.md with FFmpeg.

    python3 src/build.py            # full render
    python3 src/build.py --fast     # quicker, lower-quality preview (same timing)

Inputs it looks for (all optional; see README.md):
  audio/voice/scene1..5.(wav|mp3|m4a)   your narration, one file per scene -> scene lengths and captions follow it
  audio/music.(wav|mp3|m4a)             your music; otherwise a quiet temporary bed is generated
  captions/scene1..5.srt                hand-timed captions for a scene (times relative to the voice file)
  any "supplied" path in timeline.json  a real recording that replaces the placeholder or card

Output: DealSaathi-Demo.mp4 only when every voice file is present and no placeholder slate or placeholder
closing card is used; otherwise out/DealSaathi-Demo-DRAFT.mp4 with a DRAFT label. captions/captions.srt is
written either way.
"""
import json, math, re, subprocess, sys, wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FAST = '--fast' in sys.argv
TL = json.loads((ROOT / 'timeline.json').read_text())
W, H, FPS, T = TL['width'], TL['height'], TL['fps'], TL['transition']
OUT = ROOT / 'out'
SEG = OUT / 'segments'
SEG.mkdir(parents=True, exist_ok=True)
LEAD, TAIL = 0.6, 1.0  # seconds of picture before a scene's voice starts / after it ends


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
    scenes, cur = {}, None
    for line in (ROOT / 'narration.md').read_text().split('\n'):
        m = re.match(r'^## Scene (\d+)', line)
        if m:
            cur = int(m.group(1))
            scenes[cur] = []
        elif cur and line.startswith('> '):
            scenes[cur].append(line[2:].strip())
    return scenes


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
lines_by_scene = narration()
plan, draft_reasons = [], []
t = 0.0
for sc in TL['scenes']:
    sid = sc['id']
    voice = find(f'audio/voice/scene{sid}')
    planned = sum(s['dur'] for s in sc['segments'])
    target = duration(voice) + LEAD + TAIL if voice else planned
    k = target / planned
    if not voice:
        draft_reasons.append(f'no voice for scene {sid}')
    segs = []
    for s in sc['segments']:
        s = dict(s, dur=s['dur'] * k, _planned=s['dur'])
        sup = ROOT / s['supplied'] if s.get('supplied') else None
        if sup and sup.exists():
            s = dict(s, type='closing' if s['type'] == 'closing' else ('still' if sup.suffix.lower() in ('.png', '.jpg', '.jpeg') else 'supplied'), src=s['supplied'])
        elif s['type'] == 'closing':
            draft_reasons.append('placeholder closing card (no assets/supplied/closing.png)')
        if '/m0' in s['src'] and s['type'] == 'card':
            draft_reasons.append(f'placeholder slate {Path(s["src"]).name}')
        segs.append(s)
    plan.append({'id': sid, 'start': t, 'length': target, 'voice': voice, 'segments': segs})
    t += target
TOTAL = t
draft = bool(draft_reasons)
print(f'plan: {TOTAL:.1f} s total' + ''.join(f'\n  scene {p["id"]}: {p["start"]:6.1f}–{p["start"] + p["length"]:6.1f} s  voice: {p["voice"].name if p["voice"] else "none (temporary timing)"}' for p in plan))


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
        else:  # a supplied graphic: keep its proportions, centre it on the closing background
            base = f'[0:v]scale={W}:{H}:force_original_aspect_ratio=decrease:flags=lanczos,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=0x04261d,trim=duration={d:.3f},setpts=PTS-STARTPTS'
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
video = OUT / 'video.mp4'
args = ['ffmpeg', '-y', '-loglevel', 'error']
for f in files:
    args += ['-i', str(f)]
graph, last = '', '0:v'
for i in range(1, len(files)):
    graph += f'[{last}][{i}:v]xfade=transition=fade:duration={T}:offset={offsets[i]:.3f}[x{i}];'
    last = f'x{i}'
args += ['-filter_complex', graph.rstrip(';'), '-map', f'[{last}]', '-c:v', 'libx264', '-preset', 'ultrafast' if FAST else 'fast', '-crf', '24' if FAST else '15', '-pix_fmt', 'yuv420p', '-r', str(FPS), str(video)]
run(args)

# ---------- captions ----------
cues = []
for p in plan:
    sid, lines = p['id'], lines_by_scene.get(p['id'], [])
    manual = ROOT / f'captions/scene{sid}.srt'
    v0 = p['start'] + LEAD
    if manual.exists():
        cues += [(v0 + a, v0 + b, txt) for a, b, txt in parse_srt(manual)]
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
(ROOT / 'captions').mkdir(exist_ok=True)
(ROOT / 'captions/captions.srt').write_text(srt)
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
    mix = pad / np.abs(pad).max() * 0.55 + pluck / np.abs(pluck).max() * 0.22
    fade = np.clip(tt / 2.5, 0, 1) * np.clip((TOTAL - tt) / 4.0, 0, 1)
    mix = (mix * fade * 0.6 * 32767).astype(np.int16)
    with wave.open(str(music), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes(mix.tobytes())
    print('music: generated a temporary bed (audio/music-temp.wav); add audio/music.* to use your own')

audio = OUT / 'audio.m4a'
args = ['ffmpeg', '-y', '-loglevel', 'error', '-i', str(music)]
voices = [p for p in plan if p['voice']]
for p in voices:
    args += ['-i', str(p['voice'])]
music_chain = f'[0:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:{TOTAL:.3f},afade=t=out:st={max(0, TOTAL - 4):.3f}:d=4,volume={0.16 if voices else 0.30}[m]'
if voices:
    parts = [music_chain]
    for i, p in enumerate(voices):
        ms = int((p['start'] + LEAD) * 1000)
        parts.append(f'[{i + 1}:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay={ms}|{ms}[v{i}]')
    parts.append(''.join(f'[v{i}]' for i in range(len(voices))) + f'amix=inputs={len(voices)}:normalize=0,apad=whole_dur={TOTAL:.3f},asplit=2[vo][sc]')
    parts.append('[m][sc]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=400[md]')
    parts.append('[vo][md]amix=inputs=2:weights=1 1:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[a]')
else:
    parts = [music_chain, '[m]loudnorm=I=-26:TP=-3[a]']
args += ['-filter_complex', ';'.join(parts), '-map', '[a]', '-t', f'{TOTAL:.3f}', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', str(audio)]
run(args)

# ---------- final ----------
final = OUT / 'DealSaathi-Demo-DRAFT.mp4' if draft else ROOT / 'DealSaathi-Demo.mp4'
vf = f"subtitles=filename='{ROOT / 'captions/captions.srt'}':fontsdir=/usr/share/fonts/opentype/inter:force_style='{style}'"
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
