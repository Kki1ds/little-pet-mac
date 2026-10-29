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

/** 原生检测程序的轮询间隔（ms，与白龙桌宠 FullScreenGuard 一致） */
const FULLSCREEN_POLL_MS = 800;

/** 检测程序意外退出后的重启等待（ms）与次数上限；用完就放弃避让，宠物保持可见 */
const FULLSCREEN_RESTART_MS = 5000;
const FULLSCREEN_MAX_RESTARTS = 3;

/** 宠物画布宽高比（renderer 的 640×360 舞台） */
const STAGE_RATIO = 360 / 640;

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
 * 判定用的宠物矩形：窗口内的舞台区（去掉四周透明余量）。
 * 余量会随气泡/菜单变大；用整窗判定的话，宠物站在屏幕交界附近一冒气泡就会被误藏。
 * @param {{x:number,y:number,width:number,height:number}} bounds 窗口内容区（屏幕坐标）
 * @param {{l:number,t:number,size:number}|undefined} margin 渲染端上报的余量
 */
function stageRect(bounds, margin) {
  if (!margin || !(margin.size > 0)) return bounds;
  return { x: bounds.x + margin.l, y: bounds.y + margin.t, width: margin.size, height: margin.size * STAGE_RATIO };
}

/** 两个矩形是否有面积重叠（只擦边不算） */
function overlaps(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * 这只宠物该不该藏起来。
 * 渲染端正拿着鼠标输入（拖拽 / 菜单 / 对话框）时维持现状、不翻转：拖到一半整窗穿透会把松手
 * 事件丢掉，宠物会按旧速度飞走；输入结束后（pet:input-busy=false）立刻补判一次。
 * @param {{bounds:object, margin?:object, displays:object[], busy:boolean, concealed:boolean}} state
 */
function shouldConceal(state) {
  const { bounds, margin, displays, busy, concealed } = state || {};
  if (busy) return !!concealed;
  if (!bounds || !Array.isArray(displays) || !displays.length) return false;
  const rect = stageRect(bounds, margin);
  return displays.some((d) => overlaps(rect, d));
}

module.exports = {
  FULLSCREEN_POLL_MS,
  FULLSCREEN_RESTART_MS,
  FULLSCREEN_MAX_RESTARTS,
  parseFullScreenLine,
  stageRect,
  shouldConceal,
};
