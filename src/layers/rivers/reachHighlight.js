import * as Cesium from 'cesium';
import {
  RIVER_REACH_ROUTE,
  RIVER_REACH_SCHEMA,
} from '../../data/riverReach.js';
import { isSurfacePick, pickGroundPosition } from '../../data/scenePick.js';
import {
  failureTitle,
  missTitle,
  mouthLabel,
  pendingTitle,
  reachCardDetails,
  reachTitle,
} from './reachCard.js';

/**
 * Personal fork: a clicked river reach, the path its water takes to the sea
 * or an inland sink, and the network above it, drawn on the ground (terrain
 * and photoreal tiles alike: GroundPolylinePrimitive, classification BOTH,
 * as the Grid layer draws), with a card through the world-overlay host
 * (all world text goes there; src/noCesiumLabels.test.mjs).
 *
 * The Rivers layer attaches it and routes its map clicks to select(); any
 * source that answers 'river-reach/1' (src/data/riverReach.js) can feed
 * it: `endpoint` is Earth Engine's HydroRIVERS v1 by default, and the
 * answer's own links name where its upstream network is, so a self-hosted
 * HydroSHEDS v2 endpoint drops in.
 *
 * Styling tells the three apart by width and pattern as well as colour: the
 * clicked reach thick amber, the downstream path a cyan line, both on a
 * dark casing so they read on light and dark maps; the upstream network
 * thin pale dashes, thinner for smaller rivers.
 */

export const REACH_OVERLAY_SOURCE = 'river-reach';
export const REACH_PICK_PREFIX = 'river-reach:';
export const REACH_STYLE = Object.freeze({
  reach: Object.freeze({ color: '#ffd166', alpha: 1, width: 7 }),
  downstream: Object.freeze({ color: '#4cc9f0', alpha: 0.95, width: 4.5 }),
  casing: Object.freeze({ color: '#0b1d2a', alpha: 0.6, extra: 3 }),
  upstream: Object.freeze({ color: '#d7f3ff', alpha: 0.85, width: 3 }),
});
/** A miss or a failure stays on screen this long. */
export const NOTICE_MS = 3000;

/** The upstream line's width: the clicked river's own order is widest. */
export function upstreamWidth(order, clickedOrder) {
  const step = Math.max(0, (Number(order) || 10) - (Number(clickedOrder) || 1));
  return Math.max(1.5, REACH_STYLE.upstream.width - step * 0.75);
}

/** The point of a line nearest a place: where the card stands. */
export function nearestPoint(coordinates, lon, lat) {
  let best = null;
  let bestD = Infinity;
  const kx = Math.cos((lat * Math.PI) / 180);
  for (const point of coordinates || []) {
    const d = ((point[0] - lon) * kx) ** 2 + (point[1] - lat) ** 2;
    if (d < bestD) {
      bestD = d;
      best = point;
    }
  }
  return best;
}

/** A link from an answer, resolved against the endpoint it came from. */
export function resolveLink(link, endpoint) {
  if (typeof link !== 'string' || !link) return null;
  if (/^https?:\/\//.test(link)) return link;
  const match = /^(https?:\/\/[^/]+)/.exec(String(endpoint || ''));
  return match && link.startsWith('/') ? `${match[1]}${link}` : link;
}

/**
 * @param {{viewer: object, overlays?: object|null, cesium?: object,
 *   picking?: object|null, requestRender?: (reason: string) => void,
 *   fetchImpl?: typeof fetch, documentRef?: object|null,
 *   setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout}} services
 *   `overlays` is the world-overlay host (src/app/layers/overlayHost.js);
 *   `picking` the pick-ownership registry (src/data/pickRegistry.js).
 * @param {{endpoint?: string, upstream?: boolean, debounceMs?: number}} [options]
 * @returns {{select: (lat: number, lon: number, heightM: number,
 *   options?: {maxOrder?: number}) => Promise<object|null>, clear: () => void,
 *   detach: () => void, state: () => object}}
 */
export function attachReachHighlight(
  {
    viewer,
    overlays = null,
    cesium = Cesium,
    picking = null,
    requestRender = () => {},
    fetchImpl = (...args) => fetch(...args),
    documentRef = globalThis.document ?? null,
    setTimer = (...args) => setTimeout(...args),
    clearTimer = (...args) => clearTimeout(...args),
  },
  { endpoint = RIVER_REACH_ROUTE, upstream = true, debounceMs = 150 } = {},
) {
  let primitives = [];
  let answer = null;
  let upstreamState = null;
  let click = null;
  let token = 0;
  let controller = null;
  let debounce = null;
  /** A debounced select's promise, settled with null when it is superseded. */
  let waiting = null;
  let notice = null;
  let detached = false;

  picking?.registerPickOwner?.(REACH_OVERLAY_SOURCE, (id) =>
    String(id).startsWith(REACH_PICK_PREFIX),
  );
  overlays?.setVisible?.(REACH_OVERLAY_SOURCE, true);

  const onKey = (event) => {
    if (event?.key === 'Escape' && (answer || click)) clear();
  };
  documentRef?.addEventListener?.('keydown', onKey);

  function removePrimitives() {
    const scene = viewer?.scene;
    for (const primitive of primitives) {
      try {
        scene?.groundPrimitives?.remove(primitive);
        scene?.primitives?.remove(primitive);
      } catch {
        /* gone with the scene */
      }
    }
    primitives = [];
  }

  function stop() {
    token += 1;
    controller?.abort?.();
    controller = null;
    if (debounce) clearTimer(debounce);
    if (notice) clearTimer(notice);
    debounce = null;
    notice = null;
    waiting?.(null);
    waiting = null;
  }

  /** Clear the drawing and the card; an answer still on its way is dropped. */
  function clear() {
    stop();
    const had = primitives.length > 0 || answer || click;
    removePrimitives();
    answer = null;
    upstreamState = null;
    click = null;
    overlays?.clearSource?.(REACH_OVERLAY_SOURCE);
    if (had) requestRender('river-reach-clear');
  }

  const groundless = () => {
    try {
      return !cesium.GroundPolylinePrimitive.isSupported(viewer.scene);
    } catch {
      return true;
    }
  };

  function instance(coordinates, width, color, id, flat) {
    const positions = cesium.Cartesian3.fromDegreesArray(coordinates.flat());
    return new cesium.GeometryInstance({
      id,
      geometry: flat
        ? new cesium.PolylineGeometry({
            positions,
            width,
            arcType: cesium.ArcType.GEODESIC,
          })
        : new cesium.GroundPolylineGeometry({
            positions,
            width,
            arcType: cesium.ArcType.GEODESIC,
          }),
      attributes: {
        color: cesium.ColorGeometryInstanceAttribute.fromColor(color),
      },
    });
  }

  function add(instances, appearance, flat) {
    if (!instances.length) return;
    const scene = viewer?.scene;
    if (!scene) return;
    const primitive = flat
      ? new cesium.Primitive({
          geometryInstances: instances,
          appearance,
          asynchronous: true,
        })
      : new cesium.GroundPolylinePrimitive({
          geometryInstances: instances,
          appearance,
          classificationType: cesium.ClassificationType.BOTH,
          asynchronous: true,
        });
    primitives.push(
      (flat ? scene.primitives : scene.groundPrimitives).add(primitive),
    );
  }

  const colour = ({ color, alpha }) =>
    cesium.Color.fromCssColorString(color).withAlpha(alpha);

  /** The reach and its downstream path; the upstream network under them. */
  function draw() {
    removePrimitives();
    if (!answer) return;
    const flat = groundless();
    const reachLine = answer.reach?.geometry?.coordinates || [];
    const down = (answer.downstream?.segments || []).filter(
      (segment) => segment.coordinates?.length >= 2,
    );
    const up = (answer.upstream?.lines || []).filter(
      (line) => line.coordinates?.length >= 2,
    );
    const id = answer.reach?.id;
    const clickedOrder = answer.reach?.properties?.RIV_ORD;
    const { reach, downstream, casing } = REACH_STYLE;
    // The network above is extra: if it cannot be drawn, the path still is.
    try {
      if (up.length)
        add(
          up.map((line, i) =>
            instance(
              line.coordinates,
              upstreamWidth(line.order, clickedOrder),
              colour(REACH_STYLE.upstream),
              `${REACH_PICK_PREFIX}up:${id}:${i}`,
              flat,
            ),
          ),
          new cesium.PolylineMaterialAppearance({
            material: cesium.Material.fromType('PolylineDash', {
              color: colour(REACH_STYLE.upstream),
              dashLength: 12,
            }),
          }),
          flat,
        );
    } catch (error) {
      console.warn('[Rivers] upstream not drawn:', error?.message);
    }
    const cased = [
      ...down.map((segment) => [segment.coordinates, downstream.width]),
      ...(reachLine.length >= 2 ? [[reachLine, reach.width]] : []),
    ];
    add(
      cased.map(([coordinates, width], i) =>
        instance(
          coordinates,
          width + casing.extra,
          colour(casing),
          `${REACH_PICK_PREFIX}casing:${id}:${i}`,
          flat,
        ),
      ),
      new cesium.PolylineColorAppearance(),
      flat,
    );
    add(
      down.map((segment, i) =>
        instance(
          segment.coordinates,
          downstream.width,
          colour(downstream),
          `${REACH_PICK_PREFIX}down:${id}:${i}`,
          flat,
        ),
      ),
      new cesium.PolylineColorAppearance(),
      flat,
    );
    if (reachLine.length >= 2)
      add(
        [
          instance(
            reachLine,
            reach.width,
            colour(reach),
            `${REACH_PICK_PREFIX}reach:${id}`,
            flat,
          ),
        ],
        new cesium.PolylineColorAppearance(),
        flat,
      );
    requestRender('river-reach-draw');
  }

  /** The card at the reach (or the click), and a label at the path's end. */
  function publish(title, details = []) {
    if (!overlays || !click) return;
    const spot = answer
      ? nearestPoint(answer.reach?.geometry?.coordinates, click.lon, click.lat)
      : null;
    const [lon, lat] = spot || [click.lon, click.lat];
    const entries = [
      {
        id: 'card',
        position: cesium.Cartesian3.fromDegrees(lon, lat),
        variant: 'card',
        title,
        details,
        accent: REACH_STYLE.reach.color,
        priority: 1000,
        protected: true,
        collisionGroup: 'river-reach',
        interactive: false,
        horizonCull: true,
        terrainOcclusion: false,
        gapPx: 12,
        placement: 'above',
      },
    ];
    const mouth = answer?.downstream?.mouth;
    if (Array.isArray(mouth) && answer.downstream.segments?.length)
      entries.push({
        id: 'mouth',
        position: cesium.Cartesian3.fromDegrees(mouth[0], mouth[1]),
        variant: 'label',
        title: mouthLabel(answer.downstream),
        details: [],
        accent: REACH_STYLE.downstream.color,
        priority: 900,
        collisionGroup: 'river-reach',
        interactive: false,
        horizonCull: true,
        terrainOcclusion: false,
        gapPx: 4,
        placement: 'above',
      });
    try {
      overlays.setEntries(REACH_OVERLAY_SOURCE, entries, { moving: false });
    } catch (error) {
      console.warn('[Rivers] card not shown:', error?.message);
    }
    requestRender('river-reach-card');
  }

  function showAnswer() {
    publish(
      reachTitle(answer),
      reachCardDetails(answer, { upstream: upstreamState }),
    );
  }

  /** A miss or failure: said on the card, then cleared. */
  function noticeFor(title, mine) {
    publish(title);
    notice = setTimer(() => {
      if (mine === token) clear();
    }, NOTICE_MS);
  }

  async function getJson(url, signal) {
    const response = await fetchImpl(url, {
      signal,
      headers: { Accept: 'application/json' },
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, ok: response.ok, body };
  }

  async function loadUpstream(mine, signal) {
    const link = resolveLink(answer?.links?.upstream, endpoint);
    if (!link) return;
    upstreamState = 'loading';
    showAnswer();
    try {
      const { ok, body } = await getJson(link, signal);
      if (mine !== token) return;
      if (!ok || body?.schema !== RIVER_REACH_SCHEMA || !body.upstream)
        throw new Error('no upstream');
      answer = { ...answer, upstream: body.upstream };
      upstreamState = null;
      draw();
    } catch {
      if (mine !== token) return;
      upstreamState = 'failed';
    }
    showAnswer();
  }

  async function lookUp(mine, lat, lon, heightM, maxOrder) {
    controller =
      typeof AbortController === 'function' ? new AbortController() : null;
    const signal = controller?.signal;
    const params = new URLSearchParams({
      lat: lat.toFixed(6),
      lon: lon.toFixed(6),
      heightM: String(Math.round(heightM)),
    });
    if (Number.isInteger(maxOrder)) params.set('maxOrder', String(maxOrder));
    let result;
    try {
      result = await getJson(`${endpoint}?${params}`, signal);
    } catch {
      if (mine === token) noticeFor(failureTitle(0), mine);
      return null;
    }
    if (mine !== token) return null;
    if (result.status === 404) {
      noticeFor(missTitle(), mine);
      return null;
    }
    if (!result.ok || result.body?.schema !== RIVER_REACH_SCHEMA) {
      noticeFor(failureTitle(result.status), mine);
      return null;
    }
    answer = result.body;
    upstreamState = null;
    draw();
    showAnswer();
    // A name-only answer has no reach to trace upstream from.
    if (upstream && !answer.upstream && !answer.nameOnly)
      await loadUpstream(mine, signal);
    return mine === token ? answer : null;
  }

  return {
    /**
     * Look up the reach at a place seen from a height, replacing what is
     * drawn. Clicks closer together than `debounceMs` ask only once, for
     * the last.
     */
    select(lat, lon, heightM, { maxOrder } = {}) {
      if (detached || !Number.isFinite(lat) || !Number.isFinite(lon))
        return Promise.resolve(null);
      clear();
      const mine = token;
      click = { lat, lon };
      publish(pendingTitle());
      const height = Number.isFinite(heightM) ? Math.max(0, heightM) : 10_000;
      return new Promise((resolve) => {
        const go = () => {
          debounce = null;
          waiting = null;
          if (mine !== token) return resolve(null);
          lookUp(mine, lat, lon, height, maxOrder).then(resolve, () =>
            resolve(null),
          );
        };
        if (debounceMs > 0) {
          waiting = resolve;
          debounce = setTimer(go, debounceMs);
        } else go();
      });
    },
    clear,
    detach() {
      if (detached) return;
      clear();
      detached = true;
      documentRef?.removeEventListener?.('keydown', onKey);
      picking?.unregisterPickOwner?.(REACH_OVERLAY_SOURCE);
      overlays?.setVisible?.(REACH_OVERLAY_SOURCE, false);
    },
    /** For tests: what is drawn and shown. */
    state: () => ({
      answer,
      upstream: upstreamState,
      primitives: [...primitives],
      click,
    }),
  };
}

/**
 * Route a viewer's map clicks to a highlight while a layer wants them: a
 * click on the map (or on the highlight itself) selects the reach there; a
 * click on another layer's object is left to that layer; a click on the sky
 * clears. Returns the detach function.
 * @param {{viewer: object, highlight: {select: Function, clear: Function},
 *   cesium?: object, picking?: object|null, isPointerFree?: () => boolean,
 *   maxOrder?: (heightM: number) => number|undefined}} options
 */
export function attachReachClicks({
  viewer,
  highlight,
  cesium = Cesium,
  picking = null,
  isPointerFree = () => true,
  maxOrder = () => undefined,
}) {
  const handler = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((click) => {
    if (!isPointerFree()) return;
    let picked = null;
    try {
      picked = viewer.scene.pick(click.position);
    } catch {
      picked = null;
    }
    if (!isSurfacePick(picked)) {
      const id = picking?.resolvePickId?.(picked) ?? null;
      const ours = id && id.startsWith(REACH_PICK_PREFIX);
      if (!ours && (!picking || picking.findPickOwner?.(id))) return;
    }
    const ground = pickGroundPosition(viewer, click.position);
    if (!ground) {
      highlight.clear();
      return;
    }
    const carto = cesium.Cartographic.fromCartesian(ground);
    const heightM = viewer.camera?.positionCartographic?.height;
    highlight.select(
      cesium.Math.toDegrees(carto.latitude),
      cesium.Math.toDegrees(carto.longitude),
      heightM,
      { maxOrder: maxOrder(heightM) },
    );
  }, cesium.ScreenSpaceEventType.LEFT_CLICK);
  return () => handler.destroy();
}
