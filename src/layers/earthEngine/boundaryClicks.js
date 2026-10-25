/**
 * Personal fork: the Administrative boundaries layer's clicks. While it
 * shows REGIONS or DISTRICTS (forced, or AUTO in those bands), a click on
 * the map asks the local server which country, region and county the point
 * is in (Overture's division areas, ./overtureAreas.js) and shows the
 * answer as a card on the world overlay; a click elsewhere, or off the
 * globe, closes it. Off, the card and the click handler go.
 */
import * as Cesium from 'cesium';
import { t } from '../../i18n/index.js';

export const BOUNDARY_CLICKS_OVERLAY = 'admin-boundaries';

/** A unit's name, with its English name when that differs. */
const named = (unit) =>
  unit.nameEn && unit.nameEn !== unit.name
    ? `${unit.name} (${unit.nameEn})`
    : unit.name;

/** The card for an identify answer: {title, details}. */
export function identifyCard(answer) {
  const {
    units = {},
    sea = null,
    land = false,
    attribution = '',
  } = answer || {};
  const details = [];
  if (!land) {
    const title = t('At sea');
    if (sea)
      details.push(
        t('In the territorial sea of {country}', { country: named(sea) }),
      );
    if (attribution) details.push(attribution);
    return { title, details };
  }
  const first = units.county || units.region || units.country;
  if (units.county)
    details.push(t('County: {name}', { name: named(units.county) }));
  if (units.region)
    details.push(t('Region: {name}', { name: named(units.region) }));
  if (units.country)
    details.push(
      units.country.country
        ? t('Country: {name} ({code})', {
            name: named(units.country),
            code: units.country.country,
          })
        : t('Country: {name}', { name: named(units.country) }),
    );
  if (!units.county && units.region)
    details.push(t('No county in Overture here'));
  if (attribution) details.push(attribution);
  return { title: first ? named(first) : t('Unknown'), details };
}

/**
 * @param {{source: {identify: Function}, overlayHost?: object|null,
 *   hitTest?: Function|null, isPointerFree?: () => boolean,
 *   requestRender?: Function, cesium?: object}} options
 */
export function createBoundaryClicks({
  source,
  overlayHost = null,
  hitTest = null,
  isPointerFree = () => true,
  requestRender = () => {},
  cesium = Cesium,
}) {
  let viewer = null;
  let handler = null;
  let active = () => false;
  let asked = 0;
  let card = null;

  function draw() {
    if (!overlayHost) return;
    const entries = card
      ? [
          {
            id: 'card',
            variant: 'card',
            position: cesium.Cartesian3.fromDegrees(card.lon, card.lat, 0),
            title: card.title,
            details: card.details,
            accent: '#ffffff',
            priority: 1000,
            protected: true,
            collisionGroup: 'admin-boundaries-card',
            interactive: false,
            horizonCull: true,
            terrainOcclusion: false,
            gapPx: 12,
            placement: 'above',
            accessibilityLabel: card.title,
          },
        ]
      : [];
    try {
      overlayHost.setEntries(BOUNDARY_CLICKS_OVERLAY, entries, {
        moving: false,
      });
    } catch (error) {
      console.warn('[Boundaries] card not drawn:', error?.message);
    }
    requestRender('admin-boundaries-card');
  }

  function close() {
    asked++;
    if (!card) return;
    card = null;
    draw();
  }

  function pick(position) {
    try {
      const hit = viewer?.camera?.pickEllipsoid?.(
        new cesium.Cartesian2(position.x, position.y),
      );
      if (!hit) return null;
      const point = cesium.Cartographic.fromCartesian(hit);
      return {
        lat: cesium.Math.toDegrees(point.latitude),
        lon: cesium.Math.toDegrees(point.longitude),
      };
    } catch {
      return null;
    }
  }

  /** A click: the units under it, as a card; off the globe, closed. */
  async function onClick(position) {
    if (!viewer || !position || !active() || !isPointerFree()) return;
    const hit = hitTest?.(position.x, position.y, {
      sourceId: BOUNDARY_CLICKS_OVERLAY,
    });
    if (hit?.entryId === 'card') return;
    const point = pick(position);
    if (!point) return close();
    const mine = ++asked;
    const answer = await source.identify(point.lat, point.lon);
    if (mine !== asked || !viewer) return;
    if (!answer) return close();
    card = { ...point, ...identifyCard(answer) };
    draw();
  }

  return {
    /** `active()`: whether a click asks (REGIONS or DISTRICTS showing). */
    enable(nextViewer, options = {}) {
      viewer = nextViewer || viewer;
      if (typeof options.active === 'function') active = options.active;
      if (handler || !viewer?.scene?.canvas || !cesium.ScreenSpaceEventHandler)
        return;
      try {
        handler = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        handler.setInputAction(
          (movement) => void onClick(movement.position),
          cesium.ScreenSpaceEventType.LEFT_CLICK,
        );
      } catch {
        handler = null;
      }
      overlayHost?.setVisible?.(BOUNDARY_CLICKS_OVERLAY, true);
    },
    disable() {
      try {
        handler?.destroy();
      } catch {
        /* gone with the scene */
      }
      handler = null;
      close();
      overlayHost?.clearSource?.(BOUNDARY_CLICKS_OVERLAY);
      overlayHost?.setVisible?.(BOUNDARY_CLICKS_OVERLAY, false);
      viewer = null;
    },
    /** The levels changed: a card for a level no longer shown closes. */
    update() {
      if (card && !active()) close();
    },
    attached: () => Boolean(handler),
    /** For tests. */
    _onClick: onClick,
    _card: () => card,
  };
}
