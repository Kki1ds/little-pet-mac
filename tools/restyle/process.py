"""Recolor one VP9-alpha webm: decode -> recolor frames -> encode VP9 alpha."""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import recolor  # noqa: E402

src, dst = sys.argv[1], sys.argv[2]
crf = sys.argv[3] if len(sys.argv) > 3 else '28'

info = json.loads(subprocess.check_output([
    'ffprobe', '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', src]))['streams'][0]
w, h, rate = info['width'], info['height'], info['r_frame_rate']

dec = subprocess.Popen(['ffmpeg', '-v', 'error', '-c:v', 'libvpx-vp9', '-i', src,
                        '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], stdout=subprocess.PIPE)
enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba',
                        '-s', f'{w}x{h}', '-r', rate, '-i', '-',
                        '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-crf', crf, '-b:v', '0',
                        '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2',
                        '-auto-alt-ref', '0', '-metadata:s:v:0', 'alpha_mode=1', dst],
                       stdin=subprocess.PIPE)
tracker = recolor.FaceTracker()
n = found = eyes = 0
size = w * h * 4
while True:
    buf = dec.stdout.read(size)
    if len(buf) < size:
        break
    frame = np.frombuffer(buf, np.uint8).reshape(h, w, 4)
    out, em, box = recolor.recolor(frame, tracker, debug=True)
    n += 1
    found += box is not None
    eyes += em.sum() > 0
    enc.stdin.write(out.tobytes())
enc.stdin.close()
enc.wait()
dec.wait()
print(f'{src}: frames={n} face={found} eyes={eyes}', flush=True)
