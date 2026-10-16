// Personal fork: the Street View indoor probe service, database and routes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  CELL_SIZE_M,
  PANO_RETENTION_DAYS,
  cellKey,
  cellsInCircle,
  createIndoorDb,
  metresBetween,
} from '../server/providers/streetview/db.js';
import {
  DENIED_RETRY_MS,
  MAX_GRID_TARGETS,
  createIndoorService,
  createPacer,
  gridTargets,
  indoorConfig,
  isContributed,
} from '../server/providers/streetview/indoor.js';
import {
  createIndoorHandler,
  parseNear,
} from '../server/providers/streetview/routes.js';

const DAY = 86_400_000;
const BALTIMORE = { lat: 39.2904, lon: -76.6122 };

/** A point `north`/`east` metres from `origin`. */
function offset(origin, north, east = 0) {
  return {
    lat: origin.lat + north / 110_540,
    lon: origin.lon + east / (111_320 * Math.cos((origin.lat * Math.PI) / 180)),
  };
}

function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-indoor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Google's metadata endpoint over a list of panoramas: `default` returns the
 * nearest within the radius, `outdoor` the nearest outdoor one, `pano=` by id.
 * `snapM` lets a default answer come from further away, as Google sometimes does.
 */
function fakeGoogle({ panos = [], status = null, snapM = 0 } = {}) {
  const calls = [];
  const answer = (body) => ({
    ok: true,
    status: 200,
    json: async () => body,
  });
  async function fetchImpl(url) {
    const u = new URL(url);
    const query = Object.fromEntries(u.searchParams);
    calls.push(query);
    if (status) return answer({ status, error_message: 'API not enabled' });
    if (query.pano) {
      const pano = panos.find((p) => p.panoId === query.pano);
      return answer(
        pano
          ? {
              status: 'OK',
              pano_id: pano.panoId,
              location: { lat: pano.lat, lng: pano.lon },
              date: pano.date,
              copyright: '© Someone',
            }
          : { status: 'NOT_FOUND' },
      );
    }
    const [lat, lon] = query.location.split(',').map(Number);
    const radius = Number(query.radius) + snapM;
    const candidates = panos
      .filter((p) => query.source !== 'outdoor' || p.outdoor)
      .map((p) => ({ p, d: metresBetween({ lat, lon }, p) }))
      .filter(({ d }) => d <= radius)
      .sort((a, b) => a.d - b.d);
    if (!candidates.length) return answer({ status: 'ZERO_RESULTS' });
    const { p } = candidates[0];
    return answer({
      status: 'OK',
      pano_id: p.panoId,
      location: { lat: p.lat, lng: p.lon },
      date: p.date,
      copyright: p.copyright ?? (p.outdoor ? '© Google' : '© A Photographer'),
    });
  }
  return { fetchImpl, calls };
}

function fakePlaces(places) {
  const calls = [];
  async function searchNearby(options) {
    calls.push(options);
    // Each type group returns its own half of the list.
    const group = calls.length - 1;
    return {
      ok: true,
      places: places.filter((_, i) => i % 2 === group % 2),
    };
  }
  return { searchNearby, calls };
}

function service(
  t,
  {
    google = fakeGoogle(),
    places = fakePlaces([]),
    env = {},
    key = 'server-key',
    clock = { t: Date.UTC(2026, 9, 16, 12) },
    dir = tempDir(t),
  } = {},
) {
  const warnings = [];
  const db = createIndoorDb({ dir, now: () => clock.t });
  const svc = createIndoorService({
    db,
    resolveApiKey: () => key,
    fetchImpl: google.fetchImpl,
    searchNearby: places.searchNearby,
    env,
    now: () => clock.t,
    pacer: async () => {},
    logger: { warn: (...args) => warnings.push(args.join(' ')), log() {} },
  });
  return { svc, db, google, places, clock, dir, warnings };
}

const PANO = (id) => id.padEnd(22, 'x');

test('a panorama Google returns for default but not outdoor is an indoor hit', async (t) => {
  const museum = offset(BALTIMORE, 120, 80);
  const cafe = offset(BALTIMORE, -200, 50);
  const shop = offset(BALTIMORE, 300, -150);
  const google = fakeGoogle({
    panos: [
      // Indoor: no outdoor imagery near it at all.
      { panoId: PANO('museumIndoor'), ...offset(museum, 5), date: '2019-05' },
      // Indoor nearest, with outdoor imagery 15 m away: a different pano id.
      { panoId: PANO('cafeIndoor'), ...offset(cafe, 3), date: '2021-02' },
      {
        panoId: PANO('cafeStreet'),
        ...offset(cafe, 18),
        outdoor: true,
        date: '2024-07',
      },
      // Only outdoor imagery: not a hit.
      { panoId: PANO('shopStreet'), ...offset(shop, 4), outdoor: true },
    ],
  });
  const places = fakePlaces([
    {
      id: 'p-museum',
      name: 'Museum',
      latitude: museum.lat,
      longitude: museum.lon,
    },
    { id: 'p-cafe', name: 'Cafe', latitude: cafe.lat, longitude: cafe.lon },
    { id: 'p-shop', name: 'Shop', latitude: shop.lat, longitude: shop.lon },
  ]);
  const { svc } = service(t, { google, places });
  const result = await svc.probe({ ...BALTIMORE, radiusKm: 0.5 });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.newHits.map((hit) => [hit.name, hit.panoDate, hit.placeId]).sort(),
    [
      ['Cafe', '2021-02', 'p-cafe'],
      ['Museum', '2019-05', 'p-museum'],
    ],
  );
  assert.equal(result.targets.poi, 3);
  assert.equal(result.requests.places, 2);
  // Contributed imagery needs one request; Google's own, default then outdoor.
  assert.equal(result.requests.metadata, 4);
  assert.deepEqual(
    result.newHits.map((hit) => hit.kind),
    ['contributed', 'contributed'],
  );
  assert.ok(google.calls.every((call) => call.radius === '25'));
  assert.deepEqual(
    places.calls.map((call) => call.rankPreference),
    ['POPULARITY', 'POPULARITY'],
  );
  assert.ok(places.calls[0].includedTypes.includes('museum'));
  assert.ok(places.calls[1].includedTypes.includes('church'));
});

test('a panorama more than 40 m from its target is skipped', async (t) => {
  const target = offset(BALTIMORE, 100);
  const google = fakeGoogle({
    snapM: 100,
    panos: [{ panoId: PANO('farIndoor'), ...offset(target, 60) }],
  });
  const places = fakePlaces([
    { id: 'p', name: 'Far', latitude: target.lat, longitude: target.lon },
  ]);
  const { svc } = service(t, { google, places });
  const result = await svc.probe({ ...BALTIMORE, radiusKm: 0.3 });
  assert.equal(result.newHits.length, 0);
  // The default answer was enough to rule it out.
  assert.equal(result.requests.metadata, 1);
});

test('REQUEST_DENIED reads as not configured, probes nothing more, and retries later', async (t) => {
  const google = fakeGoogle({ status: 'REQUEST_DENIED' });
  const places = fakePlaces([
    {
      id: 'a',
      name: 'A',
      ...{ latitude: BALTIMORE.lat, longitude: BALTIMORE.lon },
    },
    {
      id: 'b',
      name: 'B',
      latitude: BALTIMORE.lat + 0.001,
      longitude: BALTIMORE.lon,
    },
  ]);
  const { svc, db, clock } = service(t, { google, places });
  const result = await svc.probe({ ...BALTIMORE, radiusKm: 0.3 });
  assert.equal(result.ok, false);
  assert.equal(result.configured, false);
  assert.equal(result.stopped, 'not_configured');
  assert.match(result.error, /Street View Static API/);
  assert.equal(google.calls.length, 1, 'stops at the first refusal');
  // The area was not explored: it stays unprobed.
  assert.equal(
    db.unprobedCells(cellsInCircle(BALTIMORE.lat, BALTIMORE.lon, 300)).length >
      0,
    true,
  );
  const status = await svc.status();
  assert.equal(status.configured, false);
  assert.equal(status.reason, 'not_enabled');
  // Held back: no request while the refusal is fresh.
  const again = await svc.probe({ ...BALTIMORE, radiusKm: 0.3 });
  assert.equal(again.reason, 'not_enabled');
  assert.equal(google.calls.length, 1);
  clock.t += DENIED_RETRY_MS + 1;
  assert.equal((await svc.status()).configured, true);
});

test('no server key: not configured, logged once, nothing requested', async (t) => {
  const google = fakeGoogle();
  const { svc, warnings } = service(t, { google, key: '' });
  const a = await svc.probe({ ...BALTIMORE, radiusKm: 0.3 });
  const b = await svc.probe({ ...BALTIMORE, radiusKm: 0.3 });
  assert.equal(a.reason, 'no_key');
  assert.equal(b.reason, 'no_key');
  assert.equal(google.calls.length, 0);
  assert.equal(warnings.length, 1);
  assert.equal((await svc.status()).configured, false);
  const off = service(t, { env: { STREETVIEW_INDOOR_ENABLED: '0' } });
  assert.equal((await off.svc.probe({ ...BALTIMORE })).reason, 'disabled');
});

test('the daily cap stops a probe and leaves its cells unprobed', async (t) => {
  const google = fakeGoogle();
  const env = { STREETVIEW_INDOOR_GRID: '1', STREETVIEW_INDOOR_DAILY_CAP: '7' };
  const { svc, db } = service(t, { google, env });
  const result = await svc.probe({ ...BALTIMORE, radiusKm: 0.3 });
  assert.equal(result.capReached, true);
  assert.equal(result.stopped, 'cap');
  assert.equal(google.calls.length, 7);
  assert.equal(result.usage.remainingToday, 0);
  assert.ok(
    db.unprobedCells(cellsInCircle(BALTIMORE.lat, BALTIMORE.lon, 300)).length,
  );
  const status = await svc.status();
  assert.equal(status.usedToday, 7);
  assert.equal(status.remainingToday, 0);
  // Still today: the next probe stops before asking Google.
  const next = await svc.probe({ ...BALTIMORE, radiusKm: 0.3 });
  assert.equal(next.capReached, true);
  assert.equal(google.calls.length, 7, 'no request past the cap');
});

test('a probed area is not probed again within 30 days', async (t) => {
  const google = fakeGoogle();
  const places = fakePlaces([
    { id: 'a', name: 'A', latitude: BALTIMORE.lat, longitude: BALTIMORE.lon },
  ]);
  const { svc, clock } = service(t, {
    google,
    places,
    env: { STREETVIEW_INDOOR_GRID: '1' },
  });
  const first = await svc.probe({ ...BALTIMORE, radiusKm: 0.2 });
  assert.equal(first.ok, true);
  assert.ok(first.targets.grid > 0);
  const used = google.calls.length;
  const second = await svc.probe({ ...BALTIMORE, radiusKm: 0.2 });
  assert.equal(second.skipped, true);
  assert.equal(google.calls.length, used);
  assert.equal(places.calls.length, 2);
  assert.equal(
    (await svc.hitsNear({ ...BALTIMORE, radiusKm: 0.2 })).unprobedCells,
    0,
  );
  clock.t += 31 * DAY;
  const later = await svc.hitsNear({ ...BALTIMORE, radiusKm: 0.2 });
  assert.ok(later.unprobedCells > 0);
});

test('the grid is opt-in and capped at 400 points', async (t) => {
  assert.equal(indoorConfig({}).grid, false);
  assert.equal(indoorConfig({ STREETVIEW_INDOOR_GRID: '1' }).grid, true);
  assert.equal(indoorConfig({}).dailyCap, 3000);
  assert.equal(
    indoorConfig({ STREETVIEW_INDOOR_DAILY_CAP: 'x' }).dailyCap,
    3000,
  );
  const small = gridTargets(BALTIMORE, 100, { spacing: 40, max: 400 });
  assert.ok(small.length > 10 && small.length < 40);
  const big = gridTargets(BALTIMORE, 2000, { spacing: 40, max: 400 });
  assert.ok(big.length <= MAX_GRID_TARGETS);
  assert.ok(big.length > 300, `${big.length} points spread over the area`);
  const google = fakeGoogle();
  const { svc } = service(t, { google });
  const result = await svc.probe({ ...BALTIMORE, radiusKm: 0.3 });
  assert.equal(result.targets.grid, 0);
  assert.equal(google.calls.length, 0);
});

test('panoramas are re-checked before 30 days and dropped after', async (t) => {
  const clock = { t: Date.UTC(2026, 9, 1) };
  const dir = tempDir(t);
  const google = fakeGoogle({
    panos: [{ panoId: PANO('stillThere'), ...BALTIMORE, date: '2020-01' }],
  });
  const { svc, db } = service(t, { google, clock, dir });
  await svc.status();
  db.putPano({
    panoId: PANO('stillThere'),
    ...BALTIMORE,
    checkedAt: clock.t - 26 * DAY,
  });
  db.putPano({
    panoId: PANO('goneNow'),
    ...BALTIMORE,
    checkedAt: clock.t - 27 * DAY,
  });
  db.putPano({ panoId: PANO('freshOne'), ...BALTIMORE, checkedAt: clock.t });
  db.putPlace({ placeId: 'place-1', name: 'Old Place', ...BALTIMORE });
  const result = await svc.sweep();
  assert.deepEqual(
    {
      checked: result.checked,
      refreshed: result.refreshed,
      dropped: result.dropped,
    },
    { checked: 2, refreshed: 1, dropped: 1 },
  );
  assert.ok(google.calls.every((call) => call.pano && !call.location));
  assert.equal(db.getPano(PANO('stillThere')).checkedAt, clock.t);
  assert.equal(db.getPano(PANO('goneNow')), null);
  // 31 days on, with no sweep: Google content goes, the Place ID stays.
  clock.t += (PANO_RETENTION_DAYS + 1) * DAY;
  db.expire();
  assert.equal(db.allPanos().length, 0);
  const place = db.getPlace('place-1');
  assert.equal(place.placeId, 'place-1');
  assert.ok(place.firstSeen);
  assert.equal(place.name, undefined);
  assert.equal(place.lat, undefined);
});

test('the database saves atomically and loads back, dropping expired rows', async (t) => {
  const dir = tempDir(t);
  const clock = { t: Date.UTC(2026, 9, 16) };
  const db = createIndoorDb({ dir, now: () => clock.t });
  await db.load();
  db.putPano({
    panoId: PANO('kept'),
    lat: 39.29,
    lon: -76.61,
    date: '2022-03',
    checkedAt: clock.t,
    method: 'poi',
  });
  db.putPano({
    panoId: PANO('expiring'),
    lat: 39.29,
    lon: -76.61,
    checkedAt: clock.t - 29 * DAY,
  });
  db.putPlace({ placeId: 'pid', name: 'Hall', lat: 39.29, lon: -76.61 });
  db.markCells([cellKey(39.29, -76.61)]);
  db.countRequest('metadata', 3);
  await Promise.all([db.save(), db.save()]);
  assert.deepEqual(readdirSync(dir).sort(), [
    'cells.json',
    'panos.json',
    'places.json',
    'usage.json',
  ]);
  clock.t += 2 * DAY;
  const reloaded = createIndoorDb({ dir, now: () => clock.t });
  await reloaded.load();
  assert.ok(reloaded.getPano(PANO('kept')));
  assert.equal(reloaded.getPano(PANO('expiring')), null);
  assert.equal(reloaded.getPlace('pid').name, 'Hall');
  assert.equal(reloaded.cellProbedAt(cellKey(39.29, -76.61)) > 0, true);
  // A new day: usage starts from zero.
  assert.equal(reloaded.usage().metadata, 0);
  const hits = reloaded.hitsNear({ lat: 39.29, lon: -76.61 }, 100);
  assert.deepEqual(Object.keys(hits[0]).sort(), [
    'checkedAt',
    'copyright',
    'foundAt',
    'kind',
    'lat',
    'lon',
    'method',
    'name',
    'panoDate',
    'panoId',
    'placeId',
  ]);
  // A corrupt file reads as empty rather than failing.
  const broken = createIndoorDb({ dir: path.join(dir, 'missing') });
  await broken.load();
  assert.deepEqual(broken.counts(), { places: 0, panos: 0, cells: 0 });
});

test('cells are ~250 m and a circle covers the cells it touches', () => {
  const a = cellKey(BALTIMORE.lat, BALTIMORE.lon);
  assert.equal(cellKey(BALTIMORE.lat + 1e-7, BALTIMORE.lon + 1e-7), a);
  assert.notEqual(cellKey(...Object.values(offset(BALTIMORE, CELL_SIZE_M))), a);
  const cells = cellsInCircle(BALTIMORE.lat, BALTIMORE.lon, 500);
  assert.ok(cells.length >= 12 && cells.length <= 40, `${cells.length}`);
});

test('the pacer spaces requests at the configured rate', async () => {
  let t = 1000;
  const slept = [];
  const wait = createPacer({
    intervalMs: 200,
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
  });
  await wait();
  await wait();
  await wait();
  assert.deepEqual(slept, [200, 200]);
});

function fakeReq({ method = 'GET', url = '/', body = '', headers = {} } = {}) {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  Object.assign(req, {
    method,
    url,
    headers: { host: 'localhost:4173', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  });
  return req;
}

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    writableEnded: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(body = '') {
      this.body = String(body);
      this.writableEnded = true;
    },
    on() {},
    json() {
      return JSON.parse(this.body);
    },
  };
  return res;
}

test('routes: status, hits near a point, probe, and their refusals', async (t) => {
  const target = offset(BALTIMORE, 50);
  const google = fakeGoogle({
    panos: [{ panoId: PANO('routeIndoor'), ...target, date: '2018-11' }],
  });
  const places = fakePlaces([
    { id: 'r', name: 'Station', latitude: target.lat, longitude: target.lon },
  ]);
  const { svc } = service(t, { google, places });
  let placesAllowed = 0;
  const handle = createIndoorHandler({
    service: svc,
    allowPlaces: () => {
      placesAllowed++;
      return true;
    },
  });
  const call = async (options) => {
    const res = fakeRes();
    await handle(fakeReq(options), res);
    return res;
  };

  const status = await call({ url: '/status' });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().configured, true);
  assert.equal(status.json().dailyCap, 3000);
  assert.equal(status.headers['cache-control'], 'no-store');

  assert.equal((await call({ url: '/?near=nope' })).statusCode, 400);
  assert.equal((await call({ url: '/?near=91,0' })).statusCode, 400);
  const empty = await call({
    url: `/?near=${BALTIMORE.lat},${BALTIMORE.lon}&radiusKm=1`,
  });
  assert.deepEqual(empty.json().hits, []);
  assert.ok(empty.json().unprobedCells > 0);

  assert.equal((await call({ url: '/probe' })).statusCode, 405);
  assert.equal(
    (await call({ method: 'POST', url: '/probe', body: '{bad' })).statusCode,
    400,
  );
  const probe = await call({
    method: 'POST',
    url: '/probe',
    body: JSON.stringify({ ...BALTIMORE, radiusKm: 0.3 }),
  });
  assert.equal(probe.statusCode, 200);
  assert.deepEqual(
    probe.json().newHits.map((hit) => [hit.panoId, hit.name]),
    [[PANO('routeIndoor'), 'Station']],
  );
  assert.equal(
    placesAllowed,
    2,
    'Places searches go through the shared limiter',
  );

  const near = await call({
    url: `/?near=${BALTIMORE.lat},${BALTIMORE.lon}&radiusKm=1`,
  });
  assert.equal(near.json().hits.length, 1);
  assert.equal(near.json().hits[0].panoDate, '2018-11');

  const bad = await call({
    method: 'POST',
    url: '/probe',
    body: JSON.stringify({ lat: 'x', lon: 0 }),
  });
  assert.equal(bad.statusCode, 400);

  // Another site cannot spend the server key.
  const crossSite = await call({
    url: '/status',
    headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSite.statusCode, 403);
  assert.equal((await call({ url: '/elsewhere' })).statusCode, 404);
});

test('a probe in flight refuses a second one', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const google = fakeGoogle();
  const slow = {
    calls: google.calls,
    fetchImpl: async (url) => {
      await gate;
      return google.fetchImpl(url);
    },
  };
  const { svc } = service(t, {
    google: slow,
    env: { STREETVIEW_INDOOR_GRID: '1' },
  });
  const first = svc.probe({ ...BALTIMORE, radiusKm: 0.1 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await svc.probe({ ...offset(BALTIMORE, 3000), radiusKm: 0.1 });
  assert.equal(second.busy, true);
  assert.equal(second.status, 409);
  release();
  assert.equal((await first).ok, true);
});

test('near parsing accepts lat,lon only', () => {
  assert.deepEqual(parseNear('39.29,-76.61'), { lat: 39.29, lon: -76.61 });
  assert.deepEqual(parseNear(' 1 , 2 '), { lat: 1, lon: 2 });
  assert.equal(parseNear('39.29'), null);
  assert.equal(parseNear('1,200'), null);
  assert.equal(parseNear(null), null);
});

test('a failed Places search leaves the area unprobed and pauses Places for a while', async (t) => {
  const calls = [];
  const places = {
    calls,
    searchNearby: async (options) => {
      calls.push(options);
      return { ok: false, places: [], error: 'Quota exceeded' };
    },
  };
  const google = fakeGoogle();
  const { svc, db, clock } = service(t, { google, places });
  const result = await svc.probe({ ...BALTIMORE, radiusKm: 0.3 });
  assert.equal(result.ok, true);
  assert.equal(result.incomplete, true);
  assert.equal(calls.length, 1, 'stops after the first failure');
  assert.match(result.notes[0], /Quota exceeded/);
  assert.ok(
    db.unprobedCells(cellsInCircle(BALTIMORE.lat, BALTIMORE.lon, 300)).length,
  );
  const again = await svc.probe({ ...BALTIMORE, radiusKm: 0.3 });
  assert.equal(calls.length, 1, 'paused');
  assert.match(again.notes[0], /paused/);
  clock.t += 11 * 60_000;
  await svc.probe({ ...BALTIMORE, radiusKm: 0.3 });
  assert.equal(calls.length, 2);
  assert.equal(google.calls.length, 0);
});

test('contributed photospheres count even when Google labels them outdoor; Google interiors need the outdoor check', async (t) => {
  const a = offset(BALTIMORE, 100);
  const b = offset(BALTIMORE, -100);
  const c = offset(BALTIMORE, 0, 150);
  const google = fakeGoogle({
    panos: [
      // A user photosphere Google also returns for source=outdoor.
      {
        panoId: PANO('userSphere'),
        ...a,
        outdoor: true,
        copyright: '© Jane Doe',
      },
      // Google's own interior: not outdoor, © Google.
      {
        panoId: PANO('googleInside'),
        ...b,
        copyright: '© 2024 Google',
      },
      // Google's street imagery.
      { panoId: PANO('googleStreet'), ...c, outdoor: true },
    ],
  });
  const places = fakePlaces([
    { id: 'a', name: 'Sphere', latitude: a.lat, longitude: a.lon },
    { id: 'b', name: 'Inside', latitude: b.lat, longitude: b.lon },
    { id: 'c', name: 'Street', latitude: c.lat, longitude: c.lon },
  ]);
  const { svc } = service(t, { google, places });
  const result = await svc.probe({ ...BALTIMORE, radiusKm: 0.4 });
  assert.deepEqual(result.newHits.map((hit) => [hit.name, hit.kind]).sort(), [
    ['Inside', 'indoor'],
    ['Sphere', 'contributed'],
  ]);
  assert.equal(result.requests.metadata, 5);
  assert.equal(isContributed('© Google'), false);
  assert.equal(isContributed('© 2019 Google'), false);
  assert.equal(isContributed(''), false);
  assert.equal(isContributed('© Googleplex Photography'), true);
  assert.equal(isContributed('© kinming fung'), true);
});
