// Personal fork: the HUD camera readout's text, tooltips and edit flow
// (src/hud/cameraReadout.js), on a small fake DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAMERA_FIELDS,
  attachCameraEditing,
  cameraFieldsHtml,
  editedView,
  floorNoteText,
  formatCameraReadout,
  normalizeRoll,
  parseEditValue,
} from './cameraReadout.js';
import { DATA_FLOORS, viewPrecision } from './precision.js';

// The Inner Harbor, Baltimore, looking north-east and a little down.
const VIEW = {
  lon: -76.6083861,
  lat: 39.2858764,
  heightM: 412.3456,
  headingDeg: 45.678,
  pitchDeg: -32.104,
  rollDeg: 0.004,
  fovDeg: 60,
};
const reading = (overrides = {}) => ({
  view: VIEW,
  altMslM: 445.678,
  geoidApplied: true,
  aglM: 405.2345,
  footprintM: 0.42,
  distanceM: 610,
  sunElDeg: 23.456,
  pixelDeg: 60 / 1920,
  ...overrides,
});
const mgrs = (lon, lat, digits) =>
  `18S UJ ${'6'.repeat(digits)} ${'4'.repeat(digits)}`;

test('near the ground on Google’s tiles: 0.1 m heights, six decimals, 1 m MGRS', () => {
  const precision = viewPrecision({
    footprintM: 0.42,
    floor: DATA_FLOORS.google,
  });
  const fields = formatCameraReadout(reading(), precision, { mgrs });
  assert.equal(fields.lat.text, '39.285876°');
  assert.equal(fields.lon.text, '-76.608386°');
  assert.equal(fields.alt.text, '445.7 m');
  assert.equal(fields.agl.text, '405.2 m');
  assert.equal(fields.mgrs.text, '18S UJ 66666 44444');
  assert.equal(fields.dms.text, `39°17'09.16"N 076°36'30.19"W`);
  assert.equal(fields.heading.text, '45.68°');
  assert.equal(fields.pitch.text, '-32.10°');
  assert.equal(fields.roll.text, '0.00°');
  assert.equal(fields.fov.text, '60.00°');
  assert.equal(fields.px.text, '0.42 m');
  assert.equal(fields.sun.text, '23.5° EL');
  assert.equal(floorNoteText(precision), '· Google');
});

test('from high up: whole kilometres, two decimals, 1 km MGRS; angles still 2 decimals', () => {
  const high = reading({
    view: { ...VIEW, heightM: 4_120_000 },
    altMslM: 4_123_456,
    aglM: 4_123_400,
    footprintM: 3_400,
    distanceM: 4_100_000,
  });
  const precision = viewPrecision({
    footprintM: 3_400,
    floor: DATA_FLOORS.google,
  });
  const fields = formatCameraReadout(high, precision, { mgrs });
  assert.equal(fields.lat.text, '39.29°');
  assert.equal(fields.alt.text, '4123000 m');
  assert.equal(fields.mgrs.text, '18S UJ 66 44');
  assert.equal(fields.dms.text, `39°17'09"N 076°36'30"W`);
  assert.equal(fields.heading.text, '45.68°');
  assert.equal(fields.px.text, '3.4 km');
});

test('every field says what it is, against what, what bounds it, and if it can be edited', () => {
  const precision = viewPrecision({
    footprintM: 0.03,
    floor: DATA_FLOORS.world,
  });
  const fields = formatCameraReadout(reading({ footprintM: 0.03 }), precision, {
    mgrs,
  });
  for (const { id, editable } of CAMERA_FIELDS) {
    assert.ok(fields[id].title.length > 20, `${id} has a tooltip`);
    assert.equal(
      fields[id].title.includes('Click to edit'),
      editable,
      `${id}: "click to edit" only where it can be`,
    );
  }
  assert.match(fields.lat.title, /WGS84 ellipsoid/);
  assert.match(fields.alt.title, /mean sea level/);
  assert.match(fields.agl.title, /rendered surface .*Cesium World Terrain/);
  // The 10 m terrain, not the 3 cm pixel, bounds these.
  assert.match(
    fields.lat.title,
    /Shown to 10 m: the Cesium World Terrain surface is 10 m resolution/,
  );
  assert.match(fields.heading.title, /One pixel is about 0\.031°/);
  // Out where the pixel is coarser than the floor, the pixel bounds them.
  const far = formatCameraReadout(
    reading({ footprintM: 42 }),
    viewPrecision({ footprintM: 42, floor: DATA_FLOORS.world }),
    { mgrs },
  );
  assert.match(far.alt.title, /Shown to 10 m: one pixel covers 42 m here/);
  // Before the geoid loads, ALT says it is ellipsoidal.
  const cold = formatCameraReadout(reading({ geoidApplied: false }), precision);
  assert.match(cold.alt.title, /WGS84 ellipsoid, until the geoid loads/);
});

test('AGL waits for the surface: a dash and a tooltip that says why', () => {
  const precision = viewPrecision({
    footprintM: 1,
    floor: DATA_FLOORS.keyless,
  });
  const fields = formatCameraReadout(reading({ aglM: NaN }), precision);
  assert.equal(fields.agl.text, '—');
  assert.match(fields.agl.title, /waiting for that surface to load/);
  assert.equal(fields.mgrs.text, '—', 'no MGRS formatter: a dash');
  // Re:Earth's 30 m: heights to 10 m.
  assert.equal(fields.alt.text, '450 m');
});

test('the corners’ markup: labels, values, editable ones focusable, the floor note', () => {
  const position = cameraFieldsHtml('position');
  const pose = cameraFieldsHtml('pose');
  for (const id of ['lat', 'lon', 'dms', 'mgrs', 'alt', 'agl'])
    assert.match(position, new RegExp(`id="hud-cam-${id}"`));
  for (const id of ['heading', 'pitch', 'roll', 'fov', 'px', 'sun'])
    assert.match(pose, new RegExp(`id="hud-cam-${id}"`));
  assert.match(
    position,
    /data-cam-field="lat" tabindex="0" role="button" data-cam-editable="true"/,
  );
  assert.doesNotMatch(position, /data-cam-field="dms" tabindex/);
  assert.match(position, /id="hud-cam-agl-floor"/);
});

test('typed numbers: point or comma, a minus sign, a trailing unit', () => {
  assert.equal(parseEditValue('39.2858'), 39.2858);
  assert.equal(parseEditValue(' -76,6083 '), -76.6083);
  assert.equal(parseEditValue('−32.5'), -32.5);
  assert.equal(parseEditValue('45°'), 45);
  assert.equal(parseEditValue('1.7 m'), 1.7);
  assert.equal(parseEditValue('.5'), 0.5);
  for (const bad of ['', 'abc', '1.2.3', '12 km', '--1', '1e'])
    assert.ok(Number.isNaN(parseEditValue(bad)), bad);
});

test('an edit changes one number and holds the other six', () => {
  const keep = (next, field) => {
    for (const key of Object.keys(VIEW))
      if (key !== field) assert.equal(next[key], VIEW[key], `${key} held`);
  };
  let next = editedView(VIEW, 'lat', 40.1);
  assert.equal(next.lat, 40.1);
  keep(next, 'lat');
  next = editedView(VIEW, 'lon', -77);
  keep(next, 'lon');
  next = editedView(VIEW, 'pitch', -90);
  assert.equal(next.pitchDeg, -90);
  keep(next, 'pitchDeg');
  next = editedView(VIEW, 'fov', 40);
  assert.equal(next.fovDeg, 40);
  keep(next, 'fovDeg');
  assert.equal(editedView(VIEW, 'heading', 370).headingDeg, 10);
  assert.equal(editedView(VIEW, 'heading', -90).headingDeg, 270);
  assert.equal(editedView(VIEW, 'roll', 190).rollDeg, -170);
  assert.equal(normalizeRoll(180), 180);
  // ALT is above sea level: the geoid's N turns it back into the ellipsoidal
  // height (Baltimore's N is about -33 m).
  assert.equal(editedView(VIEW, 'alt', 500, { geoidN: -33 }).heightM, 467);
  assert.equal(editedView(VIEW, 'alt', 500).heightM, 500, 'no geoid: as typed');
  // AGL is above the surface: ALT becomes the surface plus it (1.7 m, eye level).
  next = editedView(VIEW, 'agl', 1.7, { surfaceM: 12.4 });
  assert.ok(Math.abs(next.heightM - 14.1) < 1e-9);
  keep(next, 'heightM');
  // Values a field does not take.
  for (const [field, value, extra] of [
    ['lat', 91],
    ['lon', -181],
    ['pitch', -91],
    ['fov', 0.5],
    ['fov', 170],
    ['agl', 5, {}],
    ['agl', -1, { surfaceM: 10 }],
    ['lat', NaN],
    ['dms', 1],
    ['px', 1],
  ])
    assert.equal(
      editedView(VIEW, field, value, extra),
      null,
      `${field} ${value}`,
    );
});

/** Just enough DOM for the edit flow: elements, events that bubble, focus. */
function fakeDocument() {
  const doc = { activeElement: null };
  class El {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.parent = null;
      this.listeners = {};
      this.dataset = {};
      this.attributes = {};
      this.value = '';
      this._text = '';
      const classes = new Set();
      this.classList = {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
      };
    }
    get textContent() {
      return this._text + this.children.map((c) => c.textContent).join('');
    }
    set textContent(text) {
      this._text = text;
      for (const child of this.children) child.parent = null;
      this.children = [];
    }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    }
    removeEventListener(type, fn) {
      this.listeners[type] = (this.listeners[type] || []).filter(
        (f) => f !== fn,
      );
    }
    dispatch(type, init = {}) {
      const event = {
        type,
        target: this,
        key: init.key,
        preventDefault() {},
        stopPropagation() {},
      };
      for (let node = this; node; node = node.parent)
        for (const fn of node.listeners[type] || []) fn(event);
      return event;
    }
    appendChild(child) {
      child.parent = this;
      this.children.push(child);
      return child;
    }
    remove() {
      if (!this.parent) return;
      this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
    }
    closest(selector) {
      const key = /^\[data-cam-editable\]$/.test(selector)
        ? 'camEditable'
        : null;
      for (let node = this; node; node = node.parent)
        if (key && node.dataset[key]) return node;
      return null;
    }
    focus() {
      doc.activeElement = this;
    }
    select() {}
  }
  doc.createElement = (tag) => new El(tag);
  return doc;
}

function corner(doc, ids) {
  const root = doc.createElement('div');
  const spans = {};
  for (const id of ids) {
    const span = doc.createElement('span');
    span.dataset.camField = id;
    if (id !== 'dms') span.dataset.camEditable = 'true';
    span.textContent = `${id}-shown`;
    root.appendChild(span);
    spans[id] = span;
  }
  return { root, spans };
}

test('click to edit: Enter applies, a bad number stays open, Escape and leaving cancel', () => {
  const doc = fakeDocument();
  const { root, spans } = corner(doc, ['lat', 'dms', 'fov']);
  const applied = [];
  let accept = true;
  let changes = 0;
  const editing = attachCameraEditing({
    roots: [root],
    documentRef: doc,
    value: (field) => ({ lat: '39.285876', fov: '60.00' })[field],
    apply: (field, value) => {
      applied.push([field, value]);
      return accept;
    },
    onChange: () => changes++,
  });
  // A read-only field does not open.
  spans.dms.dispatch('click');
  assert.equal(editing.editing(), null);
  // LAT opens with the number shown, focused, in place of the text.
  spans.lat.dispatch('click');
  assert.equal(editing.editing(), 'lat');
  const input = spans.lat.children[0];
  assert.equal(input.tagName, 'INPUT');
  assert.equal(input.value, '39.285876');
  assert.equal(doc.activeElement, input);
  assert.equal(input.attributes['aria-label'], 'LAT');
  assert.equal(changes, 1);
  // A number the camera does not take: kept open, marked.
  accept = false;
  input.value = '95';
  input.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(applied, [['lat', 95]]);
  assert.equal(editing.editing(), 'lat');
  assert.ok(input.classList.contains('invalid'));
  // One it does: applied and closed.
  accept = true;
  input.value = '40,5';
  input.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(applied.at(-1), ['lat', 40.5]);
  assert.equal(editing.editing(), null);
  assert.equal(spans.lat.children.length, 0);
  // Escape cancels: nothing applied.
  spans.fov.dispatch('click');
  const fov = spans.fov.children[0];
  fov.value = '40';
  fov.dispatch('keydown', { key: 'Escape' });
  assert.equal(editing.editing(), null);
  assert.equal(applied.length, 2);
  // Leaving the box cancels too; the keyboard opens a field as a click does.
  spans.fov.dispatch('keydown', { key: 'Enter' });
  assert.equal(editing.editing(), 'fov');
  spans.fov.children[0].dispatch('blur');
  assert.equal(editing.editing(), null);
  assert.equal(applied.length, 2);
  editing.detach();
  spans.lat.dispatch('click');
  assert.equal(editing.editing(), null, 'detached');
});

test('Walk and Fly: the AGL from the model’s ground keeps its own step, not the data’s floor', () => {
  // The data floor at 10 m (Blocks re-anchoring after an entry) rounded
  // the eye's 1.62 m to "0 m".
  const coarse = viewPrecision({ footprintM: 0.005, floor: { floorM: 10 } });
  assert.equal(coarse.stepM, 10);
  assert.equal(
    formatCameraReadout(reading({ aglM: 1.62 }), coarse).agl.text,
    '0 m',
    'the data’s step, as before',
  );
  assert.equal(
    formatCameraReadout(reading({ aglM: 1.62, aglStepM: 0.1 }), coarse).agl
      .text,
    '1.6 m',
  );
});
