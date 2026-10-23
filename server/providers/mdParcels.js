// Personal fork: Maryland's property parcels for the Custom cutouts layer,
// from MD iMAP's Parcel Boundaries (MDP and SDAT). Not part of upstream
// God's Eye View.
import fs from 'node:fs';
import path from 'node:path';
import { admitSameSite } from './common/same-site.js';
import { defaultSourceRoot } from './common/source-root.js';
import {
  MD_PARCELS_HOSTS,
  MD_PARCELS_PATH,
  MD_PARCELS_ROUTE,
  inMaryland,
  parcelKeyQuery,
  parcelPointQuery,
  parcelsFromGeoJson,
  validAcctid,
  validJurscode,
} from '../../src/data/mdParcels.js';

/**
 *   GET /api/parcels/md?lat=&lon=
 *       the parcels under a point in Maryland
 *   GET /api/parcels/md?jurscode=&acctid=
 *       one parcel by its key (a cutout's rings again after a reload)
 *
 * Both answer {parcels: [{acctid, jurscode, address, acres, rings}]}, rings
 * [lon, lat], one per polygon part; an empty list where there is no parcel.
 * 400 for bad parameters or a point outside Maryland (upstream is never
 * asked); 502 when MD iMAP fails. Only ACCTID, ADDRESS, ACRES and JURSCODE
 * are asked for: never the owners' names or mailing addresses.
 *
 * Each parcel is kept on disk by its key (.gev-cache/md-parcels/, 30 days),
 * and each point's answer in memory for a while, so a reload asks nothing.
 * Upstream is asked one request at a time, with a timeout (15 s, 45 s by
 * key), under the app's own User-Agent.
 */
export const MD_PARCELS_USER_AGENT =
  'gods-eye-view-md-parcels/1.0 (personal map app; Custom cutouts)';
export const UPSTREAM_TIMEOUT_MS = 15_000;
/**
 * A parcel asked by its key (a reload whose parcel is not on disk) is an
 * attribute query, which MD iMAP answers slowly: 4.7 to 8 s, once over 15 s
 * (2026-10-23).
 */
export const KEY_TIMEOUT_MS = 45_000;
export const PARCEL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const POINT_TTL_MS = 10 * 60 * 1000;
const POINTS_KEPT = 500;
const CACHE_DIR = path.join('.gev-cache', 'md-parcels');

/**
 * @param {{sourceRoot?: string, fetchImpl?: typeof fetch,
 *   now?: () => number, hosts?: string[], timeoutMs?: number,
 *   keyTimeoutMs?: number}} [options]
 */
export function createMdParcelsService({
  sourceRoot = defaultSourceRoot,
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  hosts = MD_PARCELS_HOSTS,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
  keyTimeoutMs = KEY_TIMEOUT_MS,
} = {}) {
  const dir = path.join(sourceRoot, CACHE_DIR);
  /** "<lat>,<lon>" (6 decimals) → {keys, at}. */
  const points = new Map();
  let queue = Promise.resolve();
  const counts = { upstream: 0 };

  const fileOf = (jurscode, acctid) =>
    path.join(dir, `${jurscode}-${acctid.replace(/ /g, '_')}.json`);

  function readParcel(jurscode, acctid) {
    try {
      const file = fileOf(jurscode, acctid);
      if (now() - fs.statSync(file).mtimeMs >= PARCEL_TTL_MS) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }
  function keepParcel(parcel) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        fileOf(parcel.jurscode, parcel.acctid),
        JSON.stringify(parcel),
      );
    } catch {
      /* serving matters more than keeping */
    }
  }

  /** One upstream request at a time; each host in turn until one answers. */
  function upstream(query, wait = timeoutMs) {
    const run = async () => {
      let lastError = null;
      for (const host of hosts) {
        counts.upstream += 1;
        try {
          const response = await fetchImpl(
            `https://${host}${MD_PARCELS_PATH}?${query}`,
            {
              headers: {
                'User-Agent': MD_PARCELS_USER_AGENT,
                Accept: 'application/geo+json, application/json',
              },
              signal: AbortSignal.timeout(wait),
              redirect: 'error',
            },
          );
          if (!response.ok) {
            lastError = new Error(`${host} answered ${response.status}`);
            continue;
          }
          return parcelsFromGeoJson(await response.json());
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error('MD iMAP did not answer');
    };
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
  }

  return {
    /** The parcels under a point: {status, parcels} or {status, error}. */
    async at(lat, lon) {
      if (!inMaryland(lat, lon))
        return { status: 400, error: 'Maryland parcels only' };
      const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
      const held = points.get(key);
      if (held && now() - held.at < POINT_TTL_MS) {
        const parcels = held.keys.map(([j, a]) => readParcel(j, a));
        if (parcels.every(Boolean)) return { status: 200, parcels };
      }
      let parcels;
      try {
        parcels = await upstream(parcelPointQuery(lat, lon));
      } catch (error) {
        return { status: 502, error: String(error?.message || error) };
      }
      for (const parcel of parcels) keepParcel(parcel);
      points.delete(key);
      points.set(key, {
        keys: parcels.map((p) => [p.jurscode, p.acctid]),
        at: now(),
      });
      while (points.size > POINTS_KEPT)
        points.delete(points.keys().next().value);
      return { status: 200, parcels };
    },

    /** One parcel by its key, from disk when kept. */
    async byKey(jurscode, acctid) {
      if (!validJurscode(jurscode) || !validAcctid(acctid))
        return { status: 400, error: 'jurscode and acctid are SDAT codes' };
      const kept = readParcel(jurscode, acctid);
      if (kept) return { status: 200, parcels: [kept] };
      let parcels;
      try {
        parcels = await upstream(
          parcelKeyQuery(jurscode, acctid),
          keyTimeoutMs,
        );
      } catch (error) {
        return { status: 502, error: String(error?.message || error) };
      }
      const match = parcels.filter(
        (p) => p.jurscode === jurscode && p.acctid === acctid,
      );
      for (const parcel of match) keepParcel(parcel);
      return { status: 200, parcels: match.slice(0, 1) };
    },

    /** For tests: how many upstream requests were made. */
    counts: () => ({ ...counts }),
  };
}

function sendJson(res, status, payload, cache = 'no-store') {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache);
  res.end(JSON.stringify(payload));
}

const number = (params, name) => {
  const raw = params.get(name);
  return raw === null || raw.trim() === '' ? NaN : Number(raw);
};

/** The route /api/parcels/md (same-site only, GET only). */
export function createMdParcelsHandler({ service }) {
  return async function handle(req, res, next) {
    if (admitSameSite(req, res)) return;
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'Method not allowed' });
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    if (route !== '/') {
      if (typeof next === 'function') return next();
      return sendJson(res, 404, { error: 'Not found' });
    }
    try {
      const params = url.searchParams;
      let answer;
      if (params.has('acctid') || params.has('jurscode'))
        answer = await service.byKey(
          String(params.get('jurscode') || ''),
          String(params.get('acctid') || ''),
        );
      else {
        const lat = number(params, 'lat');
        const lon = number(params, 'lon');
        if (
          !Number.isFinite(lat) ||
          !Number.isFinite(lon) ||
          Math.abs(lat) > 90 ||
          Math.abs(lon) > 180
        )
          return sendJson(res, 400, { error: 'lat and lon are degrees' });
        answer = await service.at(lat, lon);
      }
      if (answer.status !== 200)
        return sendJson(res, answer.status, { error: answer.error });
      return sendJson(
        res,
        200,
        { parcels: answer.parcels },
        'private, max-age=3600',
      );
    } catch (error) {
      console.warn('[Parcels] MD route failed:', error?.message);
      return sendJson(res, 500, { error: 'Maryland parcels unavailable' });
    }
  };
}

/** Vite plugin: /api/parcels/md. */
export function mdParcelsProxy({
  sourceRoot = defaultSourceRoot,
  service,
} = {}) {
  function install(middlewares) {
    middlewares.use(
      MD_PARCELS_ROUTE,
      createMdParcelsHandler({
        service: service || createMdParcelsService({ sourceRoot }),
      }),
    );
  }
  return {
    name: 'md-parcels',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
