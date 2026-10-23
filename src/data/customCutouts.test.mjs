// Personal fork: the Custom cutouts model (src/data/customCutouts.js): the
// Overpass queries pass the proxy's sanitizer, is_in and relation answers
// become cutouts, rings fit the vertex budget, and the list and the URL
// round-trip; drawn rings travel in their source key, crossing rings are
// caught, and a ring's winding never matters.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CUTOUT_SOURCE_PATTERNS,
  CUTOUT_VERTEX_BUDGET,
  DRAW_MAX_VERTICES,
  MAX_CUTOUTS,
  OSM_AREA_OFFSET,
  addCutout,
  areasFromIsIn,
  cutoutFromRelationGeometry,
  decodeCutouts,
  decodeDrawnRing,
  encodeCutouts,
  encodeDrawnRing,
  isCutoutSource,
  nextDrawnName,
  pathSelfIntersects,
  ringSelfIntersects,
  ringSignedArea,
  isInQuery,
  relationGeometryQuery,
  removeCutout,
  simplifyRings,
  updateCutout,
  visibleRings,
} from './customCutouts.js';
import { parcelSourceKey, parseParcelSourceKey } from './mdParcels.js';
import {
  isOverpassBoundaryQuery,
  sanitizeOverpassBody,
} from '../../server/providers/overpass/query.js';

/** A wiggly ring of n points around (lon, lat), radius r degrees. */
function circle(lon, lat, r, n) {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    const wobble = 1 + 0.02 * Math.sin(i * 7.3);
    return [lon + r * wobble * Math.cos(a), lat + r * wobble * Math.sin(a)];
  });
}

test('both queries pass the Overpass proxy sanitizer and are boundary-class', () => {
  const isIn = isInQuery(39.3699, -76.6131);
  assert.match(isIn, /is_in\(39\.369900,-76\.613100\)/);
  const geometry = relationGeometryQuery(133345);
  assert.match(geometry, new RegExp(`area\\(${OSM_AREA_OFFSET + 133345}\\)`));
  for (const query of [isIn, geometry]) {
    const checked = sanitizeOverpassBody(`data=${encodeURIComponent(query)}`);
    assert.equal(checked.ok, true, `${query}: ${checked.error}`);
    assert.ok(isOverpassBoundaryQuery(query), `${query} keeps 30 days`);
  }
  // The plain id form is refused: it is why the pivot form is used.
  assert.equal(
    sanitizeOverpassBody(
      `data=${encodeURIComponent('[out:json];relation(133345);out geom;')}`,
    ).ok,
    false,
  );
});

test('is_in answers list the relations at the point, most local first', () => {
  const areas = areasFromIsIn({
    elements: [
      {
        type: 'area',
        id: OSM_AREA_OFFSET + 162110,
        tags: {
          admin_level: '4',
          name: 'Maryland',
          boundary: 'administrative',
        },
      },
      {
        type: 'area',
        id: OSM_AREA_OFFSET + 133345,
        tags: {
          admin_level: '6',
          name: 'Baltimore',
          boundary: 'administrative',
        },
      },
      {
        type: 'area',
        id: OSM_AREA_OFFSET + 9999,
        tags: { admin_level: '10', name: 'Cedarcroft' },
      },
      // A closed way's area (2400000000 + way id) has no relation: left out.
      {
        type: 'area',
        id: 2_400_000_123,
        tags: { admin_level: '8', name: 'Way' },
      },
      { type: 'area', id: OSM_AREA_OFFSET + 5, tags: { name: 'No level' } },
    ],
  });
  assert.deepEqual(areas, [
    { relationId: 9999, name: 'Cedarcroft', level: 10 },
    { relationId: 133345, name: 'Baltimore', level: 6 },
    { relationId: 162110, name: 'Maryland', level: 4 },
  ]);
  assert.deepEqual(areasFromIsIn(null), []);
});

test('a relation becomes outer rings, stitched, islets and holes left out, within the budget', () => {
  // The outer boundary in three ways, one reversed; a hole; an islet.
  const ring = circle(-76.61, 39.3, 0.1, 1500).map(([lon, lat]) => ({
    lon,
    lat,
  }));
  ring.push(ring[0]);
  const ways = [
    ring.slice(0, 600),
    ring.slice(599, 1100).reverse(),
    ring.slice(1099),
  ];
  const hole = circle(-76.61, 39.3, 0.01, 50).map(([lon, lat]) => ({
    lon,
    lat,
  }));
  hole.push(hole[0]);
  const islet = circle(-76.4, 39.3, 0.0001, 8).map(([lon, lat]) => ({
    lon,
    lat,
  }));
  islet.push(islet[0]);
  const second = circle(-76.0, 39.0, 0.05, 900).map(([lon, lat]) => ({
    lon,
    lat,
  }));
  second.push(second[0]);
  const cutout = cutoutFromRelationGeometry({
    elements: [
      {
        type: 'relation',
        id: 133345,
        tags: { name: 'Baltimore', admin_level: '6' },
        members: [
          ...ways.map((geometry) => ({ type: 'way', role: 'outer', geometry })),
          { type: 'way', role: 'inner', geometry: hole },
          { type: 'way', role: 'outer', geometry: islet },
          { type: 'way', role: 'outer', geometry: second },
          { type: 'node', role: 'admin_centre', lat: 39.29, lon: -76.61 },
        ],
      },
    ],
  });
  assert.equal(cutout.relationId, 133345);
  assert.equal(cutout.name, 'Baltimore');
  assert.equal(cutout.level, 6);
  assert.equal(
    cutout.rings.length,
    2,
    'two outer rings; the hole and the islet left out',
  );
  const vertices = cutout.rings.reduce((sum, r) => sum + r.length, 0);
  assert.ok(vertices <= CUTOUT_VERTEX_BUDGET, `${vertices} vertices`);
  assert.ok(vertices >= 40, 'still a shape');
  for (const r of cutout.rings) {
    assert.notDeepEqual(r[0], r[r.length - 1], 'not closed twice');
    for (const [lon, lat] of r)
      assert.ok(Number.isFinite(lon) && Number.isFinite(lat));
  }
  // An unclosed relation (half its boundary missing) gives no cutout.
  assert.equal(
    cutoutFromRelationGeometry({
      elements: [
        {
          type: 'relation',
          id: 1,
          tags: { name: 'Broken' },
          members: [
            { type: 'way', role: 'outer', geometry: ring.slice(0, 700) },
          ],
        },
      ],
    }),
    null,
  );
  assert.equal(cutoutFromRelationGeometry({ elements: [] }), null);
});

test('ring simplification: small rings kept, big ones shared down to the budget', () => {
  const small = circle(0, 0, 1, 50);
  assert.deepEqual(simplifyRings([small], 400), [small]);
  const closed = [...small, small[0]];
  assert.equal(
    simplifyRings([closed], 400)[0].length,
    50,
    'the closing repeat dropped',
  );
  const big = [circle(0, 0, 1, 5000), circle(5, 5, 0.2, 2000)];
  const out = simplifyRings(big, 300);
  const total = out.reduce((sum, r) => sum + r.length, 0);
  assert.ok(total <= 300 && total > 200, `${total} vertices`);
  assert.ok(out[0].length > out[1].length, 'the bigger ring keeps more');
  assert.ok(out.every((r) => r.length >= 4));
});

test('the list: add, rename, hide, show, remove, the visible rings', () => {
  const ring = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  let list = addCutout([], {
    source: 'osm:133345',
    name: '  Baltimore  ',
    level: 6,
    rings: [ring],
  });
  list = addCutout(list, {
    source: 'osm:9999',
    name: 'Cedarcroft',
    level: 10,
    rings: [ring, ring],
  });
  assert.deepEqual(
    list.map((c) => [c.source, c.name, c.visible]),
    [
      ['osm:133345', 'Baltimore', true],
      ['osm:9999', 'Cedarcroft', true],
    ],
  );
  assert.equal(visibleRings(list).length, 3);
  list = updateCutout(list, 'osm:9999', { visible: false });
  assert.equal(visibleRings(list).length, 1);
  list = updateCutout(list, 'osm:133345', { name: 'Baltimore City' });
  assert.equal(list[0].name, 'Baltimore City');
  assert.equal(
    updateCutout(list, 'osm:133345', { name: '   ' })[0].name,
    'Baltimore City',
    'an empty name keeps the old',
  );
  // Added again: shown again, not doubled.
  list = addCutout(list, { source: 'osm:9999', name: 'x' });
  assert.equal(list.length, 2);
  assert.equal(list[1].visible, true);
  assert.equal(list[1].name, 'Cedarcroft');
  list = removeCutout(list, 'osm:133345');
  assert.deepEqual(
    list.map((c) => c.source),
    ['osm:9999'],
  );
  // Bad sources and a full list add nothing.
  assert.equal(addCutout([], { source: 'javascript:1' }).length, 0);
  let full = [];
  for (let i = 0; i < MAX_CUTOUTS + 3; i++)
    full = addCutout(full, { source: `osm:${i + 1}` });
  assert.equal(full.length, MAX_CUTOUTS);
});

test('the URL token: the plate, sources, visibility and names round-trip; rings are not in it', () => {
  const ring = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  let cutouts = addCutout([], {
    source: 'osm:133345',
    name: 'Baltimore',
    rings: [ring],
  });
  cutouts = addCutout(cutouts, {
    source: 'pack:baltimore-cedarcroft',
    name: 'Cedar~croft & co',
    rings: [ring],
  });
  cutouts = updateCutout(cutouts, 'pack:baltimore-cedarcroft', {
    visible: false,
  });
  const token = encodeCutouts({ plate: 'white', cutouts });
  assert.equal(
    token,
    'white~osm:133345*Baltimore~pack:baltimore-cedarcroft!Cedar%7Ecroft%20%26%20co',
  );
  assert.doesNotMatch(token, /\[|\d\.\d/, 'no coordinates');
  const back = decodeCutouts(token);
  assert.equal(back.plate, 'white');
  assert.deepEqual(
    back.cutouts.map((c) => [c.source, c.name, c.visible, c.rings]),
    [
      ['osm:133345', 'Baltimore', true, null],
      ['pack:baltimore-cedarcroft', 'Cedar~croft & co', false, null],
    ],
  );
  assert.deepEqual(decodeCutouts(''), { plate: 'black', cutouts: [] });
  assert.deepEqual(
    decodeCutouts('pink~evil*x~osm:1*ok').cutouts.map((c) => c.source),
    ['osm:1'],
  );
  assert.equal(decodeCutouts('pink').plate, 'black');
});

test('a drawn ring in its key: round-trips at 1e-6°, anywhere on Earth, URL-safe, capped', () => {
  const lot = [
    [-76.631234, 39.340123],
    [-76.630988, 39.34013],
    [-76.630981, 39.339877],
    [-76.63123, 39.339871],
  ];
  const key = encodeDrawnRing(lot);
  assert.match(key, /^draw:[A-Za-z0-9_-]+$/, 'no separator, nothing escaped');
  const payload = key.slice('draw:'.length);
  assert.equal(encodeURIComponent(payload), payload, 'nothing to escape');
  assert.ok(key.length < 40, `${key.length} characters for a lot`);
  assert.deepEqual(decodeDrawnRing(key), lot);
  // All four quadrants, the poles and the antimeridian, and 1e-6 steps.
  const far = [
    [-179.999999, -89.999999],
    [179.999999, 89.999999],
    [0.000001, -0.000001],
    [151.2093, -33.8688],
    [-0.1276, 51.5072],
  ];
  assert.deepEqual(decodeDrawnRing(encodeDrawnRing(far)), far);
  const rounded = decodeDrawnRing(
    encodeDrawnRing([
      [1.23456789, 2.98765432],
      [2, 2],
      [2, 3],
    ]),
  );
  assert.deepEqual(rounded[0], [1.234568, 2.987654], 'kept to 1e-6°');

  const many = (n) =>
    Array.from({ length: n }, (_, i) => {
      const a = (2 * Math.PI * i) / n;
      return [-76.6 + 0.01 * Math.cos(a), 39.3 + 0.01 * Math.sin(a)];
    });
  const capped = encodeDrawnRing(many(DRAW_MAX_VERTICES));
  assert.equal(decodeDrawnRing(capped).length, DRAW_MAX_VERTICES);
  assert.ok(capped.length < 1200, `the cap is ${capped.length} characters`);
  assert.equal(encodeDrawnRing(many(DRAW_MAX_VERTICES + 1)), null);
  assert.equal(encodeDrawnRing(lot.slice(0, 2)), null, 'under 3 corners');
  assert.equal(
    encodeDrawnRing([
      [0, 91],
      [1, 1],
      [2, 2],
    ]),
    null,
  );
  for (const bad of ['draw:', 'draw:A', 'draw:a*b', 'osm:1', 'draw:AAAA', ''])
    assert.equal(decodeDrawnRing(bad), null, bad);
  assert.ok(DRAW_MAX_VERTICES <= CUTOUT_VERTEX_BUDGET, 'never simplified');
});

test('the accepted source keys are one list; a drawn cutout round-trips through the cc token with its ring', () => {
  assert.ok(Array.isArray(CUTOUT_SOURCE_PATTERNS));
  for (const ok of ['osm:133345', 'pack:baltimore-cedarcroft', 'draw:AbC-_9'])
    assert.equal(isCutoutSource(ok), true, ok);
  for (const no of ['osm:x', 'draw:a~b', 'draw:a*b', 'draw:a!b', 'evil:1'])
    assert.equal(isCutoutSource(no), false, no);

  const ring = [
    [-76.63, 39.34],
    [-76.62, 39.34],
    [-76.62, 39.33],
  ];
  const source = encodeDrawnRing(ring);
  let cutouts = addCutout([], { source: 'osm:133345', name: 'Baltimore' });
  cutouts = addCutout(cutouts, { source, name: 'Drawn 1' });
  assert.deepEqual(cutouts[1].rings, [ring], 'decoded on the way in');
  assert.equal(
    addCutout(cutouts, { source: 'draw:AAAA', name: 'x' }),
    cutouts,
    'a drawn key that does not decode is refused',
  );
  const token = encodeCutouts({ plate: 'black', cutouts });
  assert.equal(token, `black~osm:133345*Baltimore~${source}*Drawn%201`);
  const back = decodeCutouts(token).cutouts;
  assert.deepEqual(
    back.map((c) => [c.source, c.name, c.visible, c.rings]),
    [
      ['osm:133345', 'Baltimore', true, null],
      [source, 'Drawn 1', true, [ring]],
    ],
  );
  assert.equal(nextDrawnName(back), 'Drawn 2');
  assert.equal(nextDrawnName([]), 'Drawn 1');
  assert.equal(
    nextDrawnName([{ source: 'osm:1', name: 'Drawn 7' }]),
    'Drawn 1',
    'only drawn cutouts count',
  );
});

test('crossing rings are caught; a ring drawn either way round clips the same', () => {
  const square = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const concave = [
    [0, 0],
    [4, 0],
    [4, 4],
    [2, 1],
    [0, 4],
  ];
  assert.equal(ringSelfIntersects(square), false);
  assert.equal(ringSelfIntersects(concave), false);
  assert.equal(ringSelfIntersects(square.slice(0, 3)), false);
  // A bow tie, a figure of eight, a corner on another edge, a spike, a line.
  for (const crossing of [
    [square[0], square[2], square[1], square[3]],
    [
      [0, 0],
      [2, 2],
      [2, 0],
      [0, 2],
      [-1, 1],
    ],
    [
      [0, 0],
      [2, 0],
      [2, 2],
      [1, 0],
      [0, 2],
    ],
    [
      [0, 0],
      [2, 0],
      [1, 0],
      [1, 1],
    ],
    [
      [0, 0],
      [1, 0],
      [2, 0],
    ],
  ])
    assert.equal(ringSelfIntersects(crossing), true, JSON.stringify(crossing));
  // Open: only the edges drawn so far.
  assert.equal(
    pathSelfIntersects([
      [0, 0],
      [1, 0],
      [1, 1],
      [0.5, -1],
    ]),
    true,
  );
  assert.equal(
    pathSelfIntersects([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]),
    false,
  );

  assert.ok(ringSignedArea(square) > 0, 'counter-clockwise is positive');
  const clockwise = [...square].reverse();
  assert.ok(ringSignedArea(clockwise) < 0);
  const one = visibleRings([{ visible: true, rings: [square] }]);
  const other = visibleRings([{ visible: true, rings: [clockwise] }]);
  assert.ok(ringSignedArea(one[0]) > 0 && ringSignedArea(other[0]) > 0);
  assert.deepEqual(
    new Set(other[0].map(String)),
    new Set(square.map(String)),
    'the same corners',
  );
});

test('all four kinds in one list round-trip through the cc token; no kind reads as another, none holds a separator', () => {
  const ring = [
    [-76.6132, 39.3701],
    [-76.6129, 39.3701],
    [-76.613, 39.3698],
  ];
  const drawn = encodeDrawnRing(ring);
  const parcel = parcelSourceKey({
    jurscode: 'BACI',
    acctid: '0327665082 008A',
  });
  assert.equal(parcel, 'mdp:BACI-0327665082_008A');
  let cutouts = [];
  for (const [source, name] of [
    ['osm:133345', 'Baltimore'],
    ['pack:baltimore-city', 'Baltimore city'],
    [parcel, '6204 SYCAMORE RD'],
    [drawn, 'Drawn 1'],
  ])
    cutouts = addCutout(cutouts, { source, name });
  assert.equal(cutouts.length, 4, 'every kind accepted');
  cutouts = updateCutout(cutouts, parcel, { visible: false });
  const token = encodeCutouts({ plate: 'white', cutouts });
  assert.equal(
    token,
    `white~osm:133345*Baltimore~pack:baltimore-city*Baltimore%20city~${parcel}!6204%20SYCAMORE%20RD~${drawn}*Drawn%201`,
  );
  const back = decodeCutouts(token);
  assert.equal(back.plate, 'white');
  assert.deepEqual(
    back.cutouts.map((c) => [c.source, c.name, c.visible, c.rings]),
    [
      ['osm:133345', 'Baltimore', true, null],
      ['pack:baltimore-city', 'Baltimore city', true, null],
      [parcel, '6204 SYCAMORE RD', false, null],
      [drawn, 'Drawn 1', true, [ring]],
    ],
    'fetched kinds come back to fetch; the drawn ring from its key',
  );
  assert.equal(encodeCutouts(back), token, 'and out again the same');

  // A key of one kind never reads as another.
  assert.equal(parseParcelSourceKey(drawn), null);
  assert.equal(decodeDrawnRing(parcel), null);
  assert.equal(isCutoutSource('draw:BACI-0327665082_008A'), true);
  assert.equal(parseParcelSourceKey('draw:BACI-0327665082_008A'), null);
  assert.equal(isCutoutSource('mdp:AbC-x'), false, 'jurscode is capitals');
  assert.equal(isCutoutSource('mdp:BACI-a-b'), false, 'one dash only');
  // No pattern lets a separator in, wherever it is put.
  for (const pattern of CUTOUT_SOURCE_PATTERNS) {
    const whole = new RegExp(`^(?:${pattern})$`);
    for (const key of ['osm:1', 'pack:a', parcel, drawn]) {
      if (!whole.test(key)) continue;
      for (const separator of ['~', '*', '!'])
        for (const at of [key.indexOf(':') + 1, key.length - 1, key.length])
          assert.equal(
            whole.test(key.slice(0, at) + separator + key.slice(at)),
            false,
            `${pattern} with ${separator} in ${key}`,
          );
    }
  }
});
