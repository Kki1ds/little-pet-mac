// Plays N clips in transparent frameless windows (like the pet windows) and
// reports the app's total CPU plus whether the clips really are transparent.
//   Electron bench --dir <animations> --ext .mov --count 5 --seconds 30 --out <folder>
const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const dir = path.resolve(arg('dir', '.'));
const ext = arg('ext', '.webm');
const count = Number(arg('count', 5));
const seconds = Number(arg('seconds', 30));
const out = path.resolve(arg('out', '.'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.dock?.hide();
app.whenReady().then(async () => {
  const clips = fs.readdirSync(dir).filter((f) => f.endsWith(ext)).sort().slice(0, count);
  if (!clips.length) throw new Error('no ' + ext + ' clips in ' + dir);
  const area = screen.getPrimaryDisplay().workArea;
  const size = { width: 320, height: 240 };
  const wins = clips.map((clip, i) => {
    const win = new BrowserWindow({
      ...size,
      x: area.x + 20 + (i % 4) * (size.width + 10),
      y: area.y + 40 + Math.floor(i / 4) * (size.height + 10),
      transparent: true, frame: false, hasShadow: false, alwaysOnTop: true, resizable: false, focusable: false,
      show: false, webPreferences: { backgroundThrottling: false },
    });
    win.loadFile(path.join(__dirname, 'index.html'), { hash: encodeURIComponent(pathToFileURL(path.join(dir, clip)).href) });
    win.once('ready-to-show', () => win.showInactive());
    return win;
  });

  await sleep(5000); // let decoders warm up
  app.getAppMetrics(); // the first sample has no CPU baseline
  const samples = [];
  for (let t = 0; t < seconds; t += 2) {
    await sleep(2000);
    const metrics = app.getAppMetrics();
    const byType = {};
    for (const m of metrics) byType[m.type] = (byType[m.type] || 0) + m.cpu.percentCPUUsage;
    samples.push({ total: metrics.reduce((s, m) => s + m.cpu.percentCPUUsage, 0), byType });
  }
  const avg = (f) => samples.reduce((s, x) => s + f(x), 0) / samples.length;
  const types = [...new Set(samples.flatMap((s) => Object.keys(s.byType)))];

  const videos = [];
  for (const [i, win] of wins.entries()) {
    const state = await win.webContents.executeJavaScript(`(() => { const v = document.getElementById('v');
      const q = v.getVideoPlaybackQuality();
      return { w: v.videoWidth, h: v.videoHeight, t: v.currentTime, error: v.error && v.error.code,
               frames: q.totalVideoFrames, dropped: q.droppedVideoFrames }; })()`);
    // Transparent clip: most of the window should be see-through.
    const img = await win.webContents.capturePage();
    const bmp = img.toBitmap();
    let clear = 0;
    for (let p = 3; p < bmp.length; p += 4) if (bmp[p] < 16) clear++;
    if (i === 0) fs.writeFileSync(path.join(out, 'capture' + ext.replace('.', '-') + '.png'), img.toPNG());
    videos.push({ clip: clips[i], ...state, transparentShare: +(clear / (bmp.length / 4)).toFixed(3) });
  }
  const result = {
    ext, count: clips.length, seconds,
    cpuTotal: +avg((s) => s.total).toFixed(1),
    cpuByType: Object.fromEntries(types.map((k) => [k, +avg((s) => s.byType[k] || 0).toFixed(1)])),
    videos,
  };
  fs.writeFileSync(path.join(out, 'result' + ext.replace('.', '-') + '.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });
