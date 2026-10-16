// Personal fork: camera kinds, local time and daylight, and the plain summary.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cameraLocalTime,
  cctvPanelKind,
  localTimeLine,
  panelSections,
  plainCameraSummary,
  poselessMetaText,
  probablyReplay,
  syncCctvPanelKind,
} from './cctvPanelKind.js';
import { cameraKind, isPoselessKind } from '../layers/cctv/cameraKind.js';
import {
  apparentSolarTime,
  daylightPhase,
  sunriseSunset,
} from '../data/solarDaylight.js';
import {
  _setCctvCoverageStateForTest,
  refreshCoverageStyles,
} from '../data/cctv.js';

const BALTIMORE = { lat: 39.2904, lon: -76.6122 };

const youtube = {
  id: 'yt-1',
  name: 'Inner Harbor',
  city: 'Baltimore',
  provider: 'Harbor Cams',
  ...BALTIMORE,
  feedType: 'youtube',
  embed: { provider: 'youtube', videoId: 'abcdefghijk' },
  liveStatus: 'live',
  category: 'harbor',
  coordinatesQuality: 'area',
  licenseClass: 'embed-only',
};
const windy = {
  id: 'windy-1',
  name: 'Federal Hill',
  city: 'Baltimore',
  provider: 'Windy',
  credit: 'Windy.com',
  ...BALTIMORE,
  feedType: 'image',
  sourceKind: 'windy',
  category: 'city',
  coordinatesQuality: 'site',
  licenseClass: 'display-only',
};
const osmLink = {
  id: 'osm-1',
  name: 'Zoo cam',
  city: 'Linked webcam',
  provider: 'OpenStreetMap',
  ...BALTIMORE,
  feedType: 'link',
  licenseClass: 'display-only',
  coordinatesQuality: 'site',
};
const traffic = {
  id: 'md-1',
  name: 'I-95 at Fort McHenry',
  city: 'Baltimore',
  provider: 'MDOT CHART',
  ...BALTIMORE,
  feedType: 'hls',
  headingDeg: 120,
};

/** Clock times in a fixed UTC offset. */
const at = (ms, offsetHours) =>
  new Date(ms + offsetHours * 3_600_000).toISOString().slice(11, 16);
const minutesApart = (a, b) =>
  Math.abs(
    Number(a.slice(0, 2)) * 60 +
      Number(a.slice(3)) -
      (Number(b.slice(0, 2)) * 60 + Number(b.slice(3))),
  );

test('camera kinds: embed, link, still, projected', () => {
  assert.equal(cameraKind(youtube), 'embed');
  assert.equal(cameraKind({ feedType: 'youtube' }), 'embed');
  assert.equal(cameraKind(osmLink), 'link');
  assert.equal(cameraKind(windy), 'still');
  // USGS has a surveyed bearing but is still a display-only still.
  assert.equal(
    cameraKind({
      feedType: 'image',
      headingDeg: 210,
      licenseClass: 'public-domain',
    }),
    'still',
  );
  // An NPS or linked HLS stream carries provenance: no pose either.
  assert.equal(
    cameraKind({ feedType: 'hls', licenseClass: 'public-domain' }),
    'still',
  );
  assert.equal(cameraKind(traffic), 'projected');
  assert.equal(cameraKind({ feedType: 'image', headingDeg: NaN }), 'projected');
  assert.equal(cameraKind(null), 'projected');
  assert.equal(isPoselessKind('projected'), false);
  for (const kind of ['embed', 'still', 'link'])
    assert.equal(isPoselessKind(kind), true);
  // The panel trusts the layer's panelKind, and derives it when absent.
  assert.equal(cctvPanelKind({ ...traffic, panelKind: 'still' }), 'still');
  assert.equal(cctvPanelKind({ ...windy, panelKind: 'bogus' }), 'still');
});

test('only projected cameras show the pose-only panel parts', () => {
  assert.deepEqual(panelSections('projected'), {
    calibration: true,
    poseReadouts: true,
    calibrationActions: true,
    calBadge: true,
    projection: true,
    cone: true,
    localTime: false,
  });
  for (const kind of ['embed', 'still', 'link']) {
    const sections = panelSections(kind);
    assert.equal(sections.calibration, false, kind);
    assert.equal(sections.projection, false, kind);
    assert.equal(sections.cone, false, kind);
    assert.equal(sections.localTime, true, kind);
  }
});

test('Baltimore sunrise and sunset at the solstices (NOAA, ±3 min)', () => {
  const june = sunriseSunset(2026, 6, 21, BALTIMORE.lat, BALTIMORE.lon);
  // NOAA solar calculator: 05:39 and 20:36 EDT.
  assert.ok(
    minutesApart(at(june.sunrise, -4), '05:39') <= 3,
    at(june.sunrise, -4),
  );
  assert.ok(
    minutesApart(at(june.sunset, -4), '20:36') <= 3,
    at(june.sunset, -4),
  );
  assert.equal(june.polar, null);
  const december = sunriseSunset(2026, 12, 21, BALTIMORE.lat, BALTIMORE.lon);
  // 07:21 and 16:47 EST.
  assert.ok(
    minutesApart(at(december.sunrise, -5), '07:21') <= 3,
    at(december.sunrise, -5),
  );
  assert.ok(
    minutesApart(at(december.sunset, -5), '16:47') <= 3,
    at(december.sunset, -5),
  );
  // Sydney at the March equinox: about 06:57 and 19:06 AEDT.
  const sydney = sunriseSunset(2026, 3, 20, -33.8688, 151.2093);
  assert.ok(minutesApart(at(sydney.sunrise, 11), '06:57') <= 3);
  assert.ok(minutesApart(at(sydney.sunset, 11), '19:06') <= 3);
  // Tromsø: midnight sun in June, polar night in December.
  assert.equal(sunriseSunset(2026, 6, 21, 69.65, 18.96).polar, 'day');
  assert.equal(sunriseSunset(2026, 12, 21, 69.65, 18.96).polar, 'night');
});

test('daylight phase and solar time follow the sun', () => {
  const { lat, lon } = BALTIMORE;
  assert.equal(daylightPhase(Date.UTC(2026, 5, 21, 18), lat, lon), 'day');
  assert.equal(daylightPhase(Date.UTC(2026, 5, 21, 7, 12), lat, lon), 'night');
  // 05:20 EDT, before sunrise: dawn.
  assert.equal(daylightPhase(Date.UTC(2026, 5, 21, 9, 20), lat, lon), 'dawn');
  // 20:50 EDT, after sunset: dusk.
  assert.equal(daylightPhase(Date.UTC(2026, 5, 22, 0, 50), lat, lon), 'dusk');
  // Solar noon in Baltimore on the June solstice is about 13:08 EDT.
  assert.deepEqual(apparentSolarTime(Date.UTC(2026, 5, 21, 17, 8), lon), {
    hours: 12,
    minutes: 0,
  });
});

test('local time line: solar estimate without a zone, civil time with one', () => {
  const night = Date.UTC(2026, 5, 21, 7, 12); // 03:12 EDT
  const local = cameraLocalTime(windy, night);
  assert.equal(local.solar, true);
  assert.equal(local.phase, 'night');
  assert.match(localTimeLine(windy, night), /^Local 02:0\d solar · night$/);
  const zoned = { ...windy, timeZone: 'America/New_York' };
  assert.equal(localTimeLine(zoned, night), 'Local 03:12 · night');
  assert.equal(
    localTimeLine(zoned, Date.UTC(2026, 5, 21, 18, 5)),
    'Local 14:05 · day',
  );
  assert.equal(
    localTimeLine(zoned, Date.UTC(2026, 5, 22, 0, 50)),
    'Local 20:50 · dusk',
  );
  // An unknown zone falls back to solar time.
  assert.match(
    localTimeLine({ ...windy, timeZone: 'Mars/Olympus' }, night),
    /solar/,
  );
  assert.equal(localTimeLine({ ...windy, lat: null }, night), '');
});

test('a live embed at night is probably a replay', () => {
  const zoned = { ...youtube, timeZone: 'America/New_York' };
  const night = Date.UTC(2026, 5, 21, 7, 12);
  const day = Date.UTC(2026, 5, 21, 18, 5);
  assert.equal(
    localTimeLine(zoned, night),
    'Local 03:12 · night · probably a replay',
  );
  assert.equal(localTimeLine(zoned, day), 'Local 14:05 · day');
  assert.equal(
    probablyReplay({ ...youtube, liveStatus: 'offline' }, { phase: 'night' }),
    false,
  );
  assert.equal(probablyReplay(windy, { phase: 'night' }), false);
  assert.equal(probablyReplay(youtube, { phase: 'dusk' }), false);
});

test('poseless meta: place, category, precision, operator; local time below', () => {
  const zoned = { ...windy, timeZone: 'America/New_York' };
  assert.equal(
    poselessMetaText(zoned, Date.UTC(2026, 5, 21, 18, 5)),
    'Baltimore · CITY · PIN AT SITE · Windy · Windy.com\nLocal 14:05 · day',
  );
  assert.ok(!/HDG|FOV|RANGE/.test(poselessMetaText(windy)));
});

test('plain summary for poseless cameras; projected keeps the layer summary', () => {
  const zoned = { ...youtube, timeZone: 'America/New_York' };
  assert.equal(
    plainCameraSummary(zoned, Date.UTC(2026, 5, 21, 7, 12)),
    'Live stream: Inner Harbor, Baltimore. Harbor camera, pinned to the area. ' +
      'Operator: Harbor Cams. Local time 03:12, night — probably a replay.',
  );
  assert.equal(
    plainCameraSummary(
      { ...windy, timeZone: 'America/New_York' },
      Date.UTC(2026, 5, 21, 18, 5),
    ),
    'Still camera: Federal Hill, Baltimore. City camera, pinned at the site. ' +
      'Operator: Windy. Local time 14:05, day.',
  );
  assert.match(
    plainCameraSummary(osmLink, Date.UTC(2026, 5, 21, 18, 5)),
    /^Webcam link: Zoo cam, Linked webcam\. Pinned at the site\. Operator: OpenStreetMap\. Local time \d\d:\d\d \(solar\), day\.$/,
  );
  assert.equal(plainCameraSummary(traffic), null);
  assert.ok(!/HDG|COVERAGE|CAL /.test(plainCameraSummary(windy)));
});

test('the panel is tagged with a poseless kind and gets the plain wording', () => {
  const panel = { dataset: {} };
  const meta = { textContent: 'HDG 120° · FOV 60°' };
  const controls = { _cctvPanel: panel, _cctvMeta: meta };
  const now = Date.UTC(2026, 5, 21, 18, 5);
  const summary = syncCctvPanelKind(controls, {
    enabled: true,
    activeCamera: { ...windy, panelKind: 'still' },
    now,
  });
  assert.equal(panel.dataset.cameraKind, 'still');
  assert.match(meta.textContent, /^Baltimore · CITY · PIN AT SITE/);
  assert.match(summary, /^Still camera: Federal Hill/);

  const projected = syncCctvPanelKind(controls, {
    enabled: true,
    activeCamera: { ...traffic, panelKind: 'projected' },
    now,
  });
  assert.equal(projected, null);
  assert.equal('cameraKind' in panel.dataset, false);

  syncCctvPanelKind(controls, { enabled: true, activeCamera: youtube, now });
  assert.equal(panel.dataset.cameraKind, 'embed');
  syncCctvPanelKind(controls, { enabled: false, activeCamera: youtube, now });
  assert.equal('cameraKind' in panel.dataset, false);
});

test('poseless cameras draw no cone, viewshed volume or monitor plane', () => {
  const pose = {
    lat: 30.2672,
    lon: -97.7431,
    headingDeg: 41,
    pitchDeg: -5,
    fovDeg: 56,
    rangeM: 210,
    mountHeightM: 100,
    groundElevationM: 0,
  };
  const viewer = { entities: { add: (entity) => entity } };
  const planes = [];
  const record = (id, extra) => ({
    camera: { ...pose, id, ...extra },
    coverageEntities: [],
    projection: { planeEntity: { show: true }, id },
  });
  const still = record('still-cam', {
    feedType: 'image',
    licenseClass: 'display-only',
  });
  const posed = record('posed-cam', { feedType: 'image' });
  try {
    for (const active of [still, posed]) {
      _setCctvCoverageStateForTest({
        viewer,
        records: [active],
        activeCameraId: active.camera.id,
        coverageMode: 'viewshed',
        showProjection: true,
      });
      refreshCoverageStyles();
      planes.push(active.projection.planeEntity.show);
    }
    assert.ok(
      still.coverageEntities.every((entity) => !entity.show),
      'the still camera shows no cone',
    );
    assert.equal(still.viewshedPrimitive ?? null, null);
    assert.ok(posed.coverageEntities.length > 0);
    assert.ok(posed.coverageEntities.every((entity) => entity.show));
    assert.deepEqual(planes, [false, true]);
  } finally {
    _setCctvCoverageStateForTest({ enabled: false });
  }
});
