#!/usr/bin/env python3
"""Puts the launch film together: rendered frames + your voice + the soundtrack and effects.

    python3 src/launch/assemble.py   ->  DealSaathi-Launch-Film.mp4

The voice gets a gentle clean-up (rumble and hiss filters, light denoise, warmth, presence, soft
compression, de-esser); the music ducks under it; effects sit on top; the mix is mastered to -14 LUFS.
"""
import json, subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
OUT = ROOT / 'out/launch'
total = json.loads((OUT / 'plan.json').read_text())['total']
VOICE = ('highpass=f=80,lowpass=f=14000,afftdn=nf=-45:nr=6,equalizer=f=250:t=q:w=1.2:g=-2,equalizer=f=3500:t=q:w=1.4:g=2.5,'
         'acompressor=threshold=-20dB:ratio=2.5:attack=10:release=200:makeup=2,deesser=i=0.35')
graph = (f'[1:a]aformat=sample_rates=48000:channel_layouts=mono,{VOICE},aformat=channel_layouts=stereo,asplit=2[v][sc];'
         '[2:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=0.75[m];'
         '[m][sc]sidechaincompress=threshold=0.025:ratio=8:attack=25:release=400[md];'
         '[3:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=1.0[fx];'
         '[v][md][fx]amix=inputs=3:weights=1.6 1 0.9:normalize=0,loudnorm=I=-14:TP=-1.0:LRA=9[a]')
final = ROOT / 'DealSaathi-Launch-Film.mp4'
subprocess.run(['ffmpeg', '-y', '-v', 'error', '-framerate', '30', '-i', str(OUT / 'frames/f%05d.jpg'),
                '-i', str(OUT / 'voice.wav'), '-i', str(OUT / 'music.wav'), '-i', str(OUT / 'sfx.wav'),
                '-filter_complex', graph, '-map', '0:v', '-map', '[a]', '-t', f'{total:.3f}',
                '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', '30',
                '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-movflags', '+faststart', str(final)], check=True)
print(f'wrote {final.name}')
