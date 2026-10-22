// Personal fork: the Wikipedia layer's Articles mode: one dot per geotagged
// article from the local points index (/api/wikipedia-coverage/points),
// coloured by its type class, titles for the nearest few once zoomed in,
// and a card on click with the REST summary fetched then (never before).

import * as Cesium from 'cesium';
import { viewWindow } from '../../maps/h3Cells.js';
import {
  WIKIPEDIA_POINT_CLASSES,
  WIKIPEDIA_POINT_WIKIS,
  pointWikiOfKey,
  pointZoomForHeight,
  wikiArticleUrl,
} from '../../data/wikipediaPoints.js';
import { formatNumber, getLocale, msg, t } from '../../i18n/index.js';

export const POINTS_SOURCE = 'wikipedia-points';
export const POINT_ID_PREFIX = 'wikipedia-point:';
/** Titles show below this camera height, the nearest LABEL_LIMIT first. */
export const LABEL_MAX_HEIGHT_M = 40_000;
export const LABEL_LIMIT = 30;
export const SECONDARY_COLOR = '#b0b0b0';
const CLASS_COLOR = new Map(
  WIKIPEDIA_POINT_CLASSES.map((c) => [c.key, c.color]),
);

/** A class's colour (secondary coordinates are grey). */
export const pointColor = (point) =>
  point.secondary ? SECONDARY_COLOR : CLASS_COLOR.get(point.class) || '#8ecae6';

/** The article's page on its Wikipedia, by page id (a title can be renamed). */
export const articleUrl = (point) =>
  wikiArticleUrl(
    pointWikiOfKey(point.wiki) || WIKIPEDIA_POINT_WIKIS[0],
    point.page,
  );

/**
 * The wiki a card opens: the viewer's language when its Wikipedia has the
 * article (an index of several wikis), else the article's own.
 */
export function preferredWiki(point, locale = getLocale()) {
  const lang = String(locale || 'en')
    .toLowerCase()
    .split('-')[0];
  const wiki = WIKIPEDIA_POINT_WIKIS.find((w) => w.lang === lang);
  return wiki && point.wikis?.includes(wiki.key) && wiki.key !== point.wiki
    ? wiki.key
    : null;
}

const EARTH_RADIUS_M = 6_371_000;
function distanceM(aLat, aLon, bLat, bLon) {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * The points labelled for a view: below LABEL_MAX_HEIGHT_M, the best
 * ranked (the answer's order) within a camera height or two of the view's
 * centre, the nearest LABEL_LIMIT of them.
 */
export function labelCohort(points, view) {
  if (!(view.height < LABEL_MAX_HEIGHT_M)) return [];
  const radius = Math.max(1_500, view.height * 1.5);
  return points
    .map((point, rank) => ({
      point,
      rank,
      d: distanceM(view.lat, view.lon, point.at[1], point.at[0]),
    }))
    .filter(({ d }) => d <= radius)
    .sort((a, b) => a.d - b.d)
    .slice(0, LABEL_LIMIT);
}

/** An article size in words: 12 kB of wikitext. */
export const sizeText = (bytes) =>
  t('{size} kB of wikitext', {
    size: formatNumber(Math.max(1, Math.round(bytes / 1000))),
  });

/** The lines of an article's card. */
export function cardDetails(point, { dumpDate = '', summary = null } = {}) {
  const lines = [];
  const kind = [
    t(CLASS_WORDS[point.class] || CLASS_WORDS.other),
    point.type || '',
  ]
    .filter(Boolean)
    .join(' · ');
  lines.push(point.secondary ? `${kind} · ${t('secondary coordinate')}` : kind);
  if (summary?.description) lines.push(summary.description);
  if (summary?.extract) lines.push(summary.extract);
  // An index of several wikis: the languages with an article on the item.
  if (point.wikis?.length)
    lines.push(
      t('Wikipedia in {languages}', {
        languages: point.wikis
          .map((key) => pointWikiOfKey(key)?.lang)
          .filter(Boolean)
          .join(' · '),
      }),
    );
  const facts = [];
  if (point.bytes) facts.push(sizeText(point.bytes));
  if (point.qid) facts.push(point.qid);
  if (facts.length) lines.push(facts.join(' · '));
  // i18n-ignore: coordinates
  lines.push(`${point.at[1].toFixed(5)}, ${point.at[0].toFixed(5)}`);
  lines.push(
    dumpDate
      ? t('Wikipedia, CC BY-SA 4.0 · dump of {date} · click to open', {
          date: dumpDate,
        })
      : t('Wikipedia, CC BY-SA 4.0 · click to open'),
  );
  return lines;
}

/** The type classes in words (legend, card). */
export const CLASS_WORDS = Object.freeze({
  place: msg('Places'),
  landmark: msg('Landmarks'),
  nature: msg('Nature'),
  other: msg('Other articles'),
});

/**
 * The Articles mode: dots for the view, titles for the nearest, a card on
 * click. The owning layer (index.js) shows and hides it and hands it the
 * view; it asks `source.points` and `source.summary`.
 * @param {{source: object, cesium?: object, overlayHost?: object|null,
 *   hitTest?: Function|null, requestRender?: Function, notify?: Function,
 *   openUrl?: (url: string) => void}} options
 */
export function createPointsMode({
  source,
  cesium = Cesium,
  overlayHost = null,
  hitTest = null,
  requestRender = () => {},
  notify = () => {},
  openUrl = (url) => globalThis.open?.(url, '_blank', 'noopener,noreferrer'),
}) {
  let viewer = null;
  let active = false;
  let secondary = false;
  let collection = null;
  let handler = null;
  let held = null; // {box, zoom, secondary, points, saturated}
  let status = null;
  let selected = null; // {point, summary, image}
  let generation = 0;
  let catalog = null;
  let view = null;

  function removeDots() {
    if (!collection) return;
    try {
      viewer?.scene?.primitives?.remove(collection);
    } catch {
      /* gone with the scene */
    }
    collection = null;
  }

  function drawDots() {
    removeDots();
    if (!held?.points?.length || !cesium.PointPrimitiveCollection) return;
    collection = new cesium.PointPrimitiveCollection();
    const outline = cesium.Color.fromCssColorString('#111111').withAlpha(0.7);
    for (const point of held.points)
      collection.add({
        id: `${POINT_ID_PREFIX}${point.id}`,
        position: cesium.Cartesian3.fromDegrees(point.at[0], point.at[1], 0),
        pixelSize: point.secondary ? 4 : 6,
        color: cesium.Color.fromCssColorString(pointColor(point)),
        outlineColor: outline,
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    viewer?.scene?.primitives?.add(collection);
  }

  function publish() {
    if (!overlayHost) return;
    const entries = [];
    if (active && held && view)
      for (const { point, rank, d } of labelCohort(held.points, view))
        entries.push({
          id: `label:${point.id}`,
          position: cesium.Cartesian3.fromDegrees(point.at[0], point.at[1], 0),
          variant: 'label',
          title: point.title,
          accent: pointColor(point),
          priority: Math.round(100_000 - rank - d / 100),
          collisionGroup: 'ambient-label',
          paintLane: 'ambient-label',
          interactive: false,
          edgeFade: 'keyhole',
          horizonCull: true,
          terrainOcclusion: false,
          gapPx: 10,
          verticalOnly: true,
          placement: 'above',
        });
    if (active && selected) {
      const { point } = selected;
      const position = cesium.Cartesian3.fromDegrees(
        point.at[0],
        point.at[1],
        0,
      );
      entries.push({
        id: 'card',
        variant: 'card',
        position,
        title: point.title,
        details: cardDetails(point, {
          dumpDate: catalog?.points?.dumpDate || catalog?.dumpDate || '',
          summary: selected.summary,
        }),
        accent: pointColor(point),
        priority: 1000,
        protected: true,
        collisionGroup: 'wikipedia-card',
        interactive: true,
        accessibilityLabel: t('Open {title} on Wikipedia', {
          title: point.title,
        }),
        activate: () => {
          openUrl(selected?.url || articleUrl(point));
          return true;
        },
        horizonCull: true,
        terrainOcclusion: false,
        gapPx: 12,
        placement: 'above',
      });
      if (selected.image)
        entries.push({
          id: 'thumbnail',
          variant: 'thumbnail',
          position,
          title: point.title,
          image: selected.image,
          priority: 999,
          protected: true,
          collisionGroup: 'wikipedia-card',
          interactive: false,
          horizonCull: true,
          terrainOcclusion: false,
          gapPx: 12,
          placement: 'below',
        });
    }
    try {
      overlayHost.setEntries(POINTS_SOURCE, entries, {
        cohortLimit: LABEL_LIMIT + 2,
        collisionCapacity: 24,
        moving: false,
      });
    } catch (error) {
      console.warn('[Wikipedia] overlay not drawn:', error?.message);
    }
  }

  async function load(box, zoom) {
    const gen = ++generation;
    status = { state: 'loading', count: 0 };
    notify();
    try {
      const answer = await source.points({
        box,
        zoom,
        secondary,
        version: catalog?.points?.version,
      });
      if (!active || gen !== generation) return;
      held = { box, zoom, secondary, ...answer };
      status = {
        state: 'ready',
        count: answer.points.length,
        saturated: answer.saturated,
        zoom: answer.zoom,
      };
      drawDots();
      publish();
      requestRender('wikipedia-points');
    } catch (error) {
      if (error?.name === 'AbortError' || gen !== generation) return;
      status = {
        state: error?.status === 503 ? 'unconfigured' : 'failed',
        message: String(error?.message || error).slice(0, 200),
        count: 0,
      };
    }
    notify();
  }

  function covers(outer, inner) {
    return (
      outer &&
      inner &&
      inner.south >= outer.south &&
      inner.north <= outer.north &&
      inner.west >= outer.west &&
      inner.east <= outer.east
    );
  }

  async function select(point) {
    if (!point || selected?.point.id === point.id) {
      selected = null;
      publish();
      requestRender('wikipedia-card');
      return;
    }
    selected = { point, summary: null, image: null };
    publish();
    requestRender('wikipedia-card');
    // The viewer's language when its Wikipedia has the article too: its
    // page from the item's langs, for the card's link.
    const own = preferredWiki(point);
    if (own && point.qid)
      source
        .langs?.(point.qid)
        .then((langs) => {
          const entry = langs.find((l) => l.wiki === own);
          if (!entry || selected?.point.id !== point.id) return;
          selected.url = entry.url;
        })
        .catch(() => {});
    // The summary only now, and once a session per title (source.summary).
    try {
      const summary = await source.summary?.(
        point.title,
        point.wiki || 'enwiki',
      );
      if (selected?.point.id !== point.id || !summary) return;
      selected.summary = summary;
      publish();
      requestRender('wikipedia-card');
      const thumb = summary.thumbnail?.source;
      if (thumb && typeof globalThis.Image === 'function') {
        const image = new globalThis.Image();
        image.onload = () => {
          if (selected?.point.id !== point.id) return;
          selected.image = image;
          publish();
          requestRender('wikipedia-card');
        };
        image.src = thumb;
      }
    } catch {
      /* the card stands without its summary */
    }
  }

  function onClick(position) {
    if (!active) return;
    const card = hitTest?.(position?.x, position?.y, {
      sourceId: POINTS_SOURCE,
    });
    if (card?.entry?.activate) {
      card.entry.activate();
      return;
    }
    let picked = null;
    try {
      picked = viewer?.scene?.pick?.(position);
    } catch {
      picked = null;
    }
    const id = String(picked?.id ?? '');
    if (id.startsWith(POINT_ID_PREFIX)) {
      const point = held?.points.find(
        (p) => p.id === id.slice(POINT_ID_PREFIX.length),
      );
      if (point) return select(point);
    }
    if (selected) select(null);
  }

  return {
    get active() {
      return active;
    },
    show(nextViewer) {
      viewer = nextViewer || viewer;
      if (active) return;
      active = true;
      overlayHost?.setVisible?.(POINTS_SOURCE, true);
      if (!handler && cesium.ScreenSpaceEventHandler && viewer?.scene?.canvas)
        try {
          handler = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
          handler.setInputAction(
            (movement) => onClick(movement.position),
            cesium.ScreenSpaceEventType.LEFT_CLICK,
          );
        } catch {
          handler = null;
        }
    },
    hide() {
      if (!active) return;
      active = false;
      generation += 1;
      source.abortPoints?.();
      try {
        handler?.destroy?.();
      } catch {
        /* gone */
      }
      handler = null;
      removeDots();
      held = null;
      selected = null;
      status = null;
      overlayHost?.clearSource?.(POINTS_SOURCE);
      overlayHost?.setVisible?.(POINTS_SOURCE, false);
      requestRender('wikipedia-points-hide');
    },
    /** The view settled (lat, lon, height): dots for it, when not held. */
    sync(nextView, nextCatalog) {
      if (!active) return;
      catalog = nextCatalog || catalog;
      view = nextView;
      if (!catalog?.points?.built) {
        status = { state: 'unconfigured', count: 0 };
        notify();
        return;
      }
      const zoom = pointZoomForHeight(view.height);
      const window = viewWindow(view.lat, view.lon, view.height);
      const box = window || { west: -180, south: -85, east: 180, north: 85 };
      if (
        held &&
        held.secondary === secondary &&
        Math.min(zoom, 12) === Math.min(held.zoom, 12) &&
        (!window || (box.west <= box.east && covers(held.box, box))) &&
        !held.saturated
      ) {
        publish();
        return;
      }
      // A window twice the view's, so a pan reuses the answer.
      const wide = window
        ? viewWindow(view.lat, view.lon, view.height * 2)
        : box;
      void load(wide, zoom);
    },
    setSecondary(on) {
      secondary = Boolean(on);
      held = null;
    },
    get secondary() {
      return secondary;
    },
    status: () => status,
    onClick,
    /** For tests. */
    _state: () => ({ active, held, status, selected, collection, secondary }),
  };
}
