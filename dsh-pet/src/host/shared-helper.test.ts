/**
 * 共用进程模式（little-pet-mac，macOS）：所有桌面宠物共用一个 helper 进程，每只仍是自己的小窗口。
 *
 * 宿主不再为增删宠物重启 helper，页面发现配置变了知会 helper，helper 向宿主拉名单增删窗口，所以这里钉住：
 *   ① 名单：宿主 /config 拍平成桌面宠物名单，口径与页面一致；
 *   ② 增删计划：新出现的建、改了大小的重建、不要了的关；名单为空不动（整个 helper 由宿主停）；
 *   ③ 源码守卫：建新窗口在关旧窗口之前、旧窗口的收尾不误删新窗口、进程内不重复算碰撞、宿主/页面接线在位。
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
const { desktopPetsFromConfig, planSharedWindows, SHARED_PROFILE, LEGACY_PROFILE_PREFIX } = require(helper + 'shared-helper.js');

const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('desktopPetsFromConfig —— 宿主 /config → 桌面宠物名单', () => {
  test('按种类目录展开，只要上桌面的，assetRoot 记种类目录', () => {
    const pets = desktopPetsFromConfig({
      main: {
        pets: [
          { id: 'main', name: ' 小克 ', size: 300, display: 'both' },
          { id: 'main__clone_1', size: 300, display: 'desktop' },
          { id: 'web-only', size: 300, display: 'browser' },
          { id: 'off', size: 300, display: 'none' },
        ],
      },
      bailong: { pets: [{ id: 'bailong', name: '小白龙', size: 250, display: 'desktop' }] },
    });
    assert.deepEqual(pets, [
      { id: 'main', name: '小克', size: 300, assetRoot: 'main' },
      { id: 'main__clone_1', name: '', size: 300, assetRoot: 'main' },
      { id: 'bailong', name: '小白龙', size: 250, assetRoot: 'bailong' },
    ]);
  });

  test('坏条目丢掉，同 id 只留第一个', () => {
    const pets = desktopPetsFromConfig({
      main: {
        pets: [
          { id: 'a', size: 300, display: 'desktop' },
          { id: 'a', size: 400, display: 'desktop' },
          { id: '', size: 300, display: 'desktop' },
          { id: 'b', size: 0, display: 'desktop' },
          null,
          { id: 'c', size: '250', display: 'desktop' },
        ],
      },
      broken: { pets: 'x' },
    });
    assert.deepEqual(
      pets.map((p: { id: string; size: number }) => [p.id, p.size]),
      [
        ['a', 300],
        ['c', 250],
      ],
    );
  });

  test('不是对象 → 空名单', () => {
    assert.deepEqual(desktopPetsFromConfig(null), []);
    assert.deepEqual(desktopPetsFromConfig('x'), []);
  });
});

describe('planSharedWindows —— 增删计划', () => {
  const current = [
    { id: 'a', size: 300 },
    { id: 'b', size: 300 },
  ];

  test('新出现的建、改了大小的重建、不要了的关', () => {
    const plan = planSharedWindows(current, [
      { id: 'a', size: 400 },
      { id: 'c', size: 300 },
    ]);
    assert.deepEqual(plan.open.map((p: { id: string }) => p.id), ['c']);
    assert.deepEqual(plan.reopen.map((p: { id: string }) => p.id), ['a']);
    assert.deepEqual(plan.close, ['b']);
  });

  test('没变化就什么都不做', () => {
    assert.deepEqual(planSharedWindows(current, current), { open: [], reopen: [], close: [] });
  });

  test('名单为空不关窗口（一只都不剩时宿主会停掉整个 helper）', () => {
    assert.deepEqual(planSharedWindows(current, []), { open: [], reopen: [], close: [] });
  });
});

describe('源码守卫 —— helper 主进程', () => {
  const main = readSource(helper + 'main.js');

  test('按 DSH_PET_SHARED 选模式，用独立 profile', () => {
    assert.match(main, /process\.env\.DSH_PET_SHARED === '1'/);
    assert.match(main, /app\.setPath\('userData', path\.join\(app\.getPath\('appData'\), sharedHelper\.SHARED_PROFILE\)\)/);
    assert.equal(SHARED_PROFILE, 'dsh-pet-shared');
    assert.ok(main.includes("'dsh-pet-character-' + instance"));
    assert.equal(LEGACY_PROFILE_PREFIX, 'dsh-pet-character-');
  });

  test('改大小：先建新窗口再关旧窗口（唯一一只时先关会触发 window-all-closed 退出）', () => {
    const at = main.indexOf('for (const pet of plan.reopen)');
    assert.ok(at > 0);
    const block = main.slice(at, at + 500);
    assert.ok(block.indexOf('createPetWindow(pet)') < block.indexOf('old.close()'));
  });

  test('旧窗口收尾不误删新窗口的登记与碰撞连接', () => {
    assert.match(main, /if \(windows\.get\(pet\.id\) === win\) \{/);
    assert.match(main, /if \(collisionLinks\.get\(petId\) === link\) collisionLinks\.delete\(petId\)/);
  });

  test('进程内不广播宠物状态：碰撞只由 broker 算一遍', () => {
    const at = main.indexOf('function broadcastPetStates()');
    assert.ok(at > 0);
    assert.match(main.slice(at, at + 80), /if \(SHARED\) return;/);
  });

  test('Cmd+Q 只藏有焦点的那只', () => {
    assert.match(main, /const ids = SHARED \? \[focusedPetId\(\)\]\.filter\(Boolean\)/);
  });

  test('页面 query 带上模式', () => {
    assert.match(main, /shared: SHARED \? '1' : '0'/);
  });

  test('名单只信宿主：知会只当触发，按版本去重，增删依据是拉回来的 /config', () => {
    const at = main.indexOf('function startSharedReconcile()');
    assert.ok(at > 0);
    const block = main.slice(at, at + 2000);
    assert.match(block, /desktopPetsFromConfig\(await fetchHostConfig\(\)\)/);
    assert.match(block, /if \(!next \|\| next === version\) return;/);
  });
});

describe('源码守卫 —— 宿主与页面接线', () => {
  test('宿主：macOS 默认共用进程，DSH_PET_SHARED=0 退回；增删宠物不重启 helper', () => {
    const host = readSource('../../lib/standalone.js');
    assert.match(host, /process\.platform === "darwin" && process\.env\.DSH_PET_SHARED !== "0"/);
    assert.match(host, /DSH_PET_SHARED: shared \? "1" : "0"/);
    assert.match(host, /else if \(desktopSharedMode\(\)\) \{/);
  });

  test('页面：配置版本变了知会主进程，首启先导入旧位置再建宠物', () => {
    const events = readSource(helper + 'events.js');
    assert.match(events, /if \(CONFIG\.shared && window\.petBridge && window\.petBridge\.sharedConfigChanged\)/);
    const renderer = readSource(helper + 'renderer.js');
    const imported = renderer.indexOf('if (CONFIG.shared) await importLegacyPositions();');
    assert.ok(imported > 0 && imported < renderer.indexOf('sprites = [new PetSprite(pet)]'));
  });

  test('发布清单含新文件', () => {
    const check = readSource('../../scripts/prepack-check.js');
    for (const file of ['shared-helper.js', 'blank.html']) {
      assert.ok(check.includes(`'runtime/electron-helper/${file}'`), file);
    }
  });
});
