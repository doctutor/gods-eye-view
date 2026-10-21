import { openSkyProxy } from './aircraft/opensky.js';
import { celestrakProxy, rocketLaunchesProxy } from './space.js';
import { tomtomProxy } from './traffic.js';
import { firmsProxy } from './firms.js';
import { terrainHeightsProxy } from './terrain.js';
import { adsbdbProxy } from './aircraft/enrichment.js';
import { overpassProxy } from './overpass.js';
import { militaryInstallationsProxy } from './military-installations.js';
import { regionalBriefProxy } from './regional/briefing.js';
import { geocodeProxy } from './regional/place.js';
import { weatherEffectsProxy } from './regional/weather-effects.js';
import { cctvProxy } from './cctv.js';
import { defaultSourceRoot } from './common/source-root.js';
import { radioBrowserProxy } from './radio.js';
import { gbfsProxy } from './gbfs.js';
import { localReceiversProxy } from './local-receivers.js';
import { transitProxy } from './transit.js';
import { adsbLolProxy } from './aircraft/adsb-lol.js';
import { aisLiveProxy } from './vessels/ais-live.js';
import { trackBackfillProxies } from './aircraft/tracks.js';
import { openAiRealtimeProxy } from './openai.js';
import { googlePlacesContextProxy } from './places.js';
import { mapillaryProxy } from './mapillary.js';
// Personal fork: Street View indoor views.
import { streetViewIndoorProxy } from './streetview.js';
// Personal fork: the Recorded Video layer.
import { recordedVideoProxy } from './recordedVideo.js';
// Personal fork: the Earth Engine overlay layers.
import { earthEngineProxy } from './earthEngine.js';
// Personal fork: the Wikipedia coverage layer.
import { wikipediaCoverageProxy } from './wikipediaCoverage.js';
// Personal fork: the Rivers layer's self-hosted HydroSHEDS v2 tiles.
import { riversV2Proxy } from './riversV2.js';
// Personal fork: clicking a river reach (the Rivers layer).
import { riverReachProxy } from './riverReach.js';
// Personal fork: the Census tracts layer's locally drawn income tiles.
import { censusProxy } from './census.js';
// Personal fork: the Localities layer's Overture places close in.
import { overtureProxy } from './overture.js';
// Personal fork: the Roads layer and Street assets' bike lanes (Overture).
import { overtureRoadsProxy } from './overtureRoads.js';
// Personal fork: the Property sales layer (realestatedataset.com records).
import { propertyProxy } from './property.js';
// Personal fork: raster values (numbers, not tiles) for the Lego mode.
import { rasterValuesProxy } from './rasterValues.js';
import { keySetupEndpoint } from '../standalone/key-setup.js';
import { weatherProxy } from './weather.js';
import { firePerimetersProxy } from './firePerimeters.js';
import { gnssIntegrityProxy } from './gnssIntegrity.js';
import { cycloneProxy } from './cyclones.js';
import { windProxy } from './wind.js';

/**
 * Construct the local provider plugins in their established order.
 * `realtime` configures the voice session token endpoint.
 */
function localProviderPlugins({ realtime } = {}) {
  return [
    openSkyProxy(),
    celestrakProxy(),
    tomtomProxy(),
    firmsProxy(),
    rocketLaunchesProxy(),
    terrainHeightsProxy(),
    adsbdbProxy(),
    overpassProxy(),
    militaryInstallationsProxy(),
    regionalBriefProxy(),
    geocodeProxy(),
    weatherEffectsProxy(),
    cctvProxy({ sourceRoot: defaultSourceRoot }),
    radioBrowserProxy(),
    gbfsProxy(),
    localReceiversProxy(),
    transitProxy(),
    adsbLolProxy(),
    aisLiveProxy(),
    trackBackfillProxies(),
    openAiRealtimeProxy({ realtime }),
    googlePlacesContextProxy(),
    windProxy(),
    weatherProxy(),
    cycloneProxy(),
    mapillaryProxy(),
    streetViewIndoorProxy(),
    recordedVideoProxy({ sourceRoot: defaultSourceRoot }),
    earthEngineProxy({ sourceRoot: defaultSourceRoot }),
    wikipediaCoverageProxy({ sourceRoot: defaultSourceRoot }),
    riversV2Proxy({ sourceRoot: defaultSourceRoot }),
    riverReachProxy({ sourceRoot: defaultSourceRoot }),
    censusProxy({ sourceRoot: defaultSourceRoot }),
    overtureProxy({ sourceRoot: defaultSourceRoot }),
    overtureRoadsProxy({ sourceRoot: defaultSourceRoot }),
    propertyProxy({ sourceRoot: defaultSourceRoot }),
    rasterValuesProxy({ sourceRoot: defaultSourceRoot }),
    firePerimetersProxy(),
    gnssIntegrityProxy(),
    keySetupEndpoint(),
  ];
}

export { localProviderPlugins };

export {
  CCTV_FRAME_FETCH_TIMEOUT_MS,
  fetchCctvImageFromUpstream,
} from './cctv.js';
export {
  createRadioProxyMiddleware,
  isPublicRadioAddress,
  normalizeRadioBrowserStation,
  publicRadioStation,
  publicRadioHttpsUrl,
} from './radio.js';
export { LL2_CACHE_TTL_MS, launchLibraryRequestHeaders } from './space.js';
export { googlePlacesContextProxy } from './places.js';
export { googleServerApiKey } from './places.js';
export { keylessGooglePlacesResponse } from './places.js';
export { keylessGoogleGeocodeResponse } from './places.js';
export { validateGeocodeAddress } from './places.js';
export { geocodeBounds } from './places.js';
export { adsbLolFallbackAnchor } from './aircraft/opensky.js';
export { readResponseTextCapped } from './common/http.js';
export { readResponseJsonCapped } from './common/http.js';
export { coalesceProxyRequest } from './common/http.js';
export { requiredFiniteQueryNumber } from './common/query.js';
export { isOverpassBoundaryQuery } from './overpass/query.js';
export { simplifyOverpassPayloadBody } from './overpass/geometry.js';
export { readOverpassDisk } from './overpass/cache.js';
export { resolveOverpassPreflight } from './overpass/cache.js';
export { overpassPayloadIsData } from './overpass/transport.js';
export { fetchOverpassPayload } from './overpass/transport.js';
export { openAiRealtimeProxy } from './openai.js';
export { MILITARY_INSTALLATION_ELEMENT_CAP } from './military-installations/constants.js';
export { quantizeMilitaryInstallationBox } from './military-installations/query.js';
export { militaryInstallationCacheKey } from './military-installations/query.js';
export { resolveMilitaryInstallationTier } from './military-installations/cache.js';
export { migrateMilitaryInstallationEntry } from './military-installations/cache.js';
export { militaryInstallationDiskFresh } from './military-installations/cache.js';
export { militaryInstallationDiskPath } from './military-installations/cache.js';
export { readMilitaryInstallationDisk } from './military-installations/cache.js';
export { writeMilitaryInstallationDisk } from './military-installations/cache.js';
export { validMilitaryInstallationBox } from './military-installations/query.js';
export { militaryInstallationFailureReason } from './military-installations/query.js';
export { validRegionalPoint } from './regional/query.js';
export { regionalBriefHasAnySource } from './regional/briefing.js';
