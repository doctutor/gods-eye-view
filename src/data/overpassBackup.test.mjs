// Personal fork: the local Overpass backup and restore (scripts/overpass-backup.mjs)
// against a fake docker runner, an in-memory filesystem and a fake clock:
// the comm match, the clean point, writers paused and resumed in pairs
// (on failure and Ctrl+C too), .partial then rename, retention, the
// restore's refusals, and the status line. Nothing here touches Docker or
// a disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';

import {
  APPLYING_COMMS,
  DATA_VERIFIED,
  MANIFEST,
  adoptPartial,
  checkCopy,
  isLogFile,
  adoptBackup,
  parseArgs,
  backupName,
  backupsToRemove,
  cleanPoint,
  listBackups,
  liveLooksHealthy,
  parseFiles,
  parseProcesses,
  parseState,
  PROCESS_PROBE,
  progressLine,
  realIo,
  STATE_PROBE,
  restoreRefusal,
  runBackup,
  runRestore,
  updateRunning,
  volumeBytes,
  waitForCleanPoint,
  withWritersPaused,
  writerPids,
} from '../../scripts/overpass-backup.mjs';
import {
  BACKUP_WARN_DAYS,
  backupLine,
  summarize,
} from '../../scripts/overpass-status.mjs';

// ── An in-memory filesystem with the node:fs/promises calls used ─────────

function memoryFs({ free = 2e12 } = {}) {
  const nodes = new Map(); // normalized path → {dir} | {data, size}
  const key = (p) => path.resolve(String(p));
  const parent = (p) => path.dirname(key(p));
  const missing = (p) =>
    Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  const fs = {
    nodes,
    free,
    async mkdir(p, { recursive } = {}) {
      const k = key(p);
      if (nodes.has(k)) return;
      if (!recursive && !nodes.has(parent(k))) throw missing(p);
      if (recursive && parent(k) !== k)
        await fs.mkdir(parent(k), { recursive });
      nodes.set(k, { dir: true });
    },
    async readdir(p) {
      const k = key(p);
      if (!nodes.get(k)?.dir) throw missing(p);
      return [...nodes.keys()]
        .filter((n) => n !== k && path.dirname(n) === k)
        .map((n) => path.basename(n));
    },
    async writeFile(p, data, options = {}) {
      const k = key(p);
      if (options.flag === 'wx' && nodes.has(k))
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      if (!nodes.get(parent(k))?.dir) throw missing(p);
      nodes.set(k, {
        data: String(data),
        size: Buffer.byteLength(String(data)),
      });
    },
    async readFile(p) {
      const n = nodes.get(key(p));
      if (!n || n.dir) throw missing(p);
      return n.data ?? '';
    },
    async stat(p) {
      const n = nodes.get(key(p));
      if (!n) throw missing(p);
      return { size: n.size ?? 0, isDirectory: () => Boolean(n.dir) };
    },
    async rename(a, b) {
      const ka = key(a);
      const kb = key(b);
      if (!nodes.has(ka)) throw missing(a);
      for (const [n, v] of [...nodes]) {
        if (n === ka || n.startsWith(ka + path.sep)) {
          nodes.delete(n);
          nodes.set(kb + n.slice(ka.length), v);
        }
      }
    },
    async rm(p, { force } = {}) {
      const k = key(p);
      if (!nodes.has(k) && !force) throw missing(p);
      for (const n of [...nodes.keys()])
        if (n === k || n.startsWith(k + path.sep)) nodes.delete(n);
    },
    async statfs() {
      return { bavail: fs.free / 4096, bsize: 4096 };
    },
    /** Test helper: a file of a size (no content). */
    put(p, size) {
      nodes.set(key(p), { size, data: '' });
    },
  };
  return fs;
}

const DIR = path.resolve('/backups');
const manifestOf = (createdAt, replicateId, sizeBytes = 3e11) =>
  JSON.stringify({
    version: 1,
    complete: true,
    createdAt,
    replicateId,
    sizeBytes,
  });
async function addBackup(fs, name, createdAt, replicateId) {
  await fs.mkdir(path.join(DIR, name), { recursive: true });
  await fs.writeFile(
    path.join(DIR, name, MANIFEST),
    manifestOf(createdAt, replicateId),
  );
}

// ── A fake container ─────────────────────────────────────────────────────

const PROCS_IDLE = [
  '1\tsupervisord\t/usr/bin/python3 /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf',
  '15\tsh\tsh /app/bin/update_overpass_loop.sh',
  '18\tdispatcher\t/app/bin/dispatcher --areas --db-dir=/db/db --allow-duplicate-queries=yes',
  '21\tbash\tbash /app/bin/rules_loop.sh /db/db 10',
  '27\tdispatcher\t/app/bin/dispatcher --osm-base --db-dir=/db/db --rate-limit=8',
  '34\tnginx\tnginx: worker process',
  '43\tosm3s_query\t./osm3s_query --progress --rules',
].join('\n');
const PROCS_APPLYING = [
  PROCS_IDLE,
  '3211\tupdate_overpass\t/bin/bash /app/bin/update_overpass.sh',
  '11824\tupdate_from_dir\t/app/bin/update_from_dir --osc-dir=/db/diffs --version=2026-10-25T16:52:51Z --flush-size=4',
].join('\n');
const state = ({
  id = 7344333,
  pending = false,
  last = 'Update finished with status code: 3',
} = {}) =>
  [
    `replicate_id ${id}`,
    ...(pending ? ['pending diff'] : []),
    `last ${last}`,
    'osm_base 2026-10-25T16:52:51Z',
  ].join('\n');

/**
 * The container as a script of probe answers (each probe takes the next,
 * the last repeats), the files the volume holds, and a stream that writes
 * them (or fails, or writes one short).
 */
function fakeIo({
  fs = memoryFs(),
  probes = [{ procs: PROCS_IDLE, state: state() }],
  files = [
    { path: 'replicate_id', size: 8 },
    { path: 'db/nodes.bin', size: 1.5e11 },
    { path: 'db/ways.bin', size: 1.5e11 },
  ],
  streamFails = false,
  shortFile = null,
  copiedSizes = {},
  start = Date.parse('2026-10-25T18:00:00Z'),
} = {}) {
  let clock = start;
  let probeAt = 0;
  const kills = [];
  const log = [];
  const signals = new EventEmitter();
  const exits = [];
  const next = () => probes[Math.min(probeAt, probes.length - 1)];
  const io = {
    fs,
    kills,
    lines: log,
    signals,
    exits,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    log: (line) => log.push(line),
    exit: (code) => exits.push(code),
    async docker(args) {
      if (args[0] === 'exec') {
        const script = args.at(-1);
        if (script.startsWith('kill -')) {
          kills.push(script);
          return { code: 0, stdout: '', stderr: '' };
        }
        if (script.includes('/proc/'))
          return { code: 0, stdout: next().procs, stderr: '' };
        if (script.includes('replicate_id')) {
          const answer = next().state;
          probeAt += 1;
          return { code: 0, stdout: answer, stderr: '' };
        }
      }
      if (args[0] === 'run')
        return {
          code: 0,
          stdout: files.map((f) => `${f.size}\t${f.path}`).join('\n'),
          stderr: '',
        };
      return { code: 0, stdout: '', stderr: '' };
    },
    async stream(dest, onBytes) {
      if (streamFails) {
        fs.put(path.join(dest, 'db/nodes.bin'), 1e9);
        return { code: 2, stderr: 'tar: write error: no space left' };
      }
      for (const f of files) {
        const size =
          copiedSizes[f.path] ?? (f.path === shortFile ? f.size - 1 : f.size);
        fs.put(path.join(dest, f.path), size);
        clock += 60_000;
        onBytes(size);
      }
      return { code: 0, stderr: '' };
    },
  };
  return io;
}

// ── Tests ───────────────────────────────────────────────────────────────

test('comm is matched whole at 15 characters: update_from_dir and pyosmium are seen, the writers picked by command line', () => {
  for (const comm of APPLYING_COMMS) assert.equal(comm.length, 15);
  const idle = parseProcesses(PROCS_IDLE);
  const busy = parseProcesses(PROCS_APPLYING);
  assert.equal(updateRunning(idle), false);
  assert.equal(updateRunning(busy), true);
  // The 14-character prefix that once missed an update would not do.
  assert.equal(
    updateRunning([{ pid: 1, comm: 'update_from_di', cmdline: '' }]),
    false,
  );
  assert.equal(
    updateRunning([
      {
        pid: 2,
        comm: 'pyosmium-get-ch',
        cmdline: '/app/venv/bin/python /app/venv/bin/pyosmium-get-changes',
      },
    ]),
    true,
  );
  // The loop, the update script, update_from_dir, the rules loop and its
  // query; never the dispatchers, nginx or supervisord.
  assert.deepEqual(writerPids(busy), [15, 21, 43, 3211, 11824]);
  assert.deepEqual(writerPids(idle), [15, 21, 43]);
});

test('a clean point: nothing applying, no diff waiting, the updater caught up, replicate_id not behind', () => {
  const idle = parseProcesses(PROCS_IDLE);
  const at = (s, lastKnown) =>
    cleanPoint({ processes: idle, state: parseState(s), lastKnown });
  assert.deepEqual(at(state()), { clean: true, reason: '' });
  assert.match(
    cleanPoint({
      processes: parseProcesses(PROCS_APPLYING),
      state: parseState(state()),
    }).reason,
    /applying/,
  );
  assert.match(at(state({ pending: true })).reason, /diff is waiting/);
  // Between catch-up batches no process runs, but the updater is not done.
  assert.match(
    at(
      state({
        last: 'Reading XML file ... finished reading relations. Flushing to database ...... done.',
      }),
    ).reason,
    /between batches/,
  );
  assert.match(at(state({ id: 7344300 }), 7344333).reason, /behind/);
  assert.match(at('replicate_id \nlast x').reason, /no replicate_id/);
  assert.deepEqual(parseState(state({ pending: true })), {
    replicateId: 7344333,
    diffPending: true,
    lastLine: 'Update finished with status code: 3',
    dataTimestamp: '2026-10-25T16:52:51Z',
  });
});

test('waiting: two clean probes in a row with the same replicate_id', async () => {
  const io = fakeIo({
    probes: [
      { procs: PROCS_APPLYING, state: state({ id: 7344332 }) },
      {
        procs: PROCS_IDLE,
        state: state({ id: 7344332, last: 'Downloaded change 7344333.' }),
      },
      { procs: PROCS_IDLE, state: state({ id: 7344333 }) },
      { procs: PROCS_IDLE, state: state({ id: 7344334 }) }, // moved: not steady yet
      { procs: PROCS_IDLE, state: state({ id: 7344334 }) },
    ],
  });
  const found = await waitForCleanPoint(io);
  assert.equal(found.state.replicateId, 7344334);
  assert.ok(io.lines.some((l) => /applying/.test(l)));
  assert.ok(io.lines.some((l) => /between batches/.test(l)));
  // Never clean: gives up after its wait.
  const stuck = fakeIo({ probes: [{ procs: PROCS_APPLYING, state: state() }] });
  await assert.rejects(
    waitForCleanPoint(stuck, { maxWaitMs: 60_000 }),
    /no clean point/,
  );
});

test('pause and resume always come in pairs: done, failed, or Ctrl+C', async () => {
  const run = async (work) => {
    const kills = [];
    const signals = new EventEmitter();
    const exits = [];
    const outcome = await withWritersPaused([15, 21], () => work(signals), {
      kill: async (signal, pids) => kills.push(`${signal} ${pids.join(' ')}`),
      signals,
      exit: (code) => exits.push(code),
    }).then(
      (value) => ({ value }),
      (error) => ({ error: error.message }),
    );
    return {
      kills,
      exits,
      outcome,
      listeners: signals.listenerCount('SIGINT'),
    };
  };
  const done = await run(async () => 'copied');
  assert.deepEqual(done.kills, ['STOP 15 21', 'CONT 15 21']);
  assert.equal(done.outcome.value, 'copied');
  assert.equal(done.listeners, 0, 'handlers removed');

  const failed = await run(async () => {
    throw new Error('disk full');
  });
  assert.deepEqual(failed.kills, ['STOP 15 21', 'CONT 15 21']);
  assert.equal(failed.outcome.error, 'disk full');

  const interrupted = await run(async (signals) => {
    signals.emit('SIGINT');
    await new Promise((r) => setTimeout(r, 0));
    throw new Error('killed');
  });
  assert.deepEqual(
    interrupted.kills,
    ['STOP 15 21', 'CONT 15 21'],
    'resumed once',
  );
  assert.deepEqual(interrupted.exits, [130]);

  // Nothing to pause: nothing sent.
  const none = [];
  await withWritersPaused([], async () => {}, {
    kill: async (...a) => none.push(a),
    signals: new EventEmitter(),
  });
  assert.deepEqual(none, []);
});

test('a backup: .partial while copying, checked, renamed with its manifest, writers resumed, the oldest past two removed', async () => {
  const fs = memoryFs();
  await fs.mkdir(DIR, { recursive: true });
  await addBackup(fs, '20261010', '2026-10-10T03:00:00Z', 7340000);
  await addBackup(fs, '20261018', '2026-10-18T03:00:00Z', 7342000);
  // A copy a power cut left behind.
  await fs.mkdir(path.join(DIR, '20261024.partial'), { recursive: true });
  const io = fakeIo({ fs });
  let partialSeen = false;
  const stream = io.stream;
  io.stream = async (dest, onBytes) => {
    partialSeen = dest.endsWith('20261025.partial');
    assert.equal(
      (await listBackups(DIR, fs)).length,
      2,
      'not a backup while copying',
    );
    return stream(dest, onBytes);
  };
  const result = await runBackup(io, { dir: DIR, keep: 2 });
  assert.ok(partialSeen);
  assert.equal(result.name, '20261025');
  assert.deepEqual(result.removed, ['20261010']);
  assert.deepEqual(
    (await fs.readdir(DIR)).sort(),
    ['20261018', '20261025'],
    'the cut-off copy and the oldest are gone, the lock too',
  );
  const manifest = JSON.parse(
    await fs.readFile(path.join(DIR, '20261025', MANIFEST)),
  );
  assert.equal(manifest.complete, true);
  assert.equal(manifest.replicateId, 7344333);
  assert.equal(manifest.dataTimestamp, '2026-10-25T16:52:51Z');
  assert.equal(manifest.sizeBytes, 3e11 + 8);
  assert.equal(manifest.files.length, 3);
  assert.equal(manifest.durationSeconds, 180);
  assert.deepEqual(io.kills, ['kill -STOP 15 21 43', 'kill -CONT 15 21 43']);
  assert.ok(io.lines.some((l) => /backup complete/.test(l)));
  // A second the same day is named apart.
  assert.equal(
    backupName(new Date('2026-10-25T20:00:00Z'), new Set(['20261025'])),
    '20261025-2',
  );
});

test('a failed or short copy stays a .partial, no backup is removed, and the writers are resumed', async () => {
  for (const options of [{ streamFails: true }, { shortFile: 'db/ways.bin' }]) {
    const fs = memoryFs();
    await fs.mkdir(DIR, { recursive: true });
    await addBackup(fs, '20261010', '2026-10-10T03:00:00Z', 7340000);
    await addBackup(fs, '20261018', '2026-10-18T03:00:00Z', 7342000);
    const io = fakeIo({ fs, ...options });
    await assert.rejects(
      runBackup(io, { dir: DIR }),
      options.streamFails ? /copy failed/ : /differ from the volume/,
    );
    assert.deepEqual((await fs.readdir(DIR)).sort(), [
      '20261010',
      '20261018',
      '20261025.partial',
    ]);
    assert.deepEqual(io.kills, ['kill -STOP 15 21 43', 'kill -CONT 15 21 43']);
    assert.equal((await listBackups(DIR, fs)).length, 2);
  }
});

test('too little room: refused before a byte is copied (writers resumed); an update at the pause backs off and waits again', async () => {
  const fs = memoryFs({ free: 2e11 });
  const io = fakeIo({ fs });
  let streamed = false;
  io.stream = async () => ((streamed = true), { code: 0 });
  await assert.rejects(
    runBackup(io, { dir: DIR }),
    /200\.0 GB free; the copy needs 315\.0 GB/,
  );
  assert.equal(streamed, false);
  assert.deepEqual(io.kills, ['kill -STOP 15 21 43', 'kill -CONT 15 21 43']);

  // Clean twice, then busy right after the pause, then clean again.
  const retry = fakeIo({
    probes: [
      { procs: PROCS_IDLE, state: state() },
      { procs: PROCS_IDLE, state: state() },
      { procs: PROCS_APPLYING, state: state() },
      { procs: PROCS_IDLE, state: state({ id: 7344334 }) },
    ],
  });
  const done = await runBackup(retry, { dir: DIR });
  assert.equal(done.manifest.replicateId, 7344334);
  assert.equal(retry.kills.filter((k) => k.startsWith('kill -STOP')).length, 2);
  assert.equal(retry.kills.filter((k) => k.startsWith('kill -CONT')).length, 2);
  // One backup at a time.
  const fsLocked = memoryFs();
  await fsLocked.mkdir(DIR, { recursive: true });
  await fsLocked.writeFile(path.join(DIR, 'backup.lock'), '123');
  await assert.rejects(
    runBackup(fakeIo({ fs: fsLocked }), { dir: DIR }),
    /another backup is running/,
  );
});

test('retention keeps the newest; only complete backups count', async () => {
  const fs = memoryFs();
  await fs.mkdir(DIR, { recursive: true });
  await addBackup(fs, '20261018', '2026-10-18T03:00:00Z', 1);
  await addBackup(fs, '20261025', '2026-10-25T03:00:00Z', 3);
  await addBackup(fs, '20261025-2', '2026-10-25T20:00:00Z', 4);
  await fs.mkdir(path.join(DIR, '20261026.partial'), { recursive: true });
  await fs.mkdir(path.join(DIR, '20261020'), { recursive: true }); // no manifest
  const backups = await listBackups(DIR, fs);
  assert.deepEqual(
    backups.map((b) => b.name),
    ['20261025-2', '20261025', '20261018'],
  );
  assert.deepEqual(
    backupsToRemove(backups, 2).map((b) => b.name),
    ['20261018'],
  );
  assert.deepEqual(
    backupsToRemove(backups, 1).map((b) => b.name),
    ['20261025', '20261018'],
  );
  assert.deepEqual(
    backupsToRemove(backups, 0).map((b) => b.name),
    ['20261025', '20261018'],
    'never below one',
  );
});

test('the restore refuses: no backup, a healthy live database without --force, too little room, and without --yes', async () => {
  const backup = {
    name: '20261025',
    path: path.join(DIR, '20261025'),
    manifest: { sizeBytes: 3e11, replicateId: 7344333 },
  };
  assert.match(restoreRefusal({ backup: null }), /No such complete backup/);
  assert.match(
    restoreRefusal({ backup, healthy: true, force: false, yes: true }),
    /wrong move/,
  );
  assert.match(
    restoreRefusal({
      backup,
      healthy: false,
      yes: true,
      freeOnTarget: 1e10,
      liveBytes: 1e11,
    }),
    /needs 315\.0 GB/,
  );
  assert.match(
    restoreRefusal({
      backup,
      healthy: false,
      freeOnTarget: 1e10,
      liveBytes: 4e11,
    }),
    /--yes/,
  );
  assert.equal(
    restoreRefusal({
      backup,
      healthy: true,
      force: true,
      yes: true,
      freeOnTarget: 1e10,
      liveBytes: 4e11,
    }),
    null,
  );
  const now = Date.parse('2026-10-25T18:00:00Z');
  assert.equal(
    liveLooksHealthy({
      answering: true,
      dataTimestamp: '2026-10-25T16:00:00Z',
      now,
    }),
    true,
  );
  assert.equal(
    liveLooksHealthy({
      answering: true,
      dataTimestamp: '2026-10-20T16:00:00Z',
      now,
    }),
    false,
  );
  assert.equal(
    liveLooksHealthy({
      answering: false,
      dataTimestamp: '2026-10-25T16:00:00Z',
      now,
    }),
    false,
  );
  assert.equal(
    volumeBytes('[{"Name":"gev-overpass-db","Size":"396.2GB"}]'),
    396.2e9,
  );
  assert.equal(volumeBytes('nonsense'), null);
});

function restoreIo({ healthy = true, after = 7344340 } = {}) {
  const fs = memoryFs({ free: 2e10 });
  const io = fakeIo({
    fs,
    probes: [{ procs: PROCS_IDLE, state: state({ id: after }) }],
  });
  const calls = [];
  const docker = io.docker;
  io.docker = async (args) => {
    if (args[0] !== 'exec')
      calls.push(['docker', ...args.slice(0, 3)].join(' '));
    if (args[0] === 'system')
      return {
        code: 0,
        stdout: '[{"Name":"gev-overpass-db","Size":"396.2GB"}]',
        stderr: '',
      };
    return docker(args);
  };
  io.compose = async (args) => (
    calls.push(`compose ${args.join(' ')}`),
    { code: 0, stdout: '', stderr: '' }
  );
  io.unstream = async (src, onBytes) => (
    calls.push(`unstream ${path.basename(src)}`),
    onBytes(3e11),
    { code: 0 }
  );
  io.health = async () =>
    healthy
      ? {
          answering: true,
          dataTimestamp: new Date(io.now() - 3600_000).toISOString(),
        }
      : { answering: false, dataTimestamp: null };
  io.dockerDrive = 'D:/';
  return { io, fs, calls };
}

test('the restore: a plan without --yes changes nothing; with it, stop, recreate, stream, start, and watch it catch up', async () => {
  const { io, fs, calls } = restoreIo({ healthy: false });
  await fs.mkdir(DIR, { recursive: true });
  await addBackup(fs, '20261025', '2026-10-25T03:00:00Z', 7344333);
  const planned = await runRestore(io, { dir: DIR, which: '20261025' });
  assert.equal(planned.done, false);
  assert.match(planned.refusal, /--yes/);
  assert.ok(io.lines.some((l) => /^1\. Stop and remove the container/.test(l)));
  assert.deepEqual(calls, ['docker system df -v'], 'only looked');

  const done = await runRestore(io, { dir: DIR, which: '20261025', yes: true });
  assert.deepEqual(done, { done: true, caughtUp: true, replicateId: 7344340 });
  assert.deepEqual(calls.slice(1), [
    'docker system df -v',
    'compose rm -sf',
    'docker volume rm gev-overpass-db',
    'docker volume create gev-overpass-db',
    'unstream 20261025',
    'compose up -d',
  ]);

  // Healthy and no --force: refused before anything runs.
  const live = restoreIo({ healthy: true });
  await live.fs.mkdir(DIR, { recursive: true });
  await addBackup(live.fs, '20261025', '2026-10-25T03:00:00Z', 7344333);
  const refused = await runRestore(live.io, {
    dir: DIR,
    which: 'latest',
    yes: true,
  });
  assert.match(refused.refusal, /wrong move/);
  assert.deepEqual(live.calls, ['docker system df -v']);
  // An unknown name.
  assert.match(
    (
      await runRestore(live.io, {
        dir: DIR,
        which: '20200101',
        yes: true,
        force: true,
      })
    ).refusal,
    /No such/,
  );
  // A restore whose updater does not move: says so after its wait.
  const stuck = restoreIo({ healthy: false, after: 7344333 });
  await stuck.fs.mkdir(DIR, { recursive: true });
  await addBackup(stuck.fs, '20261025', '2026-10-25T03:00:00Z', 7344333);
  const slow = await runRestore(stuck.io, {
    dir: DIR,
    which: '20261025',
    yes: true,
    catchUpMs: 60_000,
  });
  assert.deepEqual(slow, { done: true, caughtUp: false });
});

test('the status line: the newest backup with its age, replicate_id and size; none; a warning past 14 days', () => {
  const now = Date.parse('2026-10-25T18:00:00Z');
  const backup = (createdAt) => [
    {
      name: '20261025',
      manifest: { createdAt, replicateId: 7344333, sizeBytes: 3.96e11 },
    },
  ];
  assert.equal(
    backupLine(backup('2026-10-25T16:00:00Z'), now),
    'Backup: 20261025 (2 h old), replicate_id 7344333, 396 GB',
  );
  assert.match(backupLine([], now), /^Backup: none/);
  assert.match(
    backupLine(backup('2026-10-01T16:00:00Z'), now),
    new RegExp(`older than ${BACKUP_WARN_DAYS} days: npm run overpass:backup$`),
  );
  const lines = summarize({
    url: 'u',
    container: { state: 'running' },
    base: '2026-10-25T17:00:00Z',
    backups: [],
    now,
  });
  assert.ok(lines.some((l) => /^Backup: none/.test(l)));
  // Progress and the file list.
  assert.equal(
    progressLine({ copied: 1.3e11, total: 3.9e11, seconds: 10_000 }),
    '130.0 GB of 390.0 GB (33%), 13.0 MB/s, 5 h 33 min left',
  );
  assert.deepEqual(
    parseFiles('8\treplicate_id\n106530062336\tdb/nodes.bin\njunk'),
    [
      { path: 'replicate_id', size: 8 },
      { path: 'db/nodes.bin', size: 106530062336 },
    ],
  );
});

test('a copy made by hand is adopted as a backup: its manifest from the files on disk', async () => {
  const fs = memoryFs();
  const dir = path.join(DIR, '20261025');
  await fs.mkdir(path.join(dir, 'db'), { recursive: true });
  await fs.writeFile(path.join(dir, 'replicate_id'), '7344333\n');
  await fs.writeFile(
    path.join(dir, 'db', 'osm_base_version'),
    '2026-10-25T16:52:51Z\n',
  );
  fs.put(path.join(dir, 'db', 'nodes.bin'), 1.06e11);
  const manifest = await adoptBackup(
    dir,
    fs,
    Date.parse('2026-10-25T20:00:00Z'),
  );
  assert.equal(manifest.adopted, true);
  assert.equal(manifest.replicateId, 7344333);
  assert.equal(manifest.dataTimestamp, '2026-10-25T16:52:51Z');
  assert.deepEqual(
    manifest.files.map((f) => f.path),
    ['db/nodes.bin', 'db/osm_base_version', 'replicate_id'],
  );
  assert.deepEqual(
    (await listBackups(DIR, fs)).map((b) => b.name),
    ['20261025'],
  );
  // Not a copy of /db, or not named like a backup: refused.
  await fs.mkdir(path.join(DIR, '20261026'), { recursive: true });
  await assert.rejects(
    adoptBackup(path.join(DIR, '20261026'), fs),
    /no replicate_id/,
  );
  await fs.mkdir(path.join(DIR, 'misc'), { recursive: true });
  await assert.rejects(
    adoptBackup(path.join(DIR, 'misc'), fs),
    /not named like a backup/,
  );
  // The command line.
  assert.deepEqual(parseArgs(['restore', 'latest', '--yes', '--dir', 'X:/b']), {
    command: 'restore',
    which: 'latest',
    options: { dir: 'X:/b' },
    flags: new Set(['yes']),
  });
  assert.equal(
    parseArgs(['--adopt', 'E:/x/20261025']).options.adopt,
    'E:/x/20261025',
  );
  assert.equal(parseArgs([]).command, 'backup');
});

test('container paths reach docker as written: argv arrays, no shell (Git Bash would rewrite /db)', async () => {
  const calls = [];
  const fakeChild = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.pipe = () => {};
    child.stdin = new EventEmitter();
    setTimeout(() => child.emit('close', 0), 0);
    return child;
  };
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return fakeChild();
  };
  const io = realIo({
    composeDir: 'tools/overpass',
    dockerDrive: 'D:/',
    spawnImpl,
  });
  await io.docker(['exec', 'gev-overpass', 'sh', '-c', STATE_PROBE]);
  await io.docker(['exec', 'gev-overpass', 'sh', '-c', PROCESS_PROBE]);
  await io.stream('E:/b/20261025.partial', () => {});
  await io.unstream('E:/b/20261025', () => {});
  await io.compose(['up', '-d']);
  for (const call of calls) assert.equal(call.options.shell, false);
  assert.deepEqual(calls[0].args.slice(0, 4), [
    'exec',
    'gev-overpass',
    'sh',
    '-c',
  ]);
  assert.match(calls[0].args[4], /cd \/db .*cat replicate_id/);
  assert.match(calls[1].args[4], /\/proc\/\[0-9\]\*/);
  const stream = calls.find(
    (c) => c.args.includes('--rm') && !c.args.includes('-i'),
  );
  assert.ok(stream.args.includes('gev-overpass-db:/src:ro'));
  assert.match(stream.args.at(-1), /^cd \/src && find \. -type s/);
  const unstream = calls.find((c) => c.args.includes('-i'));
  assert.ok(unstream.args.includes('gev-overpass-db:/db'));
  assert.match(unstream.args.at(-1), /^tar -xf - -C \/db && \{ chown/);
  assert.equal(calls.at(-1).options.cwd, 'tools/overpass');
});

const WITH_LOGS = [
  { path: 'changes.log', size: 1000 },
  { path: 'db/database.log', size: 500 },
  { path: 'db/transactions.log', size: 700 },
  { path: 'db/nodes.bin', size: 1.5e11 },
  { path: 'db/ways.bin', size: 1.5e11 },
  { path: 'replicate_id', size: 8 },
];

test('logs the live dispatchers keep writing are not size-checked; every data file still is', async () => {
  assert.equal(isLogFile('changes.log'), true);
  assert.equal(isLogFile('db/database.log'), true);
  assert.equal(isLogFile('db/transactions.log'), true);
  assert.equal(isLogFile('db/nodes.bin'), false);
  assert.equal(isLogFile('diffs/changes.osc'), false);
  assert.equal(isLogFile('db/sub/x.log'), false, 'only the root and db/');
  // The logs grew while the copy ran (the real backup's three differences).
  const fs = memoryFs();
  const io = fakeIo({
    fs,
    files: WITH_LOGS,
    copiedSizes: {
      'changes.log': 1400,
      'db/database.log': 900,
      'db/transactions.log': 650,
    },
  });
  const result = await runBackup(io, { dir: DIR });
  assert.equal(result.name, '20261025');
  const logs = result.manifest.files.filter((f) => f.log);
  assert.deepEqual(logs, [
    { path: 'changes.log', size: 1400, log: true },
    { path: 'db/database.log', size: 900, log: true },
    { path: 'db/transactions.log', size: 650, log: true },
  ]);
  assert.equal(result.manifest.sizeBytes, 3e11 + 8 + 1400 + 900 + 650);
  assert.deepEqual(
    await fs
      .readdir(path.join(DIR, '20261025'))
      .then((n) => n.includes(DATA_VERIFIED)),
    false,
    'the marker goes with the rename',
  );
  // A data file that differs still fails it.
  const bad = fakeIo({
    files: WITH_LOGS,
    copiedSizes: { 'db/ways.bin': 1.4e11 },
  });
  await assert.rejects(
    runBackup(bad, { dir: DIR }),
    /1 data files differ from the volume \(first: db\/ways\.bin/,
  );
  // checkCopy alone: a file the volume gained after the list (a diff the
  // resumed updater downloaded) is not in the list and does not count.
  const loose = memoryFs();
  for (const f of WITH_LOGS)
    loose.put(
      path.join(DIR, 'x', f.path),
      f.size + (isLogFile(f.path) ? 5 : 0),
    );
  loose.put(path.join(DIR, 'x', 'diffs/changes.osc'), 99);
  const checked = await checkCopy(path.join(DIR, 'x'), WITH_LOGS, loose);
  assert.deepEqual(checked.wrong, []);
  assert.equal(checked.files.length, WITH_LOGS.length);
  assert.equal(
    checked.files.some((f) => f.path === 'diffs/changes.osc'),
    false,
  );
});

test('a .partial whose data files matched is never removed: kept, with how to adopt it; a cut-off one still is', async () => {
  const fs = memoryFs();
  await fs.mkdir(DIR, { recursive: true });
  // Verified, then cut off (say at the rename).
  const good = path.join(DIR, '20261024.partial');
  await fs.mkdir(good, { recursive: true });
  await fs.writeFile(
    path.join(good, DATA_VERIFIED),
    JSON.stringify({ complete: true, replicateId: 7344300, files: [] }),
  );
  // Cut off mid-copy: no record.
  const cut = path.join(DIR, '20261023.partial');
  await fs.mkdir(cut, { recursive: true });
  const io = fakeIo({ fs });
  await runBackup(io, { dir: DIR });
  const names = await fs.readdir(DIR);
  assert.ok(names.includes('20261024.partial'), 'kept');
  assert.ok(!names.includes('20261023.partial'), 'removed');
  assert.ok(
    io.lines.some((l) =>
      l.includes(`npm run overpass:backup -- --adopt ${good}`),
    ),
  );
  // A copy that fails after its data matched leaves that record behind.
  const late = memoryFs();
  const lateIo = fakeIo({ fs: late });
  const rename = late.rename;
  late.rename = async () => {
    throw new Error('EPERM: the drive went away');
  };
  await assert.rejects(runBackup(lateIo, { dir: DIR }), /EPERM/);
  late.rename = rename;
  const left = path.join(DIR, '20261025.partial');
  const record = JSON.parse(
    await late.readFile(path.join(left, DATA_VERIFIED)),
  );
  assert.equal(record.replicateId, 7344333);
  assert.equal(record.complete, true);
});

async function partialWith(fs, name, files, { marker = false } = {}) {
  const at = path.join(DIR, name);
  await fs.mkdir(at, { recursive: true });
  for (const f of files) fs.put(path.join(at, f.path), f.size);
  await fs.writeFile(path.join(at, 'replicate_id'), '7344333\n');
  if (marker)
    await fs.writeFile(
      path.join(at, DATA_VERIFIED),
      JSON.stringify({
        version: 1,
        complete: true,
        replicateId: 7344333,
        files: [...files, { path: 'replicate_id', size: 8 }],
        sizeBytes: 1,
      }),
    );
  return at;
}
const DATA = [
  { path: 'db/nodes.bin', size: 1.5e11 },
  { path: 'db/ways.bin', size: 1.5e11 },
  { path: 'db/database.log', size: 900 },
];

test('--adopt on a .partial: by its record, or re-verified against the volume while the replicate_id still matches; refused otherwise', async () => {
  // With its record: renamed, its manifest written, the record gone.
  const fs = memoryFs();
  const marked = await partialWith(fs, '20261025.partial', DATA, {
    marker: true,
  });
  const manifest = await adoptPartial(fakeIo({ fs }), marked);
  assert.equal(manifest.replicateId, 7344333);
  assert.deepEqual(
    (await listBackups(DIR, fs)).map((b) => b.name),
    ['20261025'],
  );
  assert.equal(
    (await fs.readdir(path.join(DIR, '20261025'))).includes(DATA_VERIFIED),
    false,
  );

  // No record, the volume still at the copy's replicate_id: checked now.
  const listed = [
    { path: 'db/database.log', size: 5000 }, // grew: a log, fine
    { path: 'db/nodes.bin', size: 1.5e11 },
    { path: 'db/ways.bin', size: 1.5e11 },
    { path: 'replicate_id', size: 8 },
  ];
  const fresh = memoryFs();
  const plain = await partialWith(fresh, '20261026.partial', DATA);
  const adopted = await adoptPartial(
    fakeIo({ fs: fresh, files: listed }),
    plain,
  );
  assert.equal(adopted.verifiedAtAdoption, true);
  assert.deepEqual(
    adopted.files.find((f) => f.log),
    { path: 'db/database.log', size: 900, log: true },
  );
  assert.deepEqual(
    (await listBackups(DIR, fresh)).map((b) => b.name),
    ['20261026'],
  );

  // The database moved on: refused, the .partial left as it was.
  const moved = memoryFs();
  const old = await partialWith(moved, '20261027.partial', DATA);
  await assert.rejects(
    adoptPartial(
      fakeIo({
        fs: moved,
        files: listed,
        probes: [{ procs: PROCS_IDLE, state: state({ id: 7344400 }) }],
      }),
      old,
    ),
    /moved on since this copy \(replicate_id 7344400 now, 7344333 in the copy\)/,
  );
  assert.ok((await moved.readdir(DIR)).includes('20261027.partial'));
  // An update applying: refused for now.
  await assert.rejects(
    adoptPartial(
      fakeIo({
        fs: moved,
        files: listed,
        probes: [{ procs: PROCS_APPLYING, state: state() }],
      }),
      old,
    ),
    /applying or waiting/,
  );
  // A data file that differs: refused.
  await assert.rejects(
    adoptPartial(
      fakeIo({
        fs: moved,
        files: [...listed.slice(0, 2), { path: 'db/ways.bin', size: 1.6e11 }],
      }),
      old,
    ),
    /1 data files differ/,
  );
  // A record whose files shrank since: refused.
  const shrunk = memoryFs();
  const s1 = await partialWith(shrunk, '20261028.partial', DATA, {
    marker: true,
  });
  shrunk.put(path.join(s1, 'db/ways.bin'), 1);
  await assert.rejects(
    adoptPartial(fakeIo({ fs: shrunk }), s1),
    /no longer the size/,
  );
  // Names and a taken target.
  await assert.rejects(
    adoptPartial(fakeIo({ fs: moved }), path.join(DIR, 'misc.partial')),
    /not a backup's \.partial/,
  );
  await moved.mkdir(path.join(DIR, '20261027'), { recursive: true });
  await assert.rejects(
    adoptPartial(fakeIo({ fs: moved }), old),
    /exists already/,
  );
});
