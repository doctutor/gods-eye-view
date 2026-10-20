// Personal fork: Street assets' client for the local index of Overture's
// infrastructure (/api/overture/infrastructure, built by `npm run
// overture:build -- --infrastructure`): fire hydrants, street lamps,
// traffic signals and charging stations, from OpenStreetMap through
// Overture's base theme. The Places layer's point source with this route.
import { OVERTURE_INFRASTRUCTURE_ENDPOINT } from '../../data/overtureInfrastructure.js';
import { createPointSource } from '../places/source.js';

export const INFRASTRUCTURE_CREDIT = Object.freeze({
  key: 'overture-infrastructure',
  html:
    'Street assets: <a href="https://docs.overturemaps.org/attribution/" target="_blank" rel="noopener">© OpenStreetMap contributors, Overture Maps Foundation</a> ' +
    '(<a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noopener">ODbL</a>)',
});

/** An infrastructure pin checked on the way in ({id, at, category}), or null. */
export function normalizeInfrastructurePoint(raw) {
  const id = String(raw?.id ?? '').slice(0, 80);
  if (!/^in:[\d:]+$/.test(id)) return null;
  const [lon, lat] = Array.isArray(raw?.at) ? raw.at.map(Number) : [];
  if (
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  )
    return null;
  return {
    id,
    at: [lon, lat],
    category: String(raw.category ?? '').slice(0, 20),
  };
}

/** @param {{fetchImpl?: typeof fetch}} [options] */
export const createInfrastructureSource = (options = {}) =>
  createPointSource({
    ...options,
    endpoint: OVERTURE_INFRASTRUCTURE_ENDPOINT,
    statusKey: 'infrastructure',
    categoryParam: 'class',
    withConfidence: false,
    normalize: normalizeInfrastructurePoint,
    words: 'The infrastructure index',
  });
