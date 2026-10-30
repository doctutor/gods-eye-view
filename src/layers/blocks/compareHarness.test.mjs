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
  heightLabel,
  parseAltitudes,
  parsePlace,
  proxy,
  parseBlocksStatus,
  scaleViews,
  blocksStyleTile,
} from '../../../scripts/qa-blocks-compare.mjs';
import zlib from 'node:zlib';
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
  assert.deepEqual(Object.keys(shots), ['judgement', 'eye', 'third']);
  // Third person: Walk from the link, the view kept in this browser.
  assert.equal(shots.third.nav, 'walk');
  assert.equal(shots.third.viewMode, 'back');
  assert.equal(shots.third.blocksOnly, true);
  assert.equal(
    new URLSearchParams(
      pageHash({ blocks: true, view: shots.third.view, nav: 'walk' }).slice(1),
    ).get('nav'),
    'walk',
  );
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
  const { groupQuery, parseFootprints, buildingHeightM } =
    await import('./structures.js');
  const around = groupQuery({
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
  const far = groupQuery({
    west: VIEW.lon + 0.1,
    south: VIEW.lat + 0.1,
    east: VIEW.lon + 0.11,
    north: VIEW.lat + 0.11,
  });
  assert.deepEqual(overpassAnswer(far).elements, []);
});

test('--live: which routes go to the running server, whether one answers, and the eye standing on live ground', async () => {
  const { isLiveRoute, liveServerUp, liveEyeView, LIVE_ROUTES } =
    await import('../../../scripts/qa-blocks-compare.mjs');
  const { encodeRasterValues } = await import('../../data/rasterValues.js');
  assert.deepEqual(LIVE_ROUTES, [
    '/api/raster/values',
    '/api/overpass',
    '/api/earth-engine/',
    '/api/geocode',
    '/api/google/',
  ]);
  // The location search (--sequence).
  assert.equal(isLiveRoute('/api/geocode'), true);
  assert.equal(isLiveRoute('/api/google/text-search'), true);
  assert.equal(isLiveRoute('/api/raster/values'), true);
  assert.equal(isLiveRoute('/api/overpass'), true);
  assert.equal(isLiveRoute('/api/earth-engine/layers'), true);
  assert.equal(
    isLiveRoute('/api/earth-engine/tile/ee-elevation/zoom/default/17/1/2'),
    true,
  );
  assert.equal(isLiveRoute('/api/raster/values/extra'), false);
  assert.equal(isLiveRoute('/api/cctv/featured/pending'), false);
  // A server that answers, one that errors, none at all.
  assert.equal(
    await liveServerUp('http://x', async () => ({ status: 200 })),
    true,
  );
  assert.equal(
    await liveServerUp('http://x', async () => ({ status: 503 })),
    false,
  );
  assert.equal(
    await liveServerUp('http://x', async () => {
      throw new Error('ECONNREFUSED');
    }),
    false,
  );
  // The eye: 1.7 m over the top of the block holding the highest probe value.
  let asked = '';
  const body = encodeRasterValues(
    {
      layer: 'ee-elevation',
      mode: '',
      cols: 2,
      rows: 2,
      west: 0,
      south: 0,
      east: 1,
      north: 1,
      cellSizeM: 2,
    },
    new Float32Array([41.2, 42.9, NaN, 40]),
  );
  const eye = await liveEyeView('http://x', async (url) => {
    asked = url;
    return {
      ok: true,
      arrayBuffer: async () =>
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  });
  assert.match(asked, /^http:\/\/x\/api\/raster\/values\?layer=ee-elevation/);
  assert.equal(eye.alt, 43 + 1.7);
  assert.equal(eye.pitch, -5);
  assert.equal(eye.lat, VIEW.lat);
});

test('--altitudes: Baltimore from each height at pitch −45 and −90, named scale-<height>-p<pitch>', () => {
  assert.deepEqual(
    parseAltitudes('300,5000, 50000,500000,3000000'),
    [300, 5000, 50_000, 500_000, 3_000_000],
  );
  assert.deepEqual(parseAltitudes(null), []);
  assert.throws(() => parseAltitudes('high'));
  assert.equal(heightLabel(300), '300m');
  assert.equal(heightLabel(5000), '5km');
  assert.equal(heightLabel(3_000_000), '3000km');
  const shots = scaleViews([300, 3_000_000]);
  assert.deepEqual(Object.keys(shots), [
    'scale-300m-p45',
    'scale-300m-p90',
    'scale-3000km-p45',
    'scale-3000km-p90',
  ]);
  assert.deepEqual(shots['scale-3000km-p90'].view, {
    ...VIEW,
    alt: 3_000_000,
    pitch: -90,
  });
  assert.equal(shots['scale-300m-p45'].prefix, 'scale-300m-p45');
  // --place: the same shots over another place.
  assert.deepEqual(parsePlace('44,-84'), { lat: 44, lon: -84 });
  assert.equal(parsePlace(null), null);
  assert.throws(() => parsePlace('north'));
  assert.deepEqual(
    scaleViews([70_000], parsePlace('39.09,-120.04'))['scale-70km-p90'].view,
    {
      ...VIEW,
      lat: 39.09,
      lon: -120.04,
      alt: 70_000,
      pitch: -90,
    },
  );
});

test('the report reads the level from the Blocks status line', () => {
  assert.deepEqual(
    parseBlocksStatus(
      'Blocks: 1.9 km cells · 60 m levels · relief ×3 · 320 + 208 coarse · FABDEM 30 m',
    ),
    {
      state: 'ready',
      text: 'Blocks: 1.9 km cells · 60 m levels · relief ×3 · 320 + 208 coarse · FABDEM 30 m',
      blockM: 1900,
      levelM: 60,
      relief: 3,
      chunks: 320,
      coarse: 208,
    },
  );
  const cubes = parseBlocksStatus(
    'Blocks: 1 m cubes · 1,204 chunks · 3DEP 1 m · 12 loading',
  );
  assert.equal(cubes.state, 'loading');
  assert.equal(cubes.blockM, 1);
  assert.equal(cubes.levelM, 1);
  assert.equal(cubes.chunks, 1204);
  assert.equal(cubes.coarse, 0);
  assert.deepEqual(parseBlocksStatus('Blocks: come below 8 km to build'), {
    state: 'too-high',
    text: 'Blocks: come below 8 km to build',
    ceilingKm: 8,
  });
  assert.equal(parseBlocksStatus('').state, 'other');
});

/** The RGBA pixels of an encodePng image (filter 0 rows, one IDAT). */
function pngPixels(png) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  let at = 8;
  let idat = null;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString('ascii', at + 4, at + 8);
    if (type === 'IDAT') idat = png.subarray(at + 8, at + 8 + length);
    at += 12 + length;
  }
  const raw = zlib.inflateSync(idat);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    rgba.set(
      raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)),
      y * width * 4,
    );
  return { width, height, rgba };
}

test('--build serves the Elevation layer’s Blocks style: flat terrain sand on the style’s lattice, edged on each cell’s westmost and southmost eighth; transparent below the zoom band', () => {
  // 1,920 m cells (zoom band 7 to 14): the zoom-9 tile over Baltimore.
  const z = 9;
  const n = 2 ** z;
  const x = Math.floor(((-76.6292 + 180) / 360) * n);
  const lat = (39.3214 * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n,
  );
  const { rgba } = pngPixels(blocksStyleTile(1920, z, x, y));
  const counts = new Map();
  for (let at = 0; at < rgba.length; at += 4) {
    assert.equal(rgba[at + 3], 255, 'opaque in the band');
    const key = `${rgba[at]},${rgba[at + 1]},${rgba[at + 2]}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  // Two colours: the terrain's sand and its edge.
  assert.deepEqual([...counts.keys()].sort(), ['144,140,127', '200,194,176']);
  // About 1 − (7/8)² of the pixels are edges (cells of about 12 px here).
  const share = counts.get('144,140,127') / (256 * 256);
  assert.ok(share > 0.15 && share < 0.32, String(share));
  // Below the band (zoom 6 for 1,920 m): blank, as the server answers.
  const below = pngPixels(blocksStyleTile(1920, 6, 18, 24)).rgba;
  assert.ok(below.every((v) => v === 0));
});

test('the live proxy: a reset GET is asked once more; a failure after the shot ended is cut off, not an error, and nothing answers a closed page', async () => {
  const fakeRequest = (method = 'GET') => {
    const answered = [];
    return {
      answered,
      headers: () => ({}),
      method: () => method,
      postData: () => undefined,
      respond: async (reply) => answered.push(reply),
    };
  };
  const reset = () => {
    const error = new TypeError('fetch failed');
    error.cause = { code: 'ECONNRESET' };
    return error;
  };
  const url = new URL('http://gev-blocks.test/api/raster/values?cells=4');
  const newLog = () => ({ live: {}, errors: [], started: Date.now() });
  // Reset once, then answered: retried, answered, no error.
  let calls = 0;
  const flaky = async () => {
    if (calls++ === 0) throw reset();
    return new Response(new Uint8Array([1, 2]), {
      headers: { 'content-type': 'application/octet-stream' },
    });
  };
  const log = newLog();
  const request = fakeRequest();
  await proxy(request, url, 'http://localhost:4173', log, flaky);
  assert.equal(calls, 2);
  assert.equal(log.retried, 1);
  assert.deepEqual(log.errors, []);
  assert.equal(request.answered[0].status, 200);
  // Another failure while the shot runs: an error with its cause, a 502.
  const broken = newLog();
  const failed = fakeRequest();
  await proxy(failed, url, 'http://localhost:4173', broken, async () => {
    const error = new TypeError('fetch failed');
    error.cause = { code: 'ECONNREFUSED' };
    throw error;
  });
  assert.equal(broken.errors.length, 1);
  assert.match(
    broken.errors[0],
    /fetch failed \(ECONNREFUSED\), \d+ ms into the shot/,
  );
  assert.equal(failed.answered[0].status, 502);
  // After the shot's page closed: cut off, not an error, nothing answered.
  const ended = { ...newLog(), closedAt: Date.now() };
  const late = fakeRequest();
  await proxy(late, url, 'http://localhost:4173', ended, async () => {
    throw reset();
  });
  assert.equal(ended.cutOff, 1);
  assert.deepEqual(ended.errors, []);
  assert.deepEqual(late.answered, []);
  // An answer that comes after the close is counted, not sent.
  const after = fakeRequest();
  await proxy(
    after,
    url,
    'http://localhost:4173',
    ended,
    async () => new Response(new Uint8Array([1])),
  );
  assert.deepEqual(after.answered, []);
  assert.equal(ended.live['/api/raster/values'].count, 1);
});
