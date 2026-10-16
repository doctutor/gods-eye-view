// Personal fork: the local database behind the Street View indoor provider.
import fs from 'node:fs/promises';
import path from 'node:path';

/** Default home: one JSON file per table under .gev-cache/streetview-indoor/. */
export const INDOOR_DB_DIR = path.join('.gev-cache', 'streetview-indoor');

/**
 * Google Maps Platform terms: Google content may be cached at most 30 days;
 * Place IDs may be kept indefinitely. Panoramas older than this are dropped,
 * and a place keeps only its id (plus when this app first saw it) once its
 * name and coordinates are older than this.
 */
export const PANO_RETENTION_DAYS = 30;
/** Panoramas this old are re-checked by the sweep before they expire. */
export const PANO_RECHECK_DAYS = 25;
/** A probed cell is not probed again for this long. */
export const CELL_RETENTION_DAYS = 30;

const DAY_MS = 86_400_000;

/** Size bounds: the oldest rows go first. */
export const MAX_PANOS = 50_000;
export const MAX_PLACES = 50_000;
export const MAX_CELLS = 100_000;

/** Side of a probe cell, metres. */
export const CELL_SIZE_M = 250;
const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON = 111_320;

/** The ~250 m cell holding a point, as a stable `row:col` key. */
export function cellKey(lat, lon) {
  const latStep = CELL_SIZE_M / M_PER_DEG_LAT;
  const row = Math.floor(lat / latStep);
  const centreLat = (row + 0.5) * latStep;
  const lonStep =
    CELL_SIZE_M /
    (M_PER_DEG_LON * Math.max(0.01, Math.cos((centreLat * Math.PI) / 180)));
  const col = Math.floor(lon / lonStep);
  return `${row}:${col}`;
}

/** Keys of the cells a circle touches (sampled every half cell). */
export function cellsInCircle(lat, lon, radiusM) {
  const keys = new Set([cellKey(lat, lon)]);
  const step = CELL_SIZE_M / 2;
  const cosLat = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  for (let dy = -radiusM; dy <= radiusM; dy += step) {
    for (let dx = -radiusM; dx <= radiusM; dx += step) {
      if (Math.hypot(dx, dy) > radiusM) continue;
      keys.add(
        cellKey(lat + dy / M_PER_DEG_LAT, lon + dx / (M_PER_DEG_LON * cosLat)),
      );
    }
  }
  return [...keys];
}

/** Metres between two {lat, lon} points (equirectangular; street scale). */
export function metresBetween(a, b) {
  const lat = (((a.lat + b.lat) / 2) * Math.PI) / 180;
  let dLon = b.lon - a.lon;
  if (dLon > 180) dLon -= 360;
  if (dLon < -180) dLon += 360;
  return Math.hypot(
    dLon * M_PER_DEG_LON * Math.cos(lat),
    (b.lat - a.lat) * M_PER_DEG_LAT,
  );
}

const finite = (value) => Number.isFinite(value);
const isPanoId = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{10,64}$/.test(value);

function readRows(raw, key, valid) {
  const rows = Array.isArray(raw?.[key]) ? raw[key] : [];
  return rows.filter(valid);
}

/** Write JSON via a temp file and rename, so a crash never leaves half a file. */
async function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value), 'utf8');
  try {
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Keep the newest `max` entries of a Map by `field`. */
function trimMap(map, max, field) {
  if (map.size <= max) return;
  const ordered = [...map.entries()].sort(
    (a, b) => (a[1][field] || 0) - (b[1][field] || 0),
  );
  for (const [key] of ordered.slice(0, map.size - max)) map.delete(key);
}

/**
 * The indoor database: places (permanent ids), panoramas (≤30 days), probed
 * cells and today's request usage. Mutations mark it dirty; `save()` writes
 * the changed tables atomically, one save at a time.
 */
export function createIndoorDb({ dir = INDOOR_DB_DIR, now = Date.now } = {}) {
  /** placeId → {placeId, firstSeen, lastHitAt, name?, lat?, lon?, detailsAt?} */
  const places = new Map();
  /** panoId → {panoId, placeId, lat, lon, date, copyright, foundAt, checkedAt, method, kind, name?} */
  const panos = new Map();
  /** cellKey → probedAt */
  const cells = new Map();
  let usage = { day: '', metadata: 0, places: 0 };
  const dirty = new Set();
  let saving = null;
  let again = false;

  const file = (name) => path.join(dir, `${name}.json`);
  const today = () => new Date(now()).toISOString().slice(0, 10);

  function rollUsage() {
    const day = today();
    if (usage.day !== day) {
      usage = { day, metadata: 0, places: 0 };
      dirty.add('usage');
    }
    return usage;
  }

  /** Enforce the retention rules on what is in memory. */
  function expire() {
    const t = now();
    const panoCutoff = t - PANO_RETENTION_DAYS * DAY_MS;
    for (const [id, pano] of panos)
      if (!(pano.checkedAt >= panoCutoff)) {
        panos.delete(id);
        dirty.add('panos');
      }
    for (const place of places.values())
      if (place.detailsAt !== undefined && !(place.detailsAt >= panoCutoff)) {
        delete place.name;
        delete place.lat;
        delete place.lon;
        delete place.detailsAt;
        dirty.add('places');
      }
    const cellCutoff = t - CELL_RETENTION_DAYS * DAY_MS;
    for (const [key, probedAt] of cells)
      if (!(probedAt >= cellCutoff)) {
        cells.delete(key);
        dirty.add('cells');
      }
  }

  async function load() {
    const [rawPlaces, rawPanos, rawCells, rawUsage] = await Promise.all(
      ['places', 'panos', 'cells', 'usage'].map((name) => readJson(file(name))),
    );
    places.clear();
    panos.clear();
    cells.clear();
    for (const row of readRows(
      rawPlaces,
      'places',
      (r) => typeof r?.placeId === 'string' && r.placeId.length <= 512,
    ))
      places.set(row.placeId, { ...row });
    for (const row of readRows(
      rawPanos,
      'panos',
      (r) =>
        isPanoId(r?.panoId) &&
        finite(r.lat) &&
        finite(r.lon) &&
        finite(r.checkedAt),
    ))
      panos.set(row.panoId, { ...row });
    for (const row of readRows(
      rawCells,
      'cells',
      (r) => typeof r?.key === 'string' && finite(r.probedAt),
    ))
      cells.set(row.key, row.probedAt);
    if (rawUsage && typeof rawUsage.day === 'string')
      usage = {
        day: rawUsage.day,
        metadata: Number(rawUsage.metadata) || 0,
        places: Number(rawUsage.places) || 0,
      };
    expire();
    rollUsage();
  }

  function snapshot(name) {
    if (name === 'places') return { version: 1, places: [...places.values()] };
    if (name === 'panos') return { version: 1, panos: [...panos.values()] };
    if (name === 'cells')
      return {
        version: 1,
        cells: [...cells].map(([key, probedAt]) => ({ key, probedAt })),
      };
    return usage;
  }

  async function writeDirty() {
    const names = [...dirty];
    dirty.clear();
    if (!names.length) return;
    await fs.mkdir(dir, { recursive: true });
    for (const name of names) {
      try {
        await writeJsonAtomic(file(name), snapshot(name));
      } catch (error) {
        dirty.add(name);
        throw error;
      }
    }
  }

  /** Write every changed table; overlapping calls coalesce into one more pass. */
  async function save() {
    if (saving) {
      again = true;
      return saving;
    }
    saving = (async () => {
      try {
        do {
          again = false;
          await writeDirty();
        } while (again || dirty.size);
      } finally {
        saving = null;
      }
    })();
    return saving;
  }

  return {
    load,
    save,
    expire,
    dir,

    usage: () => ({ ...rollUsage() }),
    countRequest(kind, n = 1) {
      const current = rollUsage();
      current[kind] = (current[kind] || 0) + n;
      dirty.add('usage');
    },

    cellProbedAt: (key) => cells.get(key) ?? null,
    unprobedCells(keys) {
      const cutoff = now() - CELL_RETENTION_DAYS * DAY_MS;
      return keys.filter((key) => !(cells.get(key) >= cutoff));
    },
    markCells(keys) {
      const t = now();
      for (const key of keys) {
        cells.delete(key);
        cells.set(key, t);
      }
      if (cells.size > MAX_CELLS) {
        const ordered = [...cells].sort((a, b) => a[1] - b[1]);
        for (const [key] of ordered.slice(0, cells.size - MAX_CELLS))
          cells.delete(key);
      }
      dirty.add('cells');
    },

    getPano: (panoId) => panos.get(panoId) || null,
    allPanos: () => [...panos.values()],
    putPano(row) {
      if (!isPanoId(row?.panoId) || !finite(row.lat) || !finite(row.lon))
        return false;
      const previous = panos.get(row.panoId);
      panos.set(row.panoId, {
        ...previous,
        ...row,
        foundAt: previous?.foundAt ?? row.foundAt ?? now(),
      });
      trimMap(panos, MAX_PANOS, 'checkedAt');
      dirty.add('panos');
      return !previous;
    },
    dropPano(panoId) {
      if (panos.delete(panoId)) dirty.add('panos');
    },

    getPlace: (placeId) => places.get(placeId) || null,
    putPlace({ placeId, name, lat, lon }) {
      if (typeof placeId !== 'string' || !placeId) return;
      const t = now();
      const previous = places.get(placeId);
      places.set(placeId, {
        placeId,
        firstSeen: previous?.firstSeen ?? t,
        lastHitAt: t,
        ...(name ? { name: String(name).slice(0, 200) } : {}),
        ...(finite(lat) && finite(lon) ? { lat, lon, detailsAt: t } : {}),
      });
      trimMap(places, MAX_PLACES, 'lastHitAt');
      dirty.add('places');
    },

    /** Panoramas within `radiusM` of a point, nearest first. */
    hitsNear({ lat, lon }, radiusM) {
      const out = [];
      for (const pano of panos.values()) {
        const d = metresBetween({ lat, lon }, pano);
        if (d <= radiusM) out.push({ pano, d });
      }
      out.sort((a, b) => a.d - b.d);
      return out.map(({ pano }) => {
        const place = pano.placeId ? places.get(pano.placeId) : null;
        return {
          placeId: pano.placeId || null,
          name: pano.name || place?.name || null,
          lat: pano.lat,
          lon: pano.lon,
          panoId: pano.panoId,
          panoDate: pano.date || null,
          copyright: pano.copyright || null,
          foundAt: pano.foundAt,
          checkedAt: pano.checkedAt,
          method: pano.method || null,
          kind: pano.kind || null,
        };
      });
    },

    counts: () => ({
      places: places.size,
      panos: panos.size,
      cells: cells.size,
    }),
  };
}
