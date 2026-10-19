// Personal fork: the raw archive (scripts/rawDir.mjs, scripts/raw-archive.mjs):
// GEV_RAW_DIR from the environment or .env, the share check that never
// hangs, the builds' raw paths, and the move to the archive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  checkRawDir,
  rawDirFor,
  rawDirFromDotEnv,
  rawRoot,
} from '../../scripts/rawDir.mjs';
import { archive, planArchive } from '../../scripts/raw-archive.mjs';
import { buildPaths } from '../../scripts/rivers/build.mjs';
import { buildFiles } from '../../scripts/wikipedia/build.mjs';
import { statusOf as censusStatus } from '../../scripts/census/index.mjs';

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-raw-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const put = (file, text = 'x') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

test('GEV_RAW_DIR: the environment first, else .env (.env.local wins), else each cache’s raw/', (t) => {
  const root = tmp(t);
  assert.equal(rawRoot({}, { root }), null);
  assert.equal(
    rawDirFor('rivers', '/cache/rivers/raw', {}, { root }),
    '/cache/rivers/raw',
  );
  put(path.join(root, '.env'), 'OTHER=1\nGEV_RAW_DIR="X:/gev-data"\n');
  assert.equal(rawDirFromDotEnv(root), 'X:/gev-data');
  assert.equal(rawRoot({}, { root }), path.resolve('X:/gev-data'));
  put(path.join(root, '.env.local'), 'export GEV_RAW_DIR=Y:/raw\r\n');
  assert.equal(rawRoot({}, { root }), path.resolve('Y:/raw'));
  // The environment wins, even set empty (to turn it off for one run).
  assert.equal(
    rawRoot({ GEV_RAW_DIR: 'Z:/r' }, { root }),
    path.resolve('Z:/r'),
  );
  assert.equal(rawRoot({ GEV_RAW_DIR: '' }, { root }), null);
  assert.equal(
    rawDirFor('overture', 'fallback', { GEV_RAW_DIR: 'X:/gev-data' }),
    path.join(path.resolve('X:/gev-data'), 'overture', 'raw'),
  );
  assert.throws(() => rawDirFor('../etc', 'x', {}), /bad build name/);
});

test('the share check: writes, renames and reads back; says so instead of hanging', (t) => {
  const dir = path.join(tmp(t), 'deep', 'raw');
  assert.equal(checkRawDir(dir, { env: {} }).dir, dir);
  assert.deepEqual(fs.readdirSync(dir), [], 'the probe leaves nothing');
  // A file where the directory should be: cannot be written.
  const blocked = path.join(tmp(t), 'blocked');
  put(blocked);
  assert.throws(
    () => checkRawDir(path.join(blocked, 'raw'), { env: {} }),
    /cannot be written/,
  );
  // A share that does not answer in time.
  assert.throws(
    () => checkRawDir(dir, { env: { GEV_RAW_DIR: dir }, timeoutMs: 1 }),
    /did not answer within 0 s: is the share connected\? .*unset GEV_RAW_DIR/,
  );
  // Reading only: a missing directory is fine.
  assert.ok(checkRawDir(path.join(dir, 'none'), { env: {}, write: false }));
});

test('the builds take their raw directory from the command, the cache’s raw/ otherwise', () => {
  assert.equal(buildPaths('/c/rivers').raw, path.join('/c/rivers', 'raw'));
  assert.equal(
    buildPaths('/c/rivers', '/nas/rivers/raw').raw,
    '/nas/rivers/raw',
  );
  assert.equal(
    buildFiles('/c/wikipedia').geoTags,
    path.join('/c/wikipedia', 'enwiki-latest-geo_tags.sql.gz'),
  );
  assert.equal(
    buildFiles('/c/wikipedia', '/nas/wikipedia/raw').geoTagsMeta,
    path.join('/nas/wikipedia/raw', 'geo_tags.meta.json'),
  );
  assert.equal(
    buildFiles('/c/wikipedia', '/nas/wikipedia/raw').grid,
    path.join('/c/wikipedia', 'grid.bin'),
  );
  assert.match(
    censusStatus('/nowhere', '/nas/census/raw').raw,
    /nas.census.raw/,
  );
});

function cacheWithRaw(t) {
  const cache = tmp(t);
  put(path.join(cache, 'rivers', 'raw', 'na', 'north.gdb.zip'), 'rivers-na');
  put(path.join(cache, 'rivers', 'v2', 'manifest.json'), '{}');
  put(
    path.join(
      cache,
      'overture',
      'raw',
      '2026-09-23.1',
      'division.part.parquet',
    ),
    'divisions',
  );
  put(
    path.join(
      cache,
      'overture',
      'raw',
      '2026-09-23.1',
      'buildings',
      'footers',
      'a.footer',
    ),
    'footer',
  );
  put(
    path.join(
      cache,
      'overture',
      'raw',
      '2026-09-23.1',
      'buildings',
      'groups',
      'b.rg.123.partial',
    ),
    'writing',
  );
  put(path.join(cache, 'overture', 'buildings', 'current.json'), '{}');
  put(path.join(cache, 'census', 'raw', 'cb.zip'), 'tracts');
  put(path.join(cache, 'census', 'build', 'values.json'), '{}');
  put(path.join(cache, 'wikipedia', 'enwiki-latest-geo_tags.sql.gz'), 'dump');
  put(path.join(cache, 'wikipedia', 'geo_tags.meta.json'), '{}');
  put(path.join(cache, 'wikipedia', 'grid.bin'), 'grid');
  return cache;
}

test('raw:archive: a dry run moves nothing; a run moves the raw files and keeps the builds', async (t) => {
  const cache = cacheWithRaw(t);
  const to = path.join(tmp(t), 'gev-data');
  const lines = [];
  const plan = planArchive({ cache, to });
  assert.equal(plan.moves.length, 6);
  assert.equal(plan.skipped.length, 1, 'a file being written is left alone');
  const dry = await archive({
    cache,
    to,
    dryRun: true,
    log: (l) => lines.push(l),
  });
  assert.equal(dry.moved, 0);
  assert.ok(
    fs.existsSync(path.join(cache, 'rivers', 'raw', 'na', 'north.gdb.zip')),
  );
  assert.ok(!fs.existsSync(to));
  assert.ok(lines.some((l) => /6 files/.test(l)));
  // A file already there at its size is not copied again.
  put(path.join(to, 'census', 'raw', 'cb.zip'), 'tracts');
  const result = await archive({ cache, to, log: () => {}, check: () => {} });
  assert.equal(result.moved, 6);
  assert.equal(result.copied, 'rivers-nadivisionsfooterdump{}'.length);
  assert.equal(
    fs.readFileSync(
      path.join(to, 'rivers', 'raw', 'na', 'north.gdb.zip'),
      'utf8',
    ),
    'rivers-na',
  );
  assert.ok(
    fs.existsSync(
      path.join(
        to,
        'overture',
        'raw',
        '2026-09-23.1',
        'buildings',
        'footers',
        'a.footer',
      ),
    ),
  );
  assert.ok(
    fs.existsSync(
      path.join(to, 'wikipedia', 'raw', 'enwiki-latest-geo_tags.sql.gz'),
    ),
  );
  assert.ok(
    fs.existsSync(path.join(to, 'wikipedia', 'raw', 'geo_tags.meta.json')),
  );
  // The builds stay; the raw files and their emptied folders go.
  for (const kept of [
    'rivers/v2/manifest.json',
    'overture/buildings/current.json',
    'census/build/values.json',
    'wikipedia/grid.bin',
  ])
    assert.ok(fs.existsSync(path.join(cache, kept)), kept);
  assert.ok(!fs.existsSync(path.join(cache, 'rivers', 'raw')));
  assert.ok(!fs.existsSync(path.join(cache, 'census', 'raw')));
  assert.ok(
    !fs.existsSync(
      path.join(cache, 'wikipedia', 'enwiki-latest-geo_tags.sql.gz'),
    ),
  );
  assert.ok(
    fs.existsSync(
      path.join(
        cache,
        'overture',
        'raw',
        '2026-09-23.1',
        'buildings',
        'groups',
        'b.rg.123.partial',
      ),
    ),
  );
  // Times kept; nothing half-copied left behind.
  const walk = (dir) =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((e) =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : [e.name],
      );
  assert.deepEqual(
    walk(to).filter((n) => n.endsWith('.partial')),
    [],
  );
  // Again: nothing to do.
  assert.equal(
    (await archive({ cache, to, log: () => {}, check: () => {} })).moved,
    0,
  );
});

test('raw:archive checks the archive first: an archive that cannot be written moves nothing', async (t) => {
  const cache = cacheWithRaw(t);
  const blocked = path.join(tmp(t), 'blocked');
  put(blocked);
  await assert.rejects(
    archive({ cache, to: path.join(blocked, 'gev-data'), log: () => {} }),
    /cannot be written/,
  );
  assert.ok(
    fs.existsSync(path.join(cache, 'rivers', 'raw', 'na', 'north.gdb.zip')),
  );
});
