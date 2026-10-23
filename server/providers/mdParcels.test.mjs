// Personal fork: the Maryland parcels route (server/providers/mdParcels.js)
// against a mocked MD iMAP: the refusal outside Maryland, the disk and point
// caches, the host fallback, upstream errors, one request at a time, and the
// route's parameters. MD_PARCELS_LIVE=1 adds one live request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  MD_PARCELS_USER_AGENT,
  createMdParcelsHandler,
  createMdParcelsService,
} from './mdParcels.js';

/** MD iMAP's answer at 6204 Sycamore Rd (2026-10-23). */
const SYCAMORE = JSON.parse(
  await fs.readFile(
    new URL(
      '../../src/data/fixtures/md-parcel-6204-sycamore.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

const LAT = 39.3699327;
const LON = -76.6131013;

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-md-parcels-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

/** MD iMAP answering from `answers` by host: a body, a status, or a throw. */
function fakeUpstream(answers = {}) {
  const asked = [];
  let inFlight = 0;
  let most = 0;
  return {
    asked,
    most: () => most,
    async fetchImpl(url, init) {
      asked.push({ url: String(url), headers: init.headers });
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      const host = new URL(url).host;
      const answer = answers[host] ?? SYCAMORE;
      if (answer instanceof Error) throw answer;
      if (typeof answer === 'number')
        return new Response('<html>maintenance</html>', { status: answer });
      return new Response(JSON.stringify(answer), {
        status: 200,
        headers: { 'Content-Type': 'application/geo+json' },
      });
    },
  };
}

test('6204 Sycamore Rd: one parcel, kept on disk, and a reload asks upstream nothing', async (t) => {
  const root = await tempRoot(t);
  const upstream = fakeUpstream();
  const service = createMdParcelsService({
    sourceRoot: root,
    fetchImpl: upstream.fetchImpl,
  });
  const first = await service.at(LAT, LON);
  assert.equal(first.status, 200);
  assert.deepEqual(
    first.parcels.map((p) => [
      p.jurscode,
      p.acctid,
      p.address,
      p.acres,
      p.rings[0].length,
    ]),
    [['BACI', '0327665082 008A', '6204 SYCAMORE RD', 1.33, 11]],
  );
  // The request: the first host, the four fields, the app's own User-Agent.
  const asked = new URL(upstream.asked[0].url);
  assert.equal(asked.host, 'mdgeodata.md.gov');
  assert.equal(
    asked.searchParams.get('outFields'),
    'ACCTID,ADDRESS,ACRES,JURSCODE',
  );
  assert.equal(upstream.asked[0].headers['User-Agent'], MD_PARCELS_USER_AGENT);
  assert.doesNotMatch(MD_PARCELS_USER_AGENT, /Mozilla|Chrome|Safari/);
  // The same point again (the point cache), then by key (the disk).
  assert.deepEqual((await service.at(LAT, LON)).parcels, first.parcels);
  assert.deepEqual(
    (await service.byKey('BACI', '0327665082 008A')).parcels,
    first.parcels,
  );
  assert.equal(upstream.asked.length, 1, 'nothing asked again');
  // A fresh service (the server restarted): the key comes from disk.
  const again = createMdParcelsService({
    sourceRoot: root,
    fetchImpl: upstream.fetchImpl,
  });
  assert.deepEqual(
    (await again.byKey('BACI', '0327665082 008A')).parcels,
    first.parcels,
  );
  assert.equal(upstream.asked.length, 1);
  const files = await fs.readdir(path.join(root, '.gev-cache', 'md-parcels'));
  assert.deepEqual(files, ['BACI-0327665082_008A.json']);
  const kept = await fs.readFile(
    path.join(root, '.gev-cache', 'md-parcels', files[0]),
    'utf8',
  );
  assert.doesNotMatch(kept, /OWN/);
});

test('outside Maryland, or a bad key: refused without asking upstream', async (t) => {
  const root = await tempRoot(t);
  const upstream = fakeUpstream();
  const service = createMdParcelsService({
    sourceRoot: root,
    fetchImpl: upstream.fetchImpl,
  });
  assert.deepEqual(await service.at(40.7128, -74.006), {
    status: 400,
    error: 'Maryland parcels only',
  });
  assert.equal((await service.byKey('BACI', "1' OR '1'='1")).status, 400);
  assert.equal((await service.byKey('baci', '1')).status, 400);
  assert.equal(upstream.asked.length, 0);
});

test('the usual host as fallback, upstream errors as 502, and one request at a time', async (t) => {
  const root = await tempRoot(t);
  // The first host down: the second answers.
  const fallback = fakeUpstream({ 'mdgeodata.md.gov': 503 });
  const service = createMdParcelsService({
    sourceRoot: root,
    fetchImpl: fallback.fetchImpl,
  });
  assert.equal((await service.at(LAT, LON)).parcels.length, 1);
  assert.deepEqual(
    fallback.asked.map((a) => new URL(a.url).host),
    ['mdgeodata.md.gov', 'geodata.md.gov'],
  );
  // Both down, or an ArcGIS error: 502, and nothing kept for the point.
  const down = fakeUpstream({
    'mdgeodata.md.gov': new Error('timed out'),
    'geodata.md.gov': {
      error: { code: 500, message: 'Unable to complete operation.' },
    },
  });
  const failing = createMdParcelsService({
    sourceRoot: await tempRoot(t),
    fetchImpl: down.fetchImpl,
  });
  const failed = await failing.at(LAT, LON);
  assert.equal(failed.status, 502);
  assert.match(failed.error, /500/);
  // Water: an empty list, not an error.
  const water = fakeUpstream({
    'mdgeodata.md.gov': { type: 'FeatureCollection', features: [] },
  });
  const empty = createMdParcelsService({
    sourceRoot: await tempRoot(t),
    fetchImpl: water.fetchImpl,
  });
  assert.deepEqual(await empty.at(39.2, -76.4), { status: 200, parcels: [] });
  // Five points at once go upstream one by one.
  const paced = fakeUpstream();
  const busy = createMdParcelsService({
    sourceRoot: await tempRoot(t),
    fetchImpl: paced.fetchImpl,
  });
  await Promise.all(
    [0, 1, 2, 3, 4].map((i) => busy.at(39.3 + i / 1000, -76.6)),
  );
  assert.equal(paced.asked.length, 5);
  assert.equal(paced.most(), 1);
});

test('the route: same-site GET only, its parameters checked, the parcels as JSON', async (t) => {
  const root = await tempRoot(t);
  const upstream = fakeUpstream();
  const handler = createMdParcelsHandler({
    service: createMdParcelsService({
      sourceRoot: root,
      fetchImpl: upstream.fetchImpl,
    }),
  });
  const call = (url, method = 'GET', headers = { host: 'localhost:4173' }) =>
    new Promise((resolve) => {
      const res = {
        statusCode: 200,
        headers: {},
        setHeader(name, value) {
          this.headers[name.toLowerCase()] = value;
        },
        end(body) {
          resolve({
            status: this.statusCode,
            body: body ? JSON.parse(body) : null,
          });
        },
      };
      handler({ url, method, headers, socket: {} }, res, () =>
        resolve({ status: 'next' }),
      );
    });
  const answer = await call(`/?lat=${LAT}&lon=${LON}`);
  assert.equal(answer.status, 200);
  assert.deepEqual(Object.keys(answer.body.parcels[0]).sort(), [
    'acctid',
    'acres',
    'address',
    'jurscode',
    'rings',
  ]);
  assert.equal(
    (await call('/?jurscode=BACI&acctid=0327665082%20008A')).body.parcels[0]
      .address,
    '6204 SYCAMORE RD',
  );
  assert.equal((await call('/?lat=40.7&lon=-74')).status, 400);
  assert.equal((await call('/?lat=abc&lon=-76')).status, 400);
  assert.equal((await call('/', 'POST')).status, 405);
  assert.equal((await call('/elsewhere')).status, 'next');
  assert.equal(upstream.asked.length, 1);
});

test(
  'live: MD iMAP answers 6204 Sycamore Rd (MD_PARCELS_LIVE=1)',
  {
    skip: process.env.MD_PARCELS_LIVE !== '1',
  },
  async (t) => {
    const service = createMdParcelsService({ sourceRoot: await tempRoot(t) });
    const answer = await service.at(LAT, LON);
    assert.equal(answer.status, 200, answer.error);
    assert.equal(answer.parcels[0].acctid, '0327665082 008A');
    assert.equal(answer.parcels[0].address, '6204 SYCAMORE RD');
  },
);
