import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  camindexCatalogPath,
  catalogCameraToSource,
  createCamindexLoader,
} from '../../server/providers/cctv/camindex.js';
import {
  createCctvCatalog,
  interestFactor,
} from '../../server/providers/cctv/catalog.js';
import { normalizeSourceItem } from '../../server/providers/cctv/normalize.js';
import {
  embedBadgeText,
  embedSrcFor,
  opencctvEmbedUrl,
  syncCctvEmbed,
} from '../ui/cctvEmbed.js';
import { BROWSER_CSP } from '../../build/vite.js';

// Personal fork: the camindex pack (server/providers/cctv/camindex.js) and
// the OpenCCTV embed allowlist.

const PAGE =
  'https://opencctv.org/cameras/united-states/maryland/baltimore/peregrine-falcons-212832';
const camera = (over = {}) => ({
  id: 'opencctv-212832',
  name: 'Peregrine Falcons',
  city: 'Baltimore, Maryland, US',
  cityId: 'opencctv',
  provider: 'OpenCCTV',
  credit: 'opencctv.org',
  lat: 39.2867,
  lon: -76.6122,
  headingConfidence: 'low',
  rangeM: 150,
  sourceKind: 'opencctv',
  license: 'Listed by opencctv.org',
  category: 'nature',
  coordinatesQuality: 'site',
  operatorUrl: PAGE,
  publishSignal: 'directory-embed',
  licenseClass: 'embed-only',
  feedType: 'image',
  url: 'https://opencctv.org/still/212832.jpg',
  snapshotUrl: 'https://opencctv.org/still/212832.jpg',
  embed: { provider: 'opencctv', url: PAGE },
  liveStatus: 'live',
  ...over,
});

async function catalogDir(t, cameras) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-camindex-pack-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, '.gev-cache', 'camindex'), { recursive: true });
  const file = path.join(dir, '.gev-cache', 'camindex', 'catalog.json');
  await fs.writeFile(
    file,
    JSON.stringify({ generatedAt: '2026-10-16T00:00:00Z', sources: {}, cameras }),
  );
  return { dir, file };
}

test('catalog cameras are checked again on the way in', () => {
  const source = catalogCameraToSource(camera());
  assert.equal(source.id, 'opencctv-212832');
  assert.ok(Number.isNaN(source.headingDeg));
  assert.equal(source.feedType, 'image');
  assert.equal(source.snapshotUrl, 'https://opencctv.org/still/212832.jpg');
  assert.equal(source.embed, undefined, 'directory embeds are off by default');
  assert.deepEqual(catalogCameraToSource(camera(), { embeds: true }).embed, {
    provider: 'opencctv',
    url: PAGE,
  });
  assert.equal(
    catalogCameraToSource(
      camera({ embed: { provider: 'opencctv', url: 'https://evil.example/x' } }),
      { embeds: true },
    ).embed,
    undefined,
  );
  for (const bad of [
    { id: 'Bad Id!' },
    { lat: 0, lon: 0 },
    { lat: 95 },
    { snapshotUrl: 'http://opencctv.org/still/1.jpg' },
    { snapshotUrl: 'javascript:alert(1)' },
    { feedType: 'hls' },
    { liveStatus: 'offline' },
  ])
    assert.equal(catalogCameraToSource(camera(bad)), null, JSON.stringify(bad));
  assert.equal(
    catalogCameraToSource(camera({ operatorUrl: 'javascript:x' })).operatorUrl,
    '',
  );
  assert.equal(
    catalogCameraToSource(camera({ category: '<b>' })).category,
    'webcam',
  );
});

test('the catalog path follows CAMINDEX_DIR', () => {
  assert.equal(
    camindexCatalogPath('/repo', {}),
    path.join('/repo', '.gev-cache', 'camindex', 'catalog.json'),
  );
  assert.equal(
    camindexCatalogPath('/repo', { CAMINDEX_DIR: '/data/cams' }),
    path.join(path.resolve('/data/cams'), 'catalog.json'),
  );
});

test('the pack reads the catalog once per change and serves only proximity', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const { dir, file } = await catalogDir(t, [
    camera(),
    camera({ id: 'opencctv-2', snapshotUrl: 'ftp://x' }),
  ]);
  const load = createCamindexLoader({ env: {} });
  const first = await load({ sourceRoot: dir });
  assert.equal(first.length, 0);
  assert.equal(first.proximityOnly, true);
  assert.deepEqual(
    first.everything.map((s) => s.id),
    ['opencctv-212832'],
  );
  assert.equal(await load({ sourceRoot: dir }).then((l) => l.everything), first.everything);
  await fs.writeFile(
    file,
    JSON.stringify({ cameras: [camera(), camera({ id: 'opencctv-3' })] }),
  );
  const later = new Date(Date.now() + 5000);
  await fs.utimes(file, later, later);
  assert.equal((await load({ sourceRoot: dir })).everything.length, 2);
  await fs.writeFile(file, '{broken');
  const evenLater = new Date(Date.now() + 10000);
  await fs.utimes(file, evenLater, evenLater);
  assert.equal(
    (await load({ sourceRoot: dir })).everything.length,
    2,
    'an unreadable file keeps the last good list',
  );
  assert.equal(
    (await createCamindexLoader({ env: {} })({ sourceRoot: os.tmpdir() }))
      .everything.length,
    0,
    'no catalog, no cameras',
  );
});

test('camindex cameras reach proximity queries with their provenance', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const { dir } = await catalogDir(t, [camera()]);
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env))
      if (/^CCTV_|^OVERPASS_|^WINDY|^YOUTUBE|^CAMINDEX_/.test(key))
        delete process.env[key];
    process.env.CCTV_WINDY_ENABLED = '0';
    process.env.CCTV_FEATURED_ENABLED = '0';
    process.env.CCTV_LINKED_ENABLED = '0';
    t.mock.method(globalThis, 'fetch', async () => Response.json([]));
    const getSources = createCctvCatalog({ sourceRoot: dir });
    const capped = await getSources();
    assert.equal(
      capped.some((s) => s.pack === 'camindex'),
      false,
    );
    const [near] = await getSources.near(39.28, -76.6, { radiusKm: 5 });
    assert.equal(near.id, 'opencctv-212832');
    assert.equal(near.pack, 'camindex');
    assert.equal(near.feedType, 'image');
    assert.equal(near.category, 'nature');
    assert.equal(near.operatorUrl, PAGE);
    assert.equal(near.publishSignal, 'directory-embed');
    assert.equal(near.licenseClass, 'embed-only');
    assert.equal(near.coordinatesQuality, 'site');
    assert.equal(near.embed, undefined);

    process.env.CCTV_CAMINDEX_ENABLED = '0';
    const off = createCctvCatalog({ sourceRoot: dir });
    await off();
    assert.deepEqual(await off.near(39.28, -76.6, { radiusKm: 5 }), []);
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('a directory embed survives normalizing and ranks as scenic', () => {
  const normalized = normalizeSourceItem(camera());
  assert.deepEqual(normalized.embed, { provider: 'opencctv', url: PAGE });
  assert.equal(
    normalizeSourceItem(
      camera({ embed: { provider: 'opencctv', url: 'https://opencctv.org.evil.example/' } }),
    ).embed,
    undefined,
  );
  assert.equal(
    normalizeSourceItem(camera({ embed: { provider: 'other', url: PAGE } })).embed,
    undefined,
  );
  assert.equal(interestFactor(normalized), 0.5);
  assert.equal(
    interestFactor({ embed: { provider: 'youtube' }, publishSignal: 'operator-page' }),
    0.25,
  );
});

test('the panel frames OpenCCTV camera pages and nothing else', () => {
  assert.equal(opencctvEmbedUrl(PAGE), PAGE);
  for (const bad of [
    'http://opencctv.org/cameras/a-1',
    'https://opencctv.org/api/feed/1',
    'https://opencctv.org:8443/cameras/a-1',
    'https://user@opencctv.org/cameras/a-1',
    'https://opencctv.org.evil.example/cameras/a-1',
    'https://www.opencctv.org/cameras/a-1',
    'javascript:alert(1)',
    '',
  ])
    assert.equal(opencctvEmbedUrl(bad), '', bad);
  assert.equal(embedSrcFor({ provider: 'opencctv', url: PAGE }), PAGE);
  assert.equal(
    embedSrcFor({ provider: 'iframe', url: 'https://evil.example/' }),
    '',
  );
  assert.match(
    embedSrcFor({ provider: 'youtube', videoId: '1_BdSTneH3s' }),
    /^https:\/\/www\.youtube-nocookie\.com\/embed\/1_BdSTneH3s\?/,
  );
  assert.equal(
    embedBadgeText({ embed: { provider: 'opencctv' }, liveStatus: 'live' }),
    'OPENCCTV · LIVE',
  );
  assert.equal(
    embedBadgeText({ embed: { provider: 'youtube' } }),
    'YOUTUBE · STATUS UNKNOWN',
  );
  const frames = BROWSER_CSP.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('frame-src '))
    .split(/\s+/);
  assert.ok(frames.includes('https://opencctv.org'));
});

test('an OpenCCTV frame is sandboxed and replaced only when its page changes', (t) => {
  const made = [];
  const element = () => {
    const attributes = {};
    const classes = new Set();
    return {
      dataset: {},
      attributes,
      setAttribute: (name, value) => {
        attributes[name] = value;
      },
      remove() {
        this.removed = true;
      },
      appendChild(child) {
        this.child = child;
      },
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
      },
    };
  };
  const previous = globalThis.document;
  globalThis.document = {
    createElement: () => {
      const node = element();
      made.push(node);
      return node;
    },
  };
  t.after(() => {
    globalThis.document = previous;
  });
  const controls = { _cctvFrameWrap: element(), _cctvPanel: element() };
  const activeCamera = {
    name: 'Peregrine Falcons',
    embed: { provider: 'opencctv', url: PAGE },
  };
  assert.equal(syncCctvEmbed(controls, { enabled: true, activeCamera }), true);
  const [frame] = made;
  assert.equal(frame.src, PAGE);
  assert.equal(frame.attributes.sandbox, 'allow-scripts allow-same-origin');
  assert.equal(frame.title, 'Peregrine Falcons on OpenCCTV');
  assert.equal(syncCctvEmbed(controls, { enabled: true, activeCamera }), true);
  assert.equal(made.length, 1, 'the same page keeps its frame');
  assert.equal(
    syncCctvEmbed(controls, {
      enabled: true,
      activeCamera: { embed: { provider: 'opencctv', url: 'https://evil.example/' } },
    }),
    false,
  );
  assert.equal(frame.removed, true);
  assert.equal(made.length, 1, 'no frame for a foreign page');
});
