#!/usr/bin/env node
// Personal fork: `npm run msfs:path`, a camera path file for the MSFS
// renderer's bridge from a route (scripts/msfs/cameraPath.mjs). Terrain
// comes from the running app's raster values (layer ee-elevation, the DEM
// stack); `--terrain none` skips it. Not part of upstream God's Eye View.
//
//   npm run msfs:path -- --from 39.2904,-76.6122 --to 39.3299,-76.6205 \
//     [--via lat,lon]... [--mode line|road] [--speed 40] [--agl 150] [--fps 30]
//     [--fov 60] [--look-down 0] [--max-bank 25] [--terrain ee-elevation|none]
//     [--server http://localhost:4173] --out path.json
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRasterValuesClient } from '../../src/data/rasterValues.js';
import {
  PATH_DEFAULTS,
  buildCameraPath,
  rasterTerrain,
} from './cameraPath.mjs';

const NUMBERS = {
  '--speed': 'speed',
  '--agl': 'agl',
  '--fps': 'fps',
  '--fov': 'fov',
  '--look-down': 'lookDown',
  '--max-bank': 'maxBank',
};

/** "lat,lon" as {lat, lon}, checked. */
export function parsePoint(text, flag = 'point') {
  const parts = String(text ?? '')
    .split(',')
    .map((s) => s.trim());
  const [lat, lon] = parts.map(Number);
  if (parts.length !== 2 || !(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180))
    throw new Error(
      `${flag} takes lat,lon (got ${JSON.stringify(String(text ?? '').slice(0, 40))})`,
    );
  return { lat, lon };
}

/** The command line as {route, options, terrain, server, out}. */
export function parsePathArgs(argv, env = {}) {
  const route = { from: null, to: null, via: [] };
  const options = {};
  let terrain = 'ee-elevation';
  let server = env.GEV_URL || 'http://localhost:4173';
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined || v.startsWith('--'))
        throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === '--from') route.from = parsePoint(value(), '--from');
    else if (flag === '--to') route.to = parsePoint(value(), '--to');
    else if (flag === '--via')
      for (const p of value().split(';'))
        route.via.push(parsePoint(p, '--via'));
    else if (flag === '--mode') options.mode = value();
    else if (flag in NUMBERS) {
      const v = Number(value());
      if (!Number.isFinite(v)) throw new Error(`${flag} takes a number`);
      options[NUMBERS[flag]] = v;
    } else if (flag === '--terrain') terrain = value();
    else if (flag === '--server') server = value().replace(/\/+$/, '');
    else if (flag === '--out') out = value();
    else throw new Error(`unknown option ${argv[i]}`);
  }
  if (!route.from || !route.to)
    throw new Error('--from lat,lon and --to lat,lon are needed');
  if (!out) throw new Error('--out path.json is needed');
  if (!/^(none|[a-z0-9][a-z0-9-]{0,63})$/.test(terrain))
    throw new Error(`--terrain ${terrain}: a raster values layer or none`);
  if (terrain !== 'none' && !/^https?:\/\/[^\s/]+$/.test(server))
    throw new Error(`--server ${server}: http(s)://host[:port]`);
  return { route, options, terrain, server, out };
}

export async function main(
  argv = process.argv.slice(2),
  { env = process.env, fetchImpl, log = console.log } = {},
) {
  const args = parsePathArgs(argv, env);
  const terrain =
    args.terrain === 'none'
      ? null
      : rasterTerrain(
          createRasterValuesClient({
            base: args.server,
            ...(fetchImpl ? { fetchImpl } : {}),
          }),
          {
            layer: args.terrain,
          },
        );
  const file = await buildCameraPath(
    args.route,
    { ...args.options, terrainName: args.terrain },
    terrain,
  );
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(file)}\n`);
  const { meta } = file;
  log(
    `${args.out}: ${file.samples.length.toLocaleString('en')} samples at ${file.fps} fps, ${(meta.distance_m / 1000).toFixed(2)} km in ${meta.duration_s.toFixed(1)} s at ${meta.speed_mps} m/s, ${meta.agl_m} m above ${meta.terrain}`,
  );
  for (const warning of meta.warnings) log(`  warning: ${warning}`);
  return file;
}

export { PATH_DEFAULTS };

if (import.meta.url === pathToFileURL(process.argv[1] || '').href)
  main().catch((error) => {
    console.error(`[msfs:path] ${error?.message || error}`);
    process.exitCode = 1;
  });
