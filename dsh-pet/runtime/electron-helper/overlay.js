/**
 * little-pet-mac 单窗口模式（overlay，macOS）—— 渲染端。
 *
 * 每宠一窗时，每只宠物是一个独立的 Electron 进程 + 一个跟着宠物移动的小窗口。单窗口模式下所有宠物
 * 都在**本页面**里：每块显示器一个全屏透明窗口，宠物只是窗口里的一个元素，移动 = 改 CSS transform，
 * 不再移动系统窗口。
 *
 * 为什么每块屏一个窗口：macOS 默认开着「显示器具有单独的空间」，一个窗口跨两块屏时只画在占比大的
 * 那块上。本页面自己的窗口盖住主进程指定的那块屏（OPENER_DISPLAY_ID，一般是主屏）；别的屏要用时才
 * 用 window.open('about:blank') 开一个同源子窗口——子窗口与本页同一个渲染进程、同一个 JS 环境，
 * 宠物元素可以直接搬过去，宠物对象和它的全部状态（动作、拖拽、计时器）都不用重建。
 *
 * 搬家的代价：Chromium 把 <video> 移进另一个 document 时会重新加载片源（currentTime 归零、画面清空）。
 * 所以搬之前把当前帧画到目标窗口里的一个 canvas 上顶着，片源重新加载后跳回原来的时间点，出了新的
 * 一帧再撤掉 canvas。
 *
 * 输入：窗口默认整窗穿透。光标在某只宠物的身体命中区、或右键菜单上时才接收点击；拖拽中，按下时所在的
 * 那个窗口一直接收输入（macOS 把拖拽中的鼠标事件一直发给按下时的窗口，跨屏也一样）。判定在两处做、
 * 规则相同：这里按转发进来的 mousemove 即时判定（overlayHint），主进程按真实光标每 60ms 兜底一次
 * （pointer-target.js 的 decideOverlayIgnore，用这里上报的身体矩形与菜单矩形）。
 *
 * 依赖 constants.js 的全局（CONFIG / VIEW / PANELS / DISPLAY_IDS / OPENER_DISPLAY_ID / rootEl / sprites），
 * 先于 sprite.js 加载；只在 CONFIG.overlay 为真时启用（Overlay 为 null 时 sprite.js 走每宠一窗的老路径）。
 */
'use strict';

const Overlay = CONFIG.overlay ? createOverlay() : null;

function createOverlay() {
  /** 位置写入间隔下限：每秒至多 60 次（拖拽刷新率是用户定的 60/s；120Hz 屏上隔一帧写一次） */
  const PLACE_INTERVAL_MS = 15.5;
  /** 拖拽中给主进程的心跳：主进程的拖拽租约 3 秒没续就当作松手（页面卡死时不会挡住整块屏） */
  const DRAG_HEARTBEAT_MS = 1000;
  /** 搬家时顶替视频的冻结帧最长留多久（片源异常时也不会一直挂着） */
  const FREEZE_MAX_MS = 1500;
  const bridge = window.petBridge || null;

  /** displayId → { id, win, doc, root, copied:WeakSet, ac, last:{x,y}|null, hint:boolean|null } */
  const entries = new Map();
  const opener = makeEntry(OPENER_DISPLAY_ID, window, document, rootEl);
  entries.set(opener.id, opener);

  // 本模式专用样式：宠物元素常驻合成层（只改 transform，不重排不重绘）；冻结帧与视频同位。
  const style = document.createElement('style');
  style.dataset.overlay = '1';
  style.textContent =
    '.pet-sprite{will-change:transform}' +
    'canvas.pet-freeze{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none}';
  document.head.appendChild(style);

  function makeEntry(id, win, doc, root) {
    const entry = { id, win, doc, root, copied: new WeakSet(), ac: new AbortController(), last: null, hint: null };
    installHooks(entry);
    return entry;
  }

  /** 把本页 <head> 里的样式补进子窗口（只补还没复制过的；运行中新注入的样式下次调用时补上） */
  function syncStyles(entry) {
    if (entry === opener) return;
    for (const el of document.head.querySelectorAll('style')) {
      if (entry.copied.has(el)) continue;
      entry.copied.add(el);
      entry.doc.head.appendChild(el.cloneNode(true));
    }
  }

  function openChild(id) {
    let win = null;
    try {
      win = window.open('about:blank', 'dsh-pet-overlay-' + id, '');
    } catch (error) {
      console.warn('[dsh-pet] overlay window for display ' + id + ' failed:', error);
    }
    if (!win || !win.document || !win.document.body) return null;
    const doc = win.document;
    doc.title = document.title;
    const root = doc.createElement('div');
    root.id = 'root';
    doc.body.appendChild(root);
    const entry = makeEntry(id, win, doc, root);
    syncStyles(entry);
    entries.set(id, entry);
    return entry;
  }

  function closeChild(entry) {
    if (entry === opener || entries.get(entry.id) !== entry) return;
    entries.delete(entry.id);
    for (const s of sprites) if (s.overlay === entry) move(s, opener);
    entry.ac.abort();
    try {
      entry.win.close();
    } catch {
      /* 已经关了 */
    }
  }

  function entryFor(id, create) {
    if (id === null || id === undefined) return null;
    if (id === opener.id) return opener;
    return entries.get(id) || (create ? openChild(id) : null);
  }

  /** 某块屏的完整面板（视口坐标，与 PANELS 同系） */
  function panelOf(id) {
    const i = DISPLAY_IDS.indexOf(id);
    return i >= 0 ? PANELS[i] : null;
  }

  /** 视口坐标 → 所在显示器 id（落在屏与屏之间的空洞里 → null） */
  function displayAt(x, y) {
    for (let i = 0; i < PANELS.length; i++) {
      const p = PANELS[i];
      if (x >= p.x && x < p.x + p.width && y >= p.y && y < p.y + p.height) return DISPLAY_IDS[i];
    }
    return null;
  }

  /** 宠物身体命中区（视口坐标）：与点击判定、全屏让位同一个框 */
  function bodyOf(s) {
    return { x: s.pos.x + s.hitRect.x, y: s.pos.y + s.hitRect.y, w: s.hitRect.w, h: s.hitRect.h };
  }

  function inBody(s, x, y) {
    const b = bodyOf(s);
    return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
  }

  // ---------- 摆放：宠物归身体中心所在那块屏的窗口；位置写入每秒至多 60 次 ----------
  const pendingPlace = new Set();
  const pendingReport = new Set();
  let flushRaf = 0;
  let lastFlush = 0;

  function place(s) {
    if (!s.overlay) {
      // 首次摆放同步完成：不让宠物在主屏左上角闪一帧
      apply(s);
      pendingReport.add(s);
      schedule();
      return;
    }
    pendingPlace.add(s);
    schedule();
  }

  function schedule() {
    if (!flushRaf) flushRaf = requestAnimationFrame(flush);
  }

  function flush(now) {
    flushRaf = 0;
    if (pendingPlace.size && now - lastFlush < PLACE_INTERVAL_MS) {
      schedule();
      return;
    }
    if (pendingPlace.size) lastFlush = now;
    for (const s of pendingPlace) {
      if (s.disposed) continue;
      apply(s);
      pendingReport.add(s);
    }
    pendingPlace.clear();
    report();
  }

  function apply(s) {
    const b = bodyOf(s);
    const want = displayAt(b.x + b.w / 2, b.y + b.h / 2);
    let entry = s.overlay;
    if (want !== null && (!entry || want !== entry.id)) entry = entryFor(want, true) || entry;
    if (!entry) entry = opener;
    if (entry !== s.overlay) move(s, entry);
    const panel = panelOf(entry.id) || { x: 0, y: 0 };
    s.el.style.transform = 'translate3d(' + (s.pos.x - panel.x) + 'px,' + (s.pos.y - panel.y) + 'px,0)';
  }

  // ---------- 搬家：元素移进另一块屏的窗口 ----------
  /** 搬家次数（帧率探针用：卡顿是否集中在跨屏时） */
  let migrations = 0;
  function move(s, entry) {
    const from = s.overlay;
    syncStyles(entry);
    if (!from) {
      entry.root.appendChild(s.el);
      s.overlay = entry;
      return;
    }
    const front = s.front === 0 ? s.videoA : s.videoB;
    const back = front === s.videoA ? s.videoB : s.videoA;
    const freeze = freezeFrame(front, entry.doc);
    // 后台那条视频是上一个动作（已暂停、看不见）：不跟着重载，清掉片源省一次解码器重建，
    // 下次切动作时 switchTo 会给它设新片源。正在加载下一个动作（pending）时它马上要上前台，照常重载。
    if (back && !s.pending && back.getAttribute('src')) {
      back.onended = null;
      back.onerror = null;
      back.removeAttribute('src');
      back.load();
    }
    const videos = [s.videoA, s.videoB].map((v) => ({
      v,
      time: v.currentTime,
      playing: !v.paused && !v.ended,
      front: v === front,
    }));
    migrations += 1;
    if (s.menuOpen) s.closeMenu(); // 菜单挂在旧窗口里，跟不过去
    // 拖拽中搬家：元素离开按下时的 document，指针捕获随之失效（之后 lostpointercapture 不算松手，
    // 指针事件由按下时那个窗口的 window 级监听转交，见 installHooks）
    if (s.dragState.active) s.captureLost = true;
    entry.root.appendChild(s.el);
    s.overlay = entry;
    if (freeze) s.stage.insertBefore(freeze, s.hit);
    for (const item of videos) resumeVideo(item, item.front ? freeze : null);
    refreshHint(from);
    refreshHint(entry);
    syncBusy();
  }

  /** 当前帧 → 目标窗口里的 canvas（样式照抄视频：脚底对齐的位置尺寸、朝向镜像） */
  function freezeFrame(video, doc) {
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
    try {
      const canvas = doc.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      canvas.className = 'pet-freeze';
      canvas.style.cssText = video.style.cssText;
      return canvas;
    } catch {
      return null;
    }
  }

  /** 片源重新加载后跳回原来的时间点、接着播；新帧出来再撤冻结帧 */
  function resumeVideo({ v, time, playing }, freeze) {
    let removed = false;
    const unfreeze = () => {
      if (removed || !freeze) return;
      removed = true;
      freeze.remove();
    };
    if (freeze) window.setTimeout(unfreeze, FREEZE_MAX_MS);
    if (!v.getAttribute('src')) {
      unfreeze();
      return;
    }
    const onMeta = () => {
      v.removeEventListener('loadedmetadata', onMeta);
      if (time > 0 && Number.isFinite(v.duration) && time < v.duration) {
        try {
          v.currentTime = time;
        } catch {
          /* 片源不支持跳转：从头播 */
        }
      }
      if (playing) v.play().catch(() => {});
      if (freeze) {
        if (typeof v.requestVideoFrameCallback === 'function') v.requestVideoFrameCallback(unfreeze);
        else v.addEventListener('seeked', unfreeze, { once: true });
      }
    };
    if (v.readyState >= 1) onMeta();
    else v.addEventListener('loadedmetadata', onMeta);
    if (playing) v.play().catch(() => {});
  }

  // ---------- 状态上报：位置/身体矩形（主进程兜底命中判定 + 碰撞 broker 用），物理像素 ----------
  function report() {
    if (!pendingReport.size || !bridge || !bridge.overlayStates) {
      pendingReport.clear();
      return;
    }
    const list = [];
    for (const s of pendingReport) {
      if (s.disposed || !s.overlay) continue;
      const fly = s.throwState;
      const b = bodyOf(s);
      list.push({
        id: s.pet.id,
        display: s.overlay.id,
        x: toScreen(s.pos.x + VIEW.x),
        y: toScreen(s.pos.y + VIEW.y),
        size: toScreen(s.size),
        bottomPad: toScreen(s.bottomPad),
        vx: fly ? toScreen(fly.vx) : 0,
        vy: fly ? toScreen(fly.vy) : 0,
        enabled: !!(s.physics && s.physics.petCollision),
        flying: !!fly,
        held: s.dragState.active,
        body: { x: toScreen(b.x + VIEW.x), y: toScreen(b.y + VIEW.y), width: toScreen(b.w), height: toScreen(b.h) },
      });
    }
    pendingReport.clear();
    if (list.length) bridge.overlayStates(list);
  }

  // ---------- 输入：命中提示 / 忙碌租约 / 菜单矩形 ----------
  /** 按这块屏上次的光标位置重新判定一次「要不要接收点击」，变了才告诉主进程 */
  function refreshHint(entry) {
    if (!entry || entries.get(entry.id) !== entry) return;
    let on = sprites.some((s) => s.dragState.active && s.dragOverlay === entry);
    const panel = panelOf(entry.id);
    if (!on && entry.last && panel) {
      const x = entry.last.x + panel.x;
      const y = entry.last.y + panel.y;
      on = sprites.some((s) => s.overlay === entry && inBody(s, x, y));
      if (!on && sprites.some((s) => s.overlay === entry && (s.menuOpen || s.chatOpen))) {
        on = controlAt(entry, entry.last.x, entry.last.y);
      }
    }
    window.__dshPetDebug.interactive = on;
    if (on === entry.hint) return;
    entry.hint = on;
    if (bridge && bridge.overlayHint) bridge.overlayHint(entry.id, on);
  }

  function controlAt(entry, x, y) {
    for (const el of entry.doc.querySelectorAll('.dsh-pet-menu-column, .dsh-pet-chat')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) return true;
    }
    return false;
  }

  let busyKey = '';
  let busyList = [];
  let heartbeat = 0;
  function syncBusy() {
    const list = [];
    for (const entry of entries.values()) {
      list.push({
        display: entry.id,
        drag: sprites.some((s) => s.dragState.active && s.dragOverlay === entry),
        menu: sprites.some((s) => s.overlay === entry && (s.menuOpen || s.chatOpen)),
      });
    }
    const dragging = list.some((b) => b.drag);
    window.__dshPetDebug.inputBusy = list.some((b) => b.drag || b.menu);
    const key = JSON.stringify(list);
    if (key !== busyKey) {
      busyKey = key;
      busyList = list;
      if (bridge && bridge.overlayBusy) bridge.overlayBusy(list);
    }
    if (dragging && !heartbeat) {
      heartbeat = window.setInterval(() => bridge && bridge.overlayBusy && bridge.overlayBusy(busyList), DRAG_HEARTBEAT_MS);
    } else if (!dragging && heartbeat) {
      window.clearInterval(heartbeat);
      heartbeat = 0;
    }
    syncControls();
  }

  let controlsKey = '';
  const controlResize = new ResizeObserver(() => syncControls());
  const observed = new Set();
  function syncControls() {
    const list = [];
    const seen = new Set();
    for (const entry of entries.values()) {
      const panel = panelOf(entry.id);
      if (!panel) continue;
      for (const el of entry.doc.querySelectorAll('.dsh-pet-menu-column, .dsh-pet-chat')) {
        seen.add(el);
        if (!observed.has(el)) {
          observed.add(el);
          controlResize.observe(el);
        }
        const r = el.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) continue;
        list.push({
          display: entry.id,
          x: toScreen(r.x + panel.x + VIEW.x),
          y: toScreen(r.y + panel.y + VIEW.y),
          width: toScreen(r.width),
          height: toScreen(r.height),
        });
      }
    }
    for (const el of observed) {
      if (seen.has(el)) continue;
      observed.delete(el);
      controlResize.unobserve(el);
    }
    const key = JSON.stringify(list);
    if (key === controlsKey) return;
    controlsKey = key;
    if (bridge && bridge.overlayControls) bridge.overlayControls(list);
  }

  /** 每个窗口的 window 级监听：转发的 mousemove、拖拽收尾、失焦、防息屏 */
  function installHooks(entry) {
    const { win, doc } = entry;
    const opt = { signal: entry.ac.signal };
    // 不阻止息屏（同 renderer.js）：子窗口里的视频事件不经过本页 window，得在每个窗口各截一次
    win.addEventListener(
      'playing',
      (event) => {
        if (event.target && event.target.tagName === 'VIDEO') event.stopImmediatePropagation();
      },
      { capture: true, signal: entry.ac.signal },
    );
    win.addEventListener(
      'mousemove',
      (e) => {
        // 拖拽中却没有任何按键按着：pointerup 全丢了（例如在另一个窗口松的手），就地按松手收尾
        for (const s of sprites) if (s.dragState.active && e.buttons === 0) s.onPointerUp(e);
        entry.last = { x: e.clientX, y: e.clientY };
        if (sprites.some((s) => s.overlay === entry && (s.menuOpen || s.chatOpen))) syncControls();
        refreshHint(entry);
      },
      opt,
    );
    // 指针捕获失效后（拖拽中搬家），拖拽事件仍发到按下时的窗口：转交给正在拖的宠物
    win.addEventListener(
      'pointermove',
      (e) => {
        for (const s of sprites) {
          if (s.dragState.active && s.dragOverlay === entry && !s.hit.contains(e.target)) s.onPointerMove(e);
        }
      },
      opt,
    );
    const release = (e) => {
      for (const s of sprites) if (s.dragState.active && (s.dragOverlay === entry || !s.dragOverlay)) s.onPointerUp(e);
    };
    win.addEventListener('pointerup', release, opt);
    win.addEventListener('pointercancel', release, opt);
    win.addEventListener(
      'blur',
      () => {
        // 切到其它应用：收起这块屏上的菜单；丢了松手事件的拖拽也收尾
        for (const s of sprites) {
          if (s.overlay === entry) s.closeMenu();
          if (s.dragState.active && s.dragOverlay === entry) s.onPointerUp();
        }
        entry.last = null;
        refreshHint(entry);
      },
      opt,
    );
    // 菜单挂载/卸载（菜单根节点直接挂在 body 下）
    const mounts = new MutationObserver(() => syncControls());
    mounts.observe(doc.body, { childList: true });
    entry.ac.signal.addEventListener('abort', () => mounts.disconnect());
  }

  // ---------- 显示器变化：本页窗口换屏、多余的子窗口关掉（宠物先搬回本页） ----------
  function onDisplays() {
    if (OPENER_DISPLAY_ID !== opener.id) {
      const clash = entries.get(OPENER_DISPLAY_ID);
      if (clash && clash !== opener) closeChild(clash);
      entries.delete(opener.id);
      opener.id = OPENER_DISPLAY_ID;
      entries.set(opener.id, opener);
      opener.hint = null;
    }
    for (const entry of [...entries.values()]) {
      if (entry !== opener && !DISPLAY_IDS.includes(entry.id)) closeChild(entry);
    }
    for (const entry of entries.values()) {
      entry.last = null;
      refreshHint(entry);
    }
    syncBusy();
  }

  // ---------- 宠物登记：主进程按它建角色日志与碰撞连接 ----------
  let petsKey = '';
  function syncPets() {
    const list = sprites.map((s) => ({ id: s.pet.id, name: s.pet.name || s.pet.id, assetRoot: s.assetRoot }));
    const key = JSON.stringify(list);
    if (key === petsKey) return;
    petsKey = key;
    if (bridge && bridge.overlayPets) bridge.overlayPets(list);
  }

  function detach(s) {
    pendingPlace.delete(s);
    pendingReport.delete(s);
    const entry = s.overlay;
    s.overlay = null;
    if (entry) refreshHint(entry);
    syncBusy();
  }

  function focus(s) {
    if (bridge && bridge.overlayFocus) bridge.overlayFocus(s.pet.id);
  }

  // 主进程告诉我们窗口的真实穿透状态（兜底轮询也会翻它）：去重基准以它为准，否则两条通道会失步
  if (bridge && bridge.onOverlayIgnore) {
    bridge.onOverlayIgnore((msg) => {
      const entry = msg && entries.get(msg.display);
      if (entry) entry.hint = !msg.ignore;
    });
  }
  // 碰撞 broker 的「你被撞了」：按宠物 id 分发（一页多宠，不能每只都收）
  if (bridge && bridge.onOverlayHit) {
    bridge.onOverlayHit((payload) => {
      const s = payload && sprites.find((x) => x.pet.id === payload.petId);
      const vx = Number(payload && payload.vx);
      const vy = Number(payload && payload.vy);
      if (!s || !Number.isFinite(vx) || !Number.isFinite(vy)) return;
      s.logRuntime('角色碰撞', { peer: String(payload.peer || ''), vx, vy, dx: Number(payload.dx) || 0, dy: Number(payload.dy) || 0 });
      s.onDeskHit(toLocal(vx), toLocal(vy), toLocal(Number(payload.dx) || 0), toLocal(Number(payload.dy) || 0));
    });
  }

  /**
   * 每宠一窗时各宠物的位置存在各自 helper 的 localStorage 里；第一次进单窗口模式时主进程把它们读出来，
   * 这里补进本页的 localStorage（已有记录的不覆盖），之后不再导入。
   */
  async function importLegacyPositions() {
    const MARK = 'dsh-pet-legacy-positions-imported';
    try {
      if (localStorage.getItem(MARK) || !bridge || !bridge.legacyPositions) return;
      const legacy = await bridge.legacyPositions();
      for (const [id, pos] of Object.entries((legacy && legacy.positions) || {})) {
        const key = POS_KEY_PREFIX + id;
        if (localStorage.getItem(key) === null && pos && Number.isFinite(pos.rx) && Number.isFinite(pos.ry)) {
          localStorage.setItem(key, JSON.stringify({ rx: pos.rx, ry: pos.ry }));
        }
      }
      // 有旧 profile 没读成（比如旧进程还没退干净）就不打标记，下次启动再试
      if (legacy && legacy.complete) localStorage.setItem(MARK, String(Date.now()));
    } catch (error) {
      console.warn('[dsh-pet] legacy positions import failed:', error);
    }
  }

  return {
    place,
    detach,
    focus,
    refreshHint,
    syncBusy,
    syncControls,
    syncPets,
    onDisplays,
    importLegacyPositions,
    panelOf,
    get opener() {
      return opener;
    },
    get entries() {
      return entries;
    },
    get migrations() {
      return migrations;
    },
  };
}
