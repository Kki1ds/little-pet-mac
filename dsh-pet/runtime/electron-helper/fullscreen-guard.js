/**
 * dsh-pet desktop helper —— 全屏避让（macOS，纯判定部分）。
 *
 * 【现象】桌宠窗口 `setVisibleOnAllWorkspaces(true)` + screen-saver 层级，而 helper 又是
 * accessory 应用（app.dock.hide()）：这样的窗口会跟进**别的应用的全屏 Space**，看视频、
 * 演示、打游戏时宠物就浮在全屏画面上。collection behaviour 排除不掉它们（白龙桌宠的同款结论），
 * 所以改成：检测到某块屏正显示别的应用的全屏窗口，就把落在那块屏上的宠物窗口变成全透明 +
 * 整窗穿透，退出全屏后恢复。窗口本身不 hide()：渲染、计时、位置与可见性都照旧，只动 alpha 和输入。
 *
 * 【检测】由原生小程序 macos/fullscreen-watch（CGWindowListCopyWindowInfo）完成：
 * 普通桌面保留菜单栏，只有全屏 Space 才会让一个 layer 0 窗口恰好盖满整块屏；
 * /System/Library 下的系统进程（AquaAppearanceHelper 的深浅色过渡会短暂盖满所有屏）不算。
 * 它每次结果变化时输出一行 JSON：`[[x,y,w,h],...]`，坐标与 Electron screen 坐标同系（点，主屏左上为原点）。
 *
 * 本文件只放纯判定：不 require('electron')，可被 node:test 直接加载单测（同 pointer-target.js）。
 */

'use strict';

const { spriteHitRect } = require('./pointer-target.js');

/** 原生检测程序的轮询间隔（ms，与白龙桌宠 FullScreenGuard 一致） */
const FULLSCREEN_POLL_MS = 800;

/** 检测程序意外退出后的重启等待（ms）与次数上限；用完就放弃避让，宠物保持可见 */
const FULLSCREEN_RESTART_MS = 5000;
const FULLSCREEN_MAX_RESTARTS = 3;

/**
 * 解析检测程序的一行输出 → [{x,y,width,height}]；格式不对返回 null（调用方保持上一次结果）。
 * @param {string} line
 */
function parseFullScreenLine(line) {
  let value;
  try {
    value = JSON.parse(String(line).trim());
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const displays = [];
  for (const d of value) {
    if (!Array.isArray(d) || d.length !== 4 || !d.every(Number.isFinite)) return null;
    const [x, y, width, height] = d;
    if (width > 0 && height > 0) displays.push({ x, y, width, height });
  }
  return displays;
}

/**
 * 判定用的宠物矩形：身体命中区（与点击判定同一个框，见 pointer-target.js）。
 * 不能用整窗或整个 16:9 舞台：两侧大片透明，宠物整个站在外接屏左缘时舞台框仍会伸进主屏，
 * 主屏一全屏就把它误藏（真机验收实测，离交界约 130 点）。
 * @param {{x:number,y:number,width:number,height:number}} bounds 窗口内容区（屏幕坐标）
 * @param {{l:number,t:number,size:number}|undefined} margin 渲染端上报的余量
 */
function bodyRect(bounds, margin) {
  const r = spriteHitRect(bounds, margin);
  return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
}

/** 两个矩形重叠的面积 */
function overlapArea(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * 这只宠物该不该藏起来：身体有一半以上落在全屏的屏上才藏（跨在交界上时跟着大半个身子走）。
 * 渲染端正拿着鼠标输入（拖拽 / 菜单 / 对话框）时维持现状、不翻转：拖到一半整窗穿透会把松手
 * 事件丢掉，宠物会按旧速度飞走；输入结束后（pet:input-busy=false）立刻补判一次。
 * @param {{bounds:object, margin?:object, displays:object[], busy:boolean, concealed:boolean}} state
 */
function shouldConceal(state) {
  const { bounds, margin, displays, busy, concealed } = state || {};
  if (busy) return !!concealed;
  if (!bounds || !Array.isArray(displays) || !displays.length) return false;
  const body = bodyRect(bounds, margin);
  const area = body.width * body.height;
  if (!(area > 0)) return false;
  // 全屏的屏互不重叠，面积可以直接相加
  return displays.reduce((sum, d) => sum + overlapArea(body, d), 0) * 2 > area;
}

module.exports = {
  FULLSCREEN_POLL_MS,
  FULLSCREEN_RESTART_MS,
  FULLSCREEN_MAX_RESTARTS,
  parseFullScreenLine,
  bodyRect,
  shouldConceal,
};
