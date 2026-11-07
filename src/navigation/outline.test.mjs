// Personal fork: the Walk and Fly outline's lines (binding.js
// setOutlineLines) on real Cesium PolylineCollections: a mode entered, an
// outline drawn, the mode left (the collection destroyed, and with it each
// line's material, as Cesium's Polyline does), a mode entered again and an
// outline drawn: no line may hold a destroyed material. One shared Material
// did (2026-11-07): "This object was destroyed", the scene stopped.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import { outlineColor, setOutlineLines } from './binding.js';

// Cesium's Material asks whether a uniform is a canvas or an image.
const BROWSER_GLOBALS = [
  'HTMLCanvasElement',
  'HTMLImageElement',
  'ImageBitmap',
  'OffscreenCanvas',
];
const prior = new Map();
before(() => {
  for (const key of BROWSER_GLOBALS) {
    prior.set(key, globalThis[key]);
    globalThis[key] ??= class {};
  }
});
after(() => {
  for (const [key, value] of prior)
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
});

const at = (lon, lat, h) => Cesium.Cartesian3.fromDegrees(lon, lat, h);
const edges = (count) =>
  Array.from({ length: count }, (_, k) => [
    at(-76.6, 39.3, k),
    at(-76.6, 39.3, k + 1),
  ]);
const lines = (collection) =>
  Array.from({ length: collection.length }, (_, k) => collection.get(k));

test('each outline line has its own material: a mode left and entered again draws with live materials', () => {
  // Enter: a collection, an outline of 12 edges.
  const first = new Cesium.PolylineCollection();
  setOutlineLines(first, edges(12), { block: 1 });
  const firstLines = lines(first);
  assert.equal(firstLines.length, 12);
  const materials = new Set(firstLines.map((line) => line.material));
  assert.equal(materials.size, 12, 'one material a line');
  assert.ok(firstLines.every((line) => line.show && line.id?.block === 1));
  assert.equal(first.show, true);

  // Leave: the scene removes and destroys the collection, and Cesium each
  // line's material with it.
  first.destroy();
  for (const material of materials) assert.equal(material.isDestroyed(), true);

  // Enter again and outline: every line's material is alive.
  const second = new Cesium.PolylineCollection();
  setOutlineLines(second, edges(12), { block: 2 });
  for (const line of lines(second)) {
    assert.equal(line.material.isDestroyed(), false);
    assert.ok(!materials.has(line.material), 'none of the first mode’s');
  }
  // Fewer edges: the rest hidden, their ids cleared; none: nothing shown.
  setOutlineLines(second, edges(4));
  assert.deepEqual(
    lines(second).map((line) => line.show),
    [...Array(4).fill(true), ...Array(8).fill(false)],
  );
  assert.ok(lines(second).every((line, k) => k < 4 || line.id === null));
  setOutlineLines(second, []);
  assert.equal(second.show, false);
  second.destroy();
});

test('the outline’s colour: white at 0.9', () => {
  const color = outlineColor();
  assert.deepEqual(
    [color.red, color.green, color.blue, color.alpha],
    [1, 1, 1, 0.9],
  );
});
