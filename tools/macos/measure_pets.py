#!/usr/bin/env python3
"""Measure what the desktop pets cost on this Mac: CPU and memory of the pet helper processes.

Run it while 小小桌宠 is running with the pets you normally keep on screen:

    python tools/macos/measure_pets.py              # 30-second sample
    python tools/macos/measure_pets.py --seconds 60 --save before.json

To compare the two window modes, measure once, switch 「所有角色共用一个窗口（省资源）」 in the
menu-bar icon's menu, wait about 15 seconds for the pets to come back, and measure again.

What is counted: every process started for the pets (each `.../electron-helper/main.js` helper
and its GPU / renderer / utility children). The control console and the pet service are not
counted; they are the same in both modes. WindowServer is reported on its own line: it is
shared by every app, but moving windows and large transparent windows show up there.

CPU is the average over the sample (100% = one core). Memory is the physical footprint that
Activity Monitor shows in its Memory column. Uses only the system tools `ps` and `top`.
"""
from pathlib import Path
import argparse, json, re, subprocess, sys, time, urllib.request

HELPER_MARK = 'electron-helper/main.js'


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
    started = time.time()
    stats = sample(args.seconds)
    # Helpers that restarted during the sample would be counted twice or missed: say so.
    roots_after, members_after = pet_processes(processes())
    if set(roots_after) != set(roots):
        print('Warning: the pet helpers changed during the sample (a pet was shown/hidden or the mode switched). Measure again.')
    members &= members_after

    cpu = sum(stats[p][0] for p in members if p in stats)
    mem = sum(stats[p][1] for p in members if p in stats)
    window_server = [v for v in stats.values() if v[2].startswith('WindowServer')]
    ws_cpu = window_server[0][0] if window_server else None
    result = {
        'mode': mode,
        'helpers': len(roots),
        'processes': len(members),
        'seconds': round(time.time() - started),
        'cpu_percent': round(cpu, 1),
        'memory_mb': round(mem),
        'window_server_cpu_percent': ws_cpu,
    }
    print(f'Pets:         CPU {result["cpu_percent"]}%   memory {result["memory_mb"]} MB   ({len(roots)} helper(s), {len(members)} processes)')
    if ws_cpu is not None:
        print(f'WindowServer: CPU {ws_cpu}%   (shared by all apps)')
    if args.save:
        args.save.write_text(json.dumps(result, ensure_ascii=False, indent=1) + '\n', 'utf-8')
        print(f'Saved to {args.save}')


if __name__ == '__main__':
    main()
