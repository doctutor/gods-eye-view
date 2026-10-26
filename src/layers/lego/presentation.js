import { formatNumber, msg, t, tn } from '../../i18n/index.js';
import { EXAGGERATIONS, formatLatLon, formatValue } from './model.js';
import { RELIEF_FACTORS } from './photoreal.js';

/**
 * Personal fork: what the Lego mode says: the drop-down beside the
 * ANALYSIS heading (Render: Colour / Lego, and Lego's elevation
 * exaggeration), its status line, and a clicked column's card; and the
 * two ways of seeing elevation with the Google 3D tiles (photoreal.js):
 * Relief ×N and Photoreal on bricks.
 */

export const RENDER_LABELS = Object.freeze({
  colour: msg('Render: Colour'),
  lego: msg('Render: Lego'),
});

/** The card's lines for a column. */
export function columnCardDetails(column, header, { sourceName = '' } = {}) {
  const lon = (column.west + column.east) / 2;
  const lat = (column.south + column.north) / 2;
  const value = formatValue(column.value, header.units || '');
  return [
    tn(column.bricks, '{count} brick = {value}', '{count} bricks = {value}', {
      value,
    }),
    t('Cell {size} m', {
      size: formatNumber(Math.round(Number(header.cellSizeM))),
    }),
    formatLatLon(lat, lon),
    t('Source: {source}', { source: sourceName || header.source || '' }),
  ];
}

/** B's modes as the drop-down says them. */
export const BRICK_MODE_LABELS = Object.freeze({
  auto: msg('Bricks: AUTO'),
  lift: msg('Bricks: LIFT'),
  texture: msg('Bricks: TEXTURE'),
});
/** The textured bricks' sides as the drop-down says them. */
export const SIDE_LABELS = Object.freeze({
  tint: msg('Sides: tint'),
  colour: msg('Sides: colour'),
});

/** What Photoreal on bricks says when it is asked for but not lifting. */
export function photorealStatusText(status) {
  if (status?.bricks === 'on' && status.representation === 'texture') {
    if (status.texture === 'loading')
      return t('Fetching the imagery for the brick tops…');
    if (status.texture === 'failed')
      return t(
        'The brick tops’ imagery could not be fetched: the tiles stay lifted',
      );
    if (status.texture === 'ready')
      return t('Brick tops: {size} px of Esri imagery', {
        size: status.textureSize,
      });
  }
  switch (status?.bricks === 'waiting' ? status.reason : '') {
    case 'no-photoreal':
      return t('Photoreal on bricks needs the Google 3D map');
    case 'no-lego':
    case 'no-bricks':
      return t('Photoreal on bricks waits for the bricks');
    case 'geoid':
      return t('Loading the geoid…');
    default:
      return '';
  }
}

/** The status line beside the drop-down. */
export function legoStatusText(status) {
  switch (status?.state) {
    case 'no-layer':
      return t('Turn on a raster layer to build it in bricks');
    case 'loading':
      return t('Building bricks…');
    case 'unavailable':
      return t('Lego needs the raster values service (/api/raster/values)');
    case 'failed':
      return t('Lego bricks unavailable');
    case 'ready':
      return t('{layer}: {count} columns of {size} m bricks', {
        layer: status.layerName || status.layer,
        count: formatNumber(status.columns),
        size: formatNumber(Math.round(status.brickM * 10) / 10),
      });
    default:
      return '';
  }
}

/**
 * The heading control: a <select> for the render mode, a <select> for the
 * exaggeration (shown in Lego), and the status line.
 * @param {Document} doc
 * @param {{getMode: () => string, setMode: (mode: string) => void,
 *   getExaggeration: () => number, setExaggeration: (value: number) => void,
 *   getStatus: () => object, subscribe: (listener: Function) => Function}} lego
 * @param {{getState: () => {relief: number, bricks: boolean},
 *   setRelief: Function, setBricks: Function, getStatus: () => object,
 *   subscribe: Function}|null} [photoreal] Relief ×N and Photoreal on bricks
 * @returns {{element: HTMLElement, destroy: () => void}}
 */
export function createLegoHeadingControl(doc, lego, photoreal = null) {
  const wrap = doc.createElement('span');
  wrap.className = 'data-layer-group-control lego-render-control';
  const mode = doc.createElement('select');
  mode.className = 'lego-render-select';
  mode.setAttribute('aria-label', t('Render mode for raster layers'));
  mode.title = t(
    'Colour: the layers as images. Lego: each cell a column of 2×2 bricks, as tall as its value',
  );
  for (const key of ['colour', 'lego']) {
    const option = doc.createElement('option');
    option.value = key;
    option.textContent = t(RENDER_LABELS[key]);
    mode.appendChild(option);
  }
  const exaggeration = doc.createElement('select');
  exaggeration.className = 'lego-exaggeration-select';
  exaggeration.setAttribute('aria-label', t('Elevation exaggeration'));
  exaggeration.title = t(
    'Elevation exaggeration: 1× is true height; 2× suits flat country',
  );
  for (const value of EXAGGERATIONS) {
    const option = doc.createElement('option');
    option.value = String(value);
    option.textContent = `${value}×`;
    exaggeration.appendChild(option);
  }
  const status = doc.createElement('span');
  status.className = 'lego-render-status';
  wrap.append(mode, exaggeration);
  // Relief ×N, on any map; Photoreal on bricks, in Lego.
  let relief = null;
  let bricks = null;
  let bricksLabel = null;
  let brickMode = null;
  let sides = null;
  if (photoreal) {
    relief = doc.createElement('select');
    relief.className = 'lego-relief-select';
    relief.setAttribute('aria-label', t('Relief'));
    relief.title = t(
      'Relief: the Google 3D tiles (and the terrain) drawn taller, about the ground in the middle of the view',
    );
    for (const value of RELIEF_FACTORS) {
      const option = doc.createElement('option');
      option.value = String(value);
      option.textContent =
        value === 1 ? t('Relief ×1') : t('Relief ×{factor}', { factor: value });
      relief.appendChild(option);
    }
    bricksLabel = doc.createElement('label');
    bricksLabel.className = 'lego-photoreal-toggle';
    bricks = doc.createElement('input');
    bricks.type = 'checkbox';
    bricksLabel.title = t(
      'Lift each cell of the Google 3D tiles onto its brick',
    );
    bricksLabel.append(
      bricks,
      doc.createTextNode(` ${t('Photoreal on bricks')}`),
    );
    brickMode = doc.createElement('select');
    brickMode.className = 'lego-brick-mode-select';
    brickMode.setAttribute(
      'aria-label',
      t('How the Google 3D tiles meet the bricks'),
    );
    brickMode.title = t(
      'AUTO: the tiles lifted onto the bricks close in, the bricks’ tops textured with imagery far out (above 20 km). LIFT and TEXTURE: always one way',
    );
    for (const key of Object.keys(BRICK_MODE_LABELS)) {
      const option = doc.createElement('option');
      option.value = key;
      option.textContent = t(BRICK_MODE_LABELS[key]);
      brickMode.appendChild(option);
    }
    sides = doc.createElement('select');
    sides.className = 'lego-sides-select';
    sides.setAttribute('aria-label', t('The textured bricks’ sides'));
    for (const key of Object.keys(SIDE_LABELS)) {
      const option = doc.createElement('option');
      option.value = key;
      option.textContent = t(SIDE_LABELS[key]);
      sides.appendChild(option);
    }
    wrap.append(relief, bricksLabel, brickMode, sides);
  }
  wrap.append(status);

  const sync = () => {
    mode.value = lego.getMode();
    exaggeration.value = String(lego.getExaggeration());
    exaggeration.hidden = lego.getMode() !== 'lego';
    let text =
      lego.getMode() === 'lego' ? legoStatusText(lego.getStatus()) : '';
    if (photoreal) {
      const state = photoreal.getState();
      relief.value = String(state.relief);
      bricks.checked = state.bricks;
      bricksLabel.hidden = lego.getMode() !== 'lego';
      brickMode.value = state.mode || 'auto';
      sides.value = state.sides || 'tint';
      brickMode.hidden = bricksLabel.hidden || !state.bricks;
      sides.hidden = brickMode.hidden || state.mode === 'lift';
      const waiting =
        lego.getMode() === 'lego'
          ? photorealStatusText(photoreal.getStatus())
          : '';
      if (waiting) text = text ? `${text} · ${waiting}` : waiting;
    }
    if (status.textContent !== text) status.textContent = text;
  };
  const onMode = () => lego.setMode(mode.value);
  const onRelief = () => photoreal?.setRelief(Number(relief.value));
  const onBricks = () => photoreal?.setBricks(bricks.checked);
  const onBrickMode = () => photoreal?.setBrickMode?.(brickMode.value);
  const onSides = () => photoreal?.setSides?.(sides.value);
  relief?.addEventListener('change', onRelief);
  bricks?.addEventListener('change', onBricks);
  brickMode?.addEventListener('change', onBrickMode);
  sides?.addEventListener('change', onSides);
  const unsubscribePhotoreal = photoreal?.subscribe?.(sync);
  const onExaggeration = () => lego.setExaggeration(Number(exaggeration.value));
  mode.addEventListener('change', onMode);
  exaggeration.addEventListener('change', onExaggeration);
  // A click on the control must not toggle anything under the heading.
  const stop = (event) => event.stopPropagation();
  wrap.addEventListener('click', stop);
  const unsubscribe = lego.subscribe(sync);
  sync();
  return {
    element: wrap,
    destroy() {
      unsubscribe?.();
      unsubscribePhotoreal?.();
      relief?.removeEventListener('change', onRelief);
      bricks?.removeEventListener('change', onBricks);
      brickMode?.removeEventListener('change', onBrickMode);
      sides?.removeEventListener('change', onSides);
      mode.removeEventListener('change', onMode);
      exaggeration.removeEventListener('change', onExaggeration);
      wrap.removeEventListener('click', stop);
    },
  };
}
