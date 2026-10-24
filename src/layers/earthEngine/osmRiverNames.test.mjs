// Personal fork: the Rivers layer's names from OpenStreetMap: the labels of
// the large named rivers close in, and the reach card's title and source.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  OSM_NAMES_SOURCE,
  OSM_NAME_LIMIT,
  createRiverNames,
  osmNameText,
} from './riverNames.js';
import {
  osmNameSource,
  osmNameTitle,
  reachTitle,
} from '../rivers/reachCard.js';

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

function host() {
  const calls = [];
  return {
    calls,
    setEntries: (source, entries) => calls.push({ op: 'set', source, entries }),
    setVisible: (source, visible) =>
      calls.push({ op: 'visible', source, visible }),
    clearSource: (source) => calls.push({ op: 'clear', source }),
  };
}

test('close in, the nearest large named rivers from the sidecar', async () => {
  const overlayHost = host();
  const asked = [];
  const labels = Array.from({ length: 20 }, (_, i) => ({
    name: `Río ${i}`,
    nameEn: `River ${i}`,
    strahler: 5 + (i % 3),
    at: [-60 + i * 0.05, -3],
  }));
  const names = createRiverNames({
    overlayHost,
    cesium: Cesium,
    load: async () => [],
    locale: () => 'en',
    fetchImpl: async (url) => {
      asked.push(url);
      return Response.json({ count: labels.length, labels });
    },
  });
  names.enable();
  // From afar (Natural Earth's names): nothing asked.
  names.update({ lat: -3, lon: -60, height: 2_000_000 }, 'light');
  await flush();
  assert.equal(asked.length, 0);
  names.update({ lat: -3, lon: -60, height: 50_000 }, 'dark');
  await flush();
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^\/api\/rivers\/names\/labels\?west=/);
  const set = overlayHost.calls
    .filter((c) => c.op === 'set' && c.source === OSM_NAMES_SOURCE)
    .at(-1);
  assert.equal(set.entries.length, OSM_NAME_LIMIT);
  assert.equal(
    set.entries[0].title,
    'River 0',
    'the nearest, in English for English',
  );
  assert.ok(set.entries.every((e) => e.variant === 'label'));
  assert.equal(set.entries[0].accent, '#1a1a1a');
  assert.equal(names.osmCount(), OSM_NAME_LIMIT);
  // The same window: no second request.
  names.update({ lat: -3, lon: -60, height: 50_000 }, 'dark');
  await flush();
  assert.equal(asked.length, 1);
  // Out again: OSM's names go.
  names.update({ lat: -3, lon: -60, height: 2_000_000 }, 'light');
  assert.equal(names.osmCount(), 0);
  assert.ok(
    overlayHost.calls.some(
      (c) => c.op === 'clear' && c.source === OSM_NAMES_SOURCE,
    ),
  );
  names.disable();
  assert.ok(
    overlayHost.calls.some(
      (c) =>
        c.op === 'visible' &&
        c.source === OSM_NAMES_SOURCE &&
        c.visible === false,
    ),
  );
  assert.equal(osmNameText({ name: 'Rhein', nameEn: 'Rhine' }, 'de'), 'Rhein');
  assert.equal(osmNameText({ name: 'Rhein', nameEn: 'Rhine' }, 'en'), 'Rhine');
});

test('without the sidecar (503) the names are not asked for again', async () => {
  let asked = 0;
  const names = createRiverNames({
    overlayHost: host(),
    cesium: Cesium,
    load: async () => [],
    fetchImpl: async () => {
      asked += 1;
      return new Response('{}', { status: 503 });
    },
  });
  names.enable();
  names.update({ lat: 40, lon: 0, height: 50_000 });
  await flush();
  names.update({ lat: 41, lon: 1, height: 50_000 });
  await flush();
  assert.equal(asked, 1);
  assert.equal(names.osmCount(), 0);
});

test('the reach card takes OpenStreetMap’s name first, and says where it came from', () => {
  assert.equal(
    osmNameTitle({ name: 'Río Bravo', nameEn: 'Rio Grande' }),
    'Río Bravo (Rio Grande)',
  );
  assert.equal(osmNameTitle({ name: 'Rhine', nameEn: 'Rhine' }), 'Rhine');
  const answer = {
    osmName: {
      name: 'Río Bravo',
      nameEn: 'Rio Grande',
      confidence: 'inherited',
    },
    reach: { properties: { BB_NAME: 'Rio Grande' } },
  };
  assert.equal(reachTitle(answer), 'Río Bravo (Rio Grande)');
  assert.equal(
    reachTitle({ reach: { properties: { BB_NAME: 'Rio Grande' } } }),
    'Rio Grande',
  );
  assert.equal(reachTitle({ reach: { properties: {} } }), 'Unnamed river');
  assert.match(osmNameSource(answer.osmName), /carried down the main stem/);
  assert.match(
    osmNameSource({ name: 'X', confidence: 'direct' }),
    /^Name from OpenStreetMap/,
  );
  assert.match(
    osmNameSource({ name: 'X', confidence: 'nearest' }),
    /nearest OpenStreetMap waterway/,
  );
  assert.equal(osmNameSource(null), '');
});

test('a live name from a nearby waterway: after the sidecar’s, before BB_NAME only where BB_NAME is silent or agrees', () => {
  const live = (name) => ({ name, confidence: 'live', coverage: 0.9 });
  const answer = (osmName, BB_NAME = '', segments = []) => ({
    osmName,
    reach: { properties: { BB_NAME } },
    downstream: { segments },
  });
  // Unnamed in HydroRIVERS: the live name, and where it came from.
  assert.equal(reachTitle(answer(live('Jones Falls'))), 'Jones Falls');
  assert.equal(
    osmNameSource(live('Jones Falls')),
    'Name from OpenStreetMap (nearby waterway), © OpenStreetMap contributors, ODbL',
  );
  // BB_NAME names a big river: it stays, unless the live name agrees.
  assert.equal(
    reachTitle(answer(live('Rock Run'), 'Susquehanna')),
    'Susquehanna',
  );
  assert.equal(osmNameSource(live('Rock Run'), 'Susquehanna'), '');
  assert.equal(
    reachTitle(answer(live('Susquehanna River'), 'Susquehanna')),
    'Susquehanna River',
  );
  // The sidecar's own names still come first, BB_NAME or not.
  assert.equal(
    reachTitle(
      answer({ name: 'Rock Run', confidence: 'direct' }, 'Susquehanna'),
    ),
    'Rock Run',
  );
  // No name at all: the tributary fallback, then unnamed.
  assert.equal(
    reachTitle(answer(null, '', [{ name: '' }, { name: 'Patapsco' }])),
    'Tributary of Patapsco',
  );
  assert.equal(reachTitle(answer(null)), 'Unnamed river');
});
