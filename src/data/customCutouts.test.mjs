// Personal fork: the Custom cutouts model (src/data/customCutouts.js): the
// Overpass queries pass the proxy's sanitizer, is_in and relation answers
// become cutouts, rings fit the vertex budget, and the list and the URL
// round-trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CUTOUT_VERTEX_BUDGET,
  MAX_CUTOUTS,
  OSM_AREA_OFFSET,
  addCutout,
  areasFromIsIn,
  cutoutFromRelationGeometry,
  decodeCutouts,
  encodeCutouts,
  isInQuery,
  relationGeometryQuery,
  removeCutout,
  simplifyRings,
  updateCutout,
  visibleRings,
} from './customCutouts.js';
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
