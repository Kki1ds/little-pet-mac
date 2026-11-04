#!/usr/bin/env python3
"""Re-frame an upstream 小小桌宠2 北美大豆包 clip (960x720, alpha VP9) onto the 1280x960 canvas
that characters/Grok uses, so canvas-layout.js sizes it like the other characters and puts its
feet on the shared floor line.

    python tools/restyle/gemini_reframe.py in.webm out.webm [crf]

The upstream clips show the figure 444 px tall (idle: top 199, feet 643, centre x 480) on 960x720.
Grok's 1280x960 clips show it 583 px tall with feet at 851 and centre x ~642 (canvas-layout.js
`reference` / `feetLines`). SCALE = 583/444; the pad offsets put feet and centre on those lines.
"""
import subprocess, sys

SCALE = 583 / 444
SRC_FEET, SRC_CENTER = 643, 480
OUT_FEET, OUT_CENTER, W, H = 851, 642, 1280, 960

src, dst = sys.argv[1], sys.argv[2]
crf = sys.argv[3] if len(sys.argv) > 3 else '30'
sw, sh = round(960 * SCALE), round(720 * SCALE)
x = round(OUT_CENTER - SRC_CENTER * SCALE)
y = round(OUT_FEET - SRC_FEET * SCALE)
vf = (f'format=rgba,scale={sw}:{sh}:flags=lanczos,pad={W}:{H}:{x}:{y}:color=0x00000000,'
      'format=yuva420p')
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-c:v', 'libvpx-vp9', '-i', src, '-an', '-vf', vf,
                '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-crf', crf, '-b:v', '0', '-row-mt', '1',
                '-deadline', 'good', '-cpu-used', '2', '-auto-alt-ref', '0',
                '-metadata:s:v:0', 'alpha_mode=1', dst], check=True)
