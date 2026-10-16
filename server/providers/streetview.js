// Personal fork: Street View indoor views (Google metadata probes + local DB).
import { createIndoorDb } from './streetview/db.js';
import { createIndoorService } from './streetview/indoor.js';
import { createIndoorHandler, INDOOR_ROUTE } from './streetview/routes.js';
import { googleServerApiKey } from './places/google-key.js';
import { googleRateLimiter, requestNearbyPlaces } from './places/google.js';

let shared = null;

/** One service per process: dev and preview servers share the DB and pacing. */
function sharedService() {
  if (!shared) {
    shared = createIndoorService({
      db: createIndoorDb(),
      resolveApiKey: googleServerApiKey,
      searchNearby: requestNearbyPlaces,
    });
    shared.start();
  }
  return shared;
}

/**
 * Vite plugin: /api/streetview/indoor — find places with Google Street View
 * indoor imagery or photospheres and remember them in .gev-cache.
 */
function streetViewIndoorProxy({ service } = {}) {
  function install(middlewares) {
    const handler = createIndoorHandler({
      service: service || sharedService(),
      allowPlaces: (key) => {
        const allow = googleRateLimiter();
        return allow ? allow(key) : true;
      },
    });
    middlewares.use(INDOOR_ROUTE, handler);
  }
  return {
    name: 'streetview-indoor',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export { streetViewIndoorProxy };
