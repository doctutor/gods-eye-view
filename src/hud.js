import { applicationServices } from './services/application.js';
/**
 * @module hud
 * @description Intelligence HUD Overlay — NRO/NGA Satellite Aesthetic.
 *
 * Renders a classification banner, the style mode, a rolling summary,
 * timestamps and, personal fork, the camera's real view state over the
 * Cesium canvas: position (lat/lon, DMS, MGRS, height above sea level and
 * above the surface) and pose (heading, pitch, roll, field of view), what a
 * pixel covers and the sun's elevation, each to the precision the view
 * supports and editable where it can be set (src/hud/cameraReadout.js).
 *
 * The HUD auto-activates when a military-style shader (NVG, FLIR, CRT) is
 * selected and supports three layout variants: tactical, operator, minimal.
 *
 * Color theming is driven by the active shader mode via CSS custom properties.
 */

import * as Cesium from 'cesium';
import { forward as toMGRS } from 'mgrs';
import { CITY_POIS } from './cityPois.js';
import { composeLocalityTag } from './hudLocality.js';
import { hudQuantity, LOCALIZED_LOCALITY } from './hudLocalityFormat.js';
import {
  ellipsoidalToMslDisplayM,
  ensureGeoidReady,
  geoidHeight,
} from './data/geoid.js';
import { getBasemapLabelContext } from './voice/gevActions.js';
import {
  hudSummaryMatchesProvenance,
  hudSummaryLayerContext,
  hudTelemetryProvenance,
  isHudSummaryUnconfigured,
} from './hudSummaryResponse.js';
import {
  applyHudUiTheme,
  DEFAULT_HUD_LAYOUT,
  normalizeHudLayout,
} from './hudLayouts.js';
import { formatNumber, msg, t } from './i18n/index.js';
import { localizeLayerName } from './ui/layerPanel.js';
// Personal fork: the camera readout, its precision and the view it edits.
import {
  CAMERA_FIELDS,
  FLOOR_NOTE_ID,
  attachCameraEditing,
  cameraFieldsHtml,
  editedView,
  fieldElementId,
  floorNoteText,
  formatCameraReadout,
} from './hud/cameraReadout.js';
import {
  applyCameraView,
  canvasSpanPx,
  centreDistanceM,
  readCameraView,
  surfaceHeightM,
} from './hud/cameraState.js';
import { dataFloor, pixelFootprintM, viewPrecision } from './hud/precision.js';

/** Color palettes keyed by shader mode; applied as CSS custom properties. */
const HUD_COLORS = {
  surveillance: {
    main: 'rgba(51, 255, 51, 0.8)',
    glow: 'rgba(51, 255, 51, 0.5)',
    border: 'rgba(51, 255, 51, 0.2)',
  },
  thermal: {
    main: 'rgba(255, 255, 255, 0.7)',
    glow: 'rgba(255, 255, 255, 0.4)',
    border: 'rgba(255, 255, 255, 0.15)',
  },
  retro: {
    main: 'rgba(255, 170, 0, 0.8)',
    glow: 'rgba(255, 170, 0, 0.5)',
    border: 'rgba(255, 170, 0, 0.2)',
  },
  _default: {
    main: 'rgba(0, 255, 255, 0.6)',
    glow: 'rgba(0, 255, 255, 0.4)',
    border: 'rgba(0, 255, 255, 0.15)',
  },
};

/**
 * Mode names per style: the same English as STYLE_STATUS_LABELS
 * (ui/visualPresets.js), so both translate alike.
 */
const MODE_LABELS = Object.freeze({
  normal: msg('NORMAL'),
  retro: msg('CRT'),
  surveillance: msg('NVG'),
  thermal: msg('FLIR'),
  anime: msg('ANIME'),
  noir: msg('NOIR'),
  snow: msg('SNOW'),
});

/** Region ids from _regionLabel() and the name shown for each. */
const REGION_LABELS = Object.freeze({
  ARCTIC: msg('ARCTIC'),
  ANTARCTIC: msg('ANTARCTIC'),
  'NORTH AMERICA': msg('NORTH AMERICA'),
  'SOUTH AMERICA': msg('SOUTH AMERICA'),
  EUROPE: msg('EUROPE'),
  AFRICA: msg('AFRICA'),
  ASIA: msg('ASIA'),
  OCEANIA: msg('OCEANIA'),
  'NORTHERN OCEANIC GRID': msg('NORTHERN OCEANIC GRID'),
  'SOUTHERN OCEANIC GRID': msg('SOUTHERN OCEANIC GRID'),
});

/** Feed-state ids from hudTelemetryProvenance() and the word shown for each. */
const FEED_STATE_LABELS = Object.freeze({
  loading: msg('LOADING'),
  degraded: msg('DEGRADED'),
  stale: msg('STALE'),
  partial: msg('PARTIAL'),
  fallback: msg('FALLBACK'),
  unavailable: msg('UNAVAILABLE'),
});

/**
 * The summary's feed-state suffix in the active language, e.g.
 * `UNAVAILABLE: LIVE AIS VESSELS`. State ids and layer names stay English in
 * layer data; only this line translates them.
 */
function localizedProvenanceTag(provenance) {
  if (!provenance) return null;
  const state = FEED_STATE_LABELS[provenance.state]
    ? t(FEED_STATE_LABELS[provenance.state])
    : provenance.state.toUpperCase();
  if (!provenance.names.length) return state;
  return t('{state} {layers}', {
    state,
    layers: provenance.names
      .map((name) => localizeLayerName(name).toUpperCase())
      .join('/'),
  });
}

/** The name shown for a _viewBand() id. */
function viewBandLabel(band) {
  switch (band) {
    case 'STREET':
      return t('STREET', { context: 'view band' });
    case 'CITY':
      return t('CITY', { context: 'view band' });
    case 'METRO':
      return t('METRO', { context: 'view band' });
    case 'REGIONAL':
      return t('REGIONAL', { context: 'view band' });
    default:
      return t('GLOBAL', { context: 'view band' });
  }
}

/** Shader modes that automatically show the HUD overlay. */
const MILITARY_STYLES = new Set(['retro', 'surveillance', 'thermal']);

const HUD_SUMMARY_INTERVAL_MS = 15000;

/**
 * Cell size (degrees) for the ALT readout's geoid-undulation cache. N changes
 * by well under a metre across 0.01° (~1.1 km), so one lookup per cell keeps
 * the 4 Hz telemetry tick off the EGM96 grid without a visible step.
 */
const HUD_GEOID_CELL_DEG = 0.01;

/**
 * Personal fork: the surface under the camera is sampled again at most this
 * often while the camera has left the last sample (or none answered yet:
 * sampling fails until the tiles there stream in); a sample older than
 * twice this is not shown once the camera has left it.
 */
const SURFACE_RETRY_MS = 1000;
/** A sample still stands for the camera within this many metres of it. */
const SURFACE_NEAR_M = 25;

/** Flattened list of all city POIs for nearest-point lookups. */
const NEARBY_POINTS = Object.values(CITY_POIS).flatMap((city) =>
  city.pois.map((poi) => ({
    city: city.name,
    poi: poi.name,
    lat: poi.lat,
    lon: poi.lon,
  })),
);

/**
 * Full-screen intelligence HUD overlay rendered on top of the Cesium canvas.
 *
 * Displays classification banners, MGRS/lat-lon readouts, sensor metrics
 * (GSD, NIIRS, off-nadir angle), sun elevation, orbital metadata, and a
 * rolling semantic summary line. All values derive from the live camera
 * position and update on independent timer cadences.
 */
export class IntelHUD {
  /**
   * @param {Cesium.Viewer} viewer - The Cesium Viewer instance used for
   *   camera telemetry and coordinate derivation.
   */
  constructor(
    viewer,
    {
      placeSearch,
      summaryPolicy = {},
      basemapContext = {},
      summaryService = applicationServices.summary,
      // Personal fork: what the surface under the camera is (the map stack's
      // tileset or the globe's terrain), and who to tell after an edit.
      surfaceSource = null,
      onCameraEdited = null,
    } = {},
  ) {
    this._surfaceSource =
      typeof surfaceSource === 'function'
        ? surfaceSource
        : () => ({
            tilesetShown: viewer?.scene?.globe?.show === false,
            terrainId: viewer?.terrainProvider?.gevTerrainId ?? null,
          });
    this._onCameraEdited =
      typeof onCameraEdited === 'function' ? onCameraEdited : null;
    this._surface = null;
    this._lastDistanceM = Number.NaN;
    this._cameraFields = null;
    this._cameraEditing = null;
    this.summaryService = summaryService;
    this.summaryPolicy = summaryPolicy;
    this.basemapContext = basemapContext;
    this.placeSearch = placeSearch;
    this.viewer = viewer;
    this._visible = false;
    this._autoMode = true; // auto show/hide based on style
    this._currentStyle = 'normal';
    this._el = null;
    this._variant = DEFAULT_HUD_LAYOUT;
    this._recBlinkState = true;
    this._updateInterval = null;
    this._recBlinkInterval = null;
    this._timestampInterval = null;
    this._summaryInterval = null;
    this._summaryTypingInterval = null;
    this._latestMetrics = null;
    this._dataManager = null;
    this._dataManagerUnsubscribe = null;
    this._summaryDirty = true;
    this._summaryRequest = null;
    this._lastSummarySignature = '';
    this._summaryRevision = 0;
    // One-shot guards so the very first summary lands immediately instead of
    // waiting for the 15s interval tick: B) swap the "Awaiting telemetry..."
    // placeholder for the deterministic line as soon as metrics exist, then
    // A) kick a real AI summary once the intro fly-to settles.
    this._firstMetricsShown = false;
    this._firstSummaryKicked = false;
    // ALT readout datum: the camera height Cesium reports is ELLIPSOIDAL, the
    // number a viewer reads is MSL. N comes from the same lazy ~2.7 MB EGM96
    // chunk the flight layers use — requested on the first telemetry tick of a
    // VISIBLE HUD, never at construction, so a hidden HUD costs nothing — and
    // cached per coarse cell. Until it resolves, or if it never does,
    // `ellipsoidalToMslDisplayM` passes the raw height straight through.
    this._geoidRequested = false;
    this._geoidReady = false;
    this._geoidCellKey = null;
    this._geoidN = null;
    // Whether the LAST painted tick actually had N. The grid resolves mid-
    // session, so this flips once — and both altitude readouts have to move
    // together when it does (see the repaint in _updateCameraData).
    this._geoidCorrectionApplied = false;
    this._onCameraMoveEnd = () => {
      this._markSummaryDirty();
      // Personal fork: the surface under a settled camera, sampled afresh.
      if (this._visible) this._sampleSurface();
      // The 250 ms telemetry timer and 15 s semantic-summary timer must not
      // leave the prior city on-screen after a long CCTV focus flight.
      // Refresh deterministic camera context synchronously on settle; the AI
      // summary can still upgrade it on its normal cadence.
      if (this._visible) {
        this._updateCameraData();
        this._setSummaryText(this._composeSummary(), false);
      }
      // First settled view: request the AI summary now rather than waiting for
      // the periodic tick (saves up to ~15s of "Awaiting telemetry...").
      if (!this._firstSummaryKicked && this._visible && this._latestMetrics) {
        this._firstSummaryKicked = true;
        void this._updateSummary(true, true);
      }
    };

    this._buildDOM();
    this.viewer.camera.moveEnd.addEventListener(this._onCameraMoveEnd);
    this._startTimers();
  }

  /**
   * Construct the HUD DOM structure inside the existing `#intel-hud` element.
   * Populates corner brackets, the classification banner, the camera
   * readout's two corners, the edge clock, and the bottom summary bar.
   */
  _buildDOM() {
    this._el = document.getElementById('intel-hud');
    if (!this._el) return;

    // i18n-ignore: a classification banner; the rest uses t()
    this._el.innerHTML = `
      <div class="hud-sonar" aria-hidden="true"></div>

      <div class="hud-top-bar">
        <span class="hud-top-bar-left">TOP SECRET // SI-TK // NOFORN</span>
        <span class="hud-top-bar-right">PAGE 1/1</span>
      </div>

      <div class="hud-corner hud-top-left">
        <div class="hud-bracket">┌</div>
        <div class="hud-content">
          <div class="hud-classification">TOP SECRET // SI-TK // NOFORN</div>
          <div class="hud-mode" id="hud-mode">${t(MODE_LABELS.normal)}</div>
          <div class="hud-summary-wrap">
            <div class="hud-summary-label">${t('SUMMARY')}</div>
            <div class="hud-summary" id="hud-summary">${t('Awaiting telemetry...')}</div>
          </div>
        </div>
      </div>

      <div class="hud-corner hud-top-right">
        <div class="hud-content" style="text-align:right">
          <div class="hud-rec"><span id="hud-rec-dot">●</span> ${t('REC')}  <span id="hud-timestamp">2026-01-01 00:00:00Z</span></div>
        </div>
        <div class="hud-bracket">┐</div>
      </div>

      <div class="hud-corner hud-bottom-left">
        <div class="hud-bracket">└</div>
        <div class="hud-content hud-cam" id="hud-position">${cameraFieldsHtml('position')}</div>
      </div>

      <div class="hud-corner hud-bottom-right">
        <div class="hud-content hud-cam" id="hud-pose" style="text-align:right">
          ${cameraFieldsHtml('pose')}
          <div id="hud-ais-vessel" class="hud-ais-vessel">${t('AIS: --')}</div>
        </div>
        <div class="hud-bracket">┘</div>
      </div>

      <div class="hud-edge hud-left-edge">
        <div id="hud-coll">COLL: --:--:--Z</div>
      </div>

      <div class="hud-bottom-bar">
        <span id="hud-bottom-line">LAT: --  LON: --  MGRS: ---</span>
      </div>
    `;
    this._el.dataset.variant = this._variant;
    // Personal fork: a click on an editable number opens it for typing.
    this._cameraEditing = attachCameraEditing({
      roots: [
        document.getElementById('hud-position'),
        document.getElementById('hud-pose'),
      ],
      value: (field) => this._editValue(field),
      apply: (field, value) => this._applyCameraEdit(field, value),
      onChange: () => this._updateCameraData(),
    });
  }

  /**
   * Start all periodic update timers (timestamp, REC blink, camera
   * telemetry, semantic summary). Timers run independently at different
   * cadences and are cleaned up in {@link destroy}.
   */
  _startTimers() {
    // Timestamp — every second
    this._timestampInterval = setInterval(() => {
      const el = document.getElementById('hud-timestamp');
      if (el) el.textContent = this._formatUTC();
    }, 1000);

    // REC blink — every 800ms
    this._recBlinkInterval = setInterval(() => {
      this._recBlinkState = !this._recBlinkState;
      const dot = document.getElementById('hud-rec-dot');
      if (dot)
        dot.style.visibility = this._recBlinkState ? 'visible' : 'hidden';
    }, 800);

    // Camera-derived data — 4 updates/second (250ms)
    this._updateInterval = setInterval(() => {
      if (!this._visible) return;
      this._updateCameraData();
    }, 250);

    // Semantic summary refresh cadence
    this._summaryInterval = setInterval(() => {
      if (!this._visible) return;
      void this._updateSummary(true);
    }, HUD_SUMMARY_INTERVAL_MS);
  }

  /**
   * Format the current wall-clock time as a UTC Zulu string.
   * @returns {string} Timestamp in `YYYY-MM-DD HH:MM:SSZ` format.
   */
  _formatUTC() {
    const now = new Date();
    const y = now.getUTCFullYear();
    const mo = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    const h = String(now.getUTCHours()).padStart(2, '0');
    const mi = String(now.getUTCMinutes()).padStart(2, '0');
    const s = String(now.getUTCSeconds()).padStart(2, '0');
    return `${y}-${mo}-${d} ${h}:${mi}:${s}Z`;
  }

  /**
   * Geoid undulation N at the camera subpoint, memoized per coarse cell.
   * @param {number} latDeg - Camera latitude in decimal degrees.
   * @param {number} lonDeg - Camera longitude in decimal degrees.
   * @returns {number|null} N in metres, or null while the grid is unavailable.
   */
  _geoidUndulationM(latDeg, lonDeg) {
    if (!this._geoidReady) {
      if (!this._geoidRequested) {
        this._geoidRequested = true;
        ensureGeoidReady()
          .then(() => {
            this._geoidReady = true;
          })
          .catch(() => {
            /* readout falls back to the uncorrected height */
          });
      }
      return null;
    }
    const key = `${Math.round(latDeg / HUD_GEOID_CELL_DEG)}:${Math.round(lonDeg / HUD_GEOID_CELL_DEG)}`;
    if (key !== this._geoidCellKey) {
      try {
        this._geoidN = geoidHeight(latDeg, lonDeg);
      } catch {
        this._geoidN = null;
      }
      this._geoidCellKey = key;
    }
    return Number.isFinite(this._geoidN) ? this._geoidN : null;
  }

  /**
   * Personal fork: the precision the camera is written to now: what one
   * pixel covers at the screen's centre, bounded by the surface under the
   * camera (src/hud/precision.js). The share link writes the camera at it.
   */
  cameraPrecision() {
    const view = readCameraView(this.viewer);
    const { distanceM } = centreDistanceM(this.viewer);
    this._lastDistanceM = distanceM;
    const footprintM = pixelFootprintM({
      distanceM,
      fovRad: Cesium.Math.toRadians(view?.fovDeg ?? 60),
      widthPx: canvasSpanPx(this.viewer),
    });
    let floor = null;
    try {
      floor = dataFloor(this._surfaceSource() || {});
    } catch {
      floor = dataFloor();
    }
    return viewPrecision({ footprintM, floor });
  }

  /** Personal fork: sample the rendered surface under the camera now. */
  _sampleSurface(view = readCameraView(this.viewer)) {
    if (!view) return Number.NaN;
    const heightM = surfaceHeightM(this.viewer, view.lat, view.lon);
    this._surface = {
      lat: view.lat,
      lon: view.lon,
      heightM,
      at: Date.now(),
    };
    return heightM;
  }

  /**
   * Personal fork: the surface's ellipsoidal height under the camera, NaN
   * until one answers: the last sample while the camera is near it (or it
   * is fresh), sampled again at most once a SURFACE_RETRY_MS otherwise.
   */
  _surfaceUnderCamera(view) {
    const sample = this._surface;
    const now = Date.now();
    const offM = sample
      ? this._haversineKm(sample.lat, sample.lon, view.lat, view.lon) * 1000
      : Infinity;
    const usable = sample && Number.isFinite(sample.heightM);
    if (usable && offM <= SURFACE_NEAR_M) return sample.heightM;
    if (!sample || now - sample.at >= SURFACE_RETRY_MS)
      return this._sampleSurface(view);
    return usable && now - sample.at < 2 * SURFACE_RETRY_MS
      ? sample.heightM
      : Number.NaN;
  }

  /** Personal fork: the number an edit box opens with: the one shown. */
  _editValue(field) {
    const text = this._cameraFields?.[field]?.text || '';
    return /^-?\d+(\.\d+)?/.exec(text)?.[0] || '';
  }

  /**
   * Personal fork: apply a typed number to the camera, the other numbers
   * held (src/hud/cameraReadout.js editedView); false when it does not
   * take. A field-of-view change is a view change without a camera move,
   * so the moveEnd listeners are told; the share link is told either way.
   */
  _applyCameraEdit(field, value) {
    const view = readCameraView(this.viewer);
    if (!view) return false;
    const surfaceM =
      field === 'agl' ? this._sampleSurface(view) : this._surface?.heightM;
    const next = editedView(view, field, value, {
      surfaceM,
      geoidN: this._geoidUndulationM(view.lat, view.lon),
    });
    if (!next) return false;
    try {
      applyCameraView(this.viewer, next);
    } catch (error) {
      console.warn('[HUD] camera edit not applied:', error?.message);
      return false;
    }
    if (field === 'fov') this.viewer.camera.moveEnd?.raiseEvent?.();
    this._onCameraEdited?.();
    return true;
  }

  /**
   * Derive all camera-based telemetry and push values to the DOM.
   * Personal fork: the camera readout's fields (src/hud/cameraReadout.js),
   * each to the view's precision with its tooltip, the bottom line, sun
   * elevation and the collection clock. Stores results in
   * {@link _latestMetrics}.
   */
  _updateCameraData() {
    const view = readCameraView(this.viewer);
    if (!view) return;

    const lonDeg = view.lon;
    const latDeg = view.lat;
    const altM = view.heightM;

    // Altitude — reported as height above MEAN SEA LEVEL. `altM` is the raw
    // ellipsoidal camera height, which reads far below zero wherever the geoid
    // sits under the ellipsoid: a cockpit parked on the SFO deck (N ≈ -32 m)
    // showed "ALT: -15m", and JFK "ALT: -18m". Subtracting N restores the
    // number a viewer expects without touching the camera or any render path.
    const geoidN = this._geoidUndulationM(latDeg, lonDeg);
    const altMslM = ellipsoidalToMslDisplayM(altM, geoidN);
    const sunEl = this._estimateSunElevation(latDeg, lonDeg);
    const precision = this.cameraPrecision();
    const surfaceM = this._surfaceUnderCamera(view);
    const aglM = Number.isFinite(surfaceM) ? altM - surfaceM : Number.NaN;
    const spanPx = canvasSpanPx(this.viewer);
    const fields = formatCameraReadout(
      {
        view,
        altMslM,
        geoidApplied: Number.isFinite(geoidN),
        aglM,
        footprintM: precision.footprintM,
        distanceM: this._lastDistanceM,
        sunElDeg: sunEl,
        pixelDeg: spanPx > 0 ? view.fovDeg / spanPx : Number.NaN,
      },
      precision,
      {
        mgrs: (lon, lat, digits) =>
          this._formatMGRS(toMGRS([lon, lat], digits)),
      },
    );
    this._cameraFields = fields;
    const editing = this._cameraEditing?.editing?.() ?? null;
    for (const { id } of CAMERA_FIELDS) {
      const el = document.getElementById(fieldElementId(id));
      if (!el) continue;
      el.title = fields[id].title;
      if (id !== editing) el.textContent = fields[id].text;
    }
    const floorEl = document.getElementById(FLOOR_NOTE_ID);
    if (floorEl) floorEl.textContent = floorNoteText(precision);
    const bottomEl = document.getElementById('hud-bottom-line');
    if (bottomEl) {
      // i18n-ignore: sensor codes
      bottomEl.textContent = `MGRS: ${fields.mgrs.text}  LAT: ${fields.lat.text}  LON: ${fields.lon.text}`;
    }

    // Collection timestamp
    const collEl = document.getElementById('hud-coll');
    if (collEl) {
      const now = new Date();
      const h = String(now.getUTCHours()).padStart(2, '0');
      const m = String(now.getUTCMinutes()).padStart(2, '0');
      const s = String(now.getUTCSeconds()).padStart(2, '0');
      // i18n-ignore: sensor codes
      collEl.textContent = `COLL: ${h}:${m}:${s}Z`;
    }

    // `altM` stays the raw ellipsoidal camera height the view band reads.
    // `altMslM` is the ADDITIVE display datum — the only one any readout
    // string should print.
    this._latestMetrics = {
      latDeg,
      lonDeg,
      altM,
      altMslM,
      aglM,
      sunEl,
    };

    // First time we have real telemetry: replace the "Awaiting telemetry..."
    // placeholder with the deterministic summary line instantly (no network),
    // so there's always meaningful context on screen. The AI summary upgrades
    // this within a second via the moveEnd kick / periodic refresh.
    if (!this._firstMetricsShown) {
      this._firstMetricsShown = true;
      this._setSummaryText(this._composeSummary(), false);
    }

    // The EGM96 grid lands mid-session, and the corner readout picks it up on
    // the very next telemetry tick. The summary line has no such cadence — it
    // repaints on camera settle or its own 15 s retry — so without this the
    // corner reads `ALT: 17m` beside a summary still reading `ALT -15M`, for
    // up to fifteen seconds. Repaint the deterministic line in the SAME tick
    // the correction turns on (or off, if a lookup starts failing), and mark
    // the summary dirty so the AI line refreshes on its normal cadence —
    // exactly what a camera settle already does.
    const geoidCorrectionApplied = Number.isFinite(geoidN);
    if (geoidCorrectionApplied !== this._geoidCorrectionApplied) {
      this._geoidCorrectionApplied = geoidCorrectionApplied;
      this._markSummaryDirty();
      this._setSummaryText(this._composeSummary(), false);
    }
  }

  /**
   * Insert spaces into a raw MGRS string for human-readable display.
   * @param {string} mgrs - Raw MGRS string, e.g. `"18SUJ23370716"`.
   * @returns {string} Formatted string, e.g. `"18S UJ 2337 0716"`.
   */
  _formatMGRS(mgrs) {
    // Regex captures: grid zone designator (1-2 digits + band letter),
    // 100km square ID (2 letters), numeric easting+northing (split in half).
    const match = mgrs.match(/^(\d{1,2}[A-Z])\s*([A-Z]{2})\s*(\d+)$/);
    if (!match) return mgrs;
    const [, zone, square, coords] = match;
    const half = coords.length / 2;
    const easting = coords.slice(0, half);
    const northing = coords.slice(half);
    return `${zone} ${square} ${easting} ${northing}`;
  }

  /**
   * Estimate current solar elevation angle above the horizon.
   *
   * Uses a simplified astronomical model: solar declination is approximated
   * from the day of year, and elevation is derived from the standard
   * sin(elevation) formula involving latitude, declination, and hour angle.
   *
   * @param {number} lat - Observer latitude in decimal degrees.
   * @param {number} lon - Observer longitude in decimal degrees.
   * @returns {number} Estimated sun elevation in degrees (negative = below horizon).
   */
  _estimateSunElevation(lat, lon) {
    const now = new Date();
    // Approximate local solar time by shifting UTC hours by longitude offset
    const hours = now.getUTCHours() + now.getUTCMinutes() / 60 + lon / 15;
    const solarNoon = 12;
    const hourAngle = (hours - solarNoon) * 15;
    // Solar declination approximation (~23.45 deg amplitude sinusoidal over the year)
    const declination =
      23.45 *
      Math.sin(
        Cesium.Math.toRadians(
          (360 / 365) * (now.getUTCDate() + 30 * now.getUTCMonth() - 81),
        ),
      );
    const latRad = Cesium.Math.toRadians(lat);
    const decRad = Cesium.Math.toRadians(declination);
    const haRad = Cesium.Math.toRadians(hourAngle);
    // Standard formula: sin(el) = sin(lat)*sin(dec) + cos(lat)*cos(dec)*cos(ha)
    const sinEl =
      Math.sin(latRad) * Math.sin(decRad) +
      Math.cos(latRad) * Math.cos(decRad) * Math.cos(haRad);
    // Clamp to [-1,1] to guard against floating-point drift before asin
    return Cesium.Math.toDegrees(Math.asin(Math.max(-1, Math.min(1, sinEl))));
  }

  /**
   * Classify the camera altitude into a named observation band.
   * @param {number} altM - Camera altitude in meters.
   * @returns {'STREET'|'CITY'|'METRO'|'REGIONAL'|'GLOBAL'} Band label.
   */
  _viewBand(altM) {
    if (altM < 1200) return 'STREET';
    if (altM < 5000) return 'CITY';
    if (altM < 30000) return 'METRO';
    if (altM < 250000) return 'REGIONAL';
    return 'GLOBAL';
  }

  /**
   * Return a coarse geographic region label based on lat/lon bounding boxes.
   * @param {number} lat - Latitude in decimal degrees.
   * @param {number} lon - Longitude in decimal degrees.
   * @returns {string} Region name (e.g. `"EUROPE"`, `"NORTHERN OCEANIC GRID"`).
   */
  _regionLabel(lat, lon) {
    if (lat > 72) return 'ARCTIC';
    if (lat < -60) return 'ANTARCTIC';
    if (lat >= 5 && lat <= 83 && lon >= -170 && lon <= -50)
      return 'NORTH AMERICA';
    if (lat >= -60 && lat <= 15 && lon >= -90 && lon <= -30)
      return 'SOUTH AMERICA';
    if (lat >= 34 && lat <= 72 && lon >= -25 && lon <= 45) return 'EUROPE';
    if (lat >= -35 && lat <= 38 && lon >= -20 && lon <= 55) return 'AFRICA';
    if (lat >= 5 && lat <= 80 && lon >= 45 && lon <= 180) return 'ASIA';
    if (lat >= -50 && lat <= 5 && lon >= 110 && lon <= 180) return 'OCEANIA';
    return lat >= 0 ? 'NORTHERN OCEANIC GRID' : 'SOUTHERN OCEANIC GRID';
  }

  /**
   * Compute the approximate width and height (in km) of the camera's
   * current view rectangle on the ground.
   * @param {number} latDeg - Center latitude in decimal degrees (for
   *   longitude-to-km cosine correction).
   * @returns {{ widthKm: number, heightKm: number }|null} View window
   *   dimensions, or null if the view rectangle cannot be computed.
   */
  _viewWindowKm(latDeg) {
    const rect = this.viewer.camera.computeViewRectangle();
    if (!rect) return null;
    const north = Cesium.Math.toDegrees(rect.north);
    const south = Cesium.Math.toDegrees(rect.south);
    let east = Cesium.Math.toDegrees(rect.east);
    let west = Cesium.Math.toDegrees(rect.west);
    let lonSpan = Math.abs(east - west);
    // Handle antimeridian wrap: if span exceeds 180 deg, take the shorter arc
    if (lonSpan > 180) lonSpan = 360 - lonSpan;
    const latSpan = Math.abs(north - south);
    // 111 km/deg is the approximate surface distance per degree of latitude;
    // longitude distance is scaled by cos(lat) to account for meridian convergence.
    const widthKm = Math.max(
      0,
      lonSpan * 111 * Math.cos(Cesium.Math.toRadians(latDeg)),
    );
    const heightKm = Math.max(0, latSpan * 111);
    return { widthKm, heightKm };
  }

  /**
   * Compute the great-circle distance between two geographic points
   * using the Haversine formula.
   * @param {number} lat1 - Start latitude (decimal degrees).
   * @param {number} lon1 - Start longitude (decimal degrees).
   * @param {number} lat2 - End latitude (decimal degrees).
   * @param {number} lon2 - End longitude (decimal degrees).
   * @returns {number} Distance in kilometers.
   */
  _haversineKm(lat1, lon1, lat2, lon2) {
    const toRad = (deg) => Cesium.Math.toRadians(deg);
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * Find the closest known POI to the given coordinates.
   * @param {number} latDeg - Latitude in decimal degrees.
   * @param {number} lonDeg - Longitude in decimal degrees.
   * @returns {{ city: string, poi: string, lat: number, lon: number, distKm: number }|null}
   *   Nearest point with distance, or null if no POIs are loaded.
   */
  _nearestKnownPoint(latDeg, lonDeg) {
    let best = null;
    for (const point of NEARBY_POINTS) {
      const distKm = this._haversineKm(latDeg, lonDeg, point.lat, point.lon);
      if (!best || distKm < best.distKm) {
        best = { ...point, distKm };
      }
    }
    return best;
  }

  /**
   * Build the one-line semantic summary string from the latest camera metrics.
   * Includes mode, observation band, nearest POI or lat/lon sector, region,
   * altitude, view window dimensions, sun elevation, and local timezone.
   * @returns {string} Formatted summary line for the HUD summary readout.
   */
  _composeSummary() {
    const m = this._latestMetrics;
    if (!m) return t('Awaiting telemetry...');

    const modeEl = document.getElementById('hud-mode');
    const modeLabel = modeEl?.textContent || t(MODE_LABELS.normal);
    const region = this._regionLabel(m.latDeg, m.lonDeg);
    const nearest = this._nearestKnownPoint(m.latDeg, m.lonDeg);
    const band = this._viewBand(m.altM);
    const window = this._viewWindowKm(m.latDeg);
    // Rough local timezone from longitude (15 deg per hour)
    const utcOffset = Math.round(m.lonDeg / 15);
    const localTag = `UTC${utcOffset >= 0 ? '+' : ''}${utcOffset}`;
    // Same MSL datum as the corner ALT readout — the two are on screen
    // together, so they must never disagree. The view band above deliberately
    // keeps the ellipsoidal height: its thresholds were tuned against it.
    const altDisplayM = Number.isFinite(m.altMslM) ? m.altMslM : m.altM;
    // Display only: the AI summary request carries its own context, so this
    // line is built in the active language.
    const altTag =
      altDisplayM >= 1000
        ? hudQuantity(altDisplayM / 1000, 'km', 1)
        : hudQuantity(Math.round(altDisplayM), 'm');
    const winTag = window
      ? `${hudQuantity(Math.max(1, Math.round(window.widthKm)), '')}x${hudQuantity(Math.max(1, Math.round(window.heightKm)), 'km')}`
      : t('N/A');
    // NEAR the nearest catalogued POI at metro range; otherwise the lat/lon sector.
    const localityTag = composeLocalityTag(
      nearest,
      m.latDeg,
      m.lonDeg,
      LOCALIZED_LOCALITY,
    );

    const provenance = localizedProvenanceTag(
      hudTelemetryProvenance(this._dataManager?.getAll?.() || []),
    );
    // ALT and SUN are sensor codes, as in the corner readouts.
    const line = t(
      '{mode} {band} {locality} | {region} | ALT {alt} | WINDOW {window} | SUN {sun}° | {zone}',
      {
        mode: modeLabel,
        band: viewBandLabel(band),
        locality: localityTag,
        region: REGION_LABELS[region] ? t(REGION_LABELS[region]) : region,
        alt: altTag,
        window: winTag,
        sun: formatNumber(Math.round(m.sunEl)),
        zone: localTag,
      },
    );
    return provenance ? `${line} | ${provenance}` : line;
  }

  /**
   * Animate the summary text into the DOM using a typewriter effect
   * (2 characters every 24ms).
   * @param {string} text - Full summary string to type out.
   */
  _typeSummary(text) {
    const el = document.getElementById('hud-summary');
    if (!el) return;
    clearInterval(this._summaryTypingInterval);
    let index = 0;
    el.textContent = '';
    this._summaryTypingInterval = setInterval(() => {
      index += 2;
      if (index >= text.length) {
        el.textContent = text;
        clearInterval(this._summaryTypingInterval);
        this._summaryTypingInterval = null;
        return;
      }
      el.textContent = text.slice(0, index);
    }, 24);
  }

  /**
   * Refresh the summary readout. Optionally animates the text via typewriter.
   * @param {boolean} [animate=false] - If true, types the summary character
   *   by character; otherwise sets it instantly.
   */
  async _updateSummary(animate = false, force = false) {
    const fallbackText = this._composeSummary();
    if (!this._latestMetrics) {
      this._setSummaryText(fallbackText, animate);
      return;
    }
    if (!force && !this._summaryDirty) return;
    if (this.summaryPolicy.canRequest?.() === false) return;

    const revision = this._summaryRevision;
    // Every caller invokes this as `void this._updateSummary(...)`, so nothing
    // owns the returned promise — a rejection escaping from here lands as an
    // unhandled rejection in the console. Building the context walks the live
    // scene (the view-target pick, the layer roster), so it belongs INSIDE a
    // guard rather than in front of one. A summary we cannot build is a
    // fallback line, not a crash.
    let context;
    try {
      context = await this._summaryContext();
    } catch (error) {
      console.warn('[HUD] summary context unavailable:', error);
      // Left dirty on purpose: the next periodic tick retries instead of
      // sticking on the fallback line for the rest of the session.
      this._setSummaryText(fallbackText, animate);
      return;
    }
    if (revision !== this._summaryRevision) return;
    const signature = JSON.stringify(context);
    if (!force && signature === this._lastSummarySignature) {
      this._summaryDirty = false;
      return;
    }
    if (this._summaryRequest) return;

    if (force) this._setSummaryText(fallbackText, false);
    this._summaryDirty = false;
    this._lastSummarySignature = signature;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    this._summaryRequest = controller;
    try {
      this.summaryPolicy.onRequest?.();
      const response = await this.summaryService.summarize(context, {
        signal: controller.signal,
      });
      const data = response.data;
      if (revision !== this._summaryRevision) return;
      if (isHudSummaryUnconfigured(response.status, data)) {
        this._setSummaryText(fallbackText, animate);
        return;
      }
      if (!response.ok || !data?.summary) {
        throw new Error(data?.error || `HTTP ${response.status}`);
      }
      this._setSummaryText(
        hudSummaryMatchesProvenance(data.summary, context.feedProvenance)
          ? data.summary
          : fallbackText,
        animate,
      );
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.warn('[HUD] AI summary unavailable:', error);
        // Invalidate the committed signature so the next periodic tick
        // retries instead of sticking on the fallback line forever.
        this._lastSummarySignature = null;
        this._summaryDirty = true;
      }
      this._setSummaryText(fallbackText, animate);
    } finally {
      window.clearTimeout(timeout);
      if (this._summaryRequest === controller) this._summaryRequest = null;
    }
  }

  _setSummaryText(text, animate) {
    if (animate) {
      this._typeSummary(text);
      return;
    }
    const el = document.getElementById('hud-summary');
    if (el) el.textContent = text;
  }

  async _summaryContext() {
    const labels = await getBasemapLabelContext(
      this.viewer,
      this.placeSearch,
      this.basemapContext,
    );
    const enabledLayers =
      this._dataManager
        ?.getAll?.()
        ?.filter((layer) => layer.enabled)
        .map((layer) => layer.name) || [];
    return {
      placeLabels: labels.placeLabels,
      streetLabels: labels.streetLabels,
      nearbyPlaceLabels: labels.nearbyPlaceLabels,
      enabledLayerLabels: enabledLayers,
      ...hudSummaryLayerContext(this._dataManager?.getAll?.() || []),
    };
  }

  _markSummaryDirty() {
    this._summaryDirty = true;
    this._summaryRevision++;
  }

  // ── Public API ──────────────────────────

  /**
   * React to a shader-style change. Updates the mode label, HUD color
   * scheme (via CSS custom properties), and auto-shows/hides the overlay
   * when in auto mode.
   * @param {string} styleName - Active style key (e.g. `'surveillance'`,
   *   `'thermal'`, `'retro'`, `'normal'`).
   */
  onStyleChange(styleName) {
    this._currentStyle = styleName;

    // Update mode label
    const modeEl = document.getElementById('hud-mode');
    if (modeEl) {
      modeEl.textContent = MODE_LABELS[styleName]
        ? t(MODE_LABELS[styleName])
        : styleName.toUpperCase();
    }
    // Update color scheme
    const colors = HUD_COLORS[styleName] || HUD_COLORS._default;
    if (this._el) {
      this._el.style.setProperty('--hud-color', colors.main);
      this._el.style.setProperty('--hud-glow', colors.glow);
      this._el.style.setProperty('--hud-border', colors.border);
    }

    // Auto show/hide
    if (this._autoMode) {
      if (MILITARY_STYLES.has(styleName)) {
        this.show();
      } else {
        this.hide();
      }
    }
  }

  /** Make the HUD visible and immediately refresh all readouts. */
  show() {
    this._visible = true;
    if (this._el) this._el.classList.add('active');
    this._updateCameraData(); // immediate update
    this._markSummaryDirty();
    void this._updateSummary(false, true);
  }

  /** Hide the HUD overlay. */
  hide() {
    this._visible = false;
    if (this._el) this._el.classList.remove('active');
  }

  /** Toggle HUD visibility and disable auto-mode (user override). */
  toggle() {
    if (this._visible) {
      this._autoMode = false; // user override
      this.hide();
    } else {
      this._autoMode = false;
      this.show();
    }
  }

  /**
   * Explicit HUD mode control for scene/recording playback.
   * @param {'auto'|'on'|'off'} mode - `'auto'` re-enables style-driven
   *   show/hide; `'on'`/`'off'` force visibility and disable auto-mode.
   */
  setMode(mode) {
    if (mode === 'auto') {
      this._autoMode = true;
      this.onStyleChange(this._currentStyle);
      return;
    }

    this._autoMode = false;
    if (mode === 'on') this.show();
    else this.hide();
  }

  /**
   * Switch the HUD layout variant. Falls back to `'tactical'` if the
   * name is unrecognized. Cyber also applies a coordinated skin to the full
   * application shell; leaving Cyber restores the standard shell tokens.
   * @param {string} variantName - One of `'tactical'`, `'operator'`, `'minimal'`, `'cyber'`.
   */
  setVariant(variantName) {
    this._variant = normalizeHudLayout(variantName);
    if (this._el) {
      this._el.dataset.variant = this._variant;
    }
    applyHudUiTheme(document.documentElement, this._variant);
  }

  /**
   * @returns {string} The current HUD layout variant name.
   */
  getVariant() {
    return this._variant;
  }

  /**
   * @returns {'auto'|'on'|'off'} Current HUD mode — `'auto'` when style-driven
   *   show/hide is active, otherwise the explicit visibility override.
   */
  getMode() {
    if (this._autoMode) return 'auto';
    return this._visible ? 'on' : 'off';
  }

  /** @returns {boolean} Whether the HUD is currently visible. */
  get visible() {
    return this._visible;
  }

  attachDataManager(dataManager) {
    if (this._dataManagerUnsubscribe) {
      this._dataManagerUnsubscribe();
      this._dataManagerUnsubscribe = null;
    }
    this._dataManager = dataManager || null;
    if (typeof this._dataManager?.subscribe === 'function') {
      this._dataManagerUnsubscribe = this._dataManager.subscribe((change) => {
        if (
          ['visibility', 'refresh-transition', 'refresh-cancelled'].includes(
            change?.type,
          )
        )
          this._markSummaryDirty();
      });
    }
    this._markSummaryDirty();
  }

  /** Tear down all running intervals. Call when discarding the HUD instance. */
  destroy() {
    clearInterval(this._updateInterval);
    clearInterval(this._recBlinkInterval);
    clearInterval(this._timestampInterval);
    clearInterval(this._summaryInterval);
    clearInterval(this._summaryTypingInterval);
    this._cameraEditing?.detach();
    this.viewer.camera.moveEnd.removeEventListener(this._onCameraMoveEnd);
    this._dataManagerUnsubscribe?.();
    this._summaryRequest?.abort();
  }
}
