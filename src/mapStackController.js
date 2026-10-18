import { MapSourceController } from './maps/controller.js';
import { createDefaultMapSources } from './maps/defaultSources.js';
import { governorRequestRender } from './renderGovernor.js';
// Personal fork: the Countries basemap draws geometry as the stack settles.
import { attachCountriesBasemap } from './maps/countries/index.js';
export { MAP_STACKS } from './maps/catalog.js';
export { photorealUnavailableReason } from './maps/availability.js';

/** Preserve the standalone entry point; applications can compose the source controller directly. */
export class MapStackController extends MapSourceController {
  constructor(viewer, options = {}) {
    const googleApiKey =
      typeof window !== 'undefined' ? window.__GOOGLE_MAPS_API_KEY__ : '';
    const registry = createDefaultMapSources({ ...options, googleApiKey });
    super(viewer, {
      registry,
      initialStack: options.googleTileset
        ? options.initialStack || 'photoreal'
        : registry.defaultId,
      ...options,
      requestRender: governorRequestRender,
    });
    this.googleTileset = options.googleTileset || null;
    this.cesiumToken = String(options.cesiumToken || '').trim();
    // Personal fork: the Countries basemap renderer, for the owner's hooks
    // (setOpacity, setCountryFill, setCountryFills).
    this.countriesBasemap = attachCountriesBasemap(this, viewer, {
      requestRender: governorRequestRender,
    });
  }
  destroy() {
    this.countriesBasemap?.destroy(); // Personal fork
    this.countriesBasemap = null;
    super.destroy();
  }
  _hasPhotorealCredentials() {
    const googleKey =
      typeof window !== 'undefined' ? window.__GOOGLE_MAPS_API_KEY__ : '';
    return (
      Boolean(String(googleKey || '').trim()) ||
      Boolean(String(this.cesiumToken || '').trim())
    );
  }
}
