// Personal fork: the TREEMAP panel's clicks (treemapPanel.js): a click goes
// in once, a double-click flies and does not go in, a click while the next
// level loads does nothing, and a level that fails keeps the crumbs' labels.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTreemapPanel, CLICK_DELAY_MS } from './treemapPanel.js';
import { createTreemapStore } from '../data/treemapStore.js';

/** Just enough DOM for the panel and its address bar. */
class FakeElement extends EventTarget {
  constructor(tag) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.textContent = '';
    this.className = '';
    this.parent = null;
    this.isConnected = true;
    this.offsetParent = {};
    this.clientWidth = 600;
    this.clientHeight = 400;
    this.offsetWidth = 160;
    this.offsetHeight = 60;
    const owner = this;
    this.classList = {
      contains: (name) => owner.className.split(/\s+/).includes(name),
      add() {},
      remove() {},
      toggle() {},
    };
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node && typeof node === 'object') node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  remove() {}
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  contains() {
    return false;
  }
  querySelector() {
    return null;
  }
  focus() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 600, height: 400 };
  }
  getContext() {
    return new Proxy(
      { measureText: (text) => ({ width: String(text).length * 6 }) },
      {
        get: (target, key) => (key in target ? target[key] : () => {}),
        set: () => true,
      },
    );
  }
  /** Every descendant's text, depth first. */
  texts() {
    return this.children.flatMap((child) =>
      typeof child === 'object'
        ? [child.textContent, ...child.texts()].filter(Boolean)
        : [String(child)],
    );
  }
  /** Descendants with the class. */
  find(name) {
    return this.children.flatMap((child) =>
      typeof child === 'object'
        ? [
            ...(child.classList.contains(name) ? [child] : []),
            ...child.find(name),
          ]
        : [],
    );
  }
}

function fakeDocument() {
  return Object.assign(new EventTarget(), {
    createElement: (tag) => new FakeElement(tag),
    activeElement: null,
    querySelector: () => null,
  });
}

/** Timers run by hand. */
function fakeWindow() {
  const timers = new Map();
  let next = 1;
  return {
    devicePixelRatio: 1,
    setTimeout(fn, ms) {
      timers.set(next, { fn, ms });
      return next++;
    },
    clearTimeout: (id) => timers.delete(id),
    setInterval: () => 0,
    clearInterval() {},
    pending: () => timers.size,
    run() {
      const due = [...timers.values()];
      timers.clear();
      for (const timer of due) timer.fn();
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

const ASIA = {
  key: 'asia',
  label: 'Asia',
  value: 60,
  hasChildren: true,
  geo: 'box:25,-11,180,82',
};
const EUROPE = {
  key: 'europe',
  label: 'Europe',
  value: 40,
  hasChildren: true,
  geo: 'box:-32,34,180,82',
};

/** A source that answers the root, and Asia; JP inside Asia fails. */
function fakeSource({ hold = false } = {}) {
  const asked = [];
  let release = null;
  const answer = (path) => {
    if (path.length === 0)
      return {
        schema: 'treemap/1',
        mode: 'additive',
        unit: 'm2',
        path: [],
        total: { value: 100, count: 2 },
        level: { grouping: 'admin.continent' },
        children: [ASIA, EUROPE],
        rest: null,
      };
    if (path.join('/') === 'asia')
      return {
        schema: 'treemap/1',
        mode: 'additive',
        unit: 'm2',
        path: [{ key: 'asia', label: 'Asia', grouping: 'admin.continent' }],
        total: { value: 60, count: 1 },
        level: { grouping: 'admin.country' },
        children: [
          {
            key: 'JP',
            label: 'Japan',
            value: 60,
            hasChildren: true,
            geo: 'area:jp',
          },
        ],
        rest: null,
      };
    const error = new Error('There is no "JP" in admin.region here');
    error.code = 'refused';
    throw error;
  };
  return {
    asked,
    release: () => release?.(),
    kind: () => 'service',
    catalog: async () => ({
      schema: 'treemap/1',
      variables: [
        {
          id: 'm2/surface-area',
          available: true,
          groupings: ['admin.continent', 'admin.country', 'admin.region'],
        },
      ],
      groupings: [],
    }),
    async node({ path = [] }) {
      asked.push(path.join('/'));
      if (hold && path.length)
        await new Promise((resolve) => {
          release = resolve;
        });
      return answer(path);
    },
  };
}

function mount({ hold = false } = {}) {
  const documentRef = fakeDocument();
  const windowRef = fakeWindow();
  const store = createTreemapStore({
    initial: {
      address: 'm2/surface-area://admin.continent/admin.country/admin.region',
      path: [],
    },
  });
  const flights = [];
  const source = fakeSource({ hold });
  const container = new FakeElement('div');
  const panel = createTreemapPanel({
    container,
    source,
    store,
    globe: { outline() {}, flyTo: (ref) => flights.push(ref) },
    documentRef,
    windowRef,
  });
  const canvas = container.find('treemap-canvas')[0];
  const tileOf = (key) =>
    panel.state().tiles.find((tile) => tile.node.key === key);
  const at = (tile, type, detail = 1) => {
    const event = new Event(type);
    Object.assign(event, {
      clientX: tile.x + tile.w / 2,
      clientY: tile.y + tile.h / 2,
    });
    Object.defineProperty(event, 'detail', { value: detail });
    canvas.dispatchEvent(event);
  };
  return { panel, store, windowRef, source, flights, container, tileOf, at };
}

test('a single click goes in once, after the double-click wait', async () => {
  const m = mount();
  await settle();
  const asia = m.tileOf('asia');
  m.at(asia, 'click');
  assert.deepEqual(m.store.get().path, [], 'not before the wait');
  assert.equal(m.windowRef.pending(), 1);
  m.windowRef.run();
  assert.deepEqual(m.store.get().path, ['asia']);
  assert.ok(CLICK_DELAY_MS >= 200 && CLICK_DELAY_MS <= 300);
  m.panel.destroy();
});

test('a double-click flies there and does not go in', async () => {
  const m = mount();
  await settle();
  const asia = m.tileOf('asia');
  m.at(asia, 'click', 1);
  m.at(asia, 'click', 2);
  m.at(asia, 'dblclick', 2);
  await settle();
  m.windowRef.run();
  assert.deepEqual(m.store.get().path, []);
  assert.deepEqual(m.flights, ['box:25,-11,180,82']);
  m.panel.destroy();
});

test('a click on the last level’s tiles while the next one loads does nothing', async () => {
  const m = mount({ hold: true });
  await settle();
  const asia = m.tileOf('asia');
  m.at(asia, 'click');
  m.windowRef.run();
  await settle();
  assert.deepEqual(m.store.get().path, ['asia']);
  // Asia is still drawn while its answer is on the way: a click there must
  // not push "asia" (or anything) onto the new level.
  m.at(asia, 'click');
  m.windowRef.run();
  assert.deepEqual(m.store.get().path, ['asia']);
  m.source.release();
  await settle();
  await settle();
  assert.equal(m.tileOf('JP')?.node.label, 'Japan');
  m.panel.destroy();
});

test('a level that fails keeps the crumbs’ labels above it, and they still go back', async () => {
  const m = mount();
  await settle();
  m.at(m.tileOf('asia'), 'click');
  m.windowRef.run();
  await settle();
  await settle();
  m.at(m.tileOf('JP'), 'click');
  m.windowRef.run();
  await settle();
  await settle();
  assert.deepEqual(m.store.get().path, ['asia', 'JP']);
  const crumbs = m.container.find('treemap-crumb');
  assert.deepEqual(
    crumbs.map((crumb) => crumb.textContent),
    ['All', 'Asia', 'Japan'],
  );
  assert.match(
    m.container.find('treemap-status')[0].textContent,
    /There is no "JP"/,
  );
  // The way back: the Asia crumb.
  crumbs[1].dispatchEvent(new Event('click'));
  assert.deepEqual(m.store.get().path, ['asia']);
  m.panel.destroy();
});
