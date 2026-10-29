/**
 * 桌面 helper「全屏避让」（macOS）的判定 + 源码守卫。
 *
 * 背景：helper 是 accessory 应用，桌宠窗口跟随所有 Space，于是也会浮在别的应用的全屏 Space 上
 * （看视频、演示时宠物挡在画面上）。collection behaviour 排除不掉，改为由原生检测程序报告
 * 「哪些屏正在全屏」，落在那些屏上的宠物变全透明 + 整窗穿透。
 *
 * 本文件钉三件事：
 *   ① 检测程序输出的解析：格式不对时不得清空上一次结果；
 *   ② 判定：按舞台区（不含透明余量）与全屏屏的重叠；拖拽/菜单期间维持现状；
 *   ③ 源码守卫：main.js 真的接了线，且藏起来时只动透明度与输入，不 hide()。
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
const { parseFullScreenLine, stageRect, shouldConceal } = require(helper + 'fullscreen-guard.js');

const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** 主屏 1512×982 + 右侧高出 300 点的 5K 外接屏（2560×1440 点） */
const main = { x: 0, y: 0, width: 1512, height: 982 };
const external = { x: 1512, y: -300, width: 2560, height: 1440 };
const margin = { l: 100, t: 100, size: 400 };

describe('parseFullScreenLine —— 检测程序的一行输出', () => {
  test('空列表与多块屏', () => {
    assert.deepEqual(parseFullScreenLine('[]'), []);
    assert.deepEqual(parseFullScreenLine('[[0,0,1512,982],[1512,-300,2560,1440]]\n'), [main, external]);
  });

  test('格式不对返回 null（调用方保留上一次结果）', () => {
    for (const bad of ['', 'x', '{}', '[[0,0,1]]', '[["0",0,1,1]]', '[[0,0,1,null]]']) {
      assert.equal(parseFullScreenLine(bad), null, bad);
    }
  });

  test('零面积的屏被丢掉', () => {
    assert.deepEqual(parseFullScreenLine('[[0,0,0,982]]'), []);
  });
});

describe('shouldConceal —— 哪只宠物该藏', () => {
  const at = (x: number, y: number) => ({ x, y, width: 600, height: 425 });

  test('没有全屏就不藏', () => {
    assert.equal(shouldConceal({ bounds: at(100, 100), margin, displays: [], busy: false, concealed: false }), false);
    assert.equal(shouldConceal({ bounds: at(100, 100), margin, displays: [], busy: false, concealed: true }), false);
  });

  test('只藏落在全屏那块屏上的宠物', () => {
    const displays = [external];
    assert.equal(shouldConceal({ bounds: at(2000, 200), margin, displays, busy: false, concealed: false }), true);
    assert.equal(shouldConceal({ bounds: at(200, 200), margin, displays, busy: false, concealed: false }), false);
  });

  test('只有透明余量伸进全屏屏时不藏（气泡把余量撑大也不误藏）', () => {
    // 窗口右边缘伸到 1600（越过 1512），舞台区右边缘 = 1000+100+400 = 1500，仍在主屏
    const bounds = { x: 1000, y: 200, width: 600, height: 425 };
    assert.equal(shouldConceal({ bounds, margin, displays: [external], busy: false, concealed: false }), false);
    // 没有余量信息时按整窗判
    assert.equal(shouldConceal({ bounds, displays: [external], busy: false, concealed: false }), true);
  });

  test('拖拽/菜单期间维持现状', () => {
    const displays = [external];
    assert.equal(shouldConceal({ bounds: at(2000, 200), margin, displays, busy: true, concealed: false }), false);
    assert.equal(shouldConceal({ bounds: at(200, 200), margin, displays, busy: true, concealed: true }), true);
  });

  test('stageRect：舞台区 = 窗口 + 余量偏移，16:9', () => {
    assert.deepEqual(stageRect({ x: 10, y: 20, width: 600, height: 425 }, margin), { x: 110, y: 120, width: 400, height: 225 });
  });
});

describe('main.js 接线（源码守卫）', () => {
  const src = readSource(helper + 'main.js');

  test('启动检测程序，并在移动、显示、输入结束时补判', () => {
    assert.match(src, /startFullScreenWatch\(\);/);
    assert.match(src, /win\.on\('show', \(\) => guardFullScreen\(win\)\)/);
    assert.match(src, /if \(!busy\) guardFullScreen\(win\)/);
    assert.match(src, /'macos', 'fullscreen-watch'/);
  });

  test('藏 = 透明度 + 整窗穿透，不 hide()；穿透仍只经 setWindowIgnore', () => {
    const body = src.slice(src.indexOf('function guardFullScreen'), src.indexOf('function guardAllFullScreen'));
    assert.match(body, /win\.setOpacity\(hide \? 0 : 1\)/);
    assert.match(body, /setWindowIgnore\(win,/);
    assert.doesNotMatch(body, /\.hide\(\)|\.show\(|setIgnoreMouseEvents/);
  });

  test('检测程序退出时先恢复显示', () => {
    const body = src.slice(src.indexOf("child.on('exit'"), src.indexOf('app.on(\'will-quit\''));
    assert.match(body, /fullScreenDisplays = \[\];\s*guardAllFullScreen\(\);/);
  });
});
