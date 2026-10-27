// Personal fork: the pure parts of the Blocks comparison harness
// (scripts/qa-blocks-compare.mjs): the synthetic heightfield, the values it
// answers /api/raster/values with, the PET colour tiles, the Earth Engine
// catalog it serves, and the link it opens.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FIELD_CELLS,
  PLAIN_M,
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

test('the synthetic field: 64 × 64 at 10 m, a hill near 77 m and a valley cut to 2 m, the plain around it', () => {
  const field = syntheticField();
  assert.equal(field.length, FIELD_CELLS * FIELD_CELLS);
  const max = Math.max(...field);
  const min = Math.min(...field);
  assert.ok(max > 70 && max < 100, String(max));
  assert.ok(Math.abs(min - 2) < 0.5, String(min));
  const b = fieldBounds();
  assert.equal(heightAt(b.west - 0.01, b.south, field), PLAIN_M);
  assert.equal(
    heightAt((b.west + b.east) / 2, (b.south + b.north) / 2, field),
    field[(FIELD_CELLS / 2) * FIELD_CELLS + FIELD_CELLS / 2],
  );
});

test('raster values: never finer than 10 m, decoded by the app’s own decoder', () => {
  const field = syntheticField();
  const b = fieldBounds();
  const query = parseRasterValuesQuery({
    layer: 'ee-elevation',
    mode: '',
    west: String(b.west),
    south: String(b.south),
    east: String(b.east),
    north: String(b.north),
    cells: '512',
  });
  assert.equal(query.ok, true);
  const { header, values } = decodeRasterValues(rasterValuesBody(query, field));
  assert.equal(header.cols, 64);
  assert.equal(header.rows, 64);
  assert.ok(Math.abs(header.cellSizeM - 10) < 0.05, String(header.cellSizeM));
  assert.equal(header.source, 'Synthetic 10 m');
  assert.deepEqual([...values], [...field]);
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
