// Personal fork: the World history routes (/api/world-history) on an index
// built from a mini Cliopatria: a year, a polity at its largest or in a
// year, the names, the status, ETags on the build id, and refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createWorldHistoryHandler } from './worldHistory.js';
import { createWorldHistoryIndex } from './worldHistory/index.js';
import { buildWorldHistory } from '../../scripts/worldHistory/build.mjs';
import { writeFixture } from '../../scripts/worldHistory/testFixture.mjs';

function call(handle, url, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      headers: {},
      statusCode: 200,
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      end(body = '') {
        let json = null;
        try {
          json = body ? JSON.parse(body) : null;
        } catch {
          json = null;
        }
        resolve({ status: this.statusCode, headers: this.headers, body, json });
      },
    };
    handle(
      {
        method,
        url,
        headers: { host: 'localhost:5173', ...headers },
        socket: {},
      },
      res,
      () => resolve({ status: 'next' }),
    );
  });
}

async function built() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gev-world-history-routes-'),
  );
  const inputs = writeFixture(path.join(root, 'in'));
  const dir = path.join(root, 'out');
  await buildWorldHistory({ ...inputs, dir });
  const handle = createWorldHistoryHandler({
    history: createWorldHistoryIndex({ dir }),
  });
  return { root, dir, handle };
}

test('a year: Cottereau by default, All on request, its polygons, an ETag and a 304', async () => {
  const { root, handle } = await built();
  try {
    const status = await call(handle, '/status');
    assert.equal(status.json.built, true);
    assert.equal(status.json.records, 6);
    assert.equal(status.json.cliopatriaLastYear, 2024);

    const year = await call(handle, '/year/-450?lod=0');
    assert.equal(year.status, 200);
    assert.equal(year.json.mode, 'cottereau');
    assert.deepEqual(
      year.json.polities.map((p) => [p.title, p.name, p.from, p.to]),
      [['Alpha', 'Alpha Kingdom', -600, -301]],
    );
    assert.ok(Array.isArray(year.json.polities[0].polygons[0][0]));
    assert.match(year.headers.etag, /^"wh-[0-9a-f]{12}-/);
    assert.equal(year.headers['cache-control'], 'private, no-cache');
    const again = await call(handle, '/year/-450?lod=0', {
      headers: { 'if-none-match': year.headers.etag },
    });
    assert.equal(again.status, 304);
    const other = await call(handle, '/year/-450?lod=1');
    assert.notEqual(
      other.headers.etag,
      year.headers.etag,
      'each question its own tag',
    );

    const all = await call(handle, '/year/120?mode=all&lod=2');
    assert.deepEqual(
      all.json.polities.map((p) => p.name),
      ['Beta Empire', 'Alpha Kingdom'],
    );
    const places = await call(handle, '/year/250?places=1');
    assert.deepEqual(
      places.json.polities.map((p) => p.title),
      ['Beta'],
    );
    const late = await call(handle, '/year/2025');
    assert.equal(late.json.cliopatriaYear, 2024);

    for (const bad of [
      '/year/0',
      '/year/-2501',
      '/year/2026',
      '/year/1?mode=some',
      '/year/1?lod=x',
    ])
      assert.equal((await call(handle, bad)).status, 400, bad);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a polity at its largest or in a year, the names, and what is refused', async () => {
  const { root, handle } = await built();
  try {
    const max = await call(
      handle,
      '/polity?name=Alpha%20Kingdom&extent=max&lod=1',
    );
    assert.equal(max.status, 200);
    assert.equal(max.json.record.area, 5000);
    assert.equal(max.json.record.polygons.length, 2, 'both parts');
    assert.equal(max.json.from, -600);
    assert.equal(max.json.to, 200);
    const atYear = await call(
      handle,
      '/polity?name=Alpha%20Kingdom&extent=150',
    );
    assert.equal(atYear.json.record.area, 3000);
    const absent = await call(
      handle,
      '/polity?name=Gamma%20Republic&extent=-100',
    );
    assert.equal(absent.status, 404);
    assert.equal((await call(handle, '/polity?name=Nobody')).status, 404);
    assert.equal((await call(handle, '/polity')).status, 400);
    assert.equal(
      (await call(handle, '/polity?name=Beta%20Empire&extent=0')).status,
      400,
    );

    const names = await call(handle, '/names');
    assert.equal(names.json.names.length, 4);
    assert.deepEqual(
      names.json.names.find((n) => n[0] === 'Beta Empire'),
      ['Beta Empire', 100, 500, 9000, 1],
    );
    const found = await call(handle, '/names?q=alp');
    assert.deepEqual(
      found.json.names.map((n) => n[0]),
      ['Alpha Kingdom', '(Alliance of Alpha and Beta)'],
    );

    assert.equal(
      (await call(handle, '/year/1', { method: 'POST' })).status,
      405,
    );
    const crossSite = await call(handle, '/year/1', {
      headers: {
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
      },
    });
    assert.equal(crossSite.status, 403);
    assert.equal((await call(handle, '/elsewhere')).status, 'next');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('not built: 503 with the build command, and a status saying so', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gev-world-history-none-'),
  );
  try {
    const handle = createWorldHistoryHandler({
      history: createWorldHistoryIndex({ dir: root }),
    });
    const year = await call(handle, '/year/1');
    assert.equal(year.status, 503);
    assert.match(year.json.error, /world-history:build/);
    assert.equal((await call(handle, '/status')).json.built, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
