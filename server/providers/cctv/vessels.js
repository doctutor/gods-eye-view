import { readResponseJsonCapped } from '../common/http.js';
import { isPlausibleLatLon } from './normalize.js';

/**
 * Ship positions for featured cams aboard a vessel (live-cams.json entries
 * with `placement: 'vessel'`): the owner's rule includes a moving cam when
 * its position is confident, and a ship's own position fix is.
 *
 * NOAA publishes NOAA Ship Okeanos Explorer's current position as a public
 * ArcGIS feature service ("Current Position for Okeanos Explorer (OMAO data
 * stream)", owned by NCEI for NOAA Ocean Exploration; it feeds the ship's
 * Live Operations Map): one point with the fix time, course, speed and an
 * in-port flag. The ship tracker NOAA once ran at shiptracker.noaa.gov no
 * longer resolves. ArcGIS Online's robots.txt allows all agents.
 *
 * Asked at most once per 10 minutes per vessel (an answer or a failure is
 * kept that long); a fix older than a day places nothing, so a cam is never
 * pinned where the ship was.
 *
 * Personal-fork module; not part of upstream God's Eye View.
 */

export const VESSEL_TRACKERS = Object.freeze({
  'okeanos-explorer': Object.freeze({
    name: 'NOAA Ship Okeanos Explorer',
    url: 'https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/Okeanos_Explorer_Position/FeatureServer/0/query',
    credit: 'NOAA OMAO position stream, via NCEI',
  }),
});
export const VESSEL_POLL_MS = 10 * 60 * 1000;
/** After a failed ask with nothing held, ask again this soon (a cold start). */
export const VESSEL_RETRY_MS = 60 * 1000;
export const VESSEL_MAX_FIX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 64 * 1024;

const finite = (value) =>
  value !== null && value !== '' && Number.isFinite(Number(value))
    ? Number(value)
    : null;

/**
 * The newest fix in a feature-service answer, or null.
 * @returns {{lat: number, lon: number, at: number, courseDeg: number|null,
 *   speedKn: number|null, inPort: boolean, cruiseId: string}|null}
 */
export function parseVesselFix(body) {
  const features = Array.isArray(body?.features) ? body.features : [];
  let best = null;
  for (const feature of features) {
    const a = feature?.attributes || {};
    const lat = finite(a.lat ?? feature?.geometry?.y);
    const lon = finite(a.lon ?? feature?.geometry?.x);
    const at = finite(a.dateTime);
    if (lat === null || lon === null || at === null) continue;
    if (!isPlausibleLatLon(lat, lon)) continue;
    if (best && best.at >= at) continue;
    const course = finite(a.cog ?? a.gyro_hdg);
    best = {
      lat: Math.round(lat * 1e5) / 1e5,
      lon: Math.round(lon * 1e5) / 1e5,
      at,
      courseDeg:
        course !== null && course >= 0 && course <= 360 ? course : null,
      speedKn: finite(a.sog),
      inPort: String(a.IN_PORT ?? '0') === '1',
      cruiseId: String(a.cruiseID || '').slice(0, 20),
    };
  }
  return best;
}

/**
 * @param {{fetchImpl?: Function, now?: () => number, pollMs?: number,
 *   maxFixAgeMs?: number}} [options]
 * @returns {{fixFor: (vesselId: string) => Promise<object|null>}} The
 *   vessel's newest fix while it is fresh, else null.
 */
export function createVesselTracker({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  pollMs = VESSEL_POLL_MS,
  retryMs = VESSEL_RETRY_MS,
  maxFixAgeMs = VESSEL_MAX_FIX_AGE_MS,
} = {}) {
  const asked = new Map(); // vesselId → {at, fix, pending}

  async function fetchFix(tracker) {
    const url = new URL(tracker.url);
    url.searchParams.set('where', '1=1');
    url.searchParams.set(
      'outFields',
      'dateTime,lat,lon,cog,sog,IN_PORT,cruiseID',
    );
    url.searchParams.set('returnGeometry', 'true');
    url.searchParams.set('outSR', '4326');
    url.searchParams.set('f', 'json');
    try {
      const response = await fetchImpl(url.toString(), {
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) return null;
      return parseVesselFix(await readResponseJsonCapped(response, MAX_BYTES));
    } catch {
      return null;
    }
  }

  return {
    async fixFor(vesselId) {
      const tracker = VESSEL_TRACKERS[vesselId];
      if (!tracker) return null;
      let state = asked.get(vesselId);
      // A failed ask that left nothing to show is retried sooner than the
      // poll window: at start-up the feeds all compete for the network.
      const waitMs = state && !state.fix && !state.pending ? retryMs : pollMs;
      if (!state || now() - state.at >= waitMs) {
        const pending = state?.pending || fetchFix(tracker);
        state = { at: now(), fix: state?.fix || null, pending };
        asked.set(vesselId, state);
        const fix = await pending;
        // A failed ask keeps the last fix; its age decides below.
        state.fix = fix || state.fix;
        state.pending = null;
      } else if (state.pending) await state.pending;
      const fix = state.fix;
      if (!fix || now() - fix.at > maxFixAgeMs) return null;
      return { ...fix, vesselId, vesselName: tracker.name };
    },
  };
}
