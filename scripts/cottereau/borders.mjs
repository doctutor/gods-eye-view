#!/usr/bin/env node
/**
 * Cottereau's drawn borders as polygons, for a PRIVATE comparison layer
 * beside Cliopatria (personal use only).
 *
 *   node scripts/cottereau/borders.mjs extract [--out DIR] [--samples 0,10,20 | --every N]
 *                                              [--workers N] [--force]
 *   node scripts/cottereau/borders.mjs status  [--out DIR]
 *
 * PRIVACY: the geometry is extracted from Cottereau's copyrighted video. It
 * is written only under --out (default COTTEREAU_BORDERS_DIR, else
 * E:\gev-data\cottereau\borders), which must lie outside the repository:
 * it is never committed, never published. Frames are decoded in memory by
 * extractBorders.py and never written.
 *
 * A build is keyed by its inputs (the extractor's code, the framings, the
 * matches, the labels file): builds/<key>.partial/ while it runs, each
 * sample written whole as it is done, so a stopped run resumes where it
 * was; then the manifest (counts, per-framing pixel size, the quality
 * report), the partial directory renamed builds/<key>/, and current.json
 * switched to it in one rename ("Builds and restarts"). A subset of samples
 * (--samples, --every: a trial) is finalised as an incomplete build.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { loadCliopatria } from './cliopatria.mjs';
import { framingAt } from './framings.mjs';
import { readFrames, isLabel } from './labels.mjs';
import { computeTracks } from './index.mjs';
import { sampleForYear } from '../../server/providers/cottereauBorders.js';

export { sampleForYear };

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
export const BORDERS_FORMAT = 1;
const DEFAULTS = {
  out: process.env.COTTEREAU_BORDERS_DIR || 'E:/gev-data/cottereau/borders',
  labels: 'E:/gev-data/cottereau/labels-1fps.jsonl',
  video: 'E:/gev-data/cottereau/raw/hzWwp9JM7Hw.313.webm',
  cliopatria: 'E:/gev-data/cliopatria/raw/cliopatria-v0.2.1.geojson.zip',
  python:
    process.env.COTTEREAU_PYTHON ||
    'D:/gev-tools/cottereau-venv/Scripts/python.exe',
};

/** Whether a directory lies inside the repository (where the geometry must never go). */
export function insideRepository(dir, root = ROOT) {
  const relative = path.relative(path.resolve(root), path.resolve(dir));
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Each sample's span: the years it stands for, to the next sample's year less one. */
export function withSpans(samples, lastYear) {
  return samples.map((s, i) => ({
    ...s,
    untilYear:
      i + 1 < samples.length
        ? Math.max(s.year, samples[i + 1].year - 1)
        : lastYear,
  }));
}

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

function buildKey({ labels, framingsText, matchesText }) {
  const stat = fs.statSync(labels);
  const code = ['extractBorders.py', 'fitFraming.py']
    .map((f) =>
      fs.readFileSync(path.join(ROOT, 'scripts/cottereau', f), 'utf8'),
    )
    .join('\n');
  return sha(
    JSON.stringify({
      format: BORDERS_FORMAT,
      code: sha(code),
      framings: sha(framingsText),
      matches: sha(matchesText),
      labels: [stat.size, stat.mtimeMs],
    }),
  ).slice(0, 12);
}

function writeAtomic(file, data) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, data);
  fs.renameSync(temporary, file);
}

/**
 * The samples' file for the extractor: per sample its time, year, framing,
 * OCR boxes (for the text mask) and labels with their track and that
 * year's Cliopatria name (matches.json periods).
 */
export function samplesFile({ frames, framings, tracks, matches }) {
  const byTrack = new Map(matches.map((m) => [m.track, m]));
  const keptIds = new Set(matches.map((m) => m.track));
  const labelsAt = new Map(); // t -> [{text, x, y, w, h, track}]
  for (const track of tracks) {
    if (!keptIds.has(track.id)) continue;
    for (const p of track.points) {
      if (!labelsAt.has(p.t)) labelsAt.set(p.t, []);
      const match = byTrack.get(track.id);
      const period = (match?.periods || []).find(
        (q) =>
          q.name && q.reason !== 'none' && q.from <= p.year && q.to >= p.year,
      );
      labelsAt.get(p.t).push({
        text: p.text,
        x: Math.round(p.x),
        y: Math.round(p.y),
        w: Math.round(p.w),
        h: Math.round(p.h),
        track: track.id,
        cliopatria: period?.name || null,
        wikidata: period?.wikidata || null,
      });
    }
  }
  return {
    format: BORDERS_FORMAT,
    framings: framings.map(({ id, sx, tx, sy, ty }) => ({
      id,
      sx,
      tx,
      sy,
      ty,
    })),
    samples: frames.map((frame, index) => ({
      index,
      t: frame.t,
      year: frame.year,
      framing: framingAt(framings, frame.t).id,
      boxes: frame.boxes.filter(isLabel).map((b) => [b.cx, b.cy, b.w, b.h]),
      labels: labelsAt.get(frame.t) || [],
    })),
  };
}

/** The Cliopatria polygons of the names matched, for the extractor's comparison. */
async function writeCliopatria(dir, names, zip) {
  const records = (await loadCliopatria(zip)).filter((r) => names.has(r.name));
  let total = 0;
  for (const r of records) total += r.coords.length;
  const coords = new Float64Array(total);
  const index = [];
  let at = 0;
  for (const r of records) {
    coords.set(r.coords, at);
    const base = at / 2;
    const polygons = [];
    for (let p = 0; p < r.polygons.length; p++) {
      const first = r.polygons[p];
      const last =
        p + 1 < r.polygons.length ? r.polygons[p + 1] : r.rings.length - 1;
      const rings = [];
      for (let k = first; k < last; k++)
        rings.push([base + r.rings[k], base + r.rings[k + 1]]);
      polygons.push(rings);
    }
    index.push({
      name: r.name,
      from: r.from,
      to: r.to,
      wikidata: r.wikidata,
      box: [r.box.west, r.box.south, r.box.east, r.box.north],
      polygons,
    });
    at += r.coords.length;
  }
  writeAtomic(path.join(dir, 'cliopatria.f64'), Buffer.from(coords.buffer));
  writeAtomic(
    path.join(dir, 'cliopatria.json'),
    JSON.stringify({ records: index }),
  );
  return records.length;
}

/** One extractor process per worker, each running its spans one after another (memory is tight). */
function runExtractor({ python, partial, video, groups }) {
  return Promise.all(
    groups.map(async (spans) => {
      for (const span of spans) await runSpan({ python, partial, video, span });
    }),
  );
}

function runSpan({ python, partial, video, span: [first, last] }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      python,
      [
        '-I',
        path.join(ROOT, 'scripts/cottereau/extractBorders.py'),
        partial,
        video,
        `${first}-${last}`,
      ],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`extractor ${first}-${last} exited ${code}`)),
    );
  });
}

const centuryOf = (year) =>
  year < 0 ? -Math.ceil(-year / 100) : Math.floor(year / 100) + 1;
const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : null;
};

/** The manifest's quality report from the samples written. */
export function qualityReport(results) {
  const centuries = new Map();
  const unlabelled = [];
  const merged = [];
  const ious = [];
  for (const r of results) {
    const c = centuryOf(r.year);
    const entry = centuries.get(c) || {
      century: c,
      samples: 0,
      landPx: 0,
      claimedPx: 0,
      labelledPx: 0,
      ious: [],
    };
    entry.samples += 1;
    entry.landPx += r.stats.landPx;
    entry.claimedPx += r.stats.landPx - r.stats.unclaimedPx;
    entry.labelledPx += r.stats.labelledPx;
    centuries.set(c, entry);
    for (const u of r.unlabelled)
      unlabelled.push({
        year: r.year,
        colour: u.colour,
        areaKm2: u.areaKm2,
        lon: u.lon,
        lat: u.lat,
      });
    for (const p of r.polygons) {
      if (p.flags.includes('split') || p.flags.includes('joined'))
        merged.push({
          year: r.year,
          track: p.track,
          label: p.label,
          flags: p.flags,
          regions: p.regions,
        });
      if (typeof p.iou === 'number') {
        ious.push({
          year: r.year,
          track: p.track,
          label: p.label,
          cliopatria: p.cliopatria,
          iou: p.iou,
          areaKm2: p.areaKm2,
        });
        entry.ious.push(p.iou);
        entry.iouArea = (entry.iouArea || 0) + p.iou * p.areaKm2;
        entry.iouWeight = (entry.iouWeight || 0) + p.areaKm2;
      }
    }
  }
  const perCentury = [...centuries.values()]
    .sort((a, b) => a.century - b.century)
    .map(({ ious: list, iouArea = 0, iouWeight = 0, ...e }) => ({
      ...e,
      // By area: a large polity counts for more than a city state.
      iouByArea: iouWeight
        ? Math.round((1000 * iouArea) / iouWeight) / 1000
        : null,
      labelledOfLand: e.landPx
        ? Math.round((1000 * e.labelledPx) / e.landPx) / 1000
        : null,
      labelledOfClaimed: e.claimedPx
        ? Math.round((1000 * e.labelledPx) / e.claimedPx) / 1000
        : null,
      iou: {
        n: list.length,
        median: median(list),
        mean: list.length
          ? Math.round((1000 * list.reduce((s, v) => s + v, 0)) / list.length) /
            1000
          : null,
      },
    }));
  return {
    perCentury,
    unlabelled: {
      count: unlabelled.length,
      largest: unlabelled.sort((a, b) => b.areaKm2 - a.areaKm2).slice(0, 40),
    },
    merged: {
      count: merged.length,
      split: merged.filter((m) => m.flags.includes('split')).length,
      joined: merged.filter((m) => m.flags.includes('joined')).length,
      cases: merged.slice(0, 200),
    },
    iou: {
      count: ious.length,
      median: median(ious.map((i) => i.iou)),
      byArea: (() => {
        const weight = ious.reduce((sum, i) => sum + i.areaKm2, 0);
        return weight
          ? Math.round(
              (1000 * ious.reduce((sum, i) => sum + i.iou * i.areaKm2, 0)) /
                weight,
            ) / 1000
          : null;
      })(),
      worst: [...ious]
        .sort((a, b) => a.iou - b.iou || b.areaKm2 - a.areaKm2)
        .filter((i) => i.areaKm2 > 0)
        .slice(0, 20),
    },
  };
}

function readSample(file) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
}

async function extract(options) {
  const out = path.resolve(options.out);
  if (insideRepository(out))
    throw new Error(
      `--out ${out} is inside the repository: the borders are private and never go there`,
    );
  const framingsText = fs.readFileSync(
    path.join(ROOT, 'data/cottereau/framings.json'),
    'utf8',
  );
  const matchesText = fs.readFileSync(
    path.join(ROOT, 'data/cottereau/matches.json'),
    'utf8',
  );
  const key = buildKey({ labels: options.labels, framingsText, matchesText });
  const builds = path.join(out, 'builds');
  const finished = path.join(builds, key);
  const partial = `${finished}.partial`;
  if (fs.existsSync(finished) && !options.force && !options.samples) {
    console.log(`[borders] build ${key} is done: ${finished}`);
    return switchTo(out, key);
  }
  fs.mkdirSync(path.join(partial, 'samples'), { recursive: true });
  const prepared = path.join(partial, 'samples.json');
  if (!fs.existsSync(prepared)) {
    console.log('[borders] tracking the labels…');
    const frames = readFrames(options.labels);
    const { framings } = JSON.parse(framingsText);
    const { matches } = JSON.parse(matchesText);
    const tracks = computeTracks(frames, framings);
    const file = samplesFile({ frames, framings, tracks, matches });
    const names = new Set();
    for (const m of matches)
      for (const p of m.periods || []) if (p.name) names.add(p.name);
    console.log('[borders] the matched Cliopatria polygons…');
    const count = await writeCliopatria(partial, names, options.cliopatria);
    console.log(
      `[borders] ${file.samples.length} samples, ${count} Cliopatria records`,
    );
    writeAtomic(prepared, JSON.stringify(file));
  }
  const { samples } = JSON.parse(fs.readFileSync(prepared, 'utf8'));
  const wanted = options.samples
    ? options.samples.filter((i) => i >= 0 && i < samples.length)
    : samples.map((s) => s.index);
  const done = (i) =>
    fs.existsSync(
      path.join(partial, 'samples', `${String(i).padStart(4, '0')}.json.gz`),
    );
  const todo = wanted.filter((i) => !done(i));
  console.log(
    `[borders] build ${key}: ${wanted.length - todo.length} of ${wanted.length} samples done, ${todo.length} to go`,
  );
  if (todo.length) {
    // Contiguous spans of the samples to do, shared among the workers.
    const workers = Math.max(1, Math.min(options.workers, todo.length));
    const per = Math.ceil(todo.length / workers);
    const groups = [];
    for (let w = 0; w < workers; w++)
      groups.push(todo.slice(w * per, (w + 1) * per));
    // Each worker's samples as contiguous spans.
    const spansOf = (group) => {
      const spans = [];
      let start = null;
      let prev = null;
      for (const i of group) {
        if (start === null) start = i;
        else if (i !== prev + 1) {
          spans.push([start, prev]);
          start = i;
        }
        prev = i;
      }
      if (start !== null) spans.push([start, prev]);
      return spans;
    };
    const started = Date.now();
    await runExtractor({
      python: options.python,
      partial,
      video: options.video,
      groups: groups.filter((g) => g.length).map(spansOf),
    });
    console.log(
      `[borders] ${todo.length} samples in ${((Date.now() - started) / 1000).toFixed(0)} s`,
    );
  }
  // The manifest from every sample written.
  const present = samples.filter((s) => done(s.index));
  const results = present.map((s) =>
    readSample(
      path.join(
        partial,
        'samples',
        `${String(s.index).padStart(4, '0')}.json.gz`,
      ),
    ),
  );
  const { framings } = JSON.parse(framingsText);
  const manifest = {
    format: BORDERS_FORMAT,
    buildId: key,
    builtAt: new Date().toISOString(),
    complete: present.length === samples.length,
    private:
      'Extracted from Cottereau\'s "History of the World: Every Year" for personal use only. Never commit or publish.',
    samples: withSpans(
      results.map((r) => ({
        index: r.index,
        t: r.t,
        year: r.year,
        framing: r.framing,
        file: `samples/${String(r.index).padStart(4, '0')}.json.gz`,
        polities: r.polygons.length,
        unlabelled: r.unlabelled.length,
        seconds: r.seconds,
      })),
      results.at(-1)?.year ?? null,
    ),
    framings: framings.map((f) => ({
      id: f.id,
      fromYear: f.fromYear,
      toYear: f.toYear,
      // A pixel's width at the equator, km.
      pixelKmAtEquator: Math.round((6371 / f.sx) * 100) / 100,
    })),
    counts: {
      samples: results.length,
      polities: results.reduce((s, r) => s + r.polygons.length, 0),
      unlabelled: results.reduce((s, r) => s + r.unlabelled.length, 0),
      secondsPerSample: median(results.map((r) => r.seconds)),
    },
    quality: qualityReport(results),
  };
  writeAtomic(
    path.join(partial, 'manifest.json'),
    JSON.stringify(manifest, null, 1),
  );
  if (fs.existsSync(finished))
    fs.rmSync(finished, { recursive: true, force: true });
  if (manifest.complete || options.samples) {
    fs.cpSync(partial, finished, { recursive: true });
    if (manifest.complete) fs.rmSync(partial, { recursive: true, force: true });
    switchTo(out, key);
  }
  printReport(manifest);
}

/** current.json to a build, in one rename; older builds go. */
function switchTo(out, key) {
  writeAtomic(path.join(out, 'current.json'), JSON.stringify({ build: key }));
  for (const name of fs.readdirSync(path.join(out, 'builds')))
    if (name !== key && !name.endsWith('.partial'))
      fs.rmSync(path.join(out, 'builds', name), {
        recursive: true,
        force: true,
      });
  console.log(`[borders] current build: ${key}`);
}

export function printReport(manifest, log = console.log) {
  const q = manifest.quality;
  log(
    `[borders] ${manifest.counts.samples} samples (${manifest.complete ? 'complete' : 'a trial'}), ${manifest.counts.polities} polity polygons, ${manifest.counts.unlabelled} unlabelled regions, ${manifest.counts.secondsPerSample} s a sample`,
  );
  for (const c of q.perCentury)
    log(
      `  ${c.century < 0 ? `${-c.century} c. BC` : `${c.century} c.`}: ${c.samples} samples, labelled ${(100 * c.labelledOfClaimed).toFixed(1)}% of claimed land (${(100 * c.labelledOfLand).toFixed(1)}% of all land), IoU with Cliopatria median ${c.iou.median ?? '—'}, by area ${c.iouByArea ?? '—'} (${c.iou.n})`,
    );
  log(
    `  merged or split: ${q.merged.count} (split ${q.merged.split}, joined ${q.merged.joined}); unlabelled regions ${q.unlabelled.count}; IoU median ${q.iou.median}, by area ${q.iou.byArea}, over ${q.iou.count}`,
  );
  log('  largest disagreements with Cliopatria:');
  for (const w of q.iou.worst.slice(0, 20))
    log(
      `    ${w.year} ${w.label} ↔ ${w.cliopatria}: IoU ${w.iou}, ${Math.round(w.areaKm2).toLocaleString('en-US')} km²`,
    );
}

function status(options) {
  const out = path.resolve(options.out);
  let current = null;
  try {
    current = JSON.parse(
      fs.readFileSync(path.join(out, 'current.json'), 'utf8'),
    ).build;
  } catch {
    console.log(`[borders] no build in ${out}`);
  }
  if (current) {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(out, 'builds', current, 'manifest.json'),
        'utf8',
      ),
    );
    console.log(
      `[borders] current build ${current}, built ${manifest.builtAt}`,
    );
    printReport(manifest);
  }
  for (const name of fs.existsSync(path.join(out, 'builds'))
    ? fs.readdirSync(path.join(out, 'builds'))
    : [])
    if (name.endsWith('.partial')) {
      const n = fs
        .readdirSync(path.join(out, 'builds', name, 'samples'))
        .filter((f) => f.endsWith('.json.gz')).length;
      console.log(`[borders] in progress: ${name} (${n} samples written)`);
    }
}

function parseArgs(argv) {
  const [command = 'status', ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++)
    if (rest[i].startsWith('--'))
      flags[rest[i].slice(2)] =
        rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  return { command, flags };
}

async function main(argv) {
  const { command, flags } = parseArgs(argv);
  const options = {
    ...DEFAULTS,
    out: flags.out || DEFAULTS.out,
    labels: flags.labels || DEFAULTS.labels,
    workers: Number(flags.workers) || 1,
    force: !!flags.force,
    samples: null,
  };
  if (flags.samples)
    options.samples = String(flags.samples).split(',').map(Number);
  if (flags.every) {
    const every = Number(flags.every);
    const frames = readFrames(options.labels);
    options.samples = frames.map((_, i) => i).filter((i) => i % every === 0);
  }
  if (command === 'extract') return extract(options);
  if (command === 'status') return status(options);
  throw new Error(`unknown command ${command}: extract or status`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[borders] ${error.message}`);
    process.exit(1);
  });
