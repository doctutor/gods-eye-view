/**
 * Personal fork: where the Custom cutouts' boundaries come from. First the
 * app's Overpass proxy (the local Overpass with its areas; the proxy keeps
 * these boundary-class answers 30 days on disk): is_in for the areas at a
 * point, then a relation's geometry by its area id. When Overpass is not
 * configured or fails, the bundled boundary packs (src/data/adminBoundaries.js:
 * countries, states and provinces, US counties) answer by name. Maryland's
 * property parcels come from the app's /api/parcels/md (MD iMAP, kept on
 * disk there by parcel). Rings are kept in memory for the page; the URL
 * holds only sources.
 */
import {
  areasFromIsIn,
  cutoutFromRelationGeometry,
  isInQuery,
  relationGeometryQuery,
  simplifyRings,
} from '../../data/customCutouts.js';
import {
  MD_PARCELS_ROUTE,
  inMaryland,
  parcelName,
  parcelSourceKey,
  parseParcelSourceKey,
} from '../../data/mdParcels.js';

const unavailable = (answer) =>
  Boolean(answer && !Array.isArray(answer) && answer.unavailable);

/** A pack cutout's key: the query, folded to `[a-z0-9-]` (and back). */
export const packKey = (query) =>
  String(query || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
const packQuery = (key) => key.replace(/-/g, ' ');

/** The admin level a pack's kind stands for (OSM's numbering). */
const PACK_LEVELS = Object.freeze({ country: 2, state: 4, county: 6 });

/**
 * @param {{boundaries: {query: Function},
 *   findAdminArea?: (query: string, options?: object) => Promise<object|null>,
 *   fetchImpl?: typeof fetch}} options
 *   `boundaries` is the app's Overpass transport (applicationServices.boundaries);
 *   `findAdminArea` the packs' name lookup; `fetchImpl` asks the parcels route.
 */
export function createCutoutSource({
  boundaries,
  findAdminArea = null,
  fetchImpl = (...args) => fetch(...args),
}) {
  const rings = new Map();

  /** A parcel of the route's answer as an area with its rings. */
  const parcelArea = (parcel) => ({
    source: parcelSourceKey(parcel),
    name: parcelName(parcel),
    level: null,
    kind: 'parcel',
    acres: parcel.acres,
    rings: simplifyRings(parcel.rings),
  });

  /** The parcels route: {parcels} or {failed}. */
  async function parcels(query, signal) {
    try {
      const response = await fetchImpl(`${MD_PARCELS_ROUTE}?${query}`, {
        signal,
      });
      if (!response.ok) return { failed: 'failed' };
      const body = await response.json();
      return Array.isArray(body?.parcels)
        ? { parcels: body.parcels }
        : { failed: 'failed' };
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      return { failed: 'failed' };
    }
  }

  async function overpass(text, signal) {
    try {
      const answer = await boundaries.query(text, { signal });
      if (Array.isArray(answer)) return { elements: answer };
      return { failed: unavailable(answer) ? 'unconfigured' : 'failed' };
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      return {
        failed:
          error?.code === 'OVERPASS_NOT_CONFIGURED' ? 'unconfigured' : 'failed',
      };
    }
  }

  /** A pack's area for a query as a cutout, or null. */
  async function fromPack(query, near) {
    if (!findAdminArea) return null;
    const area = await findAdminArea(query, near ? { near } : {});
    const outer = (area?.polygons || [])
      .map((polygon) => polygon?.[0])
      .filter((ring) => Array.isArray(ring) && ring.length >= 3);
    if (!outer.length) return null;
    return {
      source: `pack:${packKey(query)}`,
      name: area.name,
      level: PACK_LEVELS[area.kind] ?? null,
      rings: simplifyRings(outer),
    };
  }

  return {
    /**
     * The administrative areas at a point from Overpass: {areas: [{source,
     * name, level}], from: 'overpass'}, or {areas: [], from: 'none', reason}
     * ('unconfigured' | 'failed') when it does not answer.
     */
    async areasAt(lat, lon, { signal } = {}) {
      const answer = await overpass(isInQuery(lat, lon), signal);
      if (!answer.elements)
        return { from: 'none', areas: [], reason: answer.failed };
      return {
        from: 'overpass',
        areas: areasFromIsIn(answer).map((area) => ({
          source: `osm:${area.relationId}`,
          name: area.name,
          level: area.level,
        })),
      };
    },

    /**
     * The Maryland parcels under a point: {areas: [{source, name, kind:
     * 'parcel', rings}], from: 'parcels'}, or {areas: [], from: 'none',
     * reason} ('outside' | 'failed').
     */
    async parcelsAt(lat, lon, { signal } = {}) {
      if (!inMaryland(lat, lon))
        return { from: 'none', areas: [], reason: 'outside' };
      const query = new URLSearchParams({
        lat: Number(lat).toFixed(6),
        lon: Number(lon).toFixed(6),
      }).toString();
      const answer = await parcels(query, signal);
      if (!answer.parcels)
        return { from: 'none', areas: [], reason: answer.failed };
      const areas = answer.parcels.map(parcelArea);
      for (const area of areas) rings.set(area.source, area);
      return { from: 'parcels', areas };
    },

    /** A pack's area named `query` (the fallback), as an area with its rings. */
    async packArea(query, { near = null } = {}) {
      const made = await fromPack(query, near);
      if (made) rings.set(made.source, made);
      return made;
    },

    /** A source's cutout {name, level, rings}, or null; kept for the page. */
    async cutout(source, { signal } = {}) {
      if (rings.has(source)) return rings.get(source);
      let cutout = null;
      const osm = /^osm:(\d+)$/.exec(source);
      if (osm) {
        const answer = await overpass(relationGeometryQuery(osm[1]), signal);
        const made = answer.elements
          ? cutoutFromRelationGeometry(answer)
          : null;
        if (made)
          cutout = { name: made.name, level: made.level, rings: made.rings };
      } else if (source.startsWith('pack:')) {
        cutout = await fromPack(packQuery(source.slice(5)), null);
      } else if (parseParcelSourceKey(source)) {
        const key = parseParcelSourceKey(source);
        const answer = await parcels(
          new URLSearchParams(key).toString(),
          signal,
        );
        const parcel = answer.parcels?.[0];
        if (parcel) {
          const area = parcelArea(parcel);
          cutout = { name: area.name, level: null, rings: area.rings };
        }
      }
      if (cutout) rings.set(source, cutout);
      return cutout;
    },
  };
}
