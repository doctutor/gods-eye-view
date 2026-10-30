import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('panel presentation places Transit between Street Traffic and Bike Share in Movement', () => {
  const source = readFileSync(
    new URL('./layerPanel.js', import.meta.url),
    'utf8',
  );
  const declarations = source.slice(
    source.indexOf('const PANEL_GROUPS ='),
    source.indexOf('const PANEL_POSITIONS ='),
  );
  const order = JSON.parse(
    runInNewContext(
      `const msg = (text) => text;\n${declarations}\nJSON.stringify(PANEL_ORDER)`,
    ),
  );
  assert.deepEqual(
    order.filter(({ label }) => label === 'Movement').map(({ id }) => id),
    [
      'satellites',
      'flights',
      'military',
      'local-adsb',
      'ais-live-vessels',
      'traffic',
      'transit',
      'bikeshare',
    ],
  );
  assert.equal(order.filter(({ id }) => id === 'transit').length, 1);
});

test('partial feed controls distinguish incomplete records from stale data and outages', async () => {
  const { LayerPanel, layerFeedState } = await import('./layerPanel.js');
  const classes = new Map();
  const attrs = new Map();
  const button = {
    classList: { toggle: (key, value) => classes.set(key, value) },
    dataset: {},
    setAttribute: (key, value) => attrs.set(key, value),
  };
  const layer = {
    id: 'ais-live-vessels',
    name: 'Live Vessels',
    source: 'AISStream',
    enabled: true,
    stats: {
      partial: true,
      stale: false,
      count: 2,
      acceptedRowCount: 2,
      rawRowCount: 3,
      lastUpdate: Date.now(),
    },
  };
  const panel = LayerPanel.prototype;
  panel._syncToggleButton(button, layer);
  assert.equal(button.textContent, 'PARTIAL');
  assert.equal(button.dataset.feedState, 'partial');
  assert.equal(classes.get('feed-partial'), true);
  assert.equal(classes.get('feed-stale'), false);
  assert.match(attrs.get('aria-label'), /PARTIAL/);
  assert.match(
    panel._buildMetaText(layer),
    /^PARTIAL · AISStream · 2 of 3 records accepted · /,
  );
  assert.match(
    panel._buildMetaText({
      ...layer,
      stats: { ...layer.stats, rawRowCount: 2 },
    }),
    /incomplete snapshot/,
  );
  assert.equal(layerFeedState({ ...layer.stats, stale: true }), 'stale');
  assert.equal(
    layerFeedState({ ...layer.stats, error: 'Connection lost' }),
    'degraded',
  );
  assert.equal(
    layerFeedState({ ...layer.stats, status: 'unavailable' }),
    'unavailable',
  );
  assert.equal(layerFeedState({ ...layer.stats, loading: true }), 'loading');
  layer.stats = { ...layer.stats, partial: false };
  panel._syncToggleButton(button, layer);
  assert.equal(button.textContent, 'ON');
  assert.equal(classes.get('feed-partial'), false);
  layer.enabled = false;
  panel._syncToggleButton(button, layer);
  assert.equal(button.textContent, 'OFF');
});

test('readout rows contain only toggles and metadata; ordinary rows retain controls', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const { railFixture } = await import('./railTestFixture.mjs');
  const f = railFixture();
  const previousDocument = globalThis.document;
  globalThis.document = f.document;
  const ids = [
    'wind',
    'weather-radar',
    'weather-satellite',
    'weather-lightning',
    'weather-cyclones',
    'other',
  ];
  let refresh;
  const layers = ids.map((id) => ({
    id,
    name: id,
    icon: '*',
    source: 'Source',
    enabled: true,
    showInTogglePanel: true,
    stats: {},
  }));
  const calls = [];
  const panel = new LayerPanel({
    getLayers: () => layers,
    isEnabled: () => true,
    setEnabled: (...args) => calls.push(args),
    setLayerParams: (...args) => calls.push(args),
    hasRowControls: () => true,
    subscribeRowControls: (_id, callback) => {
      refresh = callback;
    },
    getRowControls: (id) => ({
      readout: id !== 'other',
      summary: { status: 'Loading' },
      info: 'Detailed time',
      chips: [{ id: 'config', label: 'Soft', params: { opacity: 'light' } }],
      legend: [{ label: 'Rain', color: '#abcdef' }],
      list: {
        items: [{ id: 'storm', text: 'Storm', params: { focus: true } }],
      },
    }),
  });
  try {
    panel.mount(f.container);
    for (const id of ids.slice(0, -1)) {
      const row = f.find((n) => n.dataset.layerId === id);
      assert.equal(row.children.length, 2);
      assert.ok(row.querySelector('.data-name'));
      assert.ok(row.querySelector('.data-toggle-meta'));
      for (const cls of [
        'data-toggle-chip',
        'data-count',
        'data-toggle-controls',
        'data-toggle-controls-status',
        'data-row-list',
      ])
        assert.equal(row.querySelector(`.${cls}`), null);
      row.querySelector('.data-toggle-btn').click();
    }
    assert.deepEqual(
      calls.map(([id]) => id),
      ids.slice(0, -1),
    );
    const ordinary = f.find((n) => n.dataset.layerId === 'other');
    assert.equal(
      ordinary.querySelector('.data-toggle-controls-info').textContent,
      'Detailed time',
    );
    assert.ok(ordinary.querySelector('.data-toggle-legend-item'));
    ordinary.querySelector('.data-toggle-chip').click();
    assert.deepEqual(calls.at(-1), [
      'other',
      { opacity: 'light' },
      { origin: 'user' },
    ]);
    assert.equal(typeof refresh, 'function');
  } finally {
    panel.destroy();
    globalThis.document = previousDocument;
  }
});

test('the Recent Imagery readout mounts in its rail body like the weather readout and is rebuilt or released with the panel', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const { railFixture } = await import('./railTestFixture.mjs');
  const f = railFixture();
  const body = f.document.createElement('div');
  f.document.getElementById = (id) =>
    id === 'recent-imagery-panel-body' ? body : null;
  const previousDocument = globalThis.document;
  globalThis.document = f.document;
  const mounted = [];
  const factory = (container) => {
    const readout = {
      container,
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
    };
    mounted.push(readout);
    return readout;
  };
  const panel = new LayerPanel({
    getLayers: () => [],
    isEnabled: () => false,
    setEnabled() {},
    setLayerParams() {},
    hasRowControls: () => false,
    subscribeRowControls() {},
    getRowControls: () => null,
  });
  try {
    panel.attachRecentImagery(factory);
    assert.equal(mounted.length, 0, 'no body before the panel mounts');
    panel.mount(f.container);
    assert.equal(mounted.length, 1);
    assert.equal(mounted[0].container, body);
    panel.mount(f.container);
    assert.equal(mounted[0].destroyed, true, 'a remount rebuilds it');
    assert.equal(mounted.length, 2);
    panel.attachRecentImagery(null);
    assert.equal(mounted[1].destroyed, true);
    panel.attachRecentImagery(factory);
    assert.equal(mounted.length, 3);
    panel.destroy();
    assert.equal(mounted[2].destroyed, true);
    panel.attachRecentImagery(factory);
    assert.equal(mounted.length, 3, 'a destroyed panel mounts nothing');
  } finally {
    panel.destroy();
    globalThis.document = previousDocument;
  }
});

test('an omitted source is visibly unavailable and cannot be toggled on', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const attrs = new Map();
  const button = {
    classList: { toggle() {} },
    dataset: {},
    setAttribute: (key, value) => attrs.set(key, value),
  };
  const layer = {
    id: 'flights',
    name: 'Flights',
    enabled: false,
    stats: {
      sourceUnavailable: true,
      status: 'unavailable',
      error: 'Data source not configured: flights',
    },
  };
  LayerPanel.prototype._syncToggleButton(button, layer);
  assert.equal(button.textContent, 'UNAVAILABLE');
  assert.equal(attrs.get('aria-disabled'), 'true');
  assert.match(button.title, /not configured/);
  LayerPanel.prototype._syncToggleButton(button, { ...layer, enabled: true });
  assert.equal(
    attrs.get('aria-disabled'),
    'false',
    'an active layer can always be switched off',
  );
});

test('row text keeps a hyphenated code whole and never starts a line with the separator', async () => {
  const { setRowText } = await import('./layerPanel.js');
  const previousDocument = globalThis.document;
  const element = () => ({
    className: '',
    textContent: '',
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
  });
  globalThis.document = { createElement: element };
  try {
    const text = (node) =>
      node.children.length
        ? node.children.map((child) => child.textContent).join('')
        : node.textContent;
    const kept = (node) =>
      node.children
        .filter((child) => child.className === 'data-keep')
        .map((child) => child.textContent);

    const name = element();
    setRowText(name, 'Локальный ADS-B');
    assert.equal(text(name), 'Локальный ADS-B');
    assert.deepEqual(kept(name), ['ADS-B']);

    const meta = element();
    setRowText(meta, 'UNAVAILABLE · NASA FIRMS · LIVE · KEY REQUIRED');
    assert.equal(text(meta), 'UNAVAILABLE · NASA FIRMS · LIVE · KEY REQUIRED');
    assert.deepEqual(kept(meta), [' ·', ' ·', ' ·']);
    assert.ok(
      meta.children.every((child) => !child.textContent.startsWith('·')),
      'the space before each dot is held to the piece it closes',
    );

    const plain = element();
    setRowText(plain, 'Satellites');
    assert.equal(plain.textContent, 'Satellites');
    assert.equal(plain.children.length, 0);

    const long = element();
    setRowText(long, 'see https-proxy-endpoint-config-x');
    assert.deepEqual(kept(long), [], 'a long hyphenated run may still wrap');
  } finally {
    globalThis.document = previousDocument;
  }
});

test('the unavailable chip may abbreviate, but its accessible name keeps the full state', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const attrs = new Map();
  const button = {
    classList: { toggle() {} },
    dataset: {},
    setAttribute: (key, value) => attrs.set(key, value),
  };
  LayerPanel.prototype._syncToggleButton(button, {
    id: 'local-firms',
    name: 'FIRMS Active Fires',
    enabled: false,
    stats: { sourceUnavailable: true, error: 'KEY REQUIRED' },
  });
  assert.equal(button.textContent, 'UNAVAILABLE');
  assert.equal(button.dataset.feedState, 'unavailable');
  assert.match(attrs.get('aria-label'), /^Active Fires: UNAVAILABLE\./);
});

test('the Weather readout receives enabled air-quality alongside weather layers', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const layers = ['wind', 'air-quality', 'other'].map((id) => ({
    id,
    icon: '*',
    enabled: true,
  }));
  layers.push({ id: 'weather-radar', icon: '*', enabled: false });
  const panel = new LayerPanel({
    getLayers: () => layers,
    getRowControls: (id) => ({ readout: true, summary: { label: id } }),
  });
  let entries = null;
  panel._weatherPanel = {
    update: (next) => {
      entries = next;
    },
  };
  panel._refreshWeatherPanel();
  assert.deepEqual(
    entries.map(({ id, summary }) => [id, summary.label]),
    [
      ['wind', 'wind'],
      ['air-quality', 'air-quality'],
    ],
  );
});

test('a row slider renders once, reads the live descriptor, and leaves a dragged thumb alone', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const { railFixture } = await import('./railTestFixture.mjs');
  const f = railFixture();
  const previousDocument = globalThis.document;
  globalThis.document = f.document;
  const seen = [];
  let value = 70;
  let refresh;
  const panel = new LayerPanel({
    getLayers: () => [
      {
        id: 'ee-forest-loss',
        name: 'Forest loss',
        icon: '*',
        source: 'Google Earth Engine',
        enabled: true,
        showInTogglePanel: true,
        stats: {},
      },
    ],
    isEnabled: () => true,
    setEnabled: () => {},
    setLayerParams: () => {},
    hasRowControls: () => true,
    subscribeRowControls: (_id, callback) => {
      refresh = callback;
    },
    getRowControls: () => ({
      legend: [{ label: '2001', color: '#ffff00' }],
      slider: {
        label: `Opacity ${value}%`,
        min: 0,
        max: 100,
        step: 5,
        value,
        onInput: (next) => seen.push(['live', next]),
      },
    }),
  });
  try {
    panel.mount(f.container);
    const row = f.find((n) => n.dataset.layerId === 'ee-forest-loss');
    const slider = row.querySelector('.data-toggle-slider');
    assert.ok(slider, 'the slider renders');
    const [label, input] = slider.children;
    assert.equal(label.textContent, 'Opacity 70%');
    assert.equal(input.type, 'range');
    assert.equal(input.getAttribute('aria-label'), 'Opacity 70%');
    assert.equal(input.value, '70');
    input.value = '35';
    input.dispatchEvent(new Event('input'));
    assert.deepEqual(seen, [['live', 35]]);
    // A refresh while the thumb is held keeps it where the pointer put it.
    value = 35;
    f.document.activeElement = input;
    input.value = '40';
    panel._syncRowControls(row.querySelector('.data-toggle-controls'), {
      id: 'ee-forest-loss',
      enabled: true,
    });
    assert.equal(input.value, '40');
    assert.equal(label.textContent, 'Opacity 35%');
    assert.equal(
      row
        .querySelector('.data-toggle-controls')
        .children.filter((node) => node.className === 'data-toggle-slider')
        .length,
      1,
      'one slider, kept across refreshes',
    );
    assert.equal(typeof refresh, 'function');
  } finally {
    panel.destroy();
    globalThis.document = previousDocument;
  }
});

test('the Titles row sits above the first group and flips the overlay host', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const { railFixture } = await import('./railTestFixture.mjs');
  const { createTitlesPreference } = await import('./titles.js');
  const f = railFixture();
  const previousDocument = globalThis.document;
  globalThis.document = f.document;
  const host = [];
  const titles = createTitlesPreference({
    storage: null,
    hash: '',
    host: { set: (visible) => host.push(visible), get: () => host.at(-1) },
  });
  const panel = new LayerPanel({
    getLayers: () => [
      {
        id: 'flights',
        name: 'Flights',
        icon: '*',
        source: 'Source',
        enabled: true,
        showInTogglePanel: true,
        stats: {},
      },
    ],
    isEnabled: () => true,
    setEnabled: () => {},
    setLayerParams: () => {},
    hasRowControls: () => false,
    subscribeRowControls: () => {},
    getRowControls: () => null,
    titles,
  });
  try {
    panel.mount(f.container);
    const first = f.container.children[0];
    assert.equal(first.dataset.panelSetting, 'titles');
    assert.equal(first.querySelector('.data-name').textContent, 'Titles');
    assert.equal(
      first.querySelector('.data-toggle-meta').textContent,
      'names on markers',
    );
    const button = first.querySelector('.data-toggle-btn');
    assert.equal(button.textContent, 'ON');
    button.click();
    assert.equal(titles.get(), false);
    assert.deepEqual(host, [true, false]);
    assert.equal(button.textContent, 'OFF');
    // A change from elsewhere (a restored link) repaints the row.
    titles.set(true);
    assert.equal(button.textContent, 'ON');
    assert.deepEqual(host, [true, false, true]);
  } finally {
    panel.destroy();
    globalThis.document = previousDocument;
  }
});

test('a toggle acts on what it shows: a layer turned on while the page was hidden reads OFF, and the first click leaves it on', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const { railFixture } = await import('./railTestFixture.mjs');
  const f = railFixture();
  const previousDocument = globalThis.document;
  globalThis.document = f.document;
  const rivers = {
    id: 'ee-rivers',
    name: 'Rivers',
    icon: '~',
    source: 'HydroSHEDS',
    enabled: false,
    showInTogglePanel: true,
    stats: {},
  };
  const calls = [];
  let hiddenRefreshes = 0;
  const panel = new LayerPanel({
    getLayers: () => [rivers],
    isEnabled: () => rivers.enabled,
    setEnabled: async (id, enabled, options) => {
      calls.push([id, enabled, options.origin]);
      rivers.enabled = enabled;
      return true;
    },
    setLayerParams: () => {},
    getRowControls: () => null,
    hasRowControls: () => false,
    subscribeRowControls: () => {},
    onHiddenRefresh: () => hiddenRefreshes++,
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    panel.mount(f.container);
    const button = () =>
      f
        .find((n) => n.dataset.layerId === 'ee-rivers')
        .querySelector('.data-toggle-btn');
    assert.equal(button().textContent, 'OFF');
    // Visible and in step: an ordinary first click turns it on, the next off.
    button().click();
    await settle();
    assert.deepEqual(calls, [['ee-rivers', true, 'user']]);
    assert.equal(button().textContent, 'ON');
    button().click();
    await settle();
    assert.deepEqual(calls.at(-1), ['ee-rivers', false, 'user']);
    assert.equal(button().textContent, 'OFF');
    calls.length = 0;
    // The share link turns Rivers on while the page is hidden: the panel's
    // repaint is put off, so the button still reads OFF.
    f.document.hidden = true;
    rivers.enabled = true;
    panel._refreshTogglePanel();
    assert.equal(hiddenRefreshes, 1);
    assert.equal(button().textContent, 'OFF', 'stale while hidden');
    // The first click means ON: nothing to change, the button catches up.
    button().click();
    await settle();
    assert.deepEqual(calls, [], 'not switched off behind the user');
    assert.equal(rivers.enabled, true);
    assert.equal(button().textContent, 'ON');
    assert.ok(button().classList.contains('active'));
    // From there each click toggles as shown.
    button().click();
    await settle();
    assert.deepEqual(calls, [['ee-rivers', false, 'user']]);
    assert.equal(button().textContent, 'OFF');
    button().click();
    await settle();
    assert.deepEqual(calls.at(-1), ['ee-rivers', true, 'user']);
    assert.equal(button().textContent, 'ON');
  } finally {
    panel.destroy();
    globalThis.document = previousDocument;
  }
});

test('a row’s toggle is written only where its state changed: refreshed with the same layer it writes nothing (each write is a mutation and a restyle of the open panel, hundreds a flight)', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const writes = [];
  const attrs = new Map();
  const values = { textContent: '', title: '', disabled: false };
  const dataset = {};
  const button = {
    classList: { toggle() {} },
    dataset: new Proxy(dataset, {
      set(target, key, value) {
        writes.push(`data-${String(key)}`);
        target[key] = value;
        return true;
      },
    }),
    getAttribute: (key) => (attrs.has(key) ? attrs.get(key) : null),
    setAttribute(key, value) {
      writes.push(key);
      attrs.set(key, value);
    },
  };
  for (const key of Object.keys(values))
    Object.defineProperty(button, key, {
      get: () => values[key],
      set(value) {
        writes.push(key);
        values[key] = value;
      },
    });
  const layer = {
    id: 'ee-elevation',
    name: 'Elevation',
    source: 'Earth Engine',
    enabled: true,
    stats: { count: 1, lastUpdate: Date.now() },
  };
  LayerPanel.prototype._syncToggleButton(button, layer);
  assert.ok(writes.length > 3, 'the first sync writes the state');
  assert.equal(button.textContent, 'ON');
  writes.length = 0;
  for (let k = 0; k < 50; k++)
    LayerPanel.prototype._syncToggleButton(button, { ...layer });
  assert.deepEqual(writes, [], 'nothing written for the same state');
  // A real change writes what changed.
  LayerPanel.prototype._syncToggleButton(button, { ...layer, enabled: false });
  assert.equal(button.textContent, 'OFF');
  assert.ok(writes.includes('textContent'));
  assert.ok(writes.includes('data-enabled'));
  assert.ok(writes.includes('aria-label'));
});
