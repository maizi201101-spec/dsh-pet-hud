// 冒烟测试：用最小 React 替身渲染组件，检查姿态/高峰标记/视频接线。
// 用法：npm test（会先假定 client.js 已构建）
import { strict as assert } from 'node:assert';

globalThis.window = { __ModuleLoader__: { load(def) { globalThis.__def = def; } } };
globalThis.document = undefined;
globalThis.localStorage = undefined;

await import(new URL('../client.js', import.meta.url).href);

const def = globalThis.__def;
assert.equal(def.id, 'dsh-pet-hud');

function render({ unread = false, celebrate = false, peakTime = null } = {}) {
  const realNow = Date.now;
  if (peakTime) Date.now = () => Date.parse(peakTime);
  try {
    const now = Date.now();
    const queue = [
      { mode: 'auto', intervalSec: 60, preset: 'cat', sprite: null, pos: { x: 10, y: 10 } },
      null,
      { status: 'ok', totals: { CNY: 18.25 }, at: now, error: null },
      false,
      { x: 10, y: 10 },
      null,
      false,
      '',
      now,
      false,
      false,
      celebrate ? '' : '',
      false,
      null,
    ];
    const react = {
      createElement(type, props, ...children) { return { type, props: props || {}, children }; },
      useState(initial) { return [queue.length ? queue.shift() : initial, () => {}]; },
      useEffect() {},
      useRef(value) { return { current: value }; },
      useCallback(fn) { return fn; },
      useMemo(fn) { return fn(); },
    };
    const plugin = def.factory((name) => {
      if (name === 'react') return react;
      throw new Error('unexpected require: ' + name);
    });
    const status = new Map([['s1', { running: false, completionUnread: unread }]]);
    const list = { byId: { s1: { retainedBy: { mainView: 1 } } } };
    const props = {
      useSessionStatus: (selector) => selector(status),
      useSessions: (selector) => selector(list),
    };
    let registered = null;
    plugin.apply({
      slots: { inject(name, fn) { registered = fn(); }, register(desc, component) { return { desc, component }; } },
      locale: { getSnapshot: () => ({ active: 'zh-CN' }) },
      remote: { account: { getBalance: async () => ({ ok: true, value: null }) } },
    });
    assert.equal(registered.desc.name, 'shell.overlay');

    const found = { videos: [], dots: [] };
    (function walk(node) {
      if (node == null || node === false) return;
      if (typeof node === 'string' || typeof node === 'number') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node.type === 'video') found.videos.push(node.props['data-active']);
      if (node.props && node.props.className === 'pet-hud-dot') found.dots.push(node.props['data-peak']);
      if (typeof node.type === 'function') { walk(node.type({ ...node.props, children: node.children })); return; }
      (node.children || []).forEach(walk);
    })(registered.component(props));
    return found;
  } finally {
    Date.now = realNow;
  }
}

// 空闲：发呆视频在前
const idle = render();
assert.deepEqual(idle.videos, ['1', '0']);

// 有未读：开心视频在前
const happy = render({ unread: true });
assert.deepEqual(happy.videos, ['0', '1']);

// 高峰（2026-10-22 周四 10:00 北京时间）：余额点标红
const peak = render({ peakTime: '2026-10-22T02:00:00Z' });
assert.equal(peak.dots[0], '1', 'peak balance dot');

// 空闲时段：不标红
const off = render({ peakTime: '2026-10-24T02:00:00Z' });
assert.equal(off.dots[0], '0', 'off-peak balance dot');

console.log('smoke ok: videos, unread, peak marker');
