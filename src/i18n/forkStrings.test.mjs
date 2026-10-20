// Personal fork: every UI string the fork adds is translated in each shipped
// language, not left to fall back to English.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractMessages,
  readCatalog,
  shippedLocales,
} from '../../scripts/i18n.mjs';

/** Fork-only modules whose messages must all be translated. */
const FORK_FILES = [
  'src/ui/cctvCameraList.js',
  'src/ui/cctvEmbed.js',
  'src/ui/cctvPanelKind.js',
  'src/ui/cctvPending.js',
  'src/ui/cctvScreenshotSafe.js',
  'src/ui/cctvSources.js',
  'src/ui/recordedVideoPanel.js',
  'src/layers/cctv/audio.js',
  'src/layers/baltimoreCameras/',
  'src/layers/recordedVideo/',
  'src/layers/earthEngine/',
  'src/layers/grid/',
  'src/layers/wikipediaCoverage/',
  'src/layers/lego/',
  'src/layers/localities/',
  'src/layers/streetAssets/',
  'src/layers/places/',
  'src/layers/roads/',
  'src/layers/streetLevel/providers/googleIndoor/',
  'src/layers/rivers/reachCard.js',
  'src/layers/rivers/reachHighlight.js',
  'src/maps/keylessBasemapCatalog.js',
  'src/maps/keylessBasemaps.js',
  'src/maps/countries/',
  'src/mapStackMore.js',
];

/** The fork's markup in the CCTV panel (layer-panels.html). */
const FORK_MARKUP = [
  'Search cameras…',
  'Search cameras',
  'Cameras, nearest first',
  'HIDE WINDY',
  "Hide Windy webcams: Windy's terms forbid sharing images of them",
  'PENDING CAMS',
  'RECORDED VIDEO',
  'Search videos…',
  'Search recorded videos',
  'SEARCH AGAIN',
  "Ask YouTube again for this view (101 units of the day's budget)",
  'Recorded videos, nearest first',
  'LANDMARKS NEARBY',
  "Landmarks nearby, nearest first; a row finds videos about the place (102 units of the day's budget)",
  'SOURCES',
];

/** The fork layers' names (src/ui/layerNames.js). */
const FORK_LAYER_NAMES = [
  'Enforcement Cameras (Baltimore)',
  'CitiWatch Cameras (Baltimore)',
  'Recorded Video',
  'Terrain slope',
  'Terrain aspect',
  'Hillshade',
  'Elevation',
  'Elevation contours',
  'Forest loss',
  'Forest types',
  'Population',
  'Administrative boundaries',
  'Rivers',
  'Census tracts',
  'Inundation history',
  'Surface water',
  'Land cover',
  'Buildings',
  'Tree canopy',
  'Wikipedia coverage',
  'Localities',
  'Street assets',
  'Places',
  'Analysis',
  'Grid',
  'Reference',
];

function forkMessages() {
  const keys = new Set([...FORK_MARKUP, ...FORK_LAYER_NAMES]);
  for (const [key, { where }] of extractMessages())
    if (FORK_FILES.some((file) => where.startsWith(file))) keys.add(key);
  return [...keys];
}

const translated = (entry) =>
  typeof entry === 'string'
    ? entry.trim().length > 0
    : Boolean(entry) &&
      typeof entry === 'object' &&
      Object.values(entry).every((form) => String(form).trim().length > 0);

test('the fork has its own UI messages to check', () => {
  const keys = forkMessages();
  assert.ok(keys.length >= 140, `${keys.length} fork messages found`);
  for (const sample of [
    'HIDE WINDY',
    'camera tag|SOUND',
    'pin precision|SITE',
    'video kind|TOUR',
    'BUDGET USED',
    'probably a replay',
    'Google indoor views',
    'Recorded Video',
  ])
    assert.ok(keys.includes(sample), sample);
});

for (const locale of shippedLocales().filter((code) => code !== 'en')) {
  test(`${locale}: every fork UI string has a translation`, () => {
    const catalog = readCatalog(locale);
    const missing = forkMessages().filter((key) => !translated(catalog[key]));
    assert.deepEqual(missing, [], `${locale} lacks fork strings`);
  });
}
