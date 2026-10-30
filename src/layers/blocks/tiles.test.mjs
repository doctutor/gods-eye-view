// Personal fork: where the precomputed Blocks tilesets reach and what a
// view is drawn from (src/layers/blocks/tiles.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRegion } from './grid.js';
import {
  TILES_INDEX_URL,
  boxLabel,
  planTiles,
  tilesBox,
  tilesBoxes,
  tilesSourceText,
} from './tiles.js';

const ANCHOR = { lon0: -76.64, lat0: 39.24 };

/** A point inside group (gi, gj) of a level's map (its middle). */
function inGroup(level, gi, gj) {
  const region = createRegion({ ...ANCHOR, blockM: level });
  const groupM = 64 * 4 * level;
  const at = region.toLonLat((gi + 0.5) * groupM, (gj + 0.5) * groupM);
  return Array.isArray(at) ? { lon: at[0], lat: at[1] } : at;
}

// A city box: 120 m over 2 × 2 groups, 30 m over one of them.
const city = tilesBox({
  name: 'harbour-30',
  built: '2026-10-30T01:13:39Z',
  anchor: ANCHOR,
  levelsM: [120, 30],
  variants: [
    { file: 'tileset.json', name: 'buildings' },
    { file: 'tileset-ground.json', name: 'ground' },
  ],
  groups: {
    120: [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ],
    30: [[1, 1]],
  },
});
// A wide box: 480 m over one group, 1,920 m around it.
const wide = tilesBox({
  name: 'lower48-480',
  built: '2026-10-30T02:39:23Z',
  anchor: ANCHOR,
  levelsM: [1920, 480],
  variants: [{ file: 'tileset.json', name: 'default' }],
  groups: {
    1920: [
      [-1, -1],
      [0, -1],
      [-1, 0],
      [0, 0],
    ],
    480: [[0, 0]],
  },
});

test('a box’s floor: the finest level whose groups hold the point; null outside its tree', () => {
  assert.equal(city.floorAt(...Object.values(inGroup(30, 1, 1))), 30);
  assert.equal(city.floorAt(...Object.values(inGroup(30, 0, 0))), 120);
  assert.equal(city.floorAt(...Object.values(inGroup(120, 5, 5))), null);
  assert.equal(wide.floorAt(...Object.values(inGroup(480, 0, 0))), 480);
  assert.equal(wide.floorAt(...Object.values(inGroup(1920, -1, -1))), 1920);
  assert.equal(wide.finestM, 480);
  assert.deepEqual(wide.levelsM, [480, 1920]);
});

test('planTiles: tiles where a box reaches the view’s level and holds what it shows; hybrid where it reaches only coarser; off outside', () => {
  const boxes = [city, wide];
  const centre = inGroup(480, 0, 0);
  const near = [inGroup(480, 0, 0)];
  // The view wants 600 m cells over the 480 m group: the wide box draws it.
  let plan = planTiles(boxes, { ...centre, wantedM: 600, samples: near });
  assert.equal(plan.mode, 'tiles');
  assert.equal(plan.box, wide);
  assert.equal(plan.floorM, 480);
  // It wants 120 m: the tiles reach only 480 m there, live draws finer.
  plan = planTiles(boxes, { ...centre, wantedM: 120, samples: near });
  assert.equal(plan.mode, 'hybrid');
  assert.equal(plan.floorM, 480);
  // Walk and Fly (no level): hybrid wherever a box holds the view.
  assert.equal(planTiles(boxes, { ...centre, wantedM: NaN }).mode, 'hybrid');
  // Over the city's 30 m group, wanting 40 m: the city box, finest floor.
  const harbour = inGroup(30, 1, 1);
  plan = planTiles(boxes, { ...harbour, wantedM: 40, samples: [harbour] });
  assert.equal(plan.mode, 'tiles');
  assert.equal(plan.box, city);
  // A view that shows ground the city box does not hold: not the city's.
  plan = planTiles(boxes, {
    ...harbour,
    wantedM: 40,
    samples: [harbour, inGroup(120, 3, 3)],
  });
  assert.notEqual(plan.box, city);
  // Nothing holds it: off.
  assert.deepEqual(
    planTiles(boxes, { ...inGroup(1920, 9, 9), wantedM: 2000 }),
    { mode: 'off' },
  );
  assert.deepEqual(planTiles([], { ...centre, wantedM: 600 }), { mode: 'off' });
});

test('a box’s URL, label, month and HUD name; the index route', () => {
  assert.equal(TILES_INDEX_URL, '/api/blocks/tiles/index.json');
  assert.equal(city.url(), '/api/blocks/tiles/harbour-30/tileset.json');
  assert.equal(
    city.url({ buildings: false }),
    '/api/blocks/tiles/harbour-30/tileset-ground.json',
  );
  assert.equal(
    wide.url({ buildings: false }),
    '/api/blocks/tiles/lower48-480/tileset.json',
    'no ground variant: the default',
  );
  assert.equal(boxLabel('lower48-480'), 'lower 48');
  assert.equal(boxLabel('baltimore-harbour-30'), 'baltimore harbour');
  assert.equal(wide.month, '2026-10');
  assert.equal(
    tilesSourceText(wide, (m) => `${m} m`),
    'Blocks tiles 2026-10 · lower 48 · 480 m',
  );
  assert.equal(tilesSourceText(null), '');
  assert.equal(tilesBoxes({ boxes: [{ name: 'x' }] }).length, 0);
});
