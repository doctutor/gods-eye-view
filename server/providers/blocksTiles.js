// Personal fork: the precomputed Blocks tilesets (docs/BLOCKS-PLAN.md,
// milestone 6), served read-only from .gev-cache/blocks-tiles (D:). Not
// part of upstream God's Eye View.
//
//   GET /api/blocks/tiles/index.json
//     {schema: 'blocks-tiles/1', boxes: [{name, built, anchor, curved,
//      levelsM, finestM, variants: [{name, file}], bbox: [w, s, e, n],
//      groups: {<level m>: [[gi, gj], …]}}]}: each built box, its levels,
//     the date it was written, and every level's groups (4 × 4 chunks each)
//     in the build's own map: the tiles reach the level of a point's finest
//     group (a fill tile is a leaf of the level above), and the coarsest
//     level's groups bound the tree.
//   GET /api/blocks/tiles/<box>/<path>
//     a tileset's JSON (its external subtrees too) or a tile's GLB; never
//     the build's state or log, nothing outside the box's folder.
import fs from 'node:fs';
import path from 'node:path';
import { defaultSourceRoot } from './common/source-root.js';
import { admitSameSite } from './common/same-site.js';
import { createRegion } from '../../src/layers/blocks/grid.js';

export const BLOCKS_TILES_ROUTE = '/api/blocks/tiles';
const TILES_DIR = path.join('.gev-cache', 'blocks-tiles');
/** Chunks a group side (the build's chunkGroup). */
const GROUP = 4;
const TYPES = { '.json': 'application/json', '.glb': 'model/gltf-binary' };
/** Files of a box never served: the build's own bookkeeping. */
const PRIVATE = new Set(['build-state.json', 'build.log']);

/**
 * A built box's entry for the index, from its tileset.json's
 * asset.extras.blocks and its build-state.json, or null when it is not a
 * Blocks tileset (no extras, unreadable).
 */
export function boxEntry(dir, name) {
  let tileset;
  let state;
  try {
    tileset = JSON.parse(
      fs.readFileSync(path.join(dir, 'tileset.json'), 'utf8'),
    );
    state = JSON.parse(
      fs.readFileSync(path.join(dir, 'build-state.json'), 'utf8'),
    );
  } catch {
    return null;
  }
  const blocks = tileset?.asset?.extras?.blocks;
  if (!blocks?.anchor || !Array.isArray(blocks.levelsM)) return null;
  const finestM = Math.min(...blocks.levelsM);
  // Every level's groups (a group's variants are one group).
  const byLevel = new Map(blocks.levelsM.map((level) => [level, new Map()]));
  for (const [file, tile] of Object.entries(state?.tiles || {})) {
    if (tile?.stats?.kind !== 'group') continue;
    const match = /^(\d+(?:\.\d+)?)m\/g(-?\d+)_(-?\d+)\./.exec(file);
    const level = match && byLevel.get(Number(match[1]));
    if (!level) continue;
    level.set(`${match[2]}:${match[3]}`, [Number(match[2]), Number(match[3])]);
  }
  const groups = [...byLevel.get(finestM).values()];
  // The finest groups' corners in longitude and latitude: the box.
  const region = createRegion({
    lon0: blocks.anchor.lon0,
    lat0: blocks.anchor.lat0,
    blockM: finestM,
    ...(blocks.curved ? { curved: true } : {}),
  });
  let [west, south, east, north] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [gi, gj] of groups)
    for (const [ci, cj] of [
      [gi * GROUP, gj * GROUP],
      [(gi + 1) * GROUP, gj * GROUP],
      [gi * GROUP, (gj + 1) * GROUP],
      [(gi + 1) * GROUP, (gj + 1) * GROUP],
    ]) {
      const origin = region.chunkOrigin(ci, cj);
      const at = region.toLonLat(origin.x, origin.y);
      const [lon, lat] = Array.isArray(at) ? at : [at.lon, at.lat];
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
  const built = fs.statSync(path.join(dir, 'tileset.json')).mtime;
  return {
    name,
    built: built.toISOString(),
    anchor: { lon0: blocks.anchor.lon0, lat0: blocks.anchor.lat0 },
    curved: Boolean(blocks.curved),
    levelsM: [...blocks.levelsM].sort((a, b) => b - a),
    finestM,
    variants: (blocks.variants || [{ file: 'tileset.json', name: 'default' }])
      .filter((variant) => /^[\w.-]+\.json$/.test(variant?.file || ''))
      .map(({ file, name: variant }) => ({ file, name: variant })),
    bbox: groups.length ? [west, south, east, north] : null,
    groups: Object.fromEntries(
      [...byLevel].map(([level, found]) => [
        String(level),
        [...found.values()],
      ]),
    ),
  };
}

/** Every built box under `root` (a folder a box), by name. */
export function blocksTilesIndex(root) {
  let names = [];
  try {
    names = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    names = [];
  }
  return {
    schema: 'blocks-tiles/1',
    boxes: names
      .map((name) => boxEntry(path.join(root, name), name))
      .filter(Boolean),
  };
}

/**
 * What a request path under the route is: {status, contentType, filePath}
 * for a file, {status, json} for the index, or {status, error}. Only .json
 * and .glb inside a box's folder; no '..', no hidden or private files.
 */
export function resolveBlocksTilesPath(root, requestPath) {
  let relative;
  try {
    relative = decodeURIComponent(String(requestPath || '').split('?')[0]);
  } catch {
    return { status: 400, error: 'Bad path' };
  }
  relative = relative.replace(/^\/+/, '');
  if (relative === 'index.json')
    return { status: 200, json: blocksTilesIndex(root) };
  const parts = relative.split('/');
  if (
    parts.length < 2 ||
    parts.some(
      (part) => !part || part === '.' || part === '..' || part.startsWith('.'),
    ) ||
    /[\\:]/.test(relative)
  )
    return { status: 404, error: 'Not found' };
  const extension = path.extname(relative).toLowerCase();
  if (!TYPES[extension] || PRIVATE.has(parts.at(-1)))
    return { status: 404, error: 'Not found' };
  const base = path.resolve(root);
  const filePath = path.resolve(base, ...parts);
  if (!filePath.startsWith(base + path.sep))
    return { status: 404, error: 'Not found' };
  if (!fs.existsSync(filePath)) return { status: 404, error: 'Not found' };
  return { status: 200, contentType: TYPES[extension], filePath };
}

/** The route's handler: GET and HEAD only, same-site only. */
export function createBlocksTilesHandler({ root }) {
  return (req, res) => {
    if (admitSameSite(req, res)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, HEAD');
      return res.end();
    }
    const answer = resolveBlocksTilesPath(root, req.url);
    if (answer.json || answer.error) {
      res.statusCode = answer.status;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-cache');
      return res.end(JSON.stringify(answer.json || { error: answer.error }));
    }
    const stat = fs.statSync(answer.filePath);
    const etag = `"${stat.size.toString(36)}-${stat.mtimeMs.toString(36)}"`;
    res.setHeader('ETag', etag);
    // A rebuild rewrites a file in place: revalidated, but cheaply.
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Content-Type', answer.contentType);
    if (req.headers?.['if-none-match'] === etag) {
      res.statusCode = 304;
      return res.end();
    }
    res.statusCode = 200;
    res.setHeader('Content-Length', stat.size);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(answer.filePath)
      .on('error', () => res.destroy())
      .pipe(res);
  };
}

/** Vite plugin: /api/blocks/tiles. */
export function blocksTilesProxy({ sourceRoot = defaultSourceRoot } = {}) {
  const install = (middlewares) =>
    middlewares.use(
      BLOCKS_TILES_ROUTE,
      createBlocksTilesHandler({ root: path.join(sourceRoot, TILES_DIR) }),
    );
  return {
    name: 'blocks-tiles',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
