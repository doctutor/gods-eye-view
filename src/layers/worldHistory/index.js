/**
 * Personal fork: the World history layer. Any year from 2500 BC to 2025
 * AD, as Cottereau's video "History of the World: Every Year" shows it
 * (its labels matched to Cliopatria's polities), or every Cliopatria
 * polity alive that year; and a comparison list of polities, each at its
 * largest or as at the year, in strong colours whose overlaps mix.
 *
 * - Fills: two imagery layers painted from the served polygons
 *   (./painter.js) on the imagery host (the globe, or the Google 3D
 *   tiles; resolveImageryHost, as the draped overlays use), the list's
 *   above the year's. The list's layer alpha is the panel's opacity.
 * - Names: 'label' entries on the world overlay (so the Titles toggle
 *   hides them), thinned by area against the camera's height.
 * - A click on a polity (or its name) opens a card; the panel shows its
 *   Wikipedia link. A second click on the same spot opens the card of what
 *   lies under it.
 * - The PRIVATE Cottereau borders overlay (./borders.js), only where its
 *   route answers: his drawn borders for the slider's year (the sample at
 *   or before it) as light outlines, as fills in his colours, or where he
 *   and Cliopatria disagree, in a third imagery layer above the other two
 *   with its own opacity; his labels on request; a click on one of his
 *   regions opens its card (his label, the matched Cliopatria polity, the
 *   IoU, the flags, the sample's year), and a Cliopatria card gives the
 *   IoU of his polities matched to it.
 *
 * The state lives in ./store.js (and the share link's `wh`); the answers
 * come from the app's routes (./source.js).
 */
import * as Cesium from 'cesium';
import { resolveImageryHost } from '../../maps/imageryHost.js';
import { activeLuminance, resolveInk } from '../../maps/ink.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  CLIOPATRIA_URL,
  LIST_PALETTE,
  cliopatriaYear,
  clampYear,
  polityColor,
  polygonsContain,
} from '../../data/worldHistory.js';
import {
  createWorldHistoryImageryProvider,
  paintDifferences,
} from './painter.js';
import {
  bordersCardDetails,
  cardDetails,
  matchLines,
  regionTitle,
} from './presentation.js';
import {
  CLIOPATRIA_ONLY,
  COTTEREAU_ONLY,
  DIFFERENCE_ALPHA,
  bordersShapes,
  differencePairs,
  matchesFor,
  regionAt,
} from './borders.js';

export const WORLD_HISTORY_LAYER_ID = 'world-history';
/** The world overlay's source for the names and the card. */
export const WORLD_HISTORY_OVERLAY = 'world-history';
/** The year view's fill alpha and the list's (before the panel's opacity). */
export const YEAR_FILL_ALPHA = 0.42;
export const LIST_FILL_ALPHA = 0.55;
/** At most this many year names at once; the largest first. */
export const MAX_YEAR_LABELS = 120;
/** A polity is named when its size (√area) is this share of the camera's height. */
export const LABEL_SIZE_SHARE = 0.025;
/** A year typed or dragged is drawn once it has stood this long (ms). */
export const YEAR_SETTLE_MS = 140;

export const WORLD_HISTORY_CREDIT = Object.freeze({
  key: 'world-history',
  html: `World history: polities from <a href="${CLIOPATRIA_URL}" target="_blank" rel="noopener">Cliopatria (Seshat Global History Databank)</a>, <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>, simplified; which polities show, and their names, after Cottereau's "History of the World: Every Year"`,
});

const INK = Object.freeze({ light: '#ffffff', dark: '#1a1a1a' });
const hex = ([r, g, b]) =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/**
 * @param {{store: object, source: object, borders?: object, cesium?: object,
 *   overlayHost?: object, hitTest?: Function, requestRender?: Function,
 *   credits?: {register?: Function}, setTimeoutImpl?: Function,
 *   clearTimeoutImpl?: Function, createCanvas?: Function}} options
 *   `borders` the Cottereau borders source (./borders.js); without it the
 *   overlay is never offered.
 */
export function createWorldHistoryLayer({
  store,
  source,
  borders = null,
  cesium = Cesium,
  overlayHost = null,
  hitTest = null,
  requestRender = () => {},
  credits = null,
  setTimeoutImpl = (...args) => setTimeout(...args),
  clearTimeoutImpl = (...args) => clearTimeout(...args),
  createCanvas = null,
}) {
  let viewer = null;
  let controller = null;
  let enabled = false;
  let unsubscribeMap = null;
  let unsubscribeStore = null;
  let offMove = null;
  let handler = null;
  let rowListener = null;
  const panelListeners = new Set();

  let collection = null;
  let yearLayer = null;
  let listLayer = null;
  let yearKey = '';
  let listKey = '';
  /** The year view's answers by level, for the key drawn. */
  let yearAnswers = new Map();
  let yearState = { key: '', state: 'idle', error: '', count: 0 };
  /** name -> {key, state, record} at level 0, for the panel, names and clicks. */
  const entries = new Map();
  let selected = null;
  let settleTimer = null;
  let notBuilt = false;

  /** The Cottereau borders overlay: its status, its sample, its layer. */
  let bordersInfo = null;
  let bordersProbing = false;
  let bordersState = { year: null, state: 'idle', sample: null, error: '' };
  let bordersLayer = null;
  let bordersKey = '';

  const notify = () => {
    for (const listener of [...panelListeners]) {
      try {
        listener();
      } catch {
        /* the panel's problem */
      }
    }
    try {
      rowListener?.();
    } catch {
      /* the row's problem */
    }
  };

  const yearKeyOf = (state) =>
    `${state.year}|${state.mode}|${state.mode === 'cottereau' && state.places ? 1 : 0}`;
  const extentOf = (entry, year) =>
    entry.extent === 'year' ? cliopatriaYear(year) : 'max';
  const entryKey = (entry, year) => `${entry.name}|${extentOf(entry, year)}`;

  function imageryHost() {
    if (!controller)
      return viewer?.imageryLayers
        ? { collection: viewer.imageryLayers, kind: 'globe' }
        : { collection: null, kind: 'none' };
    return resolveImageryHost({
      viewer,
      tileset: controller.getImageryHostTileset?.() || null,
    });
  }

  function removeLayer(layer) {
    if (!layer || !collection) return;
    try {
      collection.remove(layer, true);
    } catch {
      /* gone with its tileset or the viewer */
    }
  }

  function unmount() {
    removeLayer(bordersLayer);
    removeLayer(listLayer);
    removeLayer(yearLayer);
    bordersLayer = null;
    listLayer = null;
    yearLayer = null;
    collection = null;
    yearKey = '';
    listKey = '';
    bordersKey = '';
    requestRender('world-history-hide');
  }

  const providerOptions = () => ({
    cesium,
    ...(createCanvas ? { createCanvas } : {}),
  });

  // ── The year view ────────────────────────────────────────────────────

  function yearShapes(state, lod) {
    return source
      .year(state.year, { mode: state.mode, places: state.places, lod })
      .then((answer) => {
        if (yearKeyOf(state) === yearState.key) yearAnswers.set(lod, answer);
        return answer.polities.map((p) => ({
          polygons: p.polygons,
          box: p.box,
          fill: polityColor(p.name),
          fillAlpha: YEAR_FILL_ALPHA,
          stroke: polityColor(p.name),
          strokeAlpha: 0.9,
          strokeWidth: 1,
        }));
      });
  }

  /** Ask for the year's coarse answer; the layer swaps once it is here. */
  function loadYear() {
    const state = store.get();
    const key = yearKeyOf(state);
    if (yearState.key === key && yearState.state !== 'failed') return;
    yearState = { key, state: 'loading', error: '', count: 0 };
    yearAnswers = new Map();
    notify();
    source
      .year(state.year, { mode: state.mode, places: state.places, lod: 0 })
      .then((answer) => {
        if (yearState.key !== key) return;
        notBuilt = false;
        yearAnswers.set(0, answer);
        yearState = {
          key,
          state: 'ready',
          error: '',
          count: answer.polities.length,
          cliopatriaYear: answer.cliopatriaYear,
        };
        mount();
        drawNames();
        notify();
      })
      .catch((error) => {
        if (yearState.key !== key) return;
        notBuilt = error?.status === 503;
        yearState = {
          key,
          state: notBuilt ? 'not-built' : 'failed',
          error: String(error?.message || error).slice(0, 200),
          count: 0,
        };
        notify();
      });
  }

  // ── The list ─────────────────────────────────────────────────────────

  function listShapes(list, year, lod) {
    return Promise.all(
      list
        .filter((entry) => entry.visible)
        .map((entry) =>
          source
            .polity(entry.name, { extent: extentOf(entry, year), lod })
            .then((answer) => {
              if (!answer) return null;
              const colour = LIST_PALETTE[entry.color % LIST_PALETTE.length];
              return {
                polygons: answer.record.polygons,
                box: answer.record.box,
                fill: colour,
                fillAlpha: LIST_FILL_ALPHA,
                stroke: colour,
                strokeAlpha: 1,
                strokeWidth: 2,
              };
            })
            .catch(() => null),
        ),
    ).then((shapes) => shapes.filter(Boolean));
  }

  /** Each entry's coarse answer, for the panel's row, its name and clicks. */
  function loadEntries() {
    const { list, year } = store.get();
    const names = new Set(list.map((entry) => entry.name));
    for (const name of [...entries.keys()])
      if (!names.has(name)) entries.delete(name);
    for (const entry of list) {
      const key = entryKey(entry, year);
      const known = entries.get(entry.name);
      if (known?.key === key && known.state !== 'failed') continue;
      entries.set(entry.name, { key, state: 'loading', record: null });
      source
        .polity(entry.name, { extent: extentOf(entry, year), lod: 0 })
        .then((answer) => {
          if (entries.get(entry.name)?.key !== key) return;
          entries.set(entry.name, {
            key,
            state: answer ? 'ready' : 'absent',
            record: answer?.record || null,
            from: answer?.from,
            to: answer?.to,
          });
          drawNames();
          notify();
        })
        .catch(() => {
          if (entries.get(entry.name)?.key !== key) return;
          entries.set(entry.name, { key, state: 'failed', record: null });
          notify();
        });
    }
  }

  // ── The Cottereau borders overlay ────────────────────────────────────

  /** Whether the overlay draws: its route answers, is built, and it is on. */
  const bordersOn = () =>
    enabled &&
    store.bordersAvailable?.() === true &&
    bordersInfo?.built === true &&
    store.get().borders?.on === true;

  /** Ask once whether the private route answers (none: never offered). */
  function probeBorders(again = false) {
    if (!borders) {
      store.setBordersAvailable?.(false);
      return;
    }
    if (bordersProbing || (bordersInfo && !again)) return;
    bordersProbing = true;
    Promise.resolve()
      .then(() => borders.status())
      .catch(() => ({ available: false }))
      .then((info) => {
        bordersProbing = false;
        bordersInfo = info?.available ? info : { available: false };
        store.setBordersAvailable?.(bordersInfo.available === true);
        loadBorders();
        mount();
        notify();
      });
  }

  /** The slider year's sample; the one drawn stays until the next is here. */
  function loadBorders() {
    if (!bordersOn()) return;
    const year = store.get().year;
    if (bordersState.year === year && bordersState.state !== 'failed') return;
    bordersState = { ...bordersState, year, state: 'loading', error: '' };
    notify();
    borders
      .year(year)
      .then((sample) => {
        if (bordersState.year !== year) return;
        bordersState = {
          year,
          state: sample ? 'ready' : 'none',
          sample,
          error: '',
        };
        mount();
        drawNames();
        notify();
      })
      .catch((error) => {
        if (bordersState.year !== year) return;
        bordersState = {
          year,
          state: 'failed',
          sample: null,
          error: String(error?.message || error).slice(0, 200),
        };
        mount();
        notify();
      });
  }

  /** The sample drawn now, or null. */
  const drawnSample = () => (bordersOn() ? bordersState.sample : null);

  function bordersProvider(sample, mode) {
    if (mode !== 'differences') {
      const shapes = bordersShapes(sample, mode);
      return createWorldHistoryImageryProvider({
        shapes: () => shapes,
        ...providerOptions(),
      });
    }
    const year = clampYear(sample.year);
    return createWorldHistoryImageryProvider({
      shapes: (lod) =>
        source
          .year(year, { mode: 'all', places: false, lod })
          .then((answer) => differencePairs(sample, answer.polities)),
      paint: (context, pairs, rect, options) =>
        paintDifferences(context, pairs, rect, {
          ...options,
          onlyA: COTTEREAU_ONLY,
          onlyB: CLIOPATRIA_ONLY,
          alpha: DIFFERENCE_ALPHA,
        }),
      ...providerOptions(),
    });
  }

  // ── On the scene ─────────────────────────────────────────────────────

  /** The imagery layers to match the state, the year's once it is loaded. */
  function mount() {
    if (!enabled || !viewer) {
      unmount();
      return;
    }
    const host = imageryHost();
    if (!host.collection) {
      unmount();
      return;
    }
    if (host.collection !== collection) unmount();
    collection = host.collection;
    const state = store.get();
    const key = yearKeyOf(state);
    if (
      yearState.key === key &&
      yearState.state === 'ready' &&
      key !== yearKey
    ) {
      const shapesFor = (lod) => yearShapes(state, lod);
      const next = new cesium.ImageryLayer(
        createWorldHistoryImageryProvider({
          shapes: shapesFor,
          ...providerOptions(),
        }),
        { alpha: 1 },
      );
      // Under the list and the borders overlay, whichever is lower.
      const above = [listLayer, bordersLayer]
        .map((l) => (l ? collection.indexOf(l) : -1))
        .filter((i) => i >= 0);
      if (above.length) collection.add(next, Math.min(...above));
      else collection.add(next);
      removeLayer(yearLayer);
      yearLayer = next;
      yearKey = key;
    }
    const shown = state.list.filter((entry) => entry.visible);
    const nextListKey = shown
      .map((e) => `${entryKey(e, state.year)}|${e.color}`)
      .join('~');
    if (nextListKey !== listKey) {
      removeLayer(listLayer);
      listLayer = null;
      if (shown.length) {
        const list = state.list;
        const year = state.year;
        listLayer = new cesium.ImageryLayer(
          createWorldHistoryImageryProvider({
            shapes: (lod) => listShapes(list, year, lod),
            ...providerOptions(),
          }),
          { alpha: state.opacity },
        );
        // Under the borders overlay: it stands on its own above both.
        const over = bordersLayer ? collection.indexOf(bordersLayer) : -1;
        if (over >= 0) collection.add(listLayer, over);
        else collection.add(listLayer);
      }
      listKey = nextListKey;
    }
    if (listLayer) listLayer.alpha = state.opacity;
    const sample = drawnSample();
    const nextBordersKey = sample
      ? `${sample.index}|${state.borders.mode}`
      : '';
    if (nextBordersKey !== bordersKey) {
      removeLayer(bordersLayer);
      bordersLayer = null;
      if (sample) {
        bordersLayer = new cesium.ImageryLayer(
          bordersProvider(sample, state.borders.mode),
          { alpha: state.borders.opacity },
        );
        collection.add(bordersLayer);
      }
      bordersKey = nextBordersKey;
    }
    if (bordersLayer) bordersLayer.alpha = state.borders.opacity;
    credits?.register?.(viewer, WORLD_HISTORY_CREDIT);
    requestRender('world-history');
  }

  const cameraHeight = () => {
    const height = viewer?.camera?.positionCartographic?.height;
    return Number.isFinite(height) ? height : 2e7;
  };

  /** The names on the overlay: the list's, the year's (thinned), the card. */
  function drawNames() {
    if (!enabled || !overlayHost) return;
    const accent =
      INK[resolveInk('auto', activeLuminance(controller))] || INK.light;
    const at = ([lon, lat]) => cesium.Cartesian3.fromDegrees(lon, lat, 0);
    const out = [];
    const state = store.get();
    for (const entry of state.list) {
      const known = entries.get(entry.name);
      if (!entry.visible || !known?.record?.label) continue;
      out.push({
        id: `l:${entry.name}`,
        variant: 'label',
        position: at(known.record.label),
        title: entry.name,
        details: [],
        accent: hex(LIST_PALETTE[entry.color % LIST_PALETTE.length]),
        priority: 500,
        collisionGroup: 'world-history',
        interactive: true,
        accessibilityLabel: entry.name,
        horizonCull: true,
        terrainOcclusion: false,
        gapPx: 4,
        placement: 'above',
      });
    }
    const answer = yearAnswers.get(0);
    if (answer && yearState.state === 'ready') {
      const height = cameraHeight();
      const named = answer.polities
        .filter(
          (p) => Math.sqrt(p.area || 0) * 1000 >= height * LABEL_SIZE_SHARE,
        )
        .slice(0, MAX_YEAR_LABELS);
      for (const p of named) {
        const point = p.at || p.label;
        if (!point) continue;
        out.push({
          id: `y:${p.id}`,
          variant: 'label',
          position: at(point),
          title: p.title || p.name,
          details: [],
          accent,
          priority: Math.round(Math.log10((p.area || 0) + 1) * 40),
          collisionGroup: 'world-history',
          interactive: true,
          accessibilityLabel: p.title || p.name,
          horizonCull: true,
          terrainOcclusion: false,
          gapPx: 4,
          placement: 'above',
        });
      }
    }
    const sample = drawnSample();
    if (sample && state.borders.labels) {
      const height = cameraHeight();
      const named = sample.polities
        .filter(
          (p) =>
            p.at &&
            Math.sqrt(p.areaKm2 || 0) * 1000 >= height * LABEL_SIZE_SHARE,
        )
        .sort((a, b) => (b.areaKm2 || 0) - (a.areaKm2 || 0))
        .slice(0, MAX_YEAR_LABELS);
      for (const p of named)
        out.push({
          id: `c:${sample.index}:${p.track ?? p.label}`,
          variant: 'label',
          position: at(p.at),
          title: p.label,
          details: [],
          accent: INK.light,
          priority: Math.round(Math.log10((p.areaKm2 || 0) + 1) * 40) + 1,
          collisionGroup: 'world-history',
          interactive: true,
          accessibilityLabel: p.label,
          horizonCull: true,
          terrainOcclusion: false,
          gapPx: 4,
          placement: 'below',
        });
    }
    if (selected) {
      out.push({
        id: 'card',
        variant: 'card',
        position: at([selected.lon, selected.lat]),
        title: selected.title,
        details: selectedDetails(),
        accent,
        priority: 1000,
        protected: true,
        collisionGroup: 'world-history-card',
        interactive: false,
        horizonCull: true,
        terrainOcclusion: false,
        gapPx: 12,
        placement: 'above',
        accessibilityLabel: selected.title,
      });
    }
    try {
      overlayHost.setEntries(WORLD_HISTORY_OVERLAY, out, { moving: false });
    } catch (error) {
      console.warn('[World history] names not drawn:', error?.message);
    }
    requestRender('world-history-names');
  }

  /** The selected card's lines: a Cottereau region's, or a polity's with his IoU. */
  function selectedDetails() {
    if (selected.kind === 'cottereau')
      return bordersCardDetails(selected.record, {
        sampleYear: selected.sampleYear,
      });
    const lines = cardDetails(selected.record, { title: selected.title });
    const extra = matchLines(matchesFor(drawnSample(), selected.record.name));
    // His IoU before the credit line.
    lines.splice(lines.length - 1, 0, ...extra);
    return lines;
  }

  /** The best decoded answer drawn for the year: the finest level here. */
  const finestYear = () =>
    yearAnswers.get(2) || yearAnswers.get(1) || yearAnswers.get(0) || null;

  /**
   * What is under a point, topmost first: a Cottereau region (the overlay
   * is on top), the list's entries (the last added on top), the smallest
   * of the year's polities.
   */
  function hitsAt(lon, lat) {
    const out = [];
    const sample = drawnSample();
    const region = sample ? regionAt(sample, lon, lat) : null;
    if (region)
      out.push({
        record: region,
        title: regionTitle(region),
        kind: 'cottereau',
        sampleYear: sample.year,
      });
    const { list } = store.get();
    for (const entry of [...list].reverse()) {
      const record = entries.get(entry.name)?.record;
      if (entry.visible && record && polygonsContain(record.polygons, lon, lat))
        out.push({ record, title: entry.name, kind: 'list' });
    }
    const answer = finestYear();
    const smallest = (answer?.polities || [])
      .filter((p) => polygonsContain(p.polygons, lon, lat))
      .sort((a, b) => (a.area || 0) - (b.area || 0))[0];
    if (smallest)
      out.push({
        record: smallest,
        title: smallest.title || smallest.name,
        kind: 'year',
      });
    return out;
  }

  const sameHit = (a, b) =>
    !!a && !!b && a.kind === b.kind && a.record === b.record;

  /** The topmost hit; the next one down when the topmost is open already. */
  function polityAt(lon, lat) {
    const hits = hitsAt(lon, lat);
    if (!hits.length) return null;
    const open = hits.findIndex((hit) => sameHit(hit, selected));
    return open >= 0 ? hits[(open + 1) % hits.length] : hits[0];
  }

  function select(hit, lon, lat) {
    selected = hit ? { ...hit, lon, lat } : null;
    drawNames();
    notify();
  }

  function pickDegrees(position) {
    try {
      const hit = viewer?.camera?.pickEllipsoid?.(
        new cesium.Cartesian2(position.x, position.y),
      );
      if (!hit) return null;
      const point = cesium.Cartographic.fromCartesian(hit);
      return {
        lon: cesium.Math.toDegrees(point.longitude),
        lat: cesium.Math.toDegrees(point.latitude),
      };
    } catch {
      return null;
    }
  }

  /** A click: a polity's name or fill opens its card; elsewhere closes it. */
  function onClick(position) {
    if (!enabled || !position || !isPointerFree()) return;
    const hit = hitTest?.(position.x, position.y, {
      sourceId: WORLD_HISTORY_OVERLAY,
    });
    if (hit?.entryId === 'card') return;
    const point = pickDegrees(position);
    if (!point) {
      if (selected) select(null);
      return;
    }
    const found = polityAt(point.lon, point.lat);
    if (found) return select(found, point.lon, point.lat);
    if (selected) select(null);
  }

  function attachInput() {
    if (!viewer?.scene?.canvas || !cesium.ScreenSpaceEventHandler) return;
    if (!handler) {
      try {
        handler = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        handler.setInputAction(
          (movement) => onClick(movement.position),
          cesium.ScreenSpaceEventType.LEFT_CLICK,
        );
      } catch {
        handler = null;
      }
    }
    if (!offMove && viewer.camera?.moveEnd?.addEventListener) {
      const off = viewer.camera.moveEnd.addEventListener(drawNames);
      offMove =
        typeof off === 'function'
          ? off
          : () => viewer?.camera?.moveEnd?.removeEventListener?.(drawNames);
    }
  }

  function detachInput() {
    try {
      handler?.destroy();
    } catch {
      /* gone with the scene */
    }
    handler = null;
    offMove?.();
    offMove = null;
  }

  /** The state changed: the year after it settles, the list at once. */
  function onStore() {
    if (!enabled) return notify();
    const state = store.get();
    if (yearKeyOf(state) !== yearState.key) {
      if (settleTimer) clearTimeoutImpl(settleTimer);
      settleTimer = setTimeoutImpl(() => {
        settleTimer = null;
        if (!enabled) return;
        loadYear();
        loadBorders();
      }, YEAR_SETTLE_MS);
    } else loadBorders();
    loadEntries();
    mount();
    drawNames();
    notify();
  }

  const layer = {
    id: WORLD_HISTORY_LAYER_ID,
    name: 'World history',
    icon: '⌛',
    source: 'Cliopatria (Seshat) · after Cottereau',
    updateInterval: 0,

    init(nextViewer) {
      viewer = nextViewer;
    },

    enable(nextViewer) {
      viewer = nextViewer || viewer;
      enabled = true;
      unsubscribeStore ||= store.subscribe(onStore);
      store.setEnabled(true);
      overlayHost?.setVisible?.(WORLD_HISTORY_OVERLAY, true);
      attachInput();
      probeBorders();
      loadYear();
      loadEntries();
      loadBorders();
      mount();
      drawNames();
      notify();
    },

    disable() {
      enabled = false;
      if (settleTimer) clearTimeoutImpl(settleTimer);
      settleTimer = null;
      store.setEnabled(false);
      selected = null;
      unmount();
      detachInput();
      overlayHost?.clearSource?.(WORLD_HISTORY_OVERLAY);
      overlayHost?.setVisible?.(WORLD_HISTORY_OVERLAY, false);
      notify();
    },

    async update() {
      // Nothing on a clock; `false` here would read as a refused enable.
      return enabled;
    },

    destroy() {
      this.disable();
      unsubscribeStore?.();
      unsubscribeStore = null;
      unsubscribeMap?.();
      unsubscribeMap = null;
      controller = null;
      viewer = null;
      rowListener = null;
      panelListeners.clear();
    },

    /** Every settled map switch: the fills follow the imagery host. */
    attachMapStackController(next) {
      unsubscribeMap?.();
      unsubscribeMap = null;
      controller = next || null;
      const off = controller?.subscribe?.(() => {
        if (!enabled) return;
        mount();
        drawNames();
      });
      unsubscribeMap = typeof off === 'function' ? off : null;
      if (enabled) mount();
    },

    /**
     * The layer is local-only, so the data manager never restores it: a
     * share link's `wh` that says on turns it on once the page is up.
     */
    attachDataManager(manager) {
      if (!store.get().enabled || typeof manager?.setEnabled !== 'function')
        return;
      setTimeoutImpl(() => {
        manager.setEnabled(WORLD_HISTORY_LAYER_ID, true, {
          origin: 'programmatic',
        });
      }, 0);
    },

    getStats() {
      return {
        count: enabled ? yearState.count : 0,
        countLabel:
          enabled && yearState.state === 'ready'
            ? String(yearState.count)
            : '—',
      };
    },

    setRowControlsListener(listener) {
      rowListener = typeof listener === 'function' ? listener : null;
    },

    // --- the panel's API -------------------------------------------------

    view() {
      const state = store.get();
      const available = store.bordersAvailable?.() === true;
      const sample = bordersState.sample;
      return {
        enabled,
        year: state.year,
        cliopatriaYear: cliopatriaYear(state.year),
        mode: state.mode,
        places: state.places,
        opacity: state.opacity,
        status: yearState.state,
        error: yearState.error,
        notBuilt,
        count: yearState.count,
        list: state.list.map((entry) => {
          const known = entries.get(entry.name);
          return {
            ...entry,
            state: known?.state || 'loading',
            from: known?.from,
            to: known?.to,
          };
        }),
        borders: {
          available,
          ...state.borders,
          status: !available
            ? 'absent'
            : bordersInfo?.built !== true
              ? 'not-built'
              : !state.borders.on
                ? 'off'
                : bordersState.state,
          error: bordersState.error,
          sampleYear:
            bordersState.state === 'ready' && sample ? sample.year : null,
        },
        selected: !selected
          ? null
          : selected.kind === 'cottereau'
            ? {
                kind: 'cottereau',
                title: selected.title,
                lines: bordersCardDetails(selected.record, {
                  sampleYear: selected.sampleYear,
                }),
                name: selected.record.cliopatria || '',
              }
            : {
                kind: selected.kind,
                title: selected.title,
                name: selected.record.name,
                from: selected.record.from,
                to: selected.record.to,
                area: selected.record.area,
                wikipedia: selected.record.wikipedia,
                matches: matchesFor(drawnSample(), selected.record.name),
              },
      };
    },
    onChange(listener) {
      panelListeners.add(listener);
      return () => panelListeners.delete(listener);
    },
    names: () => source.names(),
    setYear: (year) => store.setYear(year),
    setMode: (mode) => store.setMode(mode),
    setPlaces: (places) => store.setPlaces(places),
    setOpacity: (opacity) => store.setOpacity(opacity),
    setBorders: (patch) => store.setBorders(patch),
    add: (name) => store.add(name),
    setVisible: (name, visible) => store.update(name, { visible }),
    setExtent: (name, extent) => store.update(name, { extent }),
    remove: (name) => store.remove(name),
    clear: () => store.clear(),
    closeCard: () => select(null),
    retry() {
      yearState = { ...yearState, key: '' };
      for (const [name, known] of entries)
        if (known.state === 'failed') entries.delete(name);
      if (bordersState.state === 'failed')
        bordersState = { ...bordersState, year: null };
      if (bordersInfo && bordersInfo.built !== true) probeBorders(true);
      loadYear();
      loadEntries();
      loadBorders();
    },

    /** For tests: what is mounted and loaded. */
    _state: () => ({
      enabled,
      yearLayer,
      listLayer,
      bordersLayer,
      bordersState,
      collection,
      yearKey,
      listKey,
      yearState,
      entries,
      selected,
    }),
    _onClick: onClick,
    _polityAt: polityAt,
  };
  return layer;
}
