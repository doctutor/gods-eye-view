// Personal fork: the DEM stack (src/data/demStack.js), the terrain layers'
// choice of elevation source by place and zoom.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ARCTIC_BOXES,
  DEM_BANDS,
  DEM_MAX_ZOOM,
  DEM_SOURCES,
  DEM_STACK_NOTICE,
  DRAPE_ZOOM_K_M,
  US_BOXES,
  bandForHeight,
  bandForZoom,
  bandHeights,
  bandLayers,
  demBand,
  demSource,
  demVariants,
  drapeZoomForHeight,
  maxZoomInRect,
  sourceCovers,
  sourceNameAt,
  sourcesAt,
  sourcesInRect,
  tilePixelM,
} from './demStack.js';
import { RIVER_ZOOM_K_M, riverZoomForHeight } from './earthEngineLayers.js';
import { demSourceCredit } from './dataCredits.js';

const band = (key) => demBand(key);
const names = (list) => list.map((entry) => entry.key);

test('the drape zoom is the Rivers’ (Cesium 1.138, 1,600 px canvas)', () => {
  assert.equal(DRAPE_ZOOM_K_M, RIVER_ZOOM_K_M);
  for (const height of [20_000_000, 3_337_500, 1_000_000, 50_000, 5_000, 300])
    assert.equal(drapeZoomForHeight(height), riverZoomForHeight(height));
  // A Web Mercator tile pixel: 156.5 km at z 0 on the equator, halved per zoom
  // and by cos(latitude).
  assert.ok(Math.abs(tilePixelM(0) - 156_543) < 1);
  assert.ok(Math.abs(tilePixelM(12, 40) - 29.3) < 0.1);
  assert.ok(Math.abs(tilePixelM(11, 70) - 26.1) < 0.1);
});

test('every source is named, credited and bounded; FABDEM carries its licence and Copernicus’ notice', () => {
  assert.deepEqual(names(DEM_SOURCES), [
    'gmted',
    'fabdem',
    'rema',
    'arcticdem',
    '3dep10',
    '3dep1',
  ]);
  for (const entry of DEM_SOURCES) {
    assert.match(entry.name, /\d m$/, entry.key);
    assert.ok(entry.credit.length > 20, entry.key);
    assert.match(entry.url, /^https:\/\//, entry.key);
    assert.ok(entry.maxZoom >= 10 && entry.maxZoom <= DEM_MAX_ZOOM, entry.key);
  }
  const fabdem = demSource('fabdem');
  assert.equal(fabdem.asset.collection, 'projects/sat-io/open-datasets/FABDEM');
  assert.equal(fabdem.asset.band, 'b1');
  assert.equal(fabdem.asset.seaIsZero, true, 'water inside a land tile is 0');
  assert.match(
    fabdem.credit,
    /FABDEM v1-2 © University of Bristol \/ Fathom, CC BY-NC-SA 4\.0/,
  );
  assert.match(
    fabdem.credit,
    /© DLR e\.V\. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved/,
  );
  assert.equal(
    demSource('3dep10').asset.collection,
    'USGS/3DEP/10m_collection',
  );
  assert.equal(demSource('3dep1').asset.perImage, true, 'many UTM zones');
  assert.equal(demSource('arcticdem').asset.maskBand, 'datamask');
  assert.equal(demSource('arcticdem').ellipsoidal, true);
  assert.equal(demSource('rema').ellipsoidal, true);
  assert.match(
    demSource('arcticdem').credit,
    /Polar Geospatial Center under NSF-OPP awards/,
  );
  // Every box fits Web Mercator (a box to the pole cannot be transformed).
  for (const entry of DEM_SOURCES)
    for (const [west, south, east, north] of entry.boxes || []) {
      assert.ok(west < east && south < north, entry.key);
      assert.ok(Math.abs(south) <= 85.1 && Math.abs(north) <= 85.1, entry.key);
    }
  assert.equal(demSource('nope'), null);
  assert.match(DEM_STACK_NOTICE, /GMTED2010.*FABDEM.*REMA.*ArcticDEM.*3DEP/);
  // The popover entry: linked, escaped, keyed per source.
  const credit = demSourceCredit(fabdem);
  assert.equal(credit.key, 'dem-fabdem');
  assert.match(
    credit.html,
    /^Elevation, <a href="https:\/\/data\.bris\.ac\.uk\/[^"]+"[^>]*>FABDEM 30 m<\/a>: FABDEM v1-2/,
  );
  assert.match(credit.html, /Google Earth Engine<\/a>$/);
  assert.doesNotMatch(
    demSourceCredit({ key: 'x', name: '<b>', credit: 'a & b' }).html,
    /<b>|a & b/,
  );
});

test('the bands: GMTED2010 far out, FABDEM from z 6, ArcticDEM from 11, 3DEP 10 m from 13 and 1 m from 14', () => {
  assert.deepEqual(
    DEM_BANDS.map((entry) => [entry.key, ...entry.zooms]),
    [
      ['far', 0, 5],
      ['base', 6, 10],
      ['polar', 11, 12],
      ['fine', 13, 13],
      ['finest', 14, 17],
    ],
  );
  const order = (key, options) =>
    bandLayers(band(key), options).map((entry) =>
      entry.mask ? `${entry.source}:${entry.mask}` : entry.source,
    );
  // Bottom to top: polar sources fill beneath the base until their band.
  assert.deepEqual(order('far'), ['arcticdem:datamask', 'rema', 'gmted']);
  assert.deepEqual(order('base'), ['arcticdem:datamask', 'rema', 'fabdem']);
  assert.deepEqual(order('polar'), ['fabdem', 'rema', 'arcticdem:land']);
  assert.deepEqual(order('fine'), [
    'fabdem',
    'rema',
    '3dep10',
    'arcticdem:land',
  ]);
  assert.deepEqual(order('finest'), [
    'fabdem',
    'rema',
    '3dep10',
    'arcticdem:land',
    '3dep1',
  ]);
  // Heights (Elevation): the ellipsoidal sources only ever fill beneath.
  assert.deepEqual(order('finest', { heights: true }), [
    'rema',
    'arcticdem:datamask',
    'fabdem',
    '3dep10',
    '3dep1',
  ]);
  // Why those zooms: a source joins where a tile pixel is smaller than the
  // one beneath it at its region's latitude.
  assert.ok(tilePixelM(13, 37) < 30 && tilePixelM(12, 37) > 30, '3DEP 10 m');
  assert.ok(tilePixelM(14, 37) < 10 && tilePixelM(13, 37) > 10, '3DEP 1 m');
  assert.ok(tilePixelM(11, 70) < 30 && tilePixelM(10, 70) > 30, 'ArcticDEM');
  assert.ok(
    tilePixelM(6, 0) > 231,
    'FABDEM from z 6 shows no more than GMTED there',
  );
});

test('bands by zoom and by height agree with Cesium’s drape zoom', () => {
  assert.deepEqual(
    [0, 3, 5, 6, 10, 11, 12, 13, 14, 17, 20].map((z) => bandForZoom(z).key),
    [
      'far',
      'far',
      'far',
      'base',
      'base',
      'polar',
      'polar',
      'fine',
      'finest',
      'finest',
      'finest',
    ],
  );
  for (const entry of DEM_BANDS) {
    const { minHeightM, maxHeightM } = bandHeights(entry);
    if (minHeightM) {
      assert.equal(bandForHeight(minHeightM).key, entry.key);
      assert.equal(drapeZoomForHeight(minHeightM), entry.zooms[1]);
    }
    if (maxHeightM) {
      assert.notEqual(bandForHeight(maxHeightM).key, entry.key);
      assert.equal(bandForHeight(maxHeightM - 1).key, entry.key);
      assert.equal(drapeZoomForHeight(maxHeightM - 1), entry.zooms[0]);
    }
  }
  assert.deepEqual(bandHeights(band('far')), { minHeightM: 3_337_500 });
  assert.deepEqual(bandHeights(band('finest')), { maxHeightM: 13_037.109375 });
  const variants = demVariants();
  assert.deepEqual(
    variants.map((v) => [v.key, v.stack, v.auto]),
    DEM_BANDS.map((entry) => [entry.key, entry.key, true]),
  );
  assert.equal(variants[0].heights, undefined);
  assert.ok(demVariants({ heights: true }).every((v) => v.heights === true));
});

test('the source named at a point: the top one whose region holds it', () => {
  const at = (lat, lon, key, options) =>
    sourceNameAt(lat, lon, band(key), options);
  // A US view (Mount Rainier), an Arctic one (Tromsø), elsewhere (the Alps),
  // Antarctica (McMurdo), Greenland.
  assert.equal(at(46.85, -121.76, 'far'), 'GMTED2010 230 m');
  assert.equal(at(46.85, -121.76, 'base'), 'FABDEM 30 m');
  assert.equal(at(46.85, -121.76, 'polar'), 'FABDEM 30 m');
  assert.equal(at(46.85, -121.76, 'fine'), 'USGS 3DEP 10 m');
  assert.equal(
    at(46.85, -121.76, 'finest'),
    'USGS 3DEP 1 m / USGS 3DEP 10 m',
    'lidar is patchy: the source beneath is named too',
  );
  assert.equal(at(69.65, 18.96, 'base'), 'FABDEM 30 m');
  assert.equal(at(69.65, 18.96, 'polar'), 'ArcticDEM 2 m');
  assert.equal(at(69.65, 18.96, 'polar', { heights: true }), 'FABDEM 30 m');
  assert.equal(at(46.5, 8.0, 'finest'), 'FABDEM 30 m');
  assert.equal(at(-77.85, 166.67, 'base'), 'REMA 8 m');
  assert.equal(at(-77.85, 166.67, 'far'), 'REMA 8 m');
  assert.equal(
    at(72, -40, 'far'),
    'ArcticDEM 2 m',
    'GMTED2010 has no Greenland',
  );
  assert.equal(at(81, 55, 'base'), 'ArcticDEM 2 m', 'north of FABDEM');
  // Alaska: ArcticDEM (2 m) over 3DEP 10 m north of 60°; the panhandle 3DEP.
  assert.equal(at(61.2, -149.9, 'fine'), 'ArcticDEM 2 m');
  assert.equal(at(58.3, -134.4, 'fine'), 'USGS 3DEP 10 m');
  // Over the border: Whitehorse is Canada's, Vancouver too (north of 49°).
  assert.equal(at(60.7, -135.05, 'fine'), 'ArcticDEM 2 m');
  assert.equal(at(49.25, -123.1, 'fine'), 'FABDEM 30 m');
  assert.equal(
    at(48.43, -123.37, 'fine'),
    'USGS 3DEP 10 m',
    'Victoria: in the box (3DEP has no data there)',
  );
  assert.deepEqual(names(sourcesAt(46.85, -121.76, band('finest'))), [
    '3dep1',
    '3dep10',
    'fabdem',
  ]);
  assert.equal(sourceCovers(demSource('gmted'), 72, -40), false);
  assert.equal(sourceCovers(demSource('fabdem'), -70, 0), false);
  assert.equal(at(0, -30, 'fine'), 'FABDEM 30 m', 'the sea: the base by name');
});

test('the sources a view shows, and how deep it asks', () => {
  const rainier = { west: -122.5, south: 46.5, east: -121, north: 47.2 };
  const alps = { west: 7, south: 46, east: 9, north: 47 };
  const border = { west: -123, south: 48.5, east: -122, north: 49.5 };
  const tromso = { west: 18, south: 69, east: 20, north: 70 };
  assert.deepEqual(names(sourcesInRect(rainier, band('finest'))), [
    'fabdem',
    '3dep10',
    '3dep1',
  ]);
  assert.deepEqual(names(sourcesInRect(alps, band('finest'))), ['fabdem']);
  assert.deepEqual(names(sourcesInRect(tromso, band('polar'))), [
    'fabdem',
    'arcticdem',
  ]);
  assert.deepEqual(names(sourcesInRect(border, band('fine'))), [
    'fabdem',
    '3dep10',
  ]);
  assert.deepEqual(names(sourcesInRect(null, band('far'))), [
    'arcticdem',
    'rema',
    'gmted',
  ]);
  assert.equal(maxZoomInRect(rainier), 17, '3DEP 1 m');
  assert.equal(maxZoomInRect(alps), 14, 'FABDEM');
  assert.equal(maxZoomInRect(tromso), 16, 'ArcticDEM');
  assert.equal(maxZoomInRect(rainier, 14), 14, 'capped by the layer');
  assert.equal(maxZoomInRect(null), 17, 'the world');
  assert.ok(US_BOXES.length >= 8 && ARCTIC_BOXES[0][1] === 60);
});
