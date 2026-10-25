#!/usr/bin/env python3
"""Convert VP9-alpha .webm clips to HEVC-with-alpha .mov (macOS only).

ffmpeg decodes each webm (libvpx-vp9 keeps the alpha) to premultiplied BGRA frames and
scripts/hevc_alpha_encoder.swift encodes them with AVFoundation's
hevcWithAlpha codec, the same pipeline as scripts/encode_hevc_alpha.sh but
with each clip's own size and frame rate.

    python tools/macos/hevc/encode_mov.py characters/ojousama/animations/待机-翻书.webm
    python tools/macos/hevc/encode_mov.py characters/*/animations --out-dir same

A .mov is written next to each .webm by default; --out-dir puts them elsewhere.
Clips whose .mov is newer than the .webm are skipped.
"""
from pathlib import Path
import argparse, json, shutil, subprocess, sys, tempfile

ROOT = Path(__file__).resolve().parents[3]
SWIFT = ROOT / 'scripts/hevc_alpha_encoder.swift'


def tool(name):
    found = shutil.which(name) or next((p for p in (f'/opt/homebrew/bin/{name}', f'/usr/local/bin/{name}') if Path(p).exists()), None)
    if not found:
        raise SystemExit(f'{name} not found; install it with `brew install ffmpeg`')
    return found


def probe(ffprobe, webm):
    out = subprocess.run([ffprobe, '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate',
                          '-of', 'json', str(webm)], check=True, capture_output=True, text=True).stdout
    s = json.loads(out)['streams'][0]
    num, den = s['r_frame_rate'].split('/')
    return s['width'], s['height'], round(int(num) / int(den))


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('inputs', nargs='+', type=Path, help='.webm files or folders that contain them')
    parser.add_argument('--out-dir', type=Path, help='write the .mov files here instead of next to each .webm')
    parser.add_argument('--force', action='store_true', help='re-encode even when the .mov is up to date')
    parser.add_argument('--quality', type=float, default=0.75, help='colour quality 0-1 (default 0.75)')
    parser.add_argument('--alpha-quality', type=float, default=1.0,
                        help='alpha quality 0-1 (default 1.0; lower values leave speckles on the edges)')
    parser.add_argument('--matrix', default='bt709', choices=['bt709', 'bt601'],
                        help='YUV matrix used to read the webm (default bt709, matching the BT.709 tag on the .mov)')
    parser.add_argument('--straight', action='store_true',
                        help='do not premultiply (Chromium composites HEVC alpha as premultiplied; straight alpha gives light rims)')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        raise SystemExit('HEVC with alpha needs macOS (AVFoundation)')
    webms = sorted({f for p in args.inputs for f in (p.glob('*.webm') if p.is_dir() else [p]) if f.suffix == '.webm'})
    if not webms:
        raise SystemExit('no .webm files found')
    ffmpeg, ffprobe = tool('ffmpeg'), tool('ffprobe')
    with tempfile.TemporaryDirectory() as tmp:
        encoder = Path(tmp) / 'hevc-alpha-encoder'
        subprocess.run(['xcrun', 'swiftc', '-O', '-suppress-warnings', '-framework', 'AVFoundation', '-framework', 'CoreVideo',
                        '-framework', 'VideoToolbox', str(SWIFT), '-o', str(encoder)], check=True)
        done = skipped = 0
        for i, webm in enumerate(webms, 1):
            out_dir = args.out_dir or webm.parent
            out_dir.mkdir(parents=True, exist_ok=True)
            mov = out_dir / (webm.stem + '.mov')
            if not args.force and mov.exists() and mov.stat().st_mtime > webm.stat().st_mtime:
                skipped += 1
                continue
            w, h, fps = probe(ffprobe, webm)
            print(f'[{i}/{len(webms)}] {webm.name} {w}x{h}@{fps}', flush=True)
            tmp_mov = mov.with_suffix('.tmp.mov')
            vf = f'scale=in_color_matrix={args.matrix}:out_color_matrix={args.matrix},format=bgra'
            if not args.straight:
                vf += ',premultiply=inplace=1'
            dec = subprocess.Popen([ffmpeg, '-hide_banner', '-loglevel', 'error', '-c:v', 'libvpx-vp9', '-i', str(webm), '-an',
                                    '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'bgra', 'pipe:1'], stdout=subprocess.PIPE)
            enc = subprocess.run([str(encoder), str(tmp_mov), str(w), str(h), str(fps), str(args.quality), str(args.alpha_quality)],
                                 stdin=dec.stdout)
            dec.stdout.close()
            if dec.wait() or enc.returncode:
                tmp_mov.unlink(missing_ok=True)
                raise SystemExit(f'encoding failed: {webm}')
            tmp_mov.replace(mov)
            done += 1
    print(f'done: converted={done} skipped={skipped} total={len(webms)}')


if __name__ == '__main__':
    main()
