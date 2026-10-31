'use strict';
/**
 * 共用进程模式（macOS 默认，宿主经 DSH_PET_SHARED=1 打开）：一个 helper 进程装下全部桌面宠物，
 * 每只宠物仍是自己的小窗口、自己的渲染进程。
 *
 * 为什么不是「所有宠物一个整屏透明窗口」：试过，省得更多，但宠物一动就要合成整块屏，互相碰撞乱飞时
 * 明显掉帧（Mac 实测帧间隔 p95 24.5 ms、20 秒 104 次卡顿；小窗口 9.2 ms、20 次）。小窗口由系统直接挪，
 * 跟每宠一进程一样顺；省下的是每只宠物各一份的主进程、GPU 进程和网络进程。
 *
 * 和每宠一进程的差别都在主进程（main.js）：
 *   - 宠物名单变了宿主不重启 helper（重启会让所有宠物一起闪）。页面发现配置版本变了就知会主进程，
 *     主进程自己向宿主拉一次 /config，按它增删/重建窗口（各页面的知会可能乱序到达，所以名单只信宿主）；
 *   - 所有窗口共用一个 profile（dsh-pet-shared），第一次启动时把每宠一进程时各自 profile 里的位置导进来；
 *   - 碰撞只走控制台的 broker（与每宠一进程时一致），不在进程内互相广播，免得同一次碰撞算两遍；
 *   - Cmd+Q 只藏当前点着的那只。
 *
 * 本文件只放纯逻辑与旧位置读取，便于单测（src/host/shared-helper.test.ts）。
 */
const path = require('node:path');
const { existsSync, readdirSync, readFileSync, writeFileSync } = require('node:fs');

/** 每宠一进程时各 helper 的 profile 目录名前缀（main.js 按 DSH_PET_INSTANCE_ID 拼） */
const LEGACY_PROFILE_PREFIX = 'dsh-pet-character-';
/** 共用进程模式自己的 profile 目录名 */
const SHARED_PROFILE = 'dsh-pet-shared';

/** 与页面同一口径（shared-core.js 的 isDesktopVisible）：display 为 desktop/both 的宠物上桌面 */
const isDesktopVisible = (display) => display === 'desktop' || display === 'both';

/**
 * 宿主 /config 的成品聚合 → 桌面宠物名单 [{id, name, size, assetRoot}]。
 * 拍平方式与页面一致（shared-core.js 的 flattenConfigPets：按种类目录逐个展开 pets）；
 * 坏条目丢掉，同 id 只留第一个。
 */
function desktopPetsFromConfig(merged) {
  const out = [];
  const seen = new Set();
  for (const [entry, conf] of Object.entries(merged && typeof merged === 'object' ? merged : {})) {
    for (const p of Array.isArray(conf && conf.pets) ? conf.pets : []) {
      const id = p && (typeof p.id === 'string' || typeof p.id === 'number') ? String(p.id) : '';
      const size = Number(p && p.size);
      if (!id || seen.has(id) || !(size > 0) || !isDesktopVisible(p.display)) continue;
      seen.add(id);
      out.push({ id, name: typeof p.name === 'string' ? p.name.trim() : '', size, assetRoot: entry });
    }
  }
  return out;
}

/**
 * 现有窗口 vs 新名单 → 要做的事。
 *   current: [{id, size}]（现有窗口）；wanted: desktopPetsFromConfig 的结果
 *   → { open: [pet]（新出现的）, reopen: [pet]（大小变了：重建窗口，页面按新大小起）, close: [id]（不要了的） }
 * 名单为空时什么都不关：一只都不剩时宿主会停掉整个 helper，不必在这里把窗口关光。
 */
function planSharedWindows(current, wanted) {
  const have = new Map(current.map((p) => [p.id, p]));
  const want = new Map(wanted.map((p) => [p.id, p]));
  const plan = { open: [], reopen: [], close: [] };
  if (!wanted.length) return plan;
  for (const p of wanted) {
    const old = have.get(p.id);
    if (!old) plan.open.push(p);
    else if (old.size !== p.size) plan.reopen.push(p);
  }
  for (const p of current) if (!want.has(p.id)) plan.close.push(p.id);
  return plan;
}

/**
 * 每宠一进程时各 profile 里存的位置 → { positions: { petId: {rx, ry} }, complete }。
 * complete=false（有 profile 没读成，比如旧进程还握着它）时不缓存，下次启动再读。
 * 读法：用旧 profile 开一个隐藏窗口加载空白页（file:// 源，与宠物页同源），读它的 localStorage。
 */
async function readLegacyPositions({ app, BrowserWindow, session, helperDir }) {
  const cache = path.join(app.getPath('userData'), 'legacy-positions.json');
  try {
    return { positions: JSON.parse(readFileSync(cache, 'utf8')), complete: true };
  } catch {
    /* 还没读过 */
  }
  const positions = {};
  let complete = true;
  const appData = app.getPath('appData');
  let names = [];
  try {
    names = readdirSync(appData).filter((name) => name.startsWith(LEGACY_PROFILE_PREFIX));
  } catch {
    /* 没有旧 profile */
  }
  for (const name of names) {
    const dir = path.join(appData, name);
    if (!existsSync(path.join(dir, 'Local Storage'))) continue;
    try {
      Object.assign(positions, await readProfile(dir, { BrowserWindow, session, helperDir }));
    } catch (error) {
      complete = false;
      console.error('[dsh-pet-desktop-helper] legacy positions in ' + name + ':', error.message);
    }
  }
  if (complete) {
    try {
      writeFileSync(cache, JSON.stringify(positions));
    } catch {
      /* 下次再读一遍也无妨 */
    }
  }
  return { positions, complete };
}

async function readProfile(dir, { BrowserWindow, session, helperDir }) {
  if (typeof session.fromPath !== 'function') return {};
  const win = new BrowserWindow({
    show: false,
    width: 10,
    height: 10,
    webPreferences: { session: session.fromPath(dir), sandbox: true, contextIsolation: true },
  });
  const limit = (promise, ms) =>
    Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Error('timeout')), ms))]);
  try {
    await limit(win.loadFile(path.join(helperDir, 'blank.html')), 5000);
    const raw = await limit(
      win.webContents.executeJavaScript(
        "JSON.stringify(Object.keys(localStorage).filter(k => k.startsWith('dsh-pet-position:')).map(k => [k.slice(17), localStorage.getItem(k)]))",
      ),
      3000,
    );
    const out = {};
    for (const [id, value] of JSON.parse(raw)) {
      try {
        const pos = JSON.parse(value);
        if (pos && Number.isFinite(pos.rx) && Number.isFinite(pos.ry)) out[id] = { rx: pos.rx, ry: pos.ry };
      } catch {
        /* 坏记录跳过 */
      }
    }
    return out;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

module.exports = {
  LEGACY_PROFILE_PREFIX,
  SHARED_PROFILE,
  desktopPetsFromConfig,
  planSharedWindows,
  readLegacyPositions,
};
