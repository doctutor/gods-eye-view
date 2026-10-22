// Personal fork: /api/wikipedia-coverage/points and /summary, on a points
// index written here and a summary answered by a fake Wikipedia.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writePointsIndex } from '../../scripts/wikipedia/points.mjs';
import { unitX, unitY } from './wikipediaCoverage/pointsFile.js';
import {
  createWikipediaCoverageHandler,
  createWikipediaCoverageService,
  parsePointsQuery,
} from './wikipediaCoverage.js';
import { isSummaryTitle, toSummary } from './wikipediaCoverage/summary.js';

async function call(handler, url, headers = {}) {
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
    {
      url,
      method: 'GET',
      headers: { host: 'localhost:5173', ...headers },
      socket: {},
    },
    res,
  );
  return res;
}

function setup(fetchImpl = async () => new Response('{}')) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-wiki-route-'));
  writePointsIndex({
    dir: path.join(dir, 'points'),
    dump: { date: '2026-10-08' },
    points: [
      {
        x: unitX(2.2945),
        y: unitY(48.8584),
        page: 11,
        qid: 243,
        bytes: 150000,
        dim: 300,
        cls: 2,
        flags: 0,
        wiki: 1,
        title: 'Eiffel Tower',
        type: 'landmark',
      },
    ],
  });
  const service = createWikipediaCoverageService({
    gridFile: path.join(dir, 'grid.bin'),
    env: {},
    fetchImpl,
  });
  return {
    dir,
    service,
    handler: createWikipediaCoverageHandler({ service }),
    done: async () => {
      await service.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('the points route answers the box at a zoom, and says when it is not built', async () => {
  const { handler, done, dir } = setup();
  try {
    const layers = await call(handler, '/layers');
    assert.equal(layers.body.points.built, true);
    assert.equal(layers.body.points.points, 1);
    const ok = await call(
      handler,
      '/points?west=2&south=48&east=3&north=49&zoom=14',
    );
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers['cache-control'], 'no-store');
    assert.deepEqual(ok.body.points[0], {
      id: 'wp:1:11:p:' + ok.body.points[0].id.split(':').slice(4).join(':'),
      page: 11,
      qid: 'Q243',
      title: 'Eiffel Tower',
      type: 'landmark',
      class: 'landmark',
      dim: 300,
      bytes: 150000,
      at: ok.body.points[0].at,
    });
    const cached = await call(
      handler,
      `/points?west=2&south=48&east=3&north=49&zoom=14&v=${ok.body.version}`,
    );
    assert.equal(cached.headers['cache-control'], 'private, max-age=86400');
    assert.equal(
      (await call(handler, '/points?west=2&south=48&east=3&north=49'))
        .statusCode,
      400,
    );
    assert.equal(
      (await call(handler, '/points?west=2&south=49&east=3&north=48&zoom=3'))
        .statusCode,
      400,
    );
    fs.rmSync(path.join(dir, 'points'), { recursive: true, force: true });
    const service = createWikipediaCoverageService({
      gridFile: path.join(dir, 'grid.bin'),
      env: {},
    });
    const missing = await call(
      createWikipediaCoverageHandler({ service }),
      '/points?west=2&south=48&east=3&north=49&zoom=3',
    );
    assert.equal(missing.statusCode, 503);
    assert.match(missing.body.error, /--points/);
    await service.close();
  } finally {
    await done();
  }
});

test('the summary is fetched once, with the app’s name, and only its text and image pass', async () => {
  const asked = [];
  const { handler, done } = setup(async (url, options) => {
    asked.push([url, options.headers['User-Agent']]);
    if (url.endsWith('/Nowhere')) return new Response('{}', { status: 404 });
    return Response.json({
      title: 'Eiffel Tower',
      description: 'Tower in Paris',
      extract: 'The Eiffel Tower is a wrought-iron lattice tower.',
      thumbnail: {
        source: 'https://upload.wikimedia.org/eiffel.jpg',
        width: 320,
        height: 240,
      },
      content_urls: { desktop: { page: 'https://evil.example/' } },
    });
  });
  try {
    const first = await call(handler, '/summary?title=Eiffel%20Tower');
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.body, {
      title: 'Eiffel Tower',
      description: 'Tower in Paris',
      extract: 'The Eiffel Tower is a wrought-iron lattice tower.',
      thumbnail: {
        source: 'https://upload.wikimedia.org/eiffel.jpg',
        width: 320,
        height: 240,
      },
    });
    await call(handler, '/summary?title=Eiffel%20Tower');
    assert.equal(asked.length, 1, 'kept');
    assert.equal(
      asked[0][0],
      'https://en.wikipedia.org/api/rest_v1/page/summary/Eiffel_Tower',
    );
    assert.match(asked[0][1], /^gods-eye-view-personal-fork\/.+\(\+https:/);
    assert.equal(
      (await call(handler, '/summary?title=Nowhere')).statusCode,
      404,
    );
    assert.equal(
      (await call(handler, '/summary?title=..%2Fadmin')).statusCode,
      400,
    );
    assert.equal((await call(handler, '/summary')).statusCode, 400);
  } finally {
    await done();
  }
});

test('a thumbnail elsewhere than upload.wikimedia.org is dropped', () => {
  assert.equal(
    toSummary({ thumbnail: { source: 'http://upload.wikimedia.org/x.jpg' } })
      .thumbnail,
    null,
  );
  assert.equal(
    toSummary({ thumbnail: { source: 'https://elsewhere.example/x.jpg' } })
      .thumbnail,
    null,
  );
  assert.equal(isSummaryTitle('São Paulo'), true);
  assert.equal(isSummaryTitle('a|b'), false);
  assert.equal(isSummaryTitle('x'.repeat(300)), false);
});

test('the points query is checked', () => {
  const q = (s) => parsePointsQuery(new URLSearchParams(s));
  assert.equal(q('west=1&south=2&east=3&north=4&zoom=5.7').zoom, 5);
  assert.equal(
    q('west=1&south=2&east=3&north=4&zoom=5&secondary=1').secondary,
    true,
  );
  assert.match(q('west=1&south=2&east=3&north=4&zoom=99').error, /zoom/);
  assert.match(q('west=x&south=2&east=3&north=4&zoom=1').error, /degrees/);
  // Across the antimeridian is one box.
  assert.equal(q('west=179&south=-18&east=-179&north=-16&zoom=8').west, 179);
});
