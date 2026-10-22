// Personal fork: /api/rivers/names on a sidecar built here from a reach and
// a waterway (scripts/rivers/names.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRiverNames } from '../../scripts/rivers/names.mjs';
import { createRiverNamesIndex } from './riverNames/index.js';
import { createRiverNamesHandler } from './riverNames.js';

const line = (offsetM, a, b) => {
  const coords = [];
  for (let i = 0; i <= 10; i++)
    coords.push(a + ((b - a) * i) / 10, 40 + offsetM / 110_574);
  return coords;
};

async function call(handler, url, method = 'GET') {
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(body) {
      this.body = JSON.parse(body);
    },
  };
  await handler(
    { url, method, headers: { host: 'localhost:5173' }, socket: {} },
    res,
  );
  return res;
}

test('the names routes answer labels and the nearest name, and refuse what they should', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-river-route-'));
  try {
    const empty = createRiverNamesIndex({ dir: path.join(dir, 'none') });
    const unbuilt = createRiverNamesHandler({ names: empty });
    assert.equal(
      (await call(unbuilt, '/nearest?lat=40&lon=0.005')).statusCode,
      503,
    );
    assert.equal(
      (await call(unbuilt, '/labels?west=-1&south=39&east=1&north=41'))
        .statusCode,
      503,
    );
    await buildRiverNames({
      waterways: [
        JSON.stringify({
          type: 'Feature',
          properties: {
            name: 'Big River',
            'name:en': 'Big',
            waterway: 'river',
          },
          geometry: {
            type: 'LineString',
            coordinates: (() => {
              const c = line(20, -0.001, 0.011);
              const out = [];
              for (let k = 0; k < c.length; k += 2) out.push([c[k], c[k + 1]]);
              return out;
            })(),
          },
        }),
      ],
      regions: [
        {
          name: 'test',
          forEachReach: async (onReach) => {
            onReach({
              id: 1,
              down: -1,
              strahler: 6,
              upland: 9000,
              parts: [Float64Array.from(line(0, 0, 0.01))],
            });
          },
        },
      ],
      dir: path.join(dir, 'names'),
      tmpDir: path.join(dir, 'tmp'),
      workers: 1,
    });
    const handler = createRiverNamesHandler({
      names: createRiverNamesIndex({ dir: path.join(dir, 'names') }),
    });
    const near = await call(handler, '/nearest?lat=40&lon=0.005');
    assert.equal(near.statusCode, 200);
    assert.equal(near.body.name, 'Big River');
    assert.equal(near.body.nameEn, 'Big');
    assert.equal(near.body.confidence, 'direct');
    assert.equal(near.headers['cache-control'], 'private, max-age=3600');
    assert.equal(
      (await call(handler, '/nearest?lat=41&lon=0.005')).statusCode,
      404,
    );
    assert.equal((await call(handler, '/nearest?lat=x&lon=0')).statusCode, 400);
    const labels = await call(
      handler,
      '/labels?west=-1&south=39&east=1&north=41',
    );
    assert.equal(labels.statusCode, 200);
    assert.deepEqual(
      labels.body.labels.map((l) => [l.name, l.nameEn, l.strahler]),
      [['Big River', 'Big', 6]],
    );
    assert.equal(
      (await call(handler, '/labels?west=-30&south=39&east=1&north=41'))
        .statusCode,
      400,
    );
    assert.equal((await call(handler, '/labels', 'POST')).statusCode, 405);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
