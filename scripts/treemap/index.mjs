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
import {
  POLITIES_TABLE_VERSION,
  buildPolitiesTable,
  readWorldHistory,
} from './polities.mjs';
import { worldHistoryCacheDir } from '../../server/providers/worldHistory/sources.js';
import { coverageGridFile } from '../../server/providers/wikipediaCoverage.js';
import {
  LABELLER_VERSION,
  createLabeller,
  openStoredLabeller,
  storeLabels,
} from '../../server/providers/treemap/labeller.js';
import {
  WIKIPEDIA_TABLE_VERSION,
  buildWikipediaTables,
  readWikipediaPoints,
} from './wikipedia.mjs';
import {
  PLACES_TABLE_VERSION,
  buildPlacesTable,
  readPlacesIndex,
} from './places.mjs';
import {
  BUILDINGS_TABLE_VERSION,
  buildBuildingsTables,
  readBuildingsIndex,
} from './buildings.mjs';
import { overtureCacheDir } from '../../server/providers/overture/sources.js';
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
 * index), people (count/people), polities (m2/polity-area).
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
export const TREEMAP_STEPS = Object.freeze([
  'areas',
  'labels',
  'people',
  'polities',
  'wikipedia',
  'places',
  'buildings',
]);

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

  /**
   * A step's tables from its inputs: skipped when every one is current,
   * else built by `make()` ({tables: {variable: table}, stats}) and
   * published.
   */
  async function tableStep(step, variables, inputs, make) {
    if (!wants(step)) return;
    const signature = signatureOf({ variables, ...inputs });
    const manifest = readManifest(dir);
    if (
      !force &&
      variables.every((variable) =>
        isCurrent(dir, manifest.tables[variable], signature),
      )
    ) {
      log(`${step}: current`);
      return;
    }
    const started = performance.now();
    const { tables, stats } = await make();
    const seconds = (performance.now() - started) / 1000;
    const empty = variables.filter((variable) => !tables[variable].rows.length);
    if (empty.length) {
      log(`${step}: no rows for ${empty.join(', ')}; nothing published`);
      return;
    }
    let bytes = 0;
    for (const variable of variables) {
      const table = tables[variable];
      table.signature = signature;
      const entry = publish(dir, {
        section: 'tables',
        name: variable,
        json: table,
        signature,
        seconds,
        extra: { rows: table.rows.length / (table.dims.length + 2), inputs },
      });
      bytes += entry.bytes;
      done[step] = entry;
    }
    log(
      `${step}: ${JSON.stringify(stats)}, ${seconds.toFixed(1)} s, ${(bytes / 1e6).toFixed(2)} MB`,
    );
  }

  // The stored labelling (table 2): every land tile drawn once, read by
  // the steps below and by the server's /label.
  const labelsSignature = signatureOf({
    labels: LABELLER_VERSION,
    areas: areasId,
  });
  const labelsCurrent = () =>
    isCurrent(dir, readManifest(dir).files.labels, labelsSignature);
  if (wants('labels') && (force || !labelsCurrent())) {
    const started = performance.now();
    const drawing = createLabeller({ areasDir });
    const { index, bytes } = storeLabels(drawing, log);
    drawing.close();
    const seconds = (performance.now() - started) / 1000;
    done.labels = publish(dir, {
      section: 'files',
      name: 'labels',
      json: index,
      signature: labelsSignature,
      seconds,
      binary: bytes,
      extra: {
        tiles: Object.keys(index.tiles).length,
        inputs: { areas: areasId },
      },
    });
    log(
      `labels: ${done.labels.tiles} tiles, ${seconds.toFixed(1)} s, ${(bytes.length / 1e6).toFixed(2)} MB`,
    );
  } else if (wants('labels')) log('labels: current');

  let labeller = null;
  const labellerOf = () => {
    if (labeller) return labeller;
    const entry = readManifest(dir).files.labels;
    if (labelsCurrent()) {
      labeller = openStoredLabeller({
        index: JSON.parse(fs.readFileSync(path.join(dir, entry.file), 'utf8')),
        file: path.join(dir, entry.data),
      });
      labeller.units = areas.units;
    } else labeller = createLabeller({ areasDir });
    return labeller;
  };

  if (wants('polities')) {
    const historyDir = worldHistoryCacheDir(env, root);
    let history = null;
    try {
      history = readWorldHistory(historyDir);
    } catch {
      log('polities: no World history index (npm run world-history:build)');
    }
    if (history)
      await tableStep(
        'polities',
        ['m2/polity-area'],
        { v: POLITIES_TABLE_VERSION, history: history.id },
        () => {
          const { table, stats } = buildPolitiesTable({ index: history.index });
          return { tables: { 'm2/polity-area': table }, stats };
        },
      );
  }

  if (wants('wikipedia')) {
    const points = readWikipediaPoints(
      path.join(path.dirname(coverageGridFile(env, root)), 'points'),
    );
    if (!points)
      log(
        'wikipedia: no Wikipedia points index (npm run wikipedia:build -- --points)',
      );
    else
      await tableStep(
        'wikipedia',
        ['count/wikipedia-articles', 'byte/wikipedia-text'],
        {
          v: WIKIPEDIA_TABLE_VERSION,
          labels: LABELLER_VERSION,
          areas: areasId,
          points: points.manifest.version,
        },
        () => {
          const { articles, text, stats } = buildWikipediaTables({
            points,
            labeller: labellerOf(),
            log,
          });
          return {
            tables: {
              'count/wikipedia-articles': articles,
              'byte/wikipedia-text': text,
            },
            stats,
          };
        },
      );
  }
  if (wants('places')) {
    const places = readPlacesIndex(
      path.join(overtureCacheDir(env, root), 'places'),
    );
    if (!places)
      log(
        'places: no Overture places index (npm run overture:build -- --places)',
      );
    else
      await tableStep(
        'places',
        ['count/places'],
        {
          v: PLACES_TABLE_VERSION,
          labels: LABELLER_VERSION,
          areas: areasId,
          places: places.manifest.version,
        },
        () => {
          const { table, stats } = buildPlacesTable({
            places,
            labeller: labellerOf(),
            log,
          });
          return { tables: { 'count/places': table }, stats };
        },
      );
  }
  if (wants('buildings')) {
    const buildings = readBuildingsIndex(
      path.join(overtureCacheDir(env, root), 'buildings'),
    );
    if (!buildings)
      log(
        'buildings: no Overture buildings build (npm run overture:build -- --buildings)',
      );
    else
      await tableStep(
        'buildings',
        ['count/buildings', 'm2/building-footprint', 'm3/building-volume'],
        {
          v: BUILDINGS_TABLE_VERSION,
          labels: LABELLER_VERSION,
          areas: areasId,
          buildings: buildings.manifest.version,
        },
        () => {
          const { count, footprint, volume, stats } = buildBuildingsTables({
            buildings,
            labeller: labellerOf(),
            log,
          });
          return {
            tables: {
              'count/buildings': count,
              'm2/building-footprint': footprint,
              'm3/building-volume': volume,
            },
            stats,
          };
        },
      );
  }
  labeller?.close();
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
