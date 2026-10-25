#!/usr/bin/env node
// Personal fork: `npm run overpass:backup` and `npm run overpass:restore`,
// a copy of the local Overpass database (tools/overpass, the gev-overpass-db
// volume) on another drive, made while it keeps answering queries, and that
// copy put back. Not part of upstream God's Eye View.
//
//   npm run overpass:backup [-- --dir E:/gev-data/overpass-backup] [--keep 2]
//   npm run overpass:backup -- --adopt <dir>   (a copy made by hand: write its manifest)
//   npm run overpass:restore -- <backup> [--yes] [--force]
//
// Backup: wait for a clean point (no update applying, none pending, the
// updater's last word "Update finished with status code: 3"), pause the
// writers (SIGSTOP; queries go on), stream the volume out of a read-only
// container into <dir>/<yyyymmdd>.partial, check every file's size, write
// manifest.json, rename to <yyyymmdd>, resume the writers (always: on
// failure and on Ctrl+C too), and only then drop the oldest complete
// backups past --keep.
//
// Restore prints its plan and does nothing without --yes, and refuses while
// the live database looks healthy unless --force. tools/overpass/README.md,
// "Backup and restore".
import { spawn } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CONTAINER = 'gev-overpass';
export const VOLUME = 'gev-overpass-db';
export const IMAGE = 'wiktorn/overpass-api:0.7.62';
export const DEFAULT_BACKUP_DIR = 'E:/gev-data/overpass-backup';
export const DEFAULT_KEEP = 2;
export const MANIFEST = 'manifest.json';
export const PARTIAL_SUFFIX = '.partial';
/** A complete backup's directory name: the day, and a count when there are more. */
export const BACKUP_NAME = /^(\d{8})(?:-(\d+))?$/;
/** Room to spare on the target beyond the copy itself. */
export const SPACE_MARGIN = 1.05;
const POLL_MS = 20_000;
const PROGRESS_MS = 30_000;

// ── Which processes write ───────────────────────────────────────────────

/**
 * /proc/<pid>/comm holds at most 15 characters: "update_from_dir" is exactly
 * 15 and "pyosmium-get-changes" arrives as "pyosmium-get-ch". These are
 * compared whole; a shorter prefix once missed a running update.
 */
export const APPLYING_COMMS = Object.freeze([
  'update_from_dir',
  'pyosmium-get-ch',
]);
/** The writers paused for a copy, by their command line. */
export const WRITER_PATTERNS = Object.freeze([
  /\bupdate_overpass_loop\.sh\b/,
  /\bupdate_overpass\.sh\b/,
  /\bupdate_from_dir\b/,
  /\bpyosmium-get-changes\b/,
  /\brules_loop\.sh\b/,
  /\bosm3s_query --progress --rules\b/,
]);

/** One line a process, "pid<TAB>comm<TAB>cmdline", skipping the probe itself. */
export const PROCESS_PROBE =
  'me=$$; for p in /proc/[0-9]*; do pid=${p#/proc/}; [ "$pid" = "$me" ] && continue; ' +
  'c=$(cat $p/comm 2>/dev/null) || continue; ' +
  'l=$(tr "\\0" " " < $p/cmdline 2>/dev/null); ' +
  'case "$l" in *"for p in /proc"*) continue;; esac; ' +
  'printf "%s\\t%s\\t%s\\n" "$pid" "$c" "$l"; done';

/** PROCESS_PROBE's output: [{pid, comm, cmdline}]. */
export function parseProcesses(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.split('\t'))
    .filter(([pid]) => /^\d+$/.test(pid || ''))
    .map(([pid, comm = '', cmdline = '']) => ({
      pid: Number(pid),
      comm: comm.trim(),
      cmdline: cmdline.trim(),
    }));
}

/** Whether an update is applying or a diff downloading now. */
export const updateRunning = (processes) =>
  processes.some((p) => APPLYING_COMMS.includes(p.comm));

/** The pids to pause, in a stable order. */
export const writerPids = (processes) =>
  processes
    .filter((p) => WRITER_PATTERNS.some((pattern) => pattern.test(p.cmdline)))
    .map((p) => p.pid)
    .sort((a, b) => a - b);

// ── The clean point ─────────────────────────────────────────────────────

/** The database's own record of where it stands. */
export const STATE_PROBE = [
  'cd /db 2>/dev/null || exit 0',
  'printf "replicate_id %s\\n" "$(cat replicate_id 2>/dev/null)"',
  '[ -e diffs/changes.osc ] && echo "pending diff"',
  'printf "last %s\\n" "$(grep -v "^[[:space:]]*$" changes.log 2>/dev/null | tail -n 1)"',
  'printf "osm_base %s\\n" "$(cat db/osm_base_version 2>/dev/null)"',
  'true',
].join('; ');

/** STATE_PROBE's output: {replicateId, diffPending, lastLine, dataTimestamp}. */
export function parseState(text) {
  const lines = String(text || '').split(/\r?\n/);
  const value = (prefix) =>
    lines.find((line) => line.startsWith(prefix))?.slice(prefix.length) ?? '';
  const id = Number(value('replicate_id ').trim());
  return {
    replicateId: Number.isSafeInteger(id) && id > 0 ? id : null,
    diffPending: lines.includes('pending diff'),
    lastLine: value('last ').trim(),
    dataTimestamp: value('osm_base ').trim() || null,
  };
}

const FINISHED = /Update finished with status code: 3\s*$/;

/**
 * Whether the database is at a clean point: nothing applying, no diff
 * waiting, the updater's last word that it is caught up (between catch-up
 * batches there are gaps with no process at all, which are not), and its
 * replicate_id no older than the last one known.
 * @returns {{clean: boolean, reason: string}}
 */
export function cleanPoint({ processes, state, lastKnown = null }) {
  if (updateRunning(processes))
    return { clean: false, reason: 'an update is applying' };
  if (!state.replicateId)
    return { clean: false, reason: 'no replicate_id in /db' };
  if (state.diffPending)
    return { clean: false, reason: 'a downloaded diff is waiting' };
  if (!FINISHED.test(state.lastLine))
    return {
      clean: false,
      reason: 'the updater has not said it is caught up (between batches)',
    };
  if (lastKnown && state.replicateId < lastKnown)
    return {
      clean: false,
      reason: `replicate_id ${state.replicateId} is behind ${lastKnown}`,
    };
  return { clean: true, reason: '' };
}

// ── Pausing ─────────────────────────────────────────────────────────────

/**
 * Run `work` with the writers stopped (SIGSTOP) and resume them (SIGCONT)
 * however it ends: returned, thrown, or a signal (SIGINT, SIGTERM) that
 * then exits with 130. Resume runs once.
 * @param {{kill: (signal: string, pids: number[]) => Promise<void>,
 *   signals?: {on: Function, off: Function}, exit?: (code: number) => void,
 *   log?: Function}} io
 */
export async function withWritersPaused(pids, work, io) {
  const { kill, signals = process, exit = (code) => process.exit(code) } = io;
  const log = io.log || (() => {});
  let resumed = false;
  const resume = async () => {
    if (resumed || !pids.length) return;
    resumed = true;
    log(`resuming writers: ${pids.join(' ')}`);
    await kill('CONT', pids);
  };
  const onSignal = (name) => {
    log(`${name}: resuming the writers before exiting`);
    resume().finally(() => exit(130));
  };
  const handlers = ['SIGINT', 'SIGTERM'].map((name) => {
    const handler = () => onSignal(name);
    signals.on(name, handler);
    return [name, handler];
  });
  try {
    if (pids.length) {
      log(`pausing writers: ${pids.join(' ')}`);
      await kill('STOP', pids);
    }
    return await work();
  } finally {
    await resume();
    for (const [name, handler] of handlers) signals.off(name, handler);
  }
}

// ── Backups on disk ─────────────────────────────────────────────────────

/** A backup's directory name for a day: yyyymmdd, then -2, -3 when taken. */
export function backupName(date, taken) {
  const day = date.toISOString().slice(0, 10).replace(/-/g, '');
  if (!taken.has(day)) return day;
  for (let n = 2; ; n++) if (!taken.has(`${day}-${n}`)) return `${day}-${n}`;
}

/**
 * The complete backups under `dir`, newest first: {name, path, manifest}.
 * A directory counts only with its manifest; a .partial never does.
 * @param {{readdir: Function, readFile: Function}} fs
 */
export async function listBackups(dir, fs) {
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const found = [];
  for (const name of names) {
    if (!BACKUP_NAME.test(name)) continue;
    try {
      const manifest = JSON.parse(
        await fs.readFile(path.join(dir, name, MANIFEST), 'utf8'),
      );
      if (manifest?.complete === true)
        found.push({ name, path: path.join(dir, name), manifest });
    } catch {
      /* no manifest: not a backup */
    }
  }
  const order = (name) => {
    const [, day, n] = BACKUP_NAME.exec(name);
    return Number(day) * 1000 + Number(n || 1);
  };
  return found.sort((a, b) => order(b.name) - order(a.name));
}

/** The backups to remove so `keep` complete ones remain (the oldest). */
export const backupsToRemove = (backups, keep = DEFAULT_KEEP) =>
  backups.slice(Math.max(1, keep));

/** Left-over .partial directories (a copy a power cut or a failure cut off). */
export async function staleParts(dir, fs) {
  try {
    return (await fs.readdir(dir))
      .filter((name) => name.endsWith(PARTIAL_SUFFIX))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

// ── Progress and words ──────────────────────────────────────────────────

const GB = 1e9;
export const formatGb = (bytes) => `${(bytes / GB).toFixed(1)} GB`;
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '?';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}
/** A progress line: copied, of total, rate, ETA. */
export function progressLine({ copied, total, seconds }) {
  const rate = seconds > 0 ? copied / seconds : 0;
  const eta = rate > 0 ? (total - copied) / rate : NaN;
  const share = total > 0 ? Math.min(100, (100 * copied) / total) : 0;
  return `${formatGb(copied)} of ${formatGb(total)} (${share.toFixed(0)}%), ${(rate / 1e6).toFixed(1)} MB/s, ${formatDuration(eta)} left`;
}

/** The volume's files, "size<TAB>path" from `find -printf` (sockets left out). */
export const FILES_PROBE =
  "cd /src && find . -type f -printf '%s\\t%P\\n' | sort -k2";
export function parseFiles(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => /^(\d+)\t(.+)$/.exec(line))
    .filter(Boolean)
    .map(([, size, file]) => ({ path: file, size: Number(size) }));
}

/** Files whose copy is missing or a different size: [{path, expected, found}]. */
export async function verifyCopy(dir, files, fs) {
  const wrong = [];
  for (const file of files) {
    let found = null;
    try {
      found = (await fs.stat(path.join(dir, file.path))).size;
    } catch {
      /* missing */
    }
    if (found !== file.size)
      wrong.push({ path: file.path, expected: file.size, found });
  }
  return wrong;
}

/** Bytes free on the drive holding `dir`, or null when unknown. */
export async function freeBytes(dir, fs) {
  try {
    const s = await fs.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

// ── The backup ──────────────────────────────────────────────────────────

/**
 * @typedef {object} BackupIo
 * @property {(args: string[]) => Promise<{code: number, stdout: string, stderr: string}>} docker
 *   `docker <args>` to completion
 * @property {(dest: string, onBytes: (n: number) => void) => Promise<{code: number, stderr: string}>} stream
 *   the volume as a tar from a read-only container into `dest` (sockets left out)
 * @property {object} fs  node:fs/promises' readdir, readFile, writeFile,
 *   mkdir, rename, rm, stat, statfs
 * @property {() => number} now
 * @property {(ms: number) => Promise<void>} sleep
 * @property {Function} log
 * @property {{on: Function, off: Function}} [signals]
 * @property {(code: number) => void} [exit]
 */

const inContainer = (io, script) =>
  io.docker(['exec', CONTAINER, 'sh', '-c', script]);

async function probe(io) {
  const [procs, state] = await Promise.all([
    inContainer(io, PROCESS_PROBE),
    inContainer(io, STATE_PROBE),
  ]);
  if (procs.code !== 0 || state.code !== 0)
    throw new Error(
      `cannot look inside ${CONTAINER} (${(procs.stderr || state.stderr || '').trim().slice(0, 160)})`,
    );
  return {
    processes: parseProcesses(procs.stdout),
    state: parseState(state.stdout),
  };
}

/**
 * Wait until two probes a poll apart both find a clean point, and the
 * replicate_id did not move between them.
 */
export async function waitForCleanPoint(
  io,
  { lastKnown = null, maxWaitMs = 3 * 3600_000 } = {},
) {
  const started = io.now();
  let previous = null;
  let said = '';
  for (;;) {
    const now = await probe(io);
    const verdict = cleanPoint({ ...now, lastKnown });
    if (
      verdict.clean &&
      previous &&
      previous.state.replicateId === now.state.replicateId
    )
      return now;
    previous = verdict.clean ? now : null;
    const why = verdict.clean ? 'clean once; checking again' : verdict.reason;
    if (why !== said) {
      io.log(`waiting for a clean point: ${why}`);
      said = why;
    }
    if (io.now() - started > maxWaitMs)
      throw new Error(
        `no clean point in ${formatDuration(maxWaitMs / 1000)} (last: ${verdict.reason || 'unsteady'})`,
      );
    await io.sleep(POLL_MS);
  }
}

/**
 * The whole backup. Returns {name, path, manifest, removed}.
 * @param {BackupIo} io
 */
export async function runBackup(
  io,
  { dir = DEFAULT_BACKUP_DIR, keep = DEFAULT_KEEP, attempts = 3 } = {},
) {
  const { fs } = io;
  await fs.mkdir(dir, { recursive: true });
  // One backup at a time.
  const lock = path.join(dir, 'backup.lock');
  try {
    await fs.writeFile(lock, String(process.pid), { flag: 'wx' });
  } catch {
    throw new Error(
      `${lock} exists: another backup is running (or one was cut off; delete the file once you are sure none is)`,
    );
  }
  try {
    for (const stale of await staleParts(dir, fs)) {
      io.log(`removing a cut-off copy: ${stale}`);
      await fs.rm(stale, { recursive: true, force: true });
    }
    const before = await listBackups(dir, fs);
    const lastKnown = before[0]?.manifest?.replicateId || null;
    for (let attempt = 1; ; attempt++) {
      const ready = await waitForCleanPoint(io, { lastKnown });
      const pids = writerPids(ready.processes);
      const result = await withWritersPaused(
        pids,
        async () => {
          // An update that started between the check and the pause would be
          // copied half-applied: back off and wait again.
          const paused = await probe(io);
          if (updateRunning(paused.processes)) return { retry: true };
          return {
            done: await copyPaused(io, { dir, before, state: paused.state }),
          };
        },
        {
          kill: async (signal, list) => {
            const answer = await inContainer(
              io,
              `kill -${signal} ${list.join(' ')}`,
            );
            if (answer.code !== 0)
              throw new Error(
                `kill -${signal} failed: ${answer.stderr.trim()}`,
              );
          },
          signals: io.signals,
          exit: io.exit,
          log: io.log,
        },
      );
      if (result.done) {
        const removed = [];
        for (const old of backupsToRemove(await listBackups(dir, fs), keep)) {
          io.log(`removing an older backup: ${old.name}`);
          await fs.rm(old.path, { recursive: true, force: true });
          removed.push(old.name);
        }
        return { ...result.done, removed };
      }
      if (attempt >= attempts)
        throw new Error(
          `an update kept starting at the pause (${attempts} tries)`,
        );
      io.log('an update started just before the pause; waiting again');
    }
  } finally {
    await fs.rm(lock, { force: true });
  }
}

/** The copy itself, with the writers paused. */
async function copyPaused(io, { dir, before, state }) {
  const { fs } = io;
  const listed = await io.docker([
    'run',
    '--rm',
    '-v',
    `${VOLUME}:/src:ro`,
    '--entrypoint',
    'sh',
    IMAGE,
    '-c',
    FILES_PROBE,
  ]);
  if (listed.code !== 0)
    throw new Error(
      `cannot list the volume: ${listed.stderr.trim().slice(0, 160)}`,
    );
  const files = parseFiles(listed.stdout);
  const total = files.reduce((sum, f) => sum + f.size, 0);
  const free = await freeBytes(dir, fs);
  if (free !== null && free < total * SPACE_MARGIN)
    throw new Error(
      `${dir} has ${formatGb(free)} free; the copy needs ${formatGb(total * SPACE_MARGIN)}. ` +
        `Remove an older backup by hand (${before.map((b) => b.name).join(', ') || 'none here'}) or free space, then run again.`,
    );
  const name = backupName(
    new Date(io.now()),
    new Set([...(await fs.readdir(dir))]),
  );
  const partial = path.join(dir, `${name}${PARTIAL_SUFFIX}`);
  await fs.mkdir(partial, { recursive: true });
  io.log(
    `copying ${formatGb(total)} (${files.length} files, replicate_id ${state.replicateId}) to ${partial}`,
  );
  const started = io.now();
  let copied = 0;
  let lastSaid = started;
  const streamed = await io.stream(partial, (n) => {
    copied += n;
    if (io.now() - lastSaid >= PROGRESS_MS) {
      lastSaid = io.now();
      io.log(
        progressLine({ copied, total, seconds: (io.now() - started) / 1000 }),
      );
    }
  });
  if (streamed.code !== 0)
    throw new Error(
      `the copy failed (exit ${streamed.code}): ${String(streamed.stderr || '')
        .trim()
        .slice(0, 200)}; ${partial} is left for the next run to remove`,
    );
  const wrong = await verifyCopy(partial, files, fs);
  if (wrong.length)
    throw new Error(
      `${wrong.length} files differ from the volume (first: ${wrong[0].path}, ${wrong[0].found ?? 'missing'} of ${wrong[0].expected} bytes); ${partial} is left for the next run to remove`,
    );
  const seconds = (io.now() - started) / 1000;
  const manifest = {
    version: 1,
    complete: true,
    createdAt: new Date(started).toISOString(),
    replicateId: state.replicateId,
    dataTimestamp: state.dataTimestamp,
    sizeBytes: total,
    durationSeconds: Math.round(seconds),
    volume: VOLUME,
    image: IMAGE,
    files,
  };
  await fs.writeFile(
    path.join(partial, MANIFEST),
    `${JSON.stringify(manifest, null, 1)}\n`,
  );
  const final = path.join(dir, name);
  await fs.rename(partial, final);
  io.log(
    `backup complete: ${final}, ${formatGb(total)} in ${formatDuration(seconds)} (${(total / Math.max(1, seconds) / 1e6).toFixed(1)} MB/s)`,
  );
  return { name, path: final, manifest };
}

/** Every file under `dir` with its size, paths relative and with "/". */
export async function walkFiles(dir, fs, prefix = '') {
  const out = [];
  for (const name of (await fs.readdir(path.join(dir, prefix))).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = await fs.stat(path.join(dir, rel));
    if (st.isDirectory()) out.push(...(await walkFiles(dir, fs, rel)));
    else out.push({ path: rel, size: st.size });
  }
  return out;
}

/**
 * A copy made by hand (the first backup, before this script) becomes a
 * backup: its directory named like one, holding /db's replicate_id and
 * db/, gets a manifest from what is on disk, marked `adopted` (its sizes
 * were not checked against the volume at the time).
 */
export async function adoptBackup(dir, fs, now = Date.now()) {
  const name = path.basename(path.resolve(dir));
  if (!BACKUP_NAME.test(name))
    throw new Error(
      `${name} is not named like a backup (yyyymmdd or yyyymmdd-N)`,
    );
  const read = async (file) => {
    try {
      return String(await fs.readFile(path.join(dir, file), 'utf8')).trim();
    } catch {
      return '';
    }
  };
  const replicateId = Number(await read('replicate_id'));
  if (!Number.isSafeInteger(replicateId) || replicateId <= 0)
    throw new Error(`${dir} holds no replicate_id: not a copy of /db`);
  const files = (await walkFiles(dir, fs)).filter((f) => f.path !== MANIFEST);
  if (!files.some((f) => f.path.startsWith('db/')))
    throw new Error(`${dir} holds no db/: not a copy of /db`);
  const manifest = {
    version: 1,
    complete: true,
    adopted: true,
    createdAt: new Date(now).toISOString(),
    replicateId,
    dataTimestamp: (await read('db/osm_base_version')) || null,
    sizeBytes: files.reduce((sum, f) => sum + f.size, 0),
    durationSeconds: null,
    volume: VOLUME,
    image: IMAGE,
    files,
  };
  await fs.writeFile(
    path.join(dir, MANIFEST),
    `${JSON.stringify(manifest, null, 1)}\n`,
  );
  return manifest;
}

// ── The restore ─────────────────────────────────────────────────────────

/**
 * Whether the live database looks healthy enough that replacing it is the
 * wrong move: it answers, and its data is under `maxAgeHours` old.
 */
export function liveLooksHealthy({
  answering,
  dataTimestamp,
  now,
  maxAgeHours = 72,
}) {
  if (!answering) return false;
  const at = Date.parse(dataTimestamp || '');
  return Number.isFinite(at) && now - at < maxAgeHours * 3600_000;
}

/** The restore's plan, in the order it runs. */
export function restorePlan({ backup, freeOnTarget, liveBytes }) {
  const m = backup.manifest;
  return [
    `Restore ${backup.path}: replicate_id ${m.replicateId}, data as of ${m.dataTimestamp || '?'}, ${formatGb(m.sizeBytes)}, made ${m.createdAt}.`,
    `1. Stop and remove the container ${CONTAINER} (docker compose rm -sf in tools/overpass).`,
    `2. Delete the volume ${VOLUME}${liveBytes ? ` (${formatGb(liveBytes)} now)` : ''}: the live database is gone from here on.`,
    `3. Create ${VOLUME} again and stream the backup into it (room on the Docker drive: ${freeOnTarget === null ? 'unknown' : formatGb(freeOnTarget)} free, plus what step 2 frees inside Docker's disk image).`,
    `4. Start it (docker compose up -d), then watch replicate_id move past ${m.replicateId} as the updater catches up.`,
  ];
}

/**
 * The refusals, in order; the first that applies, or null.
 * @returns {string|null}
 */
export function restoreRefusal({
  backup,
  healthy,
  force,
  yes,
  freeOnTarget,
  liveBytes,
}) {
  if (!backup) return 'No such complete backup (a .partial is never one).';
  if (healthy && !force)
    return 'The live database answers and its data is fresh: replacing a healthy database is the wrong move. Add --force if you really mean to.';
  const need = backup.manifest.sizeBytes * SPACE_MARGIN;
  if (freeOnTarget !== null && freeOnTarget + (liveBytes || 0) < need)
    return `The Docker drive has ${formatGb(freeOnTarget)} free (plus ${formatGb(liveBytes || 0)} the old volume frees); the restore needs ${formatGb(need)}.`;
  if (!yes) return 'That is the plan. Run again with --yes to do it.';
  return null;
}

/**
 * @param {BackupIo & {compose: (args: string[]) => Promise<{code: number, stdout: string, stderr: string}>,
 *   unstream: (src: string, onBytes: Function) => Promise<{code: number, stderr: string}>,
 *   health: () => Promise<{answering: boolean, dataTimestamp: string|null}>,
 *   dockerDrive: string}} io
 */
export async function runRestore(
  io,
  {
    dir = DEFAULT_BACKUP_DIR,
    which,
    yes = false,
    force = false,
    catchUpMs = 60 * 60_000,
  } = {},
) {
  const backups = await listBackups(dir, io.fs);
  const backup =
    backups.find(
      (b) =>
        b.name === which ||
        b.path === which ||
        path.resolve(b.path) === path.resolve(String(which || '')),
    ) || (which === 'latest' ? backups[0] : null);
  const health = await io
    .health()
    .catch(() => ({ answering: false, dataTimestamp: null }));
  const healthy = liveLooksHealthy({ ...health, now: io.now() });
  const sized = await io
    .docker(['system', 'df', '-v', '--format', '{{json .Volumes}}'])
    .catch(() => null);
  const liveBytes = volumeBytes(sized?.stdout);
  const freeOnTarget = await freeBytes(io.dockerDrive, io.fs);
  if (backup)
    for (const line of restorePlan({ backup, freeOnTarget, liveBytes }))
      io.log(line);
  io.log(
    `The live database: ${health.answering ? `answering, data as of ${health.dataTimestamp || '?'}` : 'not answering'}${healthy ? ' (healthy)' : ''}.`,
  );
  const refusal = restoreRefusal({
    backup,
    healthy,
    force,
    yes,
    freeOnTarget,
    liveBytes,
  });
  if (refusal) return { done: false, refusal };
  const step = async (label, run) => {
    io.log(label);
    const answer = await run();
    if (answer.code !== 0)
      throw new Error(
        `${label} failed (exit ${answer.code}): ${String(answer.stderr || '')
          .trim()
          .slice(0, 200)}`,
      );
  };
  await step('stopping and removing the container', () =>
    io.compose(['rm', '-sf']),
  );
  await step(`deleting the volume ${VOLUME}`, () =>
    io.docker(['volume', 'rm', VOLUME]),
  );
  await step(`creating the volume ${VOLUME}`, () =>
    io.docker(['volume', 'create', VOLUME]),
  );
  const total = backup.manifest.sizeBytes;
  const started = io.now();
  let copied = 0;
  let lastSaid = started;
  await step('streaming the backup into the volume', () =>
    io.unstream(backup.path, (n) => {
      copied += n;
      if (io.now() - lastSaid >= PROGRESS_MS) {
        lastSaid = io.now();
        io.log(
          progressLine({ copied, total, seconds: (io.now() - started) / 1000 }),
        );
      }
    }),
  );
  await step('starting the container', () => io.compose(['up', '-d']));
  // The updater picks up from the backup's replicate_id.
  const from = backup.manifest.replicateId;
  const deadline = io.now() + catchUpMs;
  while (io.now() < deadline) {
    await io.sleep(POLL_MS);
    const state = await inContainer(io, STATE_PROBE).catch(() => null);
    const id = state?.code === 0 ? parseState(state.stdout).replicateId : null;
    if (id && id > from) {
      io.log(`catching up: replicate_id ${id}, past the backup's ${from}`);
      return { done: true, caughtUp: true, replicateId: id };
    }
  }
  io.log(
    `replicate_id has not moved past ${from} in ${formatDuration(catchUpMs / 1000)}; npm run overpass:status and docker logs ${CONTAINER} say why`,
  );
  return { done: true, caughtUp: false };
}

/** The gev-overpass-db volume's size from `docker system df -v`'s JSON, or null. */
export function volumeBytes(json) {
  try {
    const list = JSON.parse(String(json || '').trim());
    const entry = (Array.isArray(list) ? list : []).find(
      (v) => v.Name === VOLUME,
    );
    if (!entry?.Size) return null;
    const match = /^([\d.]+)\s*([KMGT]?)B$/i.exec(entry.Size.trim());
    if (!match) return null;
    const scale = { '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[
      match[2].toUpperCase()
    ];
    return Math.round(Number(match[1]) * scale);
  } catch {
    return null;
  }
}

// ── The real io ─────────────────────────────────────────────────────────

const SOCKETS_EXCLUDED =
  'cd /src && find . -type s > /tmp/sockets && tar -cf - --exclude-from=/tmp/sockets .';
const HOST_TAR =
  process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar';

function run(command, args, { cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) =>
      resolve({ code: 127, stdout, stderr: String(error.message) }),
    );
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** One process's stdout into another's stdin, counting the bytes. */
function pipe([fromCmd, fromArgs], [toCmd, toArgs], onBytes) {
  return new Promise((resolve) => {
    const from = spawn(fromCmd, fromArgs, { windowsHide: true });
    const to = spawn(toCmd, toArgs, { windowsHide: true });
    let stderr = '';
    from.stderr.on('data', (chunk) => (stderr += chunk));
    to.stderr.on('data', (chunk) => (stderr += chunk));
    from.stdout.on('data', (chunk) => onBytes(chunk.length));
    // A target that stops reading (a full disk) must not crash this.
    to.stdin.on('error', (error) => (stderr += String(error.message)));
    from.stdout.on('error', (error) => (stderr += String(error.message)));
    from.stdout.pipe(to.stdin);
    let codes = [];
    const done = (code) => {
      codes.push(code ?? 1);
      if (codes.length === 2)
        resolve({ code: codes.find((c) => c !== 0) ?? 0, stderr });
    };
    from.on('close', done);
    to.on('close', done);
    from.on('error', (error) => ((stderr += error.message), done(127)));
    to.on('error', (error) => ((stderr += error.message), done(127)));
  });
}

export function realIo({ composeDir, dockerDrive }) {
  const docker = (args) => run('docker', args);
  return {
    docker,
    compose: (args) => run('docker', ['compose', ...args], { cwd: composeDir }),
    stream: (dest, onBytes) =>
      pipe(
        [
          'docker',
          [
            'run',
            '--rm',
            '-v',
            `${VOLUME}:/src:ro`,
            '--entrypoint',
            'sh',
            IMAGE,
            '-c',
            SOCKETS_EXCLUDED,
          ],
        ],
        [HOST_TAR, ['-xf', '-', '-C', dest]],
        onBytes,
      ),
    unstream: (src, onBytes) =>
      pipe(
        [HOST_TAR, ['-cf', '-', '--exclude', MANIFEST, '-C', src, '.']],
        [
          'docker',
          [
            'run',
            '--rm',
            '-i',
            '-v',
            `${VOLUME}:/db`,
            '--entrypoint',
            'sh',
            IMAGE,
            '-c',
            'tar -xf - -C /db && chown -R overpass:overpass /db 2>/dev/null; true',
          ],
        ],
        onBytes,
      ),
    health: async () => {
      const response = await fetch('http://localhost:12345/api/interpreter', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'gods-eye-view/0.1 (overpass:restore)',
        },
        body: `data=${encodeURIComponent('[out:json][timeout:10];node(1);out ids;')}`,
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return { answering: false, dataTimestamp: null };
      const body = await response.json();
      return {
        answering: true,
        dataTimestamp: body?.osm3s?.timestamp_osm_base || null,
      };
    },
    fs: fsPromises,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.log(`${new Date().toISOString()} ${line}`),
    signals: process,
    exit: (code) => process.exit(code),
    dockerDrive,
  };
}

/** The command line: {command, which, options, flags}. */
export function parseArgs(argv) {
  const valued = new Set(['--dir', '--keep', '--docker-drive', '--adopt']);
  const options = {};
  const flags = new Set();
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (valued.has(arg)) options[arg.slice(2)] = argv[++i];
    else if (arg.startsWith('--')) flags.add(arg.slice(2));
    else rest.push(arg);
  }
  const command = rest[0] === 'restore' ? 'restore' : 'backup';
  return {
    command,
    which: command === 'restore' ? rest[1] : undefined,
    options,
    flags,
  };
}

async function main() {
  const { command, which, options, flags } = parseArgs(process.argv.slice(2));
  const dir =
    options.dir || process.env.OVERPASS_BACKUP_DIR || DEFAULT_BACKUP_DIR;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const io = realIo({
    composeDir: path.join(root, 'tools', 'overpass'),
    dockerDrive:
      options['docker-drive'] || process.env.OVERPASS_DOCKER_DRIVE || 'D:/',
  });
  try {
    if (command === 'restore') {
      const result = await runRestore(io, {
        dir,
        which,
        yes: flags.has('yes'),
        force: flags.has('force'),
      });
      if (!result.done) {
        io.log(result.refusal);
        process.exitCode = 1;
      }
    } else if (options.adopt) {
      const manifest = await adoptBackup(options.adopt, io.fs, io.now());
      io.log(
        `adopted ${options.adopt}: replicate_id ${manifest.replicateId}, ${formatGb(manifest.sizeBytes)}, ${manifest.files.length} files`,
      );
    } else {
      const keep = Number(options.keep ?? DEFAULT_KEEP);
      await runBackup(io, {
        dir,
        keep: Number.isInteger(keep) && keep >= 1 ? keep : DEFAULT_KEEP,
      });
    }
  } catch (error) {
    io.log(`failed: ${error?.message || error}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
