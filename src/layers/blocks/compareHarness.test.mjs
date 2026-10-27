// Personal fork: the pure parts of the Blocks comparison harness
// (scripts/qa-blocks-compare.mjs): the synthetic heightfield, the values it
// answers /api/raster/values with, the PET colour tiles, the Earth Engine
// catalog it serves, and the link it opens.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EYE_HEIGHT_M,
  FIELD_CELLS,
  NATIVE_M,
  VIEW,
  eyeView,
  views,
  mirrorCell,
  colourTile,
  earthEngineCatalog,
  fieldBounds,
  heightAt,
  pageHash,
  petColour,
  rasterValuesBody,
  syntheticField,
} from '../../../scripts/qa-blocks-compare.mjs';
import {
  decodeRasterValues,
  parseRasterValuesQuery,
} from '../../data/rasterValues.js';
import { toCatalogLayer } from '../earthEngine/source.js';
import { decodeBlocksParam } from '../lego/renderMode.js';

test('the synthetic field: 64 × 64 at 10 m, a hill near 77 m and a valley cut to 2 m, tiled by reflection', () => {
  const field = syntheticField();
  assert.equal(field.length, FIELD_CELLS * FIELD_CELLS);
  const max = Math.max(...field);
  const min = Math.min(...field);
  assert.ok(max > 70 && max < 100, String(max));
  assert.ok(Math.abs(min - 2) < 0.5, String(min));
  // Mirrored: continuous, and the same ground a field's width either side.
  assert.equal(mirrorCell(10), 10);
  assert.equal(mirrorCell(70), 58);
  assert.equal(mirrorCell(-6), 6);
  assert.equal(mirrorCell(128 + 10), 10);
  const b = fieldBounds();
  const w = b.east - b.west;
  const mid = (b.south + b.north) / 2;
  const inside = heightAt(b.west + w * 0.3, mid, field);
  assert.ok(
    Math.abs(heightAt(b.west - w * 0.3, mid, field) - inside) < 1e-6,
    'reflected across the west edge',
  );
  assert.ok(Math.abs(heightAt(b.west + w * 2.3, mid, field) - inside) < 1e-6);
  // At a cell centre, the cell's own height.
  const c = 20;
  const r = 30;
  assert.ok(
    Math.abs(
      heightAt(
        b.west + ((c + 0.5) / FIELD_CELLS) * w,
        b.north - ((r + 0.5) / FIELD_CELLS) * (b.north - b.south),
        field,
      ) - field[r * FIELD_CELLS + c],
    ) < 1e-3,
  );
  // Everywhere covered: 3 km away is still ground from the field's range.
  const far = heightAt(b.east + 0.03, mid + 0.02, field);
  assert.ok(far >= min - 1e-6 && far <= max + 1e-6, String(far));
});

test('raster values: at 1 m native, as 3DEP 1 m, decoded by the app’s own decoder', () => {
  const field = syntheticField();
  const b = fieldBounds();
  const box = {
    west: b.west,
    south: b.south,
    east: b.west + (b.east - b.west) / 10, // 64 m
    north: b.south + (b.north - b.south) / 10,
  };
  const query = parseRasterValuesQuery({
    layer: 'ee-elevation',
    mode: '',
    west: String(box.west),
    south: String(box.south),
    east: String(box.east),
    north: String(box.north),
    cells: '256',
  });
  assert.equal(query.ok, true);
  const { header, values } = decodeRasterValues(rasterValuesBody(query, field));
  assert.equal(NATIVE_M, 1);
  assert.equal(header.cols, 64, 'never finer than 1 m');
  assert.ok(Math.abs(header.cellSizeM - 1) < 0.02, String(header.cellSizeM));
  assert.equal(header.source, 'Synthetic 1 m');
  const lon = box.west + (10.5 / 64) * (box.east - box.west);
  const lat = box.north - (20.5 / header.rows) * (box.north - box.south);
  assert.ok(Math.abs(values[20 * 64 + 10] - heightAt(lon, lat, field)) < 1e-3);
});

test('the colour tiles are PNGs in the PET rainbow; the catalog passes the client’s check; the link', () => {
  assert.deepEqual(petColour(0), [0, 0, 0]);
  assert.deepEqual(petColour(100), [255, 255, 255]);
  assert.deepEqual(petColour(500), [255, 255, 255]);
  const png = colourTile(17, 37_639, 50_150, syntheticField(), 16);
  assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47]);
  const layer = toCatalogLayer(earthEngineCatalog().layers[0]);
  assert.equal(layer.id, 'ee-elevation');
  assert.ok(layer.variants.some((v) => v.key === 'zoom' && v.ready));
  const colour = new URLSearchParams(pageHash({ blocks: false }).slice(1));
  const blocks = new URLSearchParams(pageHash({ blocks: true }).slice(1));
  assert.equal(colour.get('map'), 'blank-black');
  assert.equal(colour.get('lat'), '39.3214');
  assert.equal(colour.get('pitch'), '-30');
  assert.equal(colour.get('cs'), 'el.r.0.100.n');
  assert.equal(colour.has('bk'), false);
  assert.equal(decodeBlocksParam(blocks.get('bk')), true);
});

test('two views: the judgement view (300 m, −30°) and eye level (1.7 m above the block underfoot, −5°)', () => {
  const field = syntheticField();
  const shots = views(field);
  assert.deepEqual(Object.keys(shots), ['judgement', 'eye']);
  assert.equal(shots.judgement.view, VIEW);
  assert.equal(shots.judgement.suffix, '');
  assert.equal(shots.eye.suffix, '-eye');
  const eye = eyeView(field);
  const ground = heightAt(VIEW.lon, VIEW.lat, field);
  // The block holding the ground, its top face one block up, then the eye.
  const top = Math.floor(ground) + 1;
  assert.equal(EYE_HEIGHT_M, 1.7);
  assert.ok(
    Math.abs(eye.alt - (top + 1.7)) < 0.051,
    `${eye.alt} vs ${top + 1.7}`,
  );
  assert.equal(eye.pitch, -5);
  assert.equal(eye.lat, VIEW.lat);
  assert.equal(eye.heading, VIEW.heading);
  const hash = new URLSearchParams(
    pageHash({ blocks: true, view: eye }).slice(1),
  );
  assert.equal(hash.get('alt'), String(eye.alt));
  assert.equal(hash.get('pitch'), '-5');
});

test('the synthetic Overpass answer: the buildings in the query’s box, read by the Blocks buildings source', async () => {
  const { overpassAnswer, SYNTHETIC_BUILDINGS } =
    await import('../../../scripts/qa-blocks-compare.mjs');
  const { buildingsQuery, parseFootprints, buildingHeightM } =
    await import('./structures.js');
  const around = buildingsQuery({
    west: VIEW.lon - 0.01,
    south: VIEW.lat,
    east: VIEW.lon + 0.01,
    north: VIEW.lat + 0.01,
  });
  const all = overpassAnswer(around).elements;
  assert.equal(all.length, SYNTHETIC_BUILDINGS.length);
  const footprints = parseFootprints(all);
  assert.equal(footprints.length, all.length);
  assert.ok(footprints.every((f) => f.rings[0].length === 5));
  // The tags give the heights: 18 m, 6 storeys, 45 m, 80 m, 2 storeys, 4, none.
  assert.deepEqual(
    footprints.map((f) => Math.round(buildingHeightM(f.tags) * 10) / 10),
    [18, 19.2, 45, 80, 6.4, 12.8, 6.4],
  );
  // A box away from the town: nothing.
  const far = buildingsQuery({
    west: VIEW.lon + 0.1,
    south: VIEW.lat + 0.1,
    east: VIEW.lon + 0.11,
    north: VIEW.lat + 0.11,
  });
  assert.deepEqual(overpassAnswer(far).elements, []);
});
