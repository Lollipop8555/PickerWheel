#!/usr/bin/env node
/**
 * 核心逻辑测试。
 *
 * 用 Node 的 vm 模块 + 最小 DOM 桩在无浏览器环境下跑 app.js，
 * 只验证纯逻辑：环形合并、指针命中、缓动曲线、时长钳制、配色唯一性。
 *
 * 做法：把 app.js 末尾的 `init(); })();` 替换成注入内部 API 的版本，
 * 源文件本身保持不被修改。
 *
 * 用法：node tools/test-core.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(ROOT, 'app.js'), 'utf8');

const injected = source.replace(
  /\n  init\(\);\n\}\)\(\);\n?$/,
  `
  init();
  globalThis.__api = {
    buildSegments, segmentAt, easeProgress, parseLines, readDuration,
    applyInput, spin, state, draw, colorAt, PRESETS,
  };
})();
`
);

if (injected === source) {
  console.error('注入失败：未在 app.js 末尾找到 init() 调用');
  process.exit(1);
}

/* ---------- 最小 DOM 桩 ---------- */

function makeClassList() {
  const set = new Set();
  return {
    add: (...names) => names.forEach((n) => set.add(n)),
    remove: (...names) => names.forEach((n) => set.delete(n)),
    toggle: (name, force) => {
      const on = force === undefined ? !set.has(name) : Boolean(force);
      if (on) set.add(name);
      else set.delete(name);
      return on;
    },
    contains: (name) => set.has(name),
  };
}

function makeElement(id, tagName = 'DIV') {
  const el = {
    id,
    tagName,
    value: '',
    textContent: '',
    disabled: false,
    offsetWidth: 100,
    dataset: {},
    children: [],
    style: { setProperty() {} },
    classList: makeClassList(),
    clientWidth: 900,
    clientHeight: 700,
    setAttribute() {},
    getAttribute: () => null,
    addEventListener() {},
    append(...nodes) {
      el.children.push(...nodes);
    },
    appendChild(node) {
      el.children.push(node);
      return node;
    },
    replaceChildren(...nodes) {
      el.children = [];
      for (const node of nodes) {
        if (node && node.__fragment) el.children.push(...node.children);
        else el.children.push(node);
      }
    },
    focus() {},
    contains: () => false,
    getBoundingClientRect: () => ({ width: 900, height: 700, top: 0, left: 0 }),
  };
  return el;
}

const drawCalls = [];
const contextStub = new Proxy(
  { measureText: (text) => ({ width: String(text).length * 9 }) },
  {
    get: (target, prop) => {
      if (prop in target) return target[prop];
      return () => {
        drawCalls.push(String(prop));
      };
    },
    set: (target, prop, value) => {
      target[prop] = value;
      return true;
    },
  }
);

const registry = new Map();
const getElement = (id) => {
  if (!registry.has(id)) {
    const tag = id === 'lines' ? 'TEXTAREA' : id === 'duration' ? 'INPUT' : 'DIV';
    const el = makeElement(id, tag);
    if (id === 'wheel') el.getContext = () => contextStub;
    registry.set(id, el);
  }
  return registry.get(id);
};

const stage = makeElement('stage');
const rafQueue = [];
let clock = 0;

const documentStub = {
  getElementById: getElement,
  querySelector: (selector) => (selector === '.stage' ? stage : null),
  createElement: () => makeElement('created', 'BUTTON'),
  createDocumentFragment: () => Object.assign(makeElement('fragment'), { __fragment: true }),
  addEventListener() {},
  activeElement: { tagName: 'BODY' },
};

const storageData = {};
const sandbox = {
  console,
  Math,
  Number,
  String,
  Array,
  JSON,
  Object,
  Boolean,
  Float64Array,
  Set,
  Map,
  Proxy,
  performance: { now: () => clock },
  localStorage: {
    getItem: (key) => (key in storageData ? storageData[key] : null),
    setItem: (key, value) => {
      storageData[key] = String(value);
    },
  },
  requestAnimationFrame: (fn) => rafQueue.push(fn),
  document: documentStub,
  window: {
    devicePixelRatio: 2,
    addEventListener() {},
    setTimeout: (fn) => {
      fn();
      return 1;
    },
    clearTimeout() {},
    getComputedStyle: () => ({
      paddingLeft: '16px',
      paddingRight: '16px',
      paddingTop: '10px',
      paddingBottom: '10px',
    }),
    // Service Worker 注册在非 http(s) 下会直接返回，不触碰 navigator
    navigator: {},
    location: { protocol: 'file:', href: 'file:///index.html', search: '' },
  },
  setTimeout: (fn) => {
    fn();
    return 1;
  },
  clearTimeout() {},
};
sandbox.window.document = documentStub;
sandbox.window.localStorage = sandbox.localStorage;
sandbox.window.performance = sandbox.performance;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(injected, sandbox, { filename: 'app.js' });

const api = sandbox.__api;

/* ---------- 断言工具 ---------- */

let failures = 0;

function check(condition, label, detail = '') {
  if (condition) {
    console.log(`  ✔ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✘ ${label}${detail ? `  (${detail})` : ''}`);
  }
}

const labelsOf = (segments) => segments.map((s) => s.label).join(',');
const sweepOf = (segments, label) => {
  const found = segments.find((s) => s.label === label);
  return found ? found.sweep : NaN;
};
const section = (title) => console.log(`\n${title}`);

/* ---------- 1. 环形连续合并 ---------- */

section('[1] 环形连续合并');

const aabc = api.buildSegments(['A', 'A', 'B', 'C']);
check(aabc.length === 3, 'A,A,B,C → 3 份', labelsOf(aabc));
check(Math.abs(sweepOf(aabc, 'A') - 180) < 1e-9, 'A 占 50%（180°）', `${sweepOf(aabc, 'A')}°`);
check(Math.abs(sweepOf(aabc, 'B') - 90) < 1e-9, 'B 占 25%（90°）');
check(Math.abs(sweepOf(aabc, 'C') - 90) < 1e-9, 'C 占 25%（90°）');

const abca = api.buildSegments(['A', 'B', 'C', 'A']);
check(abca.length === 3, 'A,B,C,A → 3 份（首尾相接）', labelsOf(abca));
check(Math.abs(sweepOf(abca, 'A') - 180) < 1e-9, 'A 占 50%（180°）', `${sweepOf(abca, 'A')}°`);
check(abca.filter((s) => s.label === 'A').length === 1, '两个 A 合并为单一扇区');

const abac = api.buildSegments(['A', 'B', 'A', 'C']);
check(abac.length === 4, 'A,B,A,C → 4 份（隔着 B、C）', labelsOf(abac));
check(abac.filter((s) => s.label === 'A').length === 2, '两个 A 保持独立');
check(abac.every((s) => Math.abs(s.sweep - 90) < 1e-9), '每份 90°');

const bbaa = api.buildSegments(['A', 'B', 'B', 'A']);
check(bbaa.length === 2, 'A,B,B,A → 2 份', labelsOf(bbaa));
check(Math.abs(sweepOf(bbaa, 'A') - 180) < 1e-9 && Math.abs(sweepOf(bbaa, 'B') - 180) < 1e-9, 'A / B 各占 50%');

const abab = api.buildSegments(['A', 'B', 'A', 'B']);
check(abab.length === 4, 'A,B,A,B → 4 份（环形严格交替）', labelsOf(abab));

const abcAA = api.buildSegments(['A', 'B', 'C', 'A', 'A']);
check(abcAA.length === 3, 'A,B,C,A,A → 3 份', labelsOf(abcAA));
check(Math.abs(sweepOf(abcAA, 'A') - 216) < 1e-9, 'A 占 3/5 = 60%（216°）', `${sweepOf(abcAA, 'A')}°`);

check(api.buildSegments(['X']).length === 1, '单行 → 1 份');
check(Math.abs(api.buildSegments(['A', 'A'])[0].sweep - 360) < 1e-9, 'A,A → 1 份 360°');
check(api.buildSegments(api.parseLines('  \n\nA\n \n')).length === 1, '空行被过滤');
check(Math.abs(api.buildSegments(api.PRESETS[3].lines)[0].sweep - 30) < 1e-9, '正反交替预设每份 30°');

/* ---------- 2. 扇区不跨界 ---------- */

section('[2] 扇区不跨越 0°');

for (const [name, segments] of Object.entries({ abca, abcAA, bbaa })) {
  const inRange = segments.every((s) => s.start >= 0 && s.start + s.sweep <= 360.000001);
  check(inRange, `${name}：扇区均落在 [0, 360]`);

  const contiguous = segments.every(
    (s, i) => i === 0 || Math.abs(s.start - (segments[i - 1].start + segments[i - 1].sweep)) < 1e-9
  );
  check(contiguous, `${name}：扇区首尾连续无缝隙`);

  const total = segments.reduce((sum, s) => sum + s.sweep, 0);
  check(Math.abs(total - 360) < 1e-9, `${name}：角度合计 360°`, `${total}°`);
}

/* ---------- 3. 指针命中 ---------- */

section('[3] 指针命中判定');

api.state.segments = aabc; // A(0-180) / B(180-270) / C(270-360)
check(api.segmentAt(0) === aabc[0], '旋转 0° → 命中 A');
check(api.segmentAt(-180) === aabc[1], '旋转 -180° → 命中 B（边界归入后一段）');
check(api.segmentAt(-270) === aabc[2], '旋转 -270° → 命中 C');
check(api.segmentAt(360) === aabc[0], '旋转 360° 等价于 0°');

const sweepOrder = [];
for (let deg = 0; deg < 360; deg += 3) {
  const hit = api.segmentAt(-deg);
  if (!hit) {
    check(false, `deg=${deg} 未命中任何扇区`);
    break;
  }
  if (sweepOrder[sweepOrder.length - 1] !== hit.label) sweepOrder.push(hit.label);
}
check(sweepOrder.length === 3, '沿圆周扫描依次经过 3 个扇区', sweepOrder.join(' → '));

/* ---------- 4. 缓动曲线 ---------- */

section('[4] 缓动曲线');

check(api.easeProgress(0) === 0, 'ease(0) = 0');
check(api.easeProgress(1) === 1, 'ease(1) = 1');

const monotonic = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1].every(
  (t, i, arr) => i === 0 || api.easeProgress(t) >= api.easeProgress(arr[i - 1])
);
check(monotonic, '进度单调不回退');
check(api.easeProgress(0.5) > 0.5, '中段已过半（起步快、末段慢）', api.easeProgress(0.5).toFixed(3));

/* ---------- 5. 时长钳制 ---------- */

section('[5] 转动时长钳制');

const durationInput = getElement('duration');
durationInput.value = '1';
check(api.readDuration() === 5, '低于 5 秒回落到 5', String(api.readDuration()));
durationInput.value = 'abc';
check(api.readDuration() === 5, '非法输入回落到 5', String(api.readDuration()));
durationInput.value = '12';
check(api.readDuration() === 12, '正常值保留', String(api.readDuration()));
durationInput.value = '99999';
check(api.readDuration() === 600, '超上限钳制到 600', String(api.readDuration()));
durationInput.value = '5';

/* ---------- 6. 空输入保护 ---------- */

section('[6] 空输入保护');

const linesInput = getElement('lines');
linesInput.value = '   \n  \n';
check(api.applyInput({ silent: true }) === false, '空内容不生成转盘');
check(api.state.segments.length > 0, '保留上一次有效转盘', `${api.state.segments.length} 份`);

/* ---------- 7. 完整转动 ---------- */

section('[7] 完整转动流程');

linesInput.value = 'A\nA\nB\nC';
api.applyInput({ silent: true });
check(api.state.segments.length === 3, '生成 3 份', `${api.state.segments.length}`);
check(getElement('hubValue').textContent === '3', '中心显示份数 3');

api.state.durationSec = 5;
api.spin();
check(api.state.spinning === true, '进入转动状态');
check(getElement('spinBtn').classList.contains('is-hidden'), '开始按钮隐藏');
check(getElement('hubCaption').textContent === '转动中', '中心显示「转动中」');

let frames = 0;
while (rafQueue.length && frames < 2000) {
  const fn = rafQueue.shift();
  clock += 16.7;
  fn(clock);
  frames += 1;
}
check(frames > 0 && frames < 2000, '转动在有限帧内结束', `${frames} 帧`);
check(api.state.spinning === false, '转动结束');
check(getElement('hubCaption').textContent === '结果', '中心显示「结果」');

const shown = getElement('hubValue').textContent;
check(['A', 'B', 'C'].includes(shown), '结果为合法选项', shown);
check(getElement('spinBtn').textContent === '再转一次', '按钮文案更新');

const landed = api.segmentAt(api.state.rotation);
check(landed && landed.label === shown, '指针落点与展示结果一致', `落点 ${landed && landed.label}`);
check(drawCalls.length > 0, '绘制流程被实际执行', `${drawCalls.length} 次调用`);

/* ---------- 8. 配色唯一性 ---------- */

section('[8] 配色唯一性');

for (const count of [1, 2, 3, 4, 6, 12, 16, 40]) {
  const unique = new Set(Array.from({ length: count }, (_, i) => api.colorAt(i, count)));
  check(unique.size === count, `${count} 份时颜色互不相同`, `${unique.size} 种`);
}

/* ---------- 汇总 ---------- */

if (failures > 0) {
  console.error(`\n${failures} 项失败 ❌\n`);
  process.exit(1);
}
console.log('\n全部通过 ✅\n');
