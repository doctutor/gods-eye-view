// Personal fork: answers from the World history index (scripts/worldHistory/
// build.mjs): the polities of a year, Cottereau's subset or every one, a
// polity at its largest or as at a year, and the names for the panel's
// picker. Geometry is read from the level files by offset and pasted into
// the answer as the build wrote it. Not part of upstream God's Eye View.
import fs from 'node:fs';
import path from 'node:path';
import {
  CLIOPATRIA_LAST_YEAR,
  CONFIDENCES,
  WORLD_HISTORY_FIRST_YEAR,
  WORLD_HISTORY_LAST_YEAR,
  foldName,
  rankNames,
} from '../../../src/data/worldHistory.js';

/** A Cottereau polity whose years Cliopatria misses by this many still shows. */
export const NEAREST_RECORD_YEARS = 10;

const rank = (confidence) => {
  const at = CONFIDENCES.indexOf(confidence);
  return at < 0 ? CONFIDENCES.length : at;
};

/**
 * The polities of a year from a loaded index ({records, polities, buckets,
 * spans, yearBucket, yearOrigin}): [{record, label, confidence, lon, lat}],
 * largest first.
 * - 'all': every polity record alive that year (RELATION records, which
 *   duplicate their members' land, left out);
 * - 'cottereau': the polities Cottereau labels that year, high and medium
 *   matches (and place-only, low, with `places`), each under his label
 *   when it was matched by name; a polity Cliopatria has a few years off
 *   (NEAREST_RECORD_YEARS) still shows, with its nearest record.
 * 2025 reads Cliopatria's 2024.
 */
export function yearPolities(
  index,
  year,
  { mode = 'cottereau', places = false } = {},
) {
  const y = Math.min(year, index.lastYear ?? CLIOPATRIA_LAST_YEAR);
  const { records } = index;
  const out = new Map();
  if (mode === 'all') {
    const bucket =
      index.buckets[Math.floor((y - index.yearOrigin) / index.yearBucket)] ||
      [];
    for (const i of bucket) {
      const r = records[i];
      if (r.from <= y && r.to >= y && r.type !== 'relation')
        out.set(i, { record: i, label: r.name, confidence: null });
    }
  } else {
    const allowed = places ? 3 : 2;
    for (const span of index.spans) {
      if (span.from > y || span.to < y) continue;
      if (rank(span.confidence) >= allowed) continue;
      const i = recordAt(index, span.name, y);
      if (i < 0) continue;
      const before = out.get(i);
      if (
        before &&
        (rank(before.confidence) < rank(span.confidence) ||
          (rank(before.confidence) === rank(span.confidence) &&
            (before.byName || !span.byName)))
      )
        continue;
      out.set(i, {
        record: i,
        label: span.label,
        confidence: span.confidence,
        byName: span.byName,
        ...(Number.isFinite(span.lon) ? { lon: span.lon, lat: span.lat } : {}),
      });
    }
  }
  return [...out.values()].sort(
    (a, b) => records[b.record].area - records[a.record].area,
  );
}

/**
 * A polity's record alive in a year, else (within NEAREST_RECORD_YEARS)
 * its nearest one; -1 when none.
 */
export function recordAt(index, name, year, slack = NEAREST_RECORD_YEARS) {
  const polity = index.byName?.get(name);
  if (!polity) return -1;
  let best = -1;
  let gap = Infinity;
  for (const i of polity.records) {
    const r = index.records[i];
    const d = year < r.from ? r.from - year : year > r.to ? year - r.to : 0;
    if (d < gap) {
      gap = d;
      best = i;
    }
  }
  return gap <= slack ? best : -1;
}

/**
 * @param {{dir: string, now?: () => number}} options
 */
export function createWorldHistoryIndex({ dir, now = () => Date.now() }) {
  const pointer = path.join(dir, 'current.json');
  let held = null;
  let checkedAt = -Infinity;
  let lastError = null;

  function close() {
    for (const fd of held?.fds || []) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    held = null;
  }

  function current() {
    // The pointer is looked at again every 5 s: a new build is picked up.
    if (now() - checkedAt < 5000) return held;
    checkedAt = now();
    let stat;
    try {
      stat = fs.statSync(pointer);
    } catch {
      close();
      lastError = null;
      return null;
    }
    if (held && held.mtimeMs === stat.mtimeMs && held.size === stat.size)
      return held;
    try {
      const { manifest: name } = JSON.parse(fs.readFileSync(pointer, 'utf8'));
      if (!/^manifest-[0-9a-f]{12}\.json$/.test(String(name)))
        throw new Error('current.json names no manifest');
      const manifest = JSON.parse(
        fs.readFileSync(path.join(dir, name), 'utf8'),
      );
      const index = JSON.parse(
        fs.readFileSync(path.join(dir, manifest.index), 'utf8'),
      );
      index.byName = new Map(index.polities.map((p) => [p.name, p]));
      index.folded = index.polities.map((p) => foldName(p.name));
      const fds = manifest.lods.map((lod) =>
        fs.openSync(path.join(dir, lod.file), 'r'),
      );
      close();
      held = { manifest, index, fds, mtimeMs: stat.mtimeMs, size: stat.size };
      lastError = null;
    } catch (error) {
      close();
      lastError = String(error?.message || error).slice(0, 200);
      console.warn('[World history] index not readable:', lastError);
    }
    return held;
  }

  /** A record's served geometry text at a level. */
  function geometry(state, i, lod) {
    const [offset, length] = state.index.records[i].geom[lod];
    const buffer = Buffer.alloc(length);
    fs.readSync(state.fds[lod], buffer, 0, length, offset);
    return buffer.toString('utf8');
  }

  /** One record as answer text, with its geometry pasted in. */
  function recordText(state, i, lod, extra = {}) {
    const r = state.index.records[i];
    const head = JSON.stringify({
      id: i,
      name: r.name,
      from: r.from,
      to: r.to,
      area: r.area,
      wikipedia: r.wikipedia,
      wikidata: r.wikidata,
      label: r.label,
      box: r.box,
      ...extra,
    });
    return `${head.slice(0, -1)},"polygons":${geometry(state, i, lod)}}`;
  }

  const lodOf = (state, lod) =>
    Math.min(
      state.manifest.lods.length - 1,
      Math.max(0, Number.isInteger(lod) ? lod : 0),
    );

  return {
    status() {
      const state = current();
      if (!state) return { built: false, error: lastError };
      const m = state.manifest;
      return {
        built: true,
        id: m.id,
        builtAt: m.builtAt,
        records: m.records,
        polities: m.polities,
        spans: m.spans,
        lods: m.lods.map((lod) => lod.tolerance),
        firstYear: WORLD_HISTORY_FIRST_YEAR,
        lastYear: WORLD_HISTORY_LAST_YEAR,
        cliopatriaLastYear: state.index.lastYear,
      };
    },

    /** The build id (for the ETag), or ''. */
    id: () => current()?.manifest.id || '',

    /** A year's polities as answer text; null when not built. */
    year(year, { mode = 'cottereau', places = false, lod } = {}) {
      const state = current();
      if (!state) return null;
      const level = lodOf(state, lod);
      const shown = yearPolities(state.index, year, { mode, places });
      const parts = shown.map((p) =>
        recordText(state, p.record, level, {
          title: p.label,
          ...(p.confidence ? { confidence: p.confidence } : {}),
          ...(Number.isFinite(p.lon) ? { at: [p.lon, p.lat] } : {}),
        }),
      );
      const cliopatria = Math.min(year, state.index.lastYear);
      return `{"build":${JSON.stringify(state.manifest.id)},"year":${year},"cliopatriaYear":${cliopatria},"mode":${JSON.stringify(mode)},"lod":${level},"polities":[${parts.join(',')}]}`;
    },

    /**
     * A polity by name: its largest record (`extent` 'max'), or its record
     * alive in a year; null when not built, '' when there is none.
     */
    polity(name, { extent = 'max', lod } = {}) {
      const state = current();
      if (!state) return null;
      const polity = state.index.byName.get(name);
      if (!polity) return '';
      let i;
      if (extent === 'max') i = polity.max;
      else {
        const year = Math.min(Number(extent), state.index.lastYear);
        i = polity.records.find((r) => {
          const rec = state.index.records[r];
          return rec.from <= year && rec.to >= year;
        });
        if (i === undefined) return '';
      }
      const level = lodOf(state, lod);
      return `{"build":${JSON.stringify(state.manifest.id)},"extent":${JSON.stringify(String(extent))},"lod":${level},"from":${polity.from},"to":${polity.to},"record":${recordText(state, i, level)}}`;
    },

    /**
     * The polities by name for the picker: [name, from, to, area of the
     * largest, in Cottereau's subset 0/1], all of them, or those matching
     * `q` (a word start first, then anywhere), at most `limit`.
     */
    names({ q = '', limit = 50 } = {}) {
      const state = current();
      if (!state) return null;
      const { index } = state;
      const cottereau = new Set(
        index.spans
          .filter((span) => span.confidence !== 'low')
          .map((s) => s.name),
      );
      const row = (p) => [
        p.name,
        p.from,
        p.to,
        index.records[p.max].area,
        cottereau.has(p.name) ? 1 : 0,
      ];
      const area = (p) => index.records[p.max].area;
      const order = new Map(index.polities.map((p, k) => [p, k]));
      const ranked = String(q).trim()
        ? rankNames(index.polities, q, {
            limit,
            area,
            folded: (p) => index.folded[order.get(p)],
          })
        : index.polities;
      return { build: state.manifest.id, names: ranked.map(row) };
    },
  };
}
