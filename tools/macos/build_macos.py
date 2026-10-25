#!/usr/bin/env python3
"""Build 小小桌宠.app for macOS (personal use, ad-hoc signed).

Uses only the macOS system Python, ditto, sips, iconutil and codesign. Node and npm
are not needed: the client runs the pet host on Electron's own Node, and the
packaged app never downloads Electron, so the engine's two download-only
dependencies are replaced with stubs.

Every run writes a new timestamped folder under outputs/macos/ and never
touches an existing build or /Applications.
"""
from pathlib import Path
import argparse, datetime, hashlib, json, plistlib, shutil, subprocess, sys, tempfile, urllib.request

ROOT = Path(__file__).resolve().parents[2]
ENGINE = ROOT / 'dsh-pet'
APP_NAME = '小小桌宠'
BUNDLE_ID = 'io.github.kki1ds.little-pet'
VERSION = '1.0.4'
MIRRORS = ['https://npmmirror.com/mirrors/electron/', 'https://github.com/electron/electron/releases/download/']


def run(*cmd):
    subprocess.run([str(c) for c in cmd], check=True)


def fetch(url, dest=None):
    print('download', url, flush=True)
    with urllib.request.urlopen(url, timeout=600) as res:
        if dest is None:
            return res.read()
        with open(dest, 'wb') as out:
            shutil.copyfileobj(res, out, 1 << 20)


def electron_zip(version, arch, cache):
    name = f'electron-v{version}-darwin-{arch}.zip'
    zip_path = cache / name
    errors = []
    for mirror in MIRRORS:
        base = f'{mirror}v{version}/'
        try:
            sums = fetch(base + 'SHASUMS256.txt').decode()
            expected = next(line.split()[0] for line in sums.splitlines() if line.strip().endswith(name))
            if not zip_path.exists() or hashlib.sha256(zip_path.read_bytes()).hexdigest() != expected:
                fetch(base + name, zip_path)
            actual = hashlib.sha256(zip_path.read_bytes()).hexdigest()
            if actual != expected:
                raise RuntimeError(f'SHA256 mismatch for {name}')
            return zip_path
        except Exception as e:  # try the next mirror
            errors.append(f'{mirror}: {e}')
    raise SystemExit('Electron download failed:\n  ' + '\n  '.join(errors))


def make_icns(png, dest):
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / 'app.iconset'
        iconset.mkdir()
        for size in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                px = size * scale
                suffix = '' if scale == 1 else '@2x'
                run('sips', '-z', px, px, png, '--out', iconset / f'icon_{size}x{size}{suffix}.png')
        run('iconutil', '-c', 'icns', iconset, '-o', dest)


def write_stub(base, name, source):
    pkg = base / 'node_modules' / name
    pkg.mkdir(parents=True)
    (pkg / 'package.json').write_text(json.dumps({'name': name, 'version': '0.0.0-stub', 'type': 'module', 'exports': './index.js'}), 'utf-8')
    (pkg / 'index.js').write_text(source, 'utf-8')


def main():
    if sys.platform != 'darwin':
        raise SystemExit('build_macos.py only runs on macOS')
    default_version = '43.3.0'
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--electron-version', default=default_version)
    parser.add_argument('--electron-zip', type=Path, help='use an already downloaded electron-v*-darwin-*.zip')
    parser.add_argument('--arch', default='arm64', choices=['arm64', 'x64'])
    parser.add_argument('--output', type=Path, help='new folder to create (default outputs/macos/<timestamp>)')
    args = parser.parse_args()

    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    out = (args.output or ROOT / 'outputs/macos' / stamp).resolve()
    if out.exists():
        parser.error(f'{out} already exists; builds always go to a new folder')
    cache = ROOT / 'outputs/macos/.cache'
    cache.mkdir(parents=True, exist_ok=True)
    zip_path = args.electron_zip or electron_zip(args.electron_version, args.arch, cache)

    out.mkdir(parents=True)
    run('ditto', '-x', '-k', zip_path, out)
    app = out / f'{APP_NAME}.app'
    (out / 'Electron.app').rename(app)
    for extra in ('LICENSE', 'LICENSES.chromium.html', 'version'):
        (out / extra).unlink(missing_ok=True)
    contents = app / 'Contents'
    res = contents / 'Resources'
    (res / 'default_app.asar').unlink(missing_ok=True)
    (res / 'electron.icns').unlink(missing_ok=True)
    make_icns(ROOT / 'client/assets/app.png', res / 'app.icns')

    plist_path = contents / 'Info.plist'
    with open(plist_path, 'rb') as f:
        plist = plistlib.load(f)
    plist.update(CFBundleName=APP_NAME, CFBundleDisplayName=APP_NAME, CFBundleIdentifier=BUNDLE_ID,
                 CFBundleIconFile='app.icns', CFBundleShortVersionString=VERSION, CFBundleVersion=VERSION)
    with open(plist_path, 'wb') as f:
        plistlib.dump(plist, f)

    # Same layout as the Windows release: service.cjs finds ../../engine and ../../characters.
    app_dir = res / 'app'
    shutil.copytree(ROOT / 'client', app_dir / 'client', ignore=shutil.ignore_patterns('*.test.cjs', 'verify.cjs', '*.ico'))
    (app_dir / 'package.json').write_text(json.dumps(dict(name='xiaoxiao-zhuochong', productName=APP_NAME, version=VERSION, main='bootstrap.cjs'), ensure_ascii=False), 'utf-8')
    (app_dir / 'bootstrap.cjs').write_text(
        "const path=require('node:path');\n"
        "if(process.env.DSH_PET_HOST_PID){require(path.resolve(__dirname,'../engine/runtime/electron-helper/main.js'));}else{require('./client/main.cjs');}\n", 'utf-8')
    engine = res / 'engine'
    for name in ('lib', 'runtime', 'assets'):
        shutil.copytree(ENGINE / name, engine / name)
    for name in ('package.json', 'LICENSE'):
        shutil.copy2(ENGINE / name, engine / name)
    # DSH_PET_ELECTRON_PATH is always set by the client, so these download-only modules never run.
    write_stub(engine, '@electron/get', "export async function downloadArtifact(){throw new Error('小小桌宠 macOS 版不下载 Electron');}\n")
    write_stub(engine, '@electron-internal/extract-zip', "export default async function extract(){throw new Error('小小桌宠 macOS 版不解压 Electron');}\n")
    shutil.copytree(ROOT / 'characters', res / 'characters')

    run('codesign', '--force', '--deep', '--sign', '-', app)
    run('codesign', '--verify', '--deep', '--strict', app)
    print(json.dumps({'app': str(app), 'electron': str(zip_path)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
