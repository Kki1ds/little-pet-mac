/**
 * dsh-pet desktop helper renderer —— 启动入口。
 *
 * 依赖链（index.html 顺序加载）：shared-core.js → constants.js → sprite.js →
 * events.js → renderer.js（本文件）。本文件只做：配置加载 / 错误处理 / 启动装配 / 素材注入。
 *
 * 与浏览器 overlay 严格对齐（宠物行为/文案完全一致）：
 *   - 纯逻辑（常量/选择器/移动几何/余额折算/拍平）来自 shared-core.js
 *     （= src/shared 的构建产物，window.PetShared）——与浏览器 bundle 共用同一份源码；
 *   - 配置唯一来源 = 宿主 /dsh-pet-7340/config 的**成品聚合**（host readAllConfig 合并，
 *     绝对正确、字段填满）：一步 fetch → S.flattenConfigPets 拍平，加载失败**大声报错**
 *     并显示红色错误条（每 5s 自动重试），绝无静默兜底池；
 *   - 动画素材经宿主 /dsh-pet-7340/thumb/<素材根>/<name>.<webm|mov>（素材根 = 条目 key；扩展名由共享常量 ANIMATION_EXT 决定）；
 *   - 几何模型：窗口 = 宠物包围盒 + 四周外扩余量（WINDOW_MARGIN_RATIO，为气泡/弹窗预留空间）。
 *     sprite 固定在窗口内 (margin.l, margin.t) 处，宠物的"移动"由本页把目标屏幕位置
 *     逐帧上报（petBridge.setBounds）→ 主进程按 sprite 位置 + 外扩余量移动窗口；
 *     视口 = 全部显示器工作区外接矩形（workAreaX/Y/W/H 由主进程注入），漫游/抛掷/角落/位置换算
 *     都跨屏（#43，宠物可被甩/拖到其它显示器）；单显示器时即主屏工作区，行为不变。
 *     外扩区透明且点击穿透（只有身体命中区可交互），不挡下层应用。
 *   - 右键级联菜单（与浏览器共用同一份组件：树+渲染+样式来自 shared-core 的 menu 模块）：
 *     右键宠物弹出，桌面端工具根项「打开网站 / 打开 DeepSeek Harness（宿主是 DSH 桌面应用时的同一项）/ 查看余额 / 回到初始位置 / 重载配置」+ 动作点播；
 *     菜单开启期间整窗保持可交互（悬停菜单不触发穿透翻转），关闭/离开窗口即恢复穿透。
 *   - 系统通知不是宠物行为（浏览器半侧 notify.ts 负责），桌面端不重复实现。
 */
'use strict';

// ---------- 不阻止息屏/睡眠 ----------
// Chromium 对「正在播放、可见、占视口 20% 以上」的 <video> 会自动申请 Video Wake Lock（macOS 上是
// PreventUserIdleDisplaySleep 断言），静音也照样申请；宠物视频几乎铺满自己的小窗，于是每个宠物进程
// 都会让显示器永不息屏、系统也不会闲置睡眠。这把锁只在收到 video 的 playing 事件后才申请，故在 window
// 捕获阶段截住它，播放本身不受影响（本页没有别的 playing 监听）。验证：pmset -g assertions 里不再有
// "Video Wake Lock"。
window.addEventListener(
  'playing',
  (event) => {
    if (event.target instanceof HTMLVideoElement) event.stopImmediatePropagation();
  },
  true,
);

// ---------- 配置（大声报错；失败 5s 重试） ----------
function showError(message) {
  console.error('[dsh-pet] ' + message);
  window.__dshPetDebug.configOk = false;
  errorEl.textContent = 'dsh-pet 配置错误：' + message;
  errorEl.classList.add('visible');
}
function hideError() {
  errorEl.classList.remove('visible');
  errorEl.textContent = '';
}
function scheduleReboot() {
  if (bootTimer) return;
  bootTimer = setTimeout(() => {
    bootTimer = null;
    void boot();
  }, 5000);
}

async function loadConfig() {
  // 唯一配置入口：宿主 /config 的成品聚合（host readAllConfig 已合并并保证绝对正确），
  // 一步拉取 → 拍平成渲染列表，零校验零兜底
  const res = await fetch(BASE + '/config', { cache: 'no-store' });
  if (!res.ok) throw new Error(`config http ${res.status}`);
  const merged = await res.json();
  return {
    pets: S.flattenConfigPets(merged),
    // 拖拽抛掷物理参数（顶层全局，所有宠物共用；合并器已填内置默认）
    physics: (merged && merged.main && merged.main.physics) || S.DEFAULT_PHYSICS,
    // 抛掷锁定在当前屏幕（根字段；合并器已填内置默认 false）
    confineToScreen: (merged && merged.main && merged.main.confineToScreen) === true,
  };
}

// ---------- 启动（配置校验通过才建 sprite；失败大声报错 + 5s 自动重试） ----------
async function boot() {
  try {
    const cfg = await loadConfig();
    config = cfg;
    hideError();
    const pets = cfg.pets.filter((p) => S.isDesktopVisible(p.display));
    if (pets.length === 0) {
      showError('配置中没有 display 为 desktop/both 的宠物，桌面模式不显示宠物');
      scheduleReboot();
      return;
    }
    if (Overlay) {
      // 单窗口模式：本页面装下全部桌面宠物（每宠一窗的位置记录先导入一次，见 overlay.js）
      await Overlay.importLegacyPositions();
      for (const s of sprites) s.dispose();
      sprites = pets.map((p) => new PetSprite(p));
      Overlay.syncPets();
      window.__dshPetDebug.configOk = true;
      window.__dshPetDebug.spriteCount = sprites.length;
      for (const s of sprites) s.playIdle();
      startLoops();
      return;
    }
    // 本窗口只承载一只宠物：petIndex 由主进程按 DSH_PET_PETS 顺序注入
    const pet = CONFIG.petId ? pets.find((entry) => entry.id === CONFIG.petId) : pets[CONFIG.petIndex];
    if (!pet) {
      showError('petIndex=' + CONFIG.petIndex + ' 超出桌面宠物列表（共 ' + pets.length + ' 只），本窗口不创建宠物');
      scheduleReboot();
      return;
    }
    for (const s of sprites) s.dispose();
    sprites = [new PetSprite(pet)];
    window.__dshPetDebug.configOk = true;
    window.__dshPetDebug.spriteCount = sprites.length;
    for (const s of sprites) s.playIdle();
    startLoops();
  } catch (e) {
    showError('配置加载失败：' + (e && e.message ? String(e.message) : String(e)));
    scheduleReboot();
  }
}

// 注入打字资源：气泡字体 + 点击/拖拽光标图标（与浏览器 overlay 同一套素材，host 经 /dsh-pet-7340/ 提供）
function injectAssets() {
  const style = document.createElement('style');
  style.textContent =
    '@font-face{font-family:"ShangshouSoftCandy";src:url("' +
    BASE +
    '/font/' +
    encodeURIComponent('上首软糖体') +
    '.ttf") format("truetype");font-display:swap;font-weight:400}' +
    '.pet-hit{cursor:url("' +
    BASE +
    '/pic/cursor-grab.png") 16 16, grab}' +
    '.pet-hit.dragging{cursor:url("' +
    BASE +
    '/pic/cursor-grabbing.png") 16 16, grabbing}';
  document.head.appendChild(style);
  // 统一右键菜单样式（与浏览器注入同一份 MENU_CSS）
  const menuStyle = document.createElement('style');
  menuStyle.textContent = S.MENU_CSS;
  document.head.appendChild(menuStyle);
  // 悬浮提示样式（与浏览器注入同一份 TOOLTIP_CSS；替代原先挂在命中层 title 上的原生提示）
  const tipStyle = document.createElement('style');
  tipStyle.textContent = S.TOOLTIP_CSS;
  document.head.appendChild(tipStyle);
}

// 显示器几何变化（改分辨率/缩放、插拔屏、旋转）：主进程重算后推来，渲染端就地重挂视口与边界。
// 这条通道是必需的——桌面几何原先只在窗口创建时经 URL query 注入一次，运行期永不更新。
if (window.petBridge && window.petBridge.onDisplays) {
  window.petBridge.onDisplays((geo) => {
    if (!applyDeskGeometry(geo)) return;
    // 单窗口模式：先按新的屏幕列表收拾窗口（本页窗口可能换了屏、拔掉的屏的窗口要关），再重摆宠物
    if (Overlay) Overlay.onDisplays();
    for (const s of sprites) s.relayout();
  });
}

// 窗口内容区尺寸异常时按当前位置重新规整。
// 守卫：拖拽/飞行/漫游中**绝不**重设位置——这三种状态下位置由输入或物理驱动，而 position()
// 会把宠物拉回 customPos（上一次的落点）。跨屏时 Windows 会因 WM_DPICHANGED 主动改窗口尺寸，
// 那正好落在拖拽/飞行过程中，不设防就会看到宠物瞬间跳回上一个落点。
window.addEventListener('resize', () => {
  for (const s of sprites) {
    if (s.dragState.active || s.throwRef !== null || s.moveRef !== null) continue;
    s.position();
  }
});

// ---------- 帧率探针（tools/macos/measure_pets.py 经主进程触发；平时不跑） ----------
// 限时跑一个 rAF 记帧间隔（主线程或合成卡住时间隔会变长），并统计各视频的丢帧数；
// 两种窗口模式同一套口径，结束后交主进程写进 ~/.dsh/pet-control-client/frame-probe/。
let frameProbeId = '';
if (window.petBridge && window.petBridge.onFrameProbe) {
  window.petBridge.onFrameProbe((req) => {
    if (!req || typeof req.id !== 'string' || !req.id || req.id === frameProbeId) return;
    frameProbeId = req.id;
    runFrameProbe(req.id, Math.min(Math.max(Number(req.ms) || 0, 1000), 300000));
  });
}

function videoQuality() {
  const out = new Map();
  for (const s of sprites) {
    for (const v of [s.videoA, s.videoB]) {
      const q = v && typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
      if (q) out.set(v, { src: v.currentSrc, dropped: q.droppedVideoFrames, total: q.totalVideoFrames });
    }
  }
  return out;
}

function runFrameProbe(id, ms) {
  const startVideos = videoQuality();
  const startMigrations = Overlay ? Overlay.migrations : 0;
  const gaps = [];
  const t0 = performance.now();
  let last = 0;
  const step = (now) => {
    if (last) gaps.push(now - last);
    last = now;
    if (now - t0 < ms) {
      requestAnimationFrame(step);
      return;
    }
    // 片源换过（切动作 / 换窗口重载）的视频，计数从新片源算起
    let dropped = 0;
    let total = 0;
    for (const [v, end] of videoQuality()) {
      const start = startVideos.get(v);
      const same = start && start.src === end.src && end.total >= start.total;
      dropped += same ? end.dropped - start.dropped : end.dropped;
      total += same ? end.total - start.total : end.total;
    }
    const sorted = gaps.slice().sort((a, b) => a - b);
    const at = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
    const p50 = at(0.5);
    const round = (x) => Math.round(x * 10) / 10;
    window.petBridge.frameProbeResult({
      id,
      mode: Overlay ? 'overlay' : 'per-pet',
      pets: sprites.map((s) => s.pet.id),
      seconds: round((performance.now() - t0) / 1000),
      frames: gaps.length,
      p50: round(p50),
      p95: round(at(0.95)),
      p99: round(at(0.99)),
      max: round(sorted.length ? sorted[sorted.length - 1] : 0),
      // 一帧拖成两帧以上算一次卡顿
      hitches: gaps.filter((g) => g > p50 * 1.8).length,
      videoDropped: dropped,
      videoTotal: total,
      migrations: Overlay ? Overlay.migrations - startMigrations : 0,
    });
  };
  requestAnimationFrame(step);
}

injectAssets();
void boot();
