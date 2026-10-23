#!/usr/bin/env node
// Personal fork: `npm run overpass:status`, whether the local Overpass API
// (tools/overpass) answers, how old its data and areas are, and where the
// container and its import (or clone) stand, said plainly after a surprise
// restart. `npm run overpass:recover` (--recover) prints what to run for
// that state. Both only read: no compose command, nothing written. Not
// part of upstream God's Eye View.
//
//   npm run overpass:status [-- --url http://localhost:12345/api] [--json]
//   npm run overpass:recover
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const DEFAULT_URL = 'http://localhost:12345/api';
const USER_AGENT = 'gods-eye-view/0.1 (overpass:status)';
const CONTAINER = 'gev-overpass';

/** /api/status's text: {rateLimit, slotsFree, running} (null where missing). */
export function parseStatusText(text) {
  const value = (pattern) => {
    const match = pattern.exec(String(text || ''));
    return match ? Number(match[1]) : null;
  };
  const lines = String(text || '').split('\n');
  const head = lines.findIndex((line) =>
    line.startsWith('Currently running queries'),
  );
  return {
    rateLimit: value(/^Rate limit: (\d+)/m),
    slotsFree: value(/^(\d+) slots available now/m),
    running:
      head < 0
        ? null
        : lines.slice(head + 1).filter((line) => /^\d+\t/.test(line)).length,
  };
}

/** A timestamp's age in words ("3.2 days", "5 h", "12 min"), or null. */
export function describeAge(timestamp, now = Date.now()) {
  const at = Date.parse(timestamp);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.max(0, (now - at) / 60000);
  if (minutes < 90) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}

/**
 * What /db holds, read in the container with `sh -c`: its marker files, the
 * import's last progress line and last lines, the clone's last lines.
 */
export const DB_PROBE = [
  'cd /db 2>/dev/null || exit 0',
  'for f in init_done import_started clone-base-url; do [ -e "$f" ] && echo "file $f"; done',
  'grep "planet read" import.log 2>/dev/null | tail -n 1 | sed "s/^/progress /"',
  'tail -n 3 import.log 2>/dev/null | sed "s/^/import /"',
  'tail -n 2 clone.log 2>/dev/null | sed "s/^/clone /"',
  'true',
].join('; ');

/** DB_PROBE's output: {initDone, importStarted, cloneStarted, progress, importLines, cloneLines}. */
export function parseDbProbe(text) {
  const lines = String(text || '').split('\n');
  const after = (prefix) =>
    lines
      .filter((line) => line.startsWith(prefix))
      .map((line) => line.slice(prefix.length));
  const files = new Set(after('file '));
  return {
    initDone: files.has('init_done'),
    importStarted: files.has('import_started'),
    cloneStarted: files.has('clone-base-url'),
    progress: after('progress ').at(-1) || null,
    importLines: after('import '),
    cloneLines: after('clone '),
  };
}

const WIPE =
  'cd tools/overpass && docker compose down -v && docker compose up -d';

/**
 * The state after whatever happened (a surprise restart, say), in plain
 * words, with the steps that get out of it. The steps are printed, never
 * run.
 * @returns {{state: string, headline: string, steps: string[]}}
 */
export function classify({
  dockerUp = true,
  container,
  db,
  answering = false,
}) {
  if (!dockerUp)
    return {
      state: 'docker-down',
      headline: 'Docker is not running',
      steps: [
        'Start Docker Desktop. The container comes back with it (restart: unless-stopped).',
        'Then run npm run overpass:status again.',
      ],
    };
  if (!container)
    return {
      state: 'no-container',
      headline: `No container ${CONTAINER}`,
      steps: ['cd tools/overpass && docker compose up -d'],
    };
  if (container.state !== 'running')
    return {
      state: 'stopped',
      headline: `Container ${CONTAINER} is ${container.state}`,
      steps: [
        'cd tools/overpass && docker compose up -d',
        `If it stops again, docker logs --tail 30 ${CONTAINER} says why.`,
      ],
    };
  const progress = /planet read (\d+%); database (\S+)/.exec(
    db?.progress || '',
  );
  const where = progress ? ` at ${progress[1]} (database ${progress[2]})` : '';
  if (db?.importStarted && !db.initDone) {
    if (db.importLines.some((line) => /did not finish/.test(line)))
      return {
        state: 'import-cut-off',
        headline: `Import cut off${where}: the database is incomplete and cannot resume; it must be wiped and the import started again`,
        steps: [
          'This deletes the gev-overpass-db volume (the incomplete database), then starts a new import:',
          `  ${WIPE}`,
          'Or switch to the clone first, which resumes after a restart (tools/overpass/README.md, "Clone instead of import").',
        ],
      };
    return {
      state: 'importing',
      headline: `Import in progress${where}; it cannot resume, so a restart now means starting again`,
      steps: ['Nothing to do but keep the PC up.'],
    };
  }
  if (db?.cloneStarted && !db.initDone) {
    const last = db.cloneLines.at(-1) || '';
    const done = /downloaded (\d+%); (\d+) of (\d+) GB/.exec(
      db.cloneLines.filter((line) => /downloaded/.test(line)).at(-1) || '',
    );
    return {
      state: 'cloning',
      headline: `Clone in progress${done ? ` at ${done[1]} (${done[2]} of ${done[3]} GB)` : ''}; a restart resumes it`,
      steps: /Gave up/.test(last)
        ? [
            `It gave up on a file (${last.slice(0, 160)}); the container restarts and resumes by itself.`,
          ]
        : ['Nothing to do: a restart picks it up where it was.'],
    };
  }
  if (answering) return { state: 'serving', headline: 'Serving', steps: [] };
  if (db?.initDone)
    return {
      state: 'starting',
      headline:
        'The database is built; the server is not answering yet (starting up)',
      steps: [`Wait a minute; docker logs --tail 20 ${CONTAINER} shows it.`],
    };
  return {
    state: 'empty',
    headline: 'Running, with nothing in the database yet',
    steps: [`docker logs --tail 20 ${CONTAINER} says what it is doing.`],
  };
}

/** --recover's lines: the state, its steps, and that nothing was run. */
export function recoverLines(classified) {
  return [
    `State: ${classified.headline}.`,
    ...(classified.steps.length ? classified.steps : ['Nothing to do.']),
    'overpass:recover runs nothing: it only prints what to run.',
  ];
}

/** The report's lines from what was found. */
export function summarize({
  url,
  status,
  base,
  areas,
  areasPresent = false,
  container,
  lastLog,
  error,
  state,
  now = Date.now(),
}) {
  const lines = [];
  if (container)
    lines.push(
      `Container ${CONTAINER}: ${container.state}${container.health ? ` (${container.health})` : ''}`,
    );
  else
    lines.push(
      `Container ${CONTAINER}: not found (docker compose up -d in tools/overpass)`,
    );
  if (error) {
    lines.push(`Overpass at ${url}: not answering (${error})`);
  } else {
    const age = describeAge(base, now);
    lines.push(
      `Overpass at ${url}: answering; data as of ${base || '?'}${age ? ` (${age} old)` : ''}`,
    );
    const areaAge = describeAge(areas, now);
    lines.push(
      areas
        ? `  areas as of ${areas}${areaAge ? ` (${areaAge} old)` : ''}`
        : areasPresent
          ? '  areas: present (is_in answers; a clone without metadata keeps no areas date)'
          : '  areas: not built yet (is_in answers nothing until the first rules pass ends)',
    );
    if (status?.rateLimit !== null && status?.rateLimit !== undefined)
      lines.push(
        `  rate limit ${status.rateLimit}, ${status.slotsFree ?? '?'} slots free, ${status.running ?? 0} running`,
      );
  }
  if (lastLog) lines.push(`  last log: ${lastLog}`);
  if (state && state.state !== 'serving')
    lines.push(`State: ${state.headline}`);
  return lines;
}

function docker(args) {
  return new Promise((resolve) => {
    execFile('docker', args, { timeout: 10_000 }, (error, stdout, stderr) =>
      resolve(error ? null : `${stdout}${stderr}`.trim()),
    );
  });
}

async function ask(url, query) {
  const response = await fetch(`${url}/interpreter`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const args = process.argv.slice(2);
  const url = (
    args.includes('--url') ? args[args.indexOf('--url') + 1] : DEFAULT_URL
  ).replace(/\/+$/, '');
  const found = { url };
  const dockerUp = Boolean(
    await docker(['info', '--format', '{{.ServerVersion}}']),
  );
  const inspect = await docker([
    'inspect',
    '--format',
    '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}',
    CONTAINER,
  ]);
  if (inspect && !/Error|No such/.test(inspect)) {
    const [state, health] = inspect.split('|');
    found.container = { state, health: health || null };
    const log = await docker(['logs', '--tail', '1', CONTAINER]);
    if (log) found.lastLog = log.split('\n').at(-1).slice(0, 200);
    if (state === 'running')
      found.db = parseDbProbe(
        await docker(['exec', CONTAINER, 'sh', '-c', DB_PROBE]),
      );
  }
  try {
    const response = await fetch(`${url}/status`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    found.status = parseStatusText(await response.text());
    const node = await ask(url, '[out:json][timeout:10];node(1);out ids;');
    found.base = node?.osm3s?.timestamp_osm_base || null;
    // An is_in query reports the areas' date once they exist.
    const area = await ask(
      url,
      '[out:json][timeout:10];is_in(51.5,-0.12);out ids;',
    );
    found.areas = area?.osm3s?.timestamp_areas_base || null;
    // A clone without metadata never writes that date, so the answer itself
    // is the proof: London lies in several administrative areas.
    found.areasPresent =
      Boolean(found.areas) ||
      (Array.isArray(area?.elements) && area.elements.length > 0);
  } catch (error) {
    found.error = error?.cause?.code || error?.message || String(error);
  }
  found.state = classify({
    dockerUp,
    container: found.container,
    db: found.db,
    answering: !found.error,
  });
  if (args.includes('--recover'))
    for (const line of recoverLines(found.state)) console.log(line);
  else if (args.includes('--json')) console.log(JSON.stringify(found, null, 2));
  else for (const line of summarize(found)) console.log(line);
  if (found.error) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
