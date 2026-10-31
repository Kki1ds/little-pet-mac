/**
 * little-pet-mac 单窗口模式（overlay，macOS）—— 主进程侧。渲染端见 overlay.js。
 *
 * 一个 helper 进程承载全部桌面宠物：本模块建一个全屏透明窗口盖住主屏，加载 index.html（overlay=1）；
 * 页面需要别的屏时 window.open 出子窗口，这里按窗口名 dsh-pet-overlay-<显示器 id> 把它摆到那块屏上。
 * 所有窗口共用一个渲染进程。
 *
 * 本模块负责：
 *   - 窗口：置顶（screen-saver 层）、所有桌面可见、不进调度中心、默认整窗穿透；显示器变化时跟着换位置；
 *   - 穿透：渲染端的即时判定（pet:overlay-hint）+ 每 60ms 按真实光标兜底（decideOverlayIgnore）；
 *     拖拽租约（pet:overlay-busy 每秒续）过期即恢复穿透；
 *   - 全屏让位：哪块屏在全屏，就把那块屏的窗口变全透明 + 穿透；
 *   - 角色日志与碰撞 broker 连接：按宠物 id 建（渲染端 pet:overlay-pets 上报名单）；
 *   - 每宠一窗时存的位置：第一次进本模式时从各旧 profile 的 localStorage 读出来交给渲染端；
 *   - 渲染进程崩了就整个退出（宿主会重新拉起）：窗口盖着整块屏，没有渲染端时绝不能留着。
 */
'use strict';

const path = require('node:path');
const { readFileSync, writeFileSync, readdirSync, existsSync } = require('node:fs');
const { decideOverlayIgnore, DRAG_LEASE_MS } = require('./pointer-target.js');
const { overlayConcealed } = require('./fullscreen-guard.js');
const { TOPMOST_WATCHDOG_TICK_MS, shouldReassertTopmost } = require('./topmost-watchdog.js');

/** 兜底命中判定的光标轮询间隔（ms，与每宠一窗的兜底通道一致） */
const OVERLAY_POLL_MS = 60;
/** 渲染端刚报过即时判定的窗口，这段时间内轮询不去改它（两条通道不抢；渲染端卡住时轮询照样接手） */
const HINT_PRIORITY_MS = 200;
const FRAME_NAME = /^dsh-pet-overlay-(-?\d+)$/;
const LEGACY_PREFIX = 'dsh-pet-character-';

function startOverlay(ctx) {
  const { app, BrowserWindow, ipcMain, screen, session } = ctx.electron;
  let geo = ctx.deskGeometry();
  let openerId = geo.ids[geo.primaryIndex];
  /** 其它屏的窗口：显示器 id → BrowserWindow（渲染端 window.open 出来的） */
  const children = new Map();
  /** 各窗口当前是否穿透（实际生效值） */
  const ignoring = new Map();
  /** 全屏让位中的窗口 */
  const concealed = new Set();
  /** 拖拽租约：显示器 id → 最近一次续约时间 */
  const dragLease = new Map();
  /** 开着菜单的窗口 */
  const menuOpen = new Set();
  /** 渲染端最近一次即时判定的时间 */
  const hintAt = new Map();
  /** 菜单/对话框矩形 [{display,x,y,width,height}] */
  let controls = [];
  /** 宠物 id → { display, body }（兜底命中判定用） */
  const pets = new Map();
  const links = new Map();
  const logs = new Map();
  let lastPetId = '';
  let fullScreenDisplays = [];

  const panelOf = (id) => {
    const i = geo.ids.indexOf(id);
    return i >= 0 ? geo.panels[i] : null;
  };
  const windowOptions = (bounds) => ({
    title: '小小桌宠',
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    useContentSize: true,
    // macOS 默认会把窗口的 y 钳到菜单栏下沿；宠物的头可以伸进菜单栏那一条，窗口要盖住整块屏
    enableLargerThanScreen: true,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    // 与每宠一窗相同：可聚焦（菜单要收到 Esc / 失焦事件），显示时用 showInactive 不抢焦点
    focusable: true,
  });

  const opener = new BrowserWindow({
    ...windowOptions(panelOf(openerId) || geo.hull),
    webPreferences: {
      preload: path.join(ctx.helperDir, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      paintWhenInitiallyHidden: false,
      spellcheck: false,
    },
  });

  const winFor = (id) => (id === openerId ? opener : children.get(id));
  const allWindows = () => {
    const list = [[openerId, opener]];
    for (const [id, win] of children) if (id !== openerId) list.push([id, win]);
    return list.filter(([, win]) => win && !win.isDestroyed());
  };
  const send = (channel, payload) => {
    if (!opener.isDestroyed()) opener.webContents.send(channel, payload);
  };
  const dragHeld = (id) => {
    const at = dragLease.get(id);
    return at !== undefined && Date.now() - at < DRAG_LEASE_MS;
  };

  function configure(win) {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // 整块屏大小的透明窗口出现在调度中心里没有意义（每宠一窗时调度中心里显示的是角色名的小窗口）
    if (typeof win.setHiddenInMissionControl === 'function') win.setHiddenInMissionControl(true);
    win.webContents.setBackgroundThrottling(false);
    win.webContents.on('context-menu', (event) => event.preventDefault());
    win.on('page-title-updated', (event) => event.preventDefault());
    win.setIgnoreMouseEvents(true, { forward: true });
  }

  /** 翻转某块屏窗口的穿透：唯一出口。全屏让位中的窗口一律穿透且不转发鼠标 */
  function setIgnore(id, ignore, force = false) {
    const win = winFor(id);
    if (!win || win.isDestroyed()) return;
    const value = concealed.has(id) ? true : !!ignore;
    if (!force && ignoring.get(id) === value) return;
    ignoring.set(id, value);
    if (concealed.has(id)) win.setIgnoreMouseEvents(true);
    else win.setIgnoreMouseEvents(value, { forward: true });
    send('pet:overlay-ignore', { display: id, ignore: value });
  }

  function evaluate(id, point) {
    const win = winFor(id);
    if (!win || win.isDestroyed()) return;
    const bodies = [];
    for (const pet of pets.values()) if (pet.display === id) bodies.push(pet.body);
    setIgnore(
      id,
      decideOverlayIgnore({
        point,
        bounds: win.getBounds(),
        bodies,
        controls: controls.filter((c) => c.display === id),
        dragging: dragHeld(id),
      }),
    );
  }

  function guardFullScreen(id) {
    const win = winFor(id);
    if (!win || win.isDestroyed()) return;
    const was = concealed.has(id);
    const hide = overlayConcealed({
      bounds: win.getBounds(),
      displays: fullScreenDisplays,
      busy: dragHeld(id) || menuOpen.has(id),
      concealed: was,
    });
    if (hide === was) return;
    if (hide) concealed.add(id);
    else concealed.delete(id);
    win.setOpacity(hide ? 0 : 1);
    if (hide) setIgnore(id, true, true);
    else evaluate(id, screen.getCursorScreenPoint());
  }

  configure(opener);
  ignoring.set(openerId, true);
  opener.on('show', () => guardFullScreen(openerId));
  opener.once('ready-to-show', () => opener.showInactive());
  // 同每宠一窗的 #55 兜底：paintWhenInitiallyHidden:false 时 ready-to-show 可能永远不来
  opener.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (!opener.isDestroyed() && !opener.isVisible()) opener.showInactive();
    }, 400);
  });
  opener.webContents.on('did-finish-load', () => opener.webContents.setZoomFactor(ctx.scale));
  opener.webContents.on('will-navigate', (event) => event.preventDefault());
  // 渲染进程没了：所有窗口都空了，而且可能停在「接收点击」上挡住整块屏。直接退出，宿主会重新拉起
  opener.webContents.on('render-process-gone', (_event, details) => {
    for (const log of logs.values()) log?.record('渲染进程退出', { reason: details.reason, exitCode: details.exitCode });
    console.error('[dsh-pet-desktop-helper] overlay renderer gone (' + details.reason + '); exiting for a restart');
    app.exit(1);
  });
  opener.on('unresponsive', () => {
    for (const log of logs.values()) log?.record('窗口无响应');
  });
  opener.on('responsive', () => {
    for (const log of logs.values()) log?.record('窗口恢复响应');
  });

  // 其它屏的窗口：只认 about:blank + 我们的窗口名，按显示器 id 摆到那块屏上
  opener.webContents.setWindowOpenHandler(({ url, frameName }) => {
    const m = FRAME_NAME.exec(frameName || '');
    if (url !== 'about:blank' || !m) return { action: 'deny' };
    const id = Number(m[1]);
    const panel = panelOf(id);
    if (!panel || id === openerId || children.has(id)) return { action: 'deny' };
    return { action: 'allow', overrideBrowserWindowOptions: windowOptions(panel) };
  });
  opener.webContents.on('did-create-window', (win, details) => {
    const m = FRAME_NAME.exec(details.frameName || '');
    if (!m) {
      win.destroy();
      return;
    }
    const id = Number(m[1]);
    children.set(id, win);
    configure(win);
    ignoring.set(id, true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    const panel = panelOf(id);
    if (panel) win.setBounds(panel);
    win.showInactive();
    guardFullScreen(id);
    win.on('closed', () => {
      if (children.get(id) !== win) return;
      children.delete(id);
      if (id !== openerId) {
        ignoring.delete(id);
        concealed.delete(id);
        dragLease.delete(id);
        hintAt.delete(id);
      }
    });
  });

  // ---------- 渲染端消息（只认本页面发来的） ----------
  const fromPage = (event) => event.sender === opener.webContents;

  ipcMain.on('pet:overlay-hint', (event, msg) => {
    if (!fromPage(event) || !msg || !winFor(msg.display)) return;
    hintAt.set(msg.display, Date.now());
    setIgnore(msg.display, dragHeld(msg.display) ? false : !msg.on);
  });

  ipcMain.on('pet:overlay-busy', (event, list) => {
    if (!fromPage(event) || !Array.isArray(list)) return;
    const now = Date.now();
    const drags = new Set();
    menuOpen.clear();
    for (const b of list) {
      if (b && b.drag) drags.add(b.display);
      if (b && b.menu) menuOpen.add(b.display);
    }
    for (const id of [...dragLease.keys()]) if (!drags.has(id)) dragLease.delete(id);
    for (const id of drags) dragLease.set(id, now);
    const point = screen.getCursorScreenPoint();
    for (const [id] of allWindows()) {
      if (dragHeld(id)) setIgnore(id, false);
      else evaluate(id, point);
      guardFullScreen(id); // 拖拽/菜单期间推迟的让位在这里补上
    }
  });

  ipcMain.on('pet:overlay-controls', (event, list) => {
    if (!fromPage(event) || !Array.isArray(list)) return;
    controls = list.filter(
      (r) => r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0,
    );
  });

  ipcMain.on('pet:overlay-states', (event, list) => {
    if (!fromPage(event) || !Array.isArray(list)) return;
    for (const s of list) {
      if (!s || typeof s.id !== 'string') continue;
      const state = {};
      for (const key of ['x', 'y', 'vx', 'vy', 'size', 'bottomPad']) state[key] = Number(s[key]);
      const b = s.body || {};
      const body = { x: Number(b.x), y: Number(b.y), width: Number(b.width), height: Number(b.height) };
      if (!Object.values(state).every(Number.isFinite) || !Object.values(body).every(Number.isFinite)) continue;
      pets.set(s.id, { display: s.display, body });
      linkFor(s.id)?.publish({
        ...state,
        enabled: s.enabled === true,
        flying: s.flying === true,
        held: s.held === true,
      });
    }
  });

  ipcMain.on('pet:overlay-pets', (event, list) => {
    if (!fromPage(event) || !Array.isArray(list)) return;
    const ids = new Set();
    for (const pet of list) {
      if (!pet || typeof pet.id !== 'string' || !pet.id) continue;
      ids.add(pet.id);
      if (!logs.has(pet.id)) logs.set(pet.id, createLog(pet));
      linkFor(pet.id);
    }
    for (const [id, log] of logs) {
      if (ids.has(id)) continue;
      log?.stop();
      logs.delete(id);
    }
    for (const [id, link] of links) {
      if (ids.has(id)) continue;
      link.close();
      links.delete(id);
    }
    for (const id of [...pets.keys()]) if (!ids.has(id)) pets.delete(id);
  });

  ipcMain.on('pet:overlay-focus', (event, id) => {
    if (fromPage(event) && typeof id === 'string') lastPetId = id;
  });

  function createLog(pet) {
    try {
      const log = ctx.createRoleLogger({ entry: pet.id, petId: pet.id, name: pet.name || pet.id, watchChanges: false });
      log.start();
      return log;
    } catch (error) {
      console.error('[pet-log] setup failed: ' + error.message);
      return null;
    }
  }

  function linkFor(id) {
    if (links.has(id)) return links.get(id);
    try {
      const link = ctx.connectRole({
        id,
        onHit: (hit) => send('pet:overlay-hit', { ...hit, petId: id }),
        onStatus: (connected) => logs.get(id)?.record('碰撞通信状态', { connected }),
      });
      links.set(id, link);
      return link;
    } catch (error) {
      console.error('[collision] link failed: ' + error.message);
      return null;
    }
  }

  // ---------- 定时：兜底命中判定 / 置顶看门狗 / 播放状态快照 ----------
  const pollTimer = setInterval(() => {
    if (ctx.isPaused()) return;
    const point = screen.getCursorScreenPoint();
    const now = Date.now();
    for (const [id] of allWindows()) {
      if (now - (hintAt.get(id) || 0) < HINT_PRIORITY_MS) continue;
      if (dragLease.has(id) && !dragHeld(id)) {
        // 租约过期（页面卡住或丢了松手）：清掉，补一次全屏让位
        dragLease.delete(id);
        guardFullScreen(id);
      }
      evaluate(id, point);
    }
  }, OVERLAY_POLL_MS);

  const lastAssert = new WeakMap();
  const topmostTimer = setInterval(() => {
    const nowMs = Date.now();
    for (const [, win] of allWindows()) {
      if (!lastAssert.has(win)) lastAssert.set(win, nowMs);
      const due = shouldReassertTopmost({
        nowMs,
        lastAssertMs: lastAssert.get(win),
        destroyed: win.isDestroyed(),
        visible: win.isVisible(),
        paused: ctx.isPaused(),
      });
      if (!due) continue;
      lastAssert.set(win, nowMs);
      win.setAlwaysOnTop(true, 'screen-saver');
    }
  }, TOPMOST_WATCHDOG_TICK_MS);

  let capturing = false;
  const lastStates = new Map();
  const stalled = new Set();
  const capture = async () => {
    if (capturing || opener.isDestroyed()) return;
    capturing = true;
    let timeout;
    try {
      const list = await Promise.race([
        opener.webContents.executeJavaScript(
          `(() => typeof sprites === 'undefined' ? [] : sprites.map(s => { const v = s.front === 0 ? s.videoA : s.videoB; return { id:s.pet.id, display:s.overlay ? s.overlay.id : null, animation:s.anim, pending:s.pending?.anim || null, videoWidth:v?.videoWidth, videoHeight:v?.videoHeight, petSize:s.size, time:v?.currentTime, duration:Number.isFinite(v?.duration) ? v.duration : null, paused:v?.paused, ended:v?.ended, readyState:v?.readyState, error:v?.error ? {code:v.error.code,message:v.error.message} : null, dragging:s.dragState?.active, recoveries:s.playbackRecoveries || 0, lastRecovery:s.lastPlaybackRecovery || null }; }))()`,
        ),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(Error('renderer snapshot timeout')), 3000);
        }),
      ]);
      for (const state of list) {
        const log = logs.get(state.id);
        if (!log) continue;
        log.record('播放状态', [state]);
        const last = lastStates.get(state.id);
        const frozen =
          last && state.animation === last.animation && state.time === last.time && !state.dragging && !state.pending;
        if (frozen && !stalled.has(state.id)) log.record('播放疑似停滞', state);
        if (frozen) stalled.add(state.id);
        else stalled.delete(state.id);
        lastStates.set(state.id, state);
      }
    } catch (error) {
      for (const log of logs.values()) log?.record('状态读取失败', { 错误: error.message });
    } finally {
      clearTimeout(timeout);
      capturing = false;
    }
  };
  const captureTimer = setInterval(capture, 30000);
  captureTimer.unref?.();
  opener.webContents.once('did-finish-load', () => setTimeout(capture, 2000));

  opener.on('closed', () => {
    clearInterval(pollTimer);
    clearInterval(topmostTimer);
    clearInterval(captureTimer);
    for (const link of links.values()) link.close();
    for (const log of logs.values()) log?.stop();
    // 其它屏的窗口没有自己的页面逻辑，留着只会是几块空的整屏窗口
    app.quit();
  });

  // ---------- 每宠一窗时存下的位置（只在第一次进本模式时读；结果缓存进本模式自己的 userData） ----------
  let legacy = null;
  ipcMain.handle('pet:legacy-positions', (event) => {
    if (!fromPage(event)) return { positions: {}, complete: false };
    legacy ??= readLegacyPositions().catch((error) => {
      console.error('[dsh-pet-desktop-helper] legacy positions:', error && error.message ? error.message : error);
      return { positions: {}, complete: false };
    });
    return legacy;
  });

  /** → { positions: { petId: {rx, ry} }, complete }；complete=false（有 profile 没读成）时不缓存，下次启动再读 */
  async function readLegacyPositions() {
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
      names = readdirSync(appData).filter((name) => name.startsWith(LEGACY_PREFIX));
    } catch {
      /* 没有旧 profile */
    }
    for (const name of names) {
      const dir = path.join(appData, name);
      if (!existsSync(path.join(dir, 'Local Storage'))) continue;
      try {
        Object.assign(positions, await readProfile(dir));
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

  /** 旧 profile 的 localStorage（file:// 源）→ { petId: {rx, ry} } */
  async function readProfile(dir) {
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
      await limit(win.loadFile(path.join(ctx.helperDir, 'blank.html')), 5000);
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

  opener
    .loadFile(path.join(ctx.helperDir, 'index.html'), {
      query: {
        ...ctx.pageQuery(geo),
        overlay: '1',
        ids: JSON.stringify(geo.ids),
        openerId: String(openerId),
      },
    })
    .catch((error) => {
      console.error('[dsh-pet-desktop-helper] overlay page load failed:', error);
      app.exit(1);
    });

  return {
    /** 显示器变化：本页窗口跟主屏走，其它屏的窗口换位置（拔掉的屏的窗口由页面自己关） */
    onDisplays(next) {
      geo = next;
      const nextOpener = geo.ids[geo.primaryIndex];
      if (nextOpener !== openerId) {
        for (const id of [openerId, nextOpener]) {
          ignoring.delete(id);
          concealed.delete(id);
          dragLease.delete(id);
          hintAt.delete(id);
        }
        // 新主屏上原来那个子窗口马上会被页面关掉；关之前先让它彻底穿透
        const clash = children.get(nextOpener);
        if (clash && !clash.isDestroyed()) clash.setIgnoreMouseEvents(true);
        openerId = nextOpener;
        opener.setOpacity(1);
      }
      const panel = panelOf(openerId);
      if (panel) opener.setBounds(panel);
      for (const [id, win] of children) {
        const p = panelOf(id);
        if (p && id !== openerId && !win.isDestroyed()) win.setBounds(p);
      }
      send('pet:displays', { ...geo, openerId });
      setIgnore(openerId, true, true);
      for (const [id] of allWindows()) guardFullScreen(id);
    },
    onFullScreen(displays) {
      fullScreenDisplays = displays;
      for (const [id] of allWindows()) guardFullScreen(id);
    },
    lastPetId: () => lastPetId,
    logFor: (petId) => (typeof petId === 'string' ? logs.get(petId) || null : null),
    windows: () => allWindows().map(([, win]) => win),
  };
}

module.exports = { startOverlay, OVERLAY_POLL_MS };
