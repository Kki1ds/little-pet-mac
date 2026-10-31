/**
 * 单窗口模式（little-pet-mac，macOS）：所有桌面宠物共用一个 helper，每块屏一个透明窗口。
 *
 * 透明窗口盖着整块屏，任何一处判定出错都会让整块屏点不动，所以这里钉住：
 *   ① 穿透判定 decideOverlayIgnore：只有宠物身体、菜单/对话框、拖拽中才接收鼠标，其余一律穿透；
 *   ② 全屏让位 overlayConcealed：窗口一半以上落在全屏的屏上才藏；拖拽/菜单期间维持现状；
 *   ③ 源码守卫：主进程的安全网（渲染端没了就退出、拖拽租约、窗口名白名单）与宿主/渲染端的接线在位。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const helper = '../../runtime/electron-helper/';
const { decideOverlayIgnore, DRAG_LEASE_MS } = require(helper + 'pointer-target.js');
const { overlayConcealed } = require(helper + 'fullscreen-guard.js');

const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** 主屏 1512×982 + 右侧高出 300 点的 5K 外接屏（2560×1440 点） */
const main = { x: 0, y: 0, width: 1512, height: 982 };
const external = { x: 1512, y: -300, width: 2560, height: 1440 };
const body = { x: 600, y: 700, width: 120, height: 200 };
const menu = { x: 730, y: 500, width: 160, height: 240 };

describe('decideOverlayIgnore —— 整屏透明窗口的穿透判定', () => {
  const at = (x: number, y: number, extra: object = {}) =>
    decideOverlayIgnore({ point: { x, y }, bounds: main, bodies: [body], controls: [], dragging: false, ...extra });

  test('宠物身上接收鼠标，旁边的透明处穿透', () => {
    assert.equal(at(650, 800), false);
    assert.equal(at(599, 800), true);
    assert.equal(at(720, 800), true, '右边界不含');
    assert.equal(at(100, 100), true);
  });

  test('菜单/对话框矩形里接收鼠标', () => {
    assert.equal(at(800, 600, { controls: [menu] }), false);
    assert.equal(at(800, 600), true, '菜单关了就穿透');
  });

  test('拖拽中整块屏接收鼠标（宠物滞后于光标，光标可能不在身体上）', () => {
    assert.equal(at(100, 100, { dragging: true }), false);
    assert.equal(at(5000, 5000, { dragging: true }), false);
  });

  test('光标不在这块屏上 / 没有光标：穿透', () => {
    assert.equal(at(2000, 100), true);
    assert.equal(decideOverlayIgnore({ point: null, bounds: main, bodies: [body] }), true);
  });

  test('别的屏的身体不算（每块屏只传自己的身体）', () => {
    assert.equal(
      decideOverlayIgnore({ point: { x: 2000, y: 100 }, bounds: external, bodies: [], controls: [], dragging: false }),
      true,
    );
  });

  test('拖拽租约比渲染端心跳（1s）宽裕，又不至于卡住太久', () => {
    assert.ok(DRAG_LEASE_MS >= 2000 && DRAG_LEASE_MS <= 5000);
  });
});

describe('overlayConcealed —— 整屏窗口的全屏让位', () => {
  test('窗口所在的屏在全屏就藏，别的屏全屏不影响', () => {
    assert.equal(overlayConcealed({ bounds: main, displays: [main], busy: false, concealed: false }), true);
    assert.equal(overlayConcealed({ bounds: main, displays: [external], busy: false, concealed: false }), false);
    assert.equal(overlayConcealed({ bounds: external, displays: [external], busy: false, concealed: false }), true);
  });

  test('没有全屏就显示（包括之前藏着的）', () => {
    assert.equal(overlayConcealed({ bounds: main, displays: [], busy: false, concealed: true }), false);
  });

  test('拖拽/菜单期间维持现状', () => {
    assert.equal(overlayConcealed({ bounds: main, displays: [main], busy: true, concealed: false }), false);
    assert.equal(overlayConcealed({ bounds: main, displays: [], busy: true, concealed: true }), true);
  });
});

describe('源码守卫 —— 主进程安全网', () => {
  const src = readSource(helper + 'overlay-main.js');

  test('渲染进程没了就整个退出（窗口盖着整块屏，不能留着）', () => {
    const at = src.indexOf("'render-process-gone'");
    assert.ok(at > 0);
    assert.match(src.slice(at, at + 400), /app\.exit\(1\)/);
  });

  test('兜底轮询按真实光标走 decideOverlayIgnore，拖拽靠租约', () => {
    assert.match(src, /decideOverlayIgnore\(/);
    assert.match(src, /screen\.getCursorScreenPoint\(\)/);
    assert.match(src, /Date\.now\(\) - at < DRAG_LEASE_MS/);
  });

  test('只放行 about:blank + 我们的窗口名；渲染端消息只认本页面', () => {
    assert.match(src, /url !== 'about:blank' \|\| !m\) return \{ action: 'deny' \}/);
    assert.match(src, /event\.sender === opener\.webContents/);
  });

  test('穿透只经 setIgnore（外加建窗时、新主屏交接时各一处）', () => {
    assert.equal((src.match(/setIgnoreMouseEvents\(/g) ?? []).length, 4);
  });

  test('窗口不进调度中心、所有桌面可见、置顶看门狗', () => {
    assert.match(src, /setHiddenInMissionControl\(true\)/);
    assert.match(src, /setVisibleOnAllWorkspaces\(true, \{ visibleOnFullScreen: true \}\)/);
    assert.match(src, /shouldReassertTopmost\(/);
  });
});

describe('源码守卫 —— 接线', () => {
  test('main.js 按 DSH_PET_OVERLAY 选模式，用独立 profile', () => {
    const main = readSource(helper + 'main.js');
    assert.match(main, /process\.env\.DSH_PET_OVERLAY === '1'/);
    assert.match(main, /'dsh-pet-overlay'/);
    assert.match(main, /if \(OVERLAY\) startOverlayMode\(\);\s*else createPetWindows\(\);/);
  });

  test('宿主：macOS 默认单窗口，DSH_PET_OVERLAY=0 退回；单窗口时增删宠物不重启 helper', () => {
    const host = readSource('../../lib/standalone.js');
    assert.match(host, /process\.platform === "darwin" && process\.env\.DSH_PET_OVERLAY !== "0"/);
    assert.match(host, /DSH_PET_OVERLAY: overlay \? "1" : "0"/);
    assert.match(host, /else if \(desktopOverlayMode\(\)\) \{/);
  });

  test('页面加载 overlay.js，且在 sprite.js 之前', () => {
    const html = readSource(helper + 'index.html');
    const overlay = html.indexOf('./overlay.js');
    assert.ok(overlay > 0 && overlay < html.indexOf('./sprite.js'));
  });

  test('发布清单含新文件', () => {
    const check = readSource('../../scripts/prepack-check.js');
    for (const file of ['overlay-main.js', 'overlay.js', 'blank.html']) {
      assert.ok(check.includes(`'runtime/electron-helper/${file}'`), file);
    }
  });
});
