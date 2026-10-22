// Personal fork: `npm run overpass:status` (scripts/overpass-status.mjs),
// the local Overpass API's status text, the data's age and the report.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DB_PROBE,
  classify,
  describeAge,
  parseDbProbe,
  parseStatusText,
  recoverLines,
  summarize,
} from '../../scripts/overpass-status.mjs';

// /api/status as Overpass answers it (overpass-api.de, 2026-10-20).
const STATUS = [
  'Connected as: 1238712214',
  'Current time: 2026-10-20T14:41:53Z',
  'Announced endpoint: none',
  'Rate limit: 8',
  '7 slots available now.',
  'Currently running queries (pid, space limit, time limit, start time):',
  '4242\t536870912\t30\t2026-10-20T14:41:50Z',
  '',
].join('\n');

test('the status text: rate limit, free slots, queries running', () => {
  assert.deepEqual(parseStatusText(STATUS), {
    rateLimit: 8,
    slotsFree: 7,
    running: 1,
  });
  assert.deepEqual(parseStatusText(''), {
    rateLimit: null,
    slotsFree: null,
    running: null,
  });
});

test('ages in words', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  assert.equal(describeAge('2026-10-20T11:48:00Z', now), '12 min');
  assert.equal(describeAge('2026-10-20T07:00:00Z', now), '5 h');
  assert.equal(describeAge('2026-10-12T00:00:00Z', now), '8.5 days');
  assert.equal(describeAge('not a date', now), null);
});

test('the report: answering with its dates, or not answering', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const up = summarize({
    url: 'http://localhost:12345/api',
    status: parseStatusText(STATUS),
    base: '2026-10-20T11:00:00Z',
    areas: null,
    container: { state: 'running', health: 'healthy' },
    now,
  });
  assert.deepEqual(up, [
    'Container gev-overpass: running (healthy)',
    'Overpass at http://localhost:12345/api: answering; data as of 2026-10-20T11:00:00Z (60 min old)',
    '  areas: not built yet (is_in answers nothing until the first rules pass ends)',
    '  rate limit 8, 7 slots free, 1 running',
  ]);
  const down = summarize({
    url: 'http://localhost:12345/api',
    error: 'ECONNREFUSED',
    container: { state: 'running', health: 'starting' },
    lastLog:
      '2026-10-20T11:50:00Z [import] read 40 of 95 GB of the planet (42%)',
    now,
  });
  assert.match(down[1], /not answering \(ECONNREFUSED\)/);
  assert.match(down[2], /42%/);
  assert.match(summarize({ url: 'x', error: 'ECONNREFUSED' })[0], /not found/);
});

// What DB_PROBE prints in each state (the lines initdb/10-import-pbf.sh and
// initdb-clone/10-clone-resumable.sh write).
const CUT_OFF = [
  'file import_started',
  'progress 2026-10-22T16:22:51Z [import] planet read 46%; database 145G',
  'import 2026-10-22T16:22:51Z [import] planet read 46%; database 145G',
  'import 2026-10-22T16:45:40Z [import] An import started at 2026-10-21T15:12:48Z did not finish; the database is incomplete.',
  'import 2026-10-22T16:45:40Z [import] Remove it and start again: docker compose down -v && docker compose up -d',
].join('\n');
const IMPORTING = [
  'file import_started',
  'progress 2026-10-22T19:12:55Z [import] planet read 11%; database 21G',
  'import 2026-10-22T19:12:55Z [import] planet read 11%; database 21G',
].join('\n');
const CLONING = [
  'file clone-base-url',
  'clone 2026-10-23T02:00:00Z [clone] Cloning https://dev.overpass-api.de/clone//2026-10-20: 38 files, 302 GB (meta: no)',
  'clone 2026-10-23T03:00:00Z [clone] downloaded 12%; 36 of 302 GB',
].join('\n');
const running = { state: 'running', health: 'starting' };

test('the database probe: marker files, the last progress, the logs', () => {
  assert.match(DB_PROBE, /init_done import_started clone-base-url/);
  assert.deepEqual(parseDbProbe(CUT_OFF), {
    initDone: false,
    importStarted: true,
    cloneStarted: false,
    progress: '2026-10-22T16:22:51Z [import] planet read 46%; database 145G',
    importLines: CUT_OFF.split('\n')
      .slice(2)
      .map((line) => line.slice('import '.length)),
    cloneLines: [],
  });
  assert.deepEqual(parseDbProbe(''), {
    initDone: false,
    importStarted: false,
    cloneStarted: false,
    progress: null,
    importLines: [],
    cloneLines: [],
  });
});

test('after a restart the state says plainly what happened and what to run', () => {
  const cut = classify({ container: running, db: parseDbProbe(CUT_OFF) });
  assert.equal(cut.state, 'import-cut-off');
  assert.equal(
    cut.headline,
    'Import cut off at 46% (database 145G): the database is incomplete and cannot resume; it must be wiped and the import started again',
  );
  assert.ok(
    cut.steps.includes(
      '  cd tools/overpass && docker compose down -v && docker compose up -d',
    ),
  );
  const importing = classify({
    container: running,
    db: parseDbProbe(IMPORTING),
  });
  assert.equal(importing.state, 'importing');
  assert.match(importing.headline, /at 11% \(database 21G\).*cannot resume/);
  const cloning = classify({ container: running, db: parseDbProbe(CLONING) });
  assert.equal(cloning.state, 'cloning');
  assert.equal(
    cloning.headline,
    'Clone in progress at 12% (36 of 302 GB); a restart resumes it',
  );
  const gaveUp = classify({
    container: running,
    db: parseDbProbe(
      `${CLONING}\nclone 2026-10-23T04:00:00Z [clone] Gave up on x at 1 of 2 bytes; the next start resumes it`,
    ),
  });
  assert.match(gaveUp.steps[0], /resumes by itself/);
  assert.equal(
    classify({
      container: running,
      db: parseDbProbe('file init_done'),
      answering: true,
    }).state,
    'serving',
  );
  assert.equal(
    classify({ container: running, db: parseDbProbe('file init_done') }).state,
    'starting',
  );
  assert.equal(
    classify({ container: running, db: parseDbProbe('') }).state,
    'empty',
  );
  assert.equal(classify({ dockerUp: false }).state, 'docker-down');
  assert.equal(classify({}).state, 'no-container');
  assert.equal(
    classify({ container: { state: 'exited', health: null } }).headline,
    'Container gev-overpass is exited',
  );
});

test('recover prints the state and the steps, and runs nothing', () => {
  const lines = recoverLines(
    classify({ container: running, db: parseDbProbe(CUT_OFF) }),
  );
  assert.match(lines[0], /^State: Import cut off at 46%/);
  assert.equal(
    lines.at(-1),
    'overpass:recover runs nothing: it only prints what to run.',
  );
  assert.deepEqual(
    recoverLines(classify({ container: running, answering: true })),
    [
      'State: Serving.',
      'Nothing to do.',
      'overpass:recover runs nothing: it only prints what to run.',
    ],
  );
  // The report adds the state's line, except when serving.
  const report = summarize({
    url: 'http://localhost:12345/api',
    error: 'UND_ERR_SOCKET',
    container: running,
    state: classify({ container: running, db: parseDbProbe(IMPORTING) }),
  });
  assert.match(report.at(-1), /^State: Import in progress at 11%/);
});
