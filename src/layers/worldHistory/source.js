/**
 * Personal fork: the World history layer's answers from the app's own
 * routes (/api/world-history, server/providers/worldHistory.js), decoded
 * once and kept for the page: a year's polities at a level of detail, a
 * polity at its largest or as at a year, and the names for the picker.
 */
import { decodePolygons, polygonsBox } from '../../data/worldHistory.js';

export const WORLD_HISTORY_ROUTE = '/api/world-history';
/** Answers kept at most (a year at a level, or a polity, is one). */
const MAX_KEPT = 48;

/** A served record with its polygons decoded and its box. */
export function decodeRecord(record) {
  const polygons = decodePolygons(record.polygons);
  return {
    ...record,
    polygons,
    box: polygonsBox(polygons),
  };
}

/**
 * @param {{fetchImpl?: typeof fetch}} [options]
 */
export function createWorldHistorySource({
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  const kept = new Map();

  async function ask(path) {
    const response = await fetchImpl(`${WORLD_HISTORY_ROUTE}${path}`);
    if (response.status === 404) return { missing: true };
    if (!response.ok) {
      let error = `HTTP ${response.status}`;
      try {
        error = (await response.json())?.error || error;
      } catch {
        /* no body */
      }
      const failure = new Error(error);
      failure.status = response.status;
      throw failure;
    }
    return response.json();
  }

  /** One answer per key, asked once; a failed one is asked again later. */
  function once(key, make) {
    if (kept.has(key)) {
      const value = kept.get(key);
      kept.delete(key);
      kept.set(key, value);
      return value;
    }
    const promise = make().catch((error) => {
      kept.delete(key);
      throw error;
    });
    kept.set(key, promise);
    while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value);
    return promise;
  }

  return {
    status: () => ask('/status'),

    /** A year's polities at a level: {year, cliopatriaYear, polities}. */
    year(year, { mode = 'cottereau', places = false, lod = 0 } = {}) {
      const query = `mode=${mode}${places && mode === 'cottereau' ? '&places=1' : ''}&lod=${lod}`;
      return once(`year ${year} ${query}`, async () => {
        const answer = await ask(`/year/${year}?${query}`);
        return {
          ...answer,
          polities: (answer.polities || []).map(decodeRecord),
        };
      });
    },

    /** A polity at its largest (`extent` 'max') or in a year; null if none. */
    polity(name, { extent = 'max', lod = 0 } = {}) {
      const query = `name=${encodeURIComponent(name)}&extent=${extent}&lod=${lod}`;
      return once(`polity ${query}`, async () => {
        const answer = await ask(`/polity?${query}`);
        if (answer.missing) return null;
        return { ...answer, record: decodeRecord(answer.record) };
      });
    },

    /** Every polity for the picker: [{name, from, to, area, cottereau}]. */
    names() {
      return once('names', async () => {
        const answer = await ask('/names');
        return (answer.names || []).map(
          ([name, from, to, area, cottereau]) => ({
            name,
            from,
            to,
            area,
            cottereau: cottereau === 1,
          }),
        );
      });
    },
  };
}
