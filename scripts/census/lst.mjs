import fs from 'node:fs';
import path from 'node:path';

/**
 * Land surface temperature per census tract, computed once by Earth
 * Engine for `npm run census:build`: the mean of the June–August
 * 2018–2023 Landsat 8 and 9 Collection 2 Level-2 surface temperature
 * (ST_B10 × 0.00341802 + 149, in °C), clear pixels only (QA_PIXEL cloud,
 * cirrus, shadow and dilated cloud bits off), averaged over each tract
 * (`reduceRegions`, mean) at 300 m. Measured 2026-10-19: Maricopa County's
 * 1,009 tracts took 90.7 s at 90 m, so about 1 hour of Earth Engine time
 * for the country at 300 m, approved once by the owner.
 *
 * Resumable: each state's answer is written to lst/<state>.json as it
 * comes, and a state already there is skipped, so a crash or a stopped
 * build repeats nothing finished. A state too large for one request (Earth
 * Engine's time or memory limit) is asked county by county, each county
 * kept as lst/<state><county>.json, then joined into the state's file.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

export const LST_SCALE_M = 300;
export const LST = Object.freeze({
  collections: Object.freeze([
    'LANDSAT/LC08/C02/T1_L2',
    'LANDSAT/LC09/C02/T1_L2',
  ]),
  start: '2018-01-01',
  end: '2024-01-01',
  months: Object.freeze([6, 8]),
  scale: LST_SCALE_M,
});
/** QA_PIXEL bits 1 (dilated cloud), 2 (cirrus), 3 (cloud), 4 (shadow). */
const CLOUDY_BITS = 0b11110;
/** Requests in flight at once. */
const CONCURRENCY = 4;
/** One request may take this long before it is treated as too large. */
const REQUEST_TIMEOUT_MS = 6 * 60 * 1000;

const c = (value) => ({ constantValue: value });
const f = (name, args) => ({
  functionInvocationValue: { functionName: name, arguments: args },
});
const IMAGE = '_landsat';
const image = { argumentReference: IMAGE };

/**
 * The value:compute request for the tracts of a state (and county): a
 * dictionary GEOID → mean °C.
 */
export function lstRequest(state, county = '') {
  const summer = (id) =>
    f('Collection.filter', {
      collection: f('Collection.filter', {
        collection: f('ImageCollection.load', { id: c(id) }),
        filter: f('Filter.dateRangeContains', {
          leftValue: f('DateRange', { start: c(LST.start), end: c(LST.end) }),
          rightField: c('system:time_start'),
        }),
      }),
      filter: f('Filter.calendarRange', {
        start: c(LST.months[0]),
        end: c(LST.months[1]),
        field: c('month'),
      }),
    });
  const scenes = f('Collection.merge', {
    collection1: summer(LST.collections[0]),
    collection2: summer(LST.collections[1]),
  });
  const mean = f('ImageCollection.reduce', {
    collection: f('Collection.map', {
      collection: scenes,
      baseAlgorithm: {
        functionDefinitionValue: { argumentNames: [IMAGE], body: '1' },
      },
    }),
    reducer: f('Reducer.mean', {}),
  });
  const filters = [
    f('Filter.equals', { leftField: c('STATEFP'), rightValue: c(state) }),
  ];
  if (county)
    filters.push(
      f('Filter.equals', { leftField: c('COUNTYFP'), rightValue: c(county) }),
    );
  const tracts = f('Collection.filter', {
    collection: f('Collection.loadTable', { tableId: c('TIGER/2020/TRACT') }),
    filter:
      filters.length === 1
        ? filters[0]
        : f('Filter.and', { filters: { arrayValue: { values: filters } } }),
  });
  // A tract with no clear summer pixel (open water, cloud every time:
  // Hawaii's) has no mean; it is left out, and drawn as no value.
  const reduced = f('Collection.filter', {
    collection: f('Image.reduceRegions', {
      image: mean,
      collection: tracts,
      reducer: f('Reducer.mean', {}),
      scale: c(LST.scale),
    }),
    filter: f('Filter.notNull', { properties: c(['mean']) }),
  });
  const qa = f('Image.select', {
    input: image,
    bandSelectors: c(['QA_PIXEL']),
  });
  const clear = f('Image.eq', {
    image1: f('Image.bitwiseAnd', {
      image1: qa,
      image2: f('Image.constant', { value: c(CLOUDY_BITS) }),
    }),
    image2: f('Image.constant', { value: c(0) }),
  });
  const celsius = f('Image.add', {
    image1: f('Image.multiply', {
      image1: f('Image.select', { input: image, bandSelectors: c(['ST_B10']) }),
      image2: f('Image.constant', { value: c(0.00341802) }),
    }),
    image2: f('Image.constant', { value: c(149.0 - 273.15) }),
  });
  return {
    expression: {
      values: {
        0: f('Dictionary.fromLists', {
          keys: f('AggregateFeatureCollection.array', {
            collection: reduced,
            property: c('GEOID'),
          }),
          values: f('AggregateFeatureCollection.array', {
            collection: reduced,
            property: c('mean'),
          }),
        }),
        1: f('Image.updateMask', { image: celsius, mask: clear }),
      },
      result: '0',
    },
  };
}

/** GEOID → °C (one decimal), a tract without clear pixels null. */
export function lstValues(result) {
  const out = {};
  for (const [geoid, value] of Object.entries(result || {}))
    out[geoid] = Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
  return out;
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, file);
};

/** Run `jobs` (async thunks) `limit` at a time. */
async function inParallel(jobs, limit) {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, jobs.length) },
    async () => {
      while (next < jobs.length) await jobs[next++]();
    },
  );
  await Promise.all(workers);
}

/**
 * Every state's tract temperatures, resumably.
 * @param {{dir: string, geoids: string[], compute: (body: object) =>
 *   Promise<object>, log?: (line: string) => void, concurrency?: number}} options
 *   `compute` posts one value:compute body and resolves to its `result`
 *   (it throws on an Earth Engine error).
 * @returns {Promise<{values: object, states: number, byCounty: string[]}>}
 */
export async function computeLst({
  dir,
  geoids,
  compute,
  log = () => {},
  concurrency = CONCURRENCY,
}) {
  const lstDir = path.join(dir, 'lst');
  const counties = new Map();
  for (const geoid of geoids) {
    const state = geoid.slice(0, 2);
    if (!counties.has(state)) counties.set(state, new Set());
    counties.get(state).add(geoid.slice(2, 5));
  }
  const states = [...counties.keys()].sort();
  const byCounty = [];
  let done = states.filter((state) =>
    readJson(path.join(lstDir, `${state}.json`)),
  ).length;
  log(
    `[census] land surface temperature: ${done} of ${states.length} states already done`,
  );
  const started = Date.now();
  await inParallel(
    states.map((state) => async () => {
      const stateFile = path.join(lstDir, `${state}.json`);
      if (readJson(stateFile)) return;
      let values;
      try {
        values = lstValues(await compute(lstRequest(state)));
      } catch (error) {
        // Too large in one request: county by county, each kept.
        byCounty.push(state);
        log(
          `[census] state ${state} by county (${String(error?.message || error).slice(0, 120)})`,
        );
        values = {};
        for (const county of [...counties.get(state)].sort()) {
          const countyFile = path.join(lstDir, `${state}${county}.json`);
          let part = readJson(countyFile);
          if (!part) {
            part = lstValues(await compute(lstRequest(state, county)));
            writeJson(countyFile, part);
          }
          Object.assign(values, part);
        }
      }
      writeJson(stateFile, values);
      done += 1;
      const minutes = ((Date.now() - started) / 60000).toFixed(1);
      log(
        `[census] land surface temperature: ${done} of ${states.length} states (${state}: ${Object.keys(values).length} tracts; ${minutes} min)`,
      );
    }),
    concurrency,
  );
  const values = {};
  for (const state of states)
    Object.assign(values, readJson(path.join(lstDir, `${state}.json`)));
  return { values, states: states.length, byCounty };
}

/** A `compute` for computeLst from the server's Earth Engine settings. */
export function earthEngineCompute({ auth, project, api, fetchImpl = fetch }) {
  return async (body) => {
    const response = await fetchImpl(
      `${api}/projects/${project}/value:compute`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await auth.token()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    const answer = await response.json().catch(() => ({}));
    if (!response.ok || answer.error)
      throw new Error(
        `Earth Engine ${response.status}: ${String(answer.error?.message || '').slice(0, 200)}`,
      );
    return answer.result;
  };
}
