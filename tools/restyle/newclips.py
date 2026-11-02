#!/usr/bin/env python3
"""Turn a 豆包 green-screen mp4 of 小克 into a clip that matches the upstream ones (characters/Claude).

The raw clips differ from the upstream clips in two ways: the figure fills ~13% less of the
frame (feet at y=609 of 720 instead of 630) and the colours are darker and pinker (hair
218,108,57 vs 244,126,57; white dress 241,216,211 vs 252,240,233). This keys the green,
tone-matches the figure and re-frames it onto the standard 1280x720 canvas of the upstream clips.

    python tools/restyle/newclips.py raw.mp4 out.webm [crf]

CURVES come from per-channel quantile matching of the keyed figure pixels of the four raw clips
(待机呼吸起伏, 东张西望, 害羞惊讶, 傲娇生气) onto frames of 待机-翻书, 查看发饰, 欢快舞蹈 and 钱多的烦恼,
smoothed and cut down to 17 anchors. SCALE/FEET_SRC/CENTER_SRC are the figure's size, bottom line
and horizontal centre in the raw clips; FEET_OUT is the Claude 1280x720 foot line in canvas-layout.js.
"""
import subprocess, sys

KEY = 'chromakey=0x00E300:0.22:0.1,despill=green'
CURVES = {
    'r': [(0, 0.0), (16, 11.2), (32, 22.4), (48, 35.5), (64, 54.7), (80, 70.7), (96, 93.9), (112, 116.9), (128, 136.6),
          (144, 155.5), (160, 177.4), (176, 201.5), (192, 220.9), (208, 238.3), (224, 250.0), (240, 254.4), (255, 255.0)],
    'g': [(0, 0.0), (16, 10.9), (32, 26.9), (48, 49.5), (64, 71.3), (80, 98.1), (96, 120.8), (112, 136.4), (128, 167.1),
          (144, 186.8), (160, 205.1), (176, 222.4), (192, 234.6), (208, 242.9), (224, 250.1), (240, 253.0), (255, 255.0)],
    'b': [(0, 0.0), (16, 4.1), (32, 20.3), (48, 43.7), (64, 64.5), (80, 88.3), (96, 112.1), (112, 133.0), (128, 150.9),
          (144, 167.5), (160, 188.3), (176, 209.8), (192, 227.6), (208, 239.7), (224, 247.7), (240, 251.9), (255, 255.0)],
}
SCALE = 1.15
FEET_SRC, CENTER_SRC = 609, 640
FEET_OUT, W, H = 630, 1280, 720

src, dst = sys.argv[1], sys.argv[2]
crf = sys.argv[3] if len(sys.argv) > 3 else '28'
curves = ':'.join(f"{c}='{' '.join(f'{a / 255:.4f}/{b / 255:.4f}' for a, b in pts)}'" for c, pts in CURVES.items())
x = round(SCALE * CENTER_SRC - W / 2)
y = round(SCALE * FEET_SRC - FEET_OUT)
vf = (f'format=rgba,{KEY},curves={curves},scale=iw*{SCALE}:ih*{SCALE}:flags=lanczos,crop={W}:{H}:{x}:{y},'
      'scale=out_color_matrix=bt601,format=yuva420p')
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-an', '-vf', vf,
                '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-crf', crf, '-b:v', '0', '-row-mt', '1',
                '-deadline', 'good', '-cpu-used', '2', '-auto-alt-ref', '0',
                '-colorspace', 'bt470bg', '-color_range', 'tv', '-metadata:s:v:0', 'alpha_mode=1', dst],
               check=True)
