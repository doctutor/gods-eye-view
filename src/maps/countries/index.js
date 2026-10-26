// Personal fork: the Countries basemap's map-source entries and its
// attachment to the map stack controller. A countries style is a globe
// stack whose ocean is the globe painted the theme's colour, with flat
// terrain; the renderer adds its own painted imagery layer at the bottom
// of the imagery layers (renderer.js) and clears it as the controller
// settles on and off the style.

import * as Cesium from 'cesium';
import { countriesBasemapRecord } from './catalog.js';
import { COUNTRY_THEMES, setCountryFill, setCountryFills } from './palette.js';
import { NATURAL_EARTH_CREDIT, createCountriesRenderer } from './renderer.js';

/**
 * The map-source registry entry for one countries descriptor.
 * @param {object} descriptor The MAP_STACKS descriptor (kind 'countries-basemap').
 * @param {{ cesium?: object }} [options]
 */
export function countriesBasemapSource(descriptor, { cesium = Cesium } = {}) {
  const record = countriesBasemapRecord(descriptor.id);
  if (!record)
    throw new TypeError(`Unknown countries basemap: ${descriptor.id}`);
  const theme = COUNTRY_THEMES[record.theme];
  return {
    descriptor,
    available: true,
    unavailableReason: null,
    // No imagery of the controller's: it paints the globe the ocean colour,
    // and the renderer adds the painted countries layer under the overlays.
    imagery: async () => null,
    globeBaseColor: cesium.Color.fromCssColorString(theme.ocean),
    // Flat terrain, shared by every countries style, as before; the next
    // imagery stack restores its own.
    terrain: {
      id: 'flat',
      create: async () => ({ provider: new cesium.EllipsoidTerrainProvider() }),
    },
    credit: NATURAL_EARTH_CREDIT,
  };
}

/**
 * Attach the renderer to a map stack controller: it draws whenever the
 * controller settles on a countries style and clears otherwise.
 * @param {object} controller MapSourceController (src/maps/controller.js).
 * @param {object} viewer
 * @param {object} [options] Renderer options (cesium, loadPack, storage, requestRender).
 */
export function attachCountriesBasemap(controller, viewer, options = {}) {
  const renderer = createCountriesRenderer({ viewer, ...options });
  const settle = (state) => {
    const record = countriesBasemapRecord(state?.activeId);
    if (record) renderer.show(record);
    else renderer.hide();
  };
  // Every setStack notifies subscribers once it settles, silent or not, so
  // the boot activation and every later switch reach the renderer.
  const unsubscribe = controller.subscribe(settle);
  return {
    renderer,
    setOpacity: (value) => renderer.setOpacity(value),
    getOpacity: () => renderer.getOpacity(),
    /** Colour one country (ISO 3166-1 alpha-2) by hand; null clears it. */
    setCountryFill,
    /** Replace every per-country colour at once, e.g. from data. */
    setCountryFills,
    /** Colour individual H3 hexes of the hex style (index → CSS colour). */
    setCellFills: (fills) => renderer.setCellFills(fills),
    getState: () => renderer.getState(),
    settled: () => renderer.settled(),
    destroy() {
      unsubscribe();
      renderer.destroy();
    },
  };
}
