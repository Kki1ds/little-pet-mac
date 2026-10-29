#!/usr/bin/env python3
"""Compare .webm vs .mov playback in Electron: CPU and transparency.

    python tools/macos/hevc/bench.py characters/Claude/animations

Needs the .mov clips next to the .webm ones (run encode_mov.py first) and the
Electron zip that build_macos.py caches in outputs/macos/.cache/. Writes
result-webm.json, result-mov.json and one window capture per format to
outputs/macos/hevc-bench/<timestamp>/.
"""
from pathlib import Path
import argparse, datetime, json, subprocess, sys, tempfile

ROOT = Path(__file__).resolve().parents[3]


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('dir', type=Path, help='folder with matching .webm and .mov clips')
    parser.add_argument('--count', type=int, default=5, help='clips played at once (default 5, like 5 pets)')
    parser.add_argument('--seconds', type=int, default=30)
    parser.add_argument('--electron-zip', type=Path, help='default: newest zip in outputs/macos/.cache/')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        raise SystemExit('macOS only')
    zip_path = args.electron_zip or max((ROOT / 'outputs/macos/.cache').glob('electron-v*-darwin-*.zip'), default=None,
                                        key=lambda p: p.stat().st_mtime)
    if not zip_path:
        raise SystemExit('no Electron zip cached; run tools/macos/build_macos.py once first')
    out = ROOT / 'outputs/macos/hevc-bench' / datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    out.mkdir(parents=True)
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(['ditto', '-x', '-k', str(zip_path), tmp], check=True)
        electron = Path(tmp) / 'Electron.app/Contents/MacOS/Electron'
        results = {}
        for ext in ('.webm', '.mov'):
            print(f'playing {args.count} {ext} clips for {args.seconds}s ...', flush=True)
            subprocess.run([str(electron), str(Path(__file__).parent / 'bench'), '--dir', str(args.dir.resolve()), '--ext', ext,
                            '--count', str(args.count), '--seconds', str(args.seconds), '--out', str(out)],
                           check=True, stdout=subprocess.DEVNULL)
            results[ext] = json.loads((out / f'result-{ext[1:]}.json').read_text())
    for ext, r in results.items():
        clear = min(v['transparentShare'] for v in r['videos'])
        frames = [v['frames'] for v in r['videos']]
        print(f"{ext:6} CPU {r['cpuTotal']:6.1f}%  by process {r['cpuByType']}  min transparent share {clear}  frames {frames}")
    print('details:', out)


if __name__ == '__main__':
    main()
