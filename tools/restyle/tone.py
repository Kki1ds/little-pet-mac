#!/usr/bin/env python3
"""Lift the darker ojousama clips to the tone of the idle clip (待机-翻书).

The upstream clips came in two batches: one has dimmer, pinker whites and duller hair.
The curve below maps that batch's black ribbon, brown book, hair and white dress
(measured as group averages, BT.601 decode) onto the bright batch's values.

    python tools/restyle/tone.py in.webm out.webm [crf]
"""
import subprocess, sys

# (dark batch, bright batch) anchors per channel, 0-255.
CURVE = {
    'r': [(0, 0), (39, 39), (93, 93), (214, 232), (238.5, 247), (255, 255)],
    'g': [(0, 0), (25, 23), (45, 42), (111, 119), (221, 236), (255, 255)],
    'b': [(0, 0), (30, 20), (61.5, 55), (219, 231), (255, 255)],
}

src, dst = sys.argv[1], sys.argv[2]
crf = sys.argv[3] if len(sys.argv) > 3 else '20'
curves = ':'.join(f"{c}='{' '.join(f'{a / 255:.4f}/{b / 255:.4f}' for a, b in pts)}'" for c, pts in CURVE.items())
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-c:v', 'libvpx-vp9', '-i', src, '-map', '0',
                '-vf', f'scale=in_color_matrix=bt601,format=rgba,curves={curves},scale=out_color_matrix=bt601,format=yuva420p',
                '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-crf', crf, '-b:v', '0', '-auto-alt-ref', '0',
                '-colorspace', 'bt470bg', '-color_range', 'tv', '-metadata:s:v:0', 'alpha_mode=1', '-c:a', 'copy', dst],
               check=True)
