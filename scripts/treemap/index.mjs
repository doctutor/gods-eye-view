import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  overtureAreasDir,
  overtureLocalitiesDir,
  treemapDir,
} from '../../server/providers/treemap/sources.js';
import {
  AREAS_TABLE_VERSION,
  buildAreasTable,
  readAreasBuild,
} from './areas.mjs';
import { PEOPLE_TABLE_VERSION, buildPeopleTable } from './people.mjs';
import { isCurrent, publish, readManifest, signatureOf } from './store.mjs';

/**
 * The treemap navigator's tables (docs/TREEMAP-PLAN.md):
 *
 *   node scripts/treemap/index.mjs build [--root DIR] [--only a,b] [--force]
 *   node scripts/treemap/index.mjs status [--root DIR] [--json]
 *
 * `--root` is the checkout whose .gev-cache holds the stores (default this
 * one); the tables go to TREEMAP_DIR, else <root>/.gev-cache/treemap. A
 * table is rebuilt only when its inputs' builds or its rules changed
 * (--force rebuilds all). Tables: areas (m2/surface-area and the outline
 * index), people (count/people).
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
export const TREEMAP_STEPS = Object.freeze(['areas', 'people']);

export function parseArgs(argv) {
  const flags = { command: argv[0] || 'status', only: null };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') flags.root = argv[++i];
    else if (arg === '--only') flags.only = String(argv[++i] || '').split(',');
    else if (arg === '--force') flags.force = true;
    else if (arg === '--json') flags.json = true;
    else throw new Error(`unknown option ${arg}`);
  }
  if (!['build', 'status'].includes(flags.command))
    throw new Error(`unknown command ${flags.command} (build or status)`);
  for (const step of flags.only || [])
    if (!TREEMAP_STEPS.includes(step))
      throw new Error(`unknown step ${step} (${TREEMAP_STEPS.join(', ')})`);
  return flags;
}

/**
 * Build the tables that are out of date.
 * @param {{root: string, env?: object, only?: string[]|null, force?: boolean,
 *   log?: (line: string) => void}} options
 */
export async function buildTreemap({
  root,
  env = process.env,
  only = null,
  force = false,
  log = () => {},
}) {
  const dir = treemapDir(env, root);
  fs.mkdirSync(dir, { recursive: true });
  const wants = (step) => !only || only.includes(step);
  const areasDir = overtureAreasDir(env, root);
  const areas = readAreasBuild(areasDir);
  const areasId = areas.manifest.buildId;
  const done = {};

  if (wants('areas')) {
    const manifest = readManifest(dir);
    const signature = signatureOf({ v: AREAS_TABLE_VERSION, areas: areasId });
    if (
      !force &&
      isCurrent(dir, manifest.tables['m2/surface-area'], signature) &&
      isCurrent(dir, manifest.files.outlines, signature)
    )
      log('areas: current');
    else {
      const started = performance.now();
      log(`areas: from ${areasDir} (build ${areasId})`);
      const { table, outlines, stats } = buildAreasTable({ areasDir, log });
      const seconds = (performance.now() - started) / 1000;
      table.signature = signature;
      done.areas = publish(dir, {
        section: 'tables',
        name: 'm2/surface-area',
        json: table,
        signature,
        seconds,
        extra: { rows: stats.rows, inputs: { areas: areasId } },
      });
      publish(dir, {
        section: 'files',
        name: 'outlines',
        json: outlines,
        signature,
        seconds: 0,
        extra: { units: Object.keys(outlines.units).length },
      });
      log(
        `areas: ${stats.units} units, ${(stats.points / 1e6).toFixed(1)} M points, ${stats.rows} rows, land ${(stats.land / 1e6).toFixed(0)} km², ${seconds.toFixed(1)} s, ${(done.areas.bytes / 1e6).toFixed(2)} MB`,
      );
    }
  }

  if (wants('people')) {
    const localitiesDir = overtureLocalitiesDir(env, root);
    if (!localitiesDir)
      log('people: no Overture localities build (npm run overture:build)');
    else {
      const manifest = readManifest(dir);
      const localitiesId = path.basename(localitiesDir);
      const signature = signatureOf({
        v: PEOPLE_TABLE_VERSION,
        areas: areasId,
        localities: localitiesId,
      });
      if (!force && isCurrent(dir, manifest.tables['count/people'], signature))
        log('people: current');
      else {
        const started = performance.now();
        log(`people: from ${localitiesDir}`);
        const { table, stats } = buildPeopleTable({
          localitiesDir,
          units: areas.units,
          log,
        });
        const seconds = (performance.now() - started) / 1000;
        table.signature = signature;
        done.people = publish(dir, {
          section: 'tables',
          name: 'count/people',
          json: table,
          signature,
          seconds,
          extra: {
            rows: stats.rows,
            inputs: { areas: areasId, localities: localitiesId },
          },
        });
        log(
          `people: ${stats.settlements} settlements, ${stats.rows} rows, ${seconds.toFixed(1)} s, ${(done.people.bytes / 1e6).toFixed(2)} MB`,
        );
      }
    }
  }
  return { dir, done };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const root = flags.root ? path.resolve(flags.root) : ROOT;
  if (flags.command === 'build') {
    await buildTreemap({
      root,
      only: flags.only,
      force: Boolean(flags.force),
      log: (line) => console.log(line),
    });
    return;
  }
  const dir = treemapDir(process.env, root);
  const manifest = readManifest(dir);
  if (flags.json) {
    console.log(JSON.stringify({ dir, ...manifest }, null, 2));
    return;
  }
  console.log(`Treemap tables: ${dir}`);
  const entries = Object.entries(manifest.tables);
  if (!entries.length) console.log('  none built (npm run treemap:build)');
  for (const [variable, entry] of entries)
    console.log(
      `  ${variable}: ${entry.rows} rows, ${(entry.bytes / 1e6).toFixed(2)} MB, ${entry.seconds} s, ${entry.builtAt}`,
    );
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href)
  main().catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
