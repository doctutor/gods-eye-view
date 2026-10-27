import * as Cesium from 'cesium';
import { createTerrainRetryPolicy } from './terrainRetry.js';

/** Re:Earth / Mapterhorn ellipsoidal quantized mesh, CC BY 4.0. */
export const KEYLESS_TERRAIN_URL =
  'https://terrain.reearth.land/cesium-mesh/ellipsoid';

/**
 * Personal fork: each provider says which terrain it is (`gevTerrainId`),
 * so the HUD's camera readout knows what bounds its precision
 * (src/hud/precision.js DATA_FLOORS: world 10 m, keyless 30 m, flat).
 */
function tagged(provider, id) {
  if (provider && typeof provider === 'object') provider.gevTerrainId = id;
  return provider;
}

/** These factories are lazy: a hidden globe must not trigger terrain loading. */
export async function createWorldTerrain(accessToken, { signal } = {}) {
  accessToken = String(accessToken || '').trim();
  if (!accessToken)
    throw new Error('World terrain requires an explicit ion token');
  signal?.throwIfAborted();
  const resource = await Cesium.IonResource.fromAssetId(1, { accessToken });
  signal?.throwIfAborted();
  return {
    provider: tagged(
      await Cesium.CesiumTerrainProvider.fromUrl(resource, {
        requestVertexNormals: true,
        requestWaterMask: false,
        ellipsoid: Cesium.Ellipsoid.WGS84,
      }),
      'world',
    ),
  };
}

function logThrottle({ statusCode, delayMs, inWindow }) {
  // One line per cooldown window, not per tile: a burst throttles dozens.
  if (inWindow !== 1) return;
  console.warn(
    `[MapStack] Re:Earth terrain answered ${statusCode}; retrying throttled tiles after ${Math.round(delayMs)} ms`,
  );
}

/**
 * The Re:Earth resource with the tile retry policy attached. Cesium copies
 * `retryCallback`/`retryAttempts` onto every derived resource, so layer.json
 * and each `{z}/{x}/{y}.terrain` fetch inherit it (see `terrainRetry.js`).
 * @param {ReturnType<typeof createTerrainRetryPolicy>} [policy]
 * @returns {Cesium.Resource}
 */
export function createKeylessTerrainResource(
  policy = createTerrainRetryPolicy({ onThrottle: logThrottle }),
) {
  return new Cesium.Resource({
    url: KEYLESS_TERRAIN_URL,
    retryCallback: policy.retryCallback,
    retryAttempts: policy.retryAttempts,
  });
}

export async function createKeylessTerrain() {
  try {
    return {
      provider: tagged(
        await Cesium.CesiumTerrainProvider.fromUrl(
          createKeylessTerrainResource(),
        ),
        'keyless',
      ),
    };
  } catch (error) {
    console.warn(
      '[MapStack] Re:Earth terrain unavailable, falling back to flat ellipsoid terrain:',
      error,
    );
    return {
      provider: tagged(new Cesium.EllipsoidTerrainProvider(), 'flat'),
      fallback: true,
    };
  }
}
