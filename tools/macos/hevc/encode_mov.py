#!/usr/bin/env python3
"""Convert VP9-alpha .webm clips to HEVC-with-alpha .mov (macOS only).

ffmpeg decodes each webm (libvpx-vp9 keeps the alpha) to premultiplied BGRA frames and
scripts/hevc_alpha_encoder.swift encodes them with AVFoundation's
hevcWithAlpha codec, the same pipeline as scripts/encode_hevc_alpha.sh but
with each clip's own size and frame rate. Clips wider than --max-width (default 960) are
scaled down on the way: the pets show them about 480pt wide, and the HEVC is decoded in
hardware, so the smaller encode only saves disk space and looks the same on screen.

    python tools/macos/hevc/encode_mov.py characters/Claude/animations/待机-翻书.webm
    python tools/macos/hevc/encode_mov.py characters/*/animations --out-dir same

The macOS build runs this for every character (build_macos.py) and ships only the .mov clips;
the .webm files in characters/ stay the source. A .mov is written next to each .webm by default
(do not commit it); --out-dir puts them elsewhere.
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


def fit(width, height, max_width):
    """Output size: at most max_width wide, same aspect, even dimensions (HEVC 4:2:0)."""
    if width <= max_width:
        return width, height
    return max_width, round(height * max_width / width / 2) * 2


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('inputs', nargs='+', type=Path, help='.webm files or folders that contain them')
    parser.add_argument('--out-dir', type=Path, help='write the .mov files here instead of next to each .webm')
    parser.add_argument('--force', action='store_true', help='re-encode even when the .mov is up to date')
    parser.add_argument('--quality', type=float, default=0.75, help='colour quality 0-1 (default 0.75)')
    parser.add_argument('--alpha-quality', type=float, default=0.9,
                        help='alpha quality 0-1 (default 0.9; 0.75 left speckles on the edges)')
    parser.add_argument('--max-width', type=int, default=960,
                        help='scale wider clips down to this width (default 960; 0 keeps every clip at its own size)')
    parser.add_argument('--matrix', default='bt601', choices=['bt601', 'bt709'],
                        help='YUV matrix used to read the webm (default bt601, how Chromium shows the untagged webm)')
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
            src_w, src_h, fps = probe(ffprobe, webm)
            w, h = fit(src_w, src_h, args.max_width) if args.max_width > 0 else (src_w, src_h)
            print(f'[{i}/{len(webms)}] {webm.name} {src_w}x{src_h}@{fps}' + (f' -> {w}x{h}' if (w, h) != (src_w, src_h) else ''), flush=True)
            tmp_mov = mov.with_suffix('.tmp.mov')
            vf = f'scale={w}:{h}:flags=lanczos:in_color_matrix={args.matrix}:out_color_matrix={args.matrix},format=bgra'
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
