#!/usr/bin/env node
// Personal fork: `npm run overpass:status`, whether the local Overpass API
// (tools/overpass) answers, how old its data and areas are, and where the
// container and its import stand. Read-only. Not part of upstream God's Eye
// View.
//
//   npm run overpass:status [-- --url http://localhost:12345/api] [--json]
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

/** The report's lines from what was found. */
export function summarize({
  url,
  status,
  base,
  areas,
  container,
  lastLog,
  error,
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
        : '  areas: not built yet (is_in answers nothing until the first rules pass ends)',
    );
    if (status?.rateLimit !== null && status?.rateLimit !== undefined)
      lines.push(
        `  rate limit ${status.rateLimit}, ${status.slotsFree ?? '?'} slots free, ${status.running ?? 0} running`,
      );
  }
  if (lastLog) lines.push(`  last log: ${lastLog}`);
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
  } catch (error) {
    found.error = error?.cause?.code || error?.message || String(error);
  }
  if (args.includes('--json')) console.log(JSON.stringify(found, null, 2));
  else for (const line of summarize(found)) console.log(line);
  if (found.error) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
