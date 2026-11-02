#!/usr/bin/env python3
"""Measure what the desktop pets cost on this Mac: CPU and memory of the pet helper processes.

Run it while 小小桌宠 is running with the pets you normally keep on screen:

    python tools/macos/measure_pets.py              # 30-second sample
    python tools/macos/measure_pets.py --seconds 60 --save before.json

To compare the two process modes, measure once, switch 「所有角色共用一个进程（省资源）」 in the
menu-bar icon's menu, wait about 15 seconds for the pets to come back, and measure again.

What is counted: every process started for the pets (each `.../electron-helper/main.js` helper
and its GPU / renderer / utility children). The control console and the pet service are not
counted; they are the same in both modes. WindowServer is reported on its own line: it is
shared by every app, but moving and compositing the pet windows shows up there. So is
VTDecoder, the system service that decodes the HEVC .mov clips in hardware: add it to the
pets' CPU when comparing with a .webm build.

CPU is the average over the sample (100% = one core), also split by process kind: a single
process near 100% is saturated even when the total looks fine. Memory is the physical footprint
that Activity Monitor shows in its Memory column.

Smoothness: during the sample every pet page counts its animation frame intervals and the video
frames it dropped (the helpers pick up a request file in ~/.dsh/pet-control-client within a
second). Make the pets do what feels choppy (drag them, throw them into each other) while it runs.

Uses only the system tools `ps` and `top`.
"""
from pathlib import Path
import argparse, json, os, re, subprocess, sys, time, urllib.request

HELPER_MARK = 'electron-helper/main.js'


CLIENT_DIR = Path(os.environ.get('DSH_HOME') or Path.home() / '.dsh') / 'pet-control-client'


def kind(command):
    m = re.search(r'--type=([\w-]+)', command)
    if not m:
        return 'main'
    return {'gpu-process': 'GPU', 'renderer': 'renderer', 'utility': 'utility'}.get(m.group(1), m.group(1))


def request_probe(seconds):
    """Ask the pet pages to count frames for the sample; returns the request id (None if not possible)."""
    if not CLIENT_DIR.is_dir():
        return None
    probe_id = str(int(time.time() * 1000))
    until = int((time.time() + seconds) * 1000)
    (CLIENT_DIR / 'frame-probe-request.json').write_text(json.dumps({'id': probe_id, 'until': until}), 'utf-8')
    return probe_id


def read_probe(probe_id, wait=8, settle=1.5):
    """Results written by the pet pages for this request: {page: result}.

    One file per pet page. A helper can hold several pages, so the count is not known in advance:
    stop once no new result has arrived for `settle` seconds (they all finish within a moment).
    """
    results = {}
    deadline = time.time() + wait
    last_new = None
    while time.time() < deadline:
        for file in (CLIENT_DIR / 'frame-probe').glob('*.json'):
            try:
                r = json.loads(file.read_text('utf-8'))
            except (OSError, ValueError):
                continue
            if r.get('id') == probe_id and file.stem not in results:
                results[file.stem] = r
                last_new = time.time()
        if last_new is not None and time.time() - last_new >= settle:
            break
        time.sleep(0.5)
    return results


def summarize_probe(results):
    if not results:
        return None
    rs = list(results.values())
    frames = sum(r.get('frames', 0) for r in rs)
    total = sum(r.get('videoTotal', 0) for r in rs)
    dropped = sum(r.get('videoDropped', 0) for r in rs)
    return {
        'pages': len(rs),
        'frames': frames,
        'frame_p50_ms': max(r.get('p50', 0) for r in rs),
        'frame_p95_ms': max(r.get('p95', 0) for r in rs),
        'frame_worst_ms': max(r.get('max', 0) for r in rs),
        'hitches': sum(r.get('hitches', 0) for r in rs),
        'video_dropped': dropped,
        'video_frames': total,
    }


def processes():
    """pid → (ppid, command)"""
    out = subprocess.run(['ps', '-axo', 'pid=,ppid=,command='], capture_output=True, text=True, check=True).stdout
    table = {}
    for line in out.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit():
            table[int(parts[0])] = (int(parts[1]), parts[2])
    return table


def pet_processes(table):
    """The pet helpers (roots) and every process below them."""
    roots = [pid for pid, (_, cmd) in table.items() if HELPER_MARK in cmd and '--type=' not in cmd]
    children = {}
    for pid, (ppid, _) in table.items():
        children.setdefault(ppid, []).append(pid)
    members, stack = set(), list(roots)
    while stack:
        pid = stack.pop()
        if pid in members:
            continue
        members.add(pid)
        stack.extend(children.get(pid, []))
    return roots, members


def parse_mem(text):
    m = re.match(r'^([\d.]+)([BKMGT]?)\+?-?$', text)
    if not m:
        return 0.0
    scale = {'': 1 / 1024 / 1024, 'B': 1 / 1024 / 1024, 'K': 1 / 1024, 'M': 1, 'G': 1024, 'T': 1024 * 1024}[m.group(2)]
    return float(m.group(1)) * scale


def sample(seconds):
    """CPU % over the interval and physical footprint (MB) per pid, from the second `top` sample."""
    out = subprocess.run(
        ['top', '-l', '2', '-s', str(seconds), '-n', '2000', '-stats', 'pid,cpu,mem,command'],
        capture_output=True, text=True, check=True,
    ).stdout
    blocks = re.split(r'^PID\s+%CPU\s+MEM.*$', out, flags=re.M)
    if len(blocks) < 3:
        sys.exit('could not read the output of top')
    stats = {}
    for line in blocks[2].splitlines():
        parts = line.split(None, 3)
        if len(parts) >= 3 and parts[0].isdigit():
            try:
                cpu = float(parts[1])
            except ValueError:
                continue
            stats[int(parts[0])] = (cpu, parse_mem(parts[2]), parts[3] if len(parts) > 3 else '')
    return stats


def host_mode():
    try:
        with urllib.request.urlopen('http://127.0.0.1:3081/health', timeout=2) as res:
            return json.load(res).get('desktopMode') or 'per-pet (older build)'
    except Exception:
        return 'unknown (pet service not reachable)'


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--seconds', type=int, default=30, help='sample length (default 30)')
    parser.add_argument('--save', type=Path, help='also write the result to this JSON file')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        sys.exit('macOS only')

    roots, members = pet_processes(processes())
    if not roots:
        sys.exit('No pet helpers are running. Start 小小桌宠 and show at least one pet.')
    mode = host_mode()
    print(f'Mode: {mode}; {len(roots)} helper(s), {len(members)} processes. Sampling for {args.seconds} s ...', flush=True)
    probe_id = request_probe(args.seconds)
    started = time.time()
    stats = sample(args.seconds)
    # Helpers that restarted during the sample would be counted twice or missed: say so.
    table_after = processes()
    roots_after, members_after = pet_processes(table_after)
    if set(roots_after) != set(roots):
        print('Warning: the pet helpers changed during the sample (a pet was shown/hidden or the mode switched). Measure again.')
    members &= members_after

    cpu = sum(stats[p][0] for p in members if p in stats)
    mem = sum(stats[p][1] for p in members if p in stats)
    by_kind = {}
    for p in members:
        if p in stats:
            k = kind(table_after[p][1])
            by_kind[k] = by_kind.get(k, 0) + stats[p][0]
    busiest = max((p for p in members if p in stats), key=lambda p: stats[p][0], default=None)
    window_server = [v for v in stats.values() if v[2].startswith('WindowServer')]
    ws_cpu = window_server[0][0] if window_server else None
    # The .mov clips are decoded in hardware through the system's VTDecoderXPCService processes (top
    # cuts the name to 16 characters); that work is the pets' but is not under the helper.
    vt_cpu = round(sum(v[0] for v in stats.values() if v[2].startswith('VTDecoderXPCServ')), 1)
    frames = summarize_probe(read_probe(probe_id)) if probe_id else None
    result = {
        'mode': mode,
        'helpers': len(roots),
        'processes': len(members),
        'seconds': round(time.time() - started),
        'cpu_percent': round(cpu, 1),
        'cpu_by_kind': {k: round(v, 1) for k, v in sorted(by_kind.items(), key=lambda kv: -kv[1])},
        'busiest_process': {'kind': kind(table_after[busiest][1]), 'cpu_percent': stats[busiest][0]} if busiest else None,
        'memory_mb': round(mem),
        'window_server_cpu_percent': ws_cpu,
        'video_decoder_cpu_percent': vt_cpu,
        'frames': frames,
    }
    print(f'Pets:         CPU {result["cpu_percent"]}%   memory {result["memory_mb"]} MB   ({len(roots)} helper(s), {len(members)} processes)')
    print('  by kind:    ' + '   '.join(f'{k} {v}%' for k, v in result['cpu_by_kind'].items()))
    if busiest:
        print(f'  busiest:    one {result["busiest_process"]["kind"]} process at {result["busiest_process"]["cpu_percent"]}% (100% = a full core)')
    print(f'VTDecoder:    CPU {vt_cpu}%   (hardware decoding of the .mov clips; shared with other apps playing video)')
    if ws_cpu is not None:
        print(f'WindowServer: CPU {ws_cpu}%   (shared by all apps)')
    if frames:
        rate = f'{frames["video_dropped"] / frames["video_frames"] * 100:.1f}%' if frames['video_frames'] else 'n/a'
        print(f'Frames:       interval p50 {frames["frame_p50_ms"]} ms, p95 {frames["frame_p95_ms"]} ms, worst {frames["frame_worst_ms"]} ms; '
              f'{frames["hitches"]} hitches (a frame that took two or more)')
        print(f'  video:      {frames["video_dropped"]} of {frames["video_frames"]} frames dropped ({rate}); '
              f'{frames["pages"]} pet page(s)')
    elif probe_id:
        print('Frames:       no answer from the pet pages (an older build, or the pets were restarting)')
    if args.save:
        args.save.write_text(json.dumps(result, ensure_ascii=False, indent=1) + '\n', 'utf-8')
        print(f'Saved to {args.save}')


if __name__ == '__main__':
    main()
