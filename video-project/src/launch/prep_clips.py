#!/usr/bin/env python3
"""Extracts the launch film's source footage as 30 fps JPEG frames (out/launch/clips/<name>/f00001.jpg...)."""
import json, subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
clips = {k: v for k, v in json.loads((ROOT / 'src/launch/clips.json').read_text()).items() if not k.startswith('_')}
for name, (src, a, b, crop) in clips.items():
    out = ROOT / 'out/launch/clips' / name
    out.mkdir(parents=True, exist_ok=True)
    for f in out.glob('*.jpg'):
        f.unlink()
    vf = (f'crop={crop},' if crop else '') + 'scale=1920:-2:flags=lanczos,fps=30'
    subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(a), '-to', str(b), '-i', str(ROOT / src), '-vf', vf, '-q:v', '3', str(out / 'f%05d.jpg')], check=True)
    print(f'{name:9} {len(list(out.glob("*.jpg"))):4} frames')
