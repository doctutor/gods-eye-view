// Personal fork: the raster values cache prune (scripts/cache-prune.mjs):
// which version folders are current, superseded or unknown on a synthetic
// cache tree, that only the superseded ones are deleted and only with
// --delete, and the real service's plans on an answer it would keep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CACHE_SUBDIR,
  main,
  pruneVersions,
  readHeader,
  requestOf,
  selectVersions,
} from '../../scripts/cache-prune.mjs';
import { createRasterValuesService } from '../../server/providers/rasterValues.js';
import { encodeRasterValues, windowGrid } from '../data/rasterValues.js';
import { latticeBox, latticeCells } from '../layers/blocks/lattice.js';

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-prune-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A kept answer: a raster-values/1 header over a few values. */
function answer(header) {
  return encodeRasterValues(
    {
      schema: 'raster-values/1',
      cols: 2,
      rows: 2,
      units: 'm',
      nodata: NaN,
      ...header,
    },
    new Float32Array(header.cols * header.rows || 4),
  );
}

function put(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body);
}

/**
 * A synthetic cache: layer `a` keeps today in v2 (west 0 and 1), in v3
 * (west 2); `b`'s build is not on this machine.
 */
function syntheticCache(root) {
  const cache = path.join(root, CACHE_SUBDIR);
  const at = (...parts) => path.join(cache, ...parts);
  const box = (west) => ({ west, south: 0, east: west + 1, north: 1 });
  const header = (west, extra = {}) => ({
    layer: 'a',
    mode: '',
    ...box(west),
    ...extra,
  });
  put(at('a', 'default', 'v2'), 'x.bin', answer(header(0)));
  put(at('a', 'default', 'v1'), 'x.bin', answer(header(0)));
  put(at('a', 'default', 'v1'), 'y.bin', answer(header(2)));
  put(at('a', 'default', 'v1'), 'z.bin.123.tmp', 'partial');
  // Mixed: one answer still kept here today, so the folder is current.
  put(at('a', 'default', 'v3'), 'p.bin', answer(header(0)));
  put(at('a', 'default', 'v3'), 'q.bin', answer(header(2)));
  put(at('a', 'default', 'bad'), 'r.bin', 'not a header');
  fs.mkdirSync(at('a', 'default', 'empty'), { recursive: true });
  put(
    at('b', 'm', 'old'),
    's.bin',
    answer({ ...header(0), layer: 'b', mode: 'm' }),
  );
  put(cache, 'notes.txt', 'outside any version');
  put(path.join(root, '.gev-cache', 'other'), 't.bin', answer(header(0)));
  /** The service's cacheFile for this cache: b answers 503. */
  const cacheFile = (request) =>
    request.layer === 'b'
      ? { status: 503, error: 'not built' }
      : {
          file: at(
            'a',
            'default',
            Number(request.west) < 2 ? 'v2' : 'v3',
            'k.bin',
          ),
        };
  return { cache, at, cacheFile };
}

const stateOf = (versions) =>
  Object.fromEntries(
    versions.map((entry) => [
      `${entry.layer}/${entry.mode}/${entry.version}`,
      entry.state,
    ]),
  );

test('selectVersions: current when an answer is kept there today, superseded when all are kept elsewhere, unknown when one cannot be planned', (t) => {
  const { cache, cacheFile } = syntheticCache(tempRoot(t));
  const versions = selectVersions(cache, cacheFile);
  assert.deepEqual(stateOf(versions), {
    'a/default/bad': 'unknown',
    'a/default/empty': 'unknown',
    'a/default/v1': 'superseded',
    'a/default/v2': 'current',
    'a/default/v3': 'current',
    'b/m/old': 'unknown',
  });
  const v1 = versions.find((entry) => entry.version === 'v1');
  assert.equal(v1.answers, 2);
  assert.equal(
    v1.bytes,
    fs.statSync(path.join(v1.dir, 'x.bin')).size * 2 + 'partial'.length,
  );
  assert.deepEqual(v1.now, ['a/default/v2', 'a/default/v3']);
});

test('pruneVersions removes the superseded folders only, nothing outside them; a folder not straight under the cache is refused', (t) => {
  const root = tempRoot(t);
  const { cache, at, cacheFile } = syntheticCache(root);
  const versions = selectVersions(cache, cacheFile);
  const removed = pruneVersions(cache, versions);
  assert.ok(removed > 0);
  assert.equal(fs.existsSync(at('a', 'default', 'v1')), false);
  for (const kept of [
    at('a', 'default', 'v2', 'x.bin'),
    at('a', 'default', 'v3', 'q.bin'),
    at('a', 'default', 'bad', 'r.bin'),
    at('a', 'default', 'empty'),
    at('b', 'm', 'old', 's.bin'),
    path.join(cache, 'notes.txt'),
    path.join(root, '.gev-cache', 'other', 't.bin'),
  ])
    assert.ok(fs.existsSync(kept), kept);
  // A forged entry outside the cache, or with a climbing name, is refused.
  const outside = path.join(root, '.gev-cache', 'other');
  for (const forged of [
    { layer: 'a', mode: 'default', version: 'v2', dir: outside },
    { layer: 'a', mode: 'default', version: '..', dir: at('a', 'default') },
  ])
    assert.throws(
      () =>
        pruneVersions(cache, [{ ...forged, state: 'superseded', bytes: 0 }]),
      /Not a version folder/,
    );
  assert.ok(fs.existsSync(path.join(outside, 't.bin')));
  assert.ok(fs.existsSync(at('a', 'default', 'v2', 'x.bin')));
});

test('main: a dry run lists and deletes nothing; --delete removes the superseded', async (t) => {
  const root = tempRoot(t);
  const { at, cacheFile } = syntheticCache(root);
  const service = { cacheFile };
  const lines = [];
  const log = (line) => lines.push(line);
  assert.equal(await main({ argv: ['--root', root], log, service }), 0);
  assert.ok(fs.existsSync(at('a', 'default', 'v1', 'x.bin')));
  assert.ok(lines.some((line) => /^a\/default: 5 versions/.test(line)));
  assert.ok(
    lines.some((line) =>
      /superseded +v1 +2 answers .*\(now v2, v3\)/.test(line),
    ),
  );
  assert.ok(
    lines.some((line) => /^superseded: 1 versions, 2 answers/.test(line)),
  );
  assert.match(lines.at(-1), /dry run: nothing deleted/);
  lines.length = 0;
  assert.equal(
    await main({ argv: ['--root', root, '--delete'], log, service }),
    0,
  );
  assert.equal(fs.existsSync(at('a', 'default', 'v1')), false);
  assert.ok(fs.existsSync(at('a', 'default', 'v2', 'x.bin')));
  assert.match(lines.at(-1), /^deleted /);
  assert.equal(await main({ argv: ['--wipe'], log, service }), 2);
});

test('the real service: an answer as it keeps it is current, a copy under another version is superseded, the water plane and the lattice cell read back', async (t) => {
  const root = tempRoot(t);
  const cacheDir = path.join(root, CACHE_SUBDIR);
  const service = createRasterValuesService({
    sourceRoot: root,
    env: {},
    cacheDir,
    dirs: {
      overtureDir: path.join(root, 'overture'),
      censusDir: path.join(root, 'census'),
      gridFile: path.join(root, 'wikipedia', 'grid.bin'),
    },
  });
  t.after(() => service.close());
  // A 120 m lattice tile over Baltimore with the water plane, as the
  // Blocks source asks it.
  const box = latticeBox(120, 179, 233);
  const request = {
    layer: 'ee-elevation',
    mode: '',
    ...Object.fromEntries(Object.entries(box).map(([k, v]) => [k, String(v)])),
    cells: String(latticeCells(120)),
    water: '1',
  };
  const { file } = service.cacheFile(request);
  assert.ok(file.startsWith(path.join(cacheDir, 'ee-elevation', 'default')));
  const { cols, rows } = windowGrid(box, latticeCells(120));
  const body = encodeRasterValues(
    {
      schema: 'raster-values/1',
      layer: 'ee-elevation',
      mode: '',
      cols,
      rows,
      ...box,
      units: 'm',
      nodata: NaN,
    },
    new Float32Array(cols * rows),
    { water: new Float32Array(cols * rows) },
  );
  put(path.dirname(file), path.basename(file), body);
  put(
    path.join(cacheDir, 'ee-elevation', 'default', 'old0123456789'),
    'a.bin',
    body,
  );
  assert.deepEqual(requestOf(readHeader(file)), request);
  const versions = selectVersions(cacheDir, (asked) =>
    service.cacheFile(asked),
  );
  const current = path.basename(path.dirname(file));
  assert.deepEqual(stateOf(versions), {
    [`ee-elevation/default/${current}`]: 'current',
    'ee-elevation/default/old0123456789': 'superseded',
  });
  // Without the plane it is another version: the copy is not current.
  const { water, ...dry } = request;
  assert.equal(water, '1');
  assert.notEqual(
    path.dirname(service.cacheFile(dry).file),
    path.dirname(file),
  );
});
