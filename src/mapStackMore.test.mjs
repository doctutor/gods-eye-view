// Personal fork: the "More styles" picker under the five map-source chips.
// Upstream's chip row is pinned by mapStackChips.test.mjs and must not change;
// these tests pin the second row: every other stack grouped in one select,
// the same selection path as a chip click, and a shown value that follows
// controller state rather than the choice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expandApplicationHtml } from '../build/application-html.js';
import { readStylesheet } from './testSupport/readStylesheet.mjs';
import { MAP_STACKS } from './maps/catalog.js';
import { KEYLESS_BASEMAP_IDS } from './maps/keylessBasemapCatalog.js';
import {
  PRESENTED_MAP_STACK_IDS,
  renderMapStackChips,
} from './mapStackChips.js';
import {
  MAP_STACK_MORE_CLASS,
  MAP_STACK_MORE_NOTE_CLASS,
  mapStackMoreGroups,
  renderMapStackMore,
  syncMapStackMore,
} from './mapStackMore.js';
import { createMapSourceControls } from './ui/mapSourceControls.js';

/** Element stand-in: enough of select/option/optgroup for the picker. */
function makeElement(tagName = 'div') {
  const element = {
    tagName,
    type: '',
    className: '',
    title: '',
    label: '',
    value: '',
    disabled: false,
    hidden: false,
    textContent: '',
    dataset: {},
    attributes: {},
    listeners: {},
    children: [],
    classList: {
      toggle(name, force) {
        const classes = new Set(
          String(element.className).split(/\s+/).filter(Boolean),
        );
        const next = force === undefined ? !classes.has(name) : !!force;
        if (next) classes.add(name);
        else classes.delete(name);
        element.className = [...classes].join(' ');
      },
      contains(name) {
        return String(element.className).split(/\s+/).includes(name);
      },
    },
    appendChild(child) {
      element.children.push(child);
      return child;
    },
    setAttribute(name, value) {
      element.attributes[name] = String(value);
    },
    getAttribute(name) {
      return element.attributes[name] ?? null;
    },
    addEventListener(type, handler) {
      (element.listeners[type] ||= []).push(handler);
    },
    removeEventListener(type, handler) {
      element.listeners[type] = (element.listeners[type] || []).filter(
        (current) => current !== handler,
      );
    },
    dispatch(type) {
      for (const handler of element.listeners[type] || []) handler();
    },
  };
  Object.defineProperty(element, 'innerHTML', {
    get: () => '',
    set() {
      element.children.length = 0;
    },
  });
  return element;
}
const doc = { createElement: (tag) => makeElement(tag) };

/** Controller-shaped stacks: the catalog plus availability, as getStacks() gives them. */
function controllerStacks({ unavailable = new Set(['bing-aerial']) } = {}) {
  return MAP_STACKS.map((stack) => ({
    ...stack,
    available: !unavailable.has(stack.id),
    unavailableReason: unavailable.has(stack.id)
      ? `${stack.label} needs something`
      : null,
  }));
}

const select = (container) =>
  container.children.find((child) => child.tagName === 'select');
const note = (container) =>
  container.children.find((child) => child.tagName === 'span');
const optgroups = (container) =>
  select(container).children.filter((child) => child.tagName === 'optgroup');
const options = (container) =>
  optgroups(container).flatMap((group) => group.children);

test("the chip row stays upstream's five; the picker holds every other stack, grouped", () => {
  const stacks = [
    ...controllerStacks(),
    { id: 'hybrid', label: 'Hybrid', available: true },
  ];
  const chips = makeElement();
  renderMapStackChips(chips, stacks, { activeId: 'osm', doc });
  assert.deepEqual(
    chips.children.map((chip) => chip.dataset.stackId),
    PRESENTED_MAP_STACK_IDS,
  );

  const more = makeElement();
  const handle = renderMapStackMore(more, stacks, { activeId: 'osm', doc });
  assert.equal(more.hidden, false);
  assert.equal(select(more).className, `pp-select ${MAP_STACK_MORE_CLASS}`);
  assert.equal(select(more).getAttribute('aria-label'), 'More map styles');
  assert.equal(select(more).children[0].value, '');
  assert.equal(select(more).children[0].textContent, 'More styles…');
  assert.equal(note(more).className, MAP_STACK_MORE_NOTE_CLASS);

  assert.deepEqual(
    optgroups(more).map((group) => group.label),
    ['Blank', 'Light', 'Dark', 'Terrain', 'NASA', 'Stamen', 'Other'],
  );
  assert.deepEqual(
    optgroups(more).map((group) => group.children.map((o) => o.value)),
    [
      ['blank-black', 'blank-white'],
      ['natural-earth-ii', 'carto-positron', 'carto-positron-nolabels'],
      ['carto-dark-matter', 'carto-dark-matter-nolabels'],
      ['opentopomap'],
      ['nasa-black-marble', 'nasa-blue-marble'],
      [
        'stamen-toner',
        'stamen-toner-lite',
        'stamen-terrain',
        'stamen-watercolor',
      ],
      ['hybrid'],
    ],
  );
  const ids = options(more).map((o) => o.value);
  assert.deepEqual(ids.slice(0, -1), [...KEYLESS_BASEMAP_IDS]);
  for (const id of PRESENTED_MAP_STACK_IDS)
    assert.ok(!ids.includes(id), `${id} stays a chip, not an option`);
  assert.deepEqual(
    options(more).map((o) => o.textContent),
    stacks.filter((s) => ids.includes(s.id)).map((s) => s.label),
    'options show the product names',
  );
  assert.equal(handle.groups.length, 7);
  assert.deepEqual(
    mapStackMoreGroups(stacks, 'osm').map((group) => group.id),
    ['blank', 'light', 'dark', 'terrain', 'nasa', 'stamen', 'other'],
  );
});

test('the placeholder shows while a chip is active; otherwise the style, lit, with its note', () => {
  const more = makeElement();
  renderMapStackMore(more, controllerStacks(), { activeId: 'osm', doc });
  assert.equal(select(more).value, '');
  assert.equal(select(more).classList.contains('active'), false);
  assert.equal(note(more).hidden, true);

  syncMapStackMore(more, 'natural-earth-ii');
  assert.equal(select(more).value, 'natural-earth-ii');
  assert.equal(select(more).classList.contains('active'), true);
  assert.equal(note(more).hidden, false);
  assert.equal(
    note(more).textContent,
    'Far-out views only: three zoom levels, bundled with Cesium',
  );

  syncMapStackMore(more, 'carto-positron');
  assert.equal(select(more).value, 'carto-positron');
  assert.equal(note(more).hidden, true, 'no note for an unlimited style');
  assert.equal(note(more).textContent, '');

  syncMapStackMore(more, 'photoreal');
  assert.equal(select(more).value, '', 'a chip stack shows the placeholder');
  assert.equal(select(more).classList.contains('active'), false);

  // A fresh render with an active keyless style starts lit.
  const lit = makeElement();
  renderMapStackMore(lit, controllerStacks(), {
    activeId: 'nasa-black-marble',
    doc,
  });
  assert.equal(select(lit).value, 'nasa-black-marble');
  assert.equal(
    note(lit).textContent,
    'VIIRS night lights, 2016; eight zoom levels',
  );
});

test('choosing a style dispatches its id; the placeholder and an unavailable style dispatch nothing', () => {
  const more = makeElement();
  const chosen = [];
  const bound = [];
  renderMapStackMore(
    more,
    controllerStacks({ unavailable: new Set(['stamen-toner']) }),
    {
      activeId: 'osm',
      doc,
      onSelect: (id) => chosen.push(id),
      bind: (element, type, listener) => {
        bound.push([element.tagName, type]);
        element.addEventListener(type, listener);
      },
    },
  );
  assert.deepEqual(bound, [['select', 'change']], 'one owned listener');
  const toner = options(more).find((o) => o.value === 'stamen-toner');
  assert.equal(toner.disabled, true);
  assert.equal(toner.title, 'Stamen Toner needs something');
  const dark = options(more).find((o) => o.value === 'carto-dark-matter');
  assert.equal(dark.disabled, false);
  assert.equal(dark.title, 'CARTO Dark Matter');

  select(more).value = 'carto-dark-matter';
  select(more).dispatch('change');
  assert.deepEqual(chosen, ['carto-dark-matter']);
  assert.equal(
    select(more).value,
    'carto-dark-matter',
    'the shown value waits for the controller, not the click',
  );

  // The controller settled elsewhere: the picker follows it.
  syncMapStackMore(more, 'osm');
  select(more).value = '';
  select(more).dispatch('change');
  assert.deepEqual(chosen, ['carto-dark-matter'], 'the placeholder is inert');

  select(more).value = 'stamen-toner';
  select(more).dispatch('change');
  assert.deepEqual(chosen, ['carto-dark-matter'], 'disabled stays unchosen');
  assert.equal(select(more).value, '', 'and the shown value snaps back');
});

test('with nothing beyond the chips the row hides; missing elements are inert', () => {
  const more = makeElement();
  const fiveOnly = controllerStacks().filter((s) =>
    PRESENTED_MAP_STACK_IDS.includes(s.id),
  );
  const handle = renderMapStackMore(more, fiveOnly, { activeId: 'osm', doc });
  assert.equal(more.hidden, true);
  assert.deepEqual(handle.groups, []);
  assert.equal(optgroups(more).length, 0);

  // Re-rendering replaces the previous picker instead of stacking a second.
  renderMapStackMore(more, controllerStacks(), { activeId: 'osm', doc });
  renderMapStackMore(more, controllerStacks(), { activeId: 'osm', doc });
  assert.equal(more.children.length, 2);
  assert.equal(more.hidden, false);

  assert.equal(renderMapStackMore(null, controllerStacks(), { doc }), null);
  assert.equal(
    renderMapStackMore(makeElement(), controllerStacks(), { doc: {} }),
    null,
  );
  assert.doesNotThrow(() => syncMapStackMore(null, 'osm'));
  assert.doesNotThrow(() => syncMapStackMore(makeElement(), 'osm'));
});

test('the map source controls render and sync the picker through the chip selection path', async () => {
  const container = makeElement();
  container.ownerDocument = doc;
  const moreContainer = makeElement();
  moreContainer.ownerDocument = doc;
  const sources = [
    { id: 'osm', label: 'OSM', available: true },
    { id: 'esri-imagery', label: 'Esri', available: true },
    {
      id: 'carto-positron',
      label: 'CARTO Positron',
      group: 'light',
      available: true,
    },
    {
      id: 'natural-earth-ii',
      label: 'Natural Earth II',
      group: 'light',
      note: 'Far-out views only: three zoom levels, bundled with Cesium',
      available: true,
    },
  ];
  let state = { activeId: 'osm', activeStack: sources[0], status: 'ready' };
  const listeners = new Set();
  const requests = [];
  const calls = [];
  const controller = {
    getStacks: () => sources,
    getActiveId: () => state.activeId,
    getState: (status) => ({ ...state, status: status || state.status }),
    setStack: (id) => {
      calls.push(id);
      return new Promise((resolve) => requests.push({ id, resolve }));
    },
  };
  const controls = createMapSourceControls({
    container,
    moreContainer,
    statusElement: makeElement(),
    controller,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  assert.equal(container.children.length, 2, 'the two chip-row stacks');
  assert.deepEqual(
    options(moreContainer).map((o) => o.value),
    ['carto-positron', 'natural-earth-ii'],
    'keyless stacks go to the picker in controller order',
  );
  assert.equal(select(moreContainer).value, '');

  select(moreContainer).value = 'carto-positron';
  select(moreContainer).dispatch('change');
  assert.deepEqual(
    calls,
    ['carto-positron'],
    'the same controller.setStack path',
  );
  assert.equal(select(moreContainer).value, '', 'switching: nothing lit yet');

  state = {
    activeId: 'carto-positron',
    activeStack: sources[2],
    status: 'ready',
  };
  requests[0].resolve(controller.getState());
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(select(moreContainer).value, 'carto-positron');
  assert.equal(select(moreContainer).classList.contains('active'), true);
  assert.equal(
    container.children.some((chip) => chip.classList.contains('active')),
    false,
    'no chip is lit while a picker style is active',
  );

  // A provider-driven change reaches the picker without a click.
  state = {
    activeId: 'natural-earth-ii',
    activeStack: sources[3],
    status: 'ready',
  };
  for (const listener of listeners) listener();
  assert.equal(select(moreContainer).value, 'natural-earth-ii');
  assert.equal(
    note(moreContainer).textContent,
    'Far-out views only: three zoom levels, bundled with Cesium',
  );

  controls.destroy();
  assert.deepEqual(
    select(moreContainer).listeners.change,
    [],
    'listener removed',
  );
});

test("the tray markup keeps upstream's chip row and adds the picker row after it", () => {
  const html = expandApplicationHtml(
    readFileSync(new URL('../index.html', import.meta.url), 'utf8'),
  );
  assert.match(
    html,
    /<div id="map-stack-chips" class="map-stack-chip-row" role="group" aria-label="Map source" data-i18n-aria-label><\/div>\s*(?:<!--[\s\S]*?-->\s*)?<div id="map-stack-more" class="map-stack-more-row" hidden><\/div>\s*<\/section>/,
    'the picker row follows the chips inside the MAP SOURCE section, hidden until rendered',
  );
  const css = readStylesheet(new URL('../style.css', import.meta.url));
  assert.match(
    css,
    /\.map-stack-chip-row\s*\{[\s\S]*?grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\);/,
    'the five chips keep their one-row grid',
  );
  assert.match(
    css,
    /\.map-stack-more-row\s*\{[\s\S]*?display:\s*grid;/,
    'the note sits under the select, so a long note never starves it',
  );
  assert.match(
    css,
    /\.map-stack-more-select\.active\s*\{[\s\S]*?color:\s*var\(--accent\);/,
  );
  assert.match(css, /\.map-stack-more-note\[hidden\]\s*\{\s*display:\s*none;/);
  const shell = readFileSync(
    new URL('./ui/shellElements.js', import.meta.url),
    'utf8',
  );
  assert.match(
    shell,
    /_mapStackMore: document\.getElementById\('map-stack-more'\)/,
  );
  const app = readFileSync(
    new URL('./ui/applicationShell.js', import.meta.url),
    'utf8',
  );
  assert.match(app, /moreContainer: this\._mapStackMore/);
});
