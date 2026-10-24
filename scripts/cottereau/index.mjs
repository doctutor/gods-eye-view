#!/usr/bin/env node
/**
 * Cottereau's "History of the World: Every Year" (2500 BC to 2025) against
 * Cliopatria: which polities the video names in which years, and under
 * which names: the subsetting Cottereau did by hand, for a future
 * world-history layer.
 *
 *   node scripts/cottereau/index.mjs fit     [--labels FILE] [--video FILE]
 *   node scripts/cottereau/index.mjs build   [--labels FILE] [--cliopatria ZIP]
 *
 * `fit` finds the map's framings (cuts from the labels: framings.mjs),
 * and fits each to the coastline with fitFraming.py (Python with OpenCV:
 * COTTEREAU_PYTHON, default D:\gev-tools\cottereau-venv), a frame decoded
 * in memory, never written: data/cottereau/framings.json.
 *
 * `build` cleans each sampled frame's labels (labels.mjs), tracks them
 * through time (tracks.mjs), places each track with its framing's fit,
 * and matches it to Cliopatria (match.mjs): data/cottereau/tracks.json,
 * matches.json and review.md.
 *
 * Inputs are read only: the labels (E:\gev-data\cottereau\
 * labels-1fps.jsonl), the video (E:\gev-data\cottereau\raw\), Cliopatria
 * v0.2.1 (E:\gev-data\cliopatria\raw\, CC BY 4.0, streamed). Only facts
 * derived from the video are written: names, years, coordinates; never a
 * frame or an image of it (it is Cottereau's work).
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePack } from '../../src/maps/countries/geometry.js';
import { loadCliopatria } from './cliopatria.mjs';
import {
  afterCut,
  detectCuts,
  framingAt,
  framingExtent,
  pixelToLonLat,
} from './framings.mjs';
import { cleanFrame, readFrames } from './labels.mjs';
import { fitSizeModel, matchTrack, periodsOf } from './match.mjs';
import { buildReview } from './review.mjs';
import { mergeTracks, trackLabels } from './tracks.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const OUT = path.join(ROOT, 'data', 'cottereau');
const DEFAULTS = {
  labels: 'E:/gev-data/cottereau/labels-1fps.jsonl',
  video: 'E:/gev-data/cottereau/raw/hzWwp9JM7Hw.313.webm',
  cliopatria: 'E:/gev-data/cliopatria/raw/cliopatria-v0.2.1.geojson.zip',
  python: 'D:/gev-tools/cottereau-venv/Scripts/python.exe',
};

/**
 * The first framing's rough start: label positions of city states and
 * regions whose places are known (pixel centres of their labels at the
 * video's start), refined on the coastline by fitFraming.py.
 */
const FIRST_FRAMING_START = [
  { name: 'Minoa', lon: 24.9, lat: 35.2, x: 398, y: 743 },
  { name: 'Ur', lon: 46.1, lat: 30.96, x: 1134, y: 907 },
  { name: 'Ebla', lon: 36.8, lat: 35.8, x: 834, y: 660 },
  { name: 'Kish', lon: 44.6, lat: 32.5, x: 979, y: 788 },
  { name: 'Indus Valley', lon: 69.0, lat: 27.0, x: 1945, y: 1066 },
  { name: 'Egypt', lon: 31.0, lat: 26.5, x: 542, y: 915 },
];
// The year box and its ornament: no coastline there.
const IGNORE = [[1600, 1580, 2240, 1920]];

function parseArgs(argv) {
  const [command = 'build', ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++)
    if (rest[i].startsWith('--'))
      flags[rest[i].slice(2)] = rest[i + 1]?.startsWith('--')
        ? true
        : rest[++i];
  return { command, flags };
}

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 1)}\n`);
};
const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

/** Control points of a known mapping: a grid of its view's lon/lat at their pixels. */
function controlPointsOf(mapping) {
  const points = [];
  for (let x = 400; x < 3840; x += 800)
    for (let y = 300; y < 1700; y += 400) {
      const [lon, lat] = pixelToLonLat(mapping, x, y);
      points.push({ lon, lat, x, y });
    }
  return points;
}

function fit({ labels, video, python }) {
  const frames = readFrames(labels);
  const cuts = detectCuts(frames);
  const bounds = [frames[0].t, ...cuts.map((c) => c.t), frames.at(-1).t + 1];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-cottereau-'));
  try {
    const pack = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, 'src/data/local_data/natural_earth/countries.json'),
        'utf8',
      ),
    );
    const rings = [];
    for (const feature of decodePack(pack))
      for (const p of feature.polygons) rings.push(p.outer);
    const land = path.join(temp, 'land.json');
    fs.writeFileSync(land, JSON.stringify(rings));
    const framings = [];
    for (let i = 0; i + 1 < bounds.length; i++) {
      const fromT = bounds[i];
      const toT = bounds[i + 1];
      const carried = i ? afterCut(framings[i - 1], cuts[i - 1].change) : null;
      const guess = {
        ignore: IGNORE,
        controlPoints: carried ? controlPointsOf(carried) : FIRST_FRAMING_START,
      };
      const guessFile = path.join(temp, `guess${i}.json`);
      const outFile = path.join(temp, `fit${i}.json`);
      fs.writeFileSync(guessFile, JSON.stringify(guess));
      // A frame well inside the framing.
      const seconds = Math.round(((fromT + toT) / 2) * 100) / 100;
      console.log(
        `[cottereau] framing ${i + 1}: ${fromT}–${toT} s, fitting at ${seconds} s…`,
      );
      const run = spawnSync(
        python,
        [
          '-I',
          path.join(ROOT, 'scripts/cottereau/fitFraming.py'),
          video,
          String(seconds),
          land,
          guessFile,
          outFile,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
      );
      if (run.status !== 0)
        throw new Error(`fitFraming.py failed for framing ${i + 1}`);
      process.stdout.write(run.stdout);
      const { fits } = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      const miller = fits.miller;
      const framing = {
        id: i + 1,
        fromT,
        toT,
        fromYear: frames.find((f) => f.t >= fromT).year,
        toYear: [...frames].reverse().find((f) => f.t < toT).year,
        projection: 'miller',
        sx: round(miller.sx, 3),
        tx: round(miller.tx, 3),
        sy: round(miller.sy, 3),
        ty: round(miller.ty, 3),
        fittedAt: seconds,
        residualKm: Object.fromEntries(
          Object.entries(fits).map(([name, f]) => [
            name,
            {
              median: round(f.residualKm.median, 1),
              p75: round(f.residualKm.p75, 1),
              p90: round(f.residualKm.p90, 1),
              within25km: round(f.residualKm.within25, 3),
              aspect: round(f.aspect, 4),
            },
          ]),
        ),
      };
      if (carried) {
        // How far the label-measured cut puts the frame's corners from the coastline fit.
        let worst = 0;
        for (const [x, y] of [
          [0, 0],
          [3840, 0],
          [0, 1920],
          [3840, 1920],
          [1920, 960],
        ]) {
          const [a, b] = pixelToLonLat(framing, x, y);
          const [c, d] = pixelToLonLat(carried, x, y);
          const km = Math.hypot(
            (a - c) * 111 * Math.cos((b * Math.PI) / 180),
            (b - d) * 111,
          );
          worst = Math.max(worst, km);
        }
        framing.cut = {
          t: cuts[i - 1].t,
          year: cuts[i - 1].year,
          zoom: round(cuts[i - 1].change.ax, 4),
          labels: cuts[i - 1].change.kept,
          carriedVsFittedKm: round(worst, 1),
        };
      }
      framing.extent = Object.fromEntries(
        Object.entries(framingExtent(framing)).map(([k, v]) => [
          k,
          round(v, 2),
        ]),
      );
      framings.push(framing);
    }
    writeJson(path.join(OUT, 'framings.json'), {
      source:
        'Fitted on the coastline of one frame each (fitFraming.py) against Natural Earth 10 m land; residuals: observed coastline to fitted, km.',
      frames: { width: 3840, height: 1920 },
      framings,
    });
    console.log(
      `[cottereau] ${framings.length} framings → data/cottereau/framings.json`,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/** Each sampled frame's labels placed with its framing: [{t, year, labels: [{text, lon, lat, size, framing}]}]. */
export function placedSamples(frames, framings) {
  return frames.map((frame) => {
    const framing = framingAt(framings, frame.t);
    return {
      t: frame.t,
      year: frame.year,
      labels: framing
        ? cleanFrame(frame).map((label) => {
            const [lon, lat] = pixelToLonLat(framing, label.x, label.y);
            return {
              text: label.text,
              lon,
              lat,
              // The line height over the framing's scale: comparable across framings.
              size: (label.h / framing.sx) * 1000,
              framing: framing.id,
              // Its pixels, for the borders' extraction (borders.mjs).
              x: label.x,
              y: label.y,
              w: label.w,
              h: label.h,
            };
          })
        : [],
    };
  });
}

/** Every track of the labels with its points: what build() keeps (seen twice or more) and borders.mjs names regions by. */
export function computeTracks(frames, framings) {
  return mergeTracks(trackLabels(placedSamples(frames, framings)));
}

async function build({ labels, cliopatria }) {
  const frames = readFrames(labels);
  const { framings } = JSON.parse(
    fs.readFileSync(path.join(OUT, 'framings.json'), 'utf8'),
  );
  const lastT = frames.at(-1).t;
  if (framings.at(-1).toT <= lastT)
    console.warn(
      '[cottereau] the labels run past the last fitted framing: run fit again',
    );
  const all = computeTracks(frames, framings);
  const tracks = all.filter((t) => t.samples >= 2);
  console.log(
    `[cottereau] ${frames.length} samples (to ${frames.at(-1).year}), ${all.length} tracks, ${tracks.length} seen twice or more`,
  );
  console.log('[cottereau] reading Cliopatria…');
  const records = await loadCliopatria(cliopatria);
  console.log(`[cottereau] ${records.length} Cliopatria records`);
  // Name matches first; the size model from the sure ones; then the rest with it.
  let matches = tracks.map((track) => matchTrack(track, records));
  const sizeModel = fitSizeModel(
    tracks
      .map((track, i) => ({ track, match: matches[i] }))
      .filter(({ match }) => match.confidence === 'high')
      .map(({ track, match }) => ({
        size: track.size,
        area: records.find(
          (r) =>
            r.name === match.name &&
            r.from <= track.lastYear &&
            r.to >= track.firstYear,
        )?.area,
      })),
  );
  matches = tracks.map((track, i) =>
    matches[i].reason?.startsWith('name') ||
    matches[i].reason?.startsWith('abbreviation')
      ? matches[i]
      : matchTrack(track, records, { sizeModel }),
  );
  // Year by year, the names a track lives through.
  matches = matches.map((match, i) => ({
    ...match,
    periods: periodsOf(tracks[i], records, match, { sizeModel }),
  }));
  writeJson(path.join(OUT, 'tracks.json'), {
    source:
      'Labels of Cottereau, "History of the World: Every Year" (YouTube hzWwp9JM7Hw), read by OCR at one sample a second; names, years and places only.',
    samples: frames.length,
    lastYear: frames.at(-1).year,
    tracks: tracks.map(({ points, ...t }) => ({
      ...t,
      lon: round(t.lon, 3),
      lat: round(t.lat, 3),
      size: round(t.size, 2),
    })),
  });
  writeJson(path.join(OUT, 'matches.json'), {
    source:
      'Tracks (tracks.json) matched to Cliopatria v0.2.1 (CC BY 4.0): match.mjs',
    sizeModel,
    matches: tracks.map((track, i) => ({
      track: track.id,
      text: track.text,
      years: [track.firstYear, track.lastYear],
      ...matches[i],
    })),
  });
  const review = buildReview({ tracks, matches, records, framings, frames });
  fs.writeFileSync(path.join(OUT, 'review.md'), review.markdown);
  console.log(`[cottereau] ${review.summary}`);
}

async function main(argv) {
  const { command, flags } = parseArgs(argv);
  const options = {
    labels: flags.labels || DEFAULTS.labels,
    video: flags.video || DEFAULTS.video,
    cliopatria: flags.cliopatria || DEFAULTS.cliopatria,
    python: process.env.COTTEREAU_PYTHON || DEFAULTS.python,
  };
  if (command === 'fit') return fit(options);
  if (command === 'build') return build(options);
  throw new Error(`unknown command ${command}: fit or build`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[cottereau] ${error.message}`);
    process.exit(1);
  });
